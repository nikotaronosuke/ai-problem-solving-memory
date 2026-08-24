/** Verification requests and responses on the Memory JSON API. */

/** How a fix or state was actually checked. */
export const VERIFICATION_TYPES = [
  'TEST',
  'REAL_DEVICE',
  'BUILD',
  'API_RESULT',
  'DB_RESULT',
  'USER_CONFIRMATION',
] as const;

export type VerificationType = (typeof VERIFICATION_TYPES)[number];

/** A Verification exactly as the API sends one. */
export interface VerificationResource {
  readonly verification_id: string;
  readonly owner_id: string;
  readonly problem_id: string;
  readonly verification_type: VerificationType;
  readonly result: boolean;
  readonly summary: string;
  readonly evidence_ref: string | null;
  readonly verified_by: string | null;
  readonly client_event_id: string;
  readonly created_at: string;
}

/** The fields a Verification response must carry, in contract order. */
export const VERIFICATION_RESOURCE_FIELDS = [
  'verification_id',
  'owner_id',
  'problem_id',
  'verification_type',
  'result',
  'summary',
  'evidence_ref',
  'verified_by',
  'client_event_id',
  'created_at',
] as const;

/** What appending a Verification sends. */
export interface AppendVerificationRequest {
  readonly verification_type: VerificationType;
  readonly result: boolean;
  readonly summary: string;
  readonly client_event_id: string;
  readonly evidence_ref?: string | null;
  readonly verified_by?: string | null;
}

/** Every field an append request may carry. */
export const APPEND_VERIFICATION_REQUEST_FIELDS = [
  'verification_type',
  'result',
  'summary',
  'client_event_id',
  'evidence_ref',
  'verified_by',
] as const;

const REQUIRED_APPEND_VERIFICATION_FIELDS = [
  'verification_type',
  'result',
  'summary',
  'client_event_id',
] as const;
const OPTIONAL_APPEND_VERIFICATION_FIELDS = ['evidence_ref', 'verified_by'] as const;
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

/** Whether a parsed body is exactly a Verification resource this contract describes. */
export function isVerificationResource(value: unknown): value is VerificationResource {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== VERIFICATION_RESOURCE_FIELDS.length) {
    return false;
  }
  for (const field of VERIFICATION_RESOURCE_FIELDS) {
    if (!(field in record)) {
      return false;
    }
  }

  return (
    typeof record['verification_id'] === 'string' &&
    typeof record['owner_id'] === 'string' &&
    typeof record['problem_id'] === 'string' &&
    isMember(VERIFICATION_TYPES, record['verification_type']) &&
    typeof record['result'] === 'boolean' &&
    typeof record['summary'] === 'string' &&
    isNullableString(record['evidence_ref']) &&
    isNullableString(record['verified_by']) &&
    typeof record['client_event_id'] === 'string' &&
    typeof record['created_at'] === 'string'
  );
}

/** Whether an append request is exactly one the Verification route accepts. */
export function isAppendVerificationRequest(value: unknown): value is AppendVerificationRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set<string>(APPEND_VERIFICATION_REQUEST_FIELDS);
  if (!Object.keys(record).every((field) => allowed.has(field))) {
    return false;
  }
  for (const field of REQUIRED_APPEND_VERIFICATION_FIELDS) {
    if (!(field in record)) {
      return false;
    }
  }

  return (
    isMember(VERIFICATION_TYPES, record['verification_type']) &&
    typeof record['result'] === 'boolean' &&
    isNonBlank(record['summary']) &&
    typeof record['client_event_id'] === 'string' &&
    UUID.test(record['client_event_id']) &&
    OPTIONAL_APPEND_VERIFICATION_FIELDS.every(
      (field) => !(field in record) || isNullableString(record[field]),
    )
  );
}
