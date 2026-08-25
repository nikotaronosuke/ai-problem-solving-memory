/**
 * The whole pipeline against a real database: a Problem in, a stored,
 * searchable artifact out.
 *
 * This is the file where three tasks meet. The summary service produced
 * drafts and stored nothing; the artifact store accepted only complete rows;
 * the lexical search found only what was stored. Here a scripted generator
 * and a scripted embedding provider close the loop, and the last test of the
 * happy path is a full-text search finding what was generated.
 *
 * The ports are scripted because what is being proven is orchestration —
 * privacy, races, atomicity, provenance, persistence — none of which depend
 * on which model produced the words or the numbers. Semantic quality is the
 * evaluation task's, measured against fixtures.
 *
 * The centrepiece is the gate. Between the moment a draft's fingerprint was
 * checked and the moment the artifact commits, the source can move — an
 * embedding call takes real time — so the final check and the write happen in
 * one short transaction under a lock on the Problem row. The lock tests here
 * are real concurrency: a second connection genuinely blocks, observed through
 * the database's own wait state, never through a sleep.
 *
 * Every credential fixture is synthetic. Skipped when `DATABASE_URL` is unset.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createRetrievalArtifactGenerationService,
  createRetrievalSummaryService,
  EmbeddingGenerationFailedError,
  type EmbeddingProvider,
  type RetrievalArtifactGenerationService,
  type RetrievalSummaryGenerator,
} from '../../src/app/index.js';
import { readDatabaseUrl } from '../../src/config/env.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import {
  createTransactionRunner,
  type DatabaseTransactionRunner,
} from '../../src/db/transaction.js';
import { toClientEventId } from '../../src/domain/client-event-id.js';
import { generateOwnerId, type OwnerContext, type OwnerId } from '../../src/domain/owner.js';
import type { ProblemId } from '../../src/domain/problem.js';
import { InvalidEmbeddingProviderOutputError } from '../../src/domain/retrieval-embedding.js';
import { STRUCTURAL_FEATURE_SCHEMA_VERSION } from '../../src/domain/retrieval-summary.js';
import { resolveOwnerContextFor } from '../../src/owner/context.js';
import {
  createMemoryRepository,
  createRetrievalArtifactRepository,
  createRetrievalSearchReader,
  createRetrievalSummarySourceReader,
  type MemoryRepository,
  type RetrievalArtifactRepository,
} from '../../src/repository/index.js';
import {
  createArtifactInspectionPolicy,
  createSecretDetectionPolicy,
  SanitizationRejectedError,
  withSanitization,
} from '../../src/sanitization/index.js';

const databaseUrl = readDatabaseUrl();

const FIXED_NOW = new Date('2026-08-16T12:00:00.000Z');

/** Synthetic, with distinctive tails so a sweep can name what leaked. */
const SECRET = {
  inSummary: 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/fakeLl2Xe7Q0123456789',
  inProviderError: 'Bearer fake-Mm3Yf8R-0123456789abcdef',
} as const;

function featuresWith(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: STRUCTURAL_FEATURE_SCHEMA_VERSION,
    problem_domain: 'deployment',
    symptom_patterns: ['works locally, fails once deployed'],
    suspected_boundaries: ['configuration resolved at build time'],
    occurrence_conditions: ['only in the deployed environment'],
    successful_directions: [],
    dead_end_directions: ['raising the timeout'],
    environment_facts: ['node 22.12.0'],
    ...overrides,
  };
}

function summaryOutput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    normalizedSummary: 'a callback fails only after deployment because the host is fixed at build',
    keywords: ['callback', 'deployment'],
    structuralFeatures: featuresWith(),
    ...overrides,
  };
}

function scriptedGenerator(
  respond: (source: string) => unknown = () => summaryOutput(),
): RetrievalSummaryGenerator {
  return {
    generatorId: 'scripted-summary-generator',
    generatorVersion: '7',
    generate: ({ source }) => Promise.resolve(respond(source)),
  };
}

/** A provider that answers immediately, and counts. */
function scriptedProvider(
  respond: () => unknown = () => [0.5, -0.25, 0.125],
): EmbeddingProvider & { calls: number } {
  const provider = {
    modelId: 'fixture-embedding-model',
    modelVersion: '2',
    dimensions: 3,
    calls: 0,
    embed() {
      provider.calls += 1;
      return Promise.resolve(respond());
    },
  };
  return provider;
}

/** A provider that stops inside the call until the test lets it continue. */
function barrierProvider(respond: () => unknown = () => [0.5, -0.25, 0.125]): EmbeddingProvider & {
  readonly entered: Promise<void>;
  release(): void;
} {
  let announce = (): void => {};
  let open = (): void => {};
  const entered = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });

  return {
    modelId: 'fixture-embedding-model',
    modelVersion: '2',
    dimensions: 3,
    entered,
    release: () => {
      open();
    },
    async embed() {
      announce();
      await gate;
      return respond();
    },
  };
}

interface Actor {
  readonly ownerId: OwnerId;
  readonly context: OwnerContext;
  readonly memory: MemoryRepository;
  readonly artifacts: RetrievalArtifactRepository;
}

describe.skipIf(databaseUrl === undefined)('generating and storing a retrieval artifact', () => {
  let pool: DatabasePool;
  let actor: Actor;
  const ownersCreated: OwnerId[] = [];

  async function makeActor(): Promise<Actor> {
    const ownerId = generateOwnerId();
    await insertOwnerIfAbsent(pool, ownerId);
    ownersCreated.push(ownerId);

    const context = await resolveOwnerContextFor(pool, ownerId);
    return {
      ownerId,
      context,
      memory: withSanitization(
        createMemoryRepository(pool, context),
        createSecretDetectionPolicy(),
      ),
      artifacts: withSanitization(
        createRetrievalArtifactRepository(pool, context),
        createArtifactInspectionPolicy(),
      ),
    };
  }

  function serviceFor(
    owner: Actor,
    generator: RetrievalSummaryGenerator,
    provider: EmbeddingProvider,
  ): RetrievalArtifactGenerationService {
    return createRetrievalArtifactGenerationService(
      createRetrievalSummaryService(
        createRetrievalSummarySourceReader(pool, owner.context),
        generator,
      ),
      provider,
      createTransactionRunner(pool),
      owner.context,
      () => FIXED_NOW,
    );
  }

  async function makeProblem(owner: Actor, tag: string): Promise<ProblemId> {
    const project = await owner.memory.createProject({ projectName: `${tag} project` });
    const environment = await owner.memory.createEnvironment({
      projectId: project.projectId,
      snapshot: { runtime: 'node 22.12.0' },
    });
    const problem = await owner.memory.createProblem({
      projectId: project.projectId,
      environmentId: environment.environmentId,
      title: `${tag} title`,
      symptoms: 'the callback returns 500 after deployment only',
      problemDomain: 'deployment',
      suspectedBoundary: 'configuration',
    });

    await owner.memory.appendEvent({
      problemId: problem.problemId,
      eventType: 'DEAD_END',
      summary: 'raising the timeout changed nothing',
      clientEventId: toClientEventId(randomUUID()),
    });

    return problem.problemId;
  }

  /** Everything this owner's Memory holds, for byte-level invariance checks. */
  async function memoryStored(ownerId: OwnerId): Promise<string> {
    const dumps: string[] = [];
    for (const table of [
      'projects',
      'environments',
      'problems',
      'events',
      'verifications',
      'relations',
      'usage_logs',
      'change_logs',
    ]) {
      const rows = await pool.query(
        `select to_jsonb(t) as row from public.${table} t where owner_id = $1 order by 1`,
        [ownerId],
      );
      dumps.push(`${table}:${JSON.stringify(rows.rows)}`);
    }
    return dumps.join('\n');
  }

  beforeAll(async () => {
    pool = createPool(resolveDatabaseConfig({ nodeEnv: 'test', connectionTimeoutMillis: 5_000 }));
    actor = await makeActor();
  });

  afterAll(async () => {
    if (ownersCreated.length > 0) {
      for (const table of [
        'retrieval_artifacts',
        'change_logs',
        'usage_logs',
        'relations',
        'verifications',
        'events',
        'problems',
        'environments',
        'projects',
        'owners',
      ]) {
        await pool.query(`delete from public.${table} where owner_id = any($1::uuid[])`, [
          ownersCreated,
        ]);
      }
    }
    await closePool(pool);
  });

  describe('the whole pipeline, when nothing interferes', () => {
    it('stores a complete artifact and every axis of its provenance', async () => {
      const problemId = await makeProblem(actor, 'success');
      const before = await memoryStored(actor.ownerId);

      const outcome = await serviceFor(
        actor,
        scriptedGenerator(),
        scriptedProvider(),
      ).generateArtifact(problemId);

      expect(outcome.kind).toBe('STORED');
      if (outcome.kind !== 'STORED') return;

      const stored = await actor.artifacts.getArtifact(problemId);
      expect(stored).toBeDefined();
      expect(stored?.normalizedSummary).toBe(
        'a callback fails only after deployment because the host is fixed at build',
      );
      expect(stored?.keywords).toEqual(['callback', 'deployment']);
      expect(stored?.structuralFeatures['problem_domain']).toBe('deployment');
      expect(stored?.semantic?.embedding).toEqual([0.5, -0.25, 0.125]);
      // Four provenance axes, each answering its own question: what was read,
      // who wrote the text, what vectorised it, when the content was complete.
      expect(stored?.sourceFingerprint).toMatch(/^retrieval-source-v1:/);
      expect(stored?.summaryGeneratorId).toBe('scripted-summary-generator');
      expect(stored?.summaryGeneratorVersion).toBe('7');
      expect(stored?.semantic?.embeddingModel).toBe('fixture-embedding-model');
      expect(stored?.semantic?.embeddingModelVersion).toBe('2');
      expect(stored?.generatedAt).toEqual(FIXED_NOW);

      // And the Memory it was derived from is byte for byte as it was.
      expect(await memoryStored(actor.ownerId)).toBe(before);
    });

    it('makes the artifact findable by the lexical search', async () => {
      const problemId = await makeProblem(actor, 'searchable');
      const marker = `pipelinemarker${randomUUID().slice(0, 8)}`;

      const outcome = await serviceFor(
        actor,
        scriptedGenerator(() =>
          summaryOutput({
            normalizedSummary: `a deployment failure involving ${marker} in the callback`,
            keywords: [marker],
          }),
        ),
        scriptedProvider(),
      ).generateArtifact(problemId);
      expect(outcome.kind).toBe('STORED');

      // Generation, embedding, storage, search: the first time the four tasks
      // hold hands. Vector search is deliberately not part of this — it does
      // not exist yet.
      const search = createRetrievalSearchReader(pool, actor.context);
      const found = await search.searchFullText({ text: marker });
      expect(found.map((candidate) => candidate.problemId)).toContain(problemId);
    });

    it('replaces the one current row on regeneration, provenance and all', async () => {
      const problemId = await makeProblem(actor, 'regenerate');
      const first = `firstmarker${randomUUID().slice(0, 8)}`;
      const second = `secondmarker${randomUUID().slice(0, 8)}`;

      await serviceFor(
        actor,
        scriptedGenerator(() =>
          summaryOutput({ normalizedSummary: `about ${first}`, keywords: [first] }),
        ),
        scriptedProvider(),
      ).generateArtifact(problemId);

      const secondProvider = scriptedProvider(() => [0.9, 0.8, 0.7]);
      Object.assign(secondProvider, { modelVersion: '3' });
      const regenerator: RetrievalSummaryGenerator = {
        generatorId: 'newer-summary-generator',
        generatorVersion: '8',
        generate: () =>
          Promise.resolve(
            summaryOutput({ normalizedSummary: `about ${second}`, keywords: [second] }),
          ),
      };
      const outcome = await serviceFor(actor, regenerator, secondProvider).generateArtifact(
        problemId,
      );
      expect(outcome.kind).toBe('STORED');

      const count = await pool.query<{ n: string }>(
        `select count(*)::text as n from public.retrieval_artifacts
          where owner_id = $1 and problem_id = $2`,
        [actor.ownerId, problemId],
      );
      expect(Number(count.rows[0]?.n)).toBe(1);

      const stored = await actor.artifacts.getArtifact(problemId);
      expect(stored?.semantic?.embedding).toEqual([0.9, 0.8, 0.7]);
      expect(stored?.summaryGeneratorId).toBe('newer-summary-generator');
      expect(stored?.summaryGeneratorVersion).toBe('8');
      expect(stored?.semantic?.embeddingModelVersion).toBe('3');

      // The lexical document followed the replacement, with no trigger and no
      // application involvement.
      const search = createRetrievalSearchReader(pool, actor.context);
      expect((await search.searchFullText({ text: first })).map((c) => c.problemId)).not.toContain(
        problemId,
      );
      expect((await search.searchFullText({ text: second })).map((c) => c.problemId)).toContain(
        problemId,
      );
    });
  });

  describe('what never reaches the provider', () => {
    it('a Problem that is not this owner’s', async () => {
      const other = await makeActor();
      const theirs = await makeProblem(other, 'theirs');
      const provider = scriptedProvider();

      const outcome = await serviceFor(actor, scriptedGenerator(), provider).generateArtifact(
        theirs,
      );

      expect(outcome.kind).toBe('SOURCE_NOT_AVAILABLE');
      expect(provider.calls).toBe(0);
    });

    it('a Problem whose owner turned automatic reading off', async () => {
      const problemId = await makeProblem(actor, 'read-off');
      const problem = await actor.memory.getProblem(problemId);
      await actor.memory.updateProblem(problemId, problem?.version ?? 0, {
        memoryReadEnabled: false,
      });
      const provider = scriptedProvider();

      const outcome = await serviceFor(actor, scriptedGenerator(), provider).generateArtifact(
        problemId,
      );

      expect(outcome.kind).toBe('MEMORY_READ_DISABLED');
      expect(provider.calls).toBe(0);
    });

    it('a summary the privacy boundary refused', async () => {
      const problemId = await makeProblem(actor, 'secret-summary');
      const provider = scriptedProvider();

      // The draft is refused whole by P4-02's inspection, and because this
      // service obtains its drafts through the summary service rather than
      // accepting them, there is no way around that check: the provider is
      // never called with the credential-bearing text.
      await expect(
        serviceFor(
          actor,
          scriptedGenerator(() =>
            summaryOutput({ normalizedSummary: `leaked: ${SECRET.inSummary}` }),
          ),
          provider,
        ).generateArtifact(problemId),
      ).rejects.toBeInstanceOf(SanitizationRejectedError);

      expect(provider.calls).toBe(0);
      expect(await actor.artifacts.getArtifact(problemId)).toBeUndefined();
    });
  });

  describe('when the provider misbehaves', () => {
    it('reports a failure without quoting what it threw', async () => {
      const problemId = await makeProblem(actor, 'provider-throw');
      const failing = scriptedProvider(() => {
        throw new Error(`provider said: ${SECRET.inProviderError}`);
      });

      let raised: unknown;
      try {
        await serviceFor(actor, scriptedGenerator(), failing).generateArtifact(problemId);
      } catch (error) {
        raised = error;
      }

      expect(raised).toBeInstanceOf(EmbeddingGenerationFailedError);
      // A provider error is the likeliest place for the sent text, a request
      // body or the provider's own credential to be quoted back. Checked as
      // booleans so a failure prints `true`, never the value.
      expect((raised as Error).message.includes('Mm3Yf8R'), 'the failure quoted the provider').toBe(
        false,
      );
      expect((raised as { cause?: unknown }).cause).toBeUndefined();
      expect(await actor.artifacts.getArtifact(problemId)).toBeUndefined();
    });

    it.each([
      ['a string', () => 'an embedding'],
      ['null', () => null],
      ['an object', () => ({ vector: [1, 2, 3] })],
      ['too few dimensions', () => [0.1, 0.2]],
      ['too many dimensions', () => [0.1, 0.2, 0.3, 0.4]],
      ['a NaN', () => [0.1, Number.NaN, 0.3]],
      ['an infinity', () => [0.1, Number.POSITIVE_INFINITY, 0.3]],
      ['all zeros', () => [0, 0, 0]],
    ])('refuses %s and stores nothing', async (_label, respond) => {
      const problemId = await makeProblem(actor, 'malformed');

      await expect(
        serviceFor(actor, scriptedGenerator(), scriptedProvider(respond)).generateArtifact(
          problemId,
        ),
      ).rejects.toBeInstanceOf(InvalidEmbeddingProviderOutputError);

      expect(await actor.artifacts.getArtifact(problemId)).toBeUndefined();
    });

    it('cannot be handed a zero vector even through the repository directly', async () => {
      const problemId = await makeProblem(actor, 'zero-direct');

      // The provider boundary is the first check, not the only one: the
      // artifact domain refuses the same vector whatever path it takes.
      await expect(
        actor.artifacts.upsertArtifact({
          problemId,
          normalizedSummary: 'a summary',
          keywords: [],
          structuralFeatures: {},
          summaryGeneratorId: 'fixture-summary-generator',
          summaryGeneratorVersion: '1',
          semantic: {
            embedding: [0, 0, 0],
            embeddingModel: 'fixture-embedding-model',
            embeddingModelVersion: '1',
          },
          sourceFingerprint: 'retrieval-source-v1:whatever',
          generatedAt: FIXED_NOW,
        }),
      ).rejects.toThrow();

      expect(await actor.artifacts.getArtifact(problemId)).toBeUndefined();
    });
  });

  describe('when the source moves while the embedding is being computed', () => {
    it('notices a new Event and stores nothing', async () => {
      const problemId = await makeProblem(actor, 'embed-race');
      const provider = barrierProvider();
      const running = serviceFor(actor, scriptedGenerator(), provider).generateArtifact(problemId);

      await provider.entered;
      // The draft's own race check has already passed; this lands squarely in
      // the window the final gate exists for.
      await actor.memory.appendEvent({
        problemId,
        eventType: 'DISCOVERY',
        summary: 'the real cause turned up mid-embedding',
        clientEventId: toClientEventId(randomUUID()),
      });
      provider.release();

      const outcome = await running;
      expect(outcome.kind).toBe('SOURCE_CHANGED');
      expect(await actor.artifacts.getArtifact(problemId)).toBeUndefined();
    });

    it('ends with the artifact absent: the append removed it and the stale run cannot rewrite it', async () => {
      const problemId = await makeProblem(actor, 'embed-race-existing');
      const first = await serviceFor(
        actor,
        scriptedGenerator(),
        scriptedProvider(),
      ).generateArtifact(problemId);
      expect(first.kind).toBe('STORED');
      expect(await actor.artifacts.getArtifact(problemId)).toBeDefined();

      const provider = barrierProvider();
      const running = serviceFor(actor, scriptedGenerator(), provider).generateArtifact(problemId);
      await provider.entered;
      await actor.memory.appendEvent({
        problemId,
        eventType: 'ATTEMPT',
        summary: 'tried again mid-embedding',
        clientEventId: toClientEventId(randomUUID()),
      });
      provider.release();

      // Both halves of the lifecycle in one interleaving. The append took the
      // stored artifact with it in its own statement — a rendering of the
      // pre-append source must not survive the append — and the generation
      // that had been reading that source reaches the locked gate, sees the
      // fingerprint no longer matches, and writes nothing. Stale data loses
      // both ways; what remains is absence, which reconciliation can see.
      expect((await running).kind).toBe('SOURCE_CHANGED');
      expect(await actor.artifacts.getArtifact(problemId)).toBeUndefined();
    });

    it('notices the read control turned off and stores nothing', async () => {
      const problemId = await makeProblem(actor, 'embed-read-off');
      const provider = barrierProvider();
      const running = serviceFor(actor, scriptedGenerator(), provider).generateArtifact(problemId);

      await provider.entered;
      const problem = await actor.memory.getProblem(problemId);
      await actor.memory.updateProblem(problemId, problem?.version ?? 0, {
        memoryReadEnabled: false,
      });
      provider.release();

      // The fingerprint cannot catch this one — a control is not content — so
      // the gate checks it separately.
      const outcome = await running;
      expect(outcome.kind).toBe('MEMORY_READ_DISABLED');
      expect(await actor.artifacts.getArtifact(problemId)).toBeUndefined();
    });

    it('notices the Problem being deleted, whose artifact went with it', async () => {
      const problemId = await makeProblem(actor, 'embed-delete');
      const first = await serviceFor(
        actor,
        scriptedGenerator(),
        scriptedProvider(),
      ).generateArtifact(problemId);
      expect(first.kind).toBe('STORED');

      const provider = barrierProvider();
      const running = serviceFor(actor, scriptedGenerator(), provider).generateArtifact(problemId);
      await provider.entered;
      const problem = await actor.memory.getProblem(problemId);
      await actor.memory.deleteProblem(problemId, problem?.version ?? 0);
      provider.release();

      // Answered by the gate's read, not by a foreign-key explosion. And the
      // previously stored artifact is gone too — the delete path removed it
      // with the Problem, which is that path's answer rather than this one's.
      expect((await running).kind).toBe('SOURCE_NOT_AVAILABLE');
      const count = await pool.query<{ n: string }>(
        `select count(*)::text as n from public.retrieval_artifacts
          where owner_id = $1 and problem_id = $2`,
        [actor.ownerId, problemId],
      );
      expect(Number(count.rows[0]?.n)).toBe(0);
    });
  });

  describe('the gate itself', () => {
    it('holds concurrent writes still until the artifact commits', async () => {
      // The property the lock buys, demonstrated with real concurrency: while
      // the gate transaction holds the Problem row, an Event append from
      // another connection does not complete. Observed through the database's
      // own wait state — never a sleep.
      const problemId = await makeProblem(actor, 'lock');

      const client = await pool.connect();
      const writerPool = createPool(
        resolveDatabaseConfig({ nodeEnv: 'test', connectionTimeoutMillis: 5_000 }),
      );
      try {
        await client.query('begin');
        await client.query(
          `select 1 from public.problems where owner_id = $1 and problem_id = $2 for update`,
          [actor.ownerId, problemId],
        );

        let appended = false;
        const writerContext = await resolveOwnerContextFor(writerPool, actor.ownerId);
        const writer = createMemoryRepository(writerPool, writerContext);
        const inflight = writer
          .appendEvent({
            problemId,
            eventType: 'ATTEMPT',
            summary: 'racing the gate',
            clientEventId: toClientEventId(randomUUID()),
          })
          .then((event) => {
            appended = true;
            return event;
          });

        // Wait until the database itself reports the writer blocked on a lock.
        let blocked = false;
        for (let attempt = 0; attempt < 2000 && !blocked && !appended; attempt += 1) {
          const waiting = await pool.query<{ n: string }>(
            `select count(*)::text as n from pg_locks l
              join pg_stat_activity a on a.pid = l.pid
             where not l.granted and a.query like '%insert into public.events%'`,
          );
          blocked = Number(waiting.rows[0]?.n) > 0;
        }

        expect(blocked, 'the append never blocked on the gate').toBe(true);
        expect(appended, 'the append completed while the gate was held').toBe(false);

        await client.query('commit');
        await inflight;
        expect(appended).toBe(true);
      } finally {
        await client.query('rollback').catch(() => {});
        client.release();
        await closePool(writerPool);
      }
    });

    it('does not call the provider inside the transaction', async () => {
      // The order that keeps somebody's inference latency from becoming
      // everybody's lock time: the provider finishes before the transaction
      // runner is entered at all.
      const problemId = await makeProblem(actor, 'ordering');
      const order: string[] = [];

      const provider = scriptedProvider();
      const originalEmbed = provider.embed.bind(provider);
      provider.embed = (input) => {
        order.push('embed');
        return originalEmbed(input);
      };

      const runner = createTransactionRunner(pool);
      const observingRunner: DatabaseTransactionRunner = {
        run: (work) => {
          order.push('transaction');
          return runner.run(work);
        },
      };

      const outcome = await createRetrievalArtifactGenerationService(
        createRetrievalSummaryService(
          createRetrievalSummarySourceReader(pool, actor.context),
          scriptedGenerator(),
        ),
        provider,
        observingRunner,
        actor.context,
        () => {
          order.push('now');
          return FIXED_NOW;
        },
      ).generateArtifact(problemId);

      expect(outcome.kind).toBe('STORED');
      // The clock is read when the complete content first exists: after the
      // embedding, before the gate. Reading it earlier would stamp a moment
      // at which no complete content existed yet.
      expect(order).toEqual(['embed', 'now', 'transaction']);
    });

    it('rolls the write back when the upsert fails inside it', async () => {
      const problemId = await makeProblem(actor, 'rollback');
      const before = await memoryStored(actor.ownerId);

      // A generator whose keywords are fine for the draft but refused by the
      // artifact policy cannot exist — the policies agree — so a storage-level
      // failure is provoked instead: a fingerprint longer than any real one,
      // driven through the same path, fails nothing... so instead the summary
      // is made to collide with the artifact boundary by carrying a suspected
      // secret the draft policy keeps and the artifact policy also keeps.
      // What CAN fail inside the gate in production is the database itself,
      // so that is what is simulated: a runner whose executor refuses the
      // upsert statement.
      const runner = createTransactionRunner(pool);
      const sabotagingRunner: DatabaseTransactionRunner = {
        run: (work) =>
          runner.run((executor) => {
            const failing: typeof executor = {
              query: (text, values) => {
                if (
                  typeof text === 'string' &&
                  text.includes('insert into public.retrieval_artifacts')
                ) {
                  throw new Error('simulated storage failure');
                }
                return executor.query(text, values);
              },
            };
            return work(failing);
          }),
      };

      await expect(
        createRetrievalArtifactGenerationService(
          createRetrievalSummaryService(
            createRetrievalSummarySourceReader(pool, actor.context),
            scriptedGenerator(),
          ),
          scriptedProvider(),
          sabotagingRunner,
          actor.context,
          () => FIXED_NOW,
        ).generateArtifact(problemId),
      ).rejects.toThrow();

      expect(await actor.artifacts.getArtifact(problemId)).toBeUndefined();
      expect(await memoryStored(actor.ownerId)).toBe(before);
    });
  });

  describe('what a provider must declare', () => {
    it('refuses construction with a broken identity', () => {
      expect(() =>
        createRetrievalArtifactGenerationService(
          createRetrievalSummaryService(
            createRetrievalSummarySourceReader(pool, actor.context),
            scriptedGenerator(),
          ),
          scriptedProvider() && { ...scriptedProvider(), dimensions: 0 },
          createTransactionRunner(pool),
          actor.context,
        ),
      ).toThrow();
    });
  });
});
