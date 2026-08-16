/**
 * Owner-scoped access to the dead ends recorded against a Memory.
 *
 * A reader, like the others on the retrieval path: one operation, and it
 * reads. Returning where a direction did not lead cannot become a way to
 * record one, because there is nothing here to record through.
 *
 * The owner is fixed when the reader is built and no method takes one.
 */

import type { DatabaseExecutor } from '../db/executor.js';
import { readDeadEndWarnings } from '../db/retrieval-dead-end-read.js';
import type { OwnerContext, OwnerId } from '../domain/owner.js';
import type { ProblemId } from '../domain/problem.js';
import type { DeadEndWarning } from '../domain/retrieval-dead-end.js';

export interface RetrievalDeadEndReader {
  /** The owner every read through this reader is scoped to. */
  readonly ownerId: OwnerId;

  /**
   * The dead ends recorded against each of these Problems, oldest first.
   *
   * A Problem present with an empty list has none recorded; a Problem absent
   * cannot be seen by this owner. The distinction matters — "nowhere is known
   * not to lead" is not "this Memory is gone" — and unknown, another owner's,
   * deleted and read-disabled are one answer among themselves.
   */
  readForCandidates(problemIds: readonly ProblemId[]): Promise<Map<ProblemId, DeadEndWarning[]>>;
}

export function createRetrievalDeadEndReader(
  executor: DatabaseExecutor,
  context: OwnerContext,
): RetrievalDeadEndReader {
  return {
    ownerId: context.ownerId,
    readForCandidates: (problemIds) => readDeadEndWarnings(executor, context, problemIds),
  };
}
