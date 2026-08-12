/**
 * The storage seam the service layer works against.
 *
 * A repository is created for one owner and stays that way. Its methods take
 * no owner argument, so a caller cannot name a different one — the question
 * "whose data is this?" is answered once, when the repository is made, rather
 * than at every call site where it could be got wrong.
 *
 * That is the difference from the layer below: `src/db/` functions take an
 * `OwnerContext` per call because they have no other way to know. Here the
 * scope is the object.
 *
 * This is a thin facade. Every method delegates to the existing database
 * function unchanged: no SQL is written here, and PostgreSQL error codes are
 * not reinterpreted. The database layer already maps its own failures, and
 * having two layers decide what an error means is how they end up disagreeing.
 *
 * It does not own a transaction either. It uses the executor it was given, so
 * a service that needs one checks out a client, begins, and builds a
 * repository over that client. Nothing here changes for that to work.
 *
 * Nothing from `pg` or Supabase appears in this module's surface.
 */

import type { DatabaseExecutor } from '../db/executor.js';
import {
  createEnvironment,
  getEnvironment,
  type CreateEnvironmentInput,
  type EnvironmentRecord,
} from '../db/environments.js';
import { appendEvent, listEvents, type AppendEventInput, type EventRecord } from '../db/events.js';
import {
  createProblem,
  getProblem,
  type CreateProblemInput,
  type ProblemRecord,
} from '../db/problems.js';
import {
  createProject,
  getProject,
  type CreateProjectInput,
  type ProjectRecord,
} from '../db/projects.js';
import {
  appendVerification,
  listVerifications,
  type AppendVerificationInput,
  type VerificationRecord,
} from '../db/verifications.js';
import type { EnvironmentId } from '../domain/environment.js';
import type { OwnerContext, OwnerId } from '../domain/owner.js';
import type { ProblemId } from '../domain/problem.js';
import type { ProjectId } from '../domain/project.js';

/**
 * Owner-scoped storage for the Memory model.
 *
 * The surface is deliberately the Phase 1 minimum. Listing projects, updating,
 * deleting, searching, relations and logs are Phase 2 work, and adding them
 * early would commit to shapes the service layer has not asked for yet.
 */
export interface MemoryRepository {
  /** The owner every operation on this repository is scoped to. */
  readonly ownerId: OwnerId;

  createProject(input: CreateProjectInput): Promise<ProjectRecord>;
  getProject(projectId: ProjectId): Promise<ProjectRecord | undefined>;

  createEnvironment(input: CreateEnvironmentInput): Promise<EnvironmentRecord>;
  getEnvironment(environmentId: EnvironmentId): Promise<EnvironmentRecord | undefined>;

  createProblem(input: CreateProblemInput): Promise<ProblemRecord>;
  getProblem(problemId: ProblemId): Promise<ProblemRecord | undefined>;

  appendEvent(input: AppendEventInput): Promise<EventRecord>;
  listEvents(problemId: ProblemId): Promise<EventRecord[]>;

  appendVerification(input: AppendVerificationInput): Promise<VerificationRecord>;
  listVerifications(problemId: ProblemId): Promise<VerificationRecord[]>;
}

/**
 * Builds a repository bound to one owner.
 *
 * The `OwnerContext` is required and fixed here. Because a context can only
 * come from `resolveOwnerContext`, which verifies the owner exists, holding a
 * repository is itself evidence that ownership was settled before any data was
 * touched.
 *
 * `executor` is whatever can run a statement — a pool for ordinary work, or a
 * checked-out client when the caller is running a transaction.
 */
export function createMemoryRepository(
  executor: DatabaseExecutor,
  context: OwnerContext,
): MemoryRepository {
  return {
    ownerId: context.ownerId,

    createProject: (input) => createProject(executor, context, input),
    getProject: (projectId) => getProject(executor, context, projectId),

    createEnvironment: (input) => createEnvironment(executor, context, input),
    getEnvironment: (environmentId) => getEnvironment(executor, context, environmentId),

    createProblem: (input) => createProblem(executor, context, input),
    getProblem: (problemId) => getProblem(executor, context, problemId),

    appendEvent: (input) => appendEvent(executor, context, input),
    listEvents: (problemId) => listEvents(executor, context, problemId),

    appendVerification: (input) => appendVerification(executor, context, input),
    listVerifications: (problemId) => listVerifications(executor, context, problemId),
  };
}
