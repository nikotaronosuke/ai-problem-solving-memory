/**
 * Owner-scoped access to the directions a Memory's record supports.
 *
 * A reader, like the others on the retrieval path: one operation, and it reads.
 * The owner is fixed when the reader is built and no method takes one.
 */

import type { DatabaseExecutor } from '../db/executor.js';
import { readSuccessfulDirections } from '../db/retrieval-successful-direction-read.js';
import type { OwnerContext, OwnerId } from '../domain/owner.js';
import type { ProblemId } from '../domain/problem.js';

export interface RetrievalSuccessfulDirectionReader {
  /** The owner every read through this reader is scoped to. */
  readonly ownerId: OwnerId;

  /**
   * The directions each of these Problems' records currently supports.
   *
   * A Problem present with an empty list has nothing that may be offered as a
   * direction that worked — because no artifact has been generated, because
   * the artifact names none, or because the record no longer passes the
   * evidence gate. Those three are not distinguished; they mean the same thing
   * to a caller.
   *
   * A Problem absent cannot be seen by this owner, and unknown, another
   * owner's, deleted and read-disabled are one answer among themselves.
   */
  readForCandidates(problemIds: readonly ProblemId[]): Promise<Map<ProblemId, readonly string[]>>;
}

export function createRetrievalSuccessfulDirectionReader(
  executor: DatabaseExecutor,
  context: OwnerContext,
): RetrievalSuccessfulDirectionReader {
  return {
    ownerId: context.ownerId,
    readForCandidates: (problemIds) => readSuccessfulDirections(executor, context, problemIds),
  };
}
