/**
 * Recording a write so that sending it any number of times records it once.
 *
 * P3-07 built a queue that holds writes which could not be sent. This is the
 * thing that decides *when* a write goes into it, and the decision is the whole
 * task: the write is made durable **before** the first attempt, not after the
 * first attempt fails.
 *
 * The obvious design is the other way round — try to send, and queue only if
 * that fails. It is cheaper, because a write that succeeds never touches the
 * disk. It also has a window that loses data outright: the attempt fails, and
 * the process ends before the failure has been written down. Nothing reached
 * the server and nothing reached the queue, so the Event is simply gone. That
 * window is small and it is exactly the moment a crash is most likely, because
 * what usually takes a network attempt down is the same thing taking the
 * process down.
 *
 * Writing first closes it. After `enqueue` returns, every subsequent outcome
 * leaves either a queue item or a row on the server:
 *
 *   crash before the attempt   → the item is on disk, replayed later
 *   attempt fails              → the item is on disk, retried later
 *   attempt succeeds, then a crash before the file is removed
 *                              → the item is on disk, replayed, and the server
 *                                keeps the first write
 *   the response is lost after the server committed
 *                              → the same, and the same
 *
 * The cost is one small file written and removed for every Event that
 * succeeds first time. That is the price of the guarantee, and it is paid on
 * the path that is not the user's work.
 *
 * There is deliberately **no fallback to sending directly** when the queue
 * cannot take the write — not when it is full, not when the disk errors, not
 * when the payload is refused. A fallback would reintroduce exactly the window
 * this exists to close, at the moment the system is least able to track what
 * happened. If the write cannot be made durable, it is not sent; recording a
 * Memory is not the work the assistant is doing, and losing track of a delivery
 * is worse than not attempting one. What the caller is told, and whether the
 * person hears about it, is P3-09's.
 *
 * Three layers own three different things, and keeping them apart is what makes
 * a resend safe:
 *
 *   this        assigns the idempotency key, once, before anything is sent
 *   the queue   persists it and never changes it
 *   the server  refuses the second write with the same key
 */

import type { DeliveryContext, RetryDelivery } from './delivery.js';
import type { EventIntentPayload, QueuedWrite, VerificationIntentPayload } from './item.js';
import type { AttemptOutcome, RetryQueue } from './queue.js';
import { generateClientEventId, type ClientEventId } from '../domain/client-event-id.js';
import type { OwnerId } from '../domain/owner.js';
import type { ProblemId } from '../domain/problem.js';

/**
 * What became of a submitted write.
 *
 * Mechanical and closed. Nothing here is phrased for a person: whether any of
 * this is worth telling somebody, and how, is P3-09's contract. No response
 * body, no error, no credential.
 */
export const SUBMIT_OUTCOMES = [
  /** It reached the server. Nothing is left on disk. */
  'DELIVERED',
  /** It did not, and will be tried again. The item is on disk. */
  'QUEUED',
  /** The credential was refused. The item is on disk, with no attempt spent. */
  'AUTH_REQUIRED',
  /** The server refused it, or the attempts ran out. The item is on disk. */
  'PERMANENT_FAILURE',
] as const;

export type SubmitOutcome = (typeof SUBMIT_OUTCOMES)[number];

export interface SubmitResult {
  readonly outcome: SubmitOutcome;
  /**
   * The key this write will carry for as long as it exists.
   *
   * Returned so a caller can correlate what it asked for with what it is later
   * told happened to it. It is not a secret and identifies nothing on its own.
   */
  readonly clientEventId: ClientEventId;
}

/**
 * How important the Problem this write belongs to was, when it was written.
 *
 * Required, and named after where it comes from. There is one notion of
 * importance in this system and it belongs to a Problem — the spec gives it
 * one, where a person can set it and an assistant may only suggest it — so a
 * write does not get an importance of its own. What is recorded here is the
 * value the caller was looking at, which is the only version obtainable when
 * the failure being handled is the server not answering.
 */
interface ProblemImportance {
  readonly problemImportant: boolean;
}

export interface SubmitEventInput extends ProblemImportance {
  readonly ownerId: OwnerId;
  readonly problemId: ProblemId;
  readonly payload: EventIntentPayload;
}

export interface SubmitVerificationInput extends ProblemImportance {
  readonly ownerId: OwnerId;
  readonly problemId: ProblemId;
  readonly payload: VerificationIntentPayload;
}

/**
 * Raised when a submission names an owner the delivery is not acting as.
 *
 * A programming mistake rather than a delivery outcome, so it is thrown rather
 * than returned: the queue's own owner guard exists for items read back off a
 * disk, and a caller assembling a write for somebody else has a bug that
 * should be loud.
 */
export class OwnerMismatchError extends Error {
  constructor() {
    // Neither owner is named. Which two identifiers failed to match is not
    // something to put in a message that may be logged.
    super('A write was submitted for an owner the delivery context is not acting as.');
    this.name = 'OwnerMismatchError';
  }
}

export interface ReliableWriteCoordinator {
  /**
   * Records an Event so that however many times it is delivered, the Memory
   * holds one row.
   *
   * The caller does not supply an idempotency key and cannot: it is generated
   * here, once, before the write is made durable, and never again. An adapter
   * that assigned its own would be re-implementing the one discipline that
   * makes all of this work, and the failure mode of getting it wrong — a fresh
   * key per retry — is invisible until there are duplicate rows.
   *
   * Delivery is at least once and is not made exactly once — that is not
   * something a network allows. What is once is the observable effect: the
   * server keeps the first write carrying a given key and refuses the rest.
   *
   * Raises whatever `enqueue` raises when the write cannot be made durable: a
   * refused payload, or a full queue. Nothing is sent in that case.
   */
  submitEvent(
    input: SubmitEventInput,
    now: Date,
    context: DeliveryContext,
    delivery: RetryDelivery,
  ): Promise<SubmitResult>;

  /** The same, for a Verification. */
  submitVerification(
    input: SubmitVerificationInput,
    now: Date,
    context: DeliveryContext,
    delivery: RetryDelivery,
  ): Promise<SubmitResult>;
}

export function createReliableWriteCoordinator(queue: RetryQueue): ReliableWriteCoordinator {
  async function submit(
    write: QueuedWrite,
    now: Date,
    context: DeliveryContext,
    delivery: RetryDelivery,
  ): Promise<SubmitResult> {
    if (write.ownerId !== context.ownerId) {
      throw new OwnerMismatchError();
    }

    // Durable first, and nothing is attempted until this returns. The item it
    // answers with is the *sanitized* one — the queue inspects the payload on
    // the way in — and that item is what gets delivered. Building a separate
    // request from the caller's original input would send the unsanitized
    // version once, on the first attempt only, which is both a leak and a write
    // that differs from every retry of itself.
    const item = await queue.enqueue(write, now);

    // One item, by id. Not a drain: a drain would sweep up every other write
    // that happened to be waiting, so recording one Event would inherit the
    // latency and the failures of writes this caller knows nothing about.
    //
    // The attempt runs the queue's own processing, so a first attempt and a
    // retry are the same code — the classification, the backoff and the
    // terminal states are not re-decided here.
    const outcome = await queue.attempt(item.queueItemId, now, context, delivery);

    return { outcome: toSubmitOutcome(outcome), clientEventId: write.clientEventId };
  }

  return {
    submitEvent(input, now, context, delivery) {
      return submit(
        {
          operation: 'appendEvent',
          ownerId: input.ownerId,
          problemId: input.problemId,
          // Once, here, before the write is durable. Never again for this
          // write, in this process or any later one.
          clientEventId: generateClientEventId(),
          problemImportant: input.problemImportant,
          payload: input.payload,
        },
        now,
        context,
        delivery,
      );
    },

    submitVerification(input, now, context, delivery) {
      return submit(
        {
          operation: 'appendVerification',
          ownerId: input.ownerId,
          problemId: input.problemId,
          clientEventId: generateClientEventId(),
          problemImportant: input.problemImportant,
          payload: input.payload,
        },
        now,
        context,
        delivery,
      );
    },
  };
}

/**
 * Translates what the queue did into what the caller is told.
 *
 * `RETRY_EXHAUSTED` and a server refusal become one answer. They differ in why
 * the item stopped, which the item itself records, and not in what the caller
 * can now do: neither will be tried again, and both are still on disk for
 * P3-09 to report.
 *
 * The rest are answers a fresh submission should never see, and each is mapped
 * to whichever true statement is safest rather than to a guess:
 *
 * `NOT_DUE` means the item is live and waiting, which is exactly what `QUEUED`
 * says. It cannot happen here — an item is due the moment it is enqueued — but
 * if it ever did, the write really is on disk and really will be retried.
 *
 * `DELIVERED_UNCLEARED` and `QUEUE_UNAVAILABLE` are the filesystem failing
 * after the write was already admitted, and they are mapped by what is true of
 * the Memory rather than by what is true of the disk. The first means the
 * server accepted the write and the file could not be removed; the second means
 * nothing was decided and the item is untouched. Neither is a write that was
 * never taken, and calling either one unsaved would tell somebody their work
 * was lost on the strength of a failure that happened afterwards.
 *
 * `TERMINAL` and `NOT_FOUND` both mean nothing further will happen to the item
 * through this path. `OWNER_MISMATCH` cannot occur, because the owner is
 * checked before the write is enqueued.
 *
 * What none of them may become is `DELIVERED`. Claiming a write arrived when it
 * did not is the one answer that must never be given wrongly, so anything
 * unrecognised falls to the answer that promises nothing.
 */
function toSubmitOutcome(outcome: AttemptOutcome): SubmitOutcome {
  switch (outcome) {
    // `DELIVERED_UNCLEARED` is the server having taken the write and only the
    // tidying up having failed. What the caller needs to know is whether the
    // Memory has it, and it does.
    case 'DELIVERED':
    case 'DELIVERED_UNCLEARED':
      return 'DELIVERED';
    // `QUEUE_UNAVAILABLE` is storage getting in the way after the write was
    // already durable: the item is on disk and will be tried again, which is
    // exactly what `QUEUED` means.
    case 'RESCHEDULED':
    case 'NOT_DUE':
    case 'QUEUE_UNAVAILABLE':
      return 'QUEUED';
    case 'AUTH_REQUIRED':
      return 'AUTH_REQUIRED';
    default:
      return 'PERMANENT_FAILURE';
  }
}
