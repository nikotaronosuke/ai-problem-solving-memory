/**
 * The one way a Problem's fields change.
 *
 * Every surface that edits a Problem — the ordinary patch, the memory
 * controls — goes through here, so the guarantees around such a change are
 * written once. Copying them per route is how two paths end up with subtly
 * different locking, or one of them quietly not recording history.
 *
 * The guarantees are:
 *
 * Existence is settled before the version, so a caller guessing at a version
 * for a Problem that is not theirs gets the same 404 as for one that does not
 * exist — answering "wrong version" would confirm it is real.
 *
 * The write is a compare-and-swap on the version the caller named, and the
 * database predicate is what arbitrates a race. The transaction does not
 * replace it.
 *
 * The change and the record of it commit or roll back together. A Problem
 * edited with no history, or history for an edit that did not happen, are both
 * worse than the write failing outright.
 *
 * Status transitions do not use this: they have a rule to apply first and a
 * different write, so they keep their own flow while following the same
 * guarantees.
 */

import { ProblemVersionConflictError, ResourceNotFoundError } from './errors.js';
import { describeProblemChanges } from './problem-changes.js';
import type { AuthenticatedRequestContext } from './request-context.js';
import type { ProblemId } from '../domain/problem.js';
import type { ProblemRecord, UpdateProblemInput } from '../repository/index.js';

export interface ProblemMutation {
  readonly problemId: ProblemId;
  readonly expectedVersion: number;
  readonly changedBy: string;
  /** What to write, in repository terms. Must not be empty. */
  readonly patch: UpdateProblemInput;
  /**
   * Wire names of the fields this change touched, for the history.
   *
   * Passed separately from `patch` because the two vocabularies differ, and
   * because a caller may write a field under a name of its own — the memory
   * controls turn `invalidate` into a change to `freshness`, and the history
   * records the field that actually moved.
   */
  readonly changedFields: readonly string[];
}

/**
 * Applies a change to one of the context owner's Problems, and records it.
 *
 * Returns the updated Problem. Raises `ResourceNotFoundError` when it is not
 * the caller's, and `ProblemVersionConflictError` when it has moved on —
 * either because the read saw a different version, or because another writer
 * landed between the read and the write.
 */
export function applyProblemMutation(
  context: AuthenticatedRequestContext,
  mutation: ProblemMutation,
): Promise<ProblemRecord> {
  const { problemId, expectedVersion, changedBy, patch, changedFields } = mutation;

  return context.runInTransaction(async (repository) => {
    const current = await repository.getProblem(problemId);
    if (current === undefined) {
      throw new ResourceNotFoundError();
    }
    if (current.version !== expectedVersion) {
      throw new ProblemVersionConflictError();
    }

    const updated = await repository.updateProblem(problemId, expectedVersion, patch);
    if (updated === undefined) {
      // The read said the version matched, so another writer landed in
      // between. The predicate on the update is what makes that a refusal
      // rather than a silent overwrite.
      throw new ProblemVersionConflictError();
    }

    await repository.createChangeLog({
      problemId,
      changedBy,
      fromVersion: current.version,
      toVersion: updated.version,
      changes: describeProblemChanges(current, updated, changedFields),
    });

    return updated;
  });
}
