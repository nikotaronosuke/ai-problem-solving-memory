/**
 * The lifecycle invariant, measured: a canonical write and the death of the
 * artifact it outdates are one atom.
 *
 * Every case here follows the same shape — put a current artifact in place,
 * perform one write, look at the artifact — because the invariant is exactly
 * that simple: writes that change the canonical source leave no artifact
 * behind, writes that do not leave it byte-identical, and no write can end in
 * between. The failed and replayed variants matter as much as the successful
 * ones: a version conflict changed nothing, so it must delete nothing, and an
 * idempotent replay is the same write again, not a second change.
 *
 * Real database throughout. The atomicity being proven lives in SQL
 * statements and transactions, and a double proves nothing about either.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createEventService,
  createMemoryControlService,
  createProblemCloseService,
  createProblemDeleteService,
  createProblemService,
  createProblemStatusService,
  createVerificationService,
  type AuthenticatedRequestContext,
} from '../../src/app/index.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import { createTransactionRunner } from '../../src/db/transaction.js';
import type { ClientEventId } from '../../src/domain/client-event-id.js';
import { generateOwnerId, type OwnerId } from '../../src/domain/owner.js';
import type { ProblemId } from '../../src/domain/problem.js';
import { resolveOwnerContextFor } from '../../src/owner/context.js';
import {
  createMemoryRepository,
  createRetrievalArtifactRepository,
  type MemoryRepository,
  type RetrievalArtifactRepository,
} from '../../src/repository/index.js';
import {
  createArtifactInspectionPolicy,
  createSecretDetectionPolicy,
  withSanitization,
} from '../../src/sanitization/index.js';

const databaseUrl = process.env['DATABASE_URL'];

describe.skipIf(databaseUrl === undefined)('artifact invalidation on canonical writes', () => {
  let pool: DatabasePool;
  let memory: MemoryRepository;
  let artifacts: RetrievalArtifactRepository;
  let context: AuthenticatedRequestContext;
  let ownerId: OwnerId;
  const ownersCreated: OwnerId[] = [];

  beforeAll(async () => {
    pool = createPool(resolveDatabaseConfig({ nodeEnv: 'test', connectionTimeoutMillis: 5_000 }));
    ownerId = generateOwnerId();
    await insertOwnerIfAbsent(pool, ownerId);
    ownersCreated.push(ownerId);

    const ownerContext = await resolveOwnerContextFor(pool, ownerId);
    memory = withSanitization(
      createMemoryRepository(pool, ownerContext),
      createSecretDetectionPolicy(),
    );
    artifacts = withSanitization(
      createRetrievalArtifactRepository(pool, ownerContext),
      createArtifactInspectionPolicy(),
    );
    const runner = createTransactionRunner(pool);
    context = {
      clientId: randomUUID() as never,
      repository: memory,
      retrievalArtifacts: artifacts,
      runInTransaction: (work) =>
        runner.run((transactional) =>
          work(
            withSanitization(
              createMemoryRepository(transactional, ownerContext),
              createSecretDetectionPolicy(),
            ),
          ),
        ),
    };
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

  /** A Problem carrying a current artifact, ready to be written to. */
  async function seeded(): Promise<ProblemId> {
    const project = await memory.createProject({ projectName: `project ${randomUUID()}` });
    const environment = await memory.createEnvironment({
      projectId: project.projectId,
      snapshot: { runtime: 'node 22.12.0' },
    });
    const problem = await memory.createProblem({
      projectId: project.projectId,
      environmentId: environment.environmentId,
      title: 'a seeded title',
      symptoms: 'seeded symptoms',
    });
    await artifacts.upsertArtifact({
      problemId: problem.problemId,
      normalizedSummary: 'a rendering of the seeded record',
      keywords: ['seeded'],
      structuralFeatures: {
        schema_version: '1',
        problem_domain: null,
        symptom_patterns: ['seeded symptoms'],
        suspected_boundaries: [],
        occurrence_conditions: [],
        successful_directions: [],
        dead_end_directions: [],
        environment_facts: [],
      },
      summaryGeneratorId: 'fixture-summary-generator',
      summaryGeneratorVersion: '1',
      semantic: {
        embedding: [1, 0, 0],
        embeddingModel: 'fixture-model',
        embeddingModelVersion: '1',
      },
      sourceFingerprint: `retrieval-source-v1:${randomUUID().replace(/-/g, '')}`,
      generatedAt: new Date('2026-08-17T09:00:00.000Z'),
    });
    return problem.problemId;
  }

  const gone = async (problemId: ProblemId) =>
    expect(await artifacts.getArtifact(problemId)).toBeUndefined();
  const kept = async (problemId: ProblemId) =>
    expect(await artifacts.getArtifact(problemId)).toBeDefined();

  const versionOf = async (problemId: ProblemId) =>
    (await memory.getProblem(problemId))?.version ?? 0;

  describe('the Problem PATCH', () => {
    it('takes the artifact when a canonical field moves', async () => {
      for (const patch of [
        { title: 'a new title' },
        { symptoms: 'new symptoms' },
        { problemDomain: 'a domain' },
        { suspectedBoundary: 'a boundary' },
      ]) {
        const problemId = await seeded();
        await memory.updateProblem(problemId, await versionOf(problemId), patch);
        await gone(problemId);
      }
    });

    it('leaves the artifact when only metadata moves', async () => {
      for (const patch of [
        { sourceAi: 'another-assistant' },
        { importance: true },
        { confidence: 'HIGH' },
        { freshness: 'STALE_UNKNOWN' },
        { memoryWriteEnabled: false },
        { suppressed: true },
      ] as const) {
        const problemId = await seeded();
        await memory.updateProblem(problemId, await versionOf(problemId), patch);
        await kept(problemId);
      }
    });

    it('takes the artifact when a mixed patch touches anything canonical', async () => {
      const problemId = await seeded();
      await memory.updateProblem(problemId, await versionOf(problemId), {
        title: 'a new title',
        confidence: 'HIGH',
        suppressed: true,
      });
      await gone(problemId);
    });

    it('leaves the artifact when the version does not match', async () => {
      const problemId = await seeded();
      const updated = await memory.updateProblem(problemId, 999, { title: 'a new title' });
      expect(updated).toBeUndefined();
      await kept(problemId);
    });
  });

  describe('the read control', () => {
    it('is not an invalidation in either direction', async () => {
      const problemId = await seeded();
      await memory.updateProblem(problemId, await versionOf(problemId), {
        memoryReadEnabled: false,
      });
      await kept(problemId);
      await memory.updateProblem(problemId, await versionOf(problemId), {
        memoryReadEnabled: true,
      });
      // Nothing canonical moved while reading was off, so the rendering is
      // still a rendering of the current record and comes straight back into
      // service. Reconciliation has nothing to do here.
      await kept(problemId);
    });

    it('does not shield the artifact from a canonical write made while off', async () => {
      const problemId = await seeded();
      await memory.updateProblem(problemId, await versionOf(problemId), {
        memoryReadEnabled: false,
      });
      // A mutation stales a rendering whatever the read flag says: the flag
      // is about who may read, not about what the record is.
      await memory.appendEvent({
        problemId,
        eventType: 'DISCOVERY',
        summary: 'found while reading was off',
        clientEventId: randomUUID() as ClientEventId,
      });
      await gone(problemId);
    });
  });

  describe('the status transition', () => {
    it('takes the artifact when the transition happens', async () => {
      const problemId = await seeded();
      await memory.updateProblemStatus(problemId, await versionOf(problemId), 'FIX_CANDIDATE');
      await gone(problemId);
    });

    it('leaves the artifact when the version does not match', async () => {
      const problemId = await seeded();
      const moved = await memory.updateProblemStatus(problemId, 999, 'FIX_CANDIDATE');
      expect(moved).toBeUndefined();
      await kept(problemId);
    });

    it('leaves the artifact when the service refuses the move', async () => {
      const problemId = await seeded();
      const service = createProblemStatusService();
      // INVESTIGATING → VERIFIED is not an allowed transition, evidence or
      // not; the refusal throws before any write.
      await expect(
        service.transition(context, problemId, {
          targetStatus: 'VERIFIED',
          expectedVersion: await versionOf(problemId),
          changedBy: 'fixture',
        }),
      ).rejects.toThrow();
      await kept(problemId);
    });
  });

  describe('the Event append', () => {
    it('takes the artifact for every event type', async () => {
      for (const eventType of [
        'HYPOTHESIS',
        'ATTEMPT',
        'DEAD_END',
        'DISCOVERY',
        'FIX',
        'USER_CORRECTION',
      ] as const) {
        const problemId = await seeded();
        await memory.appendEvent({
          problemId,
          eventType,
          summary: `an event of type ${eventType}`,
          clientEventId: randomUUID() as ClientEventId,
        });
        await gone(problemId);
      }
    });

    it('does not take it again on an idempotent replay', async () => {
      const problemId = await seeded();
      const clientEventId = randomUUID() as ClientEventId;
      const first = await memory.appendEvent({
        problemId,
        eventType: 'ATTEMPT',
        summary: 'the first write',
        clientEventId,
      });
      await gone(problemId);

      // Regeneration has since put a current rendering back.
      await artifacts.upsertArtifact({
        problemId,
        normalizedSummary: 'regenerated after the event',
        keywords: ['regenerated'],
        structuralFeatures: {
          schema_version: '1',
          problem_domain: null,
          symptom_patterns: [],
          suspected_boundaries: [],
          occurrence_conditions: [],
          successful_directions: [],
          dead_end_directions: [],
          environment_facts: [],
        },
        summaryGeneratorId: 'fixture-summary-generator',
        summaryGeneratorVersion: '1',
        semantic: {
          embedding: [0, 1, 0],
          embeddingModel: 'fixture-model',
          embeddingModelVersion: '1',
        },
        sourceFingerprint: `retrieval-source-v1:${randomUUID().replace(/-/g, '')}`,
        generatedAt: new Date('2026-08-17T10:00:00.000Z'),
      });

      // The same write, sent again: the original comes back, the payload is
      // not applied, and the current rendering survives — a retry is not a
      // second change to the record.
      const replayed = await memory.appendEvent({
        problemId,
        eventType: 'ATTEMPT',
        summary: 'a different payload on the retry',
        clientEventId,
      });
      expect(replayed.eventId).toBe(first.eventId);
      expect(replayed.summary).toBe('the first write');
      await kept(problemId);
    });
  });

  describe('the Verification append', () => {
    it('takes the artifact when a fresh Verification lands', async () => {
      const problemId = await seeded();
      await memory.appendVerification({
        problemId,
        verificationType: 'TEST',
        result: true,
        summary: 'the suite passed',
        clientEventId: randomUUID() as ClientEventId,
      });
      await gone(problemId);
    });

    it('does not take it again on an idempotent replay', async () => {
      const problemId = await seeded();
      const clientEventId = randomUUID() as ClientEventId;
      const first = await memory.appendVerification({
        problemId,
        verificationType: 'TEST',
        result: true,
        summary: 'the first check',
        clientEventId,
      });
      await gone(problemId);

      await artifacts.upsertArtifact({
        problemId,
        normalizedSummary: 'regenerated after the verification',
        keywords: ['regenerated'],
        structuralFeatures: {
          schema_version: '1',
          problem_domain: null,
          symptom_patterns: [],
          suspected_boundaries: [],
          occurrence_conditions: [],
          successful_directions: [],
          dead_end_directions: [],
          environment_facts: [],
        },
        summaryGeneratorId: 'fixture-summary-generator',
        summaryGeneratorVersion: '1',
        semantic: {
          embedding: [0, 0, 1],
          embeddingModel: 'fixture-model',
          embeddingModelVersion: '1',
        },
        sourceFingerprint: `retrieval-source-v1:${randomUUID().replace(/-/g, '')}`,
        generatedAt: new Date('2026-08-17T10:30:00.000Z'),
      });

      const replayed = await memory.appendVerification({
        problemId,
        verificationType: 'TEST',
        result: false,
        summary: 'a different payload on the retry',
        clientEventId,
      });
      expect(replayed.verificationId).toBe(first.verificationId);
      expect(replayed.result).toBe(true);
      await kept(problemId);
    });
  });

  describe('the close', () => {
    it('takes the artifact with the conclusion', async () => {
      const problemId = await seeded();
      // A close needs a path to a conclusion; CLOSED_UNRESOLVED needs no
      // evidence and closes from INVESTIGATING directly.
      const service = createProblemCloseService();
      await service.closeProblem(context, problemId, {
        expectedVersion: await versionOf(problemId),
        targetStatus: 'CLOSED_UNRESOLVED',
        changedBy: 'fixture',
        unresolvedPoints: 'never established',
      });
      await gone(problemId);
    });

    it('takes the artifact even when the close writes no review events', async () => {
      // A close with no summaries appends nothing, so the conclusion update
      // is the only canonical write in the transaction — and must invalidate
      // on its own rather than lean on the review events doing it. A mutation
      // that removed the conclusion's delete survived the richer close test
      // for exactly that reason; this case is what kills it.
      const problemId = await seeded();
      const service = createProblemCloseService();
      await service.closeProblem(context, problemId, {
        expectedVersion: await versionOf(problemId),
        targetStatus: 'CLOSED_UNRESOLVED',
        changedBy: 'fixture',
      });
      await gone(problemId);
    });

    it('leaves the artifact when the close rolls back', async () => {
      const problemId = await seeded();
      const service = createProblemCloseService();
      await expect(
        service.closeProblem(context, problemId, {
          expectedVersion: 999,
          targetStatus: 'CLOSED_UNRESOLVED',
          changedBy: 'fixture',
          unresolvedPoints: 'never established',
        }),
      ).rejects.toThrow();
      // The version conflict threw inside the transaction, so the review
      // events, the conclusion and the invalidation all rolled back as one.
      await kept(problemId);
    });
  });

  describe('writes that are not canonical at all', () => {
    it('leave the artifact alone', async () => {
      const problemId = await seeded();
      const control = createMemoryControlService();

      await control.updateControls(context, problemId, {
        expectedVersion: await versionOf(problemId),
        changedBy: 'fixture',
        suppressed: true,
      });
      await control.updateControls(context, problemId, {
        expectedVersion: await versionOf(problemId),
        changedBy: 'fixture',
        invalidate: true,
      });
      // Suppression and freshness invalidation are judgements about the
      // Memory, read live by ranking. The record itself did not move, so its
      // rendering did not either.
      await kept(problemId);
    });
  });

  describe('the delete path', () => {
    it('still takes the artifact with everything else', async () => {
      const problemId = await seeded();
      const remover = createProblemDeleteService();
      await remover.delete(context, {
        problemId,
        expectedVersion: await versionOf(problemId),
      });

      const rows = await pool.query(
        `select 1 from public.retrieval_artifacts where owner_id = $1 and problem_id = $2`,
        [ownerId, problemId],
      );
      expect(rows.rows).toHaveLength(0);
    });
  });

  describe('the services ring the maintenance doorbell', () => {
    /** A recording maintenance double; `broken` throws to prove containment. */
    function doorbell(broken = false) {
      const requested: ProblemId[] = [];
      return {
        requested,
        maintenance: {
          requestGeneration(_context: AuthenticatedRequestContext, problemId: ProblemId): void {
            requested.push(problemId);
            if (broken) {
              throw new Error('the scheduler is on fire');
            }
          },
        },
      };
    }

    it('rings after every canonical write, and only those', async () => {
      const bell = doorbell();
      const events = createEventService(bell.maintenance);
      const verifications = createVerificationService(bell.maintenance);
      const problems = createProblemService(bell.maintenance);
      const status = createProblemStatusService(bell.maintenance);

      const problemId = await seeded();
      await events.appendEvent(context, problemId, {
        eventType: 'ATTEMPT',
        summary: 'tried something',
        clientEventId: randomUUID(),
      });
      await verifications.appendVerification(context, problemId, {
        verificationType: 'TEST',
        result: true,
        summary: 'checked something',
        clientEventId: randomUUID(),
      });
      await problems.updateProblem(context, problemId, {
        expectedVersion: await versionOf(problemId),
        changedBy: 'fixture',
        title: 'a canonical edit',
      });
      await status.transition(context, problemId, {
        targetStatus: 'FIX_CANDIDATE',
        expectedVersion: await versionOf(problemId),
        changedBy: 'fixture',
      });
      expect(bell.requested).toEqual([problemId, problemId, problemId, problemId]);

      // A metadata patch invalidated nothing, so there is nothing to ask for.
      await problems.updateProblem(context, problemId, {
        expectedVersion: await versionOf(problemId),
        changedBy: 'fixture',
        confidence: 'HIGH',
      });
      expect(bell.requested).toHaveLength(4);
    });

    it('rings for a newly created Problem', async () => {
      const bell = doorbell();
      const problems = createProblemService(bell.maintenance);
      const project = await memory.createProject({ projectName: `project ${randomUUID()}` });
      const environment = await memory.createEnvironment({
        projectId: project.projectId,
        snapshot: { runtime: 'node 22.12.0' },
      });

      const created = await problems.createProblem(context, project.projectId, {
        environmentId: environment.environmentId,
        title: 'a brand new problem',
        symptoms: 'fresh symptoms',
      });

      expect(bell.requested).toEqual([created.problemId]);
    });

    it('rings after the close commits', async () => {
      const bell = doorbell();
      const close = createProblemCloseService(bell.maintenance);
      const problemId = await seeded();

      await close.closeProblem(context, problemId, {
        expectedVersion: await versionOf(problemId),
        targetStatus: 'CLOSED_UNRESOLVED',
        changedBy: 'fixture',
        unresolvedPoints: 'never established',
      });
      expect(bell.requested).toEqual([problemId]);
    });

    it('does not ring for a write that failed', async () => {
      const bell = doorbell();
      const status = createProblemStatusService(bell.maintenance);
      const problemId = await seeded();

      await expect(
        status.transition(context, problemId, {
          targetStatus: 'FIX_CANDIDATE',
          expectedVersion: 999,
          changedBy: 'fixture',
        }),
      ).rejects.toThrow();
      expect(bell.requested).toHaveLength(0);
    });

    it('cannot fail the write, whatever the scheduler does', async () => {
      const bell = doorbell(true);
      const events = createEventService(bell.maintenance);
      const problemId = await seeded();

      const appended = await events.appendEvent(context, problemId, {
        eventType: 'ATTEMPT',
        summary: 'the doorbell is broken and this still works',
        clientEventId: randomUUID(),
      });
      expect(appended.summary).toBe('the doorbell is broken and this still works');
      expect(bell.requested).toHaveLength(1);
    });
  });
});
