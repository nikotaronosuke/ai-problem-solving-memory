/**
 * HTTP transport boundary.
 *
 * Building an app is separate from running one, so importing this starts
 * nothing.
 */

export {
  buildMemoryHttpApp,
  API_PREFIX,
  createLoggerOptions,
  OPERATIONAL_FAILURES,
  OPERATIONAL_LOG_EVENTS,
  REDACTED_LOG_PATHS,
  UNMATCHED_ROUTE,
  type LoggedFailure,
  type LoggedReply,
  type LoggedRequest,
  type MemoryHttpAppDependencies,
  type OperationalFailure,
  type OperationalLoggerOptions,
  type OperationalLogEvent,
} from './app.js';
export {
  buildErrorEnvelope,
  ERROR_CODES,
  ERROR_RESPONSE_SCHEMA,
  ERROR_STATUS,
  type ErrorCode,
  type ErrorEnvelope,
} from './errors.js';
