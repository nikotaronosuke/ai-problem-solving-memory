/**
 * Problem operations.
 *
 * Between transport and the repository, like the project service. Its extra
 * job here is the relation check on creation: a Problem names a project and an
 * environment, and those two have to agree with each other and both belong to
 * the caller.
 *
 * Every way that check can fail produces the same `ResourceNotFoundError` —
 * unknown project, someone else's project, unknown environment, someone else's
 * environment, or an environment that belongs to a different project of the
 * caller's own. Separating them would let a caller probe for which ids exist.
 *
 * What a caller may change is deliberately narrow. `status` is absent because
 * transitions are P2-06's and `VERIFIED` requires a successful Verification —
 * a generic field assignment would walk straight past that rule. `version` is
 * absent because P2-07 turns it into an optimistic lock, and `fix_kind`
 * because it belongs with close and review in P2-12. None of those is an
 * oversight, and adding one here would quietly remove a guarantee a later task
 * is supposed to provide.
 */

import {
  InvalidApplicationInputError,
  ProblemVersionConflictError,
  ResourceNotFoundError,
} from './errors.js';
import type { AuthenticatedRequestContext } from './request-context.js';
import type { Confidence, Freshness } from '../domain/enums.js';
import { toEnvironmentId } from '../domain/environment.js';
import { toProblemId } from '../domain/problem.js';
import { toProjectId, type ProjectId } from '../domain/project.js';
import type { ProblemRecord, UpdateProblemInput } from '../repository/index.js';

export interface CreateProblemCommand {
  readonly environmentId: string;
  readonly title: string;
  readonly symptoms: string;
  readonly problemDomain?: string | null;
  readonly suspectedBoundary?: string | null;
  readonly sourceAi?: string | null;
}

export interface UpdateProblemCommand {
  /**
   * The version the caller last read.
   *
   * Required. Without it a client that read a problem, thought about it, and
   * sent a change would silently overwrite whatever happened in between —
   * which for a record of what was tried and learned means losing someone
   * else's finding without either of them noticing.
   */
  readonly expectedVersion: number;
  readonly title?: string;
  readonly symptoms?: string;
  readonly problemDomain?: string | null;
  readonly suspectedBoundary?: string | null;
  readonly sourceAi?: string | null;
  readonly importance?: boolean;
  readonly confidence?: Confidence;
  readonly freshness?: Freshness;
  readonly memoryReadEnabled?: boolean;
  readonly memoryWriteEnabled?: boolean;
  readonly suppressed?: boolean;
}

export interface ProblemService {
  createProblem(
    context: AuthenticatedRequestContext,
    projectId: string,
    command: CreateProblemCommand,
  ): Promise<ProblemRecord>;
  getProblem(context: AuthenticatedRequestContext, problemId: string): Promise<ProblemRecord>;
  listProblems(context: AuthenticatedRequestContext, projectId: string): Promise<ProblemRecord[]>;
  updateProblem(
    context: AuthenticatedRequestContext,
    problemId: string,
    command: UpdateProblemCommand,
  ): Promise<ProblemRecord>;
}

/**
 * Converts a path identifier, treating a malformed one as absent.
 *
 * A string that cannot be an id names nothing the owner has, so it answers the
 * same as an id that names nothing. Transport validates the format first;
 * this is the backstop for any other caller.
 */
function asProjectId(value: string): ProjectId {
  try {
    return toProjectId(value);
  } catch {
    throw new ResourceNotFoundError();
  }
}

export function createProblemService(): ProblemService {
  async function requireProject(
    context: AuthenticatedRequestContext,
    projectId: ProjectId,
  ): Promise<void> {
    if ((await context.repository.getProject(projectId)) === undefined) {
      throw new ResourceNotFoundError();
    }
  }

  return {
    async createProblem(context, projectId, command) {
      const project = asProjectId(projectId);
      await requireProject(context, project);

      let environmentId;
      try {
        environmentId = toEnvironmentId(command.environmentId);
      } catch {
        throw new ResourceNotFoundError();
      }

      const environment = await context.repository.getEnvironment(environmentId);
      // Absent, or the owner's but recorded under a different project. Both
      // are the same answer: there is no such environment for this project.
      if (environment === undefined || environment.projectId !== project) {
        throw new ResourceNotFoundError();
      }

      // Status, confidence, freshness, the flags and version are not passed:
      // they come from the column defaults, so a new Problem cannot be created
      // already claiming to be verified or trusted.
      return context.repository.createProblem({
        projectId: project,
        environmentId,
        title: command.title,
        symptoms: command.symptoms,
        ...(command.problemDomain !== undefined ? { problemDomain: command.problemDomain } : {}),
        ...(command.suspectedBoundary !== undefined
          ? { suspectedBoundary: command.suspectedBoundary }
          : {}),
        ...(command.sourceAi !== undefined ? { sourceAi: command.sourceAi } : {}),
      });
    },

    async getProblem(context, problemId) {
      let target;
      try {
        target = toProblemId(problemId);
      } catch {
        throw new ResourceNotFoundError();
      }

      const problem = await context.repository.getProblem(target);
      if (problem === undefined) {
        throw new ResourceNotFoundError();
      }
      return problem;
    },

    async listProblems(context, projectId) {
      const project = asProjectId(projectId);
      // Checked first, so another owner's project cannot answer with an empty
      // list — which would read as "it exists and has none".
      await requireProject(context, project);

      return context.repository.listProblems(project);
    },

    async updateProblem(context, problemId, command) {
      let target;
      try {
        target = toProblemId(problemId);
      } catch {
        throw new ResourceNotFoundError();
      }

      // Only the keys actually sent are forwarded. Passing `undefined` through
      // would be indistinguishable from clearing a nullable field.
      const patch: UpdateProblemInput = {
        ...(command.title !== undefined ? { title: command.title } : {}),
        ...(command.symptoms !== undefined ? { symptoms: command.symptoms } : {}),
        ...(command.problemDomain !== undefined ? { problemDomain: command.problemDomain } : {}),
        ...(command.suspectedBoundary !== undefined
          ? { suspectedBoundary: command.suspectedBoundary }
          : {}),
        ...(command.sourceAi !== undefined ? { sourceAi: command.sourceAi } : {}),
        ...(command.importance !== undefined ? { importance: command.importance } : {}),
        ...(command.confidence !== undefined ? { confidence: command.confidence } : {}),
        ...(command.freshness !== undefined ? { freshness: command.freshness } : {}),
        ...(command.memoryReadEnabled !== undefined
          ? { memoryReadEnabled: command.memoryReadEnabled }
          : {}),
        ...(command.memoryWriteEnabled !== undefined
          ? { memoryWriteEnabled: command.memoryWriteEnabled }
          : {}),
        ...(command.suppressed !== undefined ? { suppressed: command.suppressed } : {}),
      };

      if (Object.keys(patch).length === 0) {
        // Transport rejects this too. Repeated here because an update that
        // changes nothing would still move `updated_at`. `expectedVersion` is
        // a concurrency token rather than a field, so a body carrying only it
        // changes nothing.
        throw new InvalidApplicationInputError('A problem update must change at least one field.');
      }

      // Existence is settled before the version is, so a caller guessing at a
      // version for a problem that is not theirs gets the same 404 as for one
      // that does not exist. Answering "wrong version" would confirm it is
      // real.
      const current = await context.repository.getProblem(target);
      if (current === undefined) {
        throw new ResourceNotFoundError();
      }
      if (current.version !== command.expectedVersion) {
        throw new ProblemVersionConflictError();
      }

      const updated = await context.repository.updateProblem(
        target,
        command.expectedVersion,
        patch,
      );
      if (updated === undefined) {
        // The read above said the version matched, so the only way to be here
        // is another writer landing in between. The predicate on the update is
        // what makes that a refusal rather than a silent overwrite.
        throw new ProblemVersionConflictError();
      }
      return updated;
    },
  };
}
