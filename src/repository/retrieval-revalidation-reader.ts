/**
 * Owner-scoped access to what a Memory was recorded under.
 *
 * A reader, like the others on the retrieval path: one operation, and it
 * reads. Returning the conditions and the checks behind a Memory cannot become
 * a way to change either, because there is nothing here to change them
 * through.
 *
 * The owner is fixed when the reader is built and no method takes one.
 */

import type { DatabaseExecutor } from '../db/executor.js';
import {
  readRevalidationContext,
  type RevalidationRow,
} from '../db/retrieval-revalidation-read.js';
import type { OwnerContext, OwnerId } from '../domain/owner.js';
import type { ProblemId } from '../domain/problem.js';

export interface RetrievalRevalidationReader {
  /** The owner every read through this reader is scoped to. */
  readonly ownerId: OwnerId;

  /**
   * What each of these Problems occurred under, for the ones still readable.
   *
   * Fewer entries than identifiers is ordinary: a Problem can be deleted or
   * have automatic reading switched off between one stage and the next.
   * Unknown, another owner's, deleted and read-disabled are one answer.
   */
  readForCandidates(problemIds: readonly ProblemId[]): Promise<Map<ProblemId, RevalidationRow>>;
}

export function createRetrievalRevalidationReader(
  executor: DatabaseExecutor,
  context: OwnerContext,
): RetrievalRevalidationReader {
  return {
    ownerId: context.ownerId,
    readForCandidates: (problemIds) => readRevalidationContext(executor, context, problemIds),
  };
}
