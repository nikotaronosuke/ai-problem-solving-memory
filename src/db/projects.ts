/**
 * Database access for projects.
 *
 * Every function takes an `OwnerContext`, so a project operation cannot be
 * expressed without an established owner. The owner is read from the context,
 * never from the caller's input, and reads are scoped by `owner_id` alongside
 * `project_id`.
 *
 * A project belonging to another owner therefore reads as absent rather than
 * as forbidden. That is deliberate: a "not yours" answer would confirm the id
 * exists, which is itself a leak across the boundary.
 *
 * This is the minimum P1-06 needs. The general repository layer is P1-12.
 */

import type { OwnerContext, OwnerId } from '../domain/owner.js';
import {
  generateProjectId,
  toOptionalProjectRepoSubpath,
  toProjectName,
  type ProjectId,
} from '../domain/project.js';
import { normaliseOptionalText } from '../domain/text.js';
import type { DatabaseExecutor } from './executor.js';

export interface ProjectRecord {
  readonly projectId: ProjectId;
  readonly ownerId: OwnerId;
  readonly projectName: string;
  readonly repo: string | null;
  readonly platform: string | null;
  /** Owner-declared repository boundary, or null for the whole repository. */
  readonly repoSubpath: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * What a caller supplies to create a project.
 *
 * There is no owner field. Ownership comes from the context, so it cannot be
 * spoofed by the caller.
 */
export interface CreateProjectInput {
  readonly projectName: string;
  readonly repo?: string | null;
  readonly platform?: string | null;
  readonly repoSubpath?: string | null;
}

interface ProjectRow {
  project_id: string;
  owner_id: string;
  project_name: string;
  repo: string | null;
  platform: string | null;
  repo_subpath: string | null;
  created_at: Date;
  updated_at: Date;
}

function toRecord(row: ProjectRow): ProjectRecord {
  // Both columns are `uuid`, so the values are already normalised UUIDs.
  return {
    projectId: row.project_id as ProjectId,
    ownerId: row.owner_id as OwnerId,
    projectName: row.project_name,
    repo: row.repo,
    platform: row.platform,
    repoSubpath: row.repo_subpath,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const PROJECT_COLUMNS =
  'project_id, owner_id, project_name, repo, platform, repo_subpath, created_at, updated_at';

/**
 * Creates a project owned by the context's owner.
 *
 * The name is required and must not be blank; `repo` and `platform` collapse
 * to null when absent or empty. A repository boundary is validated rather than
 * tidied — it is compared in order to decide things, so a nearly-right value is
 * a boundary that silently matches nothing.
 */
export async function createProject(
  executor: DatabaseExecutor,
  context: OwnerContext,
  input: CreateProjectInput,
): Promise<ProjectRecord> {
  const projectName = toProjectName(input.projectName);
  const repo = normaliseOptionalText(input.repo);
  const platform = normaliseOptionalText(input.platform);
  const repoSubpath = toOptionalProjectRepoSubpath(input.repoSubpath);
  const projectId = generateProjectId();

  const result = await executor.query<ProjectRow>(
    `insert into public.projects (project_id, owner_id, project_name, repo, platform, repo_subpath)
          values ($1, $2, $3, $4, $5, $6)
       returning ${PROJECT_COLUMNS}`,
    [projectId, context.ownerId, projectName, repo, platform, repoSubpath],
  );

  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('Project insert returned no row.');
  }

  return toRecord(row);
}

/**
 * Reads one of the context owner's projects.
 *
 * Returns undefined when the project does not exist or belongs to someone
 * else — the two are indistinguishable to the caller by design.
 */
export async function getProject(
  executor: DatabaseExecutor,
  context: OwnerContext,
  projectId: ProjectId,
): Promise<ProjectRecord | undefined> {
  const result = await executor.query<ProjectRow>(
    `select ${PROJECT_COLUMNS}
       from public.projects
      where owner_id = $1 and project_id = $2`,
    [context.ownerId, projectId],
  );

  const row = result.rows[0];
  return row === undefined ? undefined : toRecord(row);
}

/**
 * Lists the context owner's projects, oldest first.
 *
 * `project_id` breaks ties so repeated reads agree even when two projects
 * share a timestamp. Without a second key the order of colliding rows is
 * whatever the database happens to return, which can differ between calls.
 */
export async function listProjects(
  executor: DatabaseExecutor,
  context: OwnerContext,
): Promise<ProjectRecord[]> {
  const result = await executor.query<ProjectRow>(
    `select ${PROJECT_COLUMNS}
       from public.projects
      where owner_id = $1
      order by created_at asc, project_id asc`,
    [context.ownerId],
  );

  return result.rows.map(toRecord);
}

/**
 * What a caller may change about a project.
 *
 * Every field is optional, and the distinction between "absent" and "null"
 * carries meaning: absent leaves the column alone, null clears it. That is why
 * this cannot be a plain partial record — `undefined` and `null` would collapse
 * into the same thing.
 *
 * There is no owner, id or timestamp field. Those are not things a caller
 * changes.
 */
export interface UpdateProjectInput {
  readonly projectName?: string;
  readonly repo?: string | null;
  readonly platform?: string | null;
  readonly repoSubpath?: string | null;
}

/** Raised when an update would change nothing. */
export class EmptyProjectUpdateError extends Error {
  constructor() {
    super('A project update must change at least one field.');
    this.name = 'EmptyProjectUpdateError';
  }
}

/**
 * Updates one of the context owner's projects.
 *
 * Only the fields present in `input` are written; the rest keep their stored
 * values. `updated_at` is set explicitly rather than by a trigger, so a write
 * that forgets it is a visible bug rather than something the database quietly
 * papers over.
 *
 * Returns undefined when the project does not exist or belongs to someone
 * else, matching `getProject`. Nothing is inserted in that case — this is an
 * update, never an upsert, so a wrong id cannot silently create a record.
 *
 * An empty patch is refused rather than executed. A statement with no
 * assignments would still touch `updated_at`, which would record a change that
 * did not happen.
 */
export async function updateProject(
  executor: DatabaseExecutor,
  context: OwnerContext,
  projectId: ProjectId,
  input: UpdateProjectInput,
): Promise<ProjectRecord | undefined> {
  const assignments: string[] = [];
  // Column names come from this function alone. Only values are parameterised,
  // and no caller input ever becomes a SQL identifier.
  const values: unknown[] = [context.ownerId, projectId];

  function assign(column: string, value: unknown): void {
    values.push(value);
    assignments.push(`${column} = $${values.length}`);
  }

  if (input.projectName !== undefined) {
    assign('project_name', toProjectName(input.projectName));
  }
  if (input.repo !== undefined) {
    assign('repo', normaliseOptionalText(input.repo));
  }
  if (input.platform !== undefined) {
    assign('platform', normaliseOptionalText(input.platform));
  }
  if (input.repoSubpath !== undefined) {
    // Explicit null clears the boundary back to the whole repository, which is
    // a real thing to say and not the same as leaving the field alone.
    assign('repo_subpath', toOptionalProjectRepoSubpath(input.repoSubpath));
  }

  if (assignments.length === 0) {
    throw new EmptyProjectUpdateError();
  }

  const result = await executor.query<ProjectRow>(
    `update public.projects
        set ${assignments.join(', ')}, updated_at = now()
      where owner_id = $1 and project_id = $2
     returning ${PROJECT_COLUMNS}`,
    values,
  );

  const row = result.rows[0];
  return row === undefined ? undefined : toRecord(row);
}
