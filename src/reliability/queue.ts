/**
 * The queue itself: hold a write that could not be sent, and send it later.
 *
 * The spec asks that a Memory failure not stop the work an assistant is doing,
 * that an important Event go to a temporary queue, and that it be resent once
 * things recover. The failure it names is the Memory Server being down — so
 * this cannot live inside the Memory Server. A queue behind an unreachable
 * server never receives the request it was supposed to hold. It lives beside
 * the caller, which is why nothing in `src/http`, `src/app` or `src/index.ts`
 * touches this module and an architecture test says so.
 *
 * It is in this repository because the adapters that will use it do not exist
 * yet, and the contract it has to honour — which writes are safe to resend,
 * what the server says when it refuses, what a credential may not be used
 * for — is knowledge that lives here. Phase 5 and Phase 6 supply the transport
 * and decide when to drain.
 *
 * Three rules shape everything below.
 *
 * **The key is never regenerated.** `clientEventId` is assigned once, before
 * the first attempt, by whoever built the intent. Every retry carries the same
 * one. The database has a unique index on it and keeps the first write, so
 * sending an Event five times leaves one row — which is exactly what a queue
 * that minted a fresh key per attempt would destroy.
 *
 * **Nothing is thrown away quietly.** A success deletes the file. Everything
 * else keeps it, including a permanent refusal and a run of attempts that used
 * itself up. The spec's other half is that the user is told about important
 * things that were not saved, and nothing can be reported that has already
 * been deleted. Reporting is P3-09's; keeping is this task's.
 *
 * **There is no timer.** The queue records when an item may next be tried and
 * the caller decides when to look. A background loop here would keep running
 * in a process that may have nothing to do, and would need a clock and a
 * scheduler to test around. `drain` takes the time as an argument instead.
 */

import { classifyDeliveryOutcome, type DeliveryOutcome } from './classify.js';
import { nextDelayMs, type RetryPolicy } from './backoff.js';
import type { DeliveryContext, RetryDelivery } from './delivery.js';
import {
  generateQueueItemId,
  type QueueItem,
  type QueuedWrite,
  type TerminalFailure,
} from './item.js';
import { createQueueStore, type QueueLimits, type QueueStore } from './store.js';
import {
  createSecretDetectionPolicy,
  sanitizeValue,
  type SanitizationPolicy,
} from '../sanitization/index.js';

/** What happened to one item during a drain. Closed, and free of detail. */
export const DRAIN_OUTCOMES = [
  'DELIVERED',
  'RESCHEDULED',
  'RETRY_EXHAUSTED',
  'PERMANENT_FAILURE',
  'AUTH_REQUIRED',
  'OWNER_MISMATCH',
] as const;

export type DrainOutcome = (typeof DRAIN_OUTCOMES)[number];

export interface DrainReport {
  /** One entry per item considered, in the order they were considered. */
  readonly results: readonly { readonly queueItemId: string; readonly outcome: DrainOutcome }[];
  /** Items still waiting for their next attempt, untouched by this drain. */
  readonly notDue: number;
  /** Items already terminal, skipped. */
  readonly terminal: number;
  /** Files that could not be read. A count, and nothing about them. */
  readonly corruptCount: number;
}

export interface RetryQueueOptions {
  /**
   * Where the queue lives.
   *
   * Required, with no default anywhere in this module. Choosing a directory
   * means choosing where somebody's unsaved work sits on their disk, and that
   * belongs to whoever installs the adapter — a library that guessed would
   * write to a home directory, a working directory or a repository without
   * being asked.
   */
  readonly directory: string;
  readonly limits: QueueLimits;
  readonly policy: RetryPolicy;
  /**
   * What every queued write is inspected against before it is written down.
   *
   * Defaults to the same policy the server's write boundary uses, so a queue
   * built without an opinion is checked rather than open.
   */
  readonly sanitization?: SanitizationPolicy;
}

export interface RetryQueue {
  /**
   * Records a write that could not be sent, after inspecting it.
   *
   * Raises `SanitizationRejectedError` when the intent holds a credential that
   * cannot be safely removed, and `QueueCapacityError` when the queue is at
   * one of its limits. Both leave nothing behind.
   */
  enqueue(write: QueuedWrite, now: Date): Promise<QueueItem>;

  /** Everything currently held, terminal items included. */
  list(): Promise<{ readonly items: readonly QueueItem[]; readonly corruptCount: number }>;

  /**
   * Attempts every item that is due, oldest first.
   *
   * Stops early on `AUTH_REQUIRED`: the credential is the obstacle, and the
   * next item would meet it too. The caller drains again once it has a working
   * one.
   */
  drain(now: Date, context: DeliveryContext, delivery: RetryDelivery): Promise<DrainReport>;
}

export function createRetryQueue(options: RetryQueueOptions): RetryQueue {
  const store: QueueStore = createQueueStore(options.directory);
  const sanitization = options.sanitization ?? createSecretDetectionPolicy();

  const terminal = (item: QueueItem, failure: TerminalFailure): QueueItem => ({
    ...item,
    nextAttemptAt: null,
    terminalFailure: failure,
  });

  return {
    async enqueue(write, now) {
      // Before anything reaches the disk. A queue file outlives the process,
      // gets copied by whatever backs up a home directory, and is read by a
      // person when something has gone wrong — so it is subject to the same
      // rule as the database, and for stronger reasons. The policy is the
      // server's own; what a credential looks like is not re-implemented here.
      const inspected = sanitizeValue(write.payload, sanitization, [
        { kind: 'operation', name: write.operation },
      ]);

      const item: QueueItem = {
        queueItemId: generateQueueItemId(),
        // The key is carried across untouched. Everything else in the write
        // has been through the boundary above.
        write: { ...write, payload: inspected } as QueuedWrite,
        enqueuedAt: now.toISOString(),
        attemptCount: 0,
        // Due immediately: the caller is queuing because an attempt already
        // failed or could not be made, and the backoff starts at the first
        // failure rather than at the enqueue.
        nextAttemptAt: now.toISOString(),
        terminalFailure: null,
      };

      await store.write(item, options.limits, true);
      return item;
    },

    async list() {
      const { items, corruptCount } = await store.read();
      return { items, corruptCount };
    },

    async drain(now, context, delivery) {
      const { items, corruptCount } = await store.read();
      const results: { queueItemId: string; outcome: DrainOutcome }[] = [];
      let notDue = 0;
      let terminalCount = 0;

      for (const item of items) {
        if (item.terminalFailure !== null) {
          terminalCount += 1;
          continue;
        }
        if (item.nextAttemptAt !== null && new Date(item.nextAttemptAt) > now) {
          notDue += 1;
          continue;
        }

        if (item.write.ownerId !== context.ownerId) {
          // Not delivered, not counted as an attempt, not modified. This is
          // not an authorisation check — the server decides that from the
          // credential — it is a guard against handing one person's Event to a
          // context established for someone else.
          results.push({ queueItemId: item.queueItemId, outcome: 'OWNER_MISMATCH' });
          continue;
        }

        const outcome: DeliveryOutcome = await delivery.deliver(item, context);

        if (outcome.kind === 'SUCCESS') {
          await store.remove(item.queueItemId);
          results.push({ queueItemId: item.queueItemId, outcome: 'DELIVERED' });
          continue;
        }

        const decision = classifyDeliveryOutcome(outcome);

        if (decision === 'AUTH_REQUIRED') {
          // Untouched: no attempt spent, no schedule moved, nothing written.
          // A revoked credential is replaced, and the Event queued before that
          // happened is still worth saving.
          results.push({ queueItemId: item.queueItemId, outcome: 'AUTH_REQUIRED' });
          break;
        }

        if (decision === 'PERMANENT') {
          await store.write(terminal(item, 'PERMANENT_RESPONSE'), options.limits, false);
          results.push({ queueItemId: item.queueItemId, outcome: 'PERMANENT_FAILURE' });
          continue;
        }

        const attemptCount = item.attemptCount + 1;
        if (attemptCount >= options.policy.maxAttempts) {
          await store.write(
            terminal({ ...item, attemptCount }, 'RETRY_EXHAUSTED'),
            options.limits,
            false,
          );
          results.push({ queueItemId: item.queueItemId, outcome: 'RETRY_EXHAUSTED' });
          continue;
        }

        const delay = nextDelayMs(
          options.policy,
          attemptCount,
          outcome.kind === 'HTTP_FAILURE' ? outcome.retryAfterMs : undefined,
        );
        await store.write(
          {
            ...item,
            attemptCount,
            nextAttemptAt: new Date(now.getTime() + delay).toISOString(),
          },
          options.limits,
          false,
        );
        results.push({ queueItemId: item.queueItemId, outcome: 'RESCHEDULED' });
      }

      return { results, notDue, terminal: terminalCount, corruptCount };
    },
  };
}
