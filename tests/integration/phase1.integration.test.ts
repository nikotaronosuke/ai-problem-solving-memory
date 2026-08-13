/**
 * The Phase 1 scenario, end to end.
 *
 * One problem is investigated from first suspicion to confirmed fix, and every
 * step of the normal path goes through `MemoryRepository`. What this proves is
 * not that any single table works — the entity suites already cover that — but
 * that the whole foundation holds together as one flow, from a clean database.
 *
 * Raw SQL appears only where a repository call cannot reach: probing the
 * database's own constraints, and cleaning up afterwards. Those live in clearly
 * marked helpers at the bottom of the file and are never part of the story.
 *
 * The fixture is self-contained. It generates its own owner every run, never
 * touches the developer's owner or anything a previous run left behind, and
 * removes only what it created. It does not assume the database is empty.
 *
 * Skipped when `DATABASE_URL` is not set.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readDatabaseUrl } from '../../src/config/env.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import { generateClientEventId, type ClientEventId } from '../../src/domain/client-event-id.js';
import { generateOwnerId, type OwnerId } from '../../src/domain/owner.js';
import { generateProblemId, type ProblemId } from '../../src/domain/problem.js';
import { MEMORY_OWNER_ID_VAR, resolveOwnerContext } from '../../src/owner/context.js';
import {
  createMemoryRepository,
  DuplicateClientEventIdError,
  ProblemNotAvailableError,
  type MemoryRepository,
} from '../../src/repository/index.js';

const databaseUrl = readDatabaseUrl();

/**
 * The investigation this scenario tells.
 *
 * A plausible sequence rather than placeholder text: a hypothesis, the check
 * that followed it, a direction that turned out not to be the cause, and the
 * change that actually worked. Dead ends are recorded because knowing which
 * direction failed is half of what makes the memory reusable.
 */
const STORY = {
  hypothesis: {
    summary: 'Sign-in callback may not match the redirect the provider has registered',
    reason: 'The failure only appears after deployment, where the host differs',
  },
  attempt: {
    summary: 'Compared the deployed callback path against the registered redirect',
    result: 'They differ in the trailing path segment',
  },
  deadEnd: {
    summary: 'Changing the application route alone did not resolve the mismatch',
    reason: 'The provider still redirects to the value registered on its side',
    result: 'Sign-in still fails after deployment',
  },
  fix: {
    summary: 'Aligned the registered redirect URI with the actual callback path',
    result: 'Sign-in completes on the deployed environment',
  },
} as const;

describe.skipIf(databaseUrl === undefined)('Phase 1 scenario', () => {
  let pool: DatabasePool;
  const ownersCreated: OwnerId[] = [];

  /** Step 1: establish an owner and a repository scoped to it. */
  async function establishOwner(): Promise<MemoryRepository> {
    const ownerId = generateOwnerId();
    await insertOwnerIfAbsent(pool, ownerId);
    ownersCreated.push(ownerId);

    const context = await resolveOwnerContext(pool, { [MEMORY_OWNER_ID_VAR]: ownerId });
    return createMemoryRepository(pool, context);
  }

  beforeAll(() => {
    pool = createPool(resolveDatabaseConfig({ nodeEnv: 'test', connectionTimeoutMillis: 5_000 }));
  });

  afterAll(async () => {
    await cleanUpOwners(pool, ownersCreated);
    await closePool(pool);
  });

  it('carries one problem from first suspicion to confirmed fix', async () => {
    // ---- 1. owner context -------------------------------------------------
    const repository = await establishOwner();
    expect(repository.ownerId).toBeDefined();

    // ---- 2. project -------------------------------------------------------
    const project = await repository.createProject({
      projectName: 'checkout-web',
      repo: 'example/checkout-web',
      platform: 'web',
    });

    const rereadProject = await repository.getProject(project.projectId);
    expect(rereadProject).toBeDefined();
    expect(rereadProject?.ownerId).toBe(repository.ownerId);
    expect(rereadProject?.projectName).toBe('checkout-web');
    expect(rereadProject?.repo).toBe('example/checkout-web');
    expect(rereadProject?.platform).toBe('web');

    // ---- 3. environment ---------------------------------------------------
    // The conditions relevant to this problem, not an inventory of the machine.
    const snapshot = {
      runtime: 'node 22.12.0',
      framework: 'next 15.1',
      deployment: 'preview',
      branch: 'release/1.4',
      commit: 'a1b2c3d',
    };
    const environment = await repository.createEnvironment({
      projectId: project.projectId,
      snapshot,
    });

    const rereadEnvironment = await repository.getEnvironment(environment.environmentId);
    expect(rereadEnvironment?.projectId).toBe(project.projectId);
    expect(rereadEnvironment?.snapshot).toEqual(snapshot);

    // ---- 4. problem -------------------------------------------------------
    const problem = await repository.createProblem({
      projectId: project.projectId,
      environmentId: environment.environmentId,
      title: 'Sign-in fails after deploying to preview',
      symptoms: 'Sign-in works locally. On preview the provider returns to an error page.',
      problemDomain: 'auth',
      suspectedBoundary: 'application / identity provider boundary',
      sourceAi: 'claude-code',
    });

    expect(problem.projectId).toBe(project.projectId);
    expect(problem.environmentId).toBe(environment.environmentId);
    expect(problem.title).toBe('Sign-in fails after deploying to preview');
    expect(problem.symptoms).toContain('Sign-in works locally');
    // A new problem is under investigation, unverified and untrusted.
    expect(problem.status).toBe('INVESTIGATING');
    expect(problem.fixKind).toBeNull();
    expect(problem.importance).toBe(false);
    expect(problem.confidence).toBe('LOW');
    expect(problem.freshness).toBe('CURRENT');
    expect(problem.memoryReadEnabled).toBe(true);
    expect(problem.memoryWriteEnabled).toBe(true);
    expect(problem.suppressed).toBe(false);
    expect(problem.version).toBe(1);

    // ---- 5-8. the investigation ------------------------------------------
    const clientEventIds: ClientEventId[] = [];

    async function record(
      eventType: 'HYPOTHESIS' | 'ATTEMPT' | 'DEAD_END' | 'FIX',
      fields: { summary: string; result?: string; reason?: string },
    ) {
      const clientEventId = generateClientEventId();
      clientEventIds.push(clientEventId);

      return repository.appendEvent({
        problemId: problem.problemId,
        eventType,
        sourceAi: 'claude-code',
        clientEventId,
        ...fields,
      });
    }

    await record('HYPOTHESIS', STORY.hypothesis);
    await record('ATTEMPT', STORY.attempt);
    await record('DEAD_END', STORY.deadEnd);
    await record('FIX', STORY.fix);

    const events = await repository.listEvents(problem.problemId);

    expect(events).toHaveLength(4);
    expect(events.map((event) => event.eventType)).toEqual([
      'HYPOTHESIS',
      'ATTEMPT',
      'DEAD_END',
      'FIX',
    ]);
    expect(events.map((event) => event.summary)).toEqual([
      STORY.hypothesis.summary,
      STORY.attempt.summary,
      STORY.deadEnd.summary,
      STORY.fix.summary,
    ]);
    expect(events.every((event) => event.problemId === problem.problemId)).toBe(true);
    expect(events.every((event) => event.ownerId === repository.ownerId)).toBe(true);
    expect(events.map((event) => event.clientEventId)).toEqual(clientEventIds);
    // The dead end kept both why it was tried and what came of it.
    expect(events[2]?.reason).toBe(STORY.deadEnd.reason);
    expect(events[2]?.result).toBe(STORY.deadEnd.result);
    expect(events[3]?.result).toBe(STORY.fix.result);

    // ---- 9. verification --------------------------------------------------
    // Separate from the FIX event: applying a change and confirming it worked
    // are different claims.
    const verification = await repository.appendVerification({
      problemId: problem.problemId,
      verificationType: 'TEST',
      result: true,
      summary: 'Sign-in end-to-end test passes against the preview deployment',
      verifiedBy: 'vitest',
      evidenceRef: 'tests/e2e/sign-in.test.ts > completes on preview',
      clientEventId: generateClientEventId(),
    });

    expect(verification.problemId).toBe(problem.problemId);
    expect(verification.result).toBe(true);
    expect(verification).not.toHaveProperty('eventId');

    // ---- 10. re-read everything from the database -------------------------
    // Not the objects returned above — what the database actually holds.
    const storedProblem = await repository.getProblem(problem.problemId);
    const storedEvents = await repository.listEvents(problem.problemId);
    const storedVerifications = await repository.listVerifications(problem.problemId);

    expect(storedProblem).toEqual(problem);
    expect(storedProblem?.ownerId).toBe(repository.ownerId);
    expect(storedProblem?.createdAt).toBeInstanceOf(Date);
    expect(storedProblem?.updatedAt).toBeInstanceOf(Date);

    expect(storedEvents).toEqual(events);
    expect(storedEvents.every((event) => event.createdAt instanceof Date)).toBe(true);

    expect(storedVerifications).toHaveLength(1);
    expect(storedVerifications[0]).toEqual(verification);
    expect(storedVerifications[0]?.ownerId).toBe(repository.ownerId);
    expect(storedVerifications[0]?.createdAt).toBeInstanceOf(Date);

    // Recording successful evidence does not decide the problem is solved.
    // That judgement belongs to P2-06, after checking the evidence exists.
    expect(storedProblem?.status).toBe('INVESTIGATING');
    expect(storedProblem?.version).toBe(1);
  });

  describe('what must not be possible', () => {
    let owner: MemoryRepository;
    let other: MemoryRepository;
    let problemId: ProblemId;
    let usedClientEventId: ClientEventId;

    beforeAll(async () => {
      owner = await establishOwner();
      other = await establishOwner();

      const project = await owner.createProject({ projectName: 'negative-fixture' });
      const environment = await owner.createEnvironment({
        projectId: project.projectId,
        snapshot: { runtime: 'node 22.12.0' },
      });
      const problem = await owner.createProblem({
        projectId: project.projectId,
        environmentId: environment.environmentId,
        title: 'Fixture problem',
        symptoms: 'Fixture symptoms',
      });
      problemId = problem.problemId;

      usedClientEventId = generateClientEventId();
      await owner.appendEvent({
        problemId,
        eventType: 'HYPOTHESIS',
        summary: 'Fixture hypothesis',
        clientEventId: usedClientEventId,
      });
    });

    it('reading another owner’s records', async () => {
      const project = await owner.createProject({ projectName: 'private' });
      const environment = await owner.createEnvironment({
        projectId: project.projectId,
        snapshot: {},
      });

      expect(await other.getProject(project.projectId)).toBeUndefined();
      expect(await other.getEnvironment(environment.environmentId)).toBeUndefined();
      expect(await other.getProblem(problemId)).toBeUndefined();
      expect(await other.listEvents(problemId)).toEqual([]);
      expect(await other.listVerifications(problemId)).toEqual([]);
    });

    it('appending to another owner’s problem', async () => {
      await expect(
        other.appendEvent({
          problemId,
          eventType: 'ATTEMPT',
          summary: 'Should not land',
          clientEventId: generateClientEventId(),
        }),
      ).rejects.toThrow(ProblemNotAvailableError);

      await expect(
        other.appendVerification({
          problemId,
          verificationType: 'TEST',
          result: true,
          summary: 'Should not land',
          clientEventId: generateClientEventId(),
        }),
      ).rejects.toThrow(ProblemNotAvailableError);

      // A problem that does not exist gives the same answer, so the outcome
      // cannot be used to learn that someone else's id is real.
      await expect(
        other.appendEvent({
          problemId: generateProblemId(),
          eventType: 'ATTEMPT',
          summary: 'Should not land',
          clientEventId: generateClientEventId(),
        }),
      ).rejects.toThrow(ProblemNotAvailableError);
    });

    it('replaying a client event id', async () => {
      const before = await owner.listEvents(problemId);
      const original = before.find((event) => event.clientEventId === usedClientEventId);

      const retry = await owner.appendEvent({
        problemId,
        eventType: 'HYPOTHESIS',
        summary: 'The same write, sent again',
        clientEventId: usedClientEventId,
      });

      // Since P2-04 this returns the original rather than failing, and the
      // retry's payload is not applied. Nothing new was written either way.
      expect(retry).toEqual(original);
      expect(retry.summary).toBe('Fixture hypothesis');
      expect(await owner.listEvents(problemId)).toHaveLength(before.length);
    });

    it('replaying a verification client event id', async () => {
      const clientEventId = generateClientEventId();
      await owner.appendVerification({
        problemId,
        verificationType: 'TEST',
        result: true,
        summary: 'Checked once',
        clientEventId,
      });
      const before = await owner.listVerifications(problemId);

      await expect(
        owner.appendVerification({
          problemId,
          verificationType: 'TEST',
          result: true,
          summary: 'The same write, sent again',
          clientEventId,
        }),
      ).rejects.toThrow(DuplicateClientEventIdError);

      // Verifications still refuse; their replay is P2-05. Events and
      // Verifications behaving differently is deliberate, not a gap.
      expect(await owner.listVerifications(problemId)).toHaveLength(before.length);
    });

    it('storing an event type outside the shared value set', async () => {
      // Unreachable through the repository — the type system rejects it — so
      // this probes the database's own defence directly.
      await expect(probeInvalidEventType(pool, owner.ownerId, problemId)).rejects.toThrow(
        /event_type_allowed_values/,
      );
    });

    it('storing an event against a problem that does not exist', async () => {
      await expect(probeMissingProblemForeignKey(pool, owner.ownerId)).rejects.toThrow(
        /violates foreign key constraint/,
      );
    });
  });
});

// --------------------------------------------------------------------------
// Test-only database access.
//
// Everything below reaches past the repository on purpose: to check a
// constraint the repository cannot express, or to clear up afterwards. None of
// it belongs to the scenario.
// --------------------------------------------------------------------------

/** Inserts an event whose type no domain value allows. */
async function probeInvalidEventType(
  pool: DatabasePool,
  ownerId: OwnerId,
  problemId: ProblemId,
): Promise<unknown> {
  return pool.query(
    `insert into public.events (event_id, owner_id, problem_id, event_type, summary,
                                client_event_id)
          values ($1, $2, $3, 'RETROSPECTIVE', 'Not a real event type', $4)`,
    [generateProblemId(), ownerId, problemId, generateClientEventId()],
  );
}

/** Inserts an event for a real owner but a problem that was never created. */
async function probeMissingProblemForeignKey(
  pool: DatabasePool,
  ownerId: OwnerId,
): Promise<unknown> {
  return pool.query(
    `insert into public.events (event_id, owner_id, problem_id, event_type, summary,
                                client_event_id)
          values ($1, $2, $3, 'ATTEMPT', 'Orphan', $4)`,
    [generateProblemId(), ownerId, generateProblemId(), generateClientEventId()],
  );
}

/**
 * Removes only what this file created, leaves to root.
 *
 * That order is the delete policy: every foreign key restricts, so a parent
 * cannot go before its children.
 */
async function cleanUpOwners(pool: DatabasePool, ownerIds: readonly OwnerId[]): Promise<void> {
  if (ownerIds.length === 0) {
    return;
  }

  for (const table of [
    'verifications',
    'events',
    'problems',
    'environments',
    'projects',
    'owners',
  ]) {
    await pool.query(`delete from public.${table} where owner_id = any($1::uuid[])`, [ownerIds]);
  }
}
