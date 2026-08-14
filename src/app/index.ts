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
