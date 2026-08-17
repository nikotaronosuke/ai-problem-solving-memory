/**
 * The Problem as the JSON API returns it, and the check that it really is one.
 *
 * ## Why this is the wire shape rather than a domain model
 *
 * `snake_case`, ISO strings, every field exactly as `GET /v1/problems/:id`
 * sends it. This is a client for a JSON API, and a client that renamed fields
 * and parsed dates would be a second domain layer: two places where "what a
 * Problem is" is decided, disagreeing quietly the first time one of them is
 * extended. Callers that want a model of their own can build one; they will
 * build it from something that says what the server said.
 *
 * ## Why the values are checked when TypeScript already describes them
 *
 * A type annotation on a parsed response is a claim about a value that arrived
 * over a network from a process this one does not control. It is checked
 * because the alternative is that a missing field becomes `undefined` and
 * travels — into an adapter, into a prompt, eventually into a Memory — as
 * though the server had said it.
 *
 * The check is deliberately small and hand-written. A schema library would be
 * a runtime dependency for one resource, and a generator would be a build step
 * and a generated file to keep honest; both are larger than what they replace
 * while this client has one method. What is checked is what the published
 * contract requires: every field present, primitives of the right type, the
 * three closed value sets closed, and nullables allowed to be null and nothing
 * else.
 *
 * The value sets are mirrored from the contract rather than imported from the
 * server, for the same reason the error codes are: a client that reached into
 * the server's source could only run beside it. A test in the server's suite
 * compares both lists against the server's own, so a mirror that falls behind
 * fails there rather than in production.
 */

/** The states a Problem can be in. Mirrored from the published contract. */
export const PROBLEM_STATUSES = [
  'INVESTIGATING',
  'FIX_CANDIDATE',
  'VERIFIED',
  'PAUSED',
  'CLOSED_UNRESOLVED',
] as const;

export type ProblemStatus = (typeof PROBLEM_STATUSES)[number];

/** Whether a fix addressed the cause or worked around it. */
export const FIX_KINDS = ['ROOT_FIX', 'WORKAROUND'] as const;

export type FixKind = (typeof FIX_KINDS)[number];

/** How much the record is trusted. */
export const CONFIDENCES = ['HIGH', 'MEDIUM', 'LOW', 'CONFLICTED'] as const;

export type Confidence = (typeof CONFIDENCES)[number];

/** Whether the record still describes current conditions. */
export const FRESHNESSES = ['CURRENT', 'STALE_UNKNOWN', 'SUPERSEDED', 'INVALID'] as const;

export type Freshness = (typeof FRESHNESSES)[number];

/**
 * A Problem, exactly as the API sends one.
 *
 * `created_at` and `updated_at` stay strings. Parsing them here would decide,
 * on every caller's behalf, that a timestamp is a `Date` — including for the
 * callers that only want to pass it on, who would then have to turn it back.
 */
export interface ProblemResource {
  readonly problem_id: string;
  readonly owner_id: string;
  readonly project_id: string;
  readonly environment_id: string;
  readonly title: string;
  readonly symptoms: string;
  readonly problem_domain: string | null;
  readonly suspected_boundary: string | null;
  readonly source_ai: string | null;
  readonly status: ProblemStatus;
  readonly fix_kind: FixKind | null;
  readonly importance: boolean;
  readonly confidence: Confidence;
  readonly freshness: Freshness;
  readonly memory_read_enabled: boolean;
  readonly memory_write_enabled: boolean;
  readonly suppressed: boolean;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
}

/** The fields a Problem response must carry, in the contract's order. */
export const PROBLEM_RESOURCE_FIELDS = [
  'problem_id',
  'owner_id',
  'project_id',
  'environment_id',
  'title',
  'symptoms',
  'problem_domain',
  'suspected_boundary',
  'source_ai',
  'status',
  'fix_kind',
  'importance',
  'confidence',
  'freshness',
  'memory_read_enabled',
  'memory_write_enabled',
  'suppressed',
  'version',
  'created_at',
  'updated_at',
] as const;

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isMember<T extends string>(members: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (members as readonly string[]).includes(value);
}

/**
 * Whether a parsed body is a Problem this contract describes.
 *
 * A predicate rather than a parser: nothing is coerced, defaulted or dropped.
 * A body that passes is returned as it arrived, which is what makes "the
 * client did not change what the server said" checkable rather than promised.
 */
export function isProblemResource(value: unknown): value is ProblemResource {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;

  // Presence first, so a missing field fails as a missing field rather than as
  // whatever `undefined` happens to fail on below.
  for (const field of PROBLEM_RESOURCE_FIELDS) {
    if (!(field in record)) {
      return false;
    }
  }

  return (
    isString(record['problem_id']) &&
    isString(record['owner_id']) &&
    isString(record['project_id']) &&
    isString(record['environment_id']) &&
    isString(record['title']) &&
    isString(record['symptoms']) &&
    isNullableString(record['problem_domain']) &&
    isNullableString(record['suspected_boundary']) &&
    isNullableString(record['source_ai']) &&
    isMember(PROBLEM_STATUSES, record['status']) &&
    (record['fix_kind'] === null || isMember(FIX_KINDS, record['fix_kind'])) &&
    typeof record['importance'] === 'boolean' &&
    isMember(CONFIDENCES, record['confidence']) &&
    isMember(FRESHNESSES, record['freshness']) &&
    typeof record['memory_read_enabled'] === 'boolean' &&
    typeof record['memory_write_enabled'] === 'boolean' &&
    typeof record['suppressed'] === 'boolean' &&
    typeof record['version'] === 'number' &&
    Number.isInteger(record['version']) &&
    isString(record['created_at']) &&
    isString(record['updated_at'])
  );
}
