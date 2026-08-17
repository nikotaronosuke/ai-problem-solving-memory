/**
 * The Memory JSON API client.
 *
 * One export list, so what this package promises is readable in one place. It
 * grows a method at a time, when a task needs one: the API has twenty-seven
 * operations and this client has one, because a client method that no caller
 * has is a guess about how it will be called.
 */

export {
  createMemoryApiClient,
  MemoryApiArgumentError,
  MEMORY_API_REQUEST_TIMEOUT_MS,
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
  isProblemResource,
  CONFIDENCES,
  FIX_KINDS,
  FRESHNESSES,
  PROBLEM_RESOURCE_FIELDS,
  PROBLEM_STATUSES,
  type Confidence,
  type FixKind,
  type Freshness,
  type ProblemResource,
  type ProblemStatus,
} from './problem.js';
