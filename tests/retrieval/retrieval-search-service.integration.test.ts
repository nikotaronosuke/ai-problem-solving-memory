/**
 * The whole retrieval path as one call, against a real database.
 *
 * The cache's own behaviour is pinned by the unit tests. What is proven here
 * is what the composition promises:
 *
 * **That reuse skips the expensive work and nothing else.** A hit calls no
 * embedding provider and no reranker, and still runs the ranking stage —
 * which is what makes suppressing a Memory, lowering its confidence, marking
 * it invalid, relabelling its Project, switching its reading off or deleting
 * it take effect on the very next search.
 *
 * **That "the same search" means the same understanding.** Appending an Event
 * or a Verification, or editing what the Problem says, misses. Marking it
 * important does not, because that is not part of what the Problem is
 * understood to be.
 *
 * **That the Problem being worked on governs the search.** Its Project is read
 * from its own row rather than named by a caller, it excludes itself, and its
 * own read control is respected before anything else happens.
 *
 * **That a Problem changing mid-search is noticed.** The two long calls leave
 * a window, and an answer to a question that has moved is reported rather than
 * returned or cached.
 *
 * Every credential fixture is synthetic. Skipped without `DATABASE_URL`.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createRetrievalHybridSearchService,
  createRetrievalRankingService,
  createRetrievalSearchCache,
  createRetrievalSearchService,
  createRetrievalStructuralRerankService,
  createRetrievalVectorSearchService,
  InvalidRetrievalSearchError,
  type RetrievalSearchCache,
  type RetrievalSearchOutcome,
  type RetrievalSearchService,
} from '../../src/app/index.js';
import { readDatabaseUrl } from '../../src/config/env.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import type { ClientEventId } from '../../src/domain/client-event-id.js';
import { generateOwnerId, type OwnerContext, type OwnerId } from '../../src/domain/owner.js';
import type { ProblemId } from '../../src/domain/problem.js';
import type { ProjectId } from '../../src/domain/project.js';
import type { EmbeddingProvider } from '../../src/domain/retrieval-embedding.js';
import { EmbeddingGenerationFailedError } from '../../src/domain/retrieval-embedding.js';
import type {
  StructuralReranker,
  StructuralRerankerInput,
} from '../../src/domain/retrieval-structural-rerank.js';
import {
  parseStructuralFeatures,
  type StructuralFeatures,
} from '../../src/domain/retrieval-summary.js';
import { resolveOwnerContextFor } from '../../src/owner/context.js';
import {
  createMemoryRepository,
  createRetrievalArtifactRepository,
  createRetrievalRankingReader,
  createRetrievalSearchReader,
  createRetrievalStructuralReader,
  createRetrievalSummarySourceReader,
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
const SECRET_QUERY = 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI-fake-Yy6Rs2T0123456789abc';

/** An embedding provider that counts, and can be told to fail. */
function provider(respond: () => unknown = () => [1, 0, 0]): EmbeddingProvider & { calls: number } {
  const state = {
    modelId: MODEL.id,
    modelVersion: MODEL.version,
    dimensions: MODEL.dimensions,
    calls: 0,
    embed(): Promise<unknown> {
      state.calls += 1;
      return Promise.resolve(respond());
    },
  };
  return state;
}

/** A reranker that counts, scoring in the order it was handed candidates. */
function reranker(
  respond: (input: StructuralRerankerInput) => unknown = (input) => ({
    candidates: input.candidates.map((candidate, index) => ({
      problemId: candidate.problemId,
      structuralScore: Math.max(0.1, 1 - index / 10),
      matchedDimensions: ['symptom_patterns'],
    })),
  }),
): StructuralReranker & { calls: number; seen: StructuralRerankerInput[] } {
  const state = {
    calls: 0,
    seen: [] as StructuralRerankerInput[],
    rerank(input: StructuralRerankerInput): Promise<unknown> {
      state.calls += 1;
      state.seen.push(input);
      return Promise.resolve(respond(input));
    },
  };
  return state;
}

const features = (overrides: Record<string, unknown> = {}): StructuralFeatures =>
  parseStructuralFeatures({
    schema_version: '1',
    problem_domain: 'deployment',
    symptom_patterns: ['works locally, fails once deployed'],
    suspected_boundaries: ['configuration read at build time'],
    occurrence_conditions: ['only in the deployed environment'],
    successful_directions: [],
    dead_end_directions: ['raising the timeout'],
    environment_facts: ['node 22.12.0'],
    ...overrides,
  });

interface Actor {
  readonly ownerId: OwnerId;
  readonly context: OwnerContext;
  readonly memory: MemoryRepository;
  readonly artifacts: RetrievalArtifactRepository;
}

describe.skipIf(databaseUrl === undefined)('retrieval search', () => {
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
    cache: RetrievalSearchCache,
    embedding: EmbeddingProvider,
    rerankerPort: StructuralReranker,
  ): RetrievalSearchService {
    return createRetrievalSearchService(
      createRetrievalSummarySourceReader(pool, owner.context),
      createRetrievalHybridSearchService(
        createRetrievalSearchReader(pool, owner.context),
        createRetrievalVectorSearchService(
          embedding,
          createRetrievalVectorSearchReader(pool, owner.context),
        ),
      ),
      createRetrievalStructuralRerankService(
        createRetrievalStructuralReader(pool, owner.context),
        rerankerPort,
      ),
      createRetrievalRankingService(createRetrievalRankingReader(pool, owner.context)),
      cache,
    );
  }

  /** A Problem, and optionally an artifact making it findable. */
  async function seed(
    owner: Actor,
    options: {
      readonly projectId?: ProjectId;
      readonly platform?: string | null;
      readonly marker?: string;
      readonly withArtifact?: boolean;
    } = {},
  ): Promise<{ problemId: ProblemId; projectId: ProjectId }> {
    const projectId =
      options.projectId ??
      (
        await owner.memory.createProject({
          projectName: `project ${randomUUID()}`,
          platform: options.platform ?? 'fixture-platform',
        })
      ).projectId;
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

    if (options.withArtifact !== false) {
      await owner.artifacts.upsertArtifact({
        problemId: problem.problemId,
        normalizedSummary: `a summary about ${options.marker ?? 'deployment'}`,
        keywords: [options.marker ?? 'deployment'],
        structuralFeatures: {
          schema_version: '1',
          problem_domain: 'deployment',
          symptom_patterns: ['fails once deployed'],
          suspected_boundaries: ['configuration'],
          occurrence_conditions: ['deployed only'],
          successful_directions: [],
          dead_end_directions: ['timeout'],
          environment_facts: ['node 22.12.0'],
        },
        summaryGeneratorId: 'fixture-summary-generator',
        summaryGeneratorVersion: '1',
        embedding: [1, 0, 0],
        embeddingModel: MODEL.id,
        embeddingModelVersion: MODEL.version,
        sourceFingerprint: `retrieval-source-v1:${randomUUID().replace(/-/g, '')}`,
        generatedAt: new Date('2026-08-16T14:00:00.000Z'),
      });
    }

    return { problemId: problem.problemId, projectId };
  }

  /**
   * A Problem to search from, with two findable neighbours.
   *
   * Two rather than one on purpose: the rerank stage does not call its model
   * for a single candidate — there is no ordering to buy — so a fixture with
   * one neighbour would report zero reranker calls whether the cache worked or
   * not.
   */
  async function seedSearchable(owner: Actor): Promise<{
    current: { problemId: ProblemId; projectId: ProjectId };
    candidate: { problemId: ProblemId; projectId: ProjectId };
    other: { problemId: ProblemId; projectId: ProjectId };
  }> {
    const current = await seed(owner);
    const candidate = await seed(owner, { projectId: current.projectId });
    const other = await seed(owner, { projectId: current.projectId });
    return { current, candidate, other };
  }

  const searchFor = async (
    service: RetrievalSearchService,
    currentProblemId: ProblemId,
    overrides: Record<string, unknown> = {},
  ): Promise<RetrievalSearchOutcome> =>
    service.search({
      currentProblemId,
      lexicalText: 'deployment',
      semanticText: 'the app works locally but fails once deployed',
      currentFeatures: features(),
      ...overrides,
    });

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

  describe('composition', () => {
    it('reports the owner every stage shares', async () => {
      const owner = await makeActor();
      const service = serviceFor(owner, createRetrievalSearchCache(), provider(), reranker());
      expect(service.ownerId).toBe(owner.ownerId);
    });

    it('refuses to build stages belonging to different owners', async () => {
      const owner = await makeActor();
      const stranger = await makeActor();

      // Every stage is owner-safe alone and none can see the others, so only
      // the pairing can be wrong — and a wrongly built service must not exist.
      expect(() =>
        createRetrievalSearchService(
          createRetrievalSummarySourceReader(pool, owner.context),
          createRetrievalHybridSearchService(
            createRetrievalSearchReader(pool, stranger.context),
            createRetrievalVectorSearchService(
              provider(),
              createRetrievalVectorSearchReader(pool, stranger.context),
            ),
          ),
          createRetrievalStructuralRerankService(
            createRetrievalStructuralReader(pool, stranger.context),
            reranker(),
          ),
          createRetrievalRankingService(createRetrievalRankingReader(pool, stranger.context)),
          createRetrievalSearchCache(),
        ),
      ).toThrow();
    });

    it('names no owner when it refuses', async () => {
      const owner = await makeActor();
      const stranger = await makeActor();
      let raised: unknown;
      try {
        createRetrievalSearchService(
          createRetrievalSummarySourceReader(pool, owner.context),
          createRetrievalHybridSearchService(
            createRetrievalSearchReader(pool, stranger.context),
            createRetrievalVectorSearchService(
              provider(),
              createRetrievalVectorSearchReader(pool, stranger.context),
            ),
          ),
          createRetrievalStructuralRerankService(
            createRetrievalStructuralReader(pool, stranger.context),
            reranker(),
          ),
          createRetrievalRankingService(createRetrievalRankingReader(pool, stranger.context)),
          createRetrievalSearchCache(),
        );
      } catch (error) {
        raised = error;
      }
      const message = (raised as Error).message;
      expect(message.includes(owner.ownerId), 'the refusal named an owner').toBe(false);
      expect(message.includes(stranger.ownerId), 'the refusal named an owner').toBe(false);
    });
  });

  describe('the Problem being worked on', () => {
    it('answers the same way for one that never existed and one that is not this owner’s', async () => {
      const owner = await makeActor();
      const stranger = await makeActor();
      const theirs = await seed(stranger);
      const embedding = provider();
      const port = reranker();
      const service = serviceFor(owner, createRetrievalSearchCache(), embedding, port);

      const foreign = await searchFor(service, theirs.problemId);
      const invented = await searchFor(service, randomUUID() as ProblemId);

      expect(foreign).toEqual({ kind: 'CURRENT_PROBLEM_NOT_AVAILABLE' });
      expect(JSON.stringify(foreign)).toBe(JSON.stringify(invented));
      // And neither cost anything: no provider call, no model call.
      expect(embedding.calls).toBe(0);
      expect(port.calls).toBe(0);
    });

    it('stops when its owner has turned automatic reading off', async () => {
      const owner = await makeActor();
      const current = await seed(owner, { withArtifact: false });
      await seed(owner, { projectId: current.projectId });
      const embedding = provider();
      const port = reranker();
      const service = serviceFor(owner, createRetrievalSearchCache(), embedding, port);

      const problem = await owner.memory.getProblem(current.problemId);
      await owner.memory.updateProblem(current.problemId, problem?.version ?? 0, {
        memoryReadEnabled: false,
      });

      // Their setting on their own Problem. Not an error, and nothing runs.
      expect(await searchFor(service, current.problemId)).toEqual({ kind: 'MEMORY_READ_DISABLED' });
      expect(embedding.calls).toBe(0);
      expect(port.calls).toBe(0);
    });

    it('excludes itself from its own search', async () => {
      const owner = await makeActor();
      const current = await seed(owner, { marker: 'deployment' });
      const other = await seed(owner, { projectId: current.projectId, marker: 'deployment' });
      const port = reranker();
      const service = serviceFor(owner, createRetrievalSearchCache(), provider(), port);

      const outcome = await searchFor(service, current.problemId);

      // A Problem is not a memory of itself, and there is no caller field that
      // could say otherwise.
      expect(outcome.kind).toBe('SEARCHED');
      const seen = port.seen[0]?.candidates.map((candidate) => candidate.problemId) ?? [];
      expect(seen).not.toContain(current.problemId);
      if (outcome.kind === 'SEARCHED') {
        expect(outcome.candidates.map((candidate) => candidate.problemId)).not.toContain(
          current.problemId,
        );
        expect(outcome.candidates.map((candidate) => candidate.problemId)).toContain(
          other.problemId,
        );
      }
    });

    it('takes the current Project from the Problem’s own row', async () => {
      const owner = await makeActor();
      const current = await seed(owner, { platform: 'react' });
      const sameProject = await seed(owner, { projectId: current.projectId });
      const service = serviceFor(owner, createRetrievalSearchCache(), provider(), reranker());

      const outcome = await searchFor(service, current.problemId);

      // No caller field named the Project, so a search cannot be asked about
      // one Problem and a different Project's neighbourhood.
      expect(outcome.kind).toBe('SEARCHED');
      if (outcome.kind === 'SEARCHED') {
        const found = outcome.candidates.find(
          (candidate) => candidate.problemId === sameProject.problemId,
        );
        expect(found?.projectRelation).toBe('CURRENT_PROJECT');
      }
    });

    it('refuses a Problem identifier that is not one, before anything runs', async () => {
      const owner = await makeActor();
      const embedding = provider();
      const service = serviceFor(owner, createRetrievalSearchCache(), embedding, reranker());

      await expect(searchFor(service, 'the current one' as ProblemId)).rejects.toBeInstanceOf(
        InvalidRetrievalSearchError,
      );
      expect(embedding.calls).toBe(0);
    });
  });

  describe('reusing a search', () => {
    it('runs neither the provider nor the reranker the second time', async () => {
      const owner = await makeActor();
      const { current } = await seedSearchable(owner);
      const embedding = provider();
      const port = reranker();
      const service = serviceFor(owner, createRetrievalSearchCache(), embedding, port);

      const first = await searchFor(service, current.problemId);
      expect(embedding.calls).toBe(1);
      expect(port.calls).toBe(1);

      const second = await searchFor(service, current.problemId);

      // The two expensive calls, both skipped.
      expect(embedding.calls).toBe(1);
      expect(port.calls).toBe(1);
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    });

    it('keeps two owners apart in one shared cache', async () => {
      const cache = createRetrievalSearchCache();
      const one = await makeActor();
      const other = await makeActor();
      const mine = await seedSearchable(one);
      const theirs = await seedSearchable(other);

      const myPort = reranker();
      const theirPort = reranker();
      await searchFor(serviceFor(one, cache, provider(), myPort), mine.current.problemId);
      await searchFor(serviceFor(other, cache, provider(), theirPort), theirs.current.problemId);

      // One process, one cache, two owners — and no reuse between them.
      expect(myPort.calls).toBe(1);
      expect(theirPort.calls).toBe(1);
    });

    const missCases: [string, Record<string, unknown>][] = [
      ['the lexical text differs', { lexicalText: 'configuration' }],
      ['the semantic text differs', { semanticText: 'something else entirely' }],
      [
        'the structural profile differs',
        { currentFeatures: features({ problem_domain: 'build' }) },
      ],
      ['the candidate window differs', { hybridLimit: 10 }],
      ['the final cut differs', { rerankLimit: 3 }],
    ];

    it.each(missCases)('runs again when %s', async (_label, overrides) => {
      const owner = await makeActor();
      const { current } = await seedSearchable(owner);
      const port = reranker();
      const service = serviceFor(owner, createRetrievalSearchCache(), provider(), port);

      await searchFor(service, current.problemId);
      await searchFor(service, current.problemId, overrides);

      expect(port.calls).toBe(2);
    });

    it('treats an unstated limit and the same limit stated as one search', async () => {
      const owner = await makeActor();
      const { current } = await seedSearchable(owner);
      const port = reranker();
      const service = serviceFor(owner, createRetrievalSearchCache(), provider(), port);

      await searchFor(service, current.problemId);
      await searchFor(service, current.problemId, { hybridLimit: 20, rerankLimit: 5 });

      // Not asking and asking for the default are the same request, so they
      // must not be two entries.
      expect(port.calls).toBe(1);
    });

    it('runs again for a different Problem', async () => {
      const owner = await makeActor();
      const { current, candidate } = await seedSearchable(owner);
      await seed(owner, { projectId: current.projectId });
      const port = reranker();
      const service = serviceFor(owner, createRetrievalSearchCache(), provider(), port);

      await searchFor(service, current.problemId);
      await searchFor(service, candidate.problemId);

      expect(port.calls).toBe(2);
    });
  });

  describe('when the Problem is understood differently', () => {
    async function reusableSearch(): Promise<{
      owner: Actor;
      current: { problemId: ProblemId; projectId: ProjectId };
      port: StructuralReranker & { calls: number };
      service: RetrievalSearchService;
    }> {
      const owner = await makeActor();
      const { current } = await seedSearchable(owner);
      const port = reranker();
      const service = serviceFor(owner, createRetrievalSearchCache(), provider(), port);
      await searchFor(service, current.problemId);
      expect(port.calls).toBe(1);
      return { owner, current, port, service };
    }

    it('runs again after an Event is appended', async () => {
      const { owner, current, port, service } = await reusableSearch();

      await owner.memory.appendEvent({
        problemId: current.problemId,
        eventType: 'DISCOVERY',
        summary: 'the host is read at build time',
        clientEventId: randomUUID() as ClientEventId,
      });

      // An Event is part of what the Problem is understood to be — and the
      // Problem's `version` does not move for one, which is why the key is
      // built over the source rather than the version.
      await searchFor(service, current.problemId);
      expect(port.calls).toBe(2);
    });

    it('runs again after a Verification is appended', async () => {
      const { owner, current, port, service } = await reusableSearch();

      await owner.memory.appendVerification({
        problemId: current.problemId,
        verificationType: 'TEST',
        result: false,
        summary: 'the deployed build still fails',
        clientEventId: randomUUID() as ClientEventId,
      });

      await searchFor(service, current.problemId);
      expect(port.calls).toBe(2);
    });

    it('runs again after what the Problem says changes', async () => {
      const { owner, current, port, service } = await reusableSearch();

      const problem = await owner.memory.getProblem(current.problemId);
      await owner.memory.updateProblem(current.problemId, problem?.version ?? 0, {
        symptoms: 'a different description of what goes wrong',
      });

      await searchFor(service, current.problemId);
      expect(port.calls).toBe(2);
    });

    it('reuses the search when only a control changes', async () => {
      const { owner, current, port, service } = await reusableSearch();

      const problem = await owner.memory.getProblem(current.problemId);
      await owner.memory.updateProblem(current.problemId, problem?.version ?? 0, {
        importance: true,
      });

      // Marking a Problem important says nothing about what it is; the
      // separation between understanding and controls is the whole reason the
      // generation source excludes them.
      await searchFor(service, current.problemId);
      expect(port.calls).toBe(1);
    });
  });

  describe('a reused search still respects every control', () => {
    async function cachedSearch(): Promise<{
      owner: Actor;
      current: { problemId: ProblemId; projectId: ProjectId };
      candidate: { problemId: ProblemId; projectId: ProjectId };
      embedding: EmbeddingProvider & { calls: number };
      port: StructuralReranker & { calls: number };
      service: RetrievalSearchService;
    }> {
      const owner = await makeActor();
      const { current, candidate } = await seedSearchable(owner);
      const embedding = provider();
      const port = reranker();
      const service = serviceFor(owner, createRetrievalSearchCache(), embedding, port);

      const first = await searchFor(service, current.problemId);
      expect(first.kind).toBe('SEARCHED');
      if (first.kind === 'SEARCHED') {
        expect(first.candidates.map((entry) => entry.problemId)).toContain(candidate.problemId);
      }
      return { owner, current, candidate, embedding, port, service };
    }

    it('reflects a Memory that has since been suppressed', async () => {
      const { owner, current, candidate, embedding, port, service } = await cachedSearch();

      const problem = await owner.memory.getProblem(candidate.problemId);
      await owner.memory.updateProblem(candidate.problemId, problem?.version ?? 0, {
        suppressed: true,
      });

      const outcome = await searchFor(service, current.problemId);

      // Nothing expensive re-ran, and the change still took effect: the
      // ranking stage never sees the cache.
      expect(embedding.calls).toBe(1);
      expect(port.calls).toBe(1);
      expect(outcome.kind).toBe('SEARCHED');
      if (outcome.kind === 'SEARCHED') {
        expect(
          outcome.candidates.find((entry) => entry.problemId === candidate.problemId)?.suppressed,
        ).toBe(true);
      }
    });

    it.each([
      ['confidence', { confidence: 'CONFLICTED' as const }],
      ['freshness', { freshness: 'INVALID' as const }],
    ])('reflects a change to a Memory’s %s', async (field, change) => {
      const { owner, current, candidate, port, service } = await cachedSearch();

      const problem = await owner.memory.getProblem(candidate.problemId);
      await owner.memory.updateProblem(candidate.problemId, problem?.version ?? 0, change);

      const outcome = await searchFor(service, current.problemId);
      expect(port.calls).toBe(1);
      expect(outcome.kind).toBe('SEARCHED');
      if (outcome.kind === 'SEARCHED') {
        const found = outcome.candidates.find((entry) => entry.problemId === candidate.problemId);
        expect(found?.[field as 'confidence' | 'freshness']).toBe(Object.values(change)[0]);
      }
    });

    it('reflects a Project relabelled to another technology', async () => {
      const owner = await makeActor();
      const current = await seed(owner, { platform: 'react' });
      const elsewhere = await seed(owner, { platform: 'react' });
      await seed(owner, { projectId: current.projectId });
      const port = reranker();
      const service = serviceFor(owner, createRetrievalSearchCache(), provider(), port);

      const first = await searchFor(service, current.problemId);
      expect(first.kind).toBe('SEARCHED');
      if (first.kind === 'SEARCHED') {
        expect(
          first.candidates.find((entry) => entry.problemId === elsewhere.problemId)
            ?.projectRelation,
        ).toBe('SAME_TECH_OTHER_PROJECT');
      }

      await owner.memory.updateProject(elsewhere.projectId, { platform: 'fastify' });

      const second = await searchFor(service, current.problemId);
      expect(port.calls).toBe(1);
      if (second.kind === 'SEARCHED') {
        expect(
          second.candidates.find((entry) => entry.problemId === elsewhere.problemId)
            ?.projectRelation,
        ).toBe('OTHER_TECH');
      }
    });

    it('drops a Memory whose reading has since been switched off', async () => {
      const { owner, current, candidate, port, service } = await cachedSearch();

      const problem = await owner.memory.getProblem(candidate.problemId);
      await owner.memory.updateProblem(candidate.problemId, problem?.version ?? 0, {
        memoryReadEnabled: false,
      });

      const outcome = await searchFor(service, current.problemId);
      expect(port.calls).toBe(1);
      if (outcome.kind === 'SEARCHED') {
        expect(outcome.candidates.map((entry) => entry.problemId)).not.toContain(
          candidate.problemId,
        );
      }
    });

    it('drops a Memory that has since been deleted', async () => {
      const { owner, current, candidate, port, service } = await cachedSearch();

      const problem = await owner.memory.getProblem(candidate.problemId);
      await owner.memory.deleteProblem(candidate.problemId, problem?.version ?? 0);

      const outcome = await searchFor(service, current.problemId);

      // A cache must not bring back a Memory somebody deleted.
      expect(port.calls).toBe(1);
      if (outcome.kind === 'SEARCHED') {
        expect(outcome.candidates.map((entry) => entry.problemId)).not.toContain(
          candidate.problemId,
        );
      }
    });

    it('renumbers the final positions while keeping the earlier stage’s', async () => {
      const owner = await makeActor();
      const current = await seed(owner);
      const first = await seed(owner, { projectId: current.projectId });
      const second = await seed(owner, { projectId: current.projectId });
      const third = await seed(owner, { projectId: current.projectId });
      const port = reranker();
      const service = serviceFor(owner, createRetrievalSearchCache(), provider(), port);

      const before = await searchFor(service, current.problemId);
      expect(before.kind).toBe('SEARCHED');
      const problem = await owner.memory.getProblem(second.problemId);
      await owner.memory.deleteProblem(second.problemId, problem?.version ?? 0);

      const after = await searchFor(service, current.problemId);
      expect(port.calls).toBe(1);
      if (after.kind === 'SEARCHED') {
        expect(after.candidates.map((entry) => entry.rankingRank)).toEqual([1, 2]);
        // The hybrid positions came from the cached rerank and keep their gap.
        expect(new Set(after.candidates.map((entry) => entry.problemId))).toEqual(
          new Set([first.problemId, third.problemId]),
        );
      }
    });
  });

  describe('when the Problem changes while the search runs', () => {
    it('reports it rather than answering a question that has moved', async () => {
      const owner = await makeActor();
      const { current } = await seedSearchable(owner);

      // Appended from inside the reranker and awaited there, so the Event has
      // certainly landed by the time the second read happens. That window —
      // between the first read and the answer — is exactly what the second
      // read exists to cover, and an assistant appending Events while it works
      // is the ordinary case rather than an exotic one.
      const port = reranker(async (input) => {
        await owner.memory.appendEvent({
          problemId: current.problemId,
          eventType: 'DISCOVERY',
          summary: 'found while the search was running',
          clientEventId: randomUUID() as ClientEventId,
        });
        return {
          candidates: input.candidates.map((candidate) => ({
            problemId: candidate.problemId,
            structuralScore: 0.5,
            matchedDimensions: ['symptom_patterns'],
          })),
        };
      });
      const service = serviceFor(owner, createRetrievalSearchCache(), provider(), port);

      expect(await searchFor(service, current.problemId)).toEqual({
        kind: 'CURRENT_SOURCE_CHANGED',
      });

      // And nothing was kept: the next search recomputes rather than answering
      // from a result built against an understanding that has moved on.
      const callsSoFar = port.calls;
      await searchFor(service, current.problemId);
      expect(port.calls).toBe(callsSoFar + 1);
    });

    it('reports a Problem deleted mid-search, and caches nothing', async () => {
      const owner = await makeActor();
      const { current } = await seedSearchable(owner);

      const port = reranker(async (input) => {
        const problem = await owner.memory.getProblem(current.problemId);
        await owner.memory.deleteProblem(current.problemId, problem?.version ?? 0);
        return {
          candidates: input.candidates.map((candidate) => ({
            problemId: candidate.problemId,
            structuralScore: 0.5,
            matchedDimensions: ['symptom_patterns'],
          })),
        };
      });
      const service = serviceFor(owner, createRetrievalSearchCache(), provider(), port);

      expect(await searchFor(service, current.problemId)).toEqual({
        kind: 'CURRENT_PROBLEM_NOT_AVAILABLE',
      });
    });

    it('reports reading switched off mid-search', async () => {
      const owner = await makeActor();
      const { current } = await seedSearchable(owner);

      const port = reranker(async (input) => {
        const problem = await owner.memory.getProblem(current.problemId);
        await owner.memory.updateProblem(current.problemId, problem?.version ?? 0, {
          memoryReadEnabled: false,
        });
        return {
          candidates: input.candidates.map((candidate) => ({
            problemId: candidate.problemId,
            structuralScore: 0.5,
            matchedDimensions: ['symptom_patterns'],
          })),
        };
      });
      const service = serviceFor(owner, createRetrievalSearchCache(), provider(), port);

      expect(await searchFor(service, current.problemId)).toEqual({ kind: 'MEMORY_READ_DISABLED' });
    });
  });

  describe('what is not worth remembering', () => {
    it('does not keep a search whose provider could not be reached', async () => {
      const owner = await makeActor();
      const current = await seed(owner);
      await seed(owner, { projectId: current.projectId });
      const failing = provider(() => {
        throw new EmbeddingGenerationFailedError();
      });
      const port = reranker();
      const service = serviceFor(owner, createRetrievalSearchCache(), failing, port);

      const first = await searchFor(service, current.problemId);
      expect(first.kind).toBe('SEARCHED');
      if (first.kind === 'SEARCHED') {
        expect(first.semanticStatus).toBe('PROVIDER_UNAVAILABLE');
      }

      // An outage frozen for five minutes would outlast its own cause.
      await searchFor(service, current.problemId);
      expect(failing.calls).toBe(2);
    });

    it('does not keep a search whose query held a credential', async () => {
      const owner = await makeActor();
      const current = await seed(owner);
      await seed(owner, { projectId: current.projectId });
      const embedding = provider();
      const service = serviceFor(owner, createRetrievalSearchCache(), embedding, reranker());

      const first = await searchFor(service, current.problemId, { semanticText: SECRET_QUERY });
      if (first.kind === 'SEARCHED') {
        expect(first.semanticStatus).toBe('SKIPPED_SENSITIVE_QUERY');
      }

      const second = await searchFor(service, current.problemId, { semanticText: SECRET_QUERY });
      // Still skipped, and still decided fresh — the privacy boundary is
      // crossed on every search rather than remembered.
      if (second.kind === 'SEARCHED') {
        expect(second.semanticStatus).toBe('SKIPPED_SENSITIVE_QUERY');
      }
      expect(embedding.calls).toBe(0);
    });

    it('does not keep a search whose reranker could not be reached', async () => {
      const owner = await makeActor();
      const current = await seed(owner);
      await seed(owner, { projectId: current.projectId });
      await seed(owner, { projectId: current.projectId });
      const port = reranker(() => {
        throw new Error('the reranker is unreachable');
      });
      const service = serviceFor(owner, createRetrievalSearchCache(), provider(), port);

      const first = await searchFor(service, current.problemId);
      if (first.kind === 'SEARCHED') {
        expect(first.structuralStatus).toBe('RERANKER_UNAVAILABLE');
      }

      await searchFor(service, current.problemId);
      expect(port.calls).toBe(2);
    });

    it('keeps a search that found nothing to reorder', async () => {
      const owner = await makeActor();
      const current = await seed(owner);
      await seed(owner, { projectId: current.projectId });
      const embedding = provider();
      const service = serviceFor(owner, createRetrievalSearchCache(), embedding, reranker());

      const first = await searchFor(service, current.problemId);
      if (first.kind === 'SEARCHED') {
        // One candidate, so the rerank stage had nothing to compare — a
        // complete answer rather than a degraded one, and worth keeping.
        expect(first.structuralStatus).toBe('NOT_NEEDED');
      }

      await searchFor(service, current.problemId);
      expect(embedding.calls).toBe(1);
    });
  });

  describe('what it stores', () => {
    it('writes nothing, on any outcome', async () => {
      const owner = await makeActor();
      const current = await seed(owner);
      await seed(owner, { projectId: current.projectId });
      const service = serviceFor(owner, createRetrievalSearchCache(), provider(), reranker());

      const before = await everythingStored(owner.ownerId);

      await searchFor(service, current.problemId);
      await searchFor(service, current.problemId);
      await searchFor(service, randomUUID() as ProblemId);
      await searchFor(service, current.problemId, { semanticText: SECRET_QUERY });

      // A search is a read, at every stage, hit or miss. No usage log, no
      // record of the order, nothing.
      expect(await everythingStored(owner.ownerId)).toBe(before);
    });
  });
});
