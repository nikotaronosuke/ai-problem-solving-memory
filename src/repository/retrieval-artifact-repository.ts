/**
 * The owner-scoped way in and out of retrieval artifacts.
 *
 * Separate from `MemoryRepository` on purpose, and the separation is the
 * specification's rather than a filing preference: a retrieval artifact is
 * derived data, regenerable, and never a source of truth. Putting it beside
 * `createProblem` and `appendEvent` would put a cache behind the same door as
 * the record, and the first thing that goes wrong when those share a door is
 * that something writes to the record while meaning to refresh the cache.
 *
 * Two operations, which is all P4-01 needs. There is no list and no query —
 * what a search asks for belongs to the tasks that build searching — and no
 * delete, because an artifact is removed with its Problem, in the delete path,
 * rather than through an operation somebody could call on its own.
 *
 * Owner scope is a thing this object holds rather than an argument any caller
 * passes, exactly as the Memory repository does it. There is no method here
 * that names an owner.
 */

import type { OwnerContext, OwnerId } from '../domain/owner.js';
import type { ProblemId } from '../domain/problem.js';
import type {
  RetrievalArtifactRecord,
  UpsertRetrievalArtifactInput,
} from '../domain/retrieval-artifact.js';
import { findRetrievalArtifact, upsertRetrievalArtifact } from '../db/retrieval-artifacts.js';
import type { DatabaseExecutor } from '../db/executor.js';

export interface RetrievalArtifactRepository {
  /** The owner every operation on this repository is scoped to. */
  readonly ownerId: OwnerId;

  /**
   * Writes the Problem's current artifact, replacing any it already had.
   *
   * Refuses a Problem that is not this owner's, the same way and with the same
   * answer as every other path that could be asked about one.
   */
  upsertArtifact(input: UpsertRetrievalArtifactInput): Promise<RetrievalArtifactRecord>;

  /** Reads the Problem's current artifact, or `undefined` if it has none. */
  getArtifact(problemId: ProblemId): Promise<RetrievalArtifactRecord | undefined>;
}

export function createRetrievalArtifactRepository(
  executor: DatabaseExecutor,
  context: OwnerContext,
): RetrievalArtifactRepository {
  return {
    ownerId: context.ownerId,

    upsertArtifact(input) {
      return upsertRetrievalArtifact(executor, context, input);
    },

    getArtifact(problemId) {
      return findRetrievalArtifact(executor, context, problemId);
    },
  };
}
