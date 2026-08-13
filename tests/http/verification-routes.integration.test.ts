/**
 * Verification endpoints over a real database.
 *
 * Two owners per run, driven entirely through HTTP. Two things matter here.
 *
 * The first is that a Verification is evidence: `result` records what a check
 * actually found, and a retry — which is the same write arriving again, not a
 * second check — must never be able to change it. That is stronger than the
 * Event case, where a changed payload is merely a client mistake; here it
 * would be a rewritten finding.
 *
 * The second is that a Verification is not a decision. Recording a successful
 * one leaves the Problem's status exactly where it was; concluding a problem
 * is solved is P2-06's judgement, not a side effect of a write.
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
  createRequestContextService,
  createVerificationService,
} from '../../src/app/index.js';
import { readDatabaseUrl } from '../../src/config/env.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import { generateClientEventId } from '../../src/domain/client-event-id.js';
import { VERIFICATION_TYPES } from '../../src/domain/enums.js';
import { generateOwnerId, type OwnerId } from '../../src/domain/owner.js';
import { generateProblemId } from '../../src/domain/problem.js';
import { generateVerificationId } from '../../src/domain/verification.js';
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

describe.skipIf(databaseUrl === undefined)('Verification API', () => {
  let pool: DatabasePool;
  const ownersCreated: OwnerId[] = [];
  const appsCreated: FastifyInstance[] = [];

  async function makeActor(): Promise<Actor> {
    const ownerId = generateOwnerId();
    await insertOwnerIfAbsent(pool, ownerId);
    ownersCreated.push(ownerId);

    const app = buildMemoryHttpApp({
      healthService: createHealthService(pool),
      requestContextService: createRequestContextService(pool, { [MEMORY_OWNER_ID_VAR]: ownerId }),
      projectEnvironmentService: createProjectEnvironmentService(),
      problemService: createProblemService(),
      problemStatusService: createProblemStatusService(),
      eventService: createEventService(),
      verificationService: createVerificationService(),
      relationService: createRelationService(),
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
      url: `/v1/problems/${fixture.problemId}/verifications`,
      payload: body,
    });
  }

  async function appendOk(fixture: Fixture, body: Record<string, unknown> = {}) {
    const response = await append(fixture, {
      verification_type: 'TEST',
      result: true,
      summary: 'Suite green',
      client_event_id: generateClientEventId(),
      ...body,
    });
    expect(response.statusCode).toBe(201);
    return response.json<Record<string, unknown>>();
  }

  async function listVerifications(fixture: Fixture) {
    const response = await fixture.actor.app.inject({
      method: 'GET',
      url: `/v1/problems/${fixture.problemId}/verifications`,
    });
    expect(response.statusCode).toBe(200);
    return response.json<{ verifications: Record<string, unknown>[] }>().verifications;
  }

  /** How many verifications this owner holds under one key, across all problems. */
  async function countByKey(ownerId: OwnerId, clientEventId: string): Promise<number> {
    const result = await pool.query<{ count: string }>(
      `select count(*)::text as count from public.verifications
        where owner_id = $1 and client_event_id = $2`,
      [ownerId, clientEventId],
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  async function readProblemStatus(fixture: Fixture): Promise<string> {
    const response = await fixture.actor.app.inject({
      method: 'GET',
      url: `/v1/problems/${fixture.problemId}`,
    });
    expect(response.statusCode).toBe(200);
    return response.json<{ status: string }>().status;
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

  describe('recording a check', () => {
    it('records a verification with the ids and time the server decides', async () => {
      const fixture = await makeFixture();
      const clientEventId = generateClientEventId();

      const verification = await appendOk(fixture, {
        verification_type: 'REAL_DEVICE',
        result: true,
        summary: 'Signed in on a physical handset.',
        client_event_id: clientEventId,
      });

      expect(verification).toMatchObject({
        owner_id: fixture.actor.ownerId,
        problem_id: fixture.problemId,
        verification_type: 'REAL_DEVICE',
        result: true,
        summary: 'Signed in on a physical handset.',
        evidence_ref: null,
        verified_by: null,
        client_event_id: clientEventId,
      });
      expect(typeof verification['verification_id']).toBe('string');
      expect(verification['verification_id']).not.toBe(clientEventId);
      expect(verification).not.toHaveProperty('updated_at');
      expect(verification).not.toHaveProperty('event_id');
    });

    it('stores optional text, trimming it', async () => {
      const fixture = await makeFixture();

      const verification = await appendOk(fixture, {
        summary: '  Suite green after the fix.  ',
        evidence_ref: '  ci run 4821  ',
        verified_by: '  vitest  ',
      });

      expect(verification).toMatchObject({
        summary: 'Suite green after the fix.',
        evidence_ref: 'ci run 4821',
        verified_by: 'vitest',
      });
    });

    it('treats blank optional text as absent', async () => {
      const fixture = await makeFixture();

      const verification = await appendOk(fixture, { evidence_ref: '   ', verified_by: '' });

      expect(verification).toMatchObject({ evidence_ref: null, verified_by: null });
    });

    it.each(VERIFICATION_TYPES)('records a %s check, passing and failing', async (type) => {
      const fixture = await makeFixture();

      const passed = await appendOk(fixture, {
        verification_type: type,
        result: true,
        summary: 'held',
      });
      const failed = await appendOk(fixture, {
        verification_type: type,
        result: false,
        summary: 'did not hold',
      });

      expect(passed).toMatchObject({ verification_type: type, result: true });
      expect(failed).toMatchObject({ verification_type: type, result: false });
    });

    it('keeps a failed check as evidence, distinguishable from a successful one', async () => {
      const fixture = await makeFixture();

      await appendOk(fixture, { result: false, summary: 'The suite still fails.' });
      await appendOk(fixture, { result: true, summary: 'Suite green after the fix.' });

      const verifications = await listVerifications(fixture);

      // A failed check is not discarded and is not the same as no check.
      expect(verifications.map((v) => v['result'])).toEqual([false, true]);
      expect(verifications).toHaveLength(2);
    });

    it('does not move the problem to VERIFIED', async () => {
      const fixture = await makeFixture();
      expect(await readProblemStatus(fixture)).toBe('INVESTIGATING');

      await appendOk(fixture, { result: true, summary: 'Suite green' });

      // Recording evidence is not deciding the problem is solved. That
      // judgement weighs the transition rules too, and it is P2-06's.
      expect(await readProblemStatus(fixture)).toBe('INVESTIGATING');
    });
  });

  describe('listing', () => {
    it('returns checks oldest first', async () => {
      const fixture = await makeFixture();
      const summaries = ['first check', 'second check', 'third check'];

      for (const summary of summaries) {
        await appendOk(fixture, { summary });
      }

      expect((await listVerifications(fixture)).map((v) => v['summary'])).toEqual(summaries);
    });

    it('orders deterministically when checks share a timestamp', async () => {
      const fixture = await makeFixture();
      const shared = '2026-01-01T00:00:00Z';
      const ids = [generateVerificationId(), generateVerificationId(), generateVerificationId()];

      for (const verificationId of ids) {
        await pool.query(
          `insert into public.verifications
                  (verification_id, owner_id, problem_id, verification_type, result, summary,
                   client_event_id, created_at)
                values ($1, $2, $3, 'TEST', true, $4, $5, $6)`,
          [
            verificationId,
            fixture.actor.ownerId,
            fixture.problemId,
            `tie-${verificationId}`,
            generateClientEventId(),
            shared,
          ],
        );
      }

      const first = (await listVerifications(fixture)).map((v) => v['verification_id']);
      const second = (await listVerifications(fixture)).map((v) => v['verification_id']);

      expect(first).toEqual([...ids].sort());
      expect(second).toEqual(first);
    });

    it('returns an empty list for a problem with no checks', async () => {
      const fixture = await makeFixture();

      expect(await listVerifications(fixture)).toEqual([]);
    });

    it('refuses to list checks of an unknown problem', async () => {
      const fixture = await makeFixture();

      const response = await fixture.actor.app.inject({
        method: 'GET',
        url: `/v1/problems/${generateProblemId()}/verifications`,
      });

      // Not an empty list: that would say "it exists and has none".
      expect(response.statusCode).toBe(404);
    });

    it('refuses to append to an unknown problem', async () => {
      const fixture = await makeFixture();

      const response = await fixture.actor.app.inject({
        method: 'POST',
        url: `/v1/problems/${generateProblemId()}/verifications`,
        payload: {
          verification_type: 'TEST',
          result: true,
          summary: 'Should not land',
          client_event_id: generateClientEventId(),
        },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('a retried write', () => {
    it('returns the original instead of recording a second', async () => {
      const fixture = await makeFixture();
      const body = {
        verification_type: 'TEST',
        result: true,
        summary: 'Suite green after the fix.',
        client_event_id: generateClientEventId(),
      };

      const first = await append(fixture, body);
      const retry = await append(fixture, body);

      expect(first.statusCode).toBe(201);
      expect(retry.statusCode).toBe(201);
      expect(retry.json()).toEqual(first.json());
      expect(await listVerifications(fixture)).toHaveLength(1);
    });

    it('will not let a retry turn a failed check into a successful one', async () => {
      const fixture = await makeFixture();
      const clientEventId = generateClientEventId();

      const original = await appendOk(fixture, {
        verification_type: 'TEST',
        result: false,
        summary: 'The suite still fails.',
        evidence_ref: 'ci run 4821',
        verified_by: 'vitest',
        client_event_id: clientEventId,
      });

      const retry = await append(fixture, {
        verification_type: 'USER_CONFIRMATION',
        result: true,
        summary: 'Actually it works.',
        evidence_ref: 'a message',
        verified_by: 'an assistant',
        client_event_id: clientEventId,
      });

      expect(retry.statusCode).toBe(201);
      // The whole point of separating the fix from the confirmation is that
      // saying "it works" is not evidence that it does. A retry is the same
      // write arriving again, not a second check, so it cannot overwrite what
      // the check found.
      expect(retry.json()).toEqual(original);
      expect(retry.json()).toMatchObject({
        verification_type: 'TEST',
        result: false,
        summary: 'The suite still fails.',
        evidence_ref: 'ci run 4821',
        verified_by: 'vitest',
      });

      const verifications = await listVerifications(fixture);
      expect(verifications).toHaveLength(1);
      expect(verifications[0]).toEqual(original);
    });

    it('will not let a retry turn a successful check into a failed one either', async () => {
      const fixture = await makeFixture();
      const clientEventId = generateClientEventId();

      const original = await appendOk(fixture, {
        result: true,
        summary: 'Suite green after the fix.',
        client_event_id: clientEventId,
      });

      const retry = await append(fixture, {
        verification_type: 'TEST',
        result: false,
        summary: 'On reflection, no.',
        client_event_id: clientEventId,
      });

      // Symmetric: first write wins in both directions. Recording a different
      // finding means a new check, with a new key.
      expect(retry.json()).toEqual(original);
      expect(retry.json<{ result: boolean }>().result).toBe(true);
      expect(await listVerifications(fixture)).toHaveLength(1);
    });

    it('replays the original even when sent against a different problem', async () => {
      const actor = await makeActor();
      const first = await makeFixture(actor);
      const second = await makeFixture(actor);
      const clientEventId = generateClientEventId();

      const original = await appendOk(first, {
        result: false,
        summary: 'Recorded against the first problem.',
        client_event_id: clientEventId,
      });

      const misdirected = await append(second, {
        verification_type: 'TEST',
        result: true,
        summary: 'Retried against the wrong problem.',
        client_event_id: clientEventId,
      });

      expect(misdirected.statusCode).toBe(201);
      // The key is the owner's, not the problem's.
      expect(misdirected.json()).toEqual(original);
      expect(misdirected.json<{ problem_id: string }>().problem_id).toBe(first.problemId);
      expect(misdirected.json<{ result: boolean }>().result).toBe(false);

      expect(await listVerifications(second)).toEqual([]);
      expect(await listVerifications(first)).toHaveLength(1);
      expect(await countByKey(actor.ownerId, clientEventId)).toBe(1);
    });

    it('records once when concurrent retries arrive together', async () => {
      const fixture = await makeFixture();
      const clientEventId = generateClientEventId();
      const body = {
        verification_type: 'TEST',
        result: true,
        summary: 'Sent six times at once.',
        client_event_id: clientEventId,
      };

      // The pool opens connections lazily, and connecting takes long enough
      // that the first attempt would finish while the others were still
      // waiting for a socket — which is not a race at all. Opening them first
      // is what makes the attempts genuinely simultaneous. The same shape was
      // confirmed in P2-04 to fail against a read-then-write append.
      await Promise.all(Array.from({ length: 6 }, () => pool.query('select 1')));

      const responses = await Promise.all(Array.from({ length: 6 }, () => append(fixture, body)));

      for (const response of responses) {
        expect(response.statusCode).toBe(201);
      }

      const ids = new Set(
        responses.map((r) => r.json<{ verification_id: string }>().verification_id),
      );
      expect(ids.size).toBe(1);
      const stored = await listVerifications(fixture);
      expect(stored).toHaveLength(1);
      for (const response of responses) {
        expect(response.json()).toEqual(stored[0]);
      }
      expect(await countByKey(fixture.actor.ownerId, clientEventId)).toBe(1);
    });

    it('lets two owners use the same key independently', async () => {
      const mine = await makeFixture();
      const theirs = await makeFixture();
      const clientEventId = generateClientEventId();

      const ours = await appendOk(mine, {
        summary: 'Owner A check',
        client_event_id: clientEventId,
      });
      const theirsCheck = await appendOk(theirs, {
        summary: 'Owner B check',
        client_event_id: clientEventId,
      });

      expect(theirsCheck['verification_id']).not.toBe(ours['verification_id']);
      expect(theirsCheck).toMatchObject({ summary: 'Owner B check' });
      expect(await countByKey(mine.actor.ownerId, clientEventId)).toBe(1);
      expect(await countByKey(theirs.actor.ownerId, clientEventId)).toBe(1);
    });
  });

  describe('independence from events', () => {
    it('lets one key serve an event and a verification without either replaying the other', async () => {
      const fixture = await makeFixture();
      const clientEventId = generateClientEventId();

      const event = await fixture.actor.app.inject({
        method: 'POST',
        url: `/v1/problems/${fixture.problemId}/events`,
        payload: {
          event_type: 'FIX',
          summary: 'Pinned the resolver version.',
          client_event_id: clientEventId,
        },
      });
      expect(event.statusCode).toBe(201);

      const verification = await appendOk(fixture, {
        summary: 'Suite green after the fix.',
        client_event_id: clientEventId,
      });

      // Separate namespaces, so a Verification retry cannot collide with an
      // unrelated Event.
      expect(event.json<{ client_event_id: string }>().client_event_id).toBe(clientEventId);
      expect(verification['client_event_id']).toBe(clientEventId);
      expect(verification['summary']).toBe('Suite green after the fix.');
    });

    it('records the fix and the confirmation as separate things', async () => {
      const fixture = await makeFixture();

      await fixture.actor.app.inject({
        method: 'POST',
        url: `/v1/problems/${fixture.problemId}/events`,
        payload: {
          event_type: 'FIX',
          summary: 'Set SameSite=Lax on the session cookie.',
          client_event_id: generateClientEventId(),
        },
      });
      await appendOk(fixture, {
        verification_type: 'REAL_DEVICE',
        summary: 'Signed in on a physical handset.',
      });

      const events = await fixture.actor.app.inject({
        method: 'GET',
        url: `/v1/problems/${fixture.problemId}/events`,
      });
      const verifications = await listVerifications(fixture);

      // The change and the evidence that it worked are different claims, and
      // neither list contains the other.
      expect(events.json<{ events: unknown[] }>().events).toHaveLength(1);
      expect(verifications).toHaveLength(1);
      expect(verifications[0]).not.toHaveProperty('event_id');
    });

    it('accepts a verification for a problem that has no events at all', async () => {
      const fixture = await makeFixture();

      const verification = await appendOk(fixture, { summary: 'Checked without any events.' });

      const events = await fixture.actor.app.inject({
        method: 'GET',
        url: `/v1/problems/${fixture.problemId}/events`,
      });

      expect(events.json<{ events: unknown[] }>().events).toEqual([]);
      expect(verification['problem_id']).toBe(fixture.problemId);
    });
  });

  describe('what one owner can reach of another', () => {
    it('cannot append to or list the other’s problem', async () => {
      const mine = await makeFixture();
      const theirs = await makeFixture();
      await appendOk(theirs, { summary: 'Their private check' });

      const attempts = [
        await mine.actor.app.inject({
          method: 'POST',
          url: `/v1/problems/${theirs.problemId}/verifications`,
          payload: {
            verification_type: 'TEST',
            result: true,
            summary: 'Should not land',
            client_event_id: generateClientEventId(),
          },
        }),
        await mine.actor.app.inject({
          method: 'GET',
          url: `/v1/problems/${theirs.problemId}/verifications`,
        }),
      ];

      for (const attempt of attempts) {
        expect(attempt.statusCode).toBe(404);
        expect(attempt.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
      }

      expect(await listVerifications(theirs)).toHaveLength(1);
    });

    it('answers the same for another owner’s problem as for one that does not exist', async () => {
      const mine = await makeFixture();
      const theirs = await makeFixture();

      const body = {
        verification_type: 'TEST',
        result: true,
        summary: 's',
        client_event_id: generateClientEventId(),
      };
      const crossOwnerAppend = await mine.actor.app.inject({
        method: 'POST',
        url: `/v1/problems/${theirs.problemId}/verifications`,
        payload: { ...body, client_event_id: generateClientEventId() },
      });
      const unknownAppend = await mine.actor.app.inject({
        method: 'POST',
        url: `/v1/problems/${generateProblemId()}/verifications`,
        payload: { ...body, client_event_id: generateClientEventId() },
      });
      const crossOwnerList = await mine.actor.app.inject({
        method: 'GET',
        url: `/v1/problems/${theirs.problemId}/verifications`,
      });
      const unknownList = await mine.actor.app.inject({
        method: 'GET',
        url: `/v1/problems/${generateProblemId()}/verifications`,
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

      const theirCheck = await appendOk(theirs, {
        summary: 'Their private check',
        client_event_id: clientEventId,
      });

      // Owner A sends owner B's key at owner B's problem. Ownership is settled
      // before the key is consulted, so idempotency reveals nothing.
      const attempt = await mine.actor.app.inject({
        method: 'POST',
        url: `/v1/problems/${theirs.problemId}/verifications`,
        payload: {
          verification_type: 'TEST',
          result: true,
          summary: 'Should not land',
          client_event_id: clientEventId,
        },
      });

      expect(attempt.statusCode).toBe(404);
      expect(attempt.body).not.toContain(theirCheck['verification_id']);
      expect(attempt.body).not.toContain('Their private check');

      // A's own use of the key is unaffected: the namespaces are separate.
      const ours = await appendOk(mine, {
        summary: 'Owner A check',
        client_event_id: clientEventId,
      });
      expect(ours['verification_id']).not.toBe(theirCheck['verification_id']);
    });
  });
});
