/**
 * Owner-scoped access to what a retrieval summary is generated from.
 *
 * A reader rather than a repository, and the difference is the point: there is
 * one operation and it reads. Nothing here can write, so a generation cannot
 * become a way to modify the Memory it describes, and that guarantee holds
 * because of what this object *is* rather than because of what its callers
 * remember not to do.
 *
 * Separate from `MemoryRepository` for the reason the whole phase exists: the
 * Memory is the record and retrieval is derived from it, and the two are kept
 * apart so that changing how search reads a Problem never changes how a Problem
 * is stored. A caller wanting the Problem itself has the Memory repository;
 * this answers a different question — "what does a search need to know about
 * this Problem?" — and answers it in one consistent read.
 *
 * As with every repository here, the owner is fixed when the reader is built
 * and no method takes one. The scope is the object.
 */

import type { OwnerContext, OwnerId } from '../domain/owner.js';
import type { ProblemId } from '../domain/problem.js';
import {
  readRetrievalSummarySource,
  type RetrievalSummarySource,
} from '../db/retrieval-summary-source.js';
import type { DatabaseExecutor } from '../db/executor.js';

export interface RetrievalSummarySourceReader {
  /** The owner every read through this reader is scoped to. */
  readonly ownerId: OwnerId;

  /**
   * One consistent read of a Problem's generation source.
   *
   * `undefined` when this owner has no such Problem — unknown and somebody
   * else's are not distinguished.
   */
  readSource(problemId: ProblemId): Promise<RetrievalSummarySource | undefined>;
}

export function createRetrievalSummarySourceReader(
  executor: DatabaseExecutor,
  context: OwnerContext,
): RetrievalSummarySourceReader {
  return {
    ownerId: context.ownerId,
    readSource: (problemId) => readRetrievalSummarySource(executor, context, problemId),
  };
}
