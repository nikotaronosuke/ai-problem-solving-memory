/**
 * Phase 3, end to end.
 *
 * One secret-bearing investigation is carried through everything Phase 3
 * built, in order and on the same state: a secret arrives over a real socket
 * and is stored without it; the server goes away and the caller's work does
 * not; a second secret-bearing write waits on disk, redacted; the server
 * returns and the write lands exactly once; the Problem is then deleted for
 * good; and what remains leaves the system as an export.
 *
 * What this proves is not that any step works — each has its own suite, with
 * depth this file deliberately does not repeat. It is that the steps compose:
 * the id one step returns is the id the next attacks, the version a PATCH
 * answers is the version the DELETE presents, the key given to a queued write
 * before the outage is the key found in the database after recovery, and the
 * owner who saved everything is the owner whose export no longer contains it.
 * That continuity is the one thing a per-boundary test cannot check, and it is
 * Phase 3's definition of done.
 *
 * Two secret-bearing Events, and the distinction is load-bearing. The retry
 * queue redacts a payload *before* writing it to disk, so a write that travels
 * through the queue never presents a raw secret to the server — which means an
 * outage scenario alone cannot prove server-side sanitization, the one thing
 * the specification names as mandatory. Event A therefore goes straight at the
 * running server with the secret still raw; Event B goes through the outage.
 * Dropping either would silently drop a claim.
 *
 * Everything is real: PostgreSQL, a generated owner, a credential issued the
 * way the CLI issues one, the production application composition, the
 * production logger configuration with only its stream replaced, a listening
 * socket on an ephemeral port, an actual connection failure, and a filesystem
 * retry queue in a temporary directory. Nothing is substituted and nothing
 * waits on a clock: the retry runs at the moment the persisted schedule names.
 *
 * Skipped when `DATABASE_URL` is not set.
 */

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

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
import { resolveOwnerContextFor } from '../../src/owner/context.js';
import { createRetrievalArtifactRepository } from '../../src/repository/index.js';
import { createArtifactInspectionPolicy, withSanitization } from '../../src/sanitization/index.js';
import type { ErrorCode } from '../../src/http/errors.js';
import { buildMemoryHttpApp, createLoggerOptions } from '../../src/http/index.js';
import {
  createReliableWriteCoordinator,
  createRetryQueue,
  submitEventWithFallback,
  type DeliveryContext,
  type DeliveryOutcome,
  type QueueItem,
  type RetryDelivery,
  type RetryQueue,
} from '../../src/reliability/index.js';
import { createUnusedSearchResolver } from '../support/search-resolver.js';

const databaseUrl = readDatabaseUrl();

const LIMITS = { maxItems: 100, maxItemBytes: 64 * 1024, maxTotalBytes: 4 * 1024 * 1024 };
const POLICY = { baseDelayMs: 1_000, maxDelayMs: 30_000, maxAttempts: 5 };

/**
 * The eight collections an export carries.
 *
 * Deliberately not the same list as the tables swept below. An export is the
 * Memory somebody owns; `retrieval_artifacts` is a rendering of it built for a
 * search, regenerable and tied to whichever embedding model made it, so it does
 * not travel. The two lists differing by exactly that one name is the point.
 */
const EXPORT_COLLECTIONS = [
  'projects',
  'environments',
  'problems',
  'events',
  'verifications',
  'relations',
  'usage_logs',
  'change_logs',
] as const;

/** Every owner-scoped table holding anything, for sweeps. */
const MEMORY_TABLES = [
  'projects',
  'environments',
  'problems',
  'events',
  'verifications',
  'relations',
  'usage_logs',
  'change_logs',
  // Derived rather than recorded, and swept with the rest since P4-01.
  'retrieval_artifacts',
] as const;

/**
 * The delivery an adapter will eventually ship, in miniature — the same
 * test-local shape `server-down.integration` uses. The base URL and the
 * credential are read through closures, so a server restarted on a new
 * ephemeral port is picked up without rebuilding anything.
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

// `sequential` stated rather than assumed: within one file Vitest runs tests
// in order by default, but this file shares a server lifecycle across steps,
// and that assumption deserves to be visible and enforced.
describe.skipIf(databaseUrl === undefined)('Phase 3, end to end', { sequential: true }, () => {
  let pool: DatabasePool;
  let app: FastifyInstance | undefined;
  let baseUrl = '';
  let queueDirectory: string;
  const ownersCreated: OwnerId[] = [];

  /**
   * Every line the production logger writes, across every server this file
   * starts. One array outlives the restarts, so the final sweep covers the
   * whole story rather than the last chapter.
   */
  const logLines: string[] = [];

  /**
   * Every response body a step read, so the end of the file can say "no raw
   * secret came back over HTTP at any point" about all of them at once.
   */
  const responseBodies: string[] = [];

  // ---- the cast -----------------------------------------------------------

  let ownerId: OwnerId;
  let token = '';

  let projectId = '';
  let environmentId = '';

  /** The Problem the whole flow follows, and later deletes. */
  let targetId = '';
  /** Its version as of the importance PATCH — what the DELETE must present. */
  let targetVersion = 0;

  /** The Problem that must survive the delete, or nothing below means much. */
  let survivorId = '';

  /** Ordinary prose planted in the target and in the survivor, respectively. */
  const TARGET_MARKER = `p312target${randomUUID().replaceAll('-', '')}`;
  const CONTROL_MARKER = `p312control${randomUUID().replaceAll('-', '')}`;

  /**
   * The two synthetic secrets. Values only — the `AWS_SECRET_ACCESS_KEY=`
   * prefix that makes the detector confirm them is applied where they are
   * written, so sweeping for the value alone finds the secret wherever it
   * leaked, prefixed or not.
   */
  const SECRET_A = `a3${randomUUID().replaceAll('-', '')}A9${randomUUID().replaceAll('-', '').slice(0, 6)}`;
  const SECRET_B = `b7${randomUUID().replaceAll('-', '')}Z2${randomUUID().replaceAll('-', '').slice(0, 6)}`;

  /** The idempotency keys, one per Event, held so counts can be key-specific. */
  const EVENT_A_KEY = randomUUID();
  let eventBKey = '';

  /** Carried between the outage steps and the recovery steps. */
  let restartedQueue: RetryQueue | undefined;
  let persistedDue: Date | undefined;

  // ---- machinery ----------------------------------------------------------

  function build(): FastifyInstance {
    return buildMemoryHttpApp({
      retrievalSearchResolver: createUnusedSearchResolver(),
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
      logger: {
        // The production configuration, not a copy of it. Only the stream is
        // replaced, and every server this file starts writes to the same sink.
        ...createLoggerOptions('trace'),
        stream: {
          write(line: string) {
            logLines.push(line);
          },
        },
      },
    });
  }

  async function listen(): Promise<void> {
    app = build();
    baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  }

  async function request(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    payload?: unknown,
  ): Promise<{ status: number; body: string }> {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const body = await response.text();
    responseBodies.push(body);
    return { status: response.status, body };
  }

  async function post(path: string, payload: unknown): Promise<Record<string, unknown>> {
    const response = await request('POST', path, payload);
    expect(response.status, `${path} -> ${response.body}`).toBe(201);
    return JSON.parse(response.body) as Record<string, unknown>;
  }

  /** Everything the owner has, in every Memory table, as one string. */
  async function sweepOwner(): Promise<string> {
    const dumps: string[] = [];
    for (const table of MEMORY_TABLES) {
      const rows = await pool.query(
        `select to_jsonb(t) as row from public.${table} t where owner_id = $1`,
        [ownerId],
      );
      dumps.push(JSON.stringify(rows.rows));
    }
    return dumps.join('\n');
  }

  /** How many events carry one of this flow's keys. Never a bare total. */
  async function eventCount(clientEventId: string): Promise<number> {
    const result = await pool.query<{ n: string }>(
      `select count(*) as n from public.events
        where owner_id = $1 and problem_id = $2 and client_event_id = $3`,
      [ownerId, targetId, clientEventId],
    );
    return Number(result.rows[0]?.n ?? '0');
  }

  /**
   * Whether a text carries the credential, answered as a boolean before it
   * reaches an assertion — so a failure prints `true`, never the token.
   */
  const carriesToken = (text: string): boolean => text.includes(token);

  beforeAll(async () => {
    pool = createPool(resolveDatabaseConfig({ nodeEnv: 'test', connectionTimeoutMillis: 5_000 }));
    queueDirectory = await mkdtemp(join(tmpdir(), 'memory-phase3-e2e-'));

    ownerId = generateOwnerId();
    await insertOwnerIfAbsent(pool, ownerId);
    ownersCreated.push(ownerId);

    const credential = generateCredentialToken();
    await createCredentialRepository(pool).issueClientCredential({
      clientId: generateClientId(),
      ownerId,
      label: 'phase 3 e2e client',
      credentialId: generateCredentialId(),
      tokenLookup: credential.lookup,
      tokenHash: hashCredentialSecret(credential.secret),
    });
    token = formatCredentialToken(credential);
  });

  afterAll(async () => {
    // Any step can fail with the server up, down, or half restarted.
    try {
      await app?.close();
    } catch {
      // Already closed by the outage step.
    }
    await rm(queueDirectory, { recursive: true, force: true });
    if (ownersCreated.length > 0) {
      await pool.query(
        `delete from public.client_credentials
          where client_id in (select client_id from public.clients where owner_id = any($1::uuid[]))`,
        [ownersCreated],
      );
      for (const table of [
        'retrieval_artifacts',
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

  it('1. finds the service serving, over a real socket', async () => {
    await listen();

    const health = await request('GET', '/health');
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toEqual({ status: 'ok' });
  });

  it('2. records the ground the flow stands on', async () => {
    const project = await post('/v1/projects', { project_name: 'phase 3 proving ground' });
    projectId = String(project['project_id']);

    const environment = await post(`/v1/projects/${projectId}/environments`, {
      snapshot: { runtime: 'node 22.12.0' },
    });
    environmentId = String(environment['environment_id']);

    const target = await post(`/v1/projects/${projectId}/problems`, {
      environment_id: environmentId,
      title: `deploys fail after rotation ${TARGET_MARKER}`,
      symptoms: `the pipeline stops at the credential step, ${TARGET_MARKER}`,
    });
    targetId = String(target['problem_id']);

    // The survivor exists so that "the target is gone" can be told apart from
    // "everything is gone". Its marker never appears in the target's rows.
    const survivor = await post(`/v1/projects/${projectId}/problems`, {
      environment_id: environmentId,
      title: `a different investigation ${CONTROL_MARKER}`,
      symptoms: `unrelated symptoms, ${CONTROL_MARKER}`,
    });
    survivorId = String(survivor['problem_id']);
  });

  it('3. marks the problem important, keeping the version the server answers', async () => {
    // P3-09 records importance with the write, and this file does not fake
    // it: the Problem really is important, so the quiet PENDING later is the
    // QUEUED-is-quiet contract and not "nobody asked". `importance` is only
    // settable by PATCH, which advances the version — kept here, never
    // hardcoded, because the DELETE at the end must present it.
    const response = await request('PATCH', `/v1/problems/${targetId}`, {
      expected_version: 1,
      changed_by: 'phase3-e2e',
      importance: true,
    });

    expect(response.status).toBe(200);
    const problem = JSON.parse(response.body) as { importance: boolean; version: number };
    expect(problem.importance).toBe(true);
    targetVersion = problem.version;
    expect(targetVersion).toBeGreaterThan(1);
  });

  it('4. accepts an event carrying a raw secret, and stores it without one', async () => {
    // Event A: the server-side proof. The secret is raw on the wire — nothing
    // between this request and the server's own boundary — because the queue
    // path below redacts before sending and so can never test this.
    const created = await post(`/v1/problems/${targetId}/events`, {
      event_type: 'DISCOVERY',
      summary: `the deploy log printed AWS_SECRET_ACCESS_KEY=${SECRET_A} before failing`,
      client_event_id: EVENT_A_KEY,
    });

    // Stored, once, under the key it was given.
    expect(await eventCount(EVENT_A_KEY)).toBe(1);

    // The response carries the record but not the secret.
    const body = JSON.stringify(created);
    expect(body).not.toContain(SECRET_A);
    expect(body).toContain('[REDACTED]');

    // Nor does anything the owner has, anywhere in the database — while the
    // sentence around the secret survives, which is what redaction is for.
    const stored = await sweepOwner();
    expect(stored).not.toContain(SECRET_A);
    expect(stored).toContain('AWS_SECRET_ACCESS_KEY=[REDACTED]');
    expect(stored).toContain('the deploy log printed');

    // And reading it back over HTTP gives the redacted form, not a cached raw.
    const list = await request('GET', `/v1/problems/${targetId}/events`);
    expect(list.status).toBe(200);
    expect(list.body).not.toContain(SECRET_A);
    expect(list.body).toContain('[REDACTED]');
  });

  it('5. loses the server, for real', async () => {
    await app?.close();

    // An actual connection failure on the port that was just serving —
    // the transport failure the queue exists for, not a stand-in for one.
    await expect(fetch(`${baseUrl}/health`)).rejects.toThrow();
  });

  it('6. queues the write and lets the caller carry on', async () => {
    const queue = createRetryQueue({
      directory: queueDirectory,
      limits: LIMITS,
      policy: POLICY,
    });
    const context: DeliveryContext = { ownerId };
    const delivery = httpDelivery(
      () => baseUrl,
      () => token,
    );

    // The caller's own work, standing outside the library — P3-09's boundary.
    // The library answers; it is never handed the work.
    let primaryWorkCompleted = false;

    const decision = await submitEventWithFallback(
      createReliableWriteCoordinator(queue),
      {
        ownerId,
        problemId: targetId as ProblemId,
        problemImportant: true,
        payload: {
          eventType: 'DISCOVERY',
          summary: `the replacement value AWS_SECRET_ACCESS_KEY=${SECRET_B} also failed`,
          reason: `observed while the server was away, ${TARGET_MARKER}`,
        },
      },
      new Date(),
      context,
      delivery,
    );
    if (decision.continueMainWork) {
      primaryWorkCompleted = true;
    }

    // Durable, retryable, and quiet — for an *important* Problem, which is
    // what makes the silence P3-09's QUEUED-is-quiet contract rather than
    // an importance nobody declared. The key the coordinator assigned is not
    // in the decision — a caller correlates by what it asked, not by internal
    // ids — so the next step reads it from where it durably lives: the file.
    expect(decision.continueMainWork).toBe(true);
    expect(decision.memoryState).toBe('PENDING');
    expect(decision.noticeIntent).toBeNull();
    expect(primaryWorkCompleted).toBe(true);
  });

  it('7. holds the write on disk, redacted and without a credential', async () => {
    const files = await readdir(queueDirectory);
    expect(files).toHaveLength(1);

    const text = await readFile(join(queueDirectory, files[0] ?? ''), 'utf8');
    const item = JSON.parse(text) as {
      schema_version: string;
      problem_important: boolean;
      client_event_id: string;
    };

    expect(item.schema_version).toBe('2');
    expect(item.problem_important).toBe(true);

    // The key this write will carry for as long as it exists, assigned by the
    // coordinator before the first attempt. Held from here on, so the
    // exactly-once claim after recovery is about *this* key.
    eventBKey = item.client_event_id;
    expect(eventBKey).not.toBe('');
    expect(eventBKey).not.toBe(EVENT_A_KEY);

    // The queue redacted before writing: the raw secret never reached the
    // disk, while the sentence it sat in did.
    expect(text).not.toContain(SECRET_B);
    expect(text).toContain('AWS_SECRET_ACCESS_KEY=[REDACTED]');
    expect(text).toContain('the replacement value');

    // No credential travelled into the file. As a boolean, so a failure
    // reports `true` rather than printing the token.
    expect(carriesToken(text), 'the retry queue carried the Memory credential').toBe(false);
  });

  it('8. has written nothing to the database yet', async () => {
    // The outage write waits on disk and nowhere else; the direct write from
    // before the outage is untouched. Key-specific counts, never a bare
    // total — both Events belong to the same Problem.
    expect(await eventCount(eventBKey)).toBe(0);
    expect(await eventCount(EVENT_A_KEY)).toBe(1);
  });

  it('9. survives a restart of the queue itself', async () => {
    // The first queue instance is gone with the process that owned it. A new
    // one over the same directory finds the write — durability, not memory.
    restartedQueue = createRetryQueue({
      directory: queueDirectory,
      limits: LIMITS,
      policy: POLICY,
    });

    const listed = await restartedQueue.list();
    expect(listed.corruptCount).toBe(0);
    expect(listed.items).toHaveLength(1);

    const item = listed.items[0];
    expect(item?.write.clientEventId).toBe(eventBKey);
    expect(item?.attemptCount).toBe(1);
    expect(item?.terminalFailure).toBeNull();

    // The moment the item itself says it is next due. The drain below runs at
    // that moment — read from the file, not waited for on a clock.
    persistedDue = new Date(item?.nextAttemptAt ?? '');
    expect(Number.isNaN(persistedDue.getTime())).toBe(false);
  });

  it('10. delivers exactly once when the server returns', async () => {
    await listen();

    const report = await restartedQueue!.drain(
      persistedDue!,
      { ownerId },
      httpDelivery(
        () => baseUrl,
        () => token,
      ),
    );

    expect(report.results).toHaveLength(1);
    expect(report.results[0]?.outcome).toBe('DELIVERED');

    // Exactly one row, under the key assigned before the outage — the same
    // write, not a second one, and still without its secret.
    expect(await eventCount(eventBKey)).toBe(1);
    expect(await eventCount(EVENT_A_KEY)).toBe(1);

    const stored = await sweepOwner();
    expect(stored).not.toContain(SECRET_B);
    expect(stored).toContain('the replacement value AWS_SECRET_ACCESS_KEY=[REDACTED]');

    // Delivered means cleared: the queue holds nothing it would send again.
    expect(await readdir(queueDirectory)).toHaveLength(0);
  });

  it('11. removes the problem and everything it carried', async () => {
    // The derived store, given something to lose. P4-01 added the first one,
    // and a delete that is never asked to remove an artifact proves nothing
    // about artifacts — so the target gets one, written through the same
    // boundary production writes through, carrying the same marker.
    const context = await resolveOwnerContextFor(pool, ownerId);
    const artifacts = withSanitization(
      createRetrievalArtifactRepository(pool, context),
      createArtifactInspectionPolicy(),
    );
    await artifacts.upsertArtifact({
      problemId: targetId as ProblemId,
      normalizedSummary: `a searchable rendering of ${TARGET_MARKER}`,
      keywords: [TARGET_MARKER, 'rotation'],
      structuralFeatures: { boundary: 'credentials', note: TARGET_MARKER },
      embedding: [0.5, 0.25, 0.125],
      summaryGeneratorId: 'fixture-summary-generator',
      summaryGeneratorVersion: '1',
      embeddingModel: 'fixture-model',
      embeddingModelVersion: '1',
      sourceFingerprint: `fingerprint-${TARGET_MARKER}`,
      generatedAt: new Date('2026-08-15T10:00:00.000Z'),
    });
    expect(await artifacts.getArtifact(targetId as ProblemId)).toBeDefined();

    // The version from step 3's response. Appends do not advance it, and the
    // read here proves that rather than assuming it.
    const current = await request('GET', `/v1/problems/${targetId}`);
    expect((JSON.parse(current.body) as { version: number }).version).toBe(targetVersion);

    const deleted = await fetch(
      `${baseUrl}/v1/problems/${targetId}?expected_version=${String(targetVersion)}`,
      { method: 'DELETE', headers: { authorization: `Bearer ${token}` } },
    );
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe('');

    // Nothing of the aggregate is still reachable: not the rows, not the ids,
    // not the marker, not either Event, not the redacted sentences.
    const after = await sweepOwner();
    expect(after).not.toContain(targetId);
    expect(after).not.toContain(TARGET_MARKER);
    expect(after).not.toContain(EVENT_A_KEY);
    expect(after).not.toContain(eventBKey);
    expect(after).not.toContain(SECRET_A);
    expect(after).not.toContain(SECRET_B);
    expect(after).not.toContain('the deploy log printed');
    expect(after).not.toContain('the replacement value');

    // While the survivor — same project, same environment — is untouched,
    // which is what makes the absences above a delete and not a wipe.
    expect(after).toContain(survivorId);
    expect(after).toContain(CONTROL_MARKER);
    expect(after).toContain(projectId);
    expect(after).toContain(environmentId);

    const changeLogs = await pool.query<{ n: string }>(
      `select count(*) as n from public.change_logs where owner_id = $1 and problem_id = $2`,
      [ownerId, targetId],
    );
    expect(Number(changeLogs.rows[0]?.n)).toBe(0);

    // And the derived rendering with it — summary, keywords, features and the
    // embedding built from them. Regenerable is a reason it is cheap to lose,
    // not a reason to leave it behind when somebody asked for a delete.
    const remaining = await pool.query<{ n: string }>(
      `select count(*) as n from public.retrieval_artifacts where owner_id = $1`,
      [ownerId],
    );
    expect(Number(remaining.rows[0]?.n)).toBe(0);
  });

  it('12. leaves no derived search storage holding it either', async () => {
    // "Deleted including search derivatives" started as a claim about a phase
    // that had none: Phase 3 built no search, so the truthful form was that no
    // derived storage existed to hold a residue. P4-01 introduced the first —
    // `retrieval_artifacts` — and the standing rule it arrived under is the
    // reason this step changed with it rather than after it.
    //
    // The claim is now the forward-looking one: every derived store is known
    // here, and physical deletion covers all of them. Step 11 already swept
    // the target's artifact away with the rest of the aggregate; what this
    // step adds is that the list of derived stores is closed, so one appearing
    // without a decision about deleting it fails here.
    //
    // The catalog is asked directly, because a foreign-key inventory proves
    // only that everything *referencing* problems is known — a derived store
    // need not carry a foreign key at all.
    const derived = await pool.query<{ relname: string; relkind: string }>(
      `select k.relname, k.relkind
         from pg_class k
         join pg_namespace n on n.oid = k.relnamespace
        where n.nspname = 'public' and k.relkind in ('v', 'm', 'f', 'p')
        order by k.relname`,
    );
    expect(derived.rows).toEqual([]);

    // And the regular tables are exactly the twelve the phases have added —
    // the same inventory `connection.integration` pins, repeated here because
    // it is the other half of the claim: nothing persisted exists outside
    // them, so `retrieval_artifacts` is the only derived store there is.
    const tables = await pool.query<{ relname: string }>(
      `select k.relname
         from pg_class k
         join pg_namespace n on n.oid = k.relnamespace
        where n.nspname = 'public' and k.relkind = 'r'
        order by k.relname`,
    );
    expect(tables.rows.map((row) => row.relname)).toEqual([
      'change_logs',
      'client_credentials',
      'clients',
      'environments',
      'events',
      'owners',
      'problems',
      'projects',
      'relations',
      'retrieval_artifacts',
      'usage_logs',
      'verifications',
    ]);
  });

  it('13. exports what remains, and none of what was deleted', async () => {
    const response = await request('GET', '/v1/export');
    expect(response.status).toBe(200);

    const artifact = JSON.parse(response.body) as Record<string, unknown>;
    expect(artifact['schema_version']).toBe('1');
    expect(artifact['source_owner_id']).toBe(ownerId);
    for (const key of EXPORT_COLLECTIONS) {
      expect(Array.isArray(artifact[key]), `collection ${key}`).toBe(true);
    }
    // And nothing else: the derived store stays behind, so a restore rebuilds
    // it rather than carrying one model's vectors into another's world.
    expect(Object.keys(artifact)).not.toContain('retrieval_artifacts');

    // A real export of what survived — not an empty document that trivially
    // contains nothing.
    expect(response.body).toContain(survivorId);
    expect(response.body).toContain(CONTROL_MARKER);

    // And nothing of what left: the Problem, its Events, their keys, the
    // markers, the secrets raw or in their redacted sentences.
    for (const gone of [
      targetId,
      TARGET_MARKER,
      EVENT_A_KEY,
      eventBKey,
      SECRET_A,
      SECRET_B,
      'the deploy log printed',
      'the replacement value',
    ]) {
      expect(response.body, 'the export still carried the deleted aggregate').not.toContain(gone);
    }

    // The artifact is Memory, never access to it.
    for (const forbidden of ['token_hash', 'token_lookup', 'credential_id', 'client_id']) {
      expect(response.body).not.toContain(forbidden);
    }
    expect(carriesToken(response.body), 'the export carried the Memory credential').toBe(false);
  });

  it('14. told the operational log none of it', () => {
    const written = logLines.join('\n');
    expect(logLines.length).toBeGreaterThan(0);

    // The whole story ran under the production logger configuration, and the
    // log holds none of it: no secret from either path, no Memory prose from
    // either Problem, no credential. P3-10's field inventory is its own
    // suite; what this adds is the sweep across a full Phase 3 lifecycle —
    // secrets, outage, recovery, delete, export — in one stream.
    expect(written).not.toContain(SECRET_A);
    expect(written).not.toContain(SECRET_B);
    expect(written).not.toContain(TARGET_MARKER);
    expect(written).not.toContain(CONTROL_MARKER);
    expect(carriesToken(written), 'the operational log carried the Memory credential').toBe(false);
  });

  it('15. sent no raw secret back over HTTP at any point', () => {
    // Every response body any step read, swept once. The interesting ones are
    // the early ones — Event A's response above all — but keeping the whole
    // set means a step added later is swept without anyone remembering to.
    const everything = responseBodies.join('\n');
    expect(responseBodies.length).toBeGreaterThan(0);
    expect(everything).not.toContain(SECRET_A);
    expect(everything).not.toContain(SECRET_B);
    expect(carriesToken(everything), 'a response carried the Memory credential').toBe(false);
  });
});
