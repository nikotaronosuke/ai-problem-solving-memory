/**
 * Database access boundary.
 *
 * Importing this module opens no connection.
 *
 * The repository layer that Phase 2 builds on top belongs behind this boundary
 * (P1-12), so that PostgreSQL and Supabase specifics do not spread through the
 * rest of the service.
 */

export {
  isLocalHostname,
  resolveDatabaseConfig,
  UnsafeDatabaseTargetError,
  type DatabaseConfig,
  type DatabaseConfigInput,
} from './config.js';
export { closePool, createPool, type DatabasePool } from './pool.js';
export {
  checkDatabaseConnection,
  classifyDatabaseFailure,
  DATABASE_HEALTH_REASONS,
  type DatabaseHealth,
  type DatabaseHealthReason,
} from './health.js';
export {
  ENUM_DOMAIN_BINDINGS,
  ENUM_DOMAIN_SCHEMA,
  type EnumDomainBinding,
} from './enum-domains.js';

// `findOwnerRecord` is intentionally not re-exported. Application code reads
// its own owner through the context; only owner resolution looks up a bare id.
export {
  getOwnerForContext,
  insertOwnerIfAbsent,
  type OwnerInsertResult,
  type OwnerRecord,
} from './owners.js';

// Both take an OwnerContext, so there is no project API that names an
// arbitrary owner.
export {
  createProject,
  getProject,
  type CreateProjectInput,
  type ProjectRecord,
} from './projects.js';

export {
  createEnvironment,
  getEnvironment,
  ProjectNotAvailableError,
  type CreateEnvironmentInput,
  type EnvironmentRecord,
} from './environments.js';

export {
  createProblem,
  getProblem,
  EnvironmentNotAvailableError,
  type CreateProblemInput,
  type ProblemRecord,
} from './problems.js';

// Raised by both append paths.
export { ProblemNotAvailableError } from './errors.js';

// Append and list only. Events are append-only, so no update or delete path
// is offered.
export { appendEvent, listEvents, type AppendEventInput, type EventRecord } from './events.js';

// Create and list only. There is no update or delete path for a link.
export {
  createRelation,
  listRelations,
  type CreateRelationInput,
  type RelationRecord,
} from './relations.js';

// Running several statements as one. Needed first by change logging, which
// has to succeed or fail with the change it describes.
export { createTransactionRunner, type DatabaseTransactionRunner } from './transaction.js';

// Problem mutation history. The create is called by the mutating services
// inside their transaction, not by anything a caller can reach.
export {
  createChangeLog,
  listChangeLogs,
  type ChangeLogRecord,
  type CreateChangeLogInput,
} from './change-logs.js';

// Memory-specific usage history. Create and list only, and not a global audit
// log: tool calls, deploys and approvals belong to a layer above this one.
export {
  createUsageLog,
  listUsageLogs,
  type CreateUsageLogInput,
  type UsageLogRecord,
} from './usage-logs.js';

// Verifications attach to a Problem, not to an Event, and are append-only too.
export {
  appendVerification,
  listVerifications,
  type AppendVerificationInput,
  type VerificationRecord,
} from './verifications.js';
