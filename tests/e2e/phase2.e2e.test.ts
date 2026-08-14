/**
 * Phase 2, end to end.
 *
 * One investigation is carried from first suspicion to a verified fix, and
 * then used as memory by a second, unrelated investigation. Every step is an
 * HTTP request against the real application, through Fastify's validation,
 * the real services, an owner-scoped repository and PostgreSQL. Nothing is
 * substituted.
 *
 * What this proves is not that any endpoint works — each has its own suite,
 * and repeating them here would only make the file longer. It is that the
 * pieces compose: that the id one call returns is the id the next one
 * accepts, that a version handed back is the version the next write must
 * present, and that state written in one step is still there, unchanged and
 * readable, several steps later. That continuity is the only thing a
 * per-endpoint test cannot check.
 *
 * The story is deliberately ordinary. A sign-in callback that only fails
 * after deployment, investigated, fixed and verified; then the same shape of
 * problem in a different project, which draws on the first. If the record is
 * worth keeping, this is the shape of the thing it has to hold.
 *
 * The fixture is self-contained. It generates its own owners every run, never
 * touches the developer's owner or anything a previous run left, and removes
 * only what it created. It does not assume the database is empty. Raw SQL
 * appears only in owner setup and teardown, at the bottom of the file, and is
 * never part of the story.
 *
 * Skipped when `DATABASE_URL` is not set.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import {
  createChangeLogService,
  createEventService,
  createHealthService,
  createMemoryControlService,
  createProblemCloseService,
  createProblemDeleteService,
  createProblemService,
  createProblemStatusService,
  createProjectEnvironmentService,
  createRelationService,
  createUsageLogService,
  createVerificationService,
} from '../../src/app/index.js';
import { createFixedRequestContextService } from '../support/request-context.js';
import { readDatabaseUrl } from '../../src/config/env.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import { generateClientEventId } from '../../src/domain/client-event-id.js';
import { generateOwnerId, type OwnerId } from '../../src/domain/owner.js';
import { generateProblemId } from '../../src/domain/problem.js';
import { buildMemoryHttpApp } from '../../src/http/index.js';

const databaseUrl = readDatabaseUrl();

/** Who is recorded as making every deliberate change in this scenario. */
const ACTOR = 'phase2-e2e';

/**
 * The investigation, written out first so the steps read as one account
 * rather than as five unrelated strings.
 *
 * The dead end is here for the same reason it is in the product: knowing
 * which direction did not work is half of what makes the memory reusable.
 */
const STORY = {
  hypothesis: {
    summary: 'Sign-in may be failing because the deployed callback differs from the registered one',
    reason: 'It works locally and only fails once deployed, where the host changes',
  },
  attempt: {
    summary: 'Compared the deployed callback URL against the redirect registered with the provider',
    result: 'They differ: the registered redirect still names the previous deployment host',
  },
  deadEnd: {
    summary: 'Changing the application route alone did not help',
    reason: 'The provider redirects to the value registered on its side, whatever the app expects',
    result: 'Sign-in still fails after deploying',
  },
  discovery: {
    summary: 'The redirect registered with the provider was never updated after the host changed',
    evidenceRef: 'provider console, OAuth application settings',
  },
  fix: {
    summary: 'Updated the registered redirect to the deployed callback URL',
    result: 'Sign-in completes on the deployed environment',
    evidenceRef: 'provider console, change recorded in the deployment log',
  },
  verification: {
    summary: 'Signed in on the deployed environment and reached the authenticated page',
    evidenceRef: 'end-to-end suite, auth spec',
  },
} as const;

/** State the story carries forward. Written by the steps, in order. */
interface Carried {
  projectA?: string;
  environmentA?: string;
  problemA?: string;
  projectB?: string;
  environmentB?: string;
  problemB?: string;
  problemBVersion?: number;
}

interface Actor {
  readonly app: FastifyInstance;
  readonly ownerId: OwnerId;
}

describe.skipIf(databaseUrl === undefined)('Phase 2, end to end', () => {
  let pool: DatabasePool;
  let ownerA: Actor;
  let ownerB: Actor;
  const ownersCreated: OwnerId[] = [];
  const appsCreated: FastifyInstance[] = [];
  const carried: Carried = {};

  // ---- fixture ------------------------------------------------------------

  async function makeActor(): Promise<Actor> {
    const ownerId = generateOwnerId();
    await insertOwnerIfAbsent(pool, ownerId);
    ownersCreated.push(ownerId);

    // The real application, composed exactly as `src/index.ts` composes it.
    // The only substitution is where the owner comes from, which is the one
    // thing a test must control to be self-contained.
    const app = buildMemoryHttpApp({
      healthService: createHealthService(pool),
      requestContextService: createFixedRequestContextService(pool, ownerId),
      projectEnvironmentService: createProjectEnvironmentService(),
      problemService: createProblemService(),
      problemStatusService: createProblemStatusService(),
      eventService: createEventService(),
      verificationService: createVerificationService(),
      relationService: createRelationService(),
      usageLogService: createUsageLogService(),
      changeLogService: createChangeLogService(),
      memoryControlService: createMemoryControlService(),
      problemCloseService: createProblemCloseService(),
      problemDeleteService: createProblemDeleteService(),
      logger: false,
    });
    appsCreated.push(app);

    return { app, ownerId };
  }

  beforeAll(async () => {
    pool = createPool(resolveDatabaseConfig({ nodeEnv: 'test', connectionTimeoutMillis: 5_000 }));
    ownerA = await makeActor();
    ownerB = await makeActor();
  });

  afterAll(async () => {
    for (const app of appsCreated) {
      await app.close();
    }
    await cleanUpOwners(pool, ownersCreated);
    await closePool(pool);
  });

  // ---- HTTP helpers -------------------------------------------------------
  //
  // Thin on purpose. They pass a payload and hand back a parsed body; they do
  // not decide anything, so the story stays visible in the steps themselves.

  async function send<T>(
    actor: Actor,
    method: 'GET' | 'PATCH' | 'POST',
    url: string,
    payload?: unknown,
    expectedStatus = 200,
  ): Promise<T> {
    const response = await actor.app.inject({
      method,
      url,
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    expect(response.statusCode, `${method} ${url} -> ${response.body}`).toBe(expectedStatus);
    return response.json<T>();
  }

  function get<T>(actor: Actor, url: string): Promise<T> {
    return send<T>(actor, 'GET', url);
  }

  interface ProblemBody {
    problem_id: string;
    status: string;
    fix_kind: string | null;
    confidence: string;
    freshness: string;
    importance: boolean;
    memory_read_enabled: boolean;
    memory_write_enabled: boolean;
    suppressed: boolean;
    version: number;
    title: string;
    project_id: string;
    environment_id: string;
    owner_id: string;
  }

  interface EventBody {
    event_id: string;
    event_type: string;
    summary: string;
    result: string | null;
    reason: string | null;
    evidence_ref: string | null;
    client_event_id: string;
    created_at: string;
  }

  interface VerificationBody {
    verification_id: string;
    result: boolean;
    summary: string;
    verification_type: string;
  }

  interface RelationBody {
    relation_id: string;
    from_id: string;
    to_id: string;
    relation_type: string;
    reason: string;
  }

  interface UsageLogBody {
    usage_log_id: string;
    problem_id: string;
    memory_id: string;
    action: string;
    source_ai: string;
    reason: string;
    result: string | null;
  }

  interface ChangeLogBody {
    changed_by: string;
    from_version: number;
    to_version: number;
    changes: Record<string, { kind: string; before?: unknown; after?: unknown }>;
  }

  const readProblem = (actor: Actor, id: string): Promise<ProblemBody> =>
    get<ProblemBody>(actor, `/v1/problems/${id}`);

  const readEvents = async (actor: Actor, id: string): Promise<EventBody[]> =>
    (await get<{ events: EventBody[] }>(actor, `/v1/problems/${id}/events`)).events;

  const readVerifications = async (actor: Actor, id: string): Promise<VerificationBody[]> =>
    (await get<{ verifications: VerificationBody[] }>(actor, `/v1/problems/${id}/verifications`))
      .verifications;

  const readRelations = async (actor: Actor, id: string): Promise<RelationBody[]> =>
    (await get<{ relations: RelationBody[] }>(actor, `/v1/problems/${id}/relations`)).relations;

  const readUsageLogs = async (actor: Actor, id: string): Promise<UsageLogBody[]> =>
    (await get<{ usage_logs: UsageLogBody[] }>(actor, `/v1/problems/${id}/usage-logs`)).usage_logs;

  const readChangeLogs = async (actor: Actor, id: string): Promise<ChangeLogBody[]> =>
    (await get<{ change_logs: ChangeLogBody[] }>(actor, `/v1/problems/${id}/change-logs`))
      .change_logs;

  /**
   * A problem at INVESTIGATING, version 1, in its own project.
   *
   * Used by the negative cases so each starts from a clean state that no
   * other case can have disturbed. The primary flow builds its own, step by
   * step, because how it gets there is part of what is being tested.
   */
  async function freshProblem(actor: Actor): Promise<string> {
    const project = await send<{ project_id: string }>(
      actor,
      'POST',
      '/v1/projects',
      { project_name: 'negative-case-fixture' },
      201,
    );
    const environment = await send<{ environment_id: string }>(
      actor,
      'POST',
      `/v1/projects/${project.project_id}/environments`,
      { snapshot: { runtime: 'node 22.12.0' } },
      201,
    );
    const problem = await send<ProblemBody>(
      actor,
      'POST',
      `/v1/projects/${project.project_id}/problems`,
      {
        environment_id: environment.environment_id,
        title: 'Fixture problem',
        symptoms: 'Recorded so a negative case has somewhere to act.',
      },
      201,
    );
    return problem.problem_id;
  }

  // ---- the story ----------------------------------------------------------
  //
  // Ordered. Each step uses what the previous one returned, and nothing is
  // hard-coded between them.

  describe('an investigation, and the memory it becomes', () => {
    it('1. finds the service serving and the contract published', async () => {
      const health = await get<{ status: string }>(ownerA, '/health');
      expect(health).toEqual({ status: 'ok' });

      // The contract is public, so it is reachable before anything is owned.
      const contract = await get<{
        openapi: string;
        paths: Record<string, Record<string, { operationId?: string }>>;
      }>(ownerA, '/openapi.json');
      expect(contract.openapi).toBe('3.1.0');

      // Only that the operations this scenario is about to use are published.
      // What the document says about each of them is `openapi.test.ts`'s job.
      const published = new Set(
        Object.values(contract.paths).flatMap((item) =>
          Object.values(item).map((operation) => operation.operationId),
        ),
      );
      for (const operation of [
        'createProblem',
        'appendEvent',
        'appendVerification',
        'transitionProblemStatus',
        'closeProblem',
        'createRelation',
        'createUsageLog',
        'updateMemoryControl',
        'updateProblem',
        'listChangeLogs',
      ]) {
        expect(published, operation).toContain(operation);
      }
    });

    it('2. acts as one owner, established server-side', async () => {
      const me = await get<{ owner_id: string }>(ownerA, '/v1/me');

      // The owner is not something the caller supplied; it is what the
      // request context resolved.
      expect(me).toEqual({ owner_id: ownerA.ownerId });
    });

    it('3. records the project and the conditions the problem appeared under', async () => {
      const project = await send<{ project_id: string; project_name: string }>(
        ownerA,
        'POST',
        '/v1/projects',
        { project_name: 'storefront-web', repo: 'example/storefront-web', platform: 'web' },
        201,
      );
      carried.projectA = project.project_id;

      const environment = await send<{ environment_id: string; project_id: string }>(
        ownerA,
        'POST',
        `/v1/projects/${project.project_id}/environments`,
        {
          // The conditions this problem actually depends on, not an inventory
          // of the machine.
          snapshot: {
            runtime: 'node 22.12.0',
            framework: 'next 15.1',
            deployment: 'preview',
            auth_provider: 'oauth2',
          },
        },
        201,
      );
      carried.environmentA = environment.environment_id;

      // The environment belongs to the project it was created under: one
      // source for the id, so the two cannot disagree.
      expect(environment.project_id).toBe(project.project_id);
    });

    it('4. starts the problem, and does not get to declare its state', async () => {
      const problem = await send<ProblemBody>(
        ownerA,
        'POST',
        `/v1/projects/${carried.projectA}/problems`,
        {
          environment_id: carried.environmentA,
          title: 'Sign-in fails after deploying',
          symptoms:
            'Sign-in works locally. On the preview deployment the callback returns an error.',
          problem_domain: 'authentication',
          suspected_boundary: 'application / identity provider',
          source_ai: ACTOR,
        },
        201,
      );
      carried.problemA = problem.problem_id;

      // Everything about where a problem starts comes from the server.
      expect(problem).toMatchObject({
        status: 'INVESTIGATING',
        fix_kind: null,
        confidence: 'LOW',
        freshness: 'CURRENT',
        importance: false,
        memory_read_enabled: true,
        memory_write_enabled: true,
        suppressed: false,
        version: 1,
        project_id: carried.projectA,
        environment_id: carried.environmentA,
        owner_id: ownerA.ownerId,
      });
    });

    it('5. records the investigation as it happened', async () => {
      const appended = [];

      for (const [eventType, event] of [
        ['HYPOTHESIS', STORY.hypothesis],
        ['ATTEMPT', STORY.attempt],
        ['DEAD_END', STORY.deadEnd],
        ['DISCOVERY', STORY.discovery],
        ['FIX', STORY.fix],
      ] as const) {
        appended.push(
          await send<EventBody>(
            ownerA,
            'POST',
            `/v1/problems/${carried.problemA}/events`,
            {
              event_type: eventType,
              summary: event.summary,
              ...('result' in event ? { result: event.result } : {}),
              ...('reason' in event ? { reason: event.reason } : {}),
              ...('evidenceRef' in event ? { evidence_ref: event.evidenceRef } : {}),
              source_ai: ACTOR,
              // A key per event, minted before the first attempt.
              client_event_id: generateClientEventId(),
            },
            201,
          ),
        );
      }

      expect(new Set(appended.map((event) => event.client_event_id)).size).toBe(5);

      const stored = await readEvents(ownerA, carried.problemA ?? '');
      expect(stored.map((event) => event.event_type)).toEqual([
        'HYPOTHESIS',
        'ATTEMPT',
        'DEAD_END',
        'DISCOVERY',
        'FIX',
      ]);

      // Not just the types. What was written is what comes back, field for
      // field, several requests later.
      expect(stored[2]).toMatchObject({
        event_type: 'DEAD_END',
        summary: STORY.deadEnd.summary,
        reason: STORY.deadEnd.reason,
        result: STORY.deadEnd.result,
        // A dead end has nothing to point at; it is the absence of one.
        evidence_ref: null,
      });
      expect(stored[4]).toMatchObject({
        event_type: 'FIX',
        summary: STORY.fix.summary,
        result: STORY.fix.result,
        evidence_ref: STORY.fix.evidenceRef,
      });

      // Appending does not touch the problem: five events, still version 1.
      expect((await readProblem(ownerA, carried.problemA ?? '')).version).toBe(1);
    });

    it('6. proposes the change as a candidate fix', async () => {
      const problem = await send<ProblemBody>(
        ownerA,
        'POST',
        `/v1/problems/${carried.problemA}/status-transitions`,
        { target_status: 'FIX_CANDIDATE', expected_version: 1, changed_by: ACTOR },
      );

      expect(problem.status).toBe('FIX_CANDIDATE');
      expect(problem.version).toBe(2);

      // The move is history, written by the service in the same transaction.
      const history = await readChangeLogs(ownerA, carried.problemA ?? '');
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        changed_by: ACTOR,
        from_version: 1,
        to_version: 2,
        changes: {
          status: { kind: 'exact', before: 'INVESTIGATING', after: 'FIX_CANDIDATE' },
        },
      });

      // A FIX event and a candidate status are not evidence.
      expect(problem.status).not.toBe('VERIFIED');
    });

    it('7. checks the fix, without that alone concluding anything', async () => {
      const verification = await send<VerificationBody>(
        ownerA,
        'POST',
        `/v1/problems/${carried.problemA}/verifications`,
        {
          verification_type: 'TEST',
          result: true,
          summary: STORY.verification.summary,
          evidence_ref: STORY.verification.evidenceRef,
          verified_by: ACTOR,
          client_event_id: generateClientEventId(),
        },
        201,
      );
      expect(verification.result).toBe(true);

      // Recording a successful check does not move the problem. Concluding
      // is a separate, deliberate act.
      const problem = await readProblem(ownerA, carried.problemA ?? '');
      expect(problem.status).toBe('FIX_CANDIDATE');
      expect(problem.version).toBe(2);
    });

    it('8. concludes it verified, with the fix kind, in one act', async () => {
      const problem = await send<ProblemBody>(
        ownerA,
        'POST',
        `/v1/problems/${carried.problemA}/close`,
        {
          expected_version: 2,
          changed_by: ACTOR,
          target_status: 'VERIFIED',
          fix_kind: 'ROOT_FIX',
        },
      );

      expect(problem).toMatchObject({ status: 'VERIFIED', fix_kind: 'ROOT_FIX', version: 3 });

      // The evidence the conclusion rests on is still there, and is the
      // problem's own.
      const verifications = await readVerifications(ownerA, carried.problemA ?? '');
      expect(verifications.filter((verification) => verification.result)).toHaveLength(1);

      // Concluding says the fix holds. It does not raise confidence or
      // change how the record should be used.
      expect(problem).toMatchObject({
        confidence: 'LOW',
        freshness: 'CURRENT',
        memory_read_enabled: true,
        suppressed: false,
      });
    });

    it('9. starts a second investigation, in a different project', async () => {
      const project = await send<{ project_id: string }>(
        ownerA,
        'POST',
        '/v1/projects',
        { project_name: 'partner-portal-api', repo: 'example/partner-portal-api', platform: 'api' },
        201,
      );
      carried.projectB = project.project_id;

      const environment = await send<{ environment_id: string }>(
        ownerA,
        'POST',
        `/v1/projects/${project.project_id}/environments`,
        {
          // A different stack entirely. What connects the two problems is the
          // shape of the failure, not the technology.
          snapshot: {
            runtime: 'node 22.12.0',
            framework: 'fastify 5.11',
            deployment: 'staging',
            auth_provider: 'oidc',
          },
        },
        201,
      );
      carried.environmentB = environment.environment_id;

      const problem = await send<ProblemBody>(
        ownerA,
        'POST',
        `/v1/projects/${project.project_id}/problems`,
        {
          environment_id: environment.environment_id,
          title: 'Partner sign-in returns an error on staging',
          symptoms: 'The OIDC callback is rejected on staging but not in local development.',
          problem_domain: 'authentication',
          suspected_boundary: 'application / identity provider',
          source_ai: ACTOR,
        },
        201,
      );
      carried.problemB = problem.problem_id;
      carried.problemBVersion = problem.version;

      expect(problem).toMatchObject({ status: 'INVESTIGATING', version: 1 });
      expect(problem.project_id).not.toBe(carried.projectA);
    });

    it('10. links the new problem to the old one, across projects', async () => {
      const relation = await send<RelationBody>(
        ownerA,
        'POST',
        `/v1/problems/${carried.problemB}/relations`,
        {
          to_id: carried.problemA,
          relation_type: 'SIMILAR_TO',
          reason:
            'Same boundary: a callback registered with the provider drifting from the deployed one.',
        },
        201,
      );

      // The source is the path, the target the body. One direction, stored
      // once.
      expect(relation).toMatchObject({
        from_id: carried.problemB,
        to_id: carried.problemA,
        relation_type: 'SIMILAR_TO',
      });

      // Visible from both ends, and identical from either — a link recorded
      // as B similar to A says the same thing read from A.
      const fromB = await readRelations(ownerA, carried.problemB ?? '');
      const fromA = await readRelations(ownerA, carried.problemA ?? '');
      expect(fromB).toEqual([relation]);
      expect(fromA).toEqual([relation]);

      // A relation is a link, not a write. Neither problem moved.
      expect((await readProblem(ownerA, carried.problemA ?? '')).version).toBe(3);
      expect((await readProblem(ownerA, carried.problemB ?? '')).version).toBe(1);
    });

    it('11. records that the old problem was actually used', async () => {
      const usage = await send<UsageLogBody>(
        ownerA,
        'POST',
        `/v1/problems/${carried.problemB}/usage-logs`,
        {
          source_ai: ACTOR,
          action: 'ADOPTED',
          memory_id: carried.problemA,
          reason:
            'The earlier problem named the registered redirect as the cause; checked that first.',
          result: 'The registered redirect was stale here too.',
        },
        201,
      );

      // The distinction the record exists to make: which problem is being
      // worked on, and which past one was drawn on.
      expect(usage).toMatchObject({
        problem_id: carried.problemB,
        memory_id: carried.problemA,
        action: 'ADOPTED',
      });

      expect(await readUsageLogs(ownerA, carried.problemB ?? '')).toHaveLength(1);
      // Logging is explicit. Reading the memory did not record anything on it.
      expect(await readUsageLogs(ownerA, carried.problemA ?? '')).toEqual([]);

      // Using a memory changes nothing about either problem.
      expect((await readProblem(ownerA, carried.problemA ?? '')).version).toBe(3);
      expect((await readProblem(ownerA, carried.problemB ?? '')).version).toBe(1);
    });

    it('12. decides how the new problem should be used as memory', async () => {
      const problem = await send<ProblemBody>(
        ownerA,
        'PATCH',
        `/v1/problems/${carried.problemB}/memory-control`,
        { expected_version: 1, changed_by: ACTOR, memory_read_enabled: false },
      );

      expect(problem.version).toBe(2);
      expect(problem.memory_read_enabled).toBe(false);
      // One axis moved. The others are independent and stayed put.
      expect(problem).toMatchObject({
        memory_write_enabled: true,
        suppressed: false,
        freshness: 'CURRENT',
      });

      // Not authorisation: the owner can still read their own problem.
      expect((await readProblem(ownerA, carried.problemB ?? '')).memory_read_enabled).toBe(false);
      carried.problemBVersion = problem.version;
    });

    it('13. edits the problem, and the edit becomes history', async () => {
      const problem = await send<ProblemBody>(ownerA, 'PATCH', `/v1/problems/${carried.problemB}`, {
        expected_version: carried.problemBVersion,
        changed_by: ACTOR,
        importance: true,
      });

      expect(problem.version).toBe(3);
      expect(problem.importance).toBe(true);

      const history = await readChangeLogs(ownerA, carried.problemB ?? '');
      expect(history).toHaveLength(2);

      // The control change, then the edit — a chain, bracketed by versions.
      expect(history[0]).toMatchObject({
        from_version: 1,
        to_version: 2,
        changes: { memory_read_enabled: { kind: 'exact', before: true, after: false } },
      });
      expect(history[1]).toMatchObject({
        changed_by: ACTOR,
        from_version: 2,
        to_version: 3,
        changes: { importance: { kind: 'exact', before: false, after: true } },
      });
    });

    it('14. reads the whole thing back from the database', async () => {
      // Nothing here trusts a response from an earlier step. This is what is
      // actually stored, asked for again at the end.
      const problemA = await readProblem(ownerA, carried.problemA ?? '');
      expect(problemA).toMatchObject({
        status: 'VERIFIED',
        fix_kind: 'ROOT_FIX',
        version: 3,
        title: 'Sign-in fails after deploying',
      });

      const events = await readEvents(ownerA, carried.problemA ?? '');
      expect(events.map((event) => event.event_type)).toEqual([
        'HYPOTHESIS',
        'ATTEMPT',
        'DEAD_END',
        'DISCOVERY',
        'FIX',
      ]);
      expect(events[0]?.summary).toBe(STORY.hypothesis.summary);

      const verifications = await readVerifications(ownerA, carried.problemA ?? '');
      expect(verifications.filter((verification) => verification.result).length).toBeGreaterThan(0);

      const problemB = await readProblem(ownerA, carried.problemB ?? '');
      expect(problemB).toMatchObject({
        importance: true,
        memory_read_enabled: false,
        memory_write_enabled: true,
        suppressed: false,
        status: 'INVESTIGATING',
        version: 3,
      });

      const relations = await readRelations(ownerA, carried.problemB ?? '');
      expect(relations).toHaveLength(1);
      expect(relations[0]).toMatchObject({
        from_id: carried.problemB,
        to_id: carried.problemA,
        relation_type: 'SIMILAR_TO',
      });

      const usage = await readUsageLogs(ownerA, carried.problemB ?? '');
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({
        problem_id: carried.problemB,
        memory_id: carried.problemA,
        action: 'ADOPTED',
      });

      const history = await readChangeLogs(ownerA, carried.problemB ?? '');
      expect(history.map((entry) => entry.to_version)).toEqual([2, 3]);

      // The two problems are in different projects, which is the point of
      // keeping this record at all.
      expect(problemA.project_id).not.toBe(problemB.project_id);
    });
  });

  // ---- what must not work -------------------------------------------------

  describe('what the record refuses', () => {
    it('will not call a problem verified without a check of its own', async () => {
      const problem = await freshProblem(ownerA);
      await send(ownerA, 'POST', `/v1/problems/${problem}/status-transitions`, {
        target_status: 'FIX_CANDIDATE',
        expected_version: 1,
        changed_by: ACTOR,
      });

      // Everything a persuasive account can offer, and none of it evidence.
      await send(
        ownerA,
        'POST',
        `/v1/problems/${problem}/events`,
        {
          event_type: 'FIX',
          summary: 'Applied the change that should resolve it',
          result: 'Looks correct',
          source_ai: ACTOR,
          client_event_id: generateClientEventId(),
        },
        201,
      );

      const refused = await ownerA.app.inject({
        method: 'POST',
        url: `/v1/problems/${problem}/close`,
        payload: {
          expected_version: 2,
          changed_by: ACTOR,
          target_status: 'VERIFIED',
          fix_kind: 'ROOT_FIX',
          final_cause_summary: 'The registered redirect was stale.',
        },
      });

      expect(refused.statusCode).toBe(400);
      expect(refused.json<{ error: { code: string } }>().error.code).toBe('INVALID_REQUEST');

      const after = await readProblem(ownerA, problem);
      expect(after).toMatchObject({ status: 'FIX_CANDIDATE', fix_kind: null, version: 2 });
      // A refused change records nothing: one entry, from the transition.
      expect(await readChangeLogs(ownerA, problem)).toHaveLength(1);
    });

    it('will not accept a write from a version that has moved on', async () => {
      const problem = await freshProblem(ownerA);

      const first = await send<ProblemBody>(ownerA, 'PATCH', `/v1/problems/${problem}`, {
        expected_version: 1,
        changed_by: ACTOR,
        confidence: 'HIGH',
      });
      expect(first.version).toBe(2);

      // A second writer that read version 1 and never saw the first change.
      const stale = await ownerA.app.inject({
        method: 'PATCH',
        url: `/v1/problems/${problem}`,
        payload: { expected_version: 1, changed_by: 'someone-else', importance: true },
      });

      expect(stale.statusCode).toBe(409);
      expect(stale.json<{ error: { code: string } }>().error.code).toBe('VERSION_CONFLICT');

      // The loser's change is not applied, silently or otherwise. A lost
      // update would look like it worked.
      const after = await readProblem(ownerA, problem);
      expect(after).toMatchObject({ confidence: 'HIGH', importance: false, version: 2 });

      const history = await readChangeLogs(ownerA, problem);
      expect(history).toHaveLength(1);
      expect(history[0]?.changed_by).toBe(ACTOR);
    });

    it('does not let one owner see or touch another’s problem', async () => {
      const target = carried.problemA ?? '';
      const before = await readProblem(ownerA, target);

      const read = await ownerB.app.inject({ method: 'GET', url: `/v1/problems/${target}` });
      expect(read.statusCode).toBe(404);

      // A conflict here would be worse than a refusal: it would confirm the
      // problem exists, and at which version.
      const write = await ownerB.app.inject({
        method: 'PATCH',
        url: `/v1/problems/${target}`,
        payload: { expected_version: 3, changed_by: 'owner-b', importance: true },
      });
      expect(write.statusCode).toBe(404);
      expect(write.statusCode).not.toBe(409);

      // Indistinguishable from an id that was never issued.
      const unknown = generateProblemId();
      const unknownRead = await ownerB.app.inject({
        method: 'GET',
        url: `/v1/problems/${unknown}`,
      });
      const unknownWrite = await ownerB.app.inject({
        method: 'PATCH',
        url: `/v1/problems/${unknown}`,
        payload: { expected_version: 3, changed_by: 'owner-b', importance: true },
      });
      expect(read.json<{ error: unknown }>().error).toEqual(
        unknownRead.json<{ error: unknown }>().error,
      );
      expect(write.json<{ error: unknown }>().error).toEqual(
        unknownWrite.json<{ error: unknown }>().error,
      );

      // Not reachable sideways either: a link is a write to both ends.
      const ownProblem = await freshProblem(ownerB);
      const link = await ownerB.app.inject({
        method: 'POST',
        url: `/v1/problems/${ownProblem}/relations`,
        payload: { to_id: target, relation_type: 'SIMILAR_TO', reason: 'Looks related.' },
      });
      expect(link.statusCode).toBe(404);
      expect(await readRelations(ownerB, ownProblem)).toEqual([]);
      expect(await readRelations(ownerA, target)).toHaveLength(1);

      // Owner A's problem is exactly as it was.
      expect(await readProblem(ownerA, target)).toEqual(before);
    });

    it('treats a resent append as the same write, not a second one', async () => {
      const problem = await freshProblem(ownerA);
      const key = generateClientEventId();

      const first = await send<EventBody>(
        ownerA,
        'POST',
        `/v1/problems/${problem}/events`,
        {
          event_type: 'HYPOTHESIS',
          summary: 'The callback host may differ once deployed',
          source_ai: ACTOR,
          client_event_id: key,
        },
        201,
      );

      // The same key, a different payload — a client that never learned
      // whether its first attempt arrived, and has since reworded it.
      const retry = await send<EventBody>(
        ownerA,
        'POST',
        `/v1/problems/${problem}/events`,
        {
          event_type: 'ATTEMPT',
          summary: 'Something else entirely',
          source_ai: 'a-different-assistant',
          client_event_id: key,
        },
        201,
      );

      // First write wins, down to the identity and the timestamp.
      expect(retry).toEqual(first);
      expect(retry.summary).toBe('The callback host may differ once deployed');
      expect(retry.event_type).toBe('HYPOTHESIS');

      expect(await readEvents(ownerA, problem)).toEqual([first]);
    });

    it('will not link a problem to itself', async () => {
      const problem = await freshProblem(ownerA);

      const refused = await ownerA.app.inject({
        method: 'POST',
        url: `/v1/problems/${problem}/relations`,
        payload: {
          to_id: problem,
          relation_type: 'SIMILAR_TO',
          reason: 'It resembles itself.',
        },
      });

      // A problem is not a memory of itself, and a self-link would be a node
      // in the graph that answers every question with the question.
      expect(refused.statusCode).toBe(400);
      expect(refused.json<{ error: { code: string } }>().error.code).toBe('INVALID_REQUEST');
      expect(await readRelations(ownerA, problem)).toEqual([]);
    });
  });
});

// ---- fixture only -----------------------------------------------------------
//
// The only database access outside the story, and the only raw SQL. Creating
// an owner has no HTTP surface, and cleanup deliberately has none.

/**
 * Removes everything these owners created, and nothing else.
 *
 * Children first: every foreign key restricts, so a parent with rows still
 * pointing at it cannot be deleted. Scoped by owner id, so a developer's own
 * data and anything another suite left are untouched.
 */
async function cleanUpOwners(pool: DatabasePool, ownerIds: readonly OwnerId[]): Promise<void> {
  if (ownerIds.length === 0) {
    return;
  }

  for (const table of [
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
    await pool.query(`delete from public.${table} where owner_id = any($1::uuid[])`, [ownerIds]);
  }
}
