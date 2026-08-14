/**
 * Removing a Problem permanently.
 *
 * The spec separates three things that all mean "stop using this" and are not
 * the same. Invalidating says the memory no longer reflects reality;
 * suppressing says surface it less; turning reads off says do not draw on it.
 * All three keep the record, and all three are reversible in the sense that
 * matters — the evidence is still there to look at.
 *
 * This is the fourth, and it is none of those. The row goes. It exists for the
 * cases the spec names: something a person explicitly wants gone, something
 * that was never worth keeping, and a credential that was written into a
 * summary by mistake and cannot be un-read while it is still stored.
 *
 * Because it is physical, nothing is left behind to consult — no `deleted_at`,
 * no `DELETED` status, no tombstone row. That is not an omission. A
 * soft-deleted Problem would need every read, list and append in the system to
 * remember to exclude it, and the one that forgot would serve the very content
 * the delete existed to remove. With the row gone, every path already answers
 * correctly: each of them resolves the Problem first, and a Problem that is
 * not there is a 404 — the same 404 as one that never existed and one that
 * belongs to somebody else. A caller cannot tell which, deliberately.
 *
 * The record of the deletion is not kept either. A change log entry is
 * attached to a Problem, so an entry about this one could only exist by
 * keeping the Problem, and a separate "X was deleted" table would be a new
 * durable statement that a particular Problem existed — for the person
 * deleting a mis-saved credential, that is the thing they asked to be rid of.
 * The operational log records that a delete happened, by the closed reasons
 * this codebase chose; that is a different question from the audit policy in
 * P3-10 and does not anticipate it.
 *
 * This is a destructive operation with no undo. A caller acting on someone's
 * behalf — an adapter, a UI — must have that person's explicit intent before
 * reaching it. The server deliberately does not ask for a confirmation flag:
 * any client that can send the request can also send `confirm: true`, so the
 * flag would record nothing except that the client knew about it.
 */

import { ProblemVersionConflictError, ResourceNotFoundError } from './errors.js';
import type { AuthenticatedRequestContext } from './request-context.js';
import { toProblemId, type ProblemId } from '../domain/problem.js';

export interface DeleteProblemCommand {
  readonly problemId: string;

  /**
   * The version the caller last saw.
   *
   * Required, and worth being exact about what it does and does not buy. It
   * catches the case where the Problem itself moved between the read and the
   * delete — someone else edited a field, changed its status, or concluded it.
   *
   * It does not catch an Event or a Verification appended in the meantime,
   * because appending does not move the version: Phase 2 made appends
   * independent of the Problem's own optimistic locking on purpose, and
   * changing that here would rework idempotency and locking for every write
   * in the system to add a guard to one. So a delete decided at version 5 can
   * remove an Event that arrived after it was decided. The row lock in the
   * database layer closes the window during the delete itself, not the window
   * between reading and asking.
   */
  readonly expectedVersion: number;
}

export interface ProblemDeleteService {
  /**
   * Deletes one of the context owner's Problems, with everything that refers
   * to it.
   *
   * Returns nothing: there is no state left to describe, and returning the
   * Problem that was removed would put its content — possibly the content the
   * caller was deleting — into a response.
   *
   * Raises `ResourceNotFoundError` when it is not the caller's or is already
   * gone, and `ProblemVersionConflictError` when it has moved on.
   */
  delete(context: AuthenticatedRequestContext, command: DeleteProblemCommand): Promise<void>;
}

/**
 * An id that is not one reads as a Problem that is not there.
 *
 * The same treatment every other service gives it: a malformed id and an id
 * belonging to someone else are both 404, so guessing at the shape of an
 * identifier tells a caller nothing.
 */
function asProblemId(value: string): ProblemId {
  try {
    return toProblemId(value);
  } catch {
    throw new ResourceNotFoundError();
  }
}

export function createProblemDeleteService(): ProblemDeleteService {
  return {
    async delete(context, command) {
      const target = asProblemId(command.problemId);

      // One transaction around the whole thing. Six tables are involved, and
      // the states in between — events gone but the Problem still there,
      // relations gone from one side only — are all worse than the delete
      // failing, because each of them is a Problem that has quietly lost part
      // of its history with nothing recording that it did.
      const outcome = await context.runInTransaction((repository) =>
        repository.deleteProblem(target, command.expectedVersion),
      );

      if (outcome === 'NOT_FOUND') {
        throw new ResourceNotFoundError();
      }
      if (outcome === 'VERSION_CONFLICT') {
        throw new ProblemVersionConflictError();
      }
    },
  };
}
