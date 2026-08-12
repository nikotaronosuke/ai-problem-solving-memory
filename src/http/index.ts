/**
 * HTTP transport boundary.
 *
 * Building an app is separate from running one, so importing this starts
 * nothing.
 */

export {
  buildMemoryHttpApp,
  API_PREFIX,
  REDACTED_LOG_PATHS,
  type MemoryHttpAppDependencies,
} from './app.js';
export {
  buildErrorEnvelope,
  ERROR_CODES,
  ERROR_RESPONSE_SCHEMA,
  ERROR_STATUS,
  type ErrorCode,
  type ErrorEnvelope,
} from './errors.js';
