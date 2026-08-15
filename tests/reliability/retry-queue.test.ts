/**
 * The queue, against a real directory on a real filesystem.
 *
 * Not a mocked one. Durability is the whole claim — a write that could not be
 * sent survives the process ending — and a fake filesystem proves it against
 * itself. Every test here writes to a temporary directory and several read the
 * files back as text, because what is on disk is the thing being asserted.
 *
 * Time is supplied rather than observed. The queue has no clock and no timer:
 * `drain` takes the moment as an argument, so a backoff of ten minutes is
 * tested by passing a later date, not by waiting.
 */

import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ClientEventId } from '../../src/domain/client-event-id.js';
import type { OwnerId } from '../../src/domain/owner.js';
import type { ProblemId } from '../../src/domain/problem.js';
import {
  createRetryQueue,
  QueueCapacityError,
  RETRY_QUEUE_SCHEMA_VERSION,
  type DeliveryContext,
  type DeliveryOutcome,
  type QueueItem,
  type QueuedWrite,
  type RetryDelivery,
  type RetryQueue,
} from '../../src/reliability/index.js';
import { SanitizationRejectedError } from '../../src/sanitization/index.js';

const LIMITS = { maxItems: 100, maxItemBytes: 64 * 1024, maxTotalBytes: 4 * 1024 * 1024 };
const POLICY = { baseDelayMs: 1_000, maxDelayMs: 60_000, maxAttempts: 4 };

const AT = new Date('2026-08-14T09:00:00.000Z');
const later = (ms: number) => new Date(AT.getTime() + ms);

/** A delivery that answers whatever it is told to, and records what it saw. */
function scripted(...outcomes: DeliveryOutcome[]): RetryDelivery & {
  readonly seen: { item: QueueItem; context: DeliveryContext }[];
} {
  const seen: { item: QueueItem; context: DeliveryContext }[] = [];
  let index = 0;

  return {
    seen,
    deliver(item, context) {
      seen.push({ item, context });
      const outcome = outcomes[Math.min(index, outcomes.length - 1)];
      index += 1;
      return Promise.resolve(outcome ?? { kind: 'SUCCESS' });
    },
  };
}

const SUCCESS: DeliveryOutcome = { kind: 'SUCCESS' };
const DOWN: DeliveryOutcome = { kind: 'TRANSPORT_FAILURE' };
const REFUSED: DeliveryOutcome = { kind: 'HTTP_FAILURE', status: 400 };
const UNAUTHENTICATED: DeliveryOutcome = { kind: 'HTTP_FAILURE', status: 401 };

describe('a queue of writes that have not reached the server', () => {
  let directory: string;
  let queue: RetryQueue;
  let ownerId: OwnerId;
  let context: DeliveryContext;

  const eventWrite = (overrides: Partial<QueuedWrite> = {}): QueuedWrite =>
    ({
      operation: 'appendEvent',
      ownerId,
      problemId: randomUUID() as ProblemId,
      clientEventId: randomUUID() as ClientEventId,
      problemImportant: false,
      payload: {
        eventType: 'DISCOVERY',
        summary: 'the cache was the problem',
        reason: 'the timing lined up',
        sourceAi: 'claude-code',
        evidenceRef: 'ci/run/1',
      },
      ...overrides,
    }) as QueuedWrite;

  const verificationWrite = (): QueuedWrite => ({
    operation: 'appendVerification',
    ownerId,
    problemId: randomUUID() as ProblemId,
    clientEventId: randomUUID() as ClientEventId,
    problemImportant: false,
    payload: {
      verificationType: 'TEST',
      result: true,
      summary: 'the suite agreed',
      verifiedBy: 'claude-code',
    },
  });

  const files = () => readdir(directory);
  const readItemFiles = async (): Promise<string[]> => {
    const names = await files();
    return Promise.all(names.map((name) => readFile(join(directory, name), 'utf8')));
  };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'memory-retry-'));
    ownerId = randomUUID() as OwnerId;
    context = { ownerId };
    queue = createRetryQueue({ directory, limits: LIMITS, policy: POLICY });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  describe('holding a write', () => {
    it('writes one file per item, readable as JSON', async () => {
      const write = eventWrite();

      const item = await queue.enqueue(write, AT);

      expect(await files()).toEqual([`${item.queueItemId}.json`]);
      const stored = JSON.parse((await readItemFiles())[0] ?? '') as Record<string, unknown>;
      expect(stored['schema_version']).toBe(RETRY_QUEUE_SCHEMA_VERSION);
      expect(stored['operation']).toBe('appendEvent');
      expect(stored['client_event_id']).toBe(write.clientEventId);
      expect(stored['attempt_count']).toBe(0);
      expect(stored['terminal_failure']).toBeNull();
    });

    it('carries the format version, which is not the API or export version', async () => {
      // Three versions for three different questions. A queue file is read by
      // the process that wrote it, minutes later; an export artifact is read
      // by another install, years later. This one moved to '2' when the
      // Problem's importance was added, because a required field is a new
      // format — calling it the old one would leave a reader unable to tell
      // "not important" from "written before the field existed".
      expect(RETRY_QUEUE_SCHEMA_VERSION).toBe('2');

      await queue.enqueue(eventWrite(), AT);
      const stored = JSON.parse((await readItemFiles())[0] ?? '') as Record<string, unknown>;
      expect(stored['schema_version']).toBe('2');
    });

    it('takes both queueable operations and nothing else', async () => {
      await queue.enqueue(eventWrite(), AT);
      await queue.enqueue(verificationWrite(), AT);

      const { items } = await queue.list();
      expect(items.map((item) => item.write.operation).sort()).toEqual([
        'appendEvent',
        'appendVerification',
      ]);
    });

    it('keeps the idempotency key at the top level, once', async () => {
      const write = eventWrite();

      await queue.enqueue(write, AT);

      const text = (await readItemFiles())[0] ?? '';
      const stored = JSON.parse(text) as {
        client_event_id: string;
        payload: Record<string, unknown>;
      };
      // One home for the key. A copy inside the payload is a second thing to
      // keep in step, and the two disagreeing is the failure the key exists to
      // prevent.
      expect(stored.client_event_id).toBe(write.clientEventId);
      expect(stored.payload['clientEventId']).toBeUndefined();
      expect(text.split(write.clientEventId).length - 1).toBe(1);
    });
  });

  describe('surviving the process', () => {
    it('is still there for a queue built later on the same directory', async () => {
      const write = eventWrite();
      const enqueued = await queue.enqueue(write, AT);
      await queue.drain(AT, context, scripted(DOWN));

      // A new instance, as a restarted process would build. Nothing is carried
      // over in memory.
      const restarted = createRetryQueue({ directory, limits: LIMITS, policy: POLICY });
      const { items } = await restarted.list();

      expect(items).toHaveLength(1);
      const item = items[0];
      expect(item?.queueItemId).toBe(enqueued.queueItemId);
      expect(item?.write.clientEventId).toBe(write.clientEventId);
      expect(item?.write.ownerId).toBe(ownerId);
      expect(item?.write.problemId).toBe(write.problemId);
      expect(item?.write.payload).toEqual(write.payload);
      // The attempt already spent is remembered, so a restart does not reset
      // the backoff and start hammering.
      expect(item?.attemptCount).toBe(1);
      expect(item?.nextAttemptAt).toBe(later(POLICY.baseDelayMs).toISOString());
    });

    it('delivers what the restarted queue read, with the original key', async () => {
      const write = eventWrite();
      await queue.enqueue(write, AT);
      await queue.drain(AT, context, scripted(DOWN));

      const restarted = createRetryQueue({ directory, limits: LIMITS, policy: POLICY });
      const delivery = scripted(SUCCESS);
      await restarted.drain(later(POLICY.baseDelayMs), context, delivery);

      expect(delivery.seen).toHaveLength(1);
      expect(delivery.seen[0]?.item.write.clientEventId).toBe(write.clientEventId);
      expect(await files()).toEqual([]);
    });
  });

  describe('attempting delivery', () => {
    it('removes an item that was delivered', async () => {
      await queue.enqueue(eventWrite(), AT);

      const report = await queue.drain(AT, context, scripted(SUCCESS));

      expect(report.results.map((result) => result.outcome)).toEqual(['DELIVERED']);
      expect(await files()).toEqual([]);
    });

    it('counts a retryable failure and schedules the next attempt', async () => {
      await queue.enqueue(eventWrite(), AT);

      await queue.drain(AT, context, scripted(DOWN));
      const first = (await queue.list()).items[0];
      expect(first?.attemptCount).toBe(1);
      expect(first?.nextAttemptAt).toBe(later(1_000).toISOString());

      await queue.drain(later(1_000), context, scripted(DOWN));
      const second = (await queue.list()).items[0];
      // Doubling: one second, then two.
      expect(second?.attemptCount).toBe(2);
      expect(second?.nextAttemptAt).toBe(later(1_000 + 2_000).toISOString());
    });

    it('leaves an item alone before its next attempt is due', async () => {
      await queue.enqueue(eventWrite(), AT);
      await queue.drain(AT, context, scripted(DOWN));

      const delivery = scripted(SUCCESS);
      const report = await queue.drain(later(999), context, delivery);

      expect(delivery.seen).toHaveLength(0);
      expect(report.notDue).toBe(1);
      expect(report.results).toEqual([]);
    });

    it('gives up after the attempts it was given, and keeps the item', async () => {
      await queue.enqueue(eventWrite(), AT);

      let at = AT;
      for (let attempt = 0; attempt < POLICY.maxAttempts; attempt += 1) {
        await queue.drain(at, context, scripted(DOWN));
        const item = (await queue.list()).items[0];
        // The last failure makes it terminal, so there is no next attempt to
        // schedule and the loop stops moving the clock.
        at = new Date(item?.nextAttemptAt ?? at);
      }

      const { items } = await queue.list();
      expect(items[0]?.attemptCount).toBe(POLICY.maxAttempts);
      expect(items[0]?.terminalFailure).toBe('RETRY_EXHAUSTED');
      expect(items[0]?.nextAttemptAt).toBeNull();
      // Kept, not deleted. Somebody wanted this recorded, and nothing can be
      // reported later that has already been thrown away.
      expect(await files()).toHaveLength(1);
    });

    it('stops immediately on a refusal, and keeps the item', async () => {
      await queue.enqueue(eventWrite(), AT);

      const report = await queue.drain(AT, context, scripted(REFUSED));

      expect(report.results.map((result) => result.outcome)).toEqual(['PERMANENT_FAILURE']);
      const { items } = await queue.list();
      expect(items[0]?.terminalFailure).toBe('PERMANENT_RESPONSE');
      expect(items[0]?.nextAttemptAt).toBeNull();
      expect(await files()).toHaveLength(1);
    });

    it('never attempts a terminal item again', async () => {
      await queue.enqueue(eventWrite(), AT);
      await queue.drain(AT, context, scripted(REFUSED));

      const delivery = scripted(SUCCESS);
      const report = await queue.drain(later(1_000_000), context, delivery);

      expect(delivery.seen).toHaveLength(0);
      expect(report.terminal).toBe(1);
    });

    it('honours a Retry-After that asks for longer, and ignores one asking for less', async () => {
      await queue.enqueue(eventWrite(), AT);
      await queue.drain(
        AT,
        context,
        scripted({ kind: 'HTTP_FAILURE', status: 429, retryAfterMs: 30_000 }),
      );
      expect((await queue.list()).items[0]?.nextAttemptAt).toBe(later(30_000).toISOString());

      const at = new Date((await queue.list()).items[0]?.nextAttemptAt ?? AT);
      await queue.drain(
        at,
        context,
        scripted({ kind: 'HTTP_FAILURE', status: 429, retryAfterMs: 1 }),
      );
      // The schedule wins. Being told to wait is information a client does not
      // have; being told to hurry, by a server that just failed, is not.
      expect((await queue.list()).items[0]?.nextAttemptAt).toBe(
        new Date(at.getTime() + 2_000).toISOString(),
      );
    });
  });

  describe('attempting one item by id', () => {
    // `attempt` is a public method, so it has to hold the same guarantees a
    // sweep does. A review found it did not: it went straight to delivery,
    // which meant a caller holding a queue item id could resend a write the
    // server had permanently refused, or ignore a backoff that was still
    // running. Whether the coordinator happens to call it correctly is beside
    // the point — an exported method is used by whoever has it.

    it('delivers a fresh item, which is what a first attempt is', async () => {
      const item = await queue.enqueue(eventWrite(), AT);
      const delivery = scripted(SUCCESS);

      const outcome = await queue.attempt(item.queueItemId, AT, context, delivery);

      expect(outcome).toBe('DELIVERED');
      expect(delivery.seen).toHaveLength(1);
    });

    it('will not attempt an item whose next try is still in the future', async () => {
      await queue.enqueue(eventWrite(), AT);
      await queue.drain(AT, context, scripted(DOWN));
      const waiting = (await queue.list()).items[0];
      expect(waiting?.nextAttemptAt).toBe(later(POLICY.baseDelayMs).toISOString());

      const delivery = scripted(SUCCESS);
      const outcome = await queue.attempt(
        waiting?.queueItemId ?? '',
        later(POLICY.baseDelayMs - 1),
        context,
        delivery,
      );

      // Not sent. A backoff that only applies when the sweep happens to be
      // what runs is not a backoff.
      expect(delivery.seen).toHaveLength(0);
      expect(outcome).toBe('NOT_DUE');

      const unchanged = (await queue.list()).items[0];
      expect(unchanged?.attemptCount).toBe(waiting?.attemptCount);
      expect(unchanged?.nextAttemptAt).toBe(waiting?.nextAttemptAt);
    });

    it('attempts the same item once it is due', async () => {
      await queue.enqueue(eventWrite(), AT);
      await queue.drain(AT, context, scripted(DOWN));
      const waiting = (await queue.list()).items[0];

      const delivery = scripted(SUCCESS);
      const outcome = await queue.attempt(
        waiting?.queueItemId ?? '',
        later(POLICY.baseDelayMs),
        context,
        delivery,
      );

      expect(outcome).toBe('DELIVERED');
      expect(delivery.seen).toHaveLength(1);
    });

    it('will not attempt an item that ran out of attempts', async () => {
      await queue.enqueue(eventWrite(), AT);
      let at = AT;
      for (let attempt = 0; attempt < POLICY.maxAttempts; attempt += 1) {
        await queue.drain(at, context, scripted(DOWN));
        at = new Date((await queue.list()).items[0]?.nextAttemptAt ?? at);
      }
      const exhausted = (await queue.list()).items[0];
      expect(exhausted?.terminalFailure).toBe('RETRY_EXHAUSTED');

      const delivery = scripted(SUCCESS);
      const outcome = await queue.attempt(
        exhausted?.queueItemId ?? '',
        later(1_000_000_000),
        context,
        delivery,
      );

      // However far into the future the caller asks. Stopping means stopping.
      expect(delivery.seen).toHaveLength(0);
      expect(outcome).toBe('TERMINAL');
      expect((await queue.list()).items[0]).toEqual(exhausted);
    });

    it('will not attempt an item the server refused', async () => {
      await queue.enqueue(eventWrite(), AT);
      await queue.drain(AT, context, scripted(REFUSED));
      const refused = (await queue.list()).items[0];
      expect(refused?.terminalFailure).toBe('PERMANENT_RESPONSE');

      const delivery = scripted(SUCCESS);
      const outcome = await queue.attempt(
        refused?.queueItemId ?? '',
        later(1_000_000),
        context,
        delivery,
      );

      // The server said no. Asking again by id is still asking again.
      expect(delivery.seen).toHaveLength(0);
      expect(outcome).toBe('TERMINAL');
      expect((await queue.list()).items[0]).toEqual(refused);
    });

    it('says so when there is no such item', async () => {
      const delivery = scripted(SUCCESS);

      const outcome = await queue.attempt(randomUUID(), AT, context, delivery);

      expect(outcome).toBe('NOT_FOUND');
      expect(delivery.seen).toHaveLength(0);
    });

    it('refuses an item belonging to another owner, as a sweep does', async () => {
      const item = await queue.enqueue(eventWrite({ ownerId: randomUUID() as OwnerId }), AT);
      const delivery = scripted(SUCCESS);

      const outcome = await queue.attempt(item.queueItemId, AT, context, delivery);

      expect(outcome).toBe('OWNER_MISMATCH');
      expect(delivery.seen).toHaveLength(0);
    });
  });

  describe('when the credential is the obstacle', () => {
    it('changes nothing and stops the drain', async () => {
      await queue.enqueue(eventWrite(), AT);
      await queue.enqueue(eventWrite(), AT);

      const delivery = scripted(UNAUTHENTICATED, SUCCESS);
      const report = await queue.drain(AT, context, delivery);

      expect(report.results.map((result) => result.outcome)).toEqual(['AUTH_REQUIRED']);
      // The second item is not attempted: it would meet the same wall.
      expect(delivery.seen).toHaveLength(1);

      const { items } = await queue.list();
      expect(items).toHaveLength(2);
      // No attempt spent, no schedule moved, nothing terminal. A revoked
      // credential is replaced, and what was queued before that is still worth
      // saving.
      expect(items.every((item) => item.attemptCount === 0)).toBe(true);
      expect(items.every((item) => item.terminalFailure === null)).toBe(true);
    });

    it('delivers on a later drain with a working credential', async () => {
      const write = eventWrite();
      await queue.enqueue(write, AT);
      await queue.drain(AT, context, scripted(UNAUTHENTICATED));

      // The same owner, a different credential — which the queue never saw
      // either time. That is what makes rotation work.
      const delivery = scripted(SUCCESS);
      await queue.drain(AT, context, delivery);

      expect(delivery.seen[0]?.item.write.clientEventId).toBe(write.clientEventId);
      expect(await files()).toEqual([]);
    });
  });

  describe('the owner guard', () => {
    it('will not hand one owner’s write to another owner’s context', async () => {
      await queue.enqueue(eventWrite(), AT);

      const delivery = scripted(SUCCESS);
      const report = await queue.drain(AT, { ownerId: randomUUID() as OwnerId }, delivery);

      // Not delivered at all: the check is before the call, so the payload
      // never reaches a context established for somebody else.
      expect(delivery.seen).toHaveLength(0);
      expect(report.results.map((result) => result.outcome)).toEqual(['OWNER_MISMATCH']);

      const { items } = await queue.list();
      expect(items[0]?.attemptCount).toBe(0);
      expect(items[0]?.terminalFailure).toBeNull();
    });

    it('delivers each owner’s items under their own context', async () => {
      const mine = eventWrite();
      const theirs = eventWrite({ ownerId: randomUUID() as OwnerId });
      await queue.enqueue(mine, AT);
      await queue.enqueue(theirs, AT);

      const delivery = scripted(SUCCESS);
      await queue.drain(AT, context, delivery);

      expect(delivery.seen).toHaveLength(1);
      expect(delivery.seen[0]?.item.write.clientEventId).toBe(mine.clientEventId);
      expect((await queue.list()).items).toHaveLength(1);
    });
  });

  describe('what never reaches the disk', () => {
    it('redacts a credential before the file is written', async () => {
      const secret = `AKIA${randomUUID().replaceAll('-', '').toUpperCase().slice(0, 16)}`;
      const write = eventWrite({
        payload: {
          eventType: 'DISCOVERY',
          summary: `it worked once I set AWS_SECRET_ACCESS_KEY=${secret}`,
          reason: `PASSWORD=${secret}`,
        },
      });

      await queue.enqueue(write, AT);

      const text = (await readItemFiles())[0] ?? '';
      // A queue file outlives the process, gets copied by whatever backs up a
      // home directory, and is read by a person when something has gone
      // wrong. It is subject to the same rule as the database.
      expect(text).not.toContain(secret);
      expect(text).toContain('[REDACTED]');
      // The variable name survives, because that is the part worth reading
      // later — the same partial redaction the write boundary does.
      expect(text).toContain('AWS_SECRET_ACCESS_KEY');
    });

    it('redacts one nested inside another assignment', async () => {
      const secret = `AKIA${randomUUID().replaceAll('-', '').toUpperCase().slice(0, 16)}`;
      const write = eventWrite({
        payload: {
          eventType: 'DISCOVERY',
          summary: `ran x=AWS_SECRET_ACCESS_KEY=${secret} then failed`,
        },
      });

      await queue.enqueue(write, AT);

      // The queue inspects with the server's own policy, so a reading the
      // server gained is a reading the disk gains in the same change.
      const text = (await readItemFiles())[0] ?? '';
      expect(text).not.toContain(secret);
      expect(text).toContain('AWS_SECRET_ACCESS_KEY=[REDACTED]');
      expect(text).toContain('then failed');
    });

    it('writes no file at all when the credential cannot be removed safely', async () => {
      const secret = `AKIA${randomUUID().replaceAll('-', '').toUpperCase().slice(0, 16)}`;
      const write = eventWrite({
        payload: {
          eventType: 'DISCOVERY',
          summary: 'a private key, whole',
          reason: `-----BEGIN PRIVATE KEY-----\n${secret}`,
        },
      });

      await expect(queue.enqueue(write, AT)).rejects.toBeInstanceOf(SanitizationRejectedError);

      // Refused before anything was written, so there is no partial file and
      // nothing to clean up.
      expect(await files()).toEqual([]);
    });

    it('holds no credential, header or error text of any kind', async () => {
      await queue.enqueue(eventWrite(), AT);
      await queue.drain(AT, context, scripted({ kind: 'HTTP_FAILURE', status: 500 }));

      const text = (await readItemFiles())[0] ?? '';
      const stored = JSON.parse(text) as Record<string, unknown>;

      // The shape is closed, so this is a statement about the whole file
      // rather than about the fields somebody remembered to check.
      expect(Object.keys(stored).sort()).toEqual([
        'attempt_count',
        'client_event_id',
        'enqueued_at',
        'next_attempt_at',
        'operation',
        'owner_id',
        'payload',
        'problem_id',
        'problem_important',
        'queue_item_id',
        'schema_version',
        'terminal_failure',
      ]);
      for (const forbidden of ['authorization', 'Bearer', 'mem_', 'token', 'credential', 'stack']) {
        expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase());
      }
    });
  });

  describe('files it did not write', () => {
    it('reads every valid item beside a corrupt one', async () => {
      const good = await queue.enqueue(eventWrite(), AT);
      await writeFile(
        join(directory, `${randomUUID()}.json`),
        '{"schema_version": "1", trunc',
        'utf8',
      );

      const { items, corruptCount } = await queue.list();

      // One bad file must not cost the others. That is the reason for one file
      // per item rather than a single log.
      expect(items.map((item) => item.queueItemId)).toEqual([good.queueItemId]);
      expect(corruptCount).toBe(1);
    });

    it.each([
      ['truncated JSON', '{"schema_version": "1", "queue'],
      ['not an object', '"just a string"'],
      ['a version this build does not know', '{"schema_version": "99", "queue_item_id": "x"}'],
      [
        'an operation outside the closed set',
        JSON.stringify({
          schema_version: '1',
          queue_item_id: '00000000-0000-4000-8000-000000000000',
          owner_id: '00000000-0000-4000-8000-000000000000',
          operation: 'deleteProblem',
          problem_id: '00000000-0000-4000-8000-000000000000',
          client_event_id: '00000000-0000-4000-8000-000000000000',
          payload: {},
          enqueued_at: '2026-08-14T09:00:00.000Z',
          attempt_count: 0,
          next_attempt_at: null,
          terminal_failure: null,
        }),
      ],
      [
        'an identifier that is not one',
        JSON.stringify({
          schema_version: '1',
          queue_item_id: '../../escape',
          owner_id: '00000000-0000-4000-8000-000000000000',
          operation: 'appendEvent',
          problem_id: '00000000-0000-4000-8000-000000000000',
          client_event_id: '00000000-0000-4000-8000-000000000000',
          payload: {},
          enqueued_at: '2026-08-14T09:00:00.000Z',
          attempt_count: 0,
          next_attempt_at: null,
          terminal_failure: null,
        }),
      ],
    ])('refuses %s without repairing or deleting it', async (_label, contents) => {
      const name = `${randomUUID()}.json`;
      await writeFile(join(directory, name), contents, 'utf8');

      const { items, corruptCount } = await queue.list();

      expect(items).toEqual([]);
      expect(corruptCount).toBe(1);
      // Still there. Deleting what cannot be parsed would throw away the only
      // copy of something on the strength of this build not recognising it.
      expect(await files()).toContain(name);
    });

    it('ignores a leftover temporary file', async () => {
      const item = await queue.enqueue(eventWrite(), AT);
      await writeFile(join(directory, `${randomUUID()}.json.tmp`), 'half a write', 'utf8');

      const { items, corruptCount } = await queue.list();

      // A crash between the write and the rename leaves one of these. It is
      // not an item and is not counted as a damaged one.
      expect(items.map((entry) => entry.queueItemId)).toEqual([item.queueItemId]);
      expect(corruptCount).toBe(0);
    });
  });

  describe('limits', () => {
    it('refuses a new item rather than discarding an old one', async () => {
      const small = createRetryQueue({
        directory,
        limits: { ...LIMITS, maxItems: 1 },
        policy: POLICY,
      });
      const first = await small.enqueue(eventWrite(), AT);

      await expect(small.enqueue(eventWrite(), AT)).rejects.toBeInstanceOf(QueueCapacityError);

      // The oldest is not evicted to make room. It is the one that has been
      // waiting longest to be saved, and dropping it silently is the outcome
      // this whole task exists to avoid.
      expect((await small.list()).items.map((item) => item.queueItemId)).toEqual([
        first.queueItemId,
      ]);
    });

    it('refuses an item larger than the size it was given', async () => {
      const tight = createRetryQueue({
        directory,
        limits: { ...LIMITS, maxItemBytes: 200 },
        policy: POLICY,
      });

      await expect(tight.enqueue(eventWrite(), AT)).rejects.toBeInstanceOf(QueueCapacityError);
      expect(await files()).toEqual([]);
    });

    it('still records an attempt on an item already held when the queue is full', async () => {
      const small = createRetryQueue({
        directory,
        limits: { ...LIMITS, maxItems: 1 },
        policy: POLICY,
      });
      await small.enqueue(eventWrite(), AT);

      await small.drain(AT, context, scripted(DOWN));

      // Refusing to record the attempt would leave it retrying forever at the
      // same interval, which is worse than being full.
      expect((await small.list()).items[0]?.attemptCount).toBe(1);
    });
  });

  describe('the file on disk', () => {
    it.runIf(process.platform !== 'win32')('is readable only by its owner', async () => {
      const item = await queue.enqueue(eventWrite(), AT);

      const directoryMode = (await stat(directory)).mode & 0o777;
      const fileMode = (await stat(join(directory, `${item.queueItemId}.json`))).mode & 0o777;

      // On a shared machine the default would make somebody's unsaved work
      // readable by everyone. Windows does not honour the mode, which is why
      // this is skipped there rather than asserted loosely.
      expect(directoryMode).toBe(0o700);
      expect(fileMode).toBe(0o600);
    });

    it('is named from an identifier this module generated', async () => {
      const item = await queue.enqueue(eventWrite(), AT);

      // Nothing from a caller, an owner, a Problem or a payload appears in a
      // path, so there is nothing to traverse with.
      expect(await files()).toEqual([`${item.queueItemId}.json`]);
      expect(item.queueItemId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });
  });
});
