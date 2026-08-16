/**
 * Application services.
 *
 * The layer between HTTP transport and storage. Transport depends on this and
 * on nothing below it, so what a client is allowed to learn stays a decision
 * made here rather than a consequence of how the database happens to answer.
 */

export {
  InvalidApplicationInputError,
  ExportBlockedError,
  ProblemVersionConflictError,
  ResourceNotFoundError,
} from './errors.js';
export { createEventService, type AppendEventCommand, type EventService } from './event-service.js';
export {
  createRelationService,
  type CreateRelationCommand,
  type RelationService,
} from './relation-service.js';
export {
  createUsageLogService,
  type CreateUsageLogCommand,
  type UsageLogService,
} from './usage-log-service.js';
export { createChangeLogService, type ChangeLogService } from './change-log-service.js';
export {
  createMemoryControlService,
  type MemoryControlCommand,
  type MemoryControlService,
} from './memory-control-service.js';
export {
  createProblemCloseService,
  type CloseProblemCommand,
  type ProblemCloseService,
} from './problem-close-service.js';
export { createExportService, type ExportService } from './export-service.js';
export {
  createProblemDeleteService,
  type DeleteProblemCommand,
  type ProblemDeleteService,
} from './problem-delete-service.js';
export {
  createHealthService,
  type HealthReport,
  type HealthService,
  type HealthStatus,
} from './health-service.js';
// Re-exported so transport can name the closed reason without importing the
// database layer, which the layering rules forbid it from doing.
export { DATABASE_HEALTH_REASONS, type DatabaseHealthReason } from '../db/health.js';
export {
  createProjectEnvironmentService,
  type CreateEnvironmentCommand,
  type CreateProjectCommand,
  type ProjectEnvironmentService,
  type UpdateProjectCommand,
} from './project-environment-service.js';
export {
  createProblemStatusService,
  type ProblemStatusService,
  type TransitionCommand,
} from './problem-status-service.js';
export {
  createProblemService,
  type CreateProblemCommand,
  type ProblemService,
  type UpdateProblemCommand,
} from './problem-service.js';
export type {
  ChangeLogRecord,
  EnvironmentRecord,
  EventRecord,
  ProblemRecord,
  ProjectRecord,
  RelationRecord,
  UsageLogRecord,
  VerificationRecord,
} from '../repository/index.js';
export {
  createVerificationService,
  type AppendVerificationCommand,
  type VerificationService,
} from './verification-service.js';
// Structural reranking: the second retrieval stage, narrowing stage-one
// candidates to a handful by whether they are the same kind of problem.
export {
  createRetrievalStructuralRerankService,
  type RetrievalStructuralRerankService,
} from './retrieval-structural-rerank-service.js';
export {
  DEFAULT_STRUCTURAL_RERANK_LIMIT,
  InvalidStructuralRerankError,
  InvalidStructuralRerankerOutputError,
  MAX_STRUCTURAL_RERANK_CANDIDATES,
  MAX_STRUCTURAL_RERANK_LIMIT,
  MIN_STRUCTURAL_RERANK_LIMIT,
  parseStructuralRerankerOutput,
  resolveStructuralRerankRequest,
  STRUCTURAL_COMPARISON_DIMENSIONS,
  type StructuralCandidate,
  type StructuralComparisonDimension,
  type StructuralRerankRequest,
  type StructuralRerankResult,
  type StructuralRerankStatus,
  type StructuralReranker,
  type StructuralRerankerCandidate,
  type StructuralRerankerInput,
} from '../domain/retrieval-structural-rerank.js';
export { parseStructuralFeatures } from '../domain/retrieval-summary.js';

// The whole retrieval path as one call, with a short-lived memory of searches
// already run. The cache holds the rerank stage's result — the output of the
// two expensive calls — and ranking runs fresh every time, so an edit to a
// Memory's trust, currency or suppression is reflected immediately.
export {
  createRetrievalSearchService,
  InvalidRetrievalSearchError,
  type RetrievalSearchInvocation,
  type RetrievalSearchOutcome,
  type RetrievalSearchRequest,
  type RetrievalSearchService,
} from './retrieval-search-service.js';

// What a Memory was recorded under, and what has to be re-established before
// acting on it. The server never decides whether a Memory is still true — it
// says what it was true of, and what to check.
export {
  createRetrievalRevalidationService,
  InvalidRevalidationRequestError,
  MissingHistoricalEnvironmentError,
  type RetrievalRevalidationService,
} from './retrieval-revalidation-service.js';
export {
  REVALIDATION_CHECKS,
  type RevalidationCheck,
  type RevalidationContext,
  type VerificationEvidence,
} from '../domain/retrieval-revalidation.js';

// Where a Memory already knows a direction does not lead. Warning material
// only: nothing here removes a candidate, moves it, or forbids trying again.
export {
  createRetrievalDeadEndService,
  InvalidDeadEndRequestError,
  type RetrievalDeadEndService,
} from './retrieval-dead-end-service.js';
export type { DeadEndWarning } from '../domain/retrieval-dead-end.js';

// The directions a Memory's record supports calling successful. Derived
// guidance rather than recorded fact, and gated afresh on the Problem's
// status and checks — see the module for why no Event can supply this.
export {
  createRetrievalSuccessfulDirectionService,
  InvalidSuccessfulDirectionRequestError,
  type RetrievalSuccessfulDirectionService,
} from './retrieval-successful-direction-service.js';

// Where another Memory disagrees, and the material for telling which applies
// now. Comparison material only: no winner, no resolution, no reordering.
export {
  createRetrievalConflictService,
  InvalidConflictRequestError,
  type RetrievalConflictService,
} from './retrieval-conflict-service.js';
export {
  MissingConflictEnvironmentError,
  type ConflictContext,
  type ConflictMemorySnapshot,
  type ConflictSubject,
  type Contradiction,
} from '../domain/retrieval-conflict.js';

// The shape a search hands back, owned by none of the stages that fill it.
export type {
  DeadEndAwareMemoryCandidate,
  RetrievalMemoryCandidate,
  RevalidatedMemoryCandidate,
  SuccessfulDirectionAwareMemoryCandidate,
} from '../domain/retrieval-result.js';

// The one thing a search records: that each Memory it surfaced was surfaced.
// Whether anybody then read, took or set aside a Memory is observed elsewhere
// and reported through the ordinary usage log path.
export {
  composeSearchedReason,
  ContradictorySearchObservationError,
  createRetrievalUsageLogWriter,
  NO_COMPARISON_DIMENSIONS,
  SEARCHED_REASON_PREFIX,
  type RecordSearchedInput,
  type RetrievalUsageLogFailure,
  type RetrievalUsageLogFailureReporter,
  type RetrievalUsageLogWriter,
} from './retrieval-usage-log-writer.js';
export {
  createRetrievalSearchCache,
  RETRIEVAL_SEARCH_CACHE_MAX_ENTRIES,
  RETRIEVAL_SEARCH_CACHE_TTL_MS,
  type Clock,
  type RetrievalSearchCache,
} from './retrieval-search-cache.js';
export {
  computeRetrievalSearchCacheKey,
  copyStructuralRerankResult,
  RETRIEVAL_SEARCH_CACHE_KEY_PREFIX,
  type RetrievalSearchCacheEntry,
  type RetrievalSearchCacheKeyInput,
} from '../domain/retrieval-search-cache.js';

// Ranking: what order the survivors are offered in. Deterministic — every
// input is a stored control, so there is no model here and nothing leaves the
// process.
export {
  createRetrievalRankingService,
  type RetrievalRankingService,
} from './retrieval-ranking-service.js';
export {
  classifyProjectRelation,
  InvalidRetrievalRankingError,
  MAX_RANKED_CANDIDATES,
  PROJECT_RELATIONS,
  rankCandidates,
  resolveRetrievalRankingRequest,
  type ProjectRelation,
  type RankableCandidate,
  type RankedMemoryCandidate,
  type RetrievalRankingRequest,
  type RetrievalRankingResult,
} from '../domain/retrieval-ranking.js';

// Hybrid candidate retrieval: both channels as one intent, fused by rank.
// The first of the two retrieval stages; a reranker narrows what it returns.
export { resolveHybridSearchLimit } from './retrieval-hybrid-search-service.js';
export { resolveStructuralRerankLimit } from '../domain/retrieval-structural-rerank.js';
export {
  createRetrievalHybridSearchService,
  type HybridSearchRequest,
  type HybridSearchResult,
  type RetrievalHybridSearchService,
  type SemanticChannelStatus,
} from './retrieval-hybrid-search-service.js';
export {
  DEFAULT_HYBRID_LIMIT,
  fuseHybridCandidates,
  HYBRID_RRF_K,
  HYBRID_SOURCE_LIMIT,
  HybridCandidateInvariantError,
  InvalidHybridSearchError,
  MAX_HYBRID_LIMIT,
  MIN_HYBRID_LIMIT,
  type HybridCandidate,
} from '../domain/retrieval-hybrid-search.js';

// Semantic candidate search: text in, nearest memories out. A confirmed
// credential in the query is answered with a typed outcome rather than sent
// to the provider.
export {
  createRetrievalVectorSearchService,
  type RetrievalVectorSearchService,
  type VectorSearchOutcome,
  type VectorSearchRequest,
} from './retrieval-vector-search-service.js';
export {
  MAX_VECTOR_SEARCH_TEXT_LENGTH,
  type VectorCandidate,
  type VectorSearchQuery,
} from '../domain/retrieval-search.js';

// The full pipeline: summary, embedding, atomic persistence. Still no route —
// what invokes generation in production is an adapter decision that has not
// been made.
export {
  createRetrievalArtifactGenerationService,
  EmbeddingGenerationFailedError,
  type GenerateRetrievalArtifactOutcome,
  type RetrievalArtifactGenerationService,
} from './retrieval-artifact-generation-service.js';
export {
  InvalidEmbeddingProviderOutputError,
  requireEmbeddingProviderIdentity,
  toProviderEmbedding,
  type EmbeddingProvider,
  type EmbeddingProviderInput,
} from '../domain/retrieval-embedding.js';
// Generation only: it produces a draft and stores nothing. There is no route
// to it, deliberately — what a client may ask of a search belongs to the task
// that has a search to expose.
export {
  createRetrievalSummaryService,
  RetrievalSummaryGenerationFailedError,
  type GenerateRetrievalSummaryOutcome,
  type RetrievalSummaryGenerator,
  type RetrievalSummaryGeneratorInput,
  type RetrievalSummaryService,
} from './retrieval-summary-service.js';
export {
  InvalidRetrievalSummaryError,
  MAX_KEYWORDS,
  MAX_KEYWORD_LENGTH,
  MAX_NORMALIZED_SUMMARY_LENGTH,
  MAX_STRUCTURAL_FEATURE_ITEMS,
  MAX_STRUCTURAL_FEATURE_LENGTH,
  RETRIEVAL_SOURCE_FINGERPRINT_PREFIX,
  RETRIEVAL_SOURCE_SCHEMA_VERSION,
  STRUCTURAL_FEATURE_LISTS,
  STRUCTURAL_FEATURE_SCHEMA_VERSION,
  type RetrievalSummaryDraft,
  type StructuralFeatures,
} from '../domain/retrieval-summary.js';
export {
  createRequestContextService,
  REQUEST_CONTEXT_FAILURES,
  RequestContextUnavailableError,
  type AuthenticatedRequestContext,
  type RequestContextFailure,
  type RequestContextService,
} from './request-context.js';
// Re-exported so transport maps the refusal without importing the boundary
// directly: what a client is told about a refused value stays a decision of
// this layer, not of the layer that detected it.
export {
  createPermissivePolicy,
  createSecretDetectionPolicy,
  SanitizationRejectedError,
  type SanitizationOutcome,
  type SanitizationPolicy,
  type SanitizationSite,
} from '../sanitization/index.js';
