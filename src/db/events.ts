/**
 * Database access for events.
 *
 * Append and list only. Events are append-only, so there is deliberately no
 * update and no application delete path.
 *
 * As elsewhere, every function takes an `OwnerContext`, the owner comes from
 * the context rather than caller input, and reads are scoped by `owner_id`.
 *
 * Since P2-04, appending is idempotent on `client_event_id`: a retry returns
 * the event the first attempt wrote rather than failing. The race handling
 * that makes that safe is confined to this module — nothing above it sees a
 * PostgreSQL error code or knows that a retry happened.
 *
 * Verifications still refuse a duplicate. Their replay is P2-05, and the two
 * are deliberately not changed together.
 */

import type { ClientEventId } from '../domain/client-event-id.js';
import type { EventType } from '../domain/enums.js';
import { generateEventId, toEventSummary, type EventId } from '../domain/event.js';
import type { OwnerContext, OwnerId } from '../domain/owner.js';
import type { ProblemId } from '../domain/problem.js';
import { normaliseOptionalText } from '../domain/text.js';
import {
  FOREIGN_KEY_VIOLATION,
  ProblemNotAvailableError,
  UNIQUE_VIOLATION,
  violatesConstraint,
} from './errors.js';
import type { DatabaseExecutor } from './executor.js';

const OWNER_PROBLEM_FK = 'events_owner_id_problem_id_fkey';
const CLIENT_EVENT_ID_KEY = 'events_owner_id_client_event_id_key';

export interface EventRecord {
  readonly eventId: EventId;
  readonly ownerId: OwnerId;
  readonly problemId: ProblemId;
  readonly eventType: EventType;
  readonly summary: string;
  readonly result: string | null;
  readonly reason: string | null;
  readonly sourceAi: string | null;
  readonly evidenceRef: string | null;
  readonly clientEventId: ClientEventId;
  readonly createdAt: Date;
}

/**
 * What a caller supplies to append an event.
 *
 * There is no owner field. `clientEventId` is required and supplied by the
 * caller: one generated here would differ on every retry and protect nothing.
 */
export interface AppendEventInput {
  readonly problemId: ProblemId;
  readonly eventType: EventType;
  readonly summary: string;
  readonly clientEventId: ClientEventId;
  readonly result?: string | null;
  readonly reason?: string | null;
  readonly sourceAi?: string | null;
  readonly evidenceRef?: string | null;
}

interface EventRow {
  event_id: string;
  owner_id: string;
  problem_id: string;
  event_type: EventType;
  summary: string;
  result: string | null;
  reason: string | null;
  source_ai: string | null;
  evidence_ref: string | null;
  client_event_id: string;
  created_at: Date;
}

function toRecord(row: EventRow): EventRecord {
  // The id columns are `uuid`, so the values are already normalised UUIDs.
  return {
    eventId: row.event_id as EventId,
    ownerId: row.owner_id as OwnerId,
    problemId: row.problem_id as ProblemId,
    eventType: row.event_type,
    summary: row.summary,
    result: row.result,
    reason: row.reason,
    sourceAi: row.source_ai,
    evidenceRef: row.evidence_ref,
    clientEventId: row.client_event_id as ClientEventId,
    createdAt: row.created_at,
  };
}

const EVENT_COLUMNS = `event_id, owner_id, problem_id, event_type, summary, result, reason,
  source_ai, evidence_ref, client_event_id, created_at`;

/**
 * Reads back the event this owner already recorded under a client event id.
 *
 * Scoped by owner, like every read here, so one owner's key cannot reach
 * another's event even though the values may coincide.
 *
 * Not exported: it exists to answer "what did the first attempt write?" after
 * a unique violation, and it is not a lookup the API offers.
 */
async function findEventByClientEventId(
  executor: DatabaseExecutor,
  context: OwnerContext,
  clientEventId: ClientEventId,
): Promise<EventRecord | undefined> {
  const result = await executor.query<EventRow>(
    `select ${EVENT_COLUMNS}
       from public.events
      where owner_id = $1 and client_event_id = $2`,
    [context.ownerId, clientEventId],
  );

  const row = result.rows[0];
  return row === undefined ? undefined : toRecord(row);
}

/**
 * Appends an event to one of the context owner's problems.
 *
 * Idempotent on `clientEventId`. The first attempt writes the event; any
 * later attempt carrying the same id returns that same event, unchanged. The
 * retry's payload is not applied — the first write is the write, and a client
 * that reused a key by mistake should see the event it actually created
 * rather than have the mistake hidden behind a second row.
 *
 * The insert is attempted first and the unique index on
 * `(owner_id, client_event_id)` is what decides. Reading before writing would
 * leave a window in which two concurrent attempts both find nothing and both
 * insert; here one of them loses to the constraint and reads back the winner,
 * so concurrent retries still produce exactly one event.
 *
 * One consequence of that shape: the failed insert aborts its transaction. It
 * works because each `executor.query` is its own implicit transaction. If this
 * is ever called inside an explicit one, the insert will need a savepoint —
 * the constraint stays the arbiter either way.
 *
 * Whether the problem exists is checked above this, before the append. The
 * unique index is evaluated before the foreign key, so an unknown problem plus
 * a reused key would otherwise replay an event the caller never had a right to
 * see. Owner scope is settled first, and this is the second line, not the
 * first.
 */
export async function appendEvent(
  executor: DatabaseExecutor,
  context: OwnerContext,
  input: AppendEventInput,
): Promise<EventRecord> {
  const summary = toEventSummary(input.summary);
  const result = normaliseOptionalText(input.result);
  const reason = normaliseOptionalText(input.reason);
  const sourceAi = normaliseOptionalText(input.sourceAi);
  const evidenceRef = normaliseOptionalText(input.evidenceRef);
  const eventId = generateEventId();

  let inserted;
  try {
    inserted = await executor.query<EventRow>(
      `insert into public.events
              (event_id, owner_id, problem_id, event_type, summary, result, reason,
               source_ai, evidence_ref, client_event_id)
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         returning ${EVENT_COLUMNS}`,
      [
        eventId,
        context.ownerId,
        input.problemId,
        input.eventType,
        summary,
        result,
        reason,
        sourceAi,
        evidenceRef,
        input.clientEventId,
      ],
    );
  } catch (error) {
    if (violatesConstraint(error, FOREIGN_KEY_VIOLATION, OWNER_PROBLEM_FK)) {
      // The (owner, problem) pair does not exist. Whether the problem is
      // unknown or someone else's is not distinguished, by design.
      throw new ProblemNotAvailableError();
    }
    if (violatesConstraint(error, UNIQUE_VIOLATION, CLIENT_EVENT_ID_KEY)) {
      // The same write, sent again. Return what it produced the first time.
      const original = await findEventByClientEventId(executor, context, input.clientEventId);
      if (original === undefined) {
        // The constraint fired, so the row was there a moment ago. Events have
        // no delete path, so this should be unreachable; saying so beats
        // returning something invented.
        throw new Error('Event conflicted on client_event_id but could not be read back.');
      }
      return original;
    }
    throw error;
  }

  const row = inserted.rows[0];
  if (row === undefined) {
    throw new Error('Event insert returned no row.');
  }

  return toRecord(row);
}

/**
 * Lists one of the context owner's problems' events, oldest first.
 *
 * `event_id` breaks ties so that two events recorded in the same instant still
 * come back in a stable order rather than an arbitrary one.
 *
 * A problem that does not exist and one belonging to someone else both yield
 * an empty list, so the result cannot confirm an id exists.
 */
export async function listEvents(
  executor: DatabaseExecutor,
  context: OwnerContext,
  problemId: ProblemId,
): Promise<EventRecord[]> {
  const result = await executor.query<EventRow>(
    `select ${EVENT_COLUMNS}
       from public.events
      where owner_id = $1 and problem_id = $2
      order by created_at asc, event_id asc`,
    [context.ownerId, problemId],
  );

  return result.rows.map(toRecord);
}
