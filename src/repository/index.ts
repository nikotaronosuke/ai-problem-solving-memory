/**
 * Application-facing storage boundary.
 *
 * Service and API code from Phase 2 imports from here, not from `src/db/`.
 * The dependency direction is domain ← service ← repository ← db ← PostgreSQL,
 * and nothing in `src/domain/` depends on either storage layer.
 *
 * The record and input types are re-exported rather than redefined. Copying
 * them into repository-specific shapes would leave two definitions of the same
 * thing to keep in step, and they would not stay in step.
 *
 * `pg.Pool`, `pg.PoolClient`, raw SQL and Supabase-specific types are not part
 * of this surface. A caller needs `DatabaseExecutor` and nothing more.
 */

export { createMemoryRepository, type MemoryRepository } from './memory-repository.js';

export type { DatabaseExecutor } from '../db/executor.js';

export type { CreateProjectInput, ProjectRecord } from '../db/projects.js';
export type { CreateEnvironmentInput, EnvironmentRecord } from '../db/environments.js';
export type { CreateProblemInput, ProblemRecord } from '../db/problems.js';
export type { AppendEventInput, EventRecord } from '../db/events.js';
export type { AppendVerificationInput, VerificationRecord } from '../db/verifications.js';

// The failures a caller has to handle. Mapping stays in the database layer;
// these are re-exported so the caller need not reach past this boundary.
export { DuplicateClientEventIdError, ProblemNotAvailableError } from '../db/errors.js';
export { ProjectNotAvailableError } from '../db/environments.js';
export { EnvironmentNotAvailableError } from '../db/problems.js';
