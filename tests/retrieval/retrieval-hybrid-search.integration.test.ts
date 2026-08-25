/**
 * Both channels as one search, against a real database.
 *
 * The fusion arithmetic is pinned by the unit tests; what is proven here is
 * everything the orchestration owns and no fake can establish on its own:
 *
 * **Preflight.** A malformed request must reach neither the database nor an
 * embedding provider — a network call to somebody else's computer, made on
 * behalf of a request that was never going to succeed. Counted, not inferred.
 *
 * **The owner boundary.** Each channel is owner-safe alone and neither can
 * check the other, so pairing one owner's reader with another owner's service
 * would produce a result mixing two people's Memory with both halves behaving
 * correctly. The pairing must be impossible to build.
 *
 * **Which failures degrade.** Exactly one: an embedding provider that cannot
 * be reached. A provider returning something malformed, a database error, a
 * broken invariant — all raised, because a broken component hidden behind a
 * plausible result is the failure that takes longest to notice.
 *
 * Every credential fixture is synthetic. Skipped without `DATABASE_URL`.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createRetrievalHybridSearchService,
  createRetrievalVectorSearchService,
  InvalidEmbeddingProviderOutputError,
  InvalidHybridSearchError,
  MAX_HYBRID_LIMIT,
  MIN_HYBRID_LIMIT,
  type RetrievalHybridSearchService,
} from '../../src/app/index.js';
import { readDatabaseUrl } from '../../src/config/env.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import { EmbeddingGenerationFailedError } from '../../src/domain/retrieval-embedding.js';
import { generateOwnerId, type OwnerContext, type OwnerId } from '../../src/domain/owner.js';
import type { ProblemId } from '../../src/domain/problem.js';
import type { ProjectId } from '../../src/domain/project.js';
import type { EmbeddingProvider } from '../../src/domain/retrieval-embedding.js';
import { RetrievalProviderCallError } from '../../src/domain/retrieval-provider-failure.js';
import { resolveOwnerContextFor } from '../../src/owner/context.js';
import {
  createMemoryRepository,
  createRetrievalArtifactRepository,
  createRetrievalSearchReader,
  createRetrievalVectorSearchReader,
  type MemoryRepository,
  type RetrievalArtifactRepository,
  type RetrievalSearchReader,
} from '../../src/repository/index.js';
import {
  createArtifactInspectionPolicy,
  createSecretDetectionPolicy,
  withSanitization,
} from '../../src/sanitization/index.js';

const databaseUrl = readDatabaseUrl();

const MODEL = { id: 'fixture-embedding-model', version: '2', dimensions: 3 } as const;
const SECRET_QUERY = 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/fakePp6Bj1U0123456789';
const PROVIDER_SECRET = 'Bearer fake-Qq7Ck2V-0123456789abcdef';

function provider(respond: () => unknown = () => [1, 0, 0]): EmbeddingProvider & { calls: number } {
  const p = {
    modelId: MODEL.id,
    modelVersion: MODEL.version,
    dimensions: MODEL.dimensions,
    calls: 0,
    embed() {
      p.calls += 1;
      return Promise.resolve(respond());
    },
  };
  return p;
}

interface Actor {
  readonly ownerId: OwnerId;
  readonly context: OwnerContext;
  readonly memory: MemoryRepository;
  readonly artifacts: RetrievalArtifactRepository;
  readonly lexical: RetrievalSearchReader;
}

describe.skipIf(databaseUrl === undefined)('hybrid candidate retrieval', () => {
  let pool: DatabasePool;
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
      lexical: createRetrievalSearchReader(pool, context),
    };
  }

  function hybridFor(
    owner: Actor,
    embeddingProvider: EmbeddingProvider,
  ): RetrievalHybridSearchService {
    return createRetrievalHybridSearchService(
      owner.lexical,
      createRetrievalVectorSearchService(
        embeddingProvider,
        createRetrievalVectorSearchReader(pool, owner.context),
      ),
    );
  }

  /** A Problem with an artifact: chosen words, chosen vector, chosen model. */
  async function seed(
    owner: Actor,
    options: {
      readonly summary: string;
      readonly keywords: readonly string[];
      readonly embedding: readonly number[];
      readonly model?: string;
      readonly projectId?: ProjectId;
    },
  ): Promise<{ problemId: ProblemId; projectId: ProjectId }> {
    const projectId =
      options.projectId ??
      (await owner.memory.createProject({ projectName: `project ${randomUUID()}` })).projectId;
    const environment = await owner.memory.createEnvironment({
      projectId,
      snapshot: { runtime: 'node 22.12.0' },
    });
    const problem = await owner.memory.createProblem({
      projectId,
      environmentId: environment.environmentId,
      title: 'a seeded title',
      symptoms: 'seeded symptoms',
    });

    await owner.artifacts.upsertArtifact({
      problemId: problem.problemId,
      normalizedSummary: options.summary,
      keywords: [...options.keywords],
      structuralFeatures: { boundary: 'configuration' },
      summaryGeneratorId: 'fixture-summary-generator',
      summaryGeneratorVersion: '1',
      semantic: {
        embedding: [...options.embedding],
        embeddingModel: options.model ?? MODEL.id,
        embeddingModelVersion: MODEL.version,
      },
      sourceFingerprint: `retrieval-source-v1:${randomUUID().replace(/-/g, '')}`,
      generatedAt: new Date('2026-08-16T14:00:00.000Z'),
    });

    return { problemId: problem.problemId, projectId };
  }

  async function everythingStored(ownerId: OwnerId): Promise<string> {
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
      'retrieval_artifacts',
    ]) {
      const rows = await pool.query(
        `select to_jsonb(t) as row from public.${table} t where owner_id = $1 order by 1`,
        [ownerId],
      );
      dumps.push(`${table}:${JSON.stringify(rows.rows)}`);
    }
    return dumps.join('\n');
  }

  beforeAll(() => {
    pool = createPool(resolveDatabaseConfig({ nodeEnv: 'test', connectionTimeoutMillis: 5_000 }));
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

  describe('the owner boundary', () => {
    it('refuses to pair channels belonging to different owners', async () => {
      const one = await makeActor();
      const other = await makeActor();

      // Each channel is owner-safe on its own and neither can check the other,
      // so only the pairing can be wrong — and a wrongly-paired service must
      // not exist rather than fail later on somebody's query.
      expect(() =>
        createRetrievalHybridSearchService(
          one.lexical,
          createRetrievalVectorSearchService(
            provider(),
            createRetrievalVectorSearchReader(pool, other.context),
          ),
        ),
      ).toThrow();
    });

    it('names no owner when it refuses', async () => {
      const one = await makeActor();
      const other = await makeActor();

      let raised: unknown;
      try {
        createRetrievalHybridSearchService(
          one.lexical,
          createRetrievalVectorSearchService(
            provider(),
            createRetrievalVectorSearchReader(pool, other.context),
          ),
        );
      } catch (error) {
        raised = error;
      }

      const message = (raised as Error).message;
      expect(message.includes(one.ownerId), 'the refusal named an owner').toBe(false);
      expect(message.includes(other.ownerId), 'the refusal named an owner').toBe(false);
    });

    it('reports the owner both channels share', async () => {
      const owner = await makeActor();
      expect(hybridFor(owner, provider()).ownerId).toBe(owner.ownerId);
    });
  });

  describe('validating before anything runs', () => {
    it.each([
      ['the lexical text is blank', { lexicalText: '   ', semanticText: 'fine' }],
      [
        'the lexical text is past its bound',
        { lexicalText: 'a'.repeat(1001), semanticText: 'fine' },
      ],
      ['the semantic text is blank', { lexicalText: 'fine', semanticText: '  ' }],
      [
        'the semantic text is past its bound',
        { lexicalText: 'fine', semanticText: 'a'.repeat(4001) },
      ],
      ['the limit is below the stage floor', { lexicalText: 'a', semanticText: 'b', limit: 1 }],
      ['the limit is above the stage ceiling', { lexicalText: 'a', semanticText: 'b', limit: 21 }],
      ['the limit is fractional', { lexicalText: 'a', semanticText: 'b', limit: 12.5 }],
    ])('refuses when %s, having called nothing', async (_label, request) => {
      const owner = await makeActor();
      const embedding = provider();
      let lexicalCalls = 0;
      const countingLexical: RetrievalSearchReader = {
        ownerId: owner.lexical.ownerId,
        searchFullText: (query) => {
          lexicalCalls += 1;
          return owner.lexical.searchFullText(query);
        },
        searchFullTextWithFallback: (query) => {
          lexicalCalls += 1;
          return owner.lexical.searchFullTextWithFallback(query);
        },
      };
      const hybrid = createRetrievalHybridSearchService(
        countingLexical,
        createRetrievalVectorSearchService(
          embedding,
          createRetrievalVectorSearchReader(pool, owner.context),
        ),
      );

      await expect(hybrid.search(request)).rejects.toThrow();
      // Neither the database nor the provider was troubled by a request that
      // could never have succeeded.
      expect(lexicalCalls).toBe(0);
      expect(embedding.calls).toBe(0);
    });

    it('accepts the stage’s whole range and defaults to the top of it', async () => {
      const owner = await makeActor();
      await seed(owner, { summary: 'anything', keywords: ['anything'], embedding: [1, 0, 0] });
      const hybrid = hybridFor(owner, provider());

      for (const limit of [MIN_HYBRID_LIMIT, MAX_HYBRID_LIMIT]) {
        await expect(
          hybrid.search({ lexicalText: 'anything', semanticText: 'anything', limit }),
        ).resolves.toBeDefined();
      }
      // A caller asking this stage for one result would be doing the
      // reranker's job with the first stage's information.
      await expect(
        hybrid.search({ lexicalText: 'anything', semanticText: 'anything', limit: 1 }),
      ).rejects.toBeInstanceOf(InvalidHybridSearchError);
    });
  });

  describe('running both channels', () => {
    it('fuses what each channel found, keeping single-channel candidates', async () => {
      const owner = await makeActor();
      const marker = `hybridmarker${randomUUID().slice(0, 8)}`;

      // Lexical-only, and the way it gets there matters. Pointing the vector
      // away is not enough: the semantic channel has no distance threshold on
      // purpose, so a compatible artifact is always in its window however far
      // it is. Genuine absence comes from being in another vector space —
      // which is also the realistic case, a model rollout in progress.
      const lexicalOnly = await seed(owner, {
        summary: `a summary about ${marker}`,
        keywords: [marker],
        embedding: [0, 1, 0],
        model: 'superseded-embedding-model',
      });
      // Vector-only: the word is absent, the vector points at the query.
      const vectorOnly = await seed(owner, {
        summary: 'a summary about something else entirely',
        keywords: ['unrelated'],
        embedding: [1, 0, 0],
      });
      // Both.
      const both = await seed(owner, {
        summary: `another summary about ${marker}`,
        keywords: [marker],
        embedding: [1, 0, 0],
      });

      const result = await hybridFor(
        owner,
        provider(() => [1, 0, 0]),
      ).search({
        lexicalText: marker,
        semanticText: 'anything at all',
      });

      expect(result.semanticStatus).toBe('USED');
      const ids = result.candidates.map((candidate) => candidate.problemId);
      expect(ids).toContain(lexicalOnly.problemId);
      expect(ids).toContain(vectorOnly.problemId);
      expect(ids).toContain(both.problemId);
      // Found by both, so it leads.
      expect(ids[0]).toBe(both.problemId);

      const byId = new Map(result.candidates.map((c) => [c.problemId, c]));
      expect(byId.get(lexicalOnly.problemId)?.vectorRank).toBeNull();
      expect(byId.get(vectorOnly.problemId)?.lexicalRank).toBeNull();
      expect(byId.get(both.problemId)?.lexicalRank).not.toBeNull();
      expect(byId.get(both.problemId)?.vectorRank).not.toBeNull();
    });

    it('finds nothing without calling that a failure', async () => {
      const owner = await makeActor();

      const result = await hybridFor(owner, provider()).search({
        lexicalText: 'nothingmatchesthis',
        semanticText: 'nothing matches this either',
      });

      // Both channels ran and neither matched. That is an answer, and a
      // different one from a channel being unavailable.
      expect(result.candidates).toEqual([]);
      expect(result.semanticStatus).toBe('USED');
    });

    it('keeps an artifact from a superseded embedding model, on the lexical side', async () => {
      const owner = await makeActor();
      const marker = `oldmodelmarker${randomUUID().slice(0, 8)}`;
      const old = await seed(owner, {
        summary: `a summary about ${marker}`,
        keywords: [marker],
        embedding: [1, 0, 0],
        model: 'superseded-embedding-model',
      });

      const result = await hybridFor(owner, provider()).search({
        lexicalText: marker,
        semanticText: 'anything',
      });

      // Invisible to the vector channel because its vector lives in another
      // space — which is a fact about the model rollout, not about the Memory.
      const candidate = result.candidates.find((c) => c.problemId === old.problemId);
      expect(candidate).toBeDefined();
      expect(candidate?.vectorRank).toBeNull();
      expect(candidate?.lexicalRank).toBe(1);
    });

    it('applies one set of filters to both channels', async () => {
      const owner = await makeActor();
      const marker = `filtermarker${randomUUID().slice(0, 8)}`;
      const inA = await seed(owner, {
        summary: `a summary about ${marker}`,
        keywords: [marker],
        embedding: [1, 0, 0],
      });
      const inB = await seed(owner, {
        summary: `another summary about ${marker}`,
        keywords: [marker],
        embedding: [1, 0, 0],
      });
      const hybrid = hybridFor(owner, provider());

      const all = await hybrid.search({ lexicalText: marker, semanticText: 'anything' });
      expect(all.candidates.map((c) => c.problemId).sort()).toEqual(
        [inA.problemId, inB.problemId].sort(),
      );

      const narrowed = await hybrid.search({
        lexicalText: marker,
        semanticText: 'anything',
        projectId: inA.projectId,
      });
      expect(narrowed.candidates.map((c) => c.problemId)).toEqual([inA.problemId]);

      const excluded = await hybrid.search({
        lexicalText: marker,
        semanticText: 'anything',
        excludeProblemId: inA.problemId,
      });
      expect(excluded.candidates.map((c) => c.problemId)).toEqual([inB.problemId]);
    });

    it('never returns another owner’s Memory', async () => {
      const owner = await makeActor();
      const other = await makeActor();
      const marker = `ownermarker${randomUUID().slice(0, 8)}`;
      const mine = await seed(owner, {
        summary: `a summary about ${marker}`,
        keywords: [marker],
        embedding: [1, 0, 0],
      });
      await seed(other, {
        summary: `their summary about ${marker}`,
        keywords: [marker],
        embedding: [1, 0, 0],
      });

      const result = await hybridFor(owner, provider()).search({
        lexicalText: marker,
        semanticText: 'anything',
      });
      expect(result.candidates.map((c) => c.problemId)).toEqual([mine.problemId]);
    });

    it('writes nothing at all', async () => {
      const owner = await makeActor();
      await seed(owner, { summary: 'a summary', keywords: ['summary'], embedding: [1, 0, 0] });
      const before = await everythingStored(owner.ownerId);

      await hybridFor(owner, provider()).search({
        lexicalText: 'summary',
        semanticText: 'a description of the problem',
      });

      // Every table byte for byte. The queries and the fused result are
      // nowhere in the database.
      expect(await everythingStored(owner.ownerId)).toBe(before);
    });
  });

  describe('when the semantic half cannot run', () => {
    it('skips a credential-bearing semantic query and still answers lexically', async () => {
      const owner = await makeActor();
      const marker = `sensitivemarker${randomUUID().slice(0, 8)}`;
      const seeded = await seed(owner, {
        summary: `a summary about ${marker}`,
        keywords: [marker],
        embedding: [1, 0, 0],
      });
      const embedding = provider();

      const result = await hybridFor(owner, embedding).search({
        lexicalText: marker,
        semanticText: `find the incident about ${SECRET_QUERY}`,
      });

      expect(result.semanticStatus).toBe('SKIPPED_SENSITIVE_QUERY');
      // The credential never left the process, and the search still worked.
      expect(embedding.calls).toBe(0);
      expect(result.candidates.map((c) => c.problemId)).toEqual([seeded.problemId]);
      expect(result.candidates[0]?.vectorRank).toBeNull();
      expect(JSON.stringify(result).includes('Pp6Bj1U'), 'the result carried the credential').toBe(
        false,
      );
    });

    /** A semantic port that fails one way, on demand. */
    function portFailing(error: Error): EmbeddingProvider {
      return {
        modelId: MODEL.id,
        modelVersion: MODEL.version,
        dimensions: MODEL.dimensions,
        embed: () => Promise.reject(error),
      };
    }

    it('degrades only for a failure that says the provider could not answer', async () => {
      const owner = await makeActor();
      const marker = `classifiedmarker${randomUUID().slice(0, 8)}`;
      const seeded = await seed(owner, {
        summary: `a summary about ${marker}`,
        keywords: [marker],
        embedding: [1, 0, 0],
      });

      const result = await createRetrievalHybridSearchService(
        owner.lexical,
        createRetrievalVectorSearchService(
          portFailing(new RetrievalProviderCallError('UNAVAILABLE')),
          createRetrievalVectorSearchReader(pool, owner.context),
        ),
      ).search({ lexicalText: marker, semanticText: 'anything' });

      // A rate limit, a server error, a timeout: the provider was temporarily
      // unable to answer and the lexical half is the right answer to give.
      expect(result.semanticStatus).toBe('PROVIDER_UNAVAILABLE');
      expect(result.candidates.map((c) => c.problemId)).toEqual([seeded.problemId]);
    });

    it.each([['INVALID_RESPONSE'], ['UPSTREAM_REJECTED_REQUEST']] as const)(
      'refuses to call %s a degraded channel',
      async (failure) => {
        const owner = await makeActor();
        const marker = `integrationmarker${randomUUID().slice(0, 8)}`;
        await seed(owner, {
          summary: `a summary about ${marker}`,
          keywords: [marker],
          embedding: [1, 0, 0],
        });

        const search = createRetrievalHybridSearchService(
          owner.lexical,
          createRetrievalVectorSearchService(
            portFailing(new RetrievalProviderCallError(failure)),
            createRetrievalVectorSearchReader(pool, owner.context),
          ),
        ).search({ lexicalText: marker, semanticText: 'anything' });

        // The integration is broken, and no amount of waiting fixes it.
        // Reporting it as `PROVIDER_UNAVAILABLE` would make it look exactly
        // like a deployment that configured no provider on purpose — which is
        // how it could stay broken for as long as nobody read a log.
        await expect(search).rejects.toBeInstanceOf(RetrievalProviderCallError);
        await expect(search).rejects.toMatchObject({ failure });
      },
    );

    it('still degrades for a port that throws without saying anything', async () => {
      const owner = await makeActor();
      const marker = `genericmarker${randomUUID().slice(0, 8)}`;
      const seeded = await seed(owner, {
        summary: `a summary about ${marker}`,
        keywords: [marker],
        embedding: [1, 0, 0],
      });

      const result = await createRetrievalHybridSearchService(
        owner.lexical,
        createRetrievalVectorSearchService(
          portFailing(new Error('something went wrong')),
          createRetrievalVectorSearchReader(pool, owner.context),
        ),
      ).search({ lexicalText: marker, semanticText: 'anything' });

      // The P4 contract, unbroken. A port is free to throw anything, a plain
      // throw has always meant "no vector came back", and adding a way to say
      // more did not change what saying nothing means.
      expect(result.semanticStatus).toBe('PROVIDER_UNAVAILABLE');
      expect(result.candidates.map((c) => c.problemId)).toEqual([seeded.problemId]);
    });

    it('degrades to lexical-only when the provider cannot be reached', async () => {
      const owner = await makeActor();
      const marker = `outagemarker${randomUUID().slice(0, 8)}`;
      const seeded = await seed(owner, {
        summary: `a summary about ${marker}`,
        keywords: [marker],
        embedding: [1, 0, 0],
      });
      const failing: EmbeddingProvider = {
        modelId: MODEL.id,
        modelVersion: MODEL.version,
        dimensions: MODEL.dimensions,
        embed: () => Promise.reject(new Error(`provider said: ${PROVIDER_SECRET}`)),
      };

      const result = await createRetrievalHybridSearchService(
        owner.lexical,
        createRetrievalVectorSearchService(
          failing,
          createRetrievalVectorSearchReader(pool, owner.context),
        ),
      ).search({ lexicalText: marker, semanticText: 'anything' });

      // A Memory failure must not stop ordinary work — but it must be visible
      // as a degradation rather than pass for a complete search.
      expect(result.semanticStatus).toBe('PROVIDER_UNAVAILABLE');
      expect(result.candidates.map((c) => c.problemId)).toEqual([seeded.problemId]);
      expect(JSON.stringify(result).includes('Qq7Ck2V'), 'the result quoted the provider').toBe(
        false,
      );
    });

    it('does not hide a provider that returns something malformed', async () => {
      const owner = await makeActor();
      const marker = `malformedmarker${randomUUID().slice(0, 8)}`;
      await seed(owner, {
        summary: `a summary about ${marker}`,
        keywords: [marker],
        embedding: [1, 0, 0],
      });

      // Unreachable is infrastructure; malformed is a contract violation.
      // Treating them alike would let a broken provider run indefinitely
      // behind results that look complete — and the lexical half succeeding
      // makes that especially tempting and especially wrong.
      await expect(
        hybridFor(
          owner,
          provider(() => [0, 0, 0]),
        ).search({
          lexicalText: marker,
          semanticText: 'anything',
        }),
      ).rejects.toBeInstanceOf(InvalidEmbeddingProviderOutputError);
    });

    it('does not hide a database failure in the semantic channel', async () => {
      const owner = await makeActor();
      const marker = `dbfailmarker${randomUUID().slice(0, 8)}`;
      await seed(owner, {
        summary: `a summary about ${marker}`,
        keywords: [marker],
        embedding: [1, 0, 0],
      });

      const exploding = {
        ownerId: owner.ownerId,
        search: () => Promise.reject(new Error('the vector statement failed')),
      };
      const hybrid = createRetrievalHybridSearchService(owner.lexical, exploding);

      // Only the exact provider-unavailable class degrades; a database problem
      // dressed up as a successful lexical-only search would be a lie about
      // the state of the system.
      await expect(
        hybrid.search({ lexicalText: marker, semanticText: 'anything' }),
      ).rejects.toThrow('the vector statement failed');
    });

    it('does not hide a lexical failure behind a semantic result', async () => {
      const owner = await makeActor();
      const exploding: RetrievalSearchReader = {
        ownerId: owner.ownerId,
        searchFullText: () => Promise.reject(new Error('the lexical statement failed')),
        searchFullTextWithFallback: () => Promise.reject(new Error('the lexical statement failed')),
      };

      const hybrid = createRetrievalHybridSearchService(
        exploding,
        createRetrievalVectorSearchService(
          provider(),
          createRetrievalVectorSearchReader(pool, owner.context),
        ),
      );

      // The lexical channel has no degraded form: it succeeds or the search
      // fails.
      await expect(
        hybrid.search({ lexicalText: 'anything', semanticText: 'anything' }),
      ).rejects.toThrow('the lexical statement failed');
    });

    it('reports an unavailable provider rather than swallowing it silently', async () => {
      const owner = await makeActor();
      const failing: EmbeddingProvider = {
        modelId: MODEL.id,
        modelVersion: MODEL.version,
        dimensions: MODEL.dimensions,
        embed: () => Promise.reject(new EmbeddingGenerationFailedError()),
      };

      const result = await createRetrievalHybridSearchService(
        owner.lexical,
        createRetrievalVectorSearchService(
          failing,
          createRetrievalVectorSearchReader(pool, owner.context),
        ),
      ).search({ lexicalText: 'anything', semanticText: 'anything' });

      // Empty because nothing matched lexically either — but the status keeps
      // "we could not ask" distinct from "we asked and found nothing".
      expect(result.candidates).toEqual([]);
      expect(result.semanticStatus).toBe('PROVIDER_UNAVAILABLE');
    });
  });

  describe('the source window', () => {
    it('reads each channel to a fixed depth whatever the caller asked for', async () => {
      const owner = await makeActor();
      const depths: number[] = [];
      const watchingLexical: RetrievalSearchReader = {
        ownerId: owner.lexical.ownerId,
        searchFullText: (query) => {
          depths.push(query.limit ?? -1);
          return owner.lexical.searchFullText(query);
        },
        searchFullTextWithFallback: (query) => {
          depths.push(query.limit ?? -1);
          return owner.lexical.searchFullTextWithFallback(query);
        },
      };
      const hybrid = createRetrievalHybridSearchService(
        watchingLexical,
        createRetrievalVectorSearchService(
          provider(),
          createRetrievalVectorSearchReader(pool, owner.context),
        ),
      );

      await hybrid.search({ lexicalText: 'a', semanticText: 'a', limit: MIN_HYBRID_LIMIT });
      await hybrid.search({ lexicalText: 'a', semanticText: 'a', limit: MAX_HYBRID_LIMIT });

      // Rank fusion is sensitive to the window: letting the caller's limit set
      // the depth would make the same query answer differently depending on
      // how many results somebody wanted.
      expect(depths).toEqual([20, 20]);
    });
  });
});
