/**
 * What sits in the queue, as a durable record.
 *
 * This is a file format, so it gets a version of its own and a parser that
 * refuses anything it does not recognise. The version is not the API contract
 * version and not the export schema version: a queue file is read by the same
 * program that wrote it, usually minutes later, and the three move for
 * completely unrelated reasons.
 *
 * Two writes can be queued, and only two: appending an Event and appending a
 * Verification. That is not a starting point to be widened later without
 * thought — it is the complete set of writes this server makes idempotent. Both
 * carry a `client_event_id`, and the database has a unique index on
 * `(owner_id, client_event_id)` with the first write winning, so sending one
 * twice is safe by construction. Nothing else here has that property: creating
 * a Problem twice makes two Problems, and a Problem update carries
 * `expected_version`, which is a statement about a moment that a retry has
 * already left behind. Deleting is not on this list and must never be added to
 * it.
 *
 * What the record deliberately does not hold is anything about how to
 * authenticate it. No token, no header, no client id. A queue is a file that
 * survives a crash and sits on a disk; a credential in it is a credential in a
 * backup, in a `tar`, in whatever syncs that directory. The owner is recorded,
 * but only so a replay can check it is handing the item to the right context —
 * it authorises nothing, and the server decides ownership from the credential
 * as it always has.
 */

import { randomUUID } from 'node:crypto';

import type { ClientEventId } from '../domain/client-event-id.js';
import type { EventType, VerificationType } from '../domain/enums.js';
import type { OwnerId } from '../domain/owner.js';
import type { ProblemId } from '../domain/problem.js';

/**
 * The version of the queue file format. Not the API or export version.
 *
 * Moved to `'2'` when `problem_important` was added. A required field is a new
 * format, and calling it the old one would mean a reader could not tell whether
 * the field's absence meant "not important" or "written before the field
 * existed" — two answers with opposite consequences, since one of them
 * silences a notice and the other invents one.
 */
export const RETRY_QUEUE_SCHEMA_VERSION = '2';

/** The writes that may be queued. Exactly the ones the server deduplicates. */
export const QUEUEABLE_OPERATIONS = ['appendEvent', 'appendVerification'] as const;

export type QueueableOperation = (typeof QUEUEABLE_OPERATIONS)[number];

/**
 * Why an item will not be attempted again.
 *
 * A closed set, and `null` while an item is still live. Nothing derived from a
 * response body or an error message appears here: those are written by someone
 * else and end up in a file that outlives the process.
 */
export const TERMINAL_FAILURES = ['PERMANENT_RESPONSE', 'RETRY_EXHAUSTED'] as const;

export type TerminalFailure = (typeof TERMINAL_FAILURES)[number];

/** What an Event append carries, minus the key held at the top level. */
export interface EventIntentPayload {
  readonly eventType: EventType;
  readonly summary: string;
  readonly result?: string | null;
  readonly reason?: string | null;
  readonly sourceAi?: string | null;
  readonly evidenceRef?: string | null;
}

/** What a Verification append carries, minus the key held at the top level. */
export interface VerificationIntentPayload {
  readonly verificationType: VerificationType;
  readonly result: boolean;
  readonly summary: string;
  readonly evidenceRef?: string | null;
  readonly verifiedBy?: string | null;
}

/**
 * A write that has not reached the server yet.
 *
 * `problemImportant` is a snapshot of the Problem's `importance` as it stood
 * when the write was made, not a property of the Event itself. There is no
 * second notion of importance in this system: the spec gives one to a Problem,
 * where a person can set it, and none to an Event. It is recorded here because
 * the moment it is needed — a write that has finally run out of attempts,
 * possibly days later and in a different process — is a moment when the server
 * may well be the thing that is unreachable. A file that has to be explained by
 * asking a server is not a file that works when the server is down.
 *
 * `clientEventId` sits here rather than inside `payload`, and that placement is
 * the point rather than tidiness. It is the thing that makes a retry safe, so
 * it has exactly one home, is assigned before the first attempt by whoever
 * builds the intent, and is never regenerated. A queue that minted a fresh key
 * per attempt would turn one Event into one row per retry, which is the failure
 * the key exists to prevent.
 */
export type QueuedWrite =
  | {
      readonly operation: 'appendEvent';
      readonly ownerId: OwnerId;
      readonly problemId: ProblemId;
      readonly clientEventId: ClientEventId;
      readonly problemImportant: boolean;
      readonly payload: EventIntentPayload;
    }
  | {
      readonly operation: 'appendVerification';
      readonly ownerId: OwnerId;
      readonly problemId: ProblemId;
      readonly clientEventId: ClientEventId;
      readonly problemImportant: boolean;
      readonly payload: VerificationIntentPayload;
    };

/** A queued write, with everything the queue itself tracks about it. */
export interface QueueItem {
  readonly queueItemId: string;
  readonly write: QueuedWrite;
  readonly enqueuedAt: string;
  readonly attemptCount: number;
  /** When it may next be attempted. `null` once it is terminal. */
  readonly nextAttemptAt: string | null;
  readonly terminalFailure: TerminalFailure | null;
}

/** A fresh identifier for a queue file. Generated here, never taken in. */
export function generateQueueItemId(): string {
  return randomUUID();
}

/** The on-disk shape. Snake case, because a file is not a TypeScript value. */
interface StoredItem {
  schema_version: string;
  queue_item_id: string;
  owner_id: string;
  operation: string;
  problem_id: string;
  client_event_id: string;
  problem_important: boolean;
  payload: unknown;
  enqueued_at: string;
  attempt_count: number;
  next_attempt_at: string | null;
  terminal_failure: string | null;
}

export function serialiseQueueItem(item: QueueItem): string {
  const stored: StoredItem = {
    schema_version: RETRY_QUEUE_SCHEMA_VERSION,
    queue_item_id: item.queueItemId,
    owner_id: item.write.ownerId,
    operation: item.write.operation,
    problem_id: item.write.problemId,
    client_event_id: item.write.clientEventId,
    problem_important: item.write.problemImportant,
    payload: item.write.payload,
    enqueued_at: item.enqueuedAt,
    attempt_count: item.attemptCount,
    next_attempt_at: item.nextAttemptAt,
    terminal_failure: item.terminalFailure,
  };

  // Two spaces, so a person opening one of these can read it. The file is the
  // interface when something has gone wrong.
  return `${JSON.stringify(stored, null, 2)}\n`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/**
 * Reads a stored item, or answers `null`.
 *
 * `null` rather than a thrown error carrying detail, because the detail is the
 * contents of a file this process did not necessarily write. A truncated
 * record, a record from a future version, a record somebody edited by hand —
 * all of them are unreadable in the same way, and the only safe thing to say
 * about one is that it could not be read. `JSON.parse` says more than that: its
 * message quotes the bytes it choked on.
 *
 * Nothing is repaired and nothing is deleted. A file that cannot be read is
 * left exactly where it is, so whoever comes looking still has it.
 */
export function parseQueueItem(text: string): QueueItem | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const stored = raw as Partial<StoredItem>;

  if (stored.schema_version !== RETRY_QUEUE_SCHEMA_VERSION) {
    return null;
  }
  if (
    typeof stored.queue_item_id !== 'string' ||
    !UUID.test(stored.queue_item_id) ||
    typeof stored.owner_id !== 'string' ||
    !UUID.test(stored.owner_id) ||
    typeof stored.problem_id !== 'string' ||
    !UUID.test(stored.problem_id) ||
    typeof stored.client_event_id !== 'string' ||
    !UUID.test(stored.client_event_id)
  ) {
    return null;
  }
  if (typeof stored.problem_important !== 'boolean') {
    // Required, and not defaulted. Guessing `false` would silence a notice the
    // person asked for; guessing `true` would invent ones they did not. A file
    // that cannot answer is a file this build does not understand.
    return null;
  }
  if (typeof stored.enqueued_at !== 'string' || !ISO.test(stored.enqueued_at)) {
    return null;
  }
  if (
    typeof stored.attempt_count !== 'number' ||
    !Number.isInteger(stored.attempt_count) ||
    stored.attempt_count < 0
  ) {
    return null;
  }
  if (
    stored.next_attempt_at !== null &&
    (typeof stored.next_attempt_at !== 'string' || !ISO.test(stored.next_attempt_at))
  ) {
    return null;
  }
  if (
    stored.terminal_failure !== null &&
    !TERMINAL_FAILURES.includes(stored.terminal_failure as TerminalFailure)
  ) {
    return null;
  }
  if (
    typeof stored.payload !== 'object' ||
    stored.payload === null ||
    Array.isArray(stored.payload)
  ) {
    return null;
  }

  const operation = QUEUEABLE_OPERATIONS.find((candidate) => candidate === stored.operation);
  if (operation === undefined) {
    // Including anything a later version might add. An item this build does
    // not understand is left for the build that does.
    return null;
  }

  const write = {
    operation,
    ownerId: stored.owner_id as OwnerId,
    problemId: stored.problem_id as ProblemId,
    clientEventId: stored.client_event_id as ClientEventId,
    problemImportant: stored.problem_important,
    payload: stored.payload,
  } as QueuedWrite;

  return {
    queueItemId: stored.queue_item_id,
    write,
    enqueuedAt: stored.enqueued_at,
    attemptCount: stored.attempt_count,
    nextAttemptAt: stored.next_attempt_at,
    terminalFailure: stored.terminal_failure as TerminalFailure | null,
  };
}
