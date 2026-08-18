/**
 * Project and Environment operations.
 *
 * Sits between transport and the repository. Its job is to turn plain request
 * data into domain values, decide what "not found" means, and orchestrate the
 * few places where one operation needs another.
 *
 * Everything here works through the `AuthenticatedRequestContext`'s repository,
 * which is already bound to one owner. No function takes an owner, so no
 * caller can name one.
 *
 * Two decisions live here rather than in transport:
 *
 * A resource that does not exist and one belonging to someone else are the
 * same `ResourceNotFoundError`. The repository already returns undefined for
 * both; this keeps them merged rather than letting a caller separate them.
 *
 * Listing a project's environments checks the project first. Returning an
 * empty list for a project that is not the owner's would quietly say "that
 * project exists and is empty", which is both wrong and a small leak.
 */

import type { AuthenticatedRequestContext } from './request-context.js';
import { InvalidApplicationInputError, ResourceNotFoundError } from './errors.js';
import { toEnvironmentId, type EnvironmentId } from '../domain/environment.js';
import { toProjectId, type ProjectId } from '../domain/project.js';
import type { EnvironmentRecord, ProjectRecord, UpdateProjectInput } from '../repository/index.js';

export interface CreateProjectCommand {
  readonly projectName: string;
  readonly repo?: string | null;
  readonly platform?: string | null;
  readonly repoSubpath?: string | null;
}

export interface UpdateProjectCommand {
  readonly projectName?: string;
  readonly repo?: string | null;
  readonly platform?: string | null;
  readonly repoSubpath?: string | null;
}

export interface CreateEnvironmentCommand {
  readonly snapshot: unknown;
}

export interface ProjectEnvironmentService {
  createProject(
    context: AuthenticatedRequestContext,
    command: CreateProjectCommand,
  ): Promise<ProjectRecord>;
  getProject(context: AuthenticatedRequestContext, projectId: string): Promise<ProjectRecord>;
  listProjects(context: AuthenticatedRequestContext): Promise<ProjectRecord[]>;
  updateProject(
    context: AuthenticatedRequestContext,
    projectId: string,
    command: UpdateProjectCommand,
  ): Promise<ProjectRecord>;

  createEnvironment(
    context: AuthenticatedRequestContext,
    projectId: string,
    command: CreateEnvironmentCommand,
  ): Promise<EnvironmentRecord>;
  getEnvironment(
    context: AuthenticatedRequestContext,
    environmentId: string,
  ): Promise<EnvironmentRecord>;
  listEnvironments(
    context: AuthenticatedRequestContext,
    projectId: string,
  ): Promise<EnvironmentRecord[]>;
}

/**
 * Converts a path identifier, treating a malformed one as absent.
 *
 * A string that cannot be an id cannot name anything the owner has, so the
 * answer is the same as for an id that names nothing. Transport validates the
 * format first and returns 400; this is the backstop for any other caller.
 */
function asProjectId(value: string): ProjectId {
  try {
    return toProjectId(value);
  } catch {
    throw new ResourceNotFoundError();
  }
}

function asEnvironmentId(value: string): EnvironmentId {
  try {
    return toEnvironmentId(value);
  } catch {
    throw new ResourceNotFoundError();
  }
}

export function createProjectEnvironmentService(): ProjectEnvironmentService {
  /** Confirms the project is the owner's, or reports it as absent. */
  async function requireProject(
    context: AuthenticatedRequestContext,
    projectId: ProjectId,
  ): Promise<ProjectRecord> {
    const project = await context.repository.getProject(projectId);
    if (project === undefined) {
      throw new ResourceNotFoundError();
    }
    return project;
  }

  return {
    createProject(context, command) {
      return context.repository.createProject({
        projectName: command.projectName,
        ...(command.repo !== undefined ? { repo: command.repo } : {}),
        ...(command.platform !== undefined ? { platform: command.platform } : {}),
        ...(command.repoSubpath !== undefined ? { repoSubpath: command.repoSubpath } : {}),
      });
    },

    getProject(context, projectId) {
      return requireProject(context, asProjectId(projectId));
    },

    listProjects(context) {
      return context.repository.listProjects();
    },

    async updateProject(context, projectId, command) {
      // Only the fields actually present are forwarded. Passing `undefined`
      // through would be indistinguishable from clearing a value.
      const patch: UpdateProjectInput = {
        ...(command.projectName !== undefined ? { projectName: command.projectName } : {}),
        ...(command.repo !== undefined ? { repo: command.repo } : {}),
        ...(command.platform !== undefined ? { platform: command.platform } : {}),
        ...(command.repoSubpath !== undefined ? { repoSubpath: command.repoSubpath } : {}),
      };

      if (Object.keys(patch).length === 0) {
        // Transport rejects this too. Repeated here because an update that
        // changes nothing would still move `updated_at`, recording a change
        // that did not happen.
        throw new InvalidApplicationInputError('A project update must change at least one field.');
      }

      const updated = await context.repository.updateProject(asProjectId(projectId), patch);
      if (updated === undefined) {
        throw new ResourceNotFoundError();
      }
      return updated;
    },

    async createEnvironment(context, projectId, command) {
      const target = asProjectId(projectId);
      // Checked first so an unknown project and another owner's project fail
      // the same way, before the snapshot is even considered.
      await requireProject(context, target);

      return context.repository.createEnvironment({
        projectId: target,
        snapshot: command.snapshot,
      });
    },

    async getEnvironment(context, environmentId) {
      const environment = await context.repository.getEnvironment(asEnvironmentId(environmentId));
      if (environment === undefined) {
        throw new ResourceNotFoundError();
      }
      return environment;
    },

    async listEnvironments(context, projectId) {
      const target = asProjectId(projectId);
      // Without this, a project belonging to someone else would answer with an
      // empty list — which reads as "it exists and has none".
      await requireProject(context, target);

      return context.repository.listEnvironments(target);
    },
  };
}
