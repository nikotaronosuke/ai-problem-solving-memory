/**
 * Owner-scoped access to the metadata a ranking reads.
 *
 * A reader, like the three before it on the retrieval path: one operation, and
 * it reads. Ranking cannot become a way to write, because there is nothing
 * here to write through.
 *
 * The owner is fixed when the reader is built and no method takes one, so a
 * caller cannot rank one person's candidates against another's Project.
 */

import type { DatabaseExecutor } from '../db/executor.js';
import { readRankingMetadata, type RankingMetadataSnapshot } from '../db/retrieval-ranking-read.js';
import type { OwnerContext, OwnerId } from '../domain/owner.js';
import type { ProblemId } from '../domain/problem.js';
import type { ProjectId } from '../domain/project.js';

export interface RetrievalRankingReader {
  /** The owner every read through this reader is scoped to. */
  readonly ownerId: OwnerId;

  /**
   * The current Project's technology label and each readable candidate's
   * ranking controls, from one snapshot.
   *
   * The Project not being found and a candidate not coming back mean the same
   * thing in both cases: this owner cannot see it, and why is not disclosed.
   */
  readRankingMetadata(
    currentProjectId: ProjectId,
    problemIds: readonly ProblemId[],
  ): Promise<RankingMetadataSnapshot>;
}

export function createRetrievalRankingReader(
  executor: DatabaseExecutor,
  context: OwnerContext,
): RetrievalRankingReader {
  return {
    ownerId: context.ownerId,
    readRankingMetadata: (currentProjectId, problemIds) =>
      readRankingMetadata(executor, context, currentProjectId, problemIds),
  };
}
