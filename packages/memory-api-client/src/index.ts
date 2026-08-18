/**
 * The Memory JSON API client.
 *
 * One export list, so what this package promises is readable in one place. It
 * grows a method at a time, when a task needs one: the API has twenty-eight
 * operations and this client has seven, because a client method that no caller
 * has is a guess about how it will be called.
 *
 * What is exported from the search module is the contract: the request and
 * outcome types, the closed sets a caller may branch on, the bounds a caller
 * needs in order to build a valid request, and the two predicates. The nested
 * per-object field lists and their checks stay private — they are how the
 * validation is written, not what the package promises.
 */

export {
  createMemoryApiClient,
  MemoryApiArgumentError,
  MEMORY_API_REQUEST_TIMEOUT_MS,
  MEMORY_API_SEARCH_TIMEOUT_MS,
  type FetchLike,
  type MemoryApiClient,
  type MemoryApiClientOptions,
} from './client.js';

export {
  DEFAULT_MEMORY_API_BASE_URL,
  MemoryApiConfigurationError,
  MEMORY_API_CONFIGURATION_FAILURES,
  normalizeBaseUrl,
  requireCredential,
  type MemoryApiConfigurationFailure,
} from './config.js';

export {
  isMemoryApiErrorCode,
  MemoryApiError,
  MemoryApiProtocolError,
  MemoryApiUnreachableError,
  MEMORY_API_ERROR_CODES,
  MEMORY_API_PROTOCOL_FAILURES,
  MEMORY_API_UNREACHABLE_REASONS,
  type MemoryApiErrorCode,
  type MemoryApiProtocolFailure,
  type MemoryApiUnreachableReason,
} from './errors.js';

export {
  isMemorySearchRequest,
  isMemorySearchResponse,
  isMemorySearchStructuralFeatures,
  MEMORY_SEARCH_CANDIDATE_FIELDS,
  MEMORY_SEARCH_COMPARISON_DIMENSIONS,
  MEMORY_SEARCH_MAX_LEXICAL_TEXT_LENGTH,
  MEMORY_SEARCH_MAX_SEMANTIC_TEXT_LENGTH,
  MEMORY_SEARCH_MAX_STRUCTURAL_FEATURE_ITEMS,
  MEMORY_SEARCH_MAX_STRUCTURAL_FEATURE_LENGTH,
  MEMORY_SEARCH_PROJECT_RELATIONS,
  MEMORY_SEARCH_REQUEST_FIELDS,
  MEMORY_SEARCH_REVALIDATION_CHECKS,
  MEMORY_SEARCH_SEMANTIC_STATUSES,
  MEMORY_SEARCH_STRUCTURAL_FEATURE_FIELDS,
  MEMORY_SEARCH_STRUCTURAL_FEATURE_LISTS,
  MEMORY_SEARCH_STRUCTURAL_FEATURE_SCHEMA_VERSION,
  MEMORY_SEARCH_STRUCTURAL_STATUSES,
  MEMORY_SEARCH_VERIFICATION_TYPES,
  type MemorySearchCandidate,
  type MemorySearchComparisonDimension,
  type MemorySearchConflict,
  type MemorySearchConflictOther,
  type MemorySearchConflictSubject,
  type MemorySearchContradiction,
  type MemorySearchDeadEndWarning,
  type MemorySearchEvidence,
  type MemorySearchOutcome,
  type MemorySearchProjectRelation,
  type MemorySearchRanking,
  type MemorySearchRequest,
  type MemorySearchResponse,
  type MemorySearchRevalidation,
  type MemorySearchRevalidationCheck,
  type MemorySearchSemanticStatus,
  type MemorySearchStructuralFeatureList,
  type MemorySearchStructuralFeatures,
  type MemorySearchStructuralStatus,
  type MemorySearchVerificationType,
} from './search.js';

export { isJsonObject, type JsonObject, type JsonPrimitive, type JsonValue } from './json.js';

export {
  isCreateEnvironmentRequest,
  isEnvironmentResource,
  CREATE_ENVIRONMENT_REQUEST_FIELDS,
  ENVIRONMENT_RESOURCE_FIELDS,
  type CreateEnvironmentRequest,
  type EnvironmentResource,
} from './environment.js';

export {
  isCreateProjectRequest,
  isProjectListBody,
  isProjectResource,
  CREATE_PROJECT_REQUEST_FIELDS,
  PROJECT_RESOURCE_FIELDS,
  type CreateProjectRequest,
  type ProjectResource,
} from './project.js';

export {
  isCreateProblemRequest,
  isProblemListBody,
  isProblemResource,
  isTransitionProblemStatusRequest,
  CONFIDENCES,
  CREATE_PROBLEM_REQUEST_FIELDS,
  FIX_KINDS,
  FRESHNESSES,
  PROBLEM_RESOURCE_FIELDS,
  TRANSITION_PROBLEM_STATUS_REQUEST_FIELDS,
  PROBLEM_STATUSES,
  type Confidence,
  type FixKind,
  type CreateProblemRequest,
  type Freshness,
  type ProblemResource,
  type ProblemStatus,
  type TransitionProblemStatusRequest,
} from './problem.js';
