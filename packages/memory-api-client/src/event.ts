/**
 * Event requests and responses on the Memory JSON API.
 *
 * An Event is append-only. The caller supplies a `client_event_id` before its
 * first attempt and reuses it for a retry; the server returns the first write
 * made under that owner-wide key. Because a replay may therefore describe a
 * different Problem or payload from the attempted resend, the resource check
 * validates the wire contract without pretending the response must echo the
 * latest request.
 */

/** Meaningful state changes while solving a Problem. */
export const EVENT_TYPES = [
  'HYPOTHESIS',
  'ATTEMPT',
  'DEAD_END',
  'DISCOVERY',
  'FIX',
  'USER_CORRECTION',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** An Event exactly as the API sends one. */
export interface EventResource {
  readonly event_id: string;
  readonly owner_id: string;
  readonly problem_id: string;
  readonly event_type: EventType;
  readonly summary: string;
  readonly result: string | null;
  readonly reason: string | null;
  readonly source_ai: string | null;
  readonly evidence_ref: string | null;
  readonly client_event_id: string;
  readonly created_at: string;
}

/** The fields an Event response must carry, in contract order. */
export const EVENT_RESOURCE_FIELDS = [
  'event_id',
  'owner_id',
  'problem_id',
  'event_type',
  'summary',
  'result',
  'reason',
  'source_ai',
  'evidence_ref',
  'client_event_id',
  'created_at',
] as const;

/** What appending an Event sends. */
export interface AppendEventRequest {
  readonly event_type: EventType;
  readonly summary: string;
  readonly client_event_id: string;
  readonly result?: string | null;
  readonly reason?: string | null;
  readonly source_ai?: string | null;
  readonly evidence_ref?: string | null;
}

/** Every field an append request may carry. */
export const APPEND_EVENT_REQUEST_FIELDS = [
  'event_type',
  'summary',
  'client_event_id',
  'result',
  'reason',
  'source_ai',
  'evidence_ref',
] as const;

const REQUIRED_APPEND_EVENT_FIELDS = ['event_type', 'summary', 'client_event_id'] as const;
const OPTIONAL_APPEND_EVENT_FIELDS = ['result', 'reason', 'source_ai', 'evidence_ref'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isMember<T extends string>(members: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (members as readonly string[]).includes(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && /\S/u.test(value);
}

/** Whether a parsed body is exactly an Event resource this contract describes. */
export function isEventResource(value: unknown): value is EventResource {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== EVENT_RESOURCE_FIELDS.length) {
    return false;
  }
  for (const field of EVENT_RESOURCE_FIELDS) {
    if (!(field in record)) {
      return false;
    }
  }

  return (
    typeof record['event_id'] === 'string' &&
    typeof record['owner_id'] === 'string' &&
    typeof record['problem_id'] === 'string' &&
    isMember(EVENT_TYPES, record['event_type']) &&
    typeof record['summary'] === 'string' &&
    isNullableString(record['result']) &&
    isNullableString(record['reason']) &&
    isNullableString(record['source_ai']) &&
    isNullableString(record['evidence_ref']) &&
    typeof record['client_event_id'] === 'string' &&
    typeof record['created_at'] === 'string'
  );
}

/** Whether an append request is exactly one the Event route accepts. */
export function isAppendEventRequest(value: unknown): value is AppendEventRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set<string>(APPEND_EVENT_REQUEST_FIELDS);
  if (!Object.keys(record).every((field) => allowed.has(field))) {
    return false;
  }
  for (const field of REQUIRED_APPEND_EVENT_FIELDS) {
    if (!(field in record)) {
      return false;
    }
  }

  return (
    isMember(EVENT_TYPES, record['event_type']) &&
    isNonBlank(record['summary']) &&
    typeof record['client_event_id'] === 'string' &&
    UUID.test(record['client_event_id']) &&
    OPTIONAL_APPEND_EVENT_FIELDS.every(
      (field) => !(field in record) || isNullableString(record[field]),
    )
  );
}
