/**
 * Application services.
 *
 * The layer between HTTP transport and storage. Transport depends on this and
 * on nothing below it, so what a client is allowed to learn stays a decision
 * made here rather than a consequence of how the database happens to answer.
 */

export {
  InvalidApplicationInputError,
  ProblemVersionConflictError,
  ResourceNotFoundError,
} from './errors.js';
export { createEventService, type AppendEventCommand, type EventService } from './event-service.js';
export {
  createRelationService,
  type CreateRelationCommand,
  type RelationService,
} from './relation-service.js';
export { createHealthService, type HealthReport, type HealthService } from './health-service.js';
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
  EnvironmentRecord,
  EventRecord,
  ProblemRecord,
  ProjectRecord,
  RelationRecord,
  VerificationRecord,
} from '../repository/index.js';
export {
  createVerificationService,
  type AppendVerificationCommand,
  type VerificationService,
} from './verification-service.js';
export {
  createRequestContextService,
  RequestContextUnavailableError,
  type AuthenticatedRequestContext,
  type RequestContextService,
} from './request-context.js';
