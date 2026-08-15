/**
 * Semantic search against a real database.
 *
 * The properties here belong to PostgreSQL and to the statement, so no fake
 * can prove them. Three carry the most weight:
 *
 * **Compatibility is what keeps mixed spaces safe.** The store deliberately
 * holds vectors from different models and different dimensions side by side,
 * and a distance across dimensions is an error rather than a low score. The
 * tests seed incompatible rows — wrong model, wrong version, wrong dimension —
 * and prove they neither break the query nor occupy a place in the limit.
 *
 * **Cosine is the metric, and it is observable.** The canonical fixture proves
 * identical < near < orthogonal < opposite, and the magnitude fixture pins the
 * choice itself: the same direction at a hundred times the length is the same
 * distance. Swap the operator for L2 and that test fails.
 *
 * **The filters are the lexical search's, verbatim.** Owner in the statement,
 * read control in the statement, project and self-exclusion optional,
 * suppression and staleness deliberately not filters.
 *
 * Every artifact is seeded through the real P4-01 repository. Scripted
 * provider only; nothing here calls a network. Skipped without `DATABASE_URL`.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createRetrievalVectorSearchService,
  EmbeddingGenerationFailedError,
  type RetrievalVectorSearchService,
} from '../../src/app/index.js';
import { readDatabaseUrl } from '../../src/config/env.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import { generateOwnerId, type OwnerContext, type OwnerId } from '../../src/domain/owner.js';
import type { ProblemId } from '../../src/domain/problem.js';
import type { ProjectId } from '../../src/domain/project.js';
import type { EmbeddingProvider } from '../../src/domain/retrieval-embedding.js';
import { resolveOwnerContextFor } from '../../src/owner/context.js';
import {
  createMemoryRepository,
  createRetrievalArtifactRepository,
  createRetrievalVectorSearchReader,
  type MemoryRepository,
  type RetrievalArtifactRepository,
} from '../../src/repository/index.js';
import {
  createArtifactInspectionPolicy,
  createSecretDetectionPolicy,
  withSanitization,
} from '../../src/sanitization/index.js';

const databaseUrl = readDatabaseUrl();

const MODEL = { id: 'fixture-embedding-model', version: '2', dimensions: 3 } as const;

/** A provider answering a fixed vector; the tests vary it per call. */
function providerAnswering(
  vector: () => readonly number[],
  identity: { id: string; version: string; dimensions: number } = MODEL,
): EmbeddingProvider & { calls: number } {
  const provider = {
    modelId: identity.id,
    modelVersion: identity.version,
    dimensions: identity.dimensions,
    calls: 0,
    embed() {
      provider.calls += 1;
      return Promise.resolve([...vector()]);
    },
  };
  return provider;
}

interface Actor {
  readonly ownerId: OwnerId;
  readonly context: OwnerContext;
  readonly memory: MemoryRepository;
  readonly artifacts: RetrievalArtifactRepository;
}

describe.skipIf(databaseUrl === undefined)('semantic search over retrieval artifacts', () => {
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
    };
  }

  function serviceFor(
    owner: Actor,
    queryVector: readonly number[],
    identity: { id: string; version: string; dimensions: number } = MODEL,
  ): RetrievalVectorSearchService & { readonly provider: EmbeddingProvider & { calls: number } } {
    const provider = providerAnswering(() => queryVector, identity);
    const service = createRetrievalVectorSearchService(
      provider,
      createRetrievalVectorSearchReader(pool, owner.context),
    );
    return { ...service, provider };
  }

  /** A Problem with an artifact carrying the given vector and model identity. */
  async function seed(
    owner: Actor,
    embedding: readonly number[],
    options: {
      readonly model?: string;
      readonly version?: string;
      readonly projectId?: ProjectId;
      readonly tag?: string;
    } = {},
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
      title: `${options.tag ?? 'seeded'} title`,
      symptoms: 'seeded symptoms',
    });

    await owner.artifacts.upsertArtifact({
      problemId: problem.problemId,
      normalizedSummary: `a summary for ${options.tag ?? 'a seeded problem'}`,
      keywords: ['seeded'],
      structuralFeatures: { boundary: 'configuration' },
      summaryGeneratorId: 'fixture-summary-generator',
      summaryGeneratorVersion: '1',
      embedding: [...embedding],
      embeddingModel: options.model ?? MODEL.id,
      embeddingModelVersion: options.version ?? MODEL.version,
      sourceFingerprint: `retrieval-source-v1:${randomUUID().replace(/-/g, '')}`,
      generatedAt: new Date('2026-08-16T13:00:00.000Z'),
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

  const foundIds = async (
    service: RetrievalVectorSearchService,
    text: string,
    extra = {},
  ): Promise<ProblemId[]> => {
    const outcome = await service.search({ text, ...extra });
    expect(outcome.kind).toBe('CANDIDATES');
    return outcome.kind === 'CANDIDATES'
      ? outcome.candidates.map((candidate) => candidate.problemId)
      : [];
  };

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

  describe('the metric', () => {
    it('orders by direction: identical, near, orthogonal, opposite', async () => {
      const owner = await makeActor();
      const identical = await seed(owner, [1, 0, 0], { tag: 'identical' });
      const near = await seed(owner, [0.9, 0.1, 0], { tag: 'near' });
      const orthogonal = await seed(owner, [0, 1, 0], { tag: 'orthogonal' });
      const opposite = await seed(owner, [-1, 0, 0], { tag: 'opposite' });

      const service = serviceFor(owner, [1, 0, 0]);
      const outcome = await service.search({ text: 'anything at all' });

      expect(outcome.kind).toBe('CANDIDATES');
      if (outcome.kind !== 'CANDIDATES') return;
      expect(outcome.candidates.map((candidate) => candidate.problemId)).toEqual([
        identical.problemId,
        near.problemId,
        orthogonal.problemId,
        opposite.problemId,
      ]);

      // The distances themselves carry the meaning the name promises: 0 for
      // the same direction, about 1 orthogonal, about 2 opposite. Compared
      // loosely — they are floats — and never for exact equality.
      const distances = outcome.candidates.map((candidate) => candidate.cosineDistance);
      expect(distances[0]).toBeCloseTo(0, 5);
      expect(distances[2]).toBeCloseTo(1, 5);
      expect(distances[3]).toBeCloseTo(2, 5);
      // The opposite vector IS returned: no threshold hides it. Whether a
      // distance-2 candidate is useful is the ranking layers' question.
    });

    it('ignores magnitude, which is what makes it cosine', async () => {
      // The fixture that pins the operator: under L2 the long vector would be
      // distance 99 and sort far away; under cosine both are distance 0 from
      // the query and the tie breaks on the problem id. Swapping <=> for <->
      // fails this test.
      const owner = await makeActor();
      const unit = await seed(owner, [1, 0, 0], { tag: 'unit' });
      const long = await seed(owner, [100, 0, 0], { tag: 'long' });

      const service = serviceFor(owner, [1, 0, 0]);
      const outcome = await service.search({ text: 'anything' });

      expect(outcome.kind).toBe('CANDIDATES');
      if (outcome.kind !== 'CANDIDATES') return;
      const byId = new Map(
        outcome.candidates.map((candidate) => [candidate.problemId, candidate.cosineDistance]),
      );
      expect(byId.get(unit.problemId)).toBeCloseTo(0, 5);
      expect(byId.get(long.problemId)).toBeCloseTo(0, 5);
      const sorted = [unit.problemId, long.problemId].sort();
      expect(outcome.candidates.map((candidate) => candidate.problemId)).toEqual(sorted);
    });
  });

  describe('compatibility', () => {
    it('compares only artifacts from the provider’s exact space', async () => {
      const owner = await makeActor();
      const compatible = await seed(owner, [1, 0, 0], { tag: 'compatible' });
      // Wrong model, wrong version, wrong dimensions — each incompatible on
      // exactly one axis, including a six-dimensional vector under the SAME
      // model and version, which is the row that would error if it were ever
      // compared rather than filtered.
      await seed(owner, [1, 0, 0], { model: 'other-embedding-model', tag: 'wrong-model' });
      await seed(owner, [1, 0, 0], { version: '1', tag: 'wrong-version' });
      await seed(owner, [1, 0, 0, 0, 0, 0], { tag: 'wrong-dimensions' });

      const service = serviceFor(owner, [1, 0, 0]);
      expect(await foundIds(service, 'anything')).toEqual([compatible.problemId]);
    });

    it('does not let incompatible rows occupy the limit', async () => {
      const owner = await makeActor();
      // Two compatible rows, three incompatible ones. A limit of 2 must
      // return both compatible rows — excluded-by-filter, not lost-to-limit.
      const first = await seed(owner, [1, 0, 0], { tag: 'first' });
      const second = await seed(owner, [0.9, 0.1, 0], { tag: 'second' });
      await seed(owner, [1, 0, 0], { model: 'other-embedding-model' });
      await seed(owner, [1, 0, 0], { version: '9' });
      await seed(owner, [1, 0, 0, 0, 0, 0]);

      const service = serviceFor(owner, [1, 0, 0]);
      expect(await foundIds(service, 'anything', { limit: 2 })).toEqual([
        first.problemId,
        second.problemId,
      ]);
    });

    it('finds nothing — and regenerates nothing — when only another model’s artifacts exist', async () => {
      const owner = await makeActor();
      await seed(owner, [1, 0, 0], { model: 'model-A', tag: 'old-model' });
      const before = await everythingStored(owner.ownerId);

      // The provider is model B. The old-model artifact is excluded from the
      // vector space and nothing regenerates it: a search is a read, and the
      // lexical channel is where an old-model artifact can still surface.
      const service = serviceFor(owner, [1, 0, 0], {
        id: 'model-B',
        version: '1',
        dimensions: 3,
      });
      const outcome = await service.search({ text: 'anything' });

      expect(outcome.kind).toBe('CANDIDATES');
      if (outcome.kind !== 'CANDIDATES') return;
      expect(outcome.candidates).toEqual([]);
      expect(await everythingStored(owner.ownerId)).toBe(before);
    });
  });

  describe('who and what is excluded', () => {
    it('never returns another owner’s artifact', async () => {
      const owner = await makeActor();
      const other = await makeActor();
      const mine = await seed(owner, [1, 0, 0], { tag: 'mine' });
      const theirs = await seed(other, [1, 0, 0], { tag: 'theirs' });

      expect(await foundIds(serviceFor(owner, [1, 0, 0]), 'anything')).toEqual([mine.problemId]);
      expect(await foundIds(serviceFor(other, [1, 0, 0]), 'anything')).toEqual([theirs.problemId]);
    });

    it('excludes a read-disabled Problem while its artifact stays', async () => {
      const owner = await makeActor();
      const seeded = await seed(owner, [1, 0, 0], { tag: 'read-off' });
      const service = serviceFor(owner, [1, 0, 0]);
      expect(await foundIds(service, 'anything')).toContain(seeded.problemId);

      const problem = await owner.memory.getProblem(seeded.problemId);
      await owner.memory.updateProblem(seeded.problemId, problem?.version ?? 0, {
        memoryReadEnabled: false,
      });

      expect(await foundIds(service, 'anything')).not.toContain(seeded.problemId);
      // The row is still there: turning off automatic reading is not a delete.
      expect(await owner.artifacts.getArtifact(seeded.problemId)).toBeDefined();
    });

    it('narrows to a Project when asked and answers nothing for someone else’s', async () => {
      const owner = await makeActor();
      const other = await makeActor();
      const inA = await seed(owner, [1, 0, 0], { tag: 'in-a' });
      const inB = await seed(owner, [0.9, 0.1, 0], { tag: 'in-b' });
      const theirs = await seed(other, [1, 0, 0], { tag: 'theirs' });
      const service = serviceFor(owner, [1, 0, 0]);

      expect((await foundIds(service, 'anything')).sort()).toEqual(
        [inA.problemId, inB.problemId].sort(),
      );
      expect(await foundIds(service, 'anything', { projectId: inA.projectId })).toEqual([
        inA.problemId,
      ]);
      // Somebody else's Project and a Project that does not exist are the same
      // empty answer.
      expect(await foundIds(service, 'anything', { projectId: theirs.projectId })).toEqual([]);
      expect(await foundIds(service, 'anything', { projectId: randomUUID() as ProjectId })).toEqual(
        [],
      );
    });

    it('leaves out the Problem being worked on, only when asked', async () => {
      // The case self-exclusion exists for: the current Problem's own artifact
      // is at distance zero from itself and takes the top place.
      const owner = await makeActor();
      const current = await seed(owner, [1, 0, 0], { tag: 'current' });
      const neighbour = await seed(owner, [0.9, 0.1, 0], { tag: 'neighbour' });
      const service = serviceFor(owner, [1, 0, 0]);

      expect(await foundIds(service, 'anything')).toEqual([current.problemId, neighbour.problemId]);
      expect(await foundIds(service, 'anything', { excludeProblemId: current.problemId })).toEqual([
        neighbour.problemId,
      ]);
    });

    it('still returns a suppressed, invalid, low-confidence Memory', async () => {
      const owner = await makeActor();
      const seeded = await seed(owner, [1, 0, 0], { tag: 'judged' });
      const problem = await owner.memory.getProblem(seeded.problemId);
      await owner.memory.updateProblem(seeded.problemId, problem?.version ?? 0, {
        suppressed: true,
        freshness: 'INVALID',
        confidence: 'LOW',
        importance: false,
      });

      // Findable and recommended are different questions, here exactly as in
      // the lexical search. Ranking judgements belong to the layers that rank.
      expect(await foundIds(serviceFor(owner, [1, 0, 0]), 'anything')).toContain(seeded.problemId);
    });
  });

  describe('the shape of an answer', () => {
    it('carries the Problem, its Project and a raw distance, and nothing else', async () => {
      const owner = await makeActor();
      const seeded = await seed(owner, [1, 0, 0], { tag: 'shape' });

      const outcome = await serviceFor(owner, [1, 0, 0]).search({ text: 'anything' });
      expect(outcome.kind).toBe('CANDIDATES');
      if (outcome.kind !== 'CANDIDATES') return;

      const candidate = outcome.candidates.find((entry) => entry.problemId === seeded.problemId);
      expect(candidate?.projectId).toBe(seeded.projectId);
      expect(Object.keys(candidate ?? {}).sort()).toEqual([
        'cosineDistance',
        'problemId',
        'projectId',
      ]);
      expect(Number.isFinite(candidate?.cosineDistance)).toBe(true);
    });

    it('orders equal distances the same way every time, and truncates in that order', async () => {
      const owner = await makeActor();
      const seeded: ProblemId[] = [];
      for (let index = 0; index < 5; index += 1) {
        seeded.push((await seed(owner, [1, 0, 0], { tag: `tie-${String(index)}` })).problemId);
      }

      const service = serviceFor(owner, [1, 0, 0]);
      const all = await foundIds(service, 'anything');
      expect(all).toEqual([...all].sort());
      expect(await foundIds(service, 'anything')).toEqual(all);

      const limited = await foundIds(service, 'anything', { limit: 3 });
      expect(limited).toEqual(all.slice(0, 3));
    });
  });

  describe('what never reaches anywhere', () => {
    it('a search writes nothing at all', async () => {
      const owner = await makeActor();
      await seed(owner, [1, 0, 0], { tag: 'untouched' });
      const before = await everythingStored(owner.ownerId);

      const outcome = await serviceFor(owner, [1, 0, 0]).search({ text: 'anything' });
      expect(outcome.kind).toBe('CANDIDATES');

      // Every Memory table, the artifacts included, byte for byte. The query
      // and its vector are nowhere in the database.
      expect(await everythingStored(owner.ownerId)).toBe(before);
    });

    it('a provider failure is reported without quoting what it threw', async () => {
      const owner = await makeActor();
      await seed(owner, [1, 0, 0]);
      const failing: EmbeddingProvider = {
        modelId: MODEL.id,
        modelVersion: MODEL.version,
        dimensions: MODEL.dimensions,
        embed: () => Promise.reject(new Error('provider said: Bearer fake-Oo5Ah0T-0123456789')),
      };
      const service = createRetrievalVectorSearchService(
        failing,
        createRetrievalVectorSearchReader(pool, owner.context),
      );

      let raised: unknown;
      try {
        await service.search({ text: 'an ordinary query' });
      } catch (error) {
        raised = error;
      }

      expect(raised).toBeInstanceOf(EmbeddingGenerationFailedError);
      const message = (raised as Error).message;
      expect(message.includes('Oo5Ah0T'), 'the failure quoted the provider').toBe(false);
      expect(message.includes('ordinary query'), 'the failure quoted the query').toBe(false);
      expect((raised as { cause?: unknown }).cause).toBeUndefined();
    });

    it('invalid provider output stops before the database', async () => {
      const owner = await makeActor();
      await seed(owner, [1, 0, 0]);
      let readerCalls = 0;
      const realReader = createRetrievalVectorSearchReader(pool, owner.context);
      const countingReader = {
        ownerId: realReader.ownerId,
        searchByVector: (...args: Parameters<typeof realReader.searchByVector>) => {
          readerCalls += 1;
          return realReader.searchByVector(...args);
        },
      };

      const service = createRetrievalVectorSearchService(
        providerAnswering(() => [0, 0, 0]),
        countingReader,
      );

      // Representative case only — the full validation matrix is the unit
      // tests' and P4-04's. What this adds is the count: nothing invalid is
      // driven into a statement.
      await expect(service.search({ text: 'anything' })).rejects.toThrow();
      expect(readerCalls).toBe(0);
    });
  });

  describe('the schema this task did not touch', () => {
    it('added no migration and no vector index', async () => {
      const migrations = await pool.query<{ count: string }>(
        'select count(*)::text as count from supabase_migrations.schema_migrations',
      );
      // Exactly the sixteen P4-04 left. A seventeenth here would mean vector
      // search grew storage, which it must not: it is a read over what exists.
      expect(Number(migrations.rows[0]?.count)).toBe(16);

      const annIndexes = await pool.query<{ count: string }>(
        `select count(*)::text as count from pg_indexes
          where schemaname = 'public'
            and (indexdef like '%hnsw%' or indexdef like '%ivfflat%')`,
      );
      // Exact scan, deliberately: the column is untyped because no model is
      // chosen, and an ANN index needs a dimension. The partial cast-index
      // path was measured and stays available to the task that configures a
      // concrete provider.
      expect(Number(annIndexes.rows[0]?.count)).toBe(0);
    });
  });
});
