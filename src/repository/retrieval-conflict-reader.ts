/**
 * Owner-scoped access to what disagrees with a Memory.
 *
 * A reader, like the others on the retrieval path: one operation, and it
 * reads. Reporting that two Memories were linked as contradicting cannot
 * become a way to link them, because there is nothing here to write through.
 *
 * The owner is fixed when the reader is built and no method takes one.
 */

import type { DatabaseExecutor } from '../db/executor.js';
import { readConflicts, type ConflictRow } from '../db/retrieval-conflict-read.js';
import type { OwnerContext, OwnerId } from '../domain/owner.js';
import type { ProblemId } from '../domain/problem.js';

export interface RetrievalConflictReader {
  /** The owner every read through this reader is scoped to. */
  readonly ownerId: OwnerId;

  /**
   * Each of these Problems' own semantics, and what was recorded as
   * contradicting it.
   *
   * A Problem present with an empty list has no `CONTRADICTS` Relation
   * recorded; a Problem absent cannot be seen by this owner. The distinction
   * matters — "nothing is recorded as disagreeing" is not "this Memory is
   * gone" — and unknown, another owner's, deleted and read-disabled are one
   * answer among themselves.
   *
   * The same test is applied again to the other end of every link. A Relation
   * is a link between two Problems, not permission to read the second one.
   */
  readForCandidates(problemIds: readonly ProblemId[]): Promise<Map<ProblemId, ConflictRow>>;
}

export function createRetrievalConflictReader(
  executor: DatabaseExecutor,
  context: OwnerContext,
): RetrievalConflictReader {
  return {
    ownerId: context.ownerId,
    readForCandidates: (problemIds) => readConflicts(executor, context, problemIds),
  };
}
