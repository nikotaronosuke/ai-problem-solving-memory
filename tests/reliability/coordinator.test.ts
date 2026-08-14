/**
 * The coordinator, against a real queue on a real directory.
 *
 * What it owns is small and easy to state: assign the idempotency key once,
 * make the write durable before anything is attempted, attempt exactly the
 * write it was given, and translate what happened into a closed answer. Every
 * one of those has a way of going wrong that no amount of server-side
 * deduplication would catch, so each is asserted directly.
 *
 * The delivery here is a fake; the queue is not. Whether the file exists at the
 * moment of the first attempt is the property being tested, and a fake queue
 * would decide that for itself.
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { OwnerId } from '../../src/domain/owner.js';
import type { ProblemId } from '../../src/domain/problem.js';
import {
  createReliableWriteCoordinator,
  createRetryQueue,
  OwnerMismatchError,
  SUBMIT_OUTCOMES,
  type DeliveryOutcome,
  type AttemptOutcome,
  type QueueItem,
  type ReliableWriteCoordinator,
  type RetryDelivery,
  type RetryQueue,
} from '../../src/reliability/index.js';

const LIMITS = { maxItems: 100, maxItemBytes: 64 * 1024, maxTotalBytes: 1024 * 1024 };
const POLICY = { baseDelayMs: 1_000, maxDelayMs: 60_000, maxAttempts: 4 };
const AT = new Date('2026-08-14T12:00:00.000Z');

const SUCCESS: DeliveryOutcome = { kind: 'SUCCESS' };
const DOWN: DeliveryOutcome = { kind: 'TRANSPORT_FAILURE' };
const REFUSED: DeliveryOutcome = { kind: 'HTTP_FAILURE', status: 400 };
const UNAUTHENTICATED: DeliveryOutcome = { kind: 'HTTP_FAILURE', status: 401 };

function fake(outcome: DeliveryOutcome): RetryDelivery & { readonly seen: QueueItem[] } {
  const seen: QueueItem[] = [];
  return {
    seen,
    deliver(item) {
      seen.push(item);
      return Promise.resolve(outcome);
    },
  };
}

describe('submitting a write', () => {
  let directory: string;
  let queue: RetryQueue;
  let coordinator: ReliableWriteCoordinator;
  let ownerId: OwnerId;
  let problemId: ProblemId;

  const event = () => ({
    ownerId,
    problemId,
    payload: { eventType: 'DISCOVERY' as const, summary: 'something was learned' },
  });

  const verification = () => ({
    ownerId,
    problemId,
    payload: { verificationType: 'TEST' as const, result: true, summary: 'the suite agreed' },
  });

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'memory-coordinator-'));
    queue = createRetryQueue({ directory, limits: LIMITS, policy: POLICY });
    coordinator = createReliableWriteCoordinator(queue);
    ownerId = randomUUID() as OwnerId;
    problemId = randomUUID() as ProblemId;
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  describe('the key', () => {
    it('is assigned by the coordinator, not asked of the caller', async () => {
      // The caller passes an owner, a Problem and what happened. It cannot
      // supply a key, so it cannot supply a different one on a retry — which
      // is the mistake this arrangement exists to make impossible.
      const submitted = await coordinator.submitEvent(event(), AT, { ownerId }, fake(SUCCESS));

      expect(submitted.clientEventId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it('differs between two submissions of the same content', async () => {
      // Two Events that happen to say the same thing are two Events. The key
      // identifies a submission, not a payload.
      const first = await coordinator.submitEvent(event(), AT, { ownerId }, fake(SUCCESS));
      const second = await coordinator.submitEvent(event(), AT, { ownerId }, fake(SUCCESS));

      expect(first.clientEventId).not.toBe(second.clientEventId);
    });

    it('is the one the delivery is handed', async () => {
      const delivery = fake(SUCCESS);

      const submitted = await coordinator.submitEvent(event(), AT, { ownerId }, delivery);

      expect(delivery.seen[0]?.write.clientEventId).toBe(submitted.clientEventId);
    });
  });

  describe('durability before delivery', () => {
    it('has already written the file when the first attempt runs', async () => {
      let filesAtAttempt: string[] = [];
      const watching: RetryDelivery = {
        async deliver() {
          filesAtAttempt = await readdir(directory);
          return SUCCESS;
        },
      };

      await coordinator.submitEvent(event(), AT, { ownerId }, watching);

      // The whole design in one assertion. If the attempt happened first, a
      // crash between the failure and the enqueue would lose the write with no
      // trace anywhere.
      expect(filesAtAttempt).toHaveLength(1);
    });

    it('hands the delivery the sanitized item rather than the caller’s input', async () => {
      const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
      const delivery = fake(SUCCESS);

      await coordinator.submitEvent(
        {
          ownerId,
          problemId,
          payload: {
            eventType: 'DISCOVERY',
            summary: `AWS_SECRET_ACCESS_KEY=${secret}`,
          },
        },
        AT,
        { ownerId },
        delivery,
      );

      // Building a request from the original input would put the credential on
      // the wire on the first attempt only — invisible to anything that
      // inspects retries.
      const sent = JSON.stringify(delivery.seen[0]?.write.payload);
      expect(sent).not.toContain(secret);
      expect(sent).toContain('[REDACTED]');
    });
  });

  describe('attempting exactly one write', () => {
    it('does not touch other items that happen to be due', async () => {
      // Something older, already waiting.
      const waiting = await queue.enqueue(
        {
          operation: 'appendEvent',
          ownerId,
          problemId,
          clientEventId: randomUUID() as never,
          payload: { eventType: 'ATTEMPT', summary: 'queued earlier' },
        },
        AT,
      );

      const delivery = fake(SUCCESS);
      const submitted = await coordinator.submitEvent(event(), AT, { ownerId }, delivery);

      // One attempt, for the write that was just submitted. Draining instead
      // would make "record this Event" mean "flush the backlog", giving the
      // caller the latency and the failures of writes it knows nothing about.
      expect(delivery.seen).toHaveLength(1);
      expect(delivery.seen[0]?.write.clientEventId).toBe(submitted.clientEventId);

      const held = (await queue.list()).items;
      expect(held.map((item) => item.queueItemId)).toEqual([waiting.queueItemId]);
      expect(held[0]?.attemptCount).toBe(0);
    });
  });

  describe('what the caller is told', () => {
    it.each([
      ['a write that arrived is DELIVERED', SUCCESS, 'DELIVERED'],
      ['a server that did not answer is QUEUED', DOWN, 'QUEUED'],
      ['a credential that was refused is AUTH_REQUIRED', UNAUTHENTICATED, 'AUTH_REQUIRED'],
      ['a write the server refused is PERMANENT_FAILURE', REFUSED, 'PERMANENT_FAILURE'],
    ] as const)('answers %s', async (_label, outcome, expected) => {
      const submitted = await coordinator.submitEvent(event(), AT, { ownerId }, fake(outcome));

      expect(submitted.outcome).toBe(expected);
    });

    it('offers exactly four answers', () => {
      // Mechanical, and closed. Whether any of this is worth telling a person,
      // and how, belongs to the failure-fallback contract rather than here.
      expect([...SUBMIT_OUTCOMES].sort()).toEqual([
        'AUTH_REQUIRED',
        'DELIVERED',
        'PERMANENT_FAILURE',
        'QUEUED',
      ]);
    });

    it.each([
      ['a write that arrived', SUCCESS, 0],
      ['a server that did not answer', DOWN, 1],
      ['a credential that was refused', UNAUTHENTICATED, 1],
      ['a write the server refused', REFUSED, 1],
    ] as const)('leaves the right thing on disk after %s', async (_label, outcome, remaining) => {
      await coordinator.submitEvent(event(), AT, { ownerId }, fake(outcome));

      // A success removes the file; every other outcome keeps it, including a
      // refusal — nothing can be reported later that has been deleted.
      expect(await readdir(directory)).toHaveLength(remaining);
    });

    it('leaves a refused write terminal, and a failed one retryable', async () => {
      await coordinator.submitEvent(event(), AT, { ownerId }, fake(REFUSED));
      expect((await queue.list()).items[0]?.terminalFailure).toBe('PERMANENT_RESPONSE');

      const second = createRetryQueue({ directory, limits: LIMITS, policy: POLICY });
      await createReliableWriteCoordinator(second).submitEvent(
        event(),
        AT,
        { ownerId },
        fake(DOWN),
      );
      const live = (await second.list()).items.filter((item) => item.terminalFailure === null);
      expect(live).toHaveLength(1);
      expect(live[0]?.attemptCount).toBe(1);
    });
  });

  describe('answers a fresh submission should never see', () => {
    /**
     * A queue that reports one attempt outcome, whatever it is asked.
     *
     * The refusals below cannot arise from a fresh submission — an item is due
     * the moment it is enqueued, is not terminal, and has just been written. So
     * they are driven directly, because "cannot happen" is a claim about today
     * and the mapping is what protects the caller if it stops being true.
     */
    function queueAnswering(outcome: AttemptOutcome): RetryQueue {
      return {
        enqueue: (write, now) =>
          Promise.resolve({
            queueItemId: randomUUID(),
            write,
            enqueuedAt: now.toISOString(),
            attemptCount: 0,
            nextAttemptAt: now.toISOString(),
            terminalFailure: null,
          }),
        list: () => Promise.resolve({ items: [], corruptCount: 0 }),
        attempt: () => Promise.resolve(outcome),
        drain: () => Promise.resolve({ results: [], notDue: 0, terminal: 0, corruptCount: 0 }),
      };
    }

    it.each([
      ['NOT_FOUND', 'PERMANENT_FAILURE'],
      ['TERMINAL', 'PERMANENT_FAILURE'],
      ['OWNER_MISMATCH', 'PERMANENT_FAILURE'],
      ['RETRY_EXHAUSTED', 'PERMANENT_FAILURE'],
      // Live and waiting, which is what QUEUED already means.
      ['NOT_DUE', 'QUEUED'],
    ] as const)('turns %s into %s, never into DELIVERED', async (attempted, expected) => {
      const submitted = await createReliableWriteCoordinator(queueAnswering(attempted)).submitEvent(
        event(),
        AT,
        { ownerId },
        fake(SUCCESS),
      );

      // Claiming a write arrived when it did not is the one answer that must
      // never be given wrongly. Everything unrecognised falls to the answer
      // that promises nothing.
      expect(submitted.outcome).toBe(expected);
      expect(submitted.outcome).not.toBe('DELIVERED');
    });

    it('says DELIVERED only when the queue did', async () => {
      const submitted = await createReliableWriteCoordinator(
        queueAnswering('DELIVERED'),
      ).submitEvent(event(), AT, { ownerId }, fake(SUCCESS));

      expect(submitted.outcome).toBe('DELIVERED');
    });
  });

  describe('both writes are supported', () => {
    it('submits a Verification the same way', async () => {
      const delivery = fake(SUCCESS);

      const submitted = await coordinator.submitVerification(
        verification(),
        AT,
        { ownerId },
        delivery,
      );

      expect(submitted.outcome).toBe('DELIVERED');
      expect(delivery.seen[0]?.write.operation).toBe('appendVerification');
      expect(delivery.seen[0]?.write.clientEventId).toBe(submitted.clientEventId);
      expect(delivery.seen[0]?.write.payload).toEqual(verification().payload);
    });

    it('keeps an unsent Verification durable, as it does an Event', async () => {
      await coordinator.submitVerification(verification(), AT, { ownerId }, fake(DOWN));

      const held = (await queue.list()).items;
      expect(held).toHaveLength(1);
      expect(held[0]?.write.operation).toBe('appendVerification');
    });
  });

  describe('the owner the caller is acting as', () => {
    it('refuses a write for somebody else before anything is written or sent', async () => {
      const delivery = fake(SUCCESS);

      await expect(
        coordinator.submitEvent(event(), AT, { ownerId: randomUUID() as OwnerId }, delivery),
      ).rejects.toBeInstanceOf(OwnerMismatchError);

      // Thrown rather than returned: assembling a write for an owner the
      // delivery is not acting as is a bug in the caller, not something that
      // happened to a write. The queue's own guard is for items read back off
      // a disk, where the two can legitimately disagree.
      expect(delivery.seen).toHaveLength(0);
      expect(await readdir(directory)).toEqual([]);
    });

    it('says nothing about either owner when it refuses', async () => {
      const other = randomUUID() as OwnerId;

      try {
        await coordinator.submitEvent(event(), AT, { ownerId: other }, fake(SUCCESS));
        expect.unreachable('the submission should have been refused');
      } catch (error) {
        const refused = error as Error;
        expect(refused.message).not.toContain(ownerId);
        expect(refused.message).not.toContain(other);
      }
    });
  });
});
