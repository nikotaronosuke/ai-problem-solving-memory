/**
 * The public wire shape of a search, and the mapping to it.
 *
 * ## Why this is a separate file from `resources.ts`
 *
 * A search result is the deepest structure this API returns — five kinds of
 * material per candidate, two of them nested lists of their own — and it is the
 * only one assembled from an application service rather than read from a table.
 * It keeps the same rules as its neighbour: schema and mapper adjacent, every
 * public field written out by hand, `additionalProperties: false` everywhere,
 * `Date` rendered as an ISO string.
 *
 * ## Why nothing is spread
 *
 * `RetrievalMemoryCandidate` is an internal type five stages contribute to, and
 * the next task to add a field to it must not thereby publish it. Spreading
 * would make the public contract a consequence of an internal one; writing each
 * field out makes a new public field a deliberate line of code someone has to
 * add here.
 *
 * ## Why nothing is dropped either
 *
 * Explicit is not an excuse to be selective. Everything the pipeline
 * deliberately assembled travels: the ranking provenance including the gap-
 * keeping hybrid rank, the matched dimensions, the historical environment
 * exactly as stored, every Verification including failed ones, every field of
 * every dead-end warning, the derived successful directions, and the conflict
 * subject with all of each contradiction's material. A caller has to be able to
 * make its own judgement, and it cannot do that from a summary of the evidence.
 *
 * ## What is not here
 *
 * No answer, no recommendation, no verdict, no winner, no should-retry, no
 * natural-language account of any of it. The server returns material; deciding
 * what it means for the situation in front of the caller is the caller's, and
 * a field here that made that decision would be the one thing this design has
 * refused from the beginning.
 */

import type {
  SemanticChannelStatus,
  RetrievalMemoryCandidate,
  RetrievalSearchOutcome,
} from '../app/index.js';
import { SEMANTIC_CHANNEL_STATUSES } from '../app/index.js';
import {
  CONFIDENCES,
  FIX_KINDS,
  FRESHNESSES,
  PROBLEM_STATUSES,
  VERIFICATION_TYPES,
} from '../domain/enums.js';
import type { ConflictContext, Contradiction } from '../domain/retrieval-conflict.js';
import type { DeadEndWarning } from '../domain/retrieval-dead-end.js';
import { PROJECT_RELATIONS } from '../domain/retrieval-ranking.js';
import type { RankedMemoryCandidate } from '../domain/retrieval-ranking.js';
import { REVALIDATION_CHECKS } from '../domain/retrieval-revalidation.js';
import type {
  RevalidationContext,
  VerificationEvidence,
} from '../domain/retrieval-revalidation.js';
import {
  MAX_SEARCH_TEXT_LENGTH,
  MAX_VECTOR_SEARCH_TEXT_LENGTH,
} from '../domain/retrieval-search.js';
import {
  STRUCTURAL_COMPARISON_DIMENSIONS,
  STRUCTURAL_RERANK_STATUSES,
} from '../domain/retrieval-structural-rerank.js';
import type { StructuralRerankStatus } from '../domain/retrieval-structural-rerank.js';
import {
  MAX_STRUCTURAL_FEATURE_ITEMS,
  MAX_STRUCTURAL_FEATURE_LENGTH,
  STRUCTURAL_FEATURE_LISTS,
  STRUCTURAL_FEATURE_SCHEMA_VERSION,
} from '../domain/retrieval-summary.js';
import { NON_BLANK_STRING_SCHEMA } from './resources.js';

/** A non-blank string with a bound, for the two query fields. */
const boundedText = (maxLength: number) => ({ ...NON_BLANK_STRING_SCHEMA, maxLength }) as const;

/**
 * The structural description a caller sends: the domain's own type, as a wire
 * contract.
 *
 * Built from the domain's list names, version and bounds rather than restated,
 * so a change to the vocabulary cannot leave this schema describing the old
 * one. A generic object was rejected outright: it would accept anything and
 * push every rejection into the parser, which returns a fixed message and
 * cannot tell a caller which field was wrong.
 *
 * The bounds are duplicated in the sense that the parser also enforces them,
 * and that is the point — this is the transport boundary saying what the API
 * accepts, and the parser is the trust boundary saying what the application
 * will act on. Neither replaces the other.
 */
export const SEARCH_CURRENT_FEATURES_SCHEMA = {
  type: 'object',
  properties: {
    // Exact, not a minimum: a caller describing its Problem under a
    // vocabulary this server does not speak is refused rather than
    // reinterpreted.
    schema_version: { type: 'string', enum: [STRUCTURAL_FEATURE_SCHEMA_VERSION] },
    problem_domain: {
      anyOf: [
        { ...NON_BLANK_STRING_SCHEMA, maxLength: MAX_STRUCTURAL_FEATURE_LENGTH },
        { type: 'null' },
      ],
    },
    ...Object.fromEntries(
      STRUCTURAL_FEATURE_LISTS.map((list) => [
        list,
        {
          type: 'array',
          maxItems: MAX_STRUCTURAL_FEATURE_ITEMS,
          items: { ...NON_BLANK_STRING_SCHEMA, maxLength: MAX_STRUCTURAL_FEATURE_LENGTH },
        },
      ]),
    ),
  },
  required: ['schema_version', 'problem_domain', ...STRUCTURAL_FEATURE_LISTS],
  additionalProperties: false,
} as const;

/**
 * The request body: four fields, all required, nothing else accepted.
 *
 * What is refused matters as much as what is accepted. `owner_id` and
 * `client_id`, because ownership is established by the credential and a
 * request that could name an owner would be a request that could name the
 * wrong one. `project_id`, because a search is cross-project by default and
 * the current Project is read from the Problem rather than asserted alongside
 * it. `hybrid_limit`, `rerank_limit`, `limit`, because how many candidates
 * each stage considers is the server's to tune and a published knob is a
 * published promise. `embedding` and any vector, because a query vector must
 * come from the same space the artifacts were embedded in, and the only way
 * to guarantee that is for the server to produce it.
 */
export const SEARCH_REQUEST_SCHEMA = {
  type: 'object',
  properties: {
    // Attribution for the usage record, and nothing else: it does not reach
    // the cache key, the ranking, the query, or any provider request, and it
    // authorises nothing.
    source_ai: NON_BLANK_STRING_SCHEMA,
    lexical_text: boundedText(MAX_SEARCH_TEXT_LENGTH),
    semantic_text: boundedText(MAX_VECTOR_SEARCH_TEXT_LENGTH),
    current_features: SEARCH_CURRENT_FEATURES_SCHEMA,
  },
  required: ['source_ai', 'lexical_text', 'semantic_text', 'current_features'],
  additionalProperties: false,
} as const;

const ISO_TIMESTAMP = { type: 'string', format: 'date-time' } as const;
const NULLABLE_TEXT = { type: ['string', 'null'] } as const;

const VERIFICATION_EVIDENCE_SCHEMA = {
  type: 'object',
  properties: {
    // Closed against the domain's own list. It was `type: 'string'`, which
    // published a free-form field the server never accepts — and the client
    // that generates from this document would have copied the loose version as
    // its source of truth before anyone noticed the difference.
    verification_type: { type: 'string', enum: [...VERIFICATION_TYPES] },
    // Both values are kept: a check that failed is evidence too, and a list
    // of only the passing ones would read as though everything tried worked.
    result: { type: 'boolean' },
    summary: { type: 'string' },
    evidence_ref: NULLABLE_TEXT,
    created_at: ISO_TIMESTAMP,
  },
  required: ['verification_type', 'result', 'summary', 'evidence_ref', 'created_at'],
  additionalProperties: false,
} as const;

const RANKING_SCHEMA = {
  type: 'object',
  properties: {
    problem_id: { type: 'string', format: 'uuid' },
    project_id: { type: 'string', format: 'uuid' },
    confidence: { type: 'string', enum: [...CONFIDENCES] },
    freshness: { type: 'string', enum: [...FRESHNESSES] },
    suppressed: { type: 'boolean' },
    project_relation: { type: 'string', enum: [...PROJECT_RELATIONS] },
    // Null on every degraded path. A judgement is never turned into a number,
    // so the absence of a score is reported rather than filled in with one.
    structural_score: { type: ['number', 'null'] },
    // Where the first retrieval stage put this candidate, gaps and all: a gap
    // is the visible trace of a candidate dropped between the stages.
    hybrid_rank: { type: 'integer', minimum: 1 },
    matched_dimensions: {
      type: 'array',
      items: { type: 'string', enum: [...STRUCTURAL_COMPARISON_DIMENSIONS] },
    },
    ranking_rank: { type: 'integer', minimum: 1 },
  },
  required: [
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
  ],
  additionalProperties: false,
} as const;

const REVALIDATION_SCHEMA = {
  type: 'object',
  properties: {
    // Returned exactly as stored. Which keys a snapshot holds is not fixed,
    // so nothing here names one; picking values out would mean inventing a
    // schema the data does not have.
    historical_environment: { type: 'object', additionalProperties: true },
    evidence: { type: 'array', items: VERIFICATION_EVIDENCE_SCHEMA },
    // Always the four, always all of them — and now the schema says so rather
    // than merely permitting it. An `items` enum alone allowed a caller to read
    // this as "zero or more of these", which is the opposite of the claim: a
    // search result is a candidate rather than an answer, and the four checks
    // are what makes that claim concrete.
    //
    // The bounds and the uniqueness together are what pin it. Four entries,
    // no repeats, drawn from a four-value enum, is exactly the full set — with
    // any one of the three constraints removed, a conforming document could
    // carry a subset or the same check four times.
    required_checks: {
      type: 'array',
      minItems: REVALIDATION_CHECKS.length,
      maxItems: REVALIDATION_CHECKS.length,
      uniqueItems: true,
      items: { type: 'string', enum: [...REVALIDATION_CHECKS] },
    },
  },
  required: ['historical_environment', 'evidence', 'required_checks'],
  additionalProperties: false,
} as const;

const DEAD_END_WARNING_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    result: NULLABLE_TEXT,
    reason: NULLABLE_TEXT,
    evidence_ref: NULLABLE_TEXT,
    created_at: ISO_TIMESTAMP,
  },
  // No `blocked`, no `severity`, no `retry_allowed`. A dead end records that a
  // direction did not work under those conditions; it is not a prohibition,
  // and a field shaped like one would make it into one.
  required: ['summary', 'result', 'reason', 'evidence_ref', 'created_at'],
  additionalProperties: false,
} as const;

const CONFLICT_SUBJECT_SCHEMA = {
  type: 'object',
  properties: {
    symptoms: { type: 'string' },
    problem_domain: NULLABLE_TEXT,
    suspected_boundary: NULLABLE_TEXT,
    status: { type: 'string', enum: [...PROBLEM_STATUSES] },
    fix_kind: { type: ['string', 'null'], enum: [...FIX_KINDS, null] },
  },
  required: ['symptoms', 'problem_domain', 'suspected_boundary', 'status', 'fix_kind'],
  additionalProperties: false,
} as const;

const CONFLICT_OTHER_SCHEMA = {
  type: 'object',
  properties: {
    problem_id: { type: 'string', format: 'uuid' },
    project_id: { type: 'string', format: 'uuid' },
    symptoms: { type: 'string' },
    problem_domain: NULLABLE_TEXT,
    suspected_boundary: NULLABLE_TEXT,
    status: { type: 'string', enum: [...PROBLEM_STATUSES] },
    fix_kind: { type: ['string', 'null'], enum: [...FIX_KINDS, null] },
    confidence: { type: 'string', enum: [...CONFIDENCES] },
    freshness: { type: 'string', enum: [...FRESHNESSES] },
    historical_environment: { type: 'object', additionalProperties: true },
    evidence: { type: 'array', items: VERIFICATION_EVIDENCE_SCHEMA },
  },
  // One hop. No dead ends of its own, no conflicts of its own, no rank — it
  // was never a candidate of this search, and giving it a placement would
  // mean inventing one nobody computed.
  required: [
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
  ],
  additionalProperties: false,
} as const;

const CONTRADICTION_SCHEMA = {
  type: 'object',
  properties: {
    // Returned as stored, never summarised: the account of a disagreement is
    // exactly the part a paraphrase would flatten.
    reason: { type: 'string' },
    relation_created_at: ISO_TIMESTAMP,
    other: CONFLICT_OTHER_SCHEMA,
  },
  required: ['reason', 'relation_created_at', 'other'],
  additionalProperties: false,
} as const;

const CONFLICT_SCHEMA = {
  type: 'object',
  properties: {
    subject: CONFLICT_SUBJECT_SCHEMA,
    // No `winner`, no `preferred`, no `resolution`. Conflicting memories are
    // not settled by majority, and the material for comparing them is what
    // this returns.
    contradictions: { type: 'array', items: CONTRADICTION_SCHEMA },
  },
  required: ['subject', 'contradictions'],
  additionalProperties: false,
} as const;

const SEARCH_CANDIDATE_SCHEMA = {
  type: 'object',
  properties: {
    ranking: RANKING_SCHEMA,
    revalidation: REVALIDATION_SCHEMA,
    dead_end_warnings: { type: 'array', items: DEAD_END_WARNING_SCHEMA },
    // Derived guidance the record still supports, as plain strings. Giving
    // them the shape of an Event would dress a reading up as something
    // somebody recorded at a moment.
    successful_directions: { type: 'array', items: { type: 'string' } },
    conflict: CONFLICT_SCHEMA,
  },
  required: ['ranking', 'revalidation', 'dead_end_warnings', 'successful_directions', 'conflict'],
  additionalProperties: false,
} as const;

/**
 * The three ways a search answers with 200.
 *
 * `SEARCHED` with an empty candidate list is an ordinary answer, and the other
 * two are ordinary too: a Problem whose owner turned automatic reading off is
 * a setting being respected, and a Problem that moved mid-search is a race the
 * pipeline noticed. Neither is a failure, so neither is an error envelope —
 * what to do about them is the caller's decision.
 *
 * A `oneOf` discriminated by `kind`, so a client can branch on one field.
 */
export const SEARCH_RESPONSE_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['SEARCHED'] },
        candidates: { type: 'array', items: SEARCH_CANDIDATE_SCHEMA },
        semantic_status: { type: 'string', enum: [...SEMANTIC_CHANNEL_STATUSES] },
        structural_status: { type: 'string', enum: [...STRUCTURAL_RERANK_STATUSES] },
      },
      required: ['kind', 'candidates', 'semantic_status', 'structural_status'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['MEMORY_READ_DISABLED'] } },
      required: ['kind'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['CURRENT_SOURCE_CHANGED'] } },
      required: ['kind'],
      additionalProperties: false,
    },
  ],
} as const;

/** What a caller sends. `snake_case`, exactly the four accepted fields. */
export interface SearchRequestBody {
  source_ai: string;
  lexical_text: string;
  semantic_text: string;
  current_features: Record<string, unknown>;
}

function toEvidenceResource(evidence: VerificationEvidence) {
  return {
    verification_type: evidence.verificationType,
    result: evidence.result,
    summary: evidence.summary,
    evidence_ref: evidence.evidenceRef,
    created_at: evidence.createdAt.toISOString(),
  };
}

function toRankingResource(ranking: RankedMemoryCandidate) {
  return {
    problem_id: ranking.problemId,
    project_id: ranking.projectId,
    confidence: ranking.confidence,
    freshness: ranking.freshness,
    suppressed: ranking.suppressed,
    project_relation: ranking.projectRelation,
    structural_score: ranking.structuralScore,
    hybrid_rank: ranking.hybridRank,
    // Copied rather than referenced: the domain list is readonly and the wire
    // value should not alias it.
    matched_dimensions: [...ranking.matchedDimensions],
    ranking_rank: ranking.rankingRank,
  };
}

function toRevalidationResource(revalidation: RevalidationContext) {
  return {
    historical_environment: revalidation.historicalEnvironment,
    // Order preserved: oldest first, as the pipeline read them.
    evidence: revalidation.evidence.map(toEvidenceResource),
    required_checks: [...revalidation.requiredChecks],
  };
}

function toDeadEndResource(warning: DeadEndWarning) {
  return {
    summary: warning.summary,
    result: warning.result,
    reason: warning.reason,
    evidence_ref: warning.evidenceRef,
    created_at: warning.createdAt.toISOString(),
  };
}

function toContradictionResource(contradiction: Contradiction) {
  const other = contradiction.other;
  return {
    reason: contradiction.reason,
    relation_created_at: contradiction.relationCreatedAt.toISOString(),
    other: {
      problem_id: other.problemId,
      project_id: other.projectId,
      symptoms: other.symptoms,
      problem_domain: other.problemDomain,
      suspected_boundary: other.suspectedBoundary,
      status: other.status,
      fix_kind: other.fixKind,
      confidence: other.confidence,
      freshness: other.freshness,
      historical_environment: other.historicalEnvironment,
      evidence: other.evidence.map(toEvidenceResource),
    },
  };
}

function toConflictResource(conflict: ConflictContext) {
  return {
    subject: {
      symptoms: conflict.subject.symptoms,
      problem_domain: conflict.subject.problemDomain,
      suspected_boundary: conflict.subject.suspectedBoundary,
      status: conflict.subject.status,
      fix_kind: conflict.subject.fixKind,
    },
    contradictions: conflict.contradictions.map(toContradictionResource),
  };
}

/** One candidate, for the wire. */
export function toSearchCandidateResource(candidate: RetrievalMemoryCandidate) {
  return {
    ranking: toRankingResource(candidate.ranking),
    revalidation: toRevalidationResource(candidate.revalidation),
    dead_end_warnings: candidate.deadEndWarnings.map(toDeadEndResource),
    successful_directions: [...candidate.successfulDirections],
    conflict: toConflictResource(candidate.conflict),
  };
}

/**
 * The body for one of the three 200 outcomes.
 *
 * `CURRENT_PROBLEM_NOT_AVAILABLE` is deliberately not one of them and cannot
 * be passed here: it is a 404, mapped where every other missing resource is,
 * so a Problem that is gone, was never this owner's, or never existed answers
 * exactly alike.
 *
 * Nothing is sorted, deduplicated, truncated or otherwise touched. The order
 * the pipeline produced is the order a caller sees.
 */
export function toSearchResponseBody(
  outcome: Exclude<RetrievalSearchOutcome, { kind: 'CURRENT_PROBLEM_NOT_AVAILABLE' }>,
):
  | {
      kind: 'SEARCHED';
      candidates: ReturnType<typeof toSearchCandidateResource>[];
      semantic_status: SemanticChannelStatus;
      structural_status: StructuralRerankStatus;
    }
  | { kind: 'MEMORY_READ_DISABLED' }
  | { kind: 'CURRENT_SOURCE_CHANGED' } {
  if (outcome.kind === 'SEARCHED') {
    return {
      kind: 'SEARCHED',
      candidates: outcome.candidates.map(toSearchCandidateResource),
      semantic_status: outcome.semanticStatus,
      structural_status: outcome.structuralStatus,
    };
  }
  return { kind: outcome.kind };
}
