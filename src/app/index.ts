/**
 * Application services.
 *
 * The layer between HTTP transport and storage. Transport depends on this and
 * on nothing below it, so what a client is allowed to learn stays a decision
 * made here rather than a consequence of how the database happens to answer.
 */

export { createHealthService, type HealthReport, type HealthService } from './health-service.js';
export {
  createRequestContextService,
  RequestContextUnavailableError,
  type AuthenticatedRequestContext,
  type RequestContextService,
} from './request-context.js';
