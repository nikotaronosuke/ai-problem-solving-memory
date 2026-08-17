/**
 * Owner-scoped access to the reconciliation scan.
 *
 * A reader, like the others on the retrieval path: one operation, and it
 * reads. Finding the Problems that need generation cannot become a way to
 * generate one, because there is nothing here to generate through — the
 * answer is a list, and what happens to the list is the scheduler's.
 *
 * The owner is fixed when the reader is built and no method takes one.
 */

import type { DatabaseExecutor } from '../db/executor.js';
import {
  findProblemsNeedingArtifactGeneration,
  type ArtifactGenerationFinding,
} from '../db/retrieval-artifact-reconciliation.js';
import type { OwnerContext, OwnerId } from '../domain/owner.js';
import type { RetrievalGenerationProfile } from '../domain/retrieval-generation-profile.js';

export interface RetrievalArtifactReconciliationReader {
  /** The owner every scan through this reader is scoped to. */
  readonly ownerId: OwnerId;

  /**
   * The Problems whose artifact the given stack should generate, oldest
   * first, bounded.
   *
   * An up-to-date database answers with an empty list, and that answer is
   * the point: a sweep that finds nothing costs one read and no provider
   * call, however often it runs.
   */
  findProblemsNeedingGeneration(
    profile: RetrievalGenerationProfile,
    limit?: number,
  ): Promise<ArtifactGenerationFinding[]>;
}

export function createRetrievalArtifactReconciliationReader(
  executor: DatabaseExecutor,
  context: OwnerContext,
): RetrievalArtifactReconciliationReader {
  return {
    ownerId: context.ownerId,
    findProblemsNeedingGeneration: (profile, limit) =>
      limit === undefined
        ? findProblemsNeedingArtifactGeneration(executor, context, profile)
        : findProblemsNeedingArtifactGeneration(executor, context, profile, limit),
  };
}
