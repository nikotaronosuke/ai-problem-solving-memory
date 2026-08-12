/**
 * Database access for events.
 *
 * Append and list only. Events are append-only, so there is deliberately no
 * update and no application delete path.
 *
 * As elsewhere, every function takes an `OwnerContext`, the owner comes from
 * the context rather than caller input, and reads are scoped by `owner_id`.
 *
 * This is the minimum P1-09 needs. The append/list API, including turning a
 * duplicate `client_event_id` into a replay of the original result, is P2-04;
 * the general repository layer is P1-12.
 */

import type { ClientEventId } from '../domain/client-event-id.js';
import type { EventType } from '../domain/enums.js';
import { generateEventId, toEventSummary, type EventId } from '../domain/event.js';
import type { OwnerContext, OwnerId } from '../domain/owner.js';
import type { ProblemId } from '../domain/problem.js';
import { normaliseOptionalText } from '../domain/text.js';
import type { DatabasePool } from './pool.js';

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

/**
 * Raised when the target problem is not one of the context owner's.
 *
 * Deliberately the same error whether the problem does not exist at all or
 * belongs to someone else.
 */
export class ProblemNotAvailableError extends Error {
  constructor() {
    super('No such problem for this owner.');
    this.name = 'ProblemNotAvailableError';
  }
}

/**
 * Raised when this owner has already recorded a write with the same
 * `client_event_id`.
 *
 * P1-09 refuses the duplicate. P2-04 replaces this with returning the original
 * event, so a retry becomes a no-op rather than an error.
 */
export class DuplicateClientEventIdError extends Error {
  constructor() {
    super('This client event id has already been recorded for this owner.');
    this.name = 'DuplicateClientEventIdError';
  }
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

/** Whether an error is PostgreSQL rejecting a specific constraint. */
function violates(error: unknown, code: string, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === code && candidate.constraint === constraint;
}

const EVENT_COLUMNS = `event_id, owner_id, problem_id, event_type, summary, result, reason,
  source_ai, evidence_ref, client_event_id, created_at`;

/**
 * Appends an event to one of the context owner's problems.
 *
 * Fails if this owner has already used the same `clientEventId`, so a retried
 * write cannot land twice.
 */
export async function appendEvent(
  pool: DatabasePool,
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
    inserted = await pool.query<EventRow>(
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
    if (violates(error, '23503', OWNER_PROBLEM_FK)) {
      // The (owner, problem) pair does not exist. Whether the problem is
      // unknown or someone else's is not distinguished, by design.
      throw new ProblemNotAvailableError();
    }
    if (violates(error, '23505', CLIENT_EVENT_ID_KEY)) {
      throw new DuplicateClientEventIdError();
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
  pool: DatabasePool,
  context: OwnerContext,
  problemId: ProblemId,
): Promise<EventRecord[]> {
  const result = await pool.query<EventRow>(
    `select ${EVENT_COLUMNS}
       from public.events
      where owner_id = $1 and problem_id = $2
      order by created_at asc, event_id asc`,
    [context.ownerId, problemId],
  );

  return result.rows.map(toRecord);
}
