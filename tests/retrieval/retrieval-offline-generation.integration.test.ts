/**
 * Offline-capable generation, against a real database: an artifact exists —
 * and is findable by the free lexical channel — with no provider configured,
 * no provider reachable, and no embedding stored.
 *
 * The invariants held here are the ones the provider-credit incident showed
 * were missing: the semantic rendering is optional as one whole (all three
 * columns or none, never a half), the deterministic stack persists artifacts
 * with its own recorded identity, a configured-but-failing provider costs the
 * enhancement and never the artifact, vector search never compares a row that
 * has no vector, and the deterministic reconciliation profile leaves
 * provider-enriched rows standing instead of regenerating them downward.
 *
 * Skipped when `DATABASE_URL` is not set.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readDatabaseUrl } from '../../src/config/env.js';
import { createDeterministicSummaryGenerator } from '../../src/app/deterministic-summary-generator.js';
import { createRetrievalArtifactGenerationService } from '../../src/app/retrieval-artifact-generation-service.js';
import { createRetrievalSummaryService } from '../../src/app/retrieval-summary-service.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import { findProblemsNeedingArtifactGeneration } from '../../src/db/retrieval-artifact-reconciliation.js';
import { searchArtifactsByText } from '../../src/db/retrieval-full-text-search.js';
import { searchArtifactsByVector } from '../../src/db/retrieval-vector-search.js';
import { createTransactionRunner } from '../../src/db/transaction.js';
import {
  DETERMINISTIC_RENDERER_ID,
  DETERMINISTIC_RENDERER_VERSION,
} from '../../src/domain/deterministic-retrieval-renderer.js';
import { generateOwnerId, type OwnerContext, type OwnerId } from '../../src/domain/owner.js';
import type { ProblemId } from '../../src/domain/problem.js';
import { requireRetrievalGenerationProfile } from '../../src/domain/retrieval-generation-profile.js';
import {
  resolveFullTextSearchQuery,
  resolveVectorSearchQuery,
} from '../../src/domain/retrieval-search.js';
import { fingerprintRetrievalSource } from '../../src/domain/retrieval-summary.js';
import { resolveOwnerContextFor } from '../../src/owner/context.js';
import {
  createMemoryRepository,
  createRetrievalArtifactRepository,
  createRetrievalSummarySourceReader,
  type MemoryRepository,
  type RetrievalArtifactRepository,
} from '../../src/repository/index.js';
import { createRetrievalRuntime } from '../../src/runtime/retrieval-runtime.js';
import {
  createArtifactInspectionPolicy,
  createSecretDetectionPolicy,
  withSanitization,
} from '../../src/sanitization/index.js';

const databaseUrl = readDatabaseUrl();

const DETERMINISTIC_PROFILE = requireRetrievalGenerationProfile({
  summaryGeneratorId: DETERMINISTIC_RENDERER_ID,
  summaryGeneratorVersion: DETERMINISTIC_RENDERER_VERSION,
  semantic: null,
});

interface Actor {
  readonly ownerId: OwnerId;
  readonly context: OwnerContext;
  readonly memory: MemoryRepository;
  readonly artifacts: RetrievalArtifactRepository;
  readonly problemId: ProblemId;
  readonly projectId: string;
}

describe.skipIf(databaseUrl === undefined)('offline-capable artifact generation', () => {
  let pool: DatabasePool;
  const ownersCreated: OwnerId[] = [];

  async function makeActor(tag: string): Promise<Actor> {
    const ownerId = generateOwnerId();
    await insertOwnerIfAbsent(pool, ownerId);
    ownersCreated.push(ownerId);

    const context = await resolveOwnerContextFor(pool, ownerId);
    const memory = withSanitization(
      createMemoryRepository(pool, context),
      createSecretDetectionPolicy(),
    );
    const artifacts = withSanitization(
      createRetrievalArtifactRepository(pool, context),
      createArtifactInspectionPolicy(),
    );

    const project = await memory.createProject({ projectName: `${tag} project` });
    const environment = await memory.createEnvironment({
      projectId: project.projectId,
      snapshot: { runtime: 'node 22.12.0' },
    });
    const problem = await memory.createProblem({
      projectId: project.projectId,
      environmentId: environment.environmentId,
      title: `${tag} scheduled export writes an empty file`,
      symptoms: `${tag} the run completes without errors but the file has zero rows`,
    });

    return {
      ownerId,
      context,
      memory,
      artifacts,
      problemId: problem.problemId,
      projectId: project.projectId,
    };
  }

  function deterministicService(actor: Actor) {
    return createRetrievalArtifactGenerationService(
      createRetrievalSummaryService(
        createRetrievalSummarySourceReader(pool, actor.context),
        createDeterministicSummaryGenerator(),
      ),
      null,
      createTransactionRunner(pool),
      actor.context,
    );
  }

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

  describe('the schema holds the rendering whole', () => {
    it('stores an artifact with no semantic rendering at all', async () => {
      const actor = await makeActor('all-null');
      const stored = await actor.artifacts.upsertArtifact({
        problemId: actor.problemId,
        normalizedSummary: 'an export that writes nothing',
        keywords: ['export'],
        structuralFeatures: { schema_version: '1' },
        summaryGeneratorId: DETERMINISTIC_RENDERER_ID,
        summaryGeneratorVersion: DETERMINISTIC_RENDERER_VERSION,
        semantic: null,
        sourceFingerprint: fingerprintRetrievalSource('a source'),
        generatedAt: new Date(),
      });
      expect(stored.semantic).toBeNull();
    });

    it('still stores an artifact with the whole semantic rendering', async () => {
      const actor = await makeActor('all-present');
      const stored = await actor.artifacts.upsertArtifact({
        problemId: actor.problemId,
        normalizedSummary: 'an export that writes nothing',
        keywords: ['export'],
        structuralFeatures: { schema_version: '1' },
        summaryGeneratorId: 'scripted',
        summaryGeneratorVersion: '1',
        semantic: {
          embedding: [0.1, 0.2, 0.3],
          embeddingModel: 'scripted-model',
          embeddingModelVersion: 'v1',
        },
        sourceFingerprint: fingerprintRetrievalSource('a source'),
        generatedAt: new Date(),
      });
      expect(stored.semantic?.embeddingModel).toBe('scripted-model');
    });

    it('refuses half a rendering at the schema itself', async () => {
      const actor = await makeActor('half');
      await actor.artifacts.upsertArtifact({
        problemId: actor.problemId,
        normalizedSummary: 'an export that writes nothing',
        keywords: ['export'],
        structuralFeatures: { schema_version: '1' },
        summaryGeneratorId: 'scripted',
        summaryGeneratorVersion: '1',
        semantic: {
          embedding: [0.1, 0.2, 0.3],
          embeddingModel: 'scripted-model',
          embeddingModelVersion: 'v1',
        },
        sourceFingerprint: fingerprintRetrievalSource('a source'),
        generatedAt: new Date(),
      });

      // Below the domain layer on purpose: the constraint is what stands when
      // every validator is bypassed.
      for (const statement of [
        `update public.retrieval_artifacts set embedding = null where owner_id = $1`,
        `update public.retrieval_artifacts set embedding_model = null where owner_id = $1`,
        `update public.retrieval_artifacts set embedding_model_version = null where owner_id = $1`,
      ]) {
        await expect(pool.query(statement, [actor.ownerId])).rejects.toThrow(
          /retrieval_artifacts_semantic_rendering_all_or_none/,
        );
      }
    });
  });

  describe('the deterministic stack, with nothing configured', () => {
    it('generates and persists an artifact with its own identity and no vector', async () => {
      const actor = await makeActor('tier0');
      const outcome = await deterministicService(actor).generateArtifact(actor.problemId);

      expect(outcome.kind).toBe('STORED');
      if (outcome.kind !== 'STORED') {
        return;
      }
      expect(outcome.artifact.summaryGeneratorId).toBe(DETERMINISTIC_RENDERER_ID);
      expect(outcome.artifact.summaryGeneratorVersion).toBe(DETERMINISTIC_RENDERER_VERSION);
      expect(outcome.artifact.semantic).toBeNull();
      expect(outcome.artifact.normalizedSummary).toContain('scheduled export');
    });

    it('is found by the lexical channel and never by the vector channel', async () => {
      const actor = await makeActor('channels');
      const outcome = await deterministicService(actor).generateArtifact(actor.problemId);
      expect(outcome.kind).toBe('STORED');

      const lexical = await searchArtifactsByText(
        pool,
        actor.context,
        resolveFullTextSearchQuery({ text: 'scheduled export empty' }),
      );
      expect(lexical.map((candidate) => candidate.problemId)).toContain(actor.problemId);

      // A vector search in any space: the row has no vector, so no space can
      // claim it. A second, semantic row proves the query itself works.
      const semanticActor = await makeActor('channels-semantic');
      await semanticActor.artifacts.upsertArtifact({
        problemId: semanticActor.problemId,
        normalizedSummary: 'a semantic neighbour',
        keywords: ['neighbour'],
        structuralFeatures: { schema_version: '1' },
        summaryGeneratorId: 'scripted',
        summaryGeneratorVersion: '1',
        semantic: {
          embedding: [1, 0, 0],
          embeddingModel: 'scripted-model',
          embeddingModelVersion: 'v1',
        },
        sourceFingerprint: fingerprintRetrievalSource('semantic source'),
        generatedAt: new Date(),
      });

      const vector = await searchArtifactsByVector(
        pool,
        semanticActor.context,
        {
          embedding: [1, 0, 0],
          embeddingModel: 'scripted-model',
          embeddingModelVersion: 'v1',
          dimensions: 3,
        },
        resolveVectorSearchQuery({ text: 'a semantic neighbour' }),
      );
      expect(vector.map((candidate) => candidate.problemId)).toEqual([semanticActor.problemId]);

      const vectorForDeterministicOwner = await searchArtifactsByVector(
        pool,
        actor.context,
        {
          embedding: [1, 0, 0],
          embeddingModel: 'scripted-model',
          embeddingModelVersion: 'v1',
          dimensions: 3,
        },
        resolveVectorSearchQuery({ text: 'scheduled export empty' }),
      );
      expect(vectorForDeterministicOwner).toEqual([]);
    });

    it('reconciles a missing artifact and leaves an enriched one standing', async () => {
      const enriched = await makeActor('no-downgrade');
      await enriched.artifacts.upsertArtifact({
        problemId: enriched.problemId,
        normalizedSummary: 'written by a provider, kept as it is',
        keywords: ['provider'],
        structuralFeatures: { schema_version: '1' },
        summaryGeneratorId: 'scripted',
        summaryGeneratorVersion: '1',
        semantic: {
          embedding: [0.5, 0.5],
          embeddingModel: 'scripted-model',
          embeddingModelVersion: 'v1',
        },
        sourceFingerprint: fingerprintRetrievalSource('provider source'),
        generatedAt: new Date(),
      });
      const bare = await makeActor('missing');

      const enrichedFindings = await findProblemsNeedingArtifactGeneration(
        pool,
        enriched.context,
        DETERMINISTIC_PROFILE,
      );
      expect(enrichedFindings).toEqual([]);

      const bareFindings = await findProblemsNeedingArtifactGeneration(
        pool,
        bare.context,
        DETERMINISTIC_PROFILE,
      );
      expect(bareFindings).toEqual([{ problemId: bare.problemId, reason: 'ARTIFACT_MISSING' }]);
    });
  });

  describe('the fail-soft runtime', () => {
    it('generates deterministically on sweep with no providers at all', async () => {
      const actor = await makeActor('sweep-tier0');
      const runtime = createRetrievalRuntime({
        pool,
        discoverOwners: () => Promise.resolve([actor.ownerId]),
      });

      await runtime.sweep();
      await runtime.settled();
      runtime.stop();

      const artifact = await actor.artifacts.getArtifact(actor.problemId);
      expect(artifact?.summaryGeneratorId).toBe(DETERMINISTIC_RENDERER_ID);
      expect(artifact?.semantic).toBeNull();
    });

    it('keeps the artifact when a configured provider fails', async () => {
      const actor = await makeActor('fallback');
      const runtime = createRetrievalRuntime({
        pool,
        discoverOwners: () => Promise.resolve([actor.ownerId]),
        providers: {
          summaryGenerator: {
            generatorId: 'scripted',
            generatorVersion: '1',
            generate: () => Promise.reject(new Error('the provider is out of credit')),
          },
          embeddingProvider: {
            modelId: 'scripted-model',
            modelVersion: 'v1',
            dimensions: 3,
            embed: () => Promise.reject(new Error('the provider is out of credit')),
          },
          generationProfile: requireRetrievalGenerationProfile({
            summaryGeneratorId: 'scripted',
            summaryGeneratorVersion: '1',
            semantic: {
              embeddingModel: 'scripted-model',
              embeddingModelVersion: 'v1',
              embeddingDimensions: 3,
            },
          }),
        },
      });

      await runtime.sweep();
      await runtime.settled();
      runtime.stop();

      // The enhancement failed; the artifact did not. The deterministic
      // rendering stands, under its own honest identity.
      const artifact = await actor.artifacts.getArtifact(actor.problemId);
      expect(artifact?.summaryGeneratorId).toBe(DETERMINISTIC_RENDERER_ID);
      expect(artifact?.semantic).toBeNull();
    });
  });
});
