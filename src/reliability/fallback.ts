/**
 * What an assistant does when the Memory is not available.
 *
 * The spec is short about this and unusually specific: a search that fails
 * means carry on investigating normally, a write that fails means carry on
 * working, and the person hears about it only when something important could
 * not be saved. Underneath all three is one requirement — a Memory failure
 * must not become the caller's failure.
 *
 * That requirement is easy to satisfy badly. `catch (error) { carryOn() }`
 * makes the tests pass and turns every bug in this codebase into silence: an
 * owner mismatch, a broken invariant, a delivery implementation that threw
 * where its contract says to return, all indistinguishable from a server being
 * briefly down. So nothing here catches broadly. The failures that may be
 * absorbed are named one at a time, and anything else is re-thrown exactly as
 * it arrived.
 *
 * The line is not "did something go wrong" but "is this a thing the system
 * already knows how to be wrong about":
 *
 *   absorbed   a submit outcome, a full queue, a refused payload, storage that
 *              would not cooperate, a search that is unavailable
 *   re-thrown  everything else, including `OwnerMismatchError`, a delivery that
 *              threw, and any error this module has never heard of
 *
 * What this module does *not* do is run anything. It answers a question and the
 * caller acts on it. Handing the assistant's own work to a Memory library as a
 * callback would put workflow orchestration inside a module whose whole
 * responsibility is remembering how problems were solved — and would make the
 * library the thing that decides whether real work happens.
 */

import {
  OwnerMismatchError,
  type ReliableWriteCoordinator,
  type SubmitEventInput,
  type SubmitOutcome,
  type SubmitResult,
  type SubmitVerificationInput,
} from './coordinator.js';
import type { DeliveryContext, RetryDelivery } from './delivery.js';
import type { QueueableOperation, QueueItem } from './item.js';
import type { RetryQueue } from './queue.js';
import { QueueCapacityError, QueueStorageError } from './store.js';
import { SanitizationRejectedError } from '../sanitization/index.js';

/**
 * The one thing worth interrupting somebody for.
 *
 * The spec lists six occasions to say anything at all, and exactly one of them
 * concerns saving: an important Memory could not be saved. So there is one kind
 * of notice and there will not be more without the spec growing one.
 *
 * The temptation is to split it by cause — the queue was full, the credential
 * was refused, the payload held a secret — and that is a mistake in two
 * directions at once. To the person, all of it means the same thing and the
 * same response: what you were told would be remembered was not. And every
 * distinction added here is a distinction that travels outward, describing the
 * internals of a system they did not ask about.
 */
export const MEMORY_NOTICE_KINDS = ['IMPORTANT_MEMORY_UNSAVED'] as const;

export type MemoryNoticeKind = (typeof MEMORY_NOTICE_KINDS)[number];

/**
 * A notice as an intention, not as words.
 *
 * No sentence appears in this module. Each assistant says things its own way,
 * in its own language, at its own moment, and that is what an adapter is for —
 * a library that produced English prose would be a library that had decided how
 * a Japanese-speaking user is spoken to.
 *
 * What it carries is deliberately thin. `kind` and `operation` are enough to
 * say what happened; `dedupKey` is an opaque handle for recognising that two
 * mentions are the same event. Nothing from the write itself is here — no
 * summary, no reason, no identifier of the Problem, no path, no message from an
 * error. A notice is shown to a person, and the whole point of the thing that
 * failed may have been that it contained something that should not travel.
 */
export interface MemoryNoticeIntent {
  readonly kind: MemoryNoticeKind;
  readonly operation: QueueableOperation;
  /**
   * A stable handle for the same unsaved write, or absent.
   *
   * For correlation only, and never for display: it exists so an adapter can
   * tell that the notice it is about to give is one it has already given. The
   * same write produces the same key whether it is reported the moment it fails
   * or found on disk a week later, which is what makes acknowledgement possible
   * without this module storing any.
   *
   * Absent when the write never became durable. There is nothing to find later,
   * so there is nothing to recognise it as.
   */
  readonly dedupKey?: string;
}

/**
 * Whether the Memory has the write, might still get it, never will, or cannot
 * be said either way.
 *
 * Four states, and keeping them apart is the point:
 *
 *   `SAVED`    the server took it
 *   `PENDING`  there is a durable copy and a path by which it will be tried
 *   `UNSAVED`  it will not be saved, and that is settled
 *   `UNKNOWN`  none of the above can be shown
 *
 * `UNKNOWN` exists because collapsing it into any of the others is a claim
 * about somebody's work that this module cannot support. It arises most often
 * when another queue instance over the same directory delivered the write and
 * removed the file — a good outcome — but it can also mean the file was
 * removed by something else, and neither can be told from the other here.
 */
export const MEMORY_WRITE_STATES = ['SAVED', 'PENDING', 'UNSAVED', 'UNKNOWN'] as const;

export type MemoryWriteState = (typeof MEMORY_WRITE_STATES)[number];

/**
 * What the caller should do, and what it should say.
 *
 * `continueMainWork` is typed as `true` rather than `boolean`, and that is the
 * contract rather than an accident. There is no failure of the Memory that
 * stops the work — that is the requirement in one line — so there is no branch
 * to write and none can be added without changing this type deliberately.
 */
export interface WriteFallbackDecision {
  readonly continueMainWork: true;
  readonly memoryState: MemoryWriteState;
  readonly noticeIntent: MemoryNoticeIntent | null;
}

const dedupKeyFor = (operation: QueueableOperation, clientEventId: string): string =>
  // The logical write, not the file that happens to hold it. A queue item id
  // changes if the same write is ever re-enqueued; this does not. The operation
  // is part of it because Events and Verifications deduplicate in separate
  // tables and can legitimately share a key.
  `${operation}:${clientEventId}`;

const unsaved = (
  operation: QueueableOperation,
  problemImportant: boolean,
  dedupKey?: string,
): WriteFallbackDecision => ({
  continueMainWork: true,
  memoryState: 'UNSAVED',
  noticeIntent: problemImportant
    ? {
        kind: 'IMPORTANT_MEMORY_UNSAVED',
        operation,
        ...(dedupKey === undefined ? {} : { dedupKey }),
      }
    : null,
});

/**
 * Reads a completed submission.
 *
 * `PENDING` covers both a queued write and one whose credential was refused,
 * and neither says anything to the person. That is the part of this contract
 * most likely to be argued with, so the reasoning is worth having in one place:
 * a write in the queue is the failure design working. There is a durable copy,
 * it will be tried again, and a recovery path exists. Announcing it would mean
 * interrupting somebody every time a laptop lost its network, with news that is
 * usually retracted a minute later. The spec asks for notice when an important
 * Memory could not be saved — not when it has not been saved yet.
 *
 * `AUTH_REQUIRED` sits in the same place for the same reason, plus one more: it
 * is fixed by replacing a credential, which is an adapter's business. An
 * adapter that concludes it cannot recover one may decide to escalate; this
 * module does not decide that for it, and does not know what a credential is.
 *
 * `UNSAVED` is reserved for the settled case. A write whose fate cannot be
 * established is `UNKNOWN` and produces no notice: the spec asks that somebody
 * be told when an important Memory could not be saved, and "we cannot tell"
 * is not that.
 */
function fallbackForSubmit(
  result: SubmitResult,
  operation: QueueableOperation,
  problemImportant: boolean,
): WriteFallbackDecision {
  const outcome: SubmitOutcome = result.outcome;

  if (outcome === 'DELIVERED') {
    return { continueMainWork: true, memoryState: 'SAVED', noticeIntent: null };
  }
  if (outcome === 'QUEUED' || outcome === 'AUTH_REQUIRED') {
    return { continueMainWork: true, memoryState: 'PENDING', noticeIntent: null };
  }
  if (outcome === 'UNKNOWN') {
    // Silent, deliberately, and even for an important Problem. The only thing
    // there is to tell somebody is that an important Memory *could not be
    // saved*, and that is not what this says — the usual cause is another
    // queue instance having saved it. A second notice kind meaning "something
    // happened and we are not sure what" would be noise about the internals of
    // a system nobody asked about, and would fire most often when everything
    // had in fact worked.
    return { continueMainWork: true, memoryState: 'UNKNOWN', noticeIntent: null };
  }

  // Permanently refused, or out of attempts. The item stays on disk, so the
  // same notice can be found again later — which is why the key is included.
  return unsaved(operation, problemImportant, dedupKeyFor(operation, result.clientEventId));
}

/**
 * Runs a submission, absorbing the failures that mean the write was not made
 * durable.
 *
 * Exactly three are absorbed, and each is a case where the queue declined to
 * take the write: it was full, the payload held a credential that could not be
 * removed, or the filesystem would not cooperate. In all three nothing was
 * sent, nothing is on disk, and there is nothing to find later — which is why
 * the notice carries no key.
 *
 * They arrive here only from admission. A filesystem failure *after* the write
 * is durable is turned into an outcome by the queue instead, because by then
 * the answer depends on what happened rather than on what broke: a file that
 * could not be deleted after the server accepted the write is a saved write,
 * and an attempt whose result could not be recorded is a pending one. Reaching
 * this `catch` therefore means the write never got in.
 *
 * A refused payload is not a Memory failure in the ordinary sense; the boundary
 * did its job. It is grouped here because from the caller's position the result
 * is identical — the thing was not saved — and because the alternative is to
 * let a security refusal become the exception that stops somebody's work.
 * Nothing about what was found appears in the notice.
 *
 * Everything else propagates. `OwnerMismatchError` is a caller assembling a
 * write for somebody it is not acting as, a delivery that throws has broken its
 * own contract, and an error this module does not recognise is by definition
 * not a failure it knows how to be safe about.
 */
async function submitWithFallback(
  submit: () => Promise<SubmitResult>,
  operation: QueueableOperation,
  problemImportant: boolean,
): Promise<WriteFallbackDecision> {
  let result: SubmitResult;
  try {
    result = await submit();
  } catch (error) {
    if (
      error instanceof QueueCapacityError ||
      error instanceof SanitizationRejectedError ||
      error instanceof QueueStorageError
    ) {
      // No durable copy exists, so no key: there is nothing on disk for a later
      // scan to find and recognise.
      return unsaved(operation, problemImportant);
    }
    if (error instanceof OwnerMismatchError) {
      // Named explicitly although the re-throw below would do it anyway. It is
      // the failure most likely to be reclassified as "a Memory problem" by
      // somebody trying to make a test pass, and being listed here as
      // deliberately not absorbed is the point.
      throw error;
    }
    throw error;
  }

  return fallbackForSubmit(result, operation, problemImportant);
}

/**
 * Records an Event, and answers with what the caller should do about it.
 *
 * One call, one set of facts. The Problem's importance and the kind of write
 * are given once — importance by the caller, the operation by which function
 * was called — and both the submission and the decision are built from them.
 *
 * That is the whole reason these exist rather than a general helper taking the
 * operation and the importance as arguments. With two places to state the same
 * thing, a caller could submit an important Event and describe it as routine,
 * and the notice about it would simply not appear; or submit an Event and
 * describe it as a Verification, and the handle used to recognise it later
 * would name the wrong one. Neither mistake produces a failure at the time.
 * They are only visible as a notice somebody never received.
 */
export function submitEventWithFallback(
  coordinator: ReliableWriteCoordinator,
  input: SubmitEventInput,
  now: Date,
  context: DeliveryContext,
  delivery: RetryDelivery,
): Promise<WriteFallbackDecision> {
  return submitWithFallback(
    () => coordinator.submitEvent(input, now, context, delivery),
    'appendEvent',
    input.problemImportant,
  );
}

/** The same, for a Verification. */
export function submitVerificationWithFallback(
  coordinator: ReliableWriteCoordinator,
  input: SubmitVerificationInput,
  now: Date,
  context: DeliveryContext,
  delivery: RetryDelivery,
): Promise<WriteFallbackDecision> {
  return submitWithFallback(
    () => coordinator.submitVerification(input, now, context, delivery),
    'appendVerification',
    input.problemImportant,
  );
}

/** Everything important that is on disk and will not be delivered. */
export type NoticeScanResult =
  | { readonly kind: 'AVAILABLE'; readonly notices: readonly MemoryNoticeIntent[] }
  | { readonly kind: 'UNAVAILABLE'; readonly notices: readonly [] };

/**
 * Finds the important writes that have stopped.
 *
 * This is what P3-07's refusal to delete a failed item was for. A write that
 * has run out of attempts, or that the server refused outright, stays on disk;
 * without that there would be nothing left to tell anybody about, and the
 * moment it happens is often not a moment anybody is watching — a retry can
 * exhaust itself days later, in a process that started after the one that
 * queued it.
 *
 * Only terminal items, and only important ones. A write still being retried is
 * not a failure yet, and a routine one is not worth interrupting for.
 * Importance is read from the file, which is the only place it can be read from
 * when the reason the write is stuck is that the server cannot be reached.
 *
 * A queue that cannot be read answers `UNAVAILABLE` rather than raising. The
 * caller is not made to fail because a directory was unreadable, and it is
 * deliberately not told "you have unsaved important Memory" either — that would
 * be a guess, and the honest position is that nothing could be determined.
 * Whether a queue that cannot be read is itself worth reporting is an
 * operational question rather than something to tell the person mid-task.
 */
export async function collectImportantUnsavedNotices(queue: RetryQueue): Promise<NoticeScanResult> {
  let items: readonly QueueItem[];
  try {
    ({ items } = await queue.list());
  } catch (error) {
    if (error instanceof QueueStorageError) {
      return { kind: 'UNAVAILABLE', notices: [] };
    }
    throw error;
  }

  const notices = items
    .filter((item) => item.terminalFailure !== null && item.write.problemImportant)
    .map((item): MemoryNoticeIntent => ({
      kind: 'IMPORTANT_MEMORY_UNSAVED',
      operation: item.write.operation,
      dedupKey: dedupKeyFor(item.write.operation, item.write.clientEventId),
    }));

  return { kind: 'AVAILABLE', notices };
}

/**
 * What a search returned, or that it could not run.
 *
 * The distinction that matters is between "nothing matched" and "the search did
 * not happen". Those look similar from a caller's position and mean opposite
 * things: the first is an answer — this problem is new — and the second is the
 * absence of one. Collapsing them would have an assistant conclude a problem is
 * novel because a database was briefly unreachable.
 *
 * So an empty result is `AVAILABLE` with nothing in it. `UNAVAILABLE` carries
 * no detail: a search engine that failed has an error, and that error is a
 * string somebody else wrote.
 *
 * There is no search engine in this codebase yet. This type is the shape one
 * will have to answer in, and it is here rather than with the engine because
 * the contract it has to satisfy — infrastructure failure becomes `UNAVAILABLE`,
 * a bug stays a thrown error — is a decision about failure handling rather than
 * about searching.
 */
export type MemorySearchAttempt<T> =
  { readonly kind: 'AVAILABLE'; readonly value: T } | { readonly kind: 'UNAVAILABLE' };

/** Whether to use what the Memory said, or to proceed as though there were none. */
export type SearchFallbackDecision<T> =
  | { readonly mode: 'USE_MEMORY_RESULT'; readonly value: T }
  | { readonly mode: 'NORMAL_INVESTIGATION' };

/**
 * Reads a search attempt.
 *
 * Silent in both directions. A search that could not run produces no notice,
 * because the spec's list of things worth saying does not include it and
 * because "I could not check my notes" said at every failure is noise around
 * work that is proceeding perfectly well without them. The assistant
 * investigates the way it would have if there had never been a Memory to
 * consult, which is what the spec asks for in as many words.
 *
 * Deliberately not a wrapper around a search function. Catching whatever an
 * engine throws would absorb its bugs along with its outages, and a malformed
 * query silently becoming "no memory available" is a defect that never gets
 * found. An engine converts its own infrastructure failures into `UNAVAILABLE`;
 * anything it throws is a bug and stays one.
 */
export function fallbackForSearch<T>(attempt: MemorySearchAttempt<T>): SearchFallbackDecision<T> {
  return attempt.kind === 'AVAILABLE'
    ? { mode: 'USE_MEMORY_RESULT', value: attempt.value }
    : { mode: 'NORMAL_INVESTIGATION' };
}
