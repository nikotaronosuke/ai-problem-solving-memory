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
 *
 * The key set is exact. The server declares the resource closed, so a body
 * carrying a field nobody here knows about means the two ends disagree about
 * the contract — and a passing predicate would let that disagreement travel
 * into whatever consumes a Problem. This matters more now than it did with one
 * caller: a list check runs this per element, and an unknown field arriving in
 * one Problem of forty is exactly the kind of drift that otherwise surfaces
 * long after the release that caused it.
 */
export function isProblemResource(value: unknown): value is ProblemResource {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;

  // Presence and count first, so a missing field fails as a missing field
  // rather than as whatever `undefined` happens to fail on below — and so an
  // extra one fails as the contract disagreement it is.
  if (Object.keys(record).length !== PROBLEM_RESOURCE_FIELDS.length) {
    return false;
  }
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

/**
 * Whether a parsed body is the Problem list envelope.
 *
 * The envelope has exactly one field and is checked as closed, and every
 * element is checked. One malformed Problem makes the whole answer unreadable
 * rather than being quietly skipped: a list silently missing a Problem reads as
 * a project that does not have it, and the next thing a caller does with that
 * belief is start a second Problem for something already being investigated.
 *
 * Whether the Problems in it are the ones that were asked for is a separate
 * question, and not one this predicate can answer — it never saw the request.
 */
export function isProblemListBody(value: unknown): value is { problems: ProblemResource[] } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || !('problems' in record)) {
    return false;
  }
  const problems = record['problems'];
  return Array.isArray(problems) && problems.every((entry) => isProblemResource(entry));
}

/**
 * What moving a Problem to another status sends.
 *
 * Three fields, all required, and the key set is closed. Where the Problem is
 * now is deliberately not among them: the server reads that from the record,
 * and a request carrying both would be two claims that can disagree.
 *
 * `expected_version` is the Problem's concurrency token, shared with every
 * other write to it rather than being a second lock of its own. `changed_by` is
 * descriptive provenance for the change log and decides nothing.
 */
export interface TransitionProblemStatusRequest {
  readonly target_status: ProblemStatus;
  readonly expected_version: number;
  readonly changed_by: string;
}

/** The fields a transition request carries. Exactly these. */
export const TRANSITION_PROBLEM_STATUS_REQUEST_FIELDS = [
  'target_status',
  'expected_version',
  'changed_by',
] as const;

/**
 * Whether a request is one this client will send.
 *
 * What is checked is what the contract requires of the *shape*: a canonical
 * status, a version that is a whole number a record could actually be at, and
 * a `changed_by` with something in it.
 *
 * What is deliberately **not** checked is whether the move makes sense. Which
 * transitions are legal from which status is a rule about a Problem's
 * lifecycle, it depends on state this client has not read, and the server
 * enforces it against the record rather than against a request. A matrix
 * mirrored here would be a second copy of that rule, wrong the first time the
 * lifecycle gained a state, and it would refuse requests a correct server would
 * have accepted. So any canonical target status may be asked for, and the
 * answer to whether it was appropriate comes back from the server.
 */
export function isTransitionProblemStatusRequest(
  value: unknown,
): value is TransitionProblemStatusRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;

  const keys = Object.keys(record);
  if (keys.length !== TRANSITION_PROBLEM_STATUS_REQUEST_FIELDS.length) {
    return false;
  }
  for (const field of TRANSITION_PROBLEM_STATUS_REQUEST_FIELDS) {
    if (!(field in record)) {
      return false;
    }
  }

  const version = record['expected_version'];

  return (
    isMember(PROBLEM_STATUSES, record['target_status']) &&
    typeof version === 'number' &&
    Number.isInteger(version) &&
    version >= 1 &&
    isNonBlank(record['changed_by'])
  );
}

/**
 * What starting a Problem sends.
 *
 * Three required fields and three optional ones. Everything else a Problem has
 * — its status, its version, its confidence, its freshness, its flags — comes
 * from the server, which starts every Problem the same way. A caller cannot
 * declare a Problem already verified, and the absence of those fields from this
 * type is the first place that is true.
 *
 * The optional fields are `string | null` and both spellings mean something:
 * absent leaves the column alone, and `null` states there is no answer. They
 * are kept apart all the way to the wire rather than collapsed into one.
 */
export interface CreateProblemRequest {
  readonly environment_id: string;
  readonly title: string;
  readonly symptoms: string;
  readonly problem_domain?: string | null;
  readonly suspected_boundary?: string | null;
  readonly source_ai?: string | null;
}

/** The fields a create request may carry, in the contract's order. */
export const CREATE_PROBLEM_REQUEST_FIELDS = [
  'environment_id',
  'title',
  'symptoms',
  'problem_domain',
  'suspected_boundary',
  'source_ai',
] as const;

/** The three a request cannot leave out. */
const REQUIRED_CREATE_PROBLEM_FIELDS = ['environment_id', 'title', 'symptoms'] as const;

/** The three the server declares nullable free-form text. */
const OPTIONAL_CREATE_PROBLEM_FIELDS = [
  'problem_domain',
  'suspected_boundary',
  'source_ai',
] as const;

/**
 * The id shape the server's routes accept in a path or a body.
 *
 * Mirrored rather than imported, like every other part of this contract.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether text has something in it, which is what the server requires. */
function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && /\S/.test(value);
}

/**
 * Whether a request is one this client will send.
 *
 * The key set is closed, so a field the server would refuse — `status`,
 * `version`, a typo — fails here rather than as a `400` after a round trip.
 *
 * What is deliberately *not* checked is anything the server would accept. An
 * empty string is a legal value for the optional text fields, and refusing it
 * would make this client stricter than the contract it speaks for — which is
 * the kind of divergence that gets discovered as "the API works but the client
 * says no".
 */
export function isCreateProblemRequest(value: unknown): value is CreateProblemRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;

  const allowed = new Set<string>(CREATE_PROBLEM_REQUEST_FIELDS);
  if (!Object.keys(record).every((key) => allowed.has(key))) {
    return false;
  }
  for (const field of REQUIRED_CREATE_PROBLEM_FIELDS) {
    if (!(field in record)) {
      return false;
    }
  }

  const environmentId = record['environment_id'];
  if (typeof environmentId !== 'string' || !UUID.test(environmentId)) {
    return false;
  }
  if (!isNonBlank(record['title']) || !isNonBlank(record['symptoms'])) {
    return false;
  }

  return OPTIONAL_CREATE_PROBLEM_FIELDS.every(
    (field) => !(field in record) || isNullableString(record[field]),
  );
}
