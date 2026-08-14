/**
 * The failure the queue exists for, reproduced rather than simulated.
 *
 * A real server on a real port, a real credential, a real database, and a real
 * socket that stops answering. `inject` would not do: it calls the handler
 * directly, so there is no connection to refuse, and the case being tested is
 * precisely the one where nothing is listening.
 *
 * The delivery implementation lives in this file and only here. The library
 * ships an interface and no HTTP client, because choosing a transport, a
 * timeout and a credential source on behalf of adapters that do not exist yet
 * is how a library acquires behaviour nobody picked. This one is a test
 * fixture: `fetch`, a bearer token, and a translation of what came back into
 * the closed outcome the queue understands.
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
import { generateClientEventId } from '../../src/domain/client-event-id.js';
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
  type DeliveryContext,
  type DeliveryOutcome,
  type QueueItem,
  type RetryDelivery,
} from '../../src/reliability/index.js';
import type { ErrorCode } from '../../src/http/errors.js';

const databaseUrl = readDatabaseUrl();

const LIMITS = { maxItems: 100, maxItemBytes: 64 * 1024, maxTotalBytes: 4 * 1024 * 1024 };
const POLICY = { baseDelayMs: 1_000, maxDelayMs: 30_000, maxAttempts: 5 };

/**
 * The delivery an adapter will eventually ship, in miniature.
 *
 * Everything it knows that the queue does not: the base URL, the credential,
 * and how to read a response. What crosses back is a closed outcome, so
 * nothing the server wrote can reach a durable file by travelling through
 * here.
 */
function httpDelivery(baseUrl: () => string, token: () => string): RetryDelivery {
  return {
    async deliver(item: QueueItem): Promise<DeliveryOutcome> {
      const path =
        item.write.operation === 'appendEvent'
          ? `/v1/problems/${item.write.problemId}/events`
          : `/v1/problems/${item.write.problemId}/verifications`;

      const body =
        item.write.operation === 'appendEvent'
          ? {
              event_type: item.write.payload.eventType,
              summary: item.write.payload.summary,
              ...(item.write.payload.reason == null ? {} : { reason: item.write.payload.reason }),
              ...(item.write.payload.sourceAi == null
                ? {}
                : { source_ai: item.write.payload.sourceAi }),
              // Assembled here from the top-level key, which is the single
              // source of truth and is never regenerated.
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
        response = await fetch(`${baseUrl()}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}` },
          body: JSON.stringify(body),
        });
      } catch {
        // Refused, reset, unresolvable, timed out. Which one makes no
        // difference to the decision, and the detail is a string somebody
        // else wrote.
        return { kind: 'TRANSPORT_FAILURE' };
      }

      if (response.ok) {
        return { kind: 'SUCCESS' };
      }

      let errorCode: ErrorCode | undefined;
      try {
        const envelope = (await response.json()) as { error?: { code?: ErrorCode } };
        errorCode = envelope.error?.code;
      } catch {
        // A body that is not the envelope. The status is enough.
      }

      return {
        kind: 'HTTP_FAILURE',
        status: response.status,
        ...(errorCode === undefined ? {} : { errorCode }),
      };
    },
  };
}

describe.skipIf(databaseUrl === undefined)('a write that could not be sent', () => {
  let pool: DatabasePool;
  let app: FastifyInstance;
  let baseUrl = '';
  let directory: string;
  let ownerId: OwnerId;
  let token = '';
  let problemId: ProblemId;
  const ownersCreated: OwnerId[] = [];

  function build(): FastifyInstance {
    return buildMemoryHttpApp({
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
  }

  /** Starts a server on an ephemeral port and returns its base URL. */
  async function listen(): Promise<string> {
    app = build();
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    return address;
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

  const eventsFor = async (problem: ProblemId): Promise<string[]> =>
    (
      await pool.query<{ client_event_id: string }>(
        `select client_event_id::text as client_event_id
           from public.events where owner_id = $1 and problem_id = $2
          order by created_at asc, event_id asc`,
        [ownerId, problem],
      )
    ).rows.map((row) => row.client_event_id);

  beforeAll(async () => {
    pool = createPool(resolveDatabaseConfig({ nodeEnv: 'test', connectionTimeoutMillis: 5_000 }));
    directory = await mkdtemp(join(tmpdir(), 'memory-retry-e2e-'));

    ownerId = generateOwnerId();
    await insertOwnerIfAbsent(pool, ownerId);
    ownersCreated.push(ownerId);

    const credential = generateCredentialToken();
    await createCredentialRepository(pool).issueClientCredential({
      clientId: generateClientId(),
      ownerId,
      label: 'retry queue test client',
      credentialId: generateCredentialId(),
      tokenLookup: credential.lookup,
      tokenHash: hashCredentialSecret(credential.secret),
    });
    token = formatCredentialToken(credential);

    baseUrl = await listen();

    const project = await post('/v1/projects', { project_name: 'retry queue' });
    const environment = await post(`/v1/projects/${project['project_id'] ?? ''}/environments`, {
      snapshot: { runtime: 'node 22' },
    });
    const problem = await post(`/v1/projects/${project['project_id'] ?? ''}/problems`, {
      environment_id: environment['environment_id'] ?? '',
      title: 'the write that had to wait',
      symptoms: 'the server was not there',
    });
    problemId = (problem['problem_id'] ?? '') as ProblemId;
  });

  afterAll(async () => {
    try {
      await app.close();
    } catch {
      // Already closed by a test that stopped the server.
    }
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

  it('survives the server going away and reaches it when it comes back', async () => {
    const queue = createRetryQueue({ directory, limits: LIMITS, policy: POLICY });
    const context: DeliveryContext = { ownerId };
    const delivery = httpDelivery(
      () => baseUrl,
      () => token,
    );

    // The key is assigned once, by the coordinator, before anything is sent.
    // Every attempt below carries that exact value.
    const write = {
      operation: 'appendEvent',
      ownerId,
      problemId,
      clientEventId: generateClientEventId(),
      payload: {
        eventType: 'DISCOVERY',
        summary: 'found it while the server was down',
        sourceAi: 'claude-code',
      },
    } as const;

    // --- the server goes away -------------------------------------------
    await app.close();

    // The assistant's own work carries on. This sentinel stands in for it:
    // whatever the queue does, it must not throw into the work that was
    // happening. What the caller is *told* is P3-09's contract; that it is not
    // an exception is this task's.
    let mainWorkFinished = false;
    const enqueuedAt = new Date('2026-08-14T10:00:00.000Z');

    const submitted = await (async () => {
      // The production path, since P3-08: the coordinator makes the write
      // durable and then attempts it, so there is no hand-built item here and
      // no window between the failure and the record of it.
      const result = await createReliableWriteCoordinator(queue).submitEvent(
        {
          ownerId: write.ownerId,
          problemId: write.problemId,
          payload: write.payload,
        },
        enqueuedAt,
        context,
        delivery,
      );
      mainWorkFinished = true;
      return result;
    })();

    expect(submitted.outcome).toBe('QUEUED');
    expect(mainWorkFinished).toBe(true);
    const clientEventId = submitted.clientEventId;

    // Nothing reached the database.
    expect(await eventsFor(problemId)).toEqual([]);

    // --- the process ends and starts again ------------------------------
    const restarted = createRetryQueue({ directory, limits: LIMITS, policy: POLICY });
    const held = (await restarted.list()).items;
    expect(held).toHaveLength(1);
    expect(held[0]?.write.clientEventId).toBe(clientEventId);
    expect(held[0]?.attemptCount).toBe(1);

    // --- the server comes back ------------------------------------------
    baseUrl = await listen();

    const due = new Date(held[0]?.nextAttemptAt ?? enqueuedAt);
    const report = await restarted.drain(due, context, delivery);

    expect(report.results.map((result) => result.outcome)).toEqual(['DELIVERED']);

    // The same key that was generated before the first attempt, which is what
    // makes a resend safe. Proving that one resend leaves one row end to end
    // is P3-08; this is the half that must already be true for it.
    expect(await eventsFor(problemId)).toEqual([clientEventId]);

    // Delivered items are removed. Only what is undelivered is kept.
    expect(await readdir(directory)).toEqual([]);
  });

  it('keeps an Event for a deleted Problem instead of resurrecting it', async () => {
    const queue = createRetryQueue({ directory, limits: LIMITS, policy: POLICY });
    const context: DeliveryContext = { ownerId };
    const delivery = httpDelivery(
      () => baseUrl,
      () => token,
    );

    const project = await post('/v1/projects', { project_name: 'deleted target' });
    const environment = await post(`/v1/projects/${project['project_id'] ?? ''}/environments`, {
      snapshot: { runtime: 'node 22' },
    });
    const doomed = await post(`/v1/projects/${project['project_id'] ?? ''}/problems`, {
      environment_id: environment['environment_id'] ?? '',
      title: 'about to be removed',
      symptoms: 'x',
    });
    const doomedId = (doomed['problem_id'] ?? '') as ProblemId;

    await queue.enqueue(
      {
        operation: 'appendEvent',
        ownerId,
        problemId: doomedId,
        clientEventId: generateClientEventId(),
        payload: { eventType: 'DISCOVERY', summary: 'arrived after the delete' },
      },
      new Date('2026-08-14T10:00:00.000Z'),
    );

    const deleted = await fetch(`${baseUrl}/v1/problems/${doomedId}?expected_version=1`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(deleted.status).toBe(204);

    const report = await queue.drain(new Date('2026-08-14T10:00:00.000Z'), context, delivery);

    // A 404 is the server saying the Problem is gone, and P3-05 leaves nothing
    // to bring back. Retrying would ask for the same absent row forever.
    expect(report.results.map((result) => result.outcome)).toEqual(['PERMANENT_FAILURE']);

    const { items } = await queue.list();
    expect(items).toHaveLength(1);
    expect(items[0]?.terminalFailure).toBe('PERMANENT_RESPONSE');
    // The Problem stays deleted, the problem id is untouched, and no new
    // Problem is invented to hold the orphaned Event. It waits to be reported.
    expect(items[0]?.write.problemId).toBe(doomedId);
    const survivors = await pool.query<{ n: string }>(
      `select count(*)::text as n from public.problems where owner_id = $1 and problem_id = $2`,
      [ownerId, doomedId],
    );
    expect(survivors.rows[0]?.n).toBe('0');

    for (const name of await readdir(directory)) {
      await rm(join(directory, name));
    }
  });

  it('refuses a revoked credential without spending the item', async () => {
    const queue = createRetryQueue({ directory, limits: LIMITS, policy: POLICY });
    const context: DeliveryContext = { ownerId };

    const clientEventId = generateClientEventId();
    await queue.enqueue(
      {
        operation: 'appendVerification',
        ownerId,
        problemId,
        clientEventId,
        payload: { verificationType: 'TEST', result: true, summary: 'checked while offline' },
      },
      new Date('2026-08-14T10:00:00.000Z'),
    );

    // A credential that is well-formed and not this owner's.
    const stranger = generateCredentialToken();
    const withStranger = httpDelivery(
      () => baseUrl,
      () => formatCredentialToken(stranger),
    );

    const refused = await queue.drain(new Date('2026-08-14T10:00:00.000Z'), context, withStranger);
    expect(refused.results.map((result) => result.outcome)).toEqual(['AUTH_REQUIRED']);
    const held = (await queue.list()).items[0];
    expect(held?.attemptCount).toBe(0);
    expect(held?.terminalFailure).toBeNull();

    // The owner's real credential — a different one from the item's point of
    // view, since the item never recorded which credential produced it.
    const delivered = await queue.drain(
      new Date('2026-08-14T10:00:00.000Z'),
      context,
      httpDelivery(
        () => baseUrl,
        () => token,
      ),
    );
    expect(delivered.results.map((result) => result.outcome)).toEqual(['DELIVERED']);

    const stored = await pool.query<{ client_event_id: string }>(
      `select client_event_id::text from public.verifications where owner_id = $1`,
      [ownerId],
    );
    expect(stored.rows.map((row) => row.client_event_id)).toContain(clientEventId);
  });

  it('writes no credential into the queue directory', async () => {
    const queue = createRetryQueue({ directory, limits: LIMITS, policy: POLICY });

    await queue.enqueue(
      {
        operation: 'appendEvent',
        ownerId,
        problemId,
        clientEventId: generateClientEventId(),
        payload: { eventType: 'FIX', summary: 'a note about the fix' },
      },
      new Date('2026-08-14T10:00:00.000Z'),
    );

    const names = await readdir(directory);
    const contents = await Promise.all(
      names.map((name) => readFile(join(directory, name), 'utf8')),
    );
    const everything = contents.join('\n');

    // The credential that authenticated every request in this file, and the
    // stored halves of it. A queue file gets copied by whatever backs up a
    // home directory; a token in one is a token in a backup.
    expect(everything).not.toContain(token);
    expect(everything).not.toContain(token.split('_')[1] ?? 'lookup');
    expect(everything.toLowerCase()).not.toContain('authorization');
    expect(everything.toLowerCase()).not.toContain('bearer');

    for (const name of names) {
      await rm(join(directory, name));
    }
  });
});
