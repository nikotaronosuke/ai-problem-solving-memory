/**
 * The relaxed lexical fallback, against a real database.
 *
 * What is held here is the contract's shape, not its search quality: a strict
 * hit is returned untouched with no second query implied; only a strict
 * absence triggers the one relaxed pass, through the same statement and the
 * same safe parser; a relaxed answer ranks multi-term matches above a decoy
 * that shares one common word; every read control the strict statement
 * enforces binds the relaxed pass identically; and the usage record says
 * `lexical=RELAXED` exactly when the fallback produced what it records.
 *
 * The seeded artifacts are Tier-0 rows — no semantic rendering — because the
 * fallback exists for exactly the deployment that has nothing else.
 *
 * Skipped when `DATABASE_URL` is not set.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createRetrievalHybridSearchService,
  createRetrievalUsageLogWriter,
  createRetrievalVectorSearchService,
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
import { fingerprintRetrievalSource } from '../../src/domain/retrieval-summary.js';
import { resolveOwnerContextFor } from '../../src/owner/context.js';
import type { AuthenticatedRequestContext } from '../../src/app/request-context.js';
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

interface Actor {
  readonly ownerId: OwnerId;
  readonly context: OwnerContext;
  readonly memory: MemoryRepository;
  readonly artifacts: RetrievalArtifactRepository;
  readonly lexical: RetrievalSearchReader;
}

describe.skipIf(databaseUrl === undefined)('the relaxed lexical fallback', () => {
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

  /** A Problem carrying a Tier-0 artifact whose words are exactly `summary`. */
  async function seed(
    actor: Actor,
    summary: string,
    keywords: readonly string[] = [],
  ): Promise<{ problemId: ProblemId; projectId: ProjectId }> {
    const project = await actor.memory.createProject({
      projectName: `project ${randomUUID()}`,
    });
    const environment = await actor.memory.createEnvironment({
      projectId: project.projectId,
      snapshot: { runtime: 'node 22.12.0' },
    });
    const problem = await actor.memory.createProblem({
      projectId: project.projectId,
      environmentId: environment.environmentId,
      title: 'a seeded title',
      symptoms: 'seeded symptoms',
    });
    await actor.artifacts.upsertArtifact({
      problemId: problem.problemId,
      normalizedSummary: summary,
      keywords: [...keywords],
      structuralFeatures: { schema_version: '1' },
      summaryGeneratorId: 'deterministic',
      summaryGeneratorVersion: 'v1',
      semantic: null,
      sourceFingerprint: fingerprintRetrievalSource(`${summary} ${randomUUID()}`),
      generatedAt: new Date('2026-08-25T09:00:00.000Z'),
    });
    return { problemId: problem.problemId, projectId: project.projectId };
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

  describe('when the strict pass answers', () => {
    it('returns the strict answer untouched and reports the strict mode', async () => {
      const actor = await makeActor();
      const marker = `marker${randomUUID().slice(0, 8)}`;
      const seeded = await seed(actor, `a summary about ${marker} loss`);

      const strict = await actor.lexical.searchFullText({ text: `${marker} loss` });
      const fallback = await actor.lexical.searchFullTextWithFallback({
        text: `${marker} loss`,
      });

      expect(fallback.mode).toBe('STRICT');
      expect(fallback.candidates).toEqual(strict);
      expect(fallback.candidates.map((one) => one.problemId)).toEqual([seeded.problemId]);
    });
  });

  describe('when the strict pass finds nothing', () => {
    it('finds the candidate through the relaxed pass', async () => {
      const actor = await makeActor();
      const marker = `marker${randomUUID().slice(0, 8)}`;
      const seeded = await seed(actor, `the ${marker} queue is emptied after the awaited send`);

      // One word-form the artifact does not contain empties the strict pass —
      // the measured Tier-0 failure.
      const query = `${marker} cleared emptied`;
      expect(await actor.lexical.searchFullText({ text: query })).toEqual([]);

      const fallback = await actor.lexical.searchFullTextWithFallback({ text: query });
      expect(fallback.mode).toBe('RELAXED');
      expect(fallback.candidates.map((one) => one.problemId)).toContain(seeded.problemId);
    });

    it('returns an ordinary empty answer when the relaxed pass finds nothing either', async () => {
      const actor = await makeActor();
      await seed(actor, 'entirely unrelated words live here');

      const fallback = await actor.lexical.searchFullTextWithFallback({
        text: 'zzzquark zzzblorp',
      });
      expect(fallback.mode).toBe('RELAXED');
      expect(fallback.candidates).toEqual([]);
    });

    it('does not run a second pass for a single term', async () => {
      const actor = await makeActor();
      await seed(actor, 'some words');
      const fallback = await actor.lexical.searchFullTextWithFallback({ text: 'zzzquark' });
      // Relaxing one term changes nothing, so the strict absence stands as
      // the answer and the mode says no fallback ran.
      expect(fallback.mode).toBe('STRICT');
      expect(fallback.candidates).toEqual([]);
    });

    it('ranks the many-term match above a decoy sharing one common word', async () => {
      const actor = await makeActor();
      const marker = `marker${randomUUID().slice(0, 8)}`;
      const neighbour = await seed(actor, `${marker} buffer flush awaited appended dropped lines`);
      const decoy = await seed(actor, `${marker} meeting notes for tuesday`);

      const fallback = await actor.lexical.searchFullTextWithFallback({
        text: `${marker} buffer flush awaited increments`,
      });
      expect(fallback.mode).toBe('RELAXED');
      const order = fallback.candidates.map((one) => one.problemId);
      expect(order[0]).toBe(neighbour.problemId);
      expect(order).toContain(decoy.problemId);
    });

    it('holds the safe-parser boundary against query-syntax and injection-shaped input', async () => {
      const actor = await makeActor();
      const marker = `marker${randomUUID().slice(0, 8)}`;
      const seeded = await seed(actor, `notes about the ${marker} buffer`);

      for (const hostile of [
        `${marker}'); drop table public.retrieval_artifacts; -- zzzquark`,
        `"${marker} zzzquark" zzzblorp`,
        `-${marker} zzzquark`,
        `${marker} && (zzzquark | !zzzblorp)`,
      ]) {
        const fallback = await actor.lexical.searchFullTextWithFallback({ text: hostile });
        expect(fallback.candidates.map((one) => one.problemId)).toContain(seeded.problemId);
      }
      // And the table the hostile text named is, of course, still there.
      const still = await actor.lexical.searchFullText({ text: marker });
      expect(still.map((one) => one.problemId)).toEqual([seeded.problemId]);
    });

    it('keeps every read control: a read-disabled Problem stays invisible to the relaxed pass', async () => {
      const actor = await makeActor();
      const marker = `marker${randomUUID().slice(0, 8)}`;
      const seeded = await seed(actor, `the ${marker} queue is emptied after the awaited send`);
      await pool.query(
        `update public.problems set memory_read_enabled = false
          where owner_id = $1 and problem_id = $2`,
        [actor.ownerId, seeded.problemId],
      );

      const fallback = await actor.lexical.searchFullTextWithFallback({
        text: `${marker} cleared emptied`,
      });
      expect(fallback.candidates).toEqual([]);
    });

    it('never crosses the owner boundary, strict or relaxed', async () => {
      const actor = await makeActor();
      const stranger = await makeActor();
      const marker = `marker${randomUUID().slice(0, 8)}`;
      await seed(stranger, `the ${marker} queue is emptied after the awaited send`);

      const fallback = await actor.lexical.searchFullTextWithFallback({
        text: `${marker} cleared emptied`,
      });
      expect(fallback.candidates).toEqual([]);
    });
  });

  describe('through the hybrid stage with no semantic provider', () => {
    function hybridFor(actor: Actor) {
      return createRetrievalHybridSearchService(
        actor.lexical,
        createRetrievalVectorSearchService(
          {
            modelId: 'fixture-model',
            modelVersion: '1',
            dimensions: 3,
            embed: () => Promise.reject(new Error('no provider is configured')),
          },
          createRetrievalVectorSearchReader(pool, actor.context),
        ),
      );
    }

    it('carries the relaxed mode out beside the honest semantic degradation', async () => {
      const actor = await makeActor();
      const marker = `marker${randomUUID().slice(0, 8)}`;
      const seeded = await seed(actor, `the ${marker} queue is emptied after the awaited send`);

      const result = await hybridFor(actor).search({
        lexicalText: `${marker} cleared emptied`,
        semanticText: 'a buffer emptied after an awaited write loses entries',
      });
      expect(result.semanticStatus).toBe('PROVIDER_UNAVAILABLE');
      expect(result.lexicalRelaxed).toBe(true);
      expect(result.candidates.map((one) => one.problemId)).toContain(seeded.problemId);
    });

    it('reports a strict answer as strict', async () => {
      const actor = await makeActor();
      const marker = `marker${randomUUID().slice(0, 8)}`;
      await seed(actor, `a summary about ${marker}`);

      const result = await hybridFor(actor).search({
        lexicalText: marker,
        semanticText: 'anything at all',
      });
      expect(result.lexicalRelaxed).toBe(false);
      expect(result.candidates.length).toBeGreaterThan(0);
    });
  });

  describe('what the usage record says', () => {
    function requestContextFor(actor: Actor): AuthenticatedRequestContext {
      const runner = createTransactionRunner(pool);
      return {
        clientId: 'fixture-client' as ClientId,
        repository: actor.memory,
        retrievalArtifacts: actor.artifacts,
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

    async function reasonsOf(ownerId: OwnerId): Promise<string[]> {
      const rows = await pool.query<{ reason: string }>(
        `select reason from public.usage_logs where owner_id = $1 order by created_at asc`,
        [ownerId],
      );
      return rows.rows.map((row) => row.reason);
    }

    it('says lexical=RELAXED exactly when the fallback produced the answer', async () => {
      const actor = await makeActor();
      const current = await seed(actor, 'the problem being worked on');
      const surfaced = await seed(actor, 'the memory that surfaced');
      const writer = createRetrievalUsageLogWriter(requestContextFor(actor));

      const candidateFor = (rank: number) => ({
        problemId: surfaced.problemId,
        projectId: surfaced.projectId,
        rankingRank: rank,
        projectRelation: 'OTHER_TECH' as const,
        confidence: 'LOW' as const,
        freshness: 'CURRENT' as const,
        suppressed: false,
        structuralScore: null,
        hybridRank: rank,
        matchedDimensions: [],
      });

      await writer.recordSearched({
        currentProblemId: current.problemId,
        sourceAi: 'claude-code',
        candidates: [candidateFor(1)],
        semanticStatus: 'PROVIDER_UNAVAILABLE',
        structuralStatus: 'NOT_NEEDED',
        lexicalRelaxed: true,
      });
      await writer.recordSearched({
        currentProblemId: current.problemId,
        sourceAi: 'claude-code',
        candidates: [candidateFor(1)],
        semanticStatus: 'PROVIDER_UNAVAILABLE',
        structuralStatus: 'NOT_NEEDED',
        lexicalRelaxed: false,
      });

      const reasons = await reasonsOf(actor.ownerId);
      expect(reasons).toHaveLength(2);
      expect(reasons[0]).toContain('; lexical=RELAXED.');
      expect(reasons[1]).not.toContain('lexical=');
    });
  });
});
