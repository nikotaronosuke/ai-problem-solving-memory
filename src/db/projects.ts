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
import { generateProjectId, toProjectName, type ProjectId } from '../domain/project.js';
import { normaliseOptionalText } from '../domain/text.js';
import type { DatabaseExecutor } from './executor.js';

export interface ProjectRecord {
  readonly projectId: ProjectId;
  readonly ownerId: OwnerId;
  readonly projectName: string;
  readonly repo: string | null;
  readonly platform: string | null;
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
}

interface ProjectRow {
  project_id: string;
  owner_id: string;
  project_name: string;
  repo: string | null;
  platform: string | null;
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const PROJECT_COLUMNS =
  'project_id, owner_id, project_name, repo, platform, created_at, updated_at';

/**
 * Creates a project owned by the context's owner.
 *
 * The name is required and must not be blank; `repo` and `platform` collapse
 * to null when absent or empty.
 */
export async function createProject(
  executor: DatabaseExecutor,
  context: OwnerContext,
  input: CreateProjectInput,
): Promise<ProjectRecord> {
  const projectName = toProjectName(input.projectName);
  const repo = normaliseOptionalText(input.repo);
  const platform = normaliseOptionalText(input.platform);
  const projectId = generateProjectId();

  const result = await executor.query<ProjectRow>(
    `insert into public.projects (project_id, owner_id, project_name, repo, platform)
          values ($1, $2, $3, $4, $5)
       returning ${PROJECT_COLUMNS}`,
    [projectId, context.ownerId, projectName, repo, platform],
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
