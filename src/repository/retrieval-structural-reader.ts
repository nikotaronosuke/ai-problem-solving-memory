/**
 * Owner-scoped access to the structural side of candidate artifacts.
 *
 * A reader, like the other two on the retrieval path: one operation, and it
 * reads. Reranking cannot become a way to write, because there is nothing here
 * to write through — and in particular it cannot regenerate an artifact it
 * failed to find, which would turn a search into a generation at the moment
 * somebody is waiting for an answer.
 *
 * The owner is fixed when the reader is built and no method takes one.
 */

import type { DatabaseExecutor } from '../db/executor.js';
import {
  readStructuralArtifacts,
  type StructuralArtifactRow,
} from '../db/retrieval-structural-read.js';
import type { OwnerContext, OwnerId } from '../domain/owner.js';
import type { ProblemId } from '../domain/problem.js';

export interface RetrievalStructuralReader {
  /** The owner every read through this reader is scoped to. */
  readonly ownerId: OwnerId;

  /**
   * The structural side of whichever of these Problems is still readable.
   *
   * Fewer rows than identifiers is ordinary: a Problem can be deleted, lose
   * its artifact or have automatic reading switched off between one stage and
   * the next. Unknown, another owner's, deleted and read-disabled are one
   * answer.
   */
  readStructural(problemIds: readonly ProblemId[]): Promise<StructuralArtifactRow[]>;
}

export function createRetrievalStructuralReader(
  executor: DatabaseExecutor,
  context: OwnerContext,
): RetrievalStructuralReader {
  return {
    ownerId: context.ownerId,
    readStructural: (problemIds) => readStructuralArtifacts(executor, context, problemIds),
  };
}
