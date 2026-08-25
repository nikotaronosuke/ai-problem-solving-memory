/**
 * Generating a retrieval summary, against a real database.
 *
 * The generator here is scripted rather than a model, and that is the design
 * rather than a shortcut. What this file proves is orchestration — that the
 * source is read consistently, that the output is checked before anyone sees
 * it, that a Memory edited mid-generation is noticed, that a person's decision
 * not to have a Problem read is honoured, and that nothing is written down.
 * None of those depend on which model produced the words, and testing them
 * against a real one would make every run depend on a network call, a
 * credential, and an answer that is different each time.
 *
 * Whether the words are any *good* — whether a summary of a React problem
 * actually matches a structurally identical Fastify one — is a different
 * question, measured against fixtures by the evaluation task. Nothing here
 * claims it.
 *
 * Every race below is a real barrier: the generator blocks, the test changes
 * the Memory underneath it, and the generator is released. No sleeps, so
 * nothing here passes because a timing guess happened to hold.
 *
 * Every credential fixture is synthetic.
 *
 * Skipped when `DATABASE_URL` is not set.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createRetrievalSummaryService,
  RetrievalSummaryGenerationFailedError,
  type GenerateRetrievalSummaryOutcome,
  type RetrievalSummaryGenerator,
  type RetrievalSummaryService,
} from '../../src/app/index.js';
import { readDatabaseUrl } from '../../src/config/env.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import { toClientEventId } from '../../src/domain/client-event-id.js';
import { generateOwnerId, type OwnerContext, type OwnerId } from '../../src/domain/owner.js';
import type { ProblemId } from '../../src/domain/problem.js';
import {
  fingerprintRetrievalSource,
  InvalidRetrievalSummaryError,
  STRUCTURAL_FEATURE_SCHEMA_VERSION,
} from '../../src/domain/retrieval-summary.js';
import { resolveOwnerContextFor } from '../../src/owner/context.js';
import {
  createMemoryRepository,
  createRetrievalArtifactRepository,
  createRetrievalSummarySourceReader,
  type MemoryRepository,
  type RetrievalArtifactRepository,
  type RetrievalSummarySourceReader,
} from '../../src/repository/index.js';
import {
  createArtifactInspectionPolicy,
  createSecretDetectionPolicy,
  SanitizationRejectedError,
  withSanitization,
} from '../../src/sanitization/index.js';

const databaseUrl = readDatabaseUrl();

/** Synthetic, each with a distinctive tail so a sweep can name what leaked. */
const SECRET = {
  inSummary: 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/fakeAa1Qv7X0123456789',
  inKeyword: 'API_KEY=fake-Bb2Lm2P-0123456789abcdef',
  inFeature: 'client_secret=fake-Cc3Tr8K-0123456789abcdef',
  inDomain: 'PASSWORD=fake-Dd4Nw5J-0123456789',
  // The nested form the Phase 3 audit found, which read as prose until it was
  // closed. A generator writing prose is exactly where this shape appears.
  nested: 'ran x=AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/fakeEe5Bz3Q0123456789 then failed',
  // In a field this code never asked for, which is refused by the shape before
  // the detector is reached. The value still must not survive anywhere.
  inUnknownField: 'API_KEY=fake-Ii9Rt3M-0123456789abcdef',
} as const;

const MARKERS = ['Aa1Qv7X', 'Bb2Lm2P', 'Cc3Tr8K', 'Dd4Nw5J', 'Ee5Bz3Q', 'Ii9Rt3M'] as const;

const ALL_TABLES = [
  'projects',
  'environments',
  'problems',
  'events',
  'verifications',
  'relations',
  'usage_logs',
  'change_logs',
  'retrieval_artifacts',
] as const;

function featuresWith(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: STRUCTURAL_FEATURE_SCHEMA_VERSION,
    problem_domain: 'deployment',
    symptom_patterns: ['works locally, fails once deployed'],
    suspected_boundaries: ['configuration resolved at build time rather than at run time'],
    occurrence_conditions: ['only in the deployed environment'],
    successful_directions: [],
    dead_end_directions: ['raising the timeout'],
    environment_facts: ['node 22.12.0'],
    ...overrides,
  };
}

function outputWith(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    normalizedSummary: 'a callback fails only after deployment because the host is fixed at build',
    keywords: ['callback', 'deployment'],
    structuralFeatures: featuresWith(),
    ...overrides,
  };
}

/**
 * A generator that answers immediately, and remembers what it was shown.
 *
 * `sources` is the evidence for two separate claims: that a generator is not
 * called at all when it must not be, and that what it received is exactly the
 * document that was fingerprinted.
 */
function scriptedGenerator(respond: (source: string) => unknown): RetrievalSummaryGenerator & {
  readonly sources: string[];
} {
  const sources: string[] = [];
  return {
    generatorId: 'scripted-summary-generator',
    generatorVersion: '1',
    sources,
    generate({ source }) {
      sources.push(source);
      return Promise.resolve(respond(source));
    },
  };
}

/** A generator that stops inside the call until the test lets it continue. */
function barrierGenerator(respond: (source: string) => unknown): RetrievalSummaryGenerator & {
  readonly entered: Promise<void>;
  readonly sources: string[];
  release(): void;
} {
  const sources: string[] = [];
  let announceEntry = (): void => {};
  let openGate = (): void => {};
  const entered = new Promise<void>((resolve) => {
    announceEntry = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });

  return {
    generatorId: 'scripted-summary-generator',
    generatorVersion: '1',
    entered,
    sources,
    release: () => {
      openGate();
    },
    async generate({ source }) {
      sources.push(source);
      announceEntry();
      await gate;
      return respond(source);
    },
  };
}

interface Actor {
  readonly ownerId: OwnerId;
  readonly context: OwnerContext;
  readonly memory: MemoryRepository;
  readonly artifacts: RetrievalArtifactRepository;
  readonly reader: RetrievalSummarySourceReader;
}

describe.skipIf(databaseUrl === undefined)('generating a retrieval summary', () => {
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
      reader: createRetrievalSummarySourceReader(pool, context),
    };
  }

  /** A Problem with an Environment, a dead end, a fix and a passing check. */
  async function makeProblem(owner: Actor, tag: string): Promise<ProblemId> {
    const project = await owner.memory.createProject({ projectName: `${tag} project` });
    const environment = await owner.memory.createEnvironment({
      projectId: project.projectId,
      snapshot: { runtime: 'node 22.12.0', deployment: 'container' },
    });
    const problem = await owner.memory.createProblem({
      projectId: project.projectId,
      environmentId: environment.environmentId,
      title: `${tag} title`,
      symptoms: 'the callback returns 500 after deployment only',
      problemDomain: 'deployment',
      suspectedBoundary: 'configuration',
    });

    for (const [eventType, summary] of [
      ['HYPOTHESIS', 'the redirect host may be wrong'],
      ['DEAD_END', 'raising the timeout changed nothing'],
      ['DISCOVERY', 'the host is read at build time'],
      ['FIX', 'read the host at run time'],
    ] as const) {
      await owner.memory.appendEvent({
        problemId: problem.problemId,
        eventType,
        summary,
        clientEventId: toClientEventId(randomUUID()),
      });
    }

    return problem.problemId;
  }

  function serviceFor(owner: Actor, generator: RetrievalSummaryGenerator): RetrievalSummaryService {
    return createRetrievalSummaryService(owner.reader, generator);
  }

  /** Everything this owner has, as text, for a before-and-after comparison. */
  async function everythingStored(ownerId: OwnerId): Promise<string> {
    const dumps: string[] = [];
    for (const table of ALL_TABLES) {
      const rows = await pool.query(
        `select to_jsonb(t) as row from public.${table} t where owner_id = $1 order by 1`,
        [ownerId],
      );
      dumps.push(`${table}:${JSON.stringify(rows.rows)}`);
    }
    return dumps.join('\n');
  }

  const artifactCount = async (ownerId: OwnerId): Promise<number> =>
    Number(
      (
        await pool.query<{ n: string }>(
          `select count(*) as n from public.retrieval_artifacts where owner_id = $1`,
          [ownerId],
        )
      ).rows[0]?.n ?? '0',
    );

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

  describe('when nothing moves underneath it', () => {
    it('returns a draft built from exactly what the generator was shown', async () => {
      const problemId = await makeProblem(actor, 'stable');
      const generator = scriptedGenerator(() => outputWith());

      const outcome = await serviceFor(actor, generator).generateSummary(problemId);

      expect(outcome.kind).toBe('GENERATED');
      if (outcome.kind !== 'GENERATED') return;

      expect(outcome.draft.problemId).toBe(problemId);
      expect(outcome.draft.normalizedSummary).toContain('deployment');
      expect(outcome.draft.keywords).toEqual(['callback', 'deployment']);
      expect(outcome.draft.structuralFeatures.dead_end_directions).toEqual(['raising the timeout']);
      expect(outcome.generatorId).toBe('scripted-summary-generator');
      expect(outcome.generatorVersion).toBe('1');

      // The document the generator saw is the document the digest names. Two
      // questions — "what was this built from?" and "what did the generator
      // read?" — with one answer, which is the reason the digest is taken over
      // the exact bytes rather than a chosen list of fields.
      expect(generator.sources).toHaveLength(1);
      expect(outcome.draft.sourceFingerprint).toBe(
        fingerprintRetrievalSource(generator.sources[0] ?? ''),
      );
      const read = await actor.reader.readSource(problemId);
      expect(generator.sources[0]).toBe(read?.canonicalSource);
    });

    it('leaves the Memory byte for byte as it was', async () => {
      const problemId = await makeProblem(actor, 'untouched');
      const before = await everythingStored(actor.ownerId);

      const outcome = await serviceFor(
        actor,
        scriptedGenerator(() => outputWith()),
      ).generateSummary(problemId);

      expect(outcome.kind).toBe('GENERATED');
      // Including `version` and `updated_at`. Generating a summary is reading,
      // and a read that bumped a version would make every generation look like
      // an edit to anyone holding an optimistic lock.
      expect(await everythingStored(actor.ownerId)).toBe(before);
    });

    it('stores no artifact, because an artifact needs an embedding', async () => {
      const problemId = await makeProblem(actor, 'unstored');

      const outcome = await serviceFor(
        actor,
        scriptedGenerator(() => outputWith()),
      ).generateSummary(problemId);

      expect(outcome.kind).toBe('GENERATED');
      expect(await artifactCount(actor.ownerId)).toBe(0);
    });
  });

  describe('the successful-direction gate, decided from the record', () => {
    it('refuses a claim on a Problem that was never verified', async () => {
      const problemId = await makeProblem(actor, 'unverified');
      const generator = scriptedGenerator(() =>
        outputWith({
          structuralFeatures: featuresWith({
            successful_directions: ['read the host at run time'],
          }),
        }),
      );

      // A FIX Event exists on this Problem. It is still not evidence that the
      // fix worked — nothing links a FIX to a Verification — so the claim is
      // refused rather than taken at the generator's word.
      await expect(serviceFor(actor, generator).generateSummary(problemId)).rejects.toBeInstanceOf(
        InvalidRetrievalSummaryError,
      );
    });

    it('allows one once a successful Verification carried it to VERIFIED', async () => {
      const problemId = await makeProblem(actor, 'verified');
      await actor.memory.appendVerification({
        problemId,
        verificationType: 'TEST',
        result: true,
        summary: 'the suite passes against the deployed build',
        clientEventId: toClientEventId(randomUUID()),
      });
      const problem = await actor.memory.getProblem(problemId);
      await actor.memory.updateProblemConclusion(problemId, problem?.version ?? 0, {
        status: 'VERIFIED',
        fixKind: 'ROOT_FIX',
      });

      const outcome = await serviceFor(
        actor,
        scriptedGenerator(() =>
          outputWith({
            structuralFeatures: featuresWith({
              successful_directions: ['read the host at run time'],
            }),
          }),
        ),
      ).generateSummary(problemId);

      expect(outcome.kind).toBe('GENERATED');
      if (outcome.kind !== 'GENERATED') return;
      expect(outcome.draft.structuralFeatures.successful_directions).toEqual([
        'read the host at run time',
      ]);
    });

    it('refuses a claim on a Problem holding only a failed Verification', async () => {
      const problemId = await makeProblem(actor, 'failed-check');
      await actor.memory.appendVerification({
        problemId,
        verificationType: 'BUILD',
        result: false,
        summary: 'the build still fails',
        clientEventId: toClientEventId(randomUUID()),
      });

      await expect(
        serviceFor(
          actor,
          scriptedGenerator(() =>
            outputWith({
              structuralFeatures: featuresWith({ successful_directions: ['something'] }),
            }),
          ),
        ).generateSummary(problemId),
      ).rejects.toBeInstanceOf(InvalidRetrievalSummaryError);
    });
  });

  describe('when the owner has turned automatic reading off', () => {
    it('never calls the generator at all', async () => {
      const problemId = await makeProblem(actor, 'read-off');
      const problem = await actor.memory.getProblem(problemId);
      await actor.memory.updateProblem(problemId, problem?.version ?? 0, {
        memoryReadEnabled: false,
      });

      const generator = scriptedGenerator(() => outputWith());
      const outcome = await serviceFor(actor, generator).generateSummary(problemId);

      expect(outcome.kind).toBe('MEMORY_READ_DISABLED');
      // The whole point of checking first. A generator is ultimately a model
      // that would be handed this Problem's text, and a check made afterwards
      // would discard the answer having already sent it.
      expect(generator.sources).toEqual([]);
    });

    it('discards the draft when it is turned off during the generation', async () => {
      const problemId = await makeProblem(actor, 'read-off-race');
      const generator = barrierGenerator(() => outputWith());
      const running = serviceFor(actor, generator).generateSummary(problemId);

      await generator.entered;
      const problem = await actor.memory.getProblem(problemId);
      await actor.memory.updateProblem(problemId, problem?.version ?? 0, {
        memoryReadEnabled: false,
      });
      generator.release();

      // The digest cannot catch this: a control is not part of the document,
      // so the source is unchanged and the fingerprints match. It has to be
      // its own check, and this is the test that says so.
      expect((await running).kind).toBe('MEMORY_READ_DISABLED');
    });
  });

  describe('when the source moves during the generation', () => {
    it('notices a new Event and discards the draft', async () => {
      const problemId = await makeProblem(actor, 'race');
      const generator = barrierGenerator(() => outputWith());
      const running = serviceFor(actor, generator).generateSummary(problemId);

      await generator.entered;
      await actor.memory.appendEvent({
        problemId,
        eventType: 'DEAD_END',
        summary: 'restarting the container changed nothing either',
        clientEventId: toClientEventId(randomUUID()),
      });
      generator.release();

      const outcome = await running;
      expect(outcome.kind).toBe('SOURCE_CHANGED');
      // No draft on this branch: a summary written before the dead end was
      // recorded does not describe the Problem any more, and the fingerprint
      // it would carry would claim otherwise.
      expect(Object.hasOwn(outcome, 'draft')).toBe(false);
      expect(await artifactCount(actor.ownerId)).toBe(0);
    });

    it('notices the Problem being removed', async () => {
      const problemId = await makeProblem(actor, 'deleted');
      const problem = await actor.memory.getProblem(problemId);
      const generator = barrierGenerator(() => outputWith());
      const running = serviceFor(actor, generator).generateSummary(problemId);

      await generator.entered;
      await actor.memory.deleteProblem(problemId, problem?.version ?? 0);
      generator.release();

      // Reported by reading again, not by a foreign key complaining: nothing
      // is written here, so there is no constraint to rely on.
      expect((await running).kind).toBe('SOURCE_NOT_AVAILABLE');
    });

    it('accepts a Memory that was edited and put back as it was', async () => {
      const problemId = await makeProblem(actor, 'reverted');
      const generator = barrierGenerator(() => outputWith());
      const running = serviceFor(actor, generator).generateSummary(problemId);

      await generator.entered;
      const original = await actor.memory.getProblem(problemId);
      const changed = await actor.memory.updateProblem(problemId, original?.version ?? 0, {
        symptoms: 'something else entirely',
      });
      await actor.memory.updateProblem(problemId, changed?.version ?? 0, {
        symptoms: original?.symptoms ?? '',
      });
      generator.release();

      // The digest is over meaning, not over history. The generator read a
      // document, and that document is what the Problem says again — so the
      // summary describes it, and two version bumps do not change that.
      expect((await running).kind).toBe('GENERATED');
    });
  });

  describe('when the Problem is not this owner’s', () => {
    it('answers the same as it would for one that does not exist', async () => {
      const other = await makeActor();
      const theirs = await makeProblem(other, 'theirs');
      const generator = scriptedGenerator(() => outputWith());

      const outcome = await serviceFor(actor, generator).generateSummary(theirs);

      expect(outcome.kind).toBe('SOURCE_NOT_AVAILABLE');
      // Not merely refused: another owner's Memory never reached the
      // generator, which is where it would have left the process.
      expect(generator.sources).toEqual([]);
    });
  });

  describe('when the generated summary carries a credential', () => {
    it.each([
      ['the summary', () => outputWith({ normalizedSummary: `it failed: ${SECRET.inSummary}` })],
      [
        'a nested assignment in the summary',
        () => outputWith({ normalizedSummary: SECRET.nested }),
      ],
      ['a keyword', () => outputWith({ keywords: ['deployment', SECRET.inKeyword] })],
      [
        'a structural label',
        () =>
          outputWith({
            structuralFeatures: featuresWith({ environment_facts: [SECRET.inFeature] }),
          }),
      ],
      [
        'the problem domain',
        () => outputWith({ structuralFeatures: featuresWith({ problem_domain: SECRET.inDomain }) }),
      ],
    ])('refuses the whole draft when %s does', async (_label, build) => {
      const problemId = await makeProblem(actor, 'secret');

      // Refused here rather than at storage, and that is the whole point of
      // checking at this stage: the next step hands this text to an embedding
      // provider, so a refusal that waited for the write would arrive after
      // the value had already been sent somewhere else.
      await expect(
        serviceFor(
          actor,
          scriptedGenerator(() => build()),
        ).generateSummary(problemId),
      ).rejects.toBeInstanceOf(SanitizationRejectedError);

      expect(await artifactCount(actor.ownerId)).toBe(0);
    });

    it('refuses one written into a structural field name', async () => {
      const problemId = await makeProblem(actor, 'secret-key');

      // Caught by the shape rather than by the detector — a field nobody
      // defined is refused before its contents are considered at all — and the
      // outcome that matters is the same one: no draft.
      await expect(
        serviceFor(
          actor,
          scriptedGenerator(() =>
            outputWith({ structuralFeatures: featuresWith({ [SECRET.inKeyword]: 'present' }) }),
          ),
        ).generateSummary(problemId),
      ).rejects.toBeInstanceOf(InvalidRetrievalSummaryError);
    });

    it('refuses one carrying it in a field nobody asked for', async () => {
      const problemId = await makeProblem(actor, 'secret-extra');

      // The output is otherwise perfectly well formed — summary, keywords and
      // features all valid — with one field this code does not produce. That
      // field is refused before it is read, so nothing decides what to do with
      // its contents and nothing carries them onward. The marker sweep below
      // covers the value itself.
      await expect(
        serviceFor(
          actor,
          scriptedGenerator(() => outputWith({ leaked: SECRET.inUnknownField })),
        ).generateSummary(problemId),
      ).rejects.toBeInstanceOf(InvalidRetrievalSummaryError);

      expect(await artifactCount(actor.ownerId)).toBe(0);
    });

    it('leaves nothing of any refused draft in storage', async () => {
      const stored = await everythingStored(actor.ownerId);

      for (const marker of MARKERS) {
        expect(stored.includes(marker), `marker ${marker} reached storage`).toBe(false);
      }
    });

    it('still generates one that only talks about credentials', async () => {
      // The other half of the contract. A summary may say a token expired, and
      // the line drawn is the same one the write boundary and the export draw.
      const problemId = await makeProblem(actor, 'false-positive');

      const outcome = await serviceFor(
        actor,
        scriptedGenerator(() =>
          outputWith({
            normalizedSummary: 'the access token had expired, so the callback returned 401',
            keywords: ['token', 'expired'],
            structuralFeatures: featuresWith({ environment_facts: ['password: unknown'] }),
          }),
        ),
      ).generateSummary(problemId);

      expect(outcome.kind).toBe('GENERATED');
      if (outcome.kind !== 'GENERATED') return;
      expect(outcome.draft.normalizedSummary).toContain('access token had expired');
    });
  });

  describe('when the generator misbehaves', () => {
    it('reports a failure without quoting what it said', async () => {
      const problemId = await makeProblem(actor, 'thrower');
      const leak = 'provider said: Bearer fake-Ff6Xy4W-0123456789abcdef';

      const failing: RetrievalSummaryGenerator = {
        generatorId: 'scripted-summary-generator',
        generatorVersion: '1',
        generate: () => Promise.reject(new Error(leak)),
      };

      let raised: unknown;
      try {
        await serviceFor(actor, failing).generateSummary(problemId);
      } catch (error) {
        raised = error;
      }

      expect(raised).toBeInstanceOf(RetrievalSummaryGenerationFailedError);
      const message = (raised as Error).message;
      // A summariser is the one component handed a whole Memory that also
      // talks to something outside the process, so its errors are the likeliest
      // place for that Memory — or a provider's own credential — to be quoted
      // back. Checked as a boolean so a failure prints `true`, never the value.
      expect(message.includes('Ff6Xy4W'), 'the failure quoted the provider').toBe(false);
      expect((raised as { cause?: unknown }).cause).toBeUndefined();
    });

    it.each([
      ['a string', 'here is your summary'],
      ['null', null],
      ['an array', []],
      ['an object missing its features', { normalizedSummary: 'a', keywords: [] }],
    ])('refuses %s in place of a summary', async (_label, response) => {
      const problemId = await makeProblem(actor, 'malformed');

      await expect(
        serviceFor(
          actor,
          scriptedGenerator(() => response),
        ).generateSummary(problemId),
      ).rejects.toBeInstanceOf(InvalidRetrievalSummaryError);
    });

    it('refuses one that names a generator with no identity', () => {
      expect(() =>
        createRetrievalSummaryService(actor.reader, {
          generatorId: '  ',
          generatorVersion: '1',
          generate: () => Promise.resolve(outputWith()),
        }),
      ).toThrow();
    });
  });

  describe('an artifact that is already stored', () => {
    it('is left alone whatever the generation does', async () => {
      const problemId = await makeProblem(actor, 'existing');
      await actor.artifacts.upsertArtifact({
        problemId,
        normalizedSummary: 'an artifact written by a fixture',
        keywords: ['existing'],
        structuralFeatures: { boundary: 'configuration' },
        summaryGeneratorId: 'fixture-summary-generator',
        summaryGeneratorVersion: '1',
        semantic: {
          embedding: [0.5, 0.25],
          embeddingModel: 'fixture-model',
          embeddingModelVersion: '1',
        },
        sourceFingerprint: 'retrieval-source-v1:whatever-was-current-then',
        generatedAt: new Date('2026-08-15T10:00:00.000Z'),
      });
      const before = await actor.artifacts.getArtifact(problemId);
      expect(before).toBeDefined();

      const outcomes: GenerateRetrievalSummaryOutcome[] = [];
      // A success.
      outcomes.push(
        await serviceFor(
          actor,
          scriptedGenerator(() => outputWith()),
        ).generateSummary(problemId),
      );
      // A refusal.
      await expect(
        serviceFor(
          actor,
          scriptedGenerator(() => outputWith({ normalizedSummary: SECRET.inSummary })),
        ).generateSummary(problemId),
      ).rejects.toBeInstanceOf(SanitizationRejectedError);
      // Neither a successful generation nor a refused one moved the stored
      // artifact by a byte: the summary service has no repository to write
      // through, so "generating a summary changed the store" cannot be
      // written.
      expect(await actor.artifacts.getArtifact(problemId)).toEqual(before);

      // A race. The append is a canonical write, and canonical writes take
      // the stored artifact with them in their own statement — so after this,
      // absence is the append's doing, on the append's atomicity, while the
      // summary service still wrote and removed nothing of its own.
      const racing = barrierGenerator(() => outputWith());
      const running = serviceFor(actor, racing).generateSummary(problemId);
      await racing.entered;
      await actor.memory.appendEvent({
        problemId,
        eventType: 'ATTEMPT',
        summary: 'tried it again',
        clientEventId: toClientEventId(randomUUID()),
      });
      racing.release();
      outcomes.push(await running);

      expect(outcomes.map((outcome) => outcome.kind)).toEqual(['GENERATED', 'SOURCE_CHANGED']);
      expect(await actor.artifacts.getArtifact(problemId)).toBeUndefined();
    });
  });
});
