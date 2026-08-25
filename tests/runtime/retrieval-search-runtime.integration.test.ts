/**
 * The production search composition, against a real database.
 *
 * The HTTP suite proves the endpoint works end to end. This one is about the
 * composition itself — the four claims the runtime makes that a response body
 * cannot show:
 *
 * **Owner scope comes from the authenticated context and is resolved, never
 * asserted.** An owner id in a context is a claim; `resolveOwnerContextFor` is
 * where it becomes a fact. A composition that skipped it would build a working
 * pipeline for an owner who is not there.
 *
 * **A context carrying two owners is refused.** Every reader is owner-safe
 * alone and none can see the others, so only the pairing can be wrong — and a
 * wrongly built service must not exist rather than return mixed results.
 *
 * **One cache, for the life of the process.** The rerank cache has the owner
 * inside its key, so a single instance serves everybody; a per-request cache
 * would be empty on arrival every time, which is the one thing a five-minute
 * cache must not be.
 *
 * **Nothing is retained per request.** The usage-log writer inside a service
 * records under the context that authenticated that request, so a service kept
 * for a second request would record the first request's client.
 *
 * The ports here are vendor-neutral doubles, which is the whole point of them
 * being ports: this module names no vendor and cannot tell one from another.
 *
 * Every credential fixture is synthetic. Skipped without `DATABASE_URL`.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createRetrievalSearchCache,
  type AuthenticatedRequestContext,
  type RetrievalUsageLogFailureReporter,
} from '../../src/app/index.js';
import { readDatabaseUrl } from '../../src/config/env.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import { createTransactionRunner } from '../../src/db/transaction.js';
import type { ClientId } from '../../src/domain/client.js';
import { generateOwnerId, type OwnerContext, type OwnerId } from '../../src/domain/owner.js';
import type { ProblemId } from '../../src/domain/problem.js';
import type { ProjectId } from '../../src/domain/project.js';
import type { EmbeddingProvider } from '../../src/domain/retrieval-embedding.js';
import type {
  StructuralReranker,
  StructuralRerankerInput,
} from '../../src/domain/retrieval-structural-rerank.js';
import {
  STRUCTURAL_FEATURE_SCHEMA_VERSION,
  type StructuralFeatures,
} from '../../src/domain/retrieval-summary.js';
import { resolveOwnerContextFor } from '../../src/owner/context.js';
import {
  createMemoryRepository,
  createRetrievalArtifactRepository,
  type MemoryRepository,
  type RetrievalArtifactRepository,
} from '../../src/repository/index.js';
import { createRetrievalSearchRuntime } from '../../src/runtime/retrieval-search-runtime.js';
import {
  createArtifactInspectionPolicy,
  createSecretDetectionPolicy,
  withSanitization,
} from '../../src/sanitization/index.js';

const databaseUrl = readDatabaseUrl();

const DIMENSIONS = 3;
const MARKER = 'deployment';

const FEATURES: StructuralFeatures = {
  schema_version: STRUCTURAL_FEATURE_SCHEMA_VERSION,
  problem_domain: MARKER,
  symptom_patterns: ['works locally, fails once deployed'],
  suspected_boundaries: ['configuration read at build time'],
  occurrence_conditions: ['only in the deployed environment'],
  successful_directions: [],
  dead_end_directions: ['raising the timeout'],
  environment_facts: ['node 22.12.0'],
};

/** A semantic port that counts. Vendor-neutral, as the runtime requires. */
function countingEmbedding(): EmbeddingProvider & { calls: number } {
  const state = {
    modelId: 'fixture-embedding-model',
    modelVersion: '1',
    dimensions: DIMENSIONS,
    calls: 0,
    embed(): Promise<unknown> {
      state.calls += 1;
      return Promise.resolve([1, 0, 0]);
    },
  };
  return state;
}

/** A structural port that counts, scoring in the order it was handed. */
function countingReranker(): StructuralReranker & { calls: number } {
  const state = {
    calls: 0,
    rerank(input: StructuralRerankerInput): Promise<unknown> {
      state.calls += 1;
      return Promise.resolve({
        candidates: input.candidates.map((candidate, index) => ({
          problemId: candidate.problemId,
          structuralScore: Math.max(0.1, 1 - index / 10),
          matchedDimensions: ['symptom_patterns'],
        })),
      });
    },
  };
  return state;
}

const silentReporter: RetrievalUsageLogFailureReporter = { report: () => undefined };

interface Actor {
  readonly ownerId: OwnerId;
  readonly context: OwnerContext;
  readonly memory: MemoryRepository;
  readonly artifacts: RetrievalArtifactRepository;
}

describe.skipIf(databaseUrl === undefined)('the production search composition', () => {
  let pool: DatabasePool;
  const ownersCreated: OwnerId[] = [];

  beforeAll(() => {
    pool = createPool(resolveDatabaseConfig({ nodeEnv: 'test' }));
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

  /**
   * A request context assembled the way the server assembles one: the same
   * sanitized repositories, the same transaction runner.
   */
  function requestContextFor(
    actor: Actor,
    overrides: { readonly artifactOwner?: Actor } = {},
  ): AuthenticatedRequestContext {
    const runner = createTransactionRunner(pool);
    return {
      clientId: 'fixture-client' as ClientId,
      repository: actor.memory,
      retrievalArtifacts: (overrides.artifactOwner ?? actor).artifacts,
      runInTransaction: (work) =>
        runner.run((transactional) =>
          work(
            withSanitization(
              createMemoryRepository(transactional, actor.context),
              createSecretDetectionPolicy(),
            ),
          ),
        ),
    };
  }

  async function seed(
    actor: Actor,
    options: { readonly projectId?: ProjectId } = {},
  ): Promise<{ problemId: ProblemId; projectId: ProjectId }> {
    const projectId =
      options.projectId ??
      (
        await actor.memory.createProject({
          projectName: `project ${randomUUID()}`,
          platform: 'fixture-platform',
        })
      ).projectId;
    const environment = await actor.memory.createEnvironment({
      projectId,
      snapshot: { runtime: 'node 22.12.0' },
    });
    const problem = await actor.memory.createProblem({
      projectId,
      environmentId: environment.environmentId,
      title: 'a seeded title',
      symptoms: `seeded symptoms about ${MARKER}`,
    });

    await actor.artifacts.upsertArtifact({
      problemId: problem.problemId,
      normalizedSummary: `a summary about ${MARKER}`,
      keywords: [MARKER],
      structuralFeatures: { ...FEATURES },
      summaryGeneratorId: 'fixture-summary-generator',
      summaryGeneratorVersion: '1',
      semantic: {
        embedding: [1, 0, 0],
        embeddingModel: 'fixture-embedding-model',
        embeddingModelVersion: '1',
      },
      sourceFingerprint: `retrieval-source-v1:${randomUUID().replace(/-/g, '')}`,
      generatedAt: new Date('2026-08-17T09:00:00.000Z'),
    });

    return { problemId: problem.problemId, projectId };
  }

  /** A Problem with two findable neighbours, so the rerank stage has work. */
  async function seedSearchable(actor: Actor): Promise<ProblemId> {
    const current = await seed(actor);
    await seed(actor, { projectId: current.projectId });
    await seed(actor, { projectId: current.projectId });
    return current.problemId;
  }

  const searchWith = (
    service: { search: (request: never, invocation: never) => unknown },
    currentProblemId: ProblemId,
  ) =>
    service.search(
      {
        currentProblemId,
        lexicalText: MARKER,
        semanticText: 'the app works locally but fails once deployed',
        currentFeatures: FEATURES,
      } as never,
      { sourceAi: 'fixture-assistant' } as never,
    );

  it('resolves a service scoped to the owner the context authenticated', async () => {
    const actor = await makeActor();
    const runtime = createRetrievalSearchRuntime({ pool });

    const service = await runtime.resolve(requestContextFor(actor), silentReporter);

    // The owner every stage shares, taken from the context's own repositories
    // and from nowhere else.
    expect(service.ownerId).toBe(actor.ownerId);
  });

  it('refuses a context whose two repositories belong to different owners', async () => {
    const mine = await makeActor();
    const stranger = await makeActor();
    const runtime = createRetrievalSearchRuntime({ pool });

    // Not a hypothetical: the two repositories are built separately, and a
    // composition that trusted either one alone would read one owner's Problems
    // and another owner's artifacts into a single result.
    await expect(
      runtime.resolve(requestContextFor(mine, { artifactOwner: stranger }), silentReporter),
    ).rejects.toThrow('A request context carries two owners.');
  });

  it('refuses to resolve an owner who is not there', async () => {
    const runtime = createRetrievalSearchRuntime({ pool });
    const absent = generateOwnerId();
    const context = {
      clientId: 'fixture-client' as ClientId,
      repository: { ownerId: absent } as unknown as MemoryRepository,
      retrievalArtifacts: { ownerId: absent } as unknown as RetrievalArtifactRepository,
      runInTransaction: () => Promise.reject(new Error('not used')),
    } as AuthenticatedRequestContext;

    // The owner id agrees with itself, which is exactly the case a cast would
    // wave through. Resolution is what makes it a fact rather than a claim.
    await expect(runtime.resolve(context, silentReporter)).rejects.toThrow();
  });

  it('builds a fresh service per request, and keeps nothing', async () => {
    const actor = await makeActor();
    const runtime = createRetrievalSearchRuntime({ pool });

    const first = await runtime.resolve(requestContextFor(actor), silentReporter);
    const second = await runtime.resolve(requestContextFor(actor), silentReporter);

    // Distinct, deliberately. The usage-log writer inside a service records
    // under the context that authenticated *that* request; a service cached per
    // owner would record every later search under the first request's client.
    expect(second).not.toBe(first);
    expect(second.ownerId).toBe(first.ownerId);
  });

  it('shares one cache across requests, so a repeat search buys nothing twice', async () => {
    const actor = await makeActor();
    const problemId = await seedSearchable(actor);
    const embedding = countingEmbedding();
    const reranker = countingReranker();
    const runtime = createRetrievalSearchRuntime({
      pool,
      embeddingProvider: embedding,
      structuralReranker: reranker,
    });

    const first = await runtime.resolve(requestContextFor(actor), silentReporter);
    await searchWith(first, problemId);
    expect(embedding.calls).toBe(1);
    expect(reranker.calls).toBe(1);

    // A second request, a second service — and the same cache. This is the one
    // thing that must survive `resolve` returning.
    const second = await runtime.resolve(requestContextFor(actor), silentReporter);
    await searchWith(second, problemId);

    expect(embedding.calls).toBe(1);
    expect(reranker.calls).toBe(1);
  });

  it('does not let one owner’s cached work answer another’s search', async () => {
    const mine = await makeActor();
    const theirs = await makeActor();
    const myProblem = await seedSearchable(mine);
    const theirProblem = await seedSearchable(theirs);
    const embedding = countingEmbedding();
    const reranker = countingReranker();
    const runtime = createRetrievalSearchRuntime({
      pool,
      embeddingProvider: embedding,
      structuralReranker: reranker,
    });

    await searchWith(await runtime.resolve(requestContextFor(mine), silentReporter), myProblem);
    await searchWith(
      await runtime.resolve(requestContextFor(theirs), silentReporter),
      theirProblem,
    );

    // One cache, and the owner is inside its key. Two owners asking the same
    // question in the same words are two questions.
    expect(embedding.calls).toBe(2);
    expect(reranker.calls).toBe(2);
  });

  it('accepts a cache from its caller rather than insisting on its own', async () => {
    const actor = await makeActor();
    const problemId = await seedSearchable(actor);
    const cache = createRetrievalSearchCache();
    const embedding = countingEmbedding();
    const runtime = createRetrievalSearchRuntime({
      pool,
      embeddingProvider: embedding,
      structuralReranker: countingReranker(),
      cache,
    });

    await searchWith(await runtime.resolve(requestContextFor(actor), silentReporter), problemId);
    // The seam exists so a test can watch the cache; production passes nothing
    // and gets exactly one, which is what the previous test relies on.
    expect(embedding.calls).toBe(1);
  });

  it('answers with neither port configured, reaching nothing', async () => {
    const actor = await makeActor();
    const problemId = await seedSearchable(actor);
    const runtime = createRetrievalSearchRuntime({ pool });

    const service = await runtime.resolve(requestContextFor(actor), silentReporter);
    const outcome = (await searchWith(service, problemId)) as {
      kind: string;
      semanticStatus: string;
      structuralStatus: string;
      candidates: unknown[];
    };

    // Absence is composed, not stubbed: the runtime passes what it has, and the
    // two stage services own the degradation. No object exists here whose only
    // purpose is to fail.
    expect(outcome.kind).toBe('SEARCHED');
    expect(outcome.semanticStatus).toBe('PROVIDER_UNAVAILABLE');
    expect(outcome.structuralStatus).toBe('RERANKER_UNAVAILABLE');
    expect(outcome.candidates.length).toBeGreaterThan(0);
  });

  it('names no vendor anywhere in what it hands back', async () => {
    const actor = await makeActor();
    const runtime = createRetrievalSearchRuntime({
      pool,
      embeddingProvider: countingEmbedding(),
      structuralReranker: countingReranker(),
    });

    const service = await runtime.resolve(requestContextFor(actor), silentReporter);

    // The runtime received two ports and a pool. It cannot report a provider
    // identity because it was never told one — and the ports it holds are the
    // same shape whichever vendor is behind them.
    expect(Object.keys(service).sort()).toEqual(['ownerId', 'search']);
  });
});
