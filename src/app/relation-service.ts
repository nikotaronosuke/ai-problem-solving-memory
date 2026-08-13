/**
 * Relation operations.
 *
 * Between transport and the repository. Its job is to settle both ends before
 * anything is written: a link needs two Problems, and both have to be the
 * caller's.
 *
 * Ownership is checked here rather than left to the foreign keys. The database
 * would refuse a cross-owner link either way, but the answer a client gets
 * should be a decision made at this layer rather than a consequence of which
 * constraint happened to fire — and the two ends failing must look identical
 * from outside, or the endpoint becomes a way to ask "does this problem id
 * exist?" about someone else's data.
 *
 * A Relation does not touch either Problem. No status changes, no version
 * moves, no `updated_at` advances, and nothing is copied from one to the
 * other. Linking a verified Problem to an unverified one says they are
 * connected; the second still needs its own successful Verification to become
 * `VERIFIED`, exactly as before. A link is not an inheritance.
 *
 * Create and list only. There is no update or delete, so this service does not
 * decide how a mistaken link is withdrawn.
 */

import { InvalidApplicationInputError, ResourceNotFoundError } from './errors.js';
import type { AuthenticatedRequestContext } from './request-context.js';
import type { RelationType } from '../domain/enums.js';
import { toProblemId, type ProblemId } from '../domain/problem.js';
import { isSelfRelation } from '../domain/relation.js';
import type { RelationRecord } from '../repository/index.js';

export interface CreateRelationCommand {
  readonly toId: string;
  readonly relationType: RelationType;
  readonly reason: string;
}

export interface RelationService {
  createRelation(
    context: AuthenticatedRequestContext,
    fromProblemId: string,
    command: CreateRelationCommand,
  ): Promise<RelationRecord>;
  listRelations(context: AuthenticatedRequestContext, problemId: string): Promise<RelationRecord[]>;
}

/**
 * Converts an identifier, treating a malformed one as absent.
 *
 * Transport validates the format first; this is the backstop for any other
 * caller.
 */
function asProblemId(value: string): ProblemId {
  try {
    return toProblemId(value);
  } catch {
    throw new ResourceNotFoundError();
  }
}

export function createRelationService(): RelationService {
  async function requireProblem(
    context: AuthenticatedRequestContext,
    problemId: ProblemId,
  ): Promise<void> {
    if ((await context.repository.getProblem(problemId)) === undefined) {
      throw new ResourceNotFoundError();
    }
  }

  return {
    async createRelation(context, fromProblemId, command) {
      const fromId = asProblemId(fromProblemId);
      await requireProblem(context, fromId);

      const toId = asProblemId(command.toId);

      // Before the target is looked up, so the answer does not depend on
      // whether a problem the caller may not see happens to exist.
      if (isSelfRelation(fromId, toId)) {
        throw new InvalidApplicationInputError('A relation cannot join a problem to itself.');
      }

      // The same not-found as for the source. Another owner's problem and one
      // that does not exist are indistinguishable, so this cannot be used to
      // discover which ids are real.
      await requireProblem(context, toId);

      // The two may belong to different projects. That is the point of a
      // relation: experience from one investigation reaching another.
      return context.repository.createRelation({
        fromId,
        toId,
        relationType: command.relationType,
        reason: command.reason,
      });
    },

    async listRelations(context, problemId) {
      const target = asProblemId(problemId);
      // Checked first, so another owner's problem cannot answer with an empty
      // list — which would read as "it exists and has none".
      await requireProblem(context, target);

      return context.repository.listRelations(target);
    },
  };
}
