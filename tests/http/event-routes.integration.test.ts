/**
 * Event endpoints over a real database.
 *
 * Two owners per run, driven entirely through HTTP. What this suite is really
 * for is idempotency: a client mints a `client_event_id` before its first
 * attempt and reuses it if that attempt has to be retried, and the promise is
 * that no matter how the retry arrives — later, with a different payload,
 * against a different problem, or at the same instant as the original — there
 * is exactly one event and every response describes it.
 *
 * The concurrent case is the reason the append is written the way it is. A
 * read-then-write would pass every test above and still lose this one.
 *
 * Fixtures are made and removed here. Nothing depends on the developer's owner
 * or on what a previous run left.
 *
 * Skipped when `DATABASE_URL` is not set.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import {
  createEventService,
  createHealthService,
  createProblemService,
  createProblemStatusService,
  createProjectEnvironmentService,
  createRelationService,
  createUsageLogService,
  createChangeLogService,
  createMemoryControlService,
  createProblemCloseService,
  createRequestContextService,
  createVerificationService,
} from '../../src/app/index.js';
import { readDatabaseUrl } from '../../src/config/env.js';
import { generateClientEventId } from '../../src/domain/client-event-id.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import { createTransactionRunner } from '../../src/db/transaction.js';
import { EVENT_TYPES } from '../../src/domain/enums.js';
import { generateOwnerId, type OwnerId } from '../../src/domain/owner.js';
import { generateProblemId } from '../../src/domain/problem.js';
import { buildMemoryHttpApp } from '../../src/http/index.js';
import { MEMORY_OWNER_ID_VAR } from '../../src/owner/context.js';

const databaseUrl = readDatabaseUrl();

interface Actor {
  readonly app: FastifyInstance;
  readonly ownerId: OwnerId;
}

interface Fixture {
  readonly actor: Actor;
  readonly problemId: string;
}

describe.skipIf(databaseUrl === undefined)('Event API', () => {
  let pool: DatabasePool;
  const ownersCreated: OwnerId[] = [];
  const appsCreated: FastifyInstance[] = [];

  async function makeActor(): Promise<Actor> {
    const ownerId = generateOwnerId();
    await insertOwnerIfAbsent(pool, ownerId);
    ownersCreated.push(ownerId);

    const app = buildMemoryHttpApp({
      healthService: createHealthService(pool),
      requestContextService: createRequestContextService(pool, createTransactionRunner(pool), {
        [MEMORY_OWNER_ID_VAR]: ownerId,
      }),
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
      logger: false,
    });
    appsCreated.push(app);

    return { app, ownerId };
  }

  /** An owner with a project, an environment and a problem to record against. */
  async function makeFixture(existing?: Actor): Promise<Fixture> {
    const actor = existing ?? (await makeActor());

    const project = await actor.app.inject({
      method: 'POST',
      url: '/v1/projects',
      payload: { project_name: 'fixture-project' },
    });
    expect(project.statusCode).toBe(201);
    const projectId = project.json<{ project_id: string }>().project_id;

    const environment = await actor.app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/environments`,
      payload: { snapshot: { runtime: 'node 22.12.0' } },
    });
    expect(environment.statusCode).toBe(201);

    const problem = await actor.app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/problems`,
      payload: {
        environment_id: environment.json<{ environment_id: string }>().environment_id,
        title: 'Sign-in fails after deploying',
        symptoms: 'Works locally, fails on preview.',
      },
    });
    expect(problem.statusCode).toBe(201);

    return { actor, problemId: problem.json<{ problem_id: string }>().problem_id };
  }

  function append(fixture: Fixture, body: Record<string, unknown>) {
    return fixture.actor.app.inject({
      method: 'POST',
      url: `/v1/problems/${fixture.problemId}/events`,
      payload: body,
    });
  }

  async function appendOk(fixture: Fixture, body: Record<string, unknown> = {}) {
    const response = await append(fixture, {
      event_type: 'ATTEMPT',
      summary: 'Tried something',
      client_event_id: generateClientEventId(),
      ...body,
    });
    expect(response.statusCode).toBe(201);
    return response.json<Record<string, unknown>>();
  }

  async function listEvents(fixture: Fixture) {
    const response = await fixture.actor.app.inject({
      method: 'GET',
      url: `/v1/problems/${fixture.problemId}/events`,
    });
    expect(response.statusCode).toBe(200);
    return response.json<{ events: Record<string, unknown>[] }>().events;
  }

  /** How many events this owner holds under one client event id, across all problems. */
  async function countByKey(ownerId: OwnerId, clientEventId: string): Promise<number> {
    const result = await pool.query<{ count: string }>(
      'select count(*)::text as count from public.events where owner_id = $1 and client_event_id = $2',
      [ownerId, clientEventId],
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  beforeAll(() => {
    pool = createPool(resolveDatabaseConfig({ nodeEnv: 'test', connectionTimeoutMillis: 5_000 }));
  });

  afterAll(async () => {
    for (const app of appsCreated) {
      await app.close();
    }
    if (ownersCreated.length > 0) {
      // Children first: every foreign key restricts deleting the parent.
      for (const table of [
        'change_logs',
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

  describe('appending', () => {
    it('records an event with the ids and time the server decides', async () => {
      const fixture = await makeFixture();
      const clientEventId = generateClientEventId();

      const event = await appendOk(fixture, {
        event_type: 'HYPOTHESIS',
        summary: 'The session cookie may not survive the redirect.',
        client_event_id: clientEventId,
      });

      expect(event).toMatchObject({
        owner_id: fixture.actor.ownerId,
        problem_id: fixture.problemId,
        event_type: 'HYPOTHESIS',
        summary: 'The session cookie may not survive the redirect.',
        result: null,
        reason: null,
        source_ai: null,
        evidence_ref: null,
        client_event_id: clientEventId,
      });
      expect(typeof event['event_id']).toBe('string');
      expect(event['event_id']).not.toBe(clientEventId);
      expect(event).not.toHaveProperty('updated_at');
    });

    it('stores optional text, trimming it', async () => {
      const fixture = await makeFixture();

      const event = await appendOk(fixture, {
        event_type: 'FIX',
        summary: '  Set SameSite=Lax on the session cookie.  ',
        result: '  sign-in succeeds on preview  ',
        reason: '  the redirect is cross-site  ',
        source_ai: '  claude-code  ',
        evidence_ref: '  commit a1b2c3d  ',
      });

      expect(event).toMatchObject({
        summary: 'Set SameSite=Lax on the session cookie.',
        result: 'sign-in succeeds on preview',
        reason: 'the redirect is cross-site',
        source_ai: 'claude-code',
        evidence_ref: 'commit a1b2c3d',
      });
    });

    it('treats blank optional text as absent', async () => {
      const fixture = await makeFixture();

      const event = await appendOk(fixture, {
        result: '   ',
        reason: '',
        source_ai: null,
      });

      expect(event).toMatchObject({ result: null, reason: null, source_ai: null });
    });

    it.each(EVENT_TYPES)('records a %s event', async (eventType) => {
      const fixture = await makeFixture();

      const event = await appendOk(fixture, { event_type: eventType });

      expect(event).toMatchObject({ event_type: eventType });
    });
  });

  describe('the history of an investigation', () => {
    it('records the whole arc and reads it back in order', async () => {
      const fixture = await makeFixture();
      const arc = [
        { event_type: 'HYPOTHESIS', summary: 'The session cookie may not survive the redirect.' },
        { event_type: 'ATTEMPT', summary: 'Set the cookie domain explicitly.' },
        { event_type: 'DEAD_END', summary: 'The domain was already correct; no change.' },
        { event_type: 'DISCOVERY', summary: 'The redirect is cross-site, so SameSite applies.' },
        { event_type: 'FIX', summary: 'Set SameSite=Lax on the session cookie.' },
      ];

      for (const step of arc) {
        await appendOk(fixture, step);
      }

      const events = await listEvents(fixture);

      // A dead end is kept as carefully as the fix: knowing which direction
      // did not work is half of what makes this reusable later.
      expect(events.map((event) => event['event_type'])).toEqual([
        'HYPOTHESIS',
        'ATTEMPT',
        'DEAD_END',
        'DISCOVERY',
        'FIX',
      ]);
      expect(events.map((event) => event['summary'])).toEqual(arc.map((step) => step.summary));
    });

    it('orders deterministically when events share a timestamp', async () => {
      const fixture = await makeFixture();
      const shared = '2026-01-01T00:00:00Z';
      const ids = [generateProblemId(), generateProblemId(), generateProblemId()];

      for (const eventId of ids) {
        await pool.query(
          `insert into public.events
                  (event_id, owner_id, problem_id, event_type, summary, client_event_id, created_at)
                values ($1, $2, $3, 'ATTEMPT', $4, $5, $6)`,
          [
            eventId,
            fixture.actor.ownerId,
            fixture.problemId,
            `tie-${eventId}`,
            generateClientEventId(),
            shared,
          ],
        );
      }

      const first = (await listEvents(fixture)).map((event) => event['event_id']);
      const second = (await listEvents(fixture)).map((event) => event['event_id']);

      expect(first).toEqual([...ids].sort());
      expect(second).toEqual(first);
    });

    it('returns an empty list for a problem with no events', async () => {
      const fixture = await makeFixture();

      expect(await listEvents(fixture)).toEqual([]);
    });

    it('refuses to list events of an unknown problem', async () => {
      const fixture = await makeFixture();

      const response = await fixture.actor.app.inject({
        method: 'GET',
        url: `/v1/problems/${generateProblemId()}/events`,
      });

      // Not an empty list: that would say "it exists and has none".
      expect(response.statusCode).toBe(404);
    });

    it('refuses to append to an unknown problem', async () => {
      const fixture = await makeFixture();

      const response = await fixture.actor.app.inject({
        method: 'POST',
        url: `/v1/problems/${generateProblemId()}/events`,
        payload: {
          event_type: 'ATTEMPT',
          summary: 'Should not land',
          client_event_id: generateClientEventId(),
        },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('a retried write', () => {
    it('returns the original event instead of recording a second', async () => {
      const fixture = await makeFixture();
      const clientEventId = generateClientEventId();
      const body = {
        event_type: 'ATTEMPT',
        summary: 'Set the cookie domain explicitly.',
        client_event_id: clientEventId,
      };

      const first = await append(fixture, body);
      const retry = await append(fixture, body);

      // Same status: the client could not tell which attempt reached the
      // table, and does not have to.
      expect(first.statusCode).toBe(201);
      expect(retry.statusCode).toBe(201);
      expect(retry.json()).toEqual(first.json());
      expect(await listEvents(fixture)).toHaveLength(1);
    });

    it('keeps the first write when the retry carries a different payload', async () => {
      const fixture = await makeFixture();
      const clientEventId = generateClientEventId();

      const first = await appendOk(fixture, {
        event_type: 'HYPOTHESIS',
        summary: 'The original claim.',
        client_event_id: clientEventId,
        result: 'original result',
        reason: 'original reason',
        source_ai: 'original-ai',
        evidence_ref: 'original-ref',
      });

      const retry = await append(fixture, {
        event_type: 'FIX',
        summary: 'A different claim entirely.',
        client_event_id: clientEventId,
        result: 'changed result',
        reason: 'changed reason',
        source_ai: 'changed-ai',
        evidence_ref: 'changed-ref',
      });

      expect(retry.statusCode).toBe(201);
      // The first write is the write. Applying the retry's payload would edit
      // an append-only record; creating a second event would hide the fact
      // that the client reused a key by mistake.
      expect(retry.json()).toEqual(first);
      expect(retry.json()).toMatchObject({
        event_type: 'HYPOTHESIS',
        summary: 'The original claim.',
        result: 'original result',
        reason: 'original reason',
        source_ai: 'original-ai',
        evidence_ref: 'original-ref',
      });

      const events = await listEvents(fixture);
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(first);
    });

    it('replays the original even when sent against a different problem', async () => {
      const actor = await makeActor();
      const first = await makeFixture(actor);
      const second = await makeFixture(actor);
      const clientEventId = generateClientEventId();

      const original = await appendOk(first, {
        summary: 'Recorded against the first problem.',
        client_event_id: clientEventId,
      });

      const misdirected = await append(second, {
        event_type: 'ATTEMPT',
        summary: 'Retried against the wrong problem.',
        client_event_id: clientEventId,
      });

      expect(misdirected.statusCode).toBe(201);
      // The key is the owner's, not the problem's. Returning the original —
      // whose problem_id is the first one — is how the client finds out it
      // reused a key rather than silently getting a second event.
      expect(misdirected.json()).toEqual(original);
      expect(misdirected.json<{ problem_id: string }>().problem_id).toBe(first.problemId);

      expect(await listEvents(second)).toEqual([]);
      expect(await listEvents(first)).toHaveLength(1);
      expect(await countByKey(actor.ownerId, clientEventId)).toBe(1);
    });

    it('records once when concurrent retries arrive together', async () => {
      const fixture = await makeFixture();
      const clientEventId = generateClientEventId();
      const body = {
        event_type: 'ATTEMPT',
        summary: 'Sent six times at once.',
        client_event_id: clientEventId,
      };

      // The pool opens connections lazily, and connecting takes long enough
      // that the first attempt would finish while the others were still
      // waiting for a socket — which is not a race at all. Opening them first
      // is what makes the attempts genuinely simultaneous, and it is what this
      // test needs to be able to fail: verified by running it against a
      // read-then-write append, where five of the six collide.
      await Promise.all(Array.from({ length: 6 }, () => pool.query('select 1')));

      const responses = await Promise.all(Array.from({ length: 6 }, () => append(fixture, body)));

      for (const response of responses) {
        expect(response.statusCode).toBe(201);
      }

      const eventIds = new Set(responses.map((r) => r.json<{ event_id: string }>().event_id));
      expect(eventIds.size).toBe(1);
      expect(await listEvents(fixture)).toHaveLength(1);
      expect(await countByKey(fixture.actor.ownerId, clientEventId)).toBe(1);
    });

    it('lets two owners use the same key independently', async () => {
      const mine = await makeFixture();
      const theirs = await makeFixture();
      const clientEventId = generateClientEventId();

      const ours = await appendOk(mine, {
        summary: 'Owner A write',
        client_event_id: clientEventId,
      });
      const theirsEvent = await appendOk(theirs, {
        summary: 'Owner B write',
        client_event_id: clientEventId,
      });

      // Separate owners are separate namespaces; neither replayed the other.
      expect(theirsEvent['event_id']).not.toBe(ours['event_id']);
      expect(theirsEvent).toMatchObject({ summary: 'Owner B write' });
      expect(await countByKey(mine.actor.ownerId, clientEventId)).toBe(1);
      expect(await countByKey(theirs.actor.ownerId, clientEventId)).toBe(1);
    });
  });

  describe('what one owner can reach of another', () => {
    it('cannot append to or list the other’s problem', async () => {
      const mine = await makeFixture();
      const theirs = await makeFixture();
      await appendOk(theirs, { summary: 'Their private note' });

      const attempts = [
        await mine.actor.app.inject({
          method: 'POST',
          url: `/v1/problems/${theirs.problemId}/events`,
          payload: {
            event_type: 'ATTEMPT',
            summary: 'Should not land',
            client_event_id: generateClientEventId(),
          },
        }),
        await mine.actor.app.inject({
          method: 'GET',
          url: `/v1/problems/${theirs.problemId}/events`,
        }),
      ];

      for (const attempt of attempts) {
        expect(attempt.statusCode).toBe(404);
        expect(attempt.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
      }

      // Nothing landed on their problem.
      expect(await listEvents(theirs)).toHaveLength(1);
    });

    it('answers the same for another owner’s problem as for one that does not exist', async () => {
      const mine = await makeFixture();
      const theirs = await makeFixture();

      const crossOwnerAppend = await mine.actor.app.inject({
        method: 'POST',
        url: `/v1/problems/${theirs.problemId}/events`,
        payload: {
          event_type: 'ATTEMPT',
          summary: 's',
          client_event_id: generateClientEventId(),
        },
      });
      const unknownAppend = await mine.actor.app.inject({
        method: 'POST',
        url: `/v1/problems/${generateProblemId()}/events`,
        payload: {
          event_type: 'ATTEMPT',
          summary: 's',
          client_event_id: generateClientEventId(),
        },
      });
      const crossOwnerList = await mine.actor.app.inject({
        method: 'GET',
        url: `/v1/problems/${theirs.problemId}/events`,
      });
      const unknownList = await mine.actor.app.inject({
        method: 'GET',
        url: `/v1/problems/${generateProblemId()}/events`,
      });

      // `request_id` differs per request, so the comparison is of the part
      // that carries meaning.
      const errorOf = (r: typeof crossOwnerAppend) => r.json<{ error: unknown }>().error;
      expect(crossOwnerAppend.statusCode).toBe(unknownAppend.statusCode);
      expect(errorOf(crossOwnerAppend)).toEqual(errorOf(unknownAppend));
      expect(crossOwnerList.statusCode).toBe(unknownList.statusCode);
      expect(errorOf(crossOwnerList)).toEqual(errorOf(unknownList));
    });

    it('does not let a reused key reach another owner’s problem', async () => {
      const mine = await makeFixture();
      const theirs = await makeFixture();
      const clientEventId = generateClientEventId();

      // Owner B records something under a key of their own.
      const theirEvent = await appendOk(theirs, {
        summary: 'Their private note',
        client_event_id: clientEventId,
      });

      // Owner A now sends the same key at owner B's problem. Idempotency must
      // not be the route by which A learns anything about B: ownership is
      // settled before the key is ever consulted.
      const attempt = await mine.actor.app.inject({
        method: 'POST',
        url: `/v1/problems/${theirs.problemId}/events`,
        payload: {
          event_type: 'ATTEMPT',
          summary: 'Should not land',
          client_event_id: clientEventId,
        },
      });

      expect(attempt.statusCode).toBe(404);
      expect(attempt.body).not.toContain(theirEvent['event_id']);
      expect(attempt.body).not.toContain('Their private note');

      // And A's own use of the key is unaffected: the namespaces are separate.
      const ours = await appendOk(mine, {
        summary: 'Owner A write',
        client_event_id: clientEventId,
      });
      expect(ours['event_id']).not.toBe(theirEvent['event_id']);
    });
  });
});
