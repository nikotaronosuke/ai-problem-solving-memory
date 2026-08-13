/**
 * Database access for environments.
 *
 * Like projects, every function takes an `OwnerContext`. The owner comes from
 * the context rather than caller input, and reads are scoped by `owner_id`
 * alongside `environment_id`.
 *
 * Creating against a project that does not exist and creating against another
 * owner's project fail identically. The composite foreign key sees only a
 * missing (owner, project) pair in both cases, so the outcome cannot be used
 * to learn whether someone else's project id is real.
 *
 * There is no update path. An Environment is a point in time; changed
 * conditions are a new snapshot.
 *
 * This is the minimum P1-07 needs. The general repository layer is P1-12.
 */

import {
  generateEnvironmentId,
  toEnvironmentSnapshot,
  type EnvironmentId,
  type EnvironmentSnapshot,
} from '../domain/environment.js';
import type { OwnerContext, OwnerId } from '../domain/owner.js';
import type { ProjectId } from '../domain/project.js';
import type { DatabaseExecutor } from './executor.js';

const OWNER_PROJECT_FK = 'environments_owner_id_project_id_fkey';

export interface EnvironmentRecord {
  readonly environmentId: EnvironmentId;
  readonly ownerId: OwnerId;
  readonly projectId: ProjectId;
  readonly snapshot: EnvironmentSnapshot;
  readonly createdAt: Date;
}

/**
 * What a caller supplies to create an environment.
 *
 * There is no owner field. Ownership comes from the context, so it cannot be
 * spoofed by the caller.
 */
export interface CreateEnvironmentInput {
  readonly projectId: ProjectId;
  readonly snapshot: unknown;
}

/**
 * Raised when the target project is not one of the context owner's.
 *
 * Deliberately the same error whether the project does not exist at all or
 * belongs to someone else.
 */
export class ProjectNotAvailableError extends Error {
  constructor() {
    super('No such project for this owner.');
    this.name = 'ProjectNotAvailableError';
  }
}

interface EnvironmentRow {
  environment_id: string;
  owner_id: string;
  project_id: string;
  snapshot: Record<string, unknown>;
  created_at: Date;
}

function toRecord(row: EnvironmentRow): EnvironmentRecord {
  // The id columns are `uuid`, so the values are already normalised UUIDs.
  return {
    environmentId: row.environment_id as EnvironmentId,
    ownerId: row.owner_id as OwnerId,
    projectId: row.project_id as ProjectId,
    snapshot: row.snapshot,
    createdAt: row.created_at,
  };
}

/** Whether an error is PostgreSQL rejecting a specific foreign key. */
function isForeignKeyViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === '23503' && candidate.constraint === constraint;
}

const ENVIRONMENT_COLUMNS = 'environment_id, owner_id, project_id, snapshot, created_at';

/**
 * Records an environment against one of the context owner's projects.
 *
 * The snapshot must be a JSON object; an empty one is allowed and means the
 * relevant conditions have not been captured yet.
 */
export async function createEnvironment(
  executor: DatabaseExecutor,
  context: OwnerContext,
  input: CreateEnvironmentInput,
): Promise<EnvironmentRecord> {
  const snapshot = toEnvironmentSnapshot(input.snapshot);
  const environmentId = generateEnvironmentId();

  let result;
  try {
    result = await executor.query<EnvironmentRow>(
      `insert into public.environments (environment_id, owner_id, project_id, snapshot)
            values ($1, $2, $3, $4)
         returning ${ENVIRONMENT_COLUMNS}`,
      [environmentId, context.ownerId, input.projectId, snapshot],
    );
  } catch (error) {
    if (isForeignKeyViolation(error, OWNER_PROJECT_FK)) {
      // The (owner, project) pair does not exist. Whether the project is
      // unknown or someone else's is not distinguished, by design.
      throw new ProjectNotAvailableError();
    }
    throw error;
  }

  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('Environment insert returned no row.');
  }

  return toRecord(row);
}

/**
 * Reads one of the context owner's environments.
 *
 * Returns undefined when it does not exist or belongs to someone else — the
 * two are indistinguishable to the caller by design.
 */
export async function getEnvironment(
  executor: DatabaseExecutor,
  context: OwnerContext,
  environmentId: EnvironmentId,
): Promise<EnvironmentRecord | undefined> {
  const result = await executor.query<EnvironmentRow>(
    `select ${ENVIRONMENT_COLUMNS}
       from public.environments
      where owner_id = $1 and environment_id = $2`,
    [context.ownerId, environmentId],
  );

  const row = result.rows[0];
  return row === undefined ? undefined : toRecord(row);
}

/**
 * Lists a project's environments, oldest first.
 *
 * `environment_id` breaks ties so repeated reads agree even when two snapshots
 * share a timestamp.
 *
 * An empty list means "this owner has no environments under that project id".
 * It does not distinguish a project with none from a project that is not the
 * owner's — deciding what that means is the caller's job, and the application
 * layer checks the project first so the two do not get conflated.
 */
export async function listEnvironments(
  executor: DatabaseExecutor,
  context: OwnerContext,
  projectId: ProjectId,
): Promise<EnvironmentRecord[]> {
  const result = await executor.query<EnvironmentRow>(
    `select ${ENVIRONMENT_COLUMNS}
       from public.environments
      where owner_id = $1 and project_id = $2
      order by created_at asc, environment_id asc`,
    [context.ownerId, projectId],
  );

  return result.rows.map(toRecord);
}
