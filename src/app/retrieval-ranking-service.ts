/**
 * The last retrieval stage: deciding what order a handful of Memories go in.
 *
 * The structural stage said which candidates describe the same kind of
 * problem. This one takes those and asks which to offer first, using the
 * controls somebody actually set — how far the Memory is trusted, whether it
 * still describes current conditions, whether they asked to see less of it —
 * together with where it came from and how strongly the reranker judged it.
 *
 * Four things this file is careful about:
 *
 * **Nothing the caller says about a Memory is believed.** The candidates
 * arrive with identifiers and a structural judgement, and that is all this
 * stage takes from them. Trust, currency, suppression and the technology label
 * are read from the database every time — not because a caller would lie, but
 * because they can all be changed and one of them may have been, in the moment
 * since the previous stage ran. A ranking built from values a caller supplied
 * would also be a ranking a caller could arrange.
 *
 * **One snapshot.** The current Project's label and the candidates' controls
 * come from a single statement, so "these two Projects share a technology" is
 * a statement about a state the database really held rather than about two
 * reads stitched together.
 *
 * **The controls are re-applied.** The owner and `memory_read_enabled` were
 * checked by earlier stages, and then time passed. A candidate that has since
 * been deleted, switched off, or was never this owner's simply is not there,
 * and all of those look the same.
 *
 * **No model, no network, nothing to degrade around.** Every input is an enum,
 * a boolean or a number that already exists, so the ordering is arithmetic.
 * There is no provider to be unavailable, no payload leaving the process, and
 * therefore no privacy inspection and no degraded status of this stage's own.
 * The structural stage's status is carried through untouched.
 */

import type { OwnerId } from '../domain/owner.js';
import {
  classifyProjectRelation,
  InvalidRetrievalRankingError,
  MAX_RANKED_CANDIDATES,
  rankCandidates,
  resolveRetrievalRankingRequest,
  type RankableCandidate,
  type RetrievalRankingRequest,
  type RetrievalRankingResult,
} from '../domain/retrieval-ranking.js';
import type { RetrievalRankingReader } from '../repository/index.js';

export interface RetrievalRankingService {
  /** The owner whose Memory this ranks. */
  readonly ownerId: OwnerId;

  /**
   * Orders the structural stage's candidates for offering.
   *
   * Writes nothing. Returns between zero and five candidates: the same ones
   * that came in, minus any that have become unreadable, in a new order. None
   * is dropped for ranking low — a Memory somebody suppressed, marked invalid
   * or gave low confidence is still offered, last.
   */
  rank(request: RetrievalRankingRequest): Promise<RetrievalRankingResult>;
}

export function createRetrievalRankingService(
  reader: RetrievalRankingReader,
): RetrievalRankingService {
  return {
    ownerId: reader.ownerId,

    async rank(request): Promise<RetrievalRankingResult> {
      // Everything, before anything runs.
      const resolved = resolveRetrievalRankingRequest(request);

      if (resolved.candidates.length === 0) {
        // Nothing to order. Confirming the current Project exists would be a
        // round trip whose answer could not change this empty list — and
        // asking would turn a ranking into a way to test whether somebody
        // else's Project identifier is real.
        return { candidates: [], structuralStatus: resolved.structuralStatus };
      }

      const snapshot = await reader.readRankingMetadata(
        resolved.currentProjectId,
        resolved.candidates.map((candidate) => candidate.problemId),
      );

      if (!snapshot.currentProjectFound) {
        // Another owner's, or nobody's. One answer for both, naming nothing.
        throw new InvalidRetrievalRankingError('current project', 'it is not available');
      }

      const byProblem = new Map(snapshot.candidates.map((row) => [row.problemId, row]));

      const rankable: RankableCandidate[] = [];
      for (const candidate of resolved.candidates) {
        const row = byProblem.get(candidate.problemId);
        if (row === undefined) {
          // Deleted, switched off, or never this owner's — one outcome for
          // all three, and it is simply gone.
          continue;
        }

        // The Project a candidate belongs to cannot differ between two reads
        // of the same table. If it does, the input is not what it claims, and
        // quietly preferring one of the two answers would let the ranking rest
        // on a contradiction.
        if (row.projectId !== candidate.projectId) {
          throw new Error('A candidate was reported under two Projects.');
        }

        rankable.push({
          problemId: candidate.problemId,
          projectId: candidate.projectId,
          // Read now, not taken from the request.
          confidence: row.confidence,
          freshness: row.freshness,
          suppressed: row.suppressed,
          projectRelation: classifyProjectRelation(
            resolved.currentProjectId,
            snapshot.currentPlatform,
            row.projectId,
            row.platform,
          ),
          // Carried, not recomputed. Null stays null.
          structuralScore: candidate.structuralScore,
          hybridRank: candidate.hybridRank,
          // Carried as provenance only. What the reranker found the two
          // Problems alike in is its judgement; weighing it again here would
          // be this stage second-guessing a question it was not asked.
          matchedDimensions: candidate.matchedDimensions,
        });
      }

      return {
        candidates: rankCandidates(rankable, resolved.structuralStatus),
        structuralStatus: resolved.structuralStatus,
      };
    },
  };
}

export { MAX_RANKED_CANDIDATES };
