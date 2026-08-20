/**
 * The search, as the JSON API asks for it and answers it.
 *
 * ## Why this is the wire shape, again
 *
 * `snake_case` in and `snake_case` out, timestamps as strings, every field
 * exactly as `POST /v1/problems/:problem_id/search` names it. The reasoning is
 * the same as for a Problem, and it matters more here: a search answer is the
 * deepest structure the API returns, five kinds of material per candidate with
 * two nested lists of their own. A client that renamed its fields would be a
 * second description of what a candidate is, and the first thing anyone would
 * do with it is disagree about a field somebody added on one side only.
 *
 * ## Why the contract is mirrored rather than imported
 *
 * Nothing in this package reaches the server's source. A client that did could
 * only run beside the repository it was built in, which is the opposite of what
 * a common client is for. So every closed set, bound and field list below is
 * written from the published contract, and the server's own test suite compares
 * the two — a mirror that falls behind fails there rather than in production.
 *
 * ## What is validated, and why so much of it
 *
 * Everything, on the way out and on the way in.
 *
 * Outbound, because a TypeScript type on a caller's object is a claim about a
 * value that may have come from a config file, a prompt or another process. A
 * request that is wrong is refused here, before it is spent: the server would
 * refuse it too, but a round trip to learn something already knowable is a
 * round trip, and the failure it returns cannot say which field was wrong.
 *
 * Inbound, because a missing field becomes `undefined` and travels — into an
 * adapter, into a prompt, eventually into a Memory — as though the server had
 * said it. Objects are checked for their exact key set, not merely for the keys
 * this contract needs, because the server declares every one of them closed: a
 * field nobody here knows about is a server saying something this client cannot
 * read, and quietly passing it on is how two versions of a contract start
 * living in one system.
 *
 * ## What is deliberately not validated
 *
 * Anything about meaning. Nothing here decides whether a candidate is worth
 * reading, whether a score is high, whether a dead end forbids a direction, or
 * whether the material contradicts itself. And no secret detection: the privacy
 * policy is the Memory Server's, applied in one place, and a second one here
 * would be a second privacy contract that could disagree with it.
 */

import { CONFIDENCES, FIX_KINDS, FRESHNESSES, PROBLEM_STATUSES } from './problem.js';
import type { Confidence, FixKind, Freshness, ProblemStatus } from './problem.js';

/**
 * The structural feature vocabulary this client speaks.
 *
 * An exact value, not a floor. The server refuses anything else rather than
 * reinterpreting it, so a client that sent a version it had invented would be
 * refused for a reason it could not see.
 */
export const MEMORY_SEARCH_STRUCTURAL_FEATURE_SCHEMA_VERSION = '1';

/** The six lists a structural description is made of, in the contract's order. */
export const MEMORY_SEARCH_STRUCTURAL_FEATURE_LISTS = [
  'symptom_patterns',
  'suspected_boundaries',
  'occurrence_conditions',
  'successful_directions',
  'dead_end_directions',
  'environment_facts',
] as const;

export type MemorySearchStructuralFeatureList =
  (typeof MEMORY_SEARCH_STRUCTURAL_FEATURE_LISTS)[number];

/** The eight keys a features block has: the version, the domain, the six lists. */
export const MEMORY_SEARCH_STRUCTURAL_FEATURE_FIELDS = [
  'schema_version',
  'problem_domain',
  ...MEMORY_SEARCH_STRUCTURAL_FEATURE_LISTS,
] as const;

/** How many entries one feature list may carry. */
export const MEMORY_SEARCH_MAX_STRUCTURAL_FEATURE_ITEMS = 20;

/** How long one feature string, or the problem domain, may be. */
export const MEMORY_SEARCH_MAX_STRUCTURAL_FEATURE_LENGTH = 300;

/** How long the lexical query may be. */
export const MEMORY_SEARCH_MAX_LEXICAL_TEXT_LENGTH = 1000;

/**
 * How long the semantic query may be.
 *
 * Longer than the lexical one, deliberately: the first is terms and the second
 * is a description, and they are bounded by what each is for.
 */
export const MEMORY_SEARCH_MAX_SEMANTIC_TEXT_LENGTH = 4000;

/** The four fields a search request has. Exactly four. */
export const MEMORY_SEARCH_REQUEST_FIELDS = [
  'source_ai',
  'lexical_text',
  'semantic_text',
  'current_features',
] as const;

/** How the current Problem is described so candidates can be compared to it. */
export interface MemorySearchStructuralFeatures {
  /**
   * The vocabulary version, and only this one.
   *
   * `typeof` the constant rather than the literal spelled again: the runtime
   * check below compares against that same constant, so the type a caller
   * compiles against and the value the client will accept cannot come apart. A
   * second copy of `'1'` here would be a second place to update, and the one
   * that was forgotten would be the type — which fails last and least visibly.
   *
   * It was `string` until P5-02c-impl-2's formal review, which meant a caller
   * could write `schema_version: '999'`, compile, and learn at runtime that the
   * client mirrors a contract its own types did not describe.
   */
  readonly schema_version: typeof MEMORY_SEARCH_STRUCTURAL_FEATURE_SCHEMA_VERSION;
  readonly problem_domain: string | null;
  readonly symptom_patterns: readonly string[];
  readonly suspected_boundaries: readonly string[];
  readonly occurrence_conditions: readonly string[];
  readonly successful_directions: readonly string[];
  readonly dead_end_directions: readonly string[];
  readonly environment_facts: readonly string[];
}

/**
 * What a caller asks for.
 *
 * Four fields and no fifth. No owner or client, because ownership is the
 * credential's; no Project, because a search is cross-project and the current
 * one is read from the Problem; no limit of any kind, because how many
 * candidates each stage considers is the server's; no vector, model, provider or
 * cache instruction, for reasons that belong to the server and not to whoever
 * happens to be asking. None of those are listed as forbidden anywhere below —
 * the key set is exact, so they are refused structurally rather than by a
 * blacklist somebody has to remember to extend.
 */
export interface MemorySearchRequest {
  /** Which assistant is asking. Attribution for the usage record, nothing else. */
  readonly source_ai: string;
  readonly lexical_text: string;
  readonly semantic_text: string;
  readonly current_features: MemorySearchStructuralFeatures;
}

/** Whether the semantic channel ran, and if not, why not. */
export const MEMORY_SEARCH_SEMANTIC_STATUSES = [
  'USED',
  'SKIPPED_SENSITIVE_QUERY',
  'PROVIDER_UNAVAILABLE',
] as const;

export type MemorySearchSemanticStatus = (typeof MEMORY_SEARCH_SEMANTIC_STATUSES)[number];

/** Whether the structural stage ran, and if not, why not. */
export const MEMORY_SEARCH_STRUCTURAL_STATUSES = [
  'USED',
  'NOT_NEEDED',
  'SKIPPED_SENSITIVE_INPUT',
  'RERANKER_UNAVAILABLE',
  'RERANKER_OUTPUT_INVALID',
  'STRUCTURAL_DATA_UNAVAILABLE',
] as const;

export type MemorySearchStructuralStatus = (typeof MEMORY_SEARCH_STRUCTURAL_STATUSES)[number];

/** How a candidate's Project relates to the one being worked in. */
export const MEMORY_SEARCH_PROJECT_RELATIONS = [
  'CURRENT_PROJECT',
  'SAME_TECH_OTHER_PROJECT',
  'OTHER_TECH',
  'UNKNOWN_TECH',
] as const;

export type MemorySearchProjectRelation = (typeof MEMORY_SEARCH_PROJECT_RELATIONS)[number];

/** The dimensions a structural comparison can report a match on. */
export const MEMORY_SEARCH_COMPARISON_DIMENSIONS = [
  'problem_domain',
  ...MEMORY_SEARCH_STRUCTURAL_FEATURE_LISTS,
] as const;

export type MemorySearchComparisonDimension = (typeof MEMORY_SEARCH_COMPARISON_DIMENSIONS)[number];

/**
 * What must be re-checked before any candidate is acted on.
 *
 * Always all four, in this order. A search result is a candidate rather than an
 * answer, and this list is how the server says so.
 */
export const MEMORY_SEARCH_REVALIDATION_CHECKS = [
  'CURRENT_CODE',
  'CURRENT_ENVIRONMENT',
  'RELEVANT_VERSION',
  'OFFICIAL_SPEC',
] as const;

export type MemorySearchRevalidationCheck = (typeof MEMORY_SEARCH_REVALIDATION_CHECKS)[number];

/** The kinds of check a Verification can be. */
export const MEMORY_SEARCH_VERIFICATION_TYPES = [
  'TEST',
  'REAL_DEVICE',
  'BUILD',
  'API_RESULT',
  'DB_RESULT',
  'USER_CONFIRMATION',
] as const;

export type MemorySearchVerificationType = (typeof MEMORY_SEARCH_VERIFICATION_TYPES)[number];

/** One check somebody actually ran, including the ones that failed. */
export interface MemorySearchEvidence {
  readonly verification_type: MemorySearchVerificationType;
  readonly result: boolean;
  readonly summary: string;
  readonly evidence_ref: string | null;
  readonly created_at: string;
}

/** Where a candidate was placed, and by what. */
export interface MemorySearchRanking {
  readonly problem_id: string;
  readonly project_id: string;
  readonly confidence: Confidence;
  readonly freshness: Freshness;
  readonly suppressed: boolean;
  readonly project_relation: MemorySearchProjectRelation;
  /** Null whenever no reranker scored it. Never a stand-in number. */
  readonly structural_score: number | null;
  /** Where the first retrieval stage put it, gaps and all. */
  readonly hybrid_rank: number;
  readonly matched_dimensions: readonly MemorySearchComparisonDimension[];
  readonly ranking_rank: number;
}

/** What a candidate was true of, and what has to be re-established. */
export interface MemorySearchRevalidation {
  /** Returned exactly as stored. Its keys are not fixed and are not read here. */
  readonly historical_environment: Readonly<Record<string, unknown>>;
  readonly evidence: readonly MemorySearchEvidence[];
  readonly required_checks: readonly MemorySearchRevalidationCheck[];
}

/** A direction that did not work, and under what conditions. */
export interface MemorySearchDeadEndWarning {
  readonly summary: string;
  readonly result: string | null;
  readonly reason: string | null;
  readonly evidence_ref: string | null;
  readonly created_at: string;
}

/** The current Problem's own comparable material. */
export interface MemorySearchConflictSubject {
  readonly symptoms: string;
  readonly problem_domain: string | null;
  readonly suspected_boundary: string | null;
  readonly status: ProblemStatus;
  readonly fix_kind: FixKind | null;
}

/** The Memory on the other side of a disagreement. One hop, never followed. */
export interface MemorySearchConflictOther {
  readonly problem_id: string;
  readonly project_id: string;
  readonly symptoms: string;
  readonly problem_domain: string | null;
  readonly suspected_boundary: string | null;
  readonly status: ProblemStatus;
  readonly fix_kind: FixKind | null;
  readonly confidence: Confidence;
  readonly freshness: Freshness;
  readonly historical_environment: Readonly<Record<string, unknown>>;
  readonly evidence: readonly MemorySearchEvidence[];
}

/** One recorded disagreement, with the account of it as it was written. */
export interface MemorySearchContradiction {
  readonly reason: string;
  readonly relation_created_at: string;
  readonly other: MemorySearchConflictOther;
}

/** What contradicts a candidate, with no verdict about which side wins. */
export interface MemorySearchConflict {
  readonly subject: MemorySearchConflictSubject;
  readonly contradictions: readonly MemorySearchContradiction[];
}

/** One Memory worth considering, with the material to judge it. */
export interface MemorySearchCandidate {
  readonly ranking: MemorySearchRanking;
  readonly revalidation: MemorySearchRevalidation;
  readonly dead_end_warnings: readonly MemorySearchDeadEndWarning[];
  readonly successful_directions: readonly string[];
  readonly conflict: MemorySearchConflict;
}

/**
 * The three ways the server answers a search with `200`.
 *
 * All three are ordinary answers. An empty candidate list is one: nothing worth
 * reading is a fact about the memory rather than a fault. So is a Problem whose
 * owner turned automatic reading off, and one that changed while the search was
 * running — both carry only their kind, because what to do about either is the
 * caller's decision and the server declines to make it.
 */
export type MemorySearchResponse =
  | {
      readonly kind: 'SEARCHED';
      readonly candidates: readonly MemorySearchCandidate[];
      readonly semantic_status: MemorySearchSemanticStatus;
      readonly structural_status: MemorySearchStructuralStatus;
    }
  | { readonly kind: 'MEMORY_READ_DISABLED' }
  | { readonly kind: 'CURRENT_SOURCE_CHANGED' };

/**
 * What `search()` returns: the server's three answers, plus one this client
 * names.
 *
 * `CURRENT_PROBLEM_NOT_AVAILABLE` is the `404` turned into a typed answer,
 * because for a search it is one. Every other operation on this client raises
 * for a `404` — a Problem you asked to read and cannot is a failed read — but a
 * search's Problem is its *context*, and "the context is gone" is something a
 * caller routinely has to handle rather than an exception to its plan.
 *
 * It is deliberately not pretended to be part of the server's `200` schema. The
 * server has three kinds; this union has four, and the fourth is this client's
 * normalisation of a status code.
 */
export type MemorySearchOutcome =
  MemorySearchResponse | { readonly kind: 'CURRENT_PROBLEM_NOT_AVAILABLE' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether an object has exactly these keys and no others.
 *
 * The server declares every object in this contract closed, so "no others" is
 * part of what it promised. A field this client has never heard of means the
 * two ends disagree about the contract, and passing it through would let that
 * disagreement travel instead of surfacing.
 */
function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  if (actual.length !== keys.length) {
    return false;
  }
  return keys.every((key) => key in record);
}

function isMember<T extends string>(members: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (members as readonly string[]).includes(value);
}

function isNonBlankString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= maxLength;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/** A rank the server publishes: a position, so a whole number from one. */
function isRank(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isMemberArray<T extends string>(members: readonly T[], value: unknown): value is T[] {
  return Array.isArray(value) && value.every((entry) => isMember(members, entry));
}

function isArrayOf<T>(value: unknown, predicate: (entry: unknown) => entry is T): value is T[] {
  return Array.isArray(value) && value.every((entry) => predicate(entry));
}

/**
 * ===========================================================================
 * What a caller may send
 * ===========================================================================
 */

/**
 * Whether a features block is one this contract describes.
 *
 * Exact keys, the exact version, the exact bounds. Nothing is coerced, dropped,
 * truncated or de-duplicated: a request that does not fit is refused, because
 * silently sending something other than what a caller asked for is worse than
 * refusing — the caller would then be reasoning about a search it did not make.
 */
export function isMemorySearchStructuralFeatures(
  value: unknown,
): value is MemorySearchStructuralFeatures {
  if (!isRecord(value) || !hasExactKeys(value, MEMORY_SEARCH_STRUCTURAL_FEATURE_FIELDS)) {
    return false;
  }

  if (value['schema_version'] !== MEMORY_SEARCH_STRUCTURAL_FEATURE_SCHEMA_VERSION) {
    return false;
  }

  const domain = value['problem_domain'];
  if (domain !== null && !isNonBlankString(domain, MEMORY_SEARCH_MAX_STRUCTURAL_FEATURE_LENGTH)) {
    return false;
  }

  return MEMORY_SEARCH_STRUCTURAL_FEATURE_LISTS.every((list) => {
    const entries = value[list];
    if (!Array.isArray(entries) || entries.length > MEMORY_SEARCH_MAX_STRUCTURAL_FEATURE_ITEMS) {
      return false;
    }
    return entries.every((entry) =>
      isNonBlankString(entry, MEMORY_SEARCH_MAX_STRUCTURAL_FEATURE_LENGTH),
    );
  });
}

/** Whether a value is a search request this contract describes. */
export function isMemorySearchRequest(value: unknown): value is MemorySearchRequest {
  if (!isRecord(value) || !hasExactKeys(value, MEMORY_SEARCH_REQUEST_FIELDS)) {
    return false;
  }

  return (
    // Unbounded here on purpose: the server's own bound on `source_ai` is that
    // it is non-blank, and inventing a length the contract does not publish
    // would refuse a caller the server would have accepted.
    isNonBlankString(value['source_ai'], Number.POSITIVE_INFINITY) &&
    isNonBlankString(value['lexical_text'], MEMORY_SEARCH_MAX_LEXICAL_TEXT_LENGTH) &&
    isNonBlankString(value['semantic_text'], MEMORY_SEARCH_MAX_SEMANTIC_TEXT_LENGTH) &&
    isMemorySearchStructuralFeatures(value['current_features'])
  );
}

/**
 * ===========================================================================
 * What the server may answer
 * ===========================================================================
 */

const EVIDENCE_FIELDS = [
  'verification_type',
  'result',
  'summary',
  'evidence_ref',
  'created_at',
] as const;

function isEvidence(value: unknown): value is MemorySearchEvidence {
  if (!isRecord(value) || !hasExactKeys(value, EVIDENCE_FIELDS)) {
    return false;
  }
  return (
    isMember(MEMORY_SEARCH_VERIFICATION_TYPES, value['verification_type']) &&
    // Both values are kept. A check that failed is evidence too, and a list of
    // only the passing ones would read as though everything tried had worked.
    typeof value['result'] === 'boolean' &&
    typeof value['summary'] === 'string' &&
    isNullableString(value['evidence_ref']) &&
    typeof value['created_at'] === 'string'
  );
}

const RANKING_FIELDS = [
  'problem_id',
  'project_id',
  'confidence',
  'freshness',
  'suppressed',
  'project_relation',
  'structural_score',
  'hybrid_rank',
  'matched_dimensions',
  'ranking_rank',
] as const;

function isRanking(value: unknown): value is MemorySearchRanking {
  if (!isRecord(value) || !hasExactKeys(value, RANKING_FIELDS)) {
    return false;
  }
  return (
    typeof value['problem_id'] === 'string' &&
    typeof value['project_id'] === 'string' &&
    isMember(CONFIDENCES, value['confidence']) &&
    isMember(FRESHNESSES, value['freshness']) &&
    typeof value['suppressed'] === 'boolean' &&
    isMember(MEMORY_SEARCH_PROJECT_RELATIONS, value['project_relation']) &&
    (value['structural_score'] === null || typeof value['structural_score'] === 'number') &&
    isRank(value['hybrid_rank']) &&
    isMemberArray(MEMORY_SEARCH_COMPARISON_DIMENSIONS, value['matched_dimensions']) &&
    isRank(value['ranking_rank'])
  );
}

const REVALIDATION_FIELDS = ['historical_environment', 'evidence', 'required_checks'] as const;

/**
 * Whether the four required checks are all there.
 *
 * Four entries, no repeats, every one a member of a four-value set — which
 * together is the only way to say "all four" without depending on the order
 * they arrive in. The order is not asserted and not changed: it is the
 * server's, and it is returned exactly as it came.
 */
function isRequiredChecks(value: unknown): value is MemorySearchRevalidationCheck[] {
  if (!isMemberArray(MEMORY_SEARCH_REVALIDATION_CHECKS, value)) {
    return false;
  }
  return (
    value.length === MEMORY_SEARCH_REVALIDATION_CHECKS.length &&
    new Set(value).size === MEMORY_SEARCH_REVALIDATION_CHECKS.length
  );
}

function isRevalidation(value: unknown): value is MemorySearchRevalidation {
  if (!isRecord(value) || !hasExactKeys(value, REVALIDATION_FIELDS)) {
    return false;
  }
  return (
    // An object, and nothing said about its keys: an Environment snapshot is
    // whatever was recorded, and imposing a shape on it here would be this
    // client deciding what an environment is.
    isRecord(value['historical_environment']) &&
    isArrayOf(value['evidence'], isEvidence) &&
    isRequiredChecks(value['required_checks'])
  );
}

const DEAD_END_FIELDS = ['summary', 'result', 'reason', 'evidence_ref', 'created_at'] as const;

function isDeadEndWarning(value: unknown): value is MemorySearchDeadEndWarning {
  if (!isRecord(value) || !hasExactKeys(value, DEAD_END_FIELDS)) {
    return false;
  }
  return (
    typeof value['summary'] === 'string' &&
    // The nullable fields must be present and null rather than absent: "nobody
    // recorded a reason" and "this contract has no reason field" are different
    // statements, and only one of them is true.
    isNullableString(value['result']) &&
    isNullableString(value['reason']) &&
    isNullableString(value['evidence_ref']) &&
    typeof value['created_at'] === 'string'
  );
}

const CONFLICT_SUBJECT_FIELDS = [
  'symptoms',
  'problem_domain',
  'suspected_boundary',
  'status',
  'fix_kind',
] as const;

function isConflictSubject(value: unknown): value is MemorySearchConflictSubject {
  if (!isRecord(value) || !hasExactKeys(value, CONFLICT_SUBJECT_FIELDS)) {
    return false;
  }
  return (
    typeof value['symptoms'] === 'string' &&
    isNullableString(value['problem_domain']) &&
    isNullableString(value['suspected_boundary']) &&
    isMember(PROBLEM_STATUSES, value['status']) &&
    (value['fix_kind'] === null || isMember(FIX_KINDS, value['fix_kind']))
  );
}

const CONFLICT_OTHER_FIELDS = [
  'problem_id',
  'project_id',
  'symptoms',
  'problem_domain',
  'suspected_boundary',
  'status',
  'fix_kind',
  'confidence',
  'freshness',
  'historical_environment',
  'evidence',
] as const;

function isConflictOther(value: unknown): value is MemorySearchConflictOther {
  if (!isRecord(value) || !hasExactKeys(value, CONFLICT_OTHER_FIELDS)) {
    return false;
  }
  return (
    typeof value['problem_id'] === 'string' &&
    typeof value['project_id'] === 'string' &&
    typeof value['symptoms'] === 'string' &&
    isNullableString(value['problem_domain']) &&
    isNullableString(value['suspected_boundary']) &&
    isMember(PROBLEM_STATUSES, value['status']) &&
    (value['fix_kind'] === null || isMember(FIX_KINDS, value['fix_kind'])) &&
    isMember(CONFIDENCES, value['confidence']) &&
    isMember(FRESHNESSES, value['freshness']) &&
    isRecord(value['historical_environment']) &&
    isArrayOf(value['evidence'], isEvidence)
  );
}

const CONTRADICTION_FIELDS = ['reason', 'relation_created_at', 'other'] as const;

function isContradiction(value: unknown): value is MemorySearchContradiction {
  if (!isRecord(value) || !hasExactKeys(value, CONTRADICTION_FIELDS)) {
    return false;
  }
  return (
    typeof value['reason'] === 'string' &&
    typeof value['relation_created_at'] === 'string' &&
    isConflictOther(value['other'])
  );
}

const CONFLICT_FIELDS = ['subject', 'contradictions'] as const;

function isConflict(value: unknown): value is MemorySearchConflict {
  if (!isRecord(value) || !hasExactKeys(value, CONFLICT_FIELDS)) {
    return false;
  }
  return isConflictSubject(value['subject']) && isArrayOf(value['contradictions'], isContradiction);
}

/** The five kinds of material one candidate carries. */
export const MEMORY_SEARCH_CANDIDATE_FIELDS = [
  'ranking',
  'revalidation',
  'dead_end_warnings',
  'successful_directions',
  'conflict',
] as const;

function isCandidate(value: unknown): value is MemorySearchCandidate {
  if (!isRecord(value) || !hasExactKeys(value, MEMORY_SEARCH_CANDIDATE_FIELDS)) {
    return false;
  }
  return (
    isRanking(value['ranking']) &&
    isRevalidation(value['revalidation']) &&
    isArrayOf(value['dead_end_warnings'], isDeadEndWarning) &&
    isStringArray(value['successful_directions']) &&
    isConflict(value['conflict'])
  );
}

const SEARCHED_FIELDS = ['kind', 'candidates', 'semantic_status', 'structural_status'] as const;

/**
 * Whether a `200` body is one of the three answers this contract describes.
 *
 * A predicate rather than a parser, like every other check in this package:
 * nothing is coerced, nothing is filled in, nothing is reordered. A body that
 * passes is returned exactly as it arrived, which is what makes "the client did
 * not change what the server said" something a test can check rather than
 * something this comment promises.
 */
export function isMemorySearchResponse(value: unknown): value is MemorySearchResponse {
  if (!isRecord(value)) {
    return false;
  }

  const kind = value['kind'];

  if (kind === 'MEMORY_READ_DISABLED' || kind === 'CURRENT_SOURCE_CHANGED') {
    // The kind and nothing else. A field alongside it would be the server
    // telling a caller what to do about a setting or a race, which is exactly
    // what these two outcomes exist to avoid.
    return hasExactKeys(value, ['kind']);
  }

  if (kind !== 'SEARCHED' || !hasExactKeys(value, SEARCHED_FIELDS)) {
    return false;
  }

  return (
    isArrayOf(value['candidates'], isCandidate) &&
    isMember(MEMORY_SEARCH_SEMANTIC_STATUSES, value['semantic_status']) &&
    isMember(MEMORY_SEARCH_STRUCTURAL_STATUSES, value['structural_status'])
  );
}
