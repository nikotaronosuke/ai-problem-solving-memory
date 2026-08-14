/**
 * Sending the same write more than once, and finding one row.
 *
 * The failure this is about is not a server that is down — that one is easy to
 * reason about, because nothing arrived. It is the one where the write *did*
 * arrive, the database committed it, and the answer never made it back. The
 * caller sees a failure that is indistinguishable from the write never
 * happening, and the only safe thing it can do is send it again.
 *
 * So every test here that matters produces exactly that: a delivery that
 * really posts to a really running server, waits for a real 201, and then
 * reports a transport failure anyway. Testing against a stopped server would
 * prove something weaker and would pass against an implementation that
 * generated a fresh key on every retry.
 *
 * Real database, real credential, real HTTP over a real socket, real files on
 * disk. The only fiction is the lost response, which is the thing being
 * simulated.
 *
 * Skipped when `DATABASE_URL` is not set.
 */

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import {
  createChangeLogService,
  createEventService,
  createExportService,
  createHealthService,
  createMemoryControlService,
  createProblemCloseService,
  createProblemDeleteService,
  createProblemService,
  createProblemStatusService,
  createProjectEnvironmentService,
  createRelationService,
  createRequestContextService,
  createUsageLogService,
  createVerificationService,
} from '../../src/app/index.js';
import { readDatabaseUrl } from '../../src/config/env.js';
import {
  createCredentialAuthenticator,
  createCredentialRepository,
} from '../../src/credentials/index.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import { createTransactionRunner } from '../../src/db/transaction.js';
import { generateClientId } from '../../src/domain/client.js';
import {
  formatCredentialToken,
  generateCredentialId,
  generateCredentialToken,
  hashCredentialSecret,
} from '../../src/domain/credential.js';
import { generateOwnerId, type OwnerId } from '../../src/domain/owner.js';
import type { ProblemId } from '../../src/domain/problem.js';
import { buildMemoryHttpApp } from '../../src/http/index.js';
import {
  createReliableWriteCoordinator,
  createRetryQueue,
  QueueCapacityError,
  type DeliveryContext,
  type DeliveryOutcome,
  type QueueItem,
  type RetryDelivery,
  type RetryQueue,
} from '../../src/reliability/index.js';
import { SanitizationRejectedError } from '../../src/sanitization/index.js';
import type { ErrorCode } from '../../src/http/errors.js';

const databaseUrl = readDatabaseUrl();

const LIMITS = { maxItems: 100, maxItemBytes: 64 * 1024, maxTotalBytes: 4 * 1024 * 1024 };
const POLICY = { baseDelayMs: 1_000, maxDelayMs: 30_000, maxAttempts: 5 };
const AT = new Date('2026-08-14T11:00:00.000Z');

/** Everything a delivery saw, so a test can compare attempts to each other. */
interface Recorded {
  readonly item: QueueItem;
  readonly body: Record<string, unknown>;
  readonly status: number | 'transport-failure';
}

describe.skipIf(databaseUrl === undefined)('the same write, sent more than once', () => {
  let pool: DatabasePool;
  let app: FastifyInstance;
  let baseUrl = '';
  let directory: string;
  let ownerId: OwnerId;
  let token = '';
  let projectId = '';
  let environmentId = '';
  const ownersCreated: OwnerId[] = [];

  /**
   * The transport an adapter will ship, plus a switch for the lost answer.
   *
   * `loseAnswer` makes it post for real, read the real response, and then
   * report a transport failure regardless. That is what a timeout after a
   * commit looks like from the client: the write happened and the client has
   * no way to know.
   */
  function delivery(
    options: { loseAnswer?: boolean; bearer?: () => string } = {},
  ): RetryDelivery & {
    readonly seen: Recorded[];
  } {
    const seen: Recorded[] = [];
    const bearer = options.bearer ?? (() => token);

    return {
      seen,
      async deliver(item: QueueItem): Promise<DeliveryOutcome> {
        const path =
          item.write.operation === 'appendEvent'
            ? `/v1/problems/${item.write.problemId}/events`
            : `/v1/problems/${item.write.problemId}/verifications`;

        const body: Record<string, unknown> =
          item.write.operation === 'appendEvent'
            ? {
                event_type: item.write.payload.eventType,
                summary: item.write.payload.summary,
                ...(item.write.payload.reason == null ? {} : { reason: item.write.payload.reason }),
                client_event_id: item.write.clientEventId,
              }
            : {
                verification_type: item.write.payload.verificationType,
                result: item.write.payload.result,
                summary: item.write.payload.summary,
                client_event_id: item.write.clientEventId,
              };

        let response: Response;
        try {
          response = await fetch(`${baseUrl}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer()}` },
            body: JSON.stringify(body),
          });
        } catch {
          seen.push({ item, body, status: 'transport-failure' });
          return { kind: 'TRANSPORT_FAILURE' };
        }

        seen.push({ item, body, status: response.status });

        if (options.loseAnswer === true) {
          // The server has committed by now — the response was read. The
          // client is told nothing came back, which is the case this file
          // exists for.
          await response.text();
          return { kind: 'TRANSPORT_FAILURE' };
        }

        if (response.ok) {
          return { kind: 'SUCCESS' };
        }

        let errorCode: ErrorCode | undefined;
        try {
          errorCode = ((await response.json()) as { error?: { code?: ErrorCode } }).error?.code;
        } catch {
          // Not the envelope. The status is enough.
        }
        return {
          kind: 'HTTP_FAILURE',
          status: response.status,
          ...(errorCode === undefined ? {} : { errorCode }),
        };
      },
    };
  }

  const post = async (path: string, payload: unknown): Promise<Record<string, string>> => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    expect(response.status, `${path} -> ${await response.clone().text()}`).toBe(201);
    return (await response.json()) as Record<string, string>;
  };

  const newProblem = async (title: string): Promise<ProblemId> =>
    ((
      await post(`/v1/projects/${projectId}/problems`, {
        environment_id: environmentId,
        title,
        symptoms: 'symptoms',
      })
    )['problem_id'] ?? '') as ProblemId;

  const eventsByKey = async (key: string) =>
    (
      await pool.query<{ summary: string; event_id: string }>(
        `select summary, event_id::text from public.events
          where owner_id = $1 and client_event_id = $2`,
        [ownerId, key],
      )
    ).rows;

  const verificationsByKey = async (key: string) =>
    (
      await pool.query<{ summary: string; verification_id: string; result: boolean }>(
        `select summary, verification_id::text, result from public.verifications
          where owner_id = $1 and client_event_id = $2`,
        [ownerId, key],
      )
    ).rows;

  const newQueue = (): RetryQueue =>
    createRetryQueue({ directory, limits: LIMITS, policy: POLICY });

  beforeAll(async () => {
    pool = createPool(resolveDatabaseConfig({ nodeEnv: 'test', connectionTimeoutMillis: 5_000 }));
    directory = await mkdtemp(join(tmpdir(), 'memory-replay-'));

    ownerId = generateOwnerId();
    await insertOwnerIfAbsent(pool, ownerId);
    ownersCreated.push(ownerId);

    const credential = generateCredentialToken();
    await createCredentialRepository(pool).issueClientCredential({
      clientId: generateClientId(),
      ownerId,
      label: 'replay test client',
      credentialId: generateCredentialId(),
      tokenLookup: credential.lookup,
      tokenHash: hashCredentialSecret(credential.secret),
    });
    token = formatCredentialToken(credential);

    app = buildMemoryHttpApp({
      healthService: createHealthService(pool),
      requestContextService: createRequestContextService(
        pool,
        createTransactionRunner(pool),
        createCredentialAuthenticator(createCredentialRepository(pool)),
      ),
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
      exportService: createExportService(),
      logger: false,
    });
    baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });

    projectId =
      (await post('/v1/projects', { project_name: 'idempotent replay' }))['project_id'] ?? '';
    environmentId =
      (await post(`/v1/projects/${projectId}/environments`, { snapshot: { runtime: 'node 22' } }))[
        'environment_id'
      ] ?? '';
  });

  afterAll(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });

    if (ownersCreated.length > 0) {
      await pool.query(
        `delete from public.client_credentials
          where client_id in (select client_id from public.clients where owner_id = any($1::uuid[]))`,
        [ownersCreated],
      );
      for (const table of [
        'change_logs',
        'usage_logs',
        'relations',
        'verifications',
        'events',
        'clients',
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

  describe('an Event whose answer was lost', () => {
    it('is stored once, under the key it was given before the first attempt', async () => {
      const problemId = await newProblem('the event whose answer was lost');
      const queue = newQueue();
      const coordinator = createReliableWriteCoordinator(queue);
      const context: DeliveryContext = { ownerId };

      const first = delivery({ loseAnswer: true });
      const submitted = await coordinator.submitEvent(
        {
          ownerId,
          problemId,
          problemImportant: false,
          payload: { eventType: 'DISCOVERY', summary: 'the first and only summary' },
        },
        AT,
        context,
        first,
      );

      // The client was told it failed.
      expect(submitted.outcome).toBe('QUEUED');
      // The server disagrees: it committed, and the row is already there.
      expect(await eventsByKey(submitted.clientEventId)).toHaveLength(1);
      expect(first.seen[0]?.status).toBe(201);

      // The process ends. A new queue reads the same directory.
      const restarted = newQueue();
      const held = (await restarted.list()).items;
      expect(held).toHaveLength(1);
      expect(held[0]?.write.clientEventId).toBe(submitted.clientEventId);

      const second = delivery();
      const due = new Date(held[0]?.nextAttemptAt ?? AT);
      const report = await restarted.drain(due, context, second);

      expect(report.results.map((result) => result.outcome)).toEqual(['DELIVERED']);
      // The server answered 201 again, with the original row.
      expect(second.seen[0]?.status).toBe(201);

      // One row, not two. This is the assertion the whole task is for: an
      // implementation that generated a fresh key on the retry passes
      // everything above and fails here with two.
      const rows = await eventsByKey(submitted.clientEventId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.summary).toBe('the first and only summary');

      // And nothing anywhere else under a different key.
      const all = await pool.query<{ n: string }>(
        `select count(*)::text as n from public.events where owner_id = $1 and problem_id = $2`,
        [ownerId, problemId],
      );
      expect(all.rows[0]?.n).toBe('1');

      expect(await readdir(directory)).toEqual([]);
    });

    it('sends the same key and the same payload at every attempt', async () => {
      const problemId = await newProblem('the event sent twice');
      const queue = newQueue();
      const coordinator = createReliableWriteCoordinator(queue);
      const context: DeliveryContext = { ownerId };

      const first = delivery({ loseAnswer: true });
      const submitted = await coordinator.submitEvent(
        {
          ownerId,
          problemId,
          problemImportant: false,
          payload: {
            eventType: 'ATTEMPT',
            summary: 'the same words both times',
            reason: 'the same reason both times',
          },
        },
        AT,
        context,
        first,
      );

      const restarted = newQueue();
      const held = (await restarted.list()).items[0];
      const second = delivery();
      await restarted.drain(new Date(held?.nextAttemptAt ?? AT), context, second);

      // Compared field by field rather than by key alone. A retry that changed
      // the payload would be a different write wearing the same name, and the
      // server would silently keep the first — hiding the bug.
      expect(second.seen[0]?.body).toEqual(first.seen[0]?.body);
      expect(second.seen[0]?.item.write).toEqual(first.seen[0]?.item.write);
      expect(second.seen[0]?.item.write.clientEventId).toBe(submitted.clientEventId);
    });
  });

  describe('a Verification whose answer was lost', () => {
    it('is stored once, with what the first attempt said', async () => {
      const problemId = await newProblem('the verification whose answer was lost');
      const queue = newQueue();
      const coordinator = createReliableWriteCoordinator(queue);
      const context: DeliveryContext = { ownerId };

      const first = delivery({ loseAnswer: true });
      const submitted = await coordinator.submitVerification(
        {
          ownerId,
          problemId,
          problemImportant: false,
          payload: {
            verificationType: 'TEST',
            result: true,
            summary: 'the suite agreed, once',
          },
        },
        AT,
        context,
        first,
      );

      expect(submitted.outcome).toBe('QUEUED');
      expect(await verificationsByKey(submitted.clientEventId)).toHaveLength(1);

      const restarted = newQueue();
      const held = (await restarted.list()).items[0];
      const second = delivery();
      const report = await restarted.drain(new Date(held?.nextAttemptAt ?? AT), context, second);

      expect(report.results.map((result) => result.outcome)).toEqual(['DELIVERED']);

      const rows = await verificationsByKey(submitted.clientEventId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.summary).toBe('the suite agreed, once');
      expect(rows[0]?.result).toBe(true);

      const all = await pool.query<{ n: string }>(
        `select count(*)::text as n from public.verifications
          where owner_id = $1 and problem_id = $2`,
        [ownerId, problemId],
      );
      expect(all.rows[0]?.n).toBe('1');
      expect(await readdir(directory)).toEqual([]);
    });
  });

  describe('two drains of the same item at once', () => {
    it('leaves one row, because the server refuses the second write', async () => {
      const problemId = await newProblem('the event drained twice at once');
      const queue = newQueue();
      const coordinator = createReliableWriteCoordinator(queue);
      const context: DeliveryContext = { ownerId };

      // Queued by a first attempt whose answer was lost, so there is an item
      // to race over.
      const submitted = await coordinator.submitEvent(
        {
          ownerId,
          problemId,
          problemImportant: false,
          payload: { eventType: 'FIX', summary: 'raced' },
        },
        AT,
        context,
        delivery({ loseAnswer: true }),
      );

      // Two queue instances over one directory, exactly as two processes would
      // be. There is no lock, deliberately: the queue promises at-least-once
      // and the server is what makes the effect happen once.
      const a = newQueue();
      const b = newQueue();
      const held = (await a.list()).items[0];
      const due = new Date(held?.nextAttemptAt ?? AT);

      const deliveryA = delivery();
      const deliveryB = delivery();
      const [reportA, reportB] = await Promise.all([
        a.drain(due, context, deliveryA),
        b.drain(due, context, deliveryB),
      ]);

      // Both may well have posted. Neither is an error.
      const attempts = deliveryA.seen.length + deliveryB.seen.length;
      expect(attempts).toBeGreaterThanOrEqual(1);
      for (const report of [reportA, reportB]) {
        for (const result of report.results) {
          expect(result.outcome).toBe('DELIVERED');
        }
      }

      // Three writes may have reached the server for this key across the whole
      // test. One row.
      expect(await eventsByKey(submitted.clientEventId)).toHaveLength(1);
      expect(await readdir(directory)).toEqual([]);
    });
  });

  describe('what the server keeps when a key is reused', () => {
    it('keeps the first write, and the retry cannot change it', async () => {
      const problemId = await newProblem('the event whose retry lied');
      const queue = newQueue();
      const coordinator = createReliableWriteCoordinator(queue);
      const context: DeliveryContext = { ownerId };

      const submitted = await coordinator.submitEvent(
        {
          ownerId,
          problemId,
          problemImportant: false,
          payload: { eventType: 'HYPOTHESIS', summary: 'what was true' },
        },
        AT,
        context,
        delivery({ loseAnswer: true }),
      );

      // A hand-written second write under the same key, with different
      // content — what a bug that rewrote a queued payload would produce.
      const response = await fetch(`${baseUrl}/v1/problems/${problemId}/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          event_type: 'FIX',
          summary: 'what was not true',
          client_event_id: submitted.clientEventId,
        }),
      });

      expect(response.status).toBe(201);
      const returned = (await response.json()) as { summary: string; event_type: string };
      // The server answers with the original, so a client cannot tell which
      // attempt landed — and does not have to.
      expect(returned.summary).toBe('what was true');
      expect(returned.event_type).toBe('HYPOTHESIS');

      const rows = await eventsByKey(submitted.clientEventId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.summary).toBe('what was true');

      for (const name of await readdir(directory)) {
        await rm(join(directory, name));
      }
    });
  });

  describe('the key belongs to one table and one owner', () => {
    it('lets an Event and a Verification share a key, one row each', async () => {
      const problemId = await newProblem('the shared key');
      const context: DeliveryContext = { ownerId };
      const queue = newQueue();
      const coordinator = createReliableWriteCoordinator(queue);

      const event = await coordinator.submitEvent(
        {
          ownerId,
          problemId,
          problemImportant: false,
          payload: { eventType: 'DISCOVERY', summary: 'the event' },
        },
        AT,
        context,
        delivery(),
      );
      expect(event.outcome).toBe('DELIVERED');

      // The same key, sent by hand to the other endpoint. The two tables have
      // separate unique constraints, so this is a different write with the
      // same name — and both are kept.
      const response = await fetch(`${baseUrl}/v1/problems/${problemId}/verifications`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          verification_type: 'BUILD',
          result: true,
          summary: 'the verification',
          client_event_id: event.clientEventId,
        }),
      });
      expect(response.status).toBe(201);

      expect(await eventsByKey(event.clientEventId)).toHaveLength(1);
      expect(await verificationsByKey(event.clientEventId)).toHaveLength(1);
    });

    it('lets two owners use one key, one row each', async () => {
      const problemId = await newProblem('my side of the shared key');
      const queue = newQueue();
      const coordinator = createReliableWriteCoordinator(queue);

      const mine = await coordinator.submitEvent(
        {
          ownerId,
          problemId,
          problemImportant: false,
          payload: { eventType: 'DISCOVERY', summary: 'mine' },
        },
        AT,
        { ownerId },
        delivery(),
      );
      expect(mine.outcome).toBe('DELIVERED');

      // A second owner, with their own credential, their own project and their
      // own Problem — reusing the key. The constraint is per owner.
      const otherOwner = generateOwnerId();
      await insertOwnerIfAbsent(pool, otherOwner);
      ownersCreated.push(otherOwner);
      const otherCredential = generateCredentialToken();
      await createCredentialRepository(pool).issueClientCredential({
        clientId: generateClientId(),
        ownerId: otherOwner,
        label: 'the other owner',
        credentialId: generateCredentialId(),
        tokenLookup: otherCredential.lookup,
        tokenHash: hashCredentialSecret(otherCredential.secret),
      });
      const otherToken = formatCredentialToken(otherCredential);

      const theirHeaders = {
        'content-type': 'application/json',
        authorization: `Bearer ${otherToken}`,
      };
      const theirProject = (await (
        await fetch(`${baseUrl}/v1/projects`, {
          method: 'POST',
          headers: theirHeaders,
          body: JSON.stringify({ project_name: 'theirs' }),
        })
      ).json()) as Record<string, string>;
      const theirEnvironment = (await (
        await fetch(`${baseUrl}/v1/projects/${theirProject['project_id'] ?? ''}/environments`, {
          method: 'POST',
          headers: theirHeaders,
          body: JSON.stringify({ snapshot: { runtime: 'node 22' } }),
        })
      ).json()) as Record<string, string>;
      const theirProblem = (await (
        await fetch(`${baseUrl}/v1/projects/${theirProject['project_id'] ?? ''}/problems`, {
          method: 'POST',
          headers: theirHeaders,
          body: JSON.stringify({
            environment_id: theirEnvironment['environment_id'] ?? '',
            title: 'their side of the shared key',
            symptoms: 'symptoms',
          }),
        })
      ).json()) as Record<string, string>;

      const theirs = await fetch(
        `${baseUrl}/v1/problems/${theirProblem['problem_id'] ?? ''}/events`,
        {
          method: 'POST',
          headers: theirHeaders,
          body: JSON.stringify({
            event_type: 'DISCOVERY',
            summary: 'theirs',
            client_event_id: mine.clientEventId,
          }),
        },
      );
      expect(theirs.status).toBe(201);

      const rows = await pool.query<{ owner_id: string; summary: string }>(
        `select owner_id::text, summary from public.events where client_event_id = $1 order by summary`,
        [mine.clientEventId],
      );
      // One each. The key is not a global identifier and the queue never
      // treats it as one.
      expect(rows.rows.map((row) => row.summary)).toEqual(['mine', 'theirs']);
    });
  });

  describe('when the write cannot be made durable', () => {
    it('sends nothing at all when the queue is full', async () => {
      const problemId = await newProblem('the write that could not be recorded');
      const full = createRetryQueue({
        directory: await mkdtemp(join(tmpdir(), 'memory-replay-full-')),
        limits: { ...LIMITS, maxItems: 0 },
        policy: POLICY,
      });
      const coordinator = createReliableWriteCoordinator(full);
      const attempted = delivery();

      await expect(
        coordinator.submitEvent(
          {
            ownerId,
            problemId,
            problemImportant: false,
            payload: { eventType: 'FIX', summary: 'never sent' },
          },
          AT,
          { ownerId },
          attempted,
        ),
      ).rejects.toBeInstanceOf(QueueCapacityError);

      // The point of writing first: a write that could not be recorded is not
      // sent. Falling back to sending directly would reintroduce exactly the
      // window this design closes, at the moment the system is least able to
      // track what happened.
      expect(attempted.seen).toHaveLength(0);
      const all = await pool.query<{ n: string }>(
        `select count(*)::text as n from public.events where owner_id = $1 and problem_id = $2`,
        [ownerId, problemId],
      );
      expect(all.rows[0]?.n).toBe('0');
    });

    it('sends nothing at all when the payload is refused', async () => {
      const problemId = await newProblem('the write that held a key');
      const queue = newQueue();
      const coordinator = createReliableWriteCoordinator(queue);
      const attempted = delivery();

      await expect(
        coordinator.submitEvent(
          {
            ownerId,
            problemId,
            problemImportant: false,
            payload: {
              eventType: 'DISCOVERY',
              summary: 'a private key, whole',
              reason: '-----BEGIN PRIVATE KEY-----\nAKIAEXAMPLEEXAMPLE',
            },
          },
          AT,
          { ownerId },
          attempted,
        ),
      ).rejects.toBeInstanceOf(SanitizationRejectedError);

      expect(attempted.seen).toHaveLength(0);
      const all = await pool.query<{ n: string }>(
        `select count(*)::text as n from public.events where owner_id = $1 and problem_id = $2`,
        [ownerId, problemId],
      );
      expect(all.rows[0]?.n).toBe('0');
    });
  });

  describe('what the first attempt carries', () => {
    it('sends the redacted payload on the first attempt, not only on the retry', async () => {
      const problemId = await newProblem('the write that held a credential');
      const queue = newQueue();
      const coordinator = createReliableWriteCoordinator(queue);
      const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
      const sent = delivery();

      const submitted = await coordinator.submitEvent(
        {
          ownerId,
          problemId,
          problemImportant: false,
          payload: {
            eventType: 'DISCOVERY',
            summary: `it worked once I set AWS_SECRET_ACCESS_KEY=${secret}`,
          },
        },
        AT,
        { ownerId },
        sent,
      );

      expect(submitted.outcome).toBe('DELIVERED');

      // The first attempt already carries the redacted text. Sending the
      // caller's original once and the sanitized version thereafter would put
      // the credential on the wire exactly once — which is once too many, and
      // would be invisible to a test that only inspected retries.
      expect(JSON.stringify(sent.seen[0]?.body)).not.toContain(secret);
      expect(JSON.stringify(sent.seen[0]?.body)).toContain('[REDACTED]');

      const stored = await eventsByKey(submitted.clientEventId);
      expect(stored[0]?.summary).not.toContain(secret);

      // And nothing was left on disk holding it either.
      const names = await readdir(directory);
      const contents = await Promise.all(
        names.map((name) => readFile(join(directory, name), 'utf8')),
      );
      expect(contents.join('\n')).not.toContain(secret);
    });
  });
});
