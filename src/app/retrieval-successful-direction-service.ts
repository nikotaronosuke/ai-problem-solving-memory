/**
 * Attaching the directions a Memory's record supports calling successful.
 *
 * **These are guidance, not evidence.** Every other enrichment on this path
 * reports something somebody wrote down: the conditions a Problem occurred
 * under, the checks performed on it, the directions recorded as dead ends, the
 * links recorded as contradictions. This one does not. It reports a summary
 * generator's reading of the whole canonical history, kept because that reading
 * is the only thing in the system that can say which direction worked.
 *
 * The reason is worth stating plainly, because the asymmetry with dead ends
 * looks like an inconsistency until it is:
 *
 * A `DEAD_END` Event is already the fact — somebody tried something and
 * recorded that it did not work. A `FIX` Event is not. **A recorded fix is not
 * a verified one**, nothing links a `FIX` to the Verification that later
 * passed, and a Problem with several fixes and one successful check does not
 * say which fix the check was about. Reporting all of them as successful would
 * invent a causal claim; choosing among them by recency or by proximity to the
 * Verification would invent a rule. So no Event is read here at all, and the
 * one thing that *is* reported carries a mechanical gate rather than a guess.
 *
 * **The gate is applied again, freshly.** The artifact was written under
 * `requiresSuccessfulVerification(status) && hasSuccessfulVerification`, and a
 * generator claiming a direction without it is refused outright at generation
 * time. But a Problem can be reopened and its checks can change afterwards
 * without the artifact being rewritten, so the same test is re-run against the
 * record as it is now. An artifact keeps its directions; a Memory that has left
 * `VERIFIED` stops offering them.
 *
 * **An empty list is not "no fix was ever tried".** It means there is nothing
 * here that may currently be offered as a direction that worked — no artifact,
 * or none named, or the evidence gate no longer holds. A caller wanting the
 * history itself reads the Problem's Events, which is a different question.
 */

import type { OwnerId } from '../domain/owner.js';
import { MAX_RANKED_CANDIDATES } from '../domain/retrieval-ranking.js';
import type {
  DeadEndAwareMemoryCandidate,
  SuccessfulDirectionAwareMemoryCandidate,
} from '../domain/retrieval-result.js';
import type { RetrievalSuccessfulDirectionReader } from '../repository/index.js';

/** Raised when a set of candidates cannot be enriched as given. */
export class InvalidSuccessfulDirectionRequestError extends Error {
  readonly field: string;

  constructor(field: string, reason: string) {
    // A field and a fixed reason. Never an identifier: this error travels.
    super(`Retrieval successful-direction ${field} is unusable: ${reason}.`);
    this.name = 'InvalidSuccessfulDirectionRequestError';
    this.field = field;
  }
}

export interface RetrievalSuccessfulDirectionService {
  /** The owner every read through this service is scoped to. */
  readonly ownerId: OwnerId;

  /**
   * Attaches supported directions to each candidate still worth offering.
   *
   * Returns them in the order given, with any that have become unreadable
   * removed and the remaining positions closed up. Writes nothing.
   */
  enrich(
    candidates: readonly DeadEndAwareMemoryCandidate[],
  ): Promise<readonly SuccessfulDirectionAwareMemoryCandidate[]>;
}

export function createRetrievalSuccessfulDirectionService(
  reader: RetrievalSuccessfulDirectionReader,
): RetrievalSuccessfulDirectionService {
  return {
    ownerId: reader.ownerId,

    async enrich(candidates): Promise<readonly SuccessfulDirectionAwareMemoryCandidate[]> {
      // The type says these came from the stage before. This function is
      // exported, so that is a claim rather than a fact, and these are the
      // cheap checks that keep a malformed list from reaching a query. The
      // same four every enrichment stage makes, because the same reasoning
      // applies to this entry point independently.
      if (!Array.isArray(candidates)) {
        throw new InvalidSuccessfulDirectionRequestError('candidates', 'they are not a list');
      }
      // Held under its declared type: `Array.isArray` widens a readonly array
      // to `any[]`, and every field below is read from it.
      const enriched: readonly DeadEndAwareMemoryCandidate[] = candidates;

      if (enriched.length > MAX_RANKED_CANDIDATES) {
        throw new InvalidSuccessfulDirectionRequestError(
          'candidates',
          `there are more than ${String(MAX_RANKED_CANDIDATES)} of them`,
        );
      }

      const seen = new Set<string>();
      for (const [index, candidate] of enriched.entries()) {
        if (seen.has(candidate.ranking.problemId)) {
          throw new InvalidSuccessfulDirectionRequestError(
            'candidates',
            'one Problem appears twice',
          );
        }
        seen.add(candidate.ranking.problemId);

        // The array's order and each candidate's stated position have to be
        // the same fact, because a candidate dropping out below is renumbered
        // from its place in the array.
        if (candidate.ranking.rankingRank !== index + 1) {
          throw new InvalidSuccessfulDirectionRequestError(
            'candidates',
            'their ranking positions are inconsistent',
          );
        }
      }

      if (enriched.length === 0) {
        // Nothing to look up, and asking would be a round trip whose answer
        // could not change this empty list.
        return [];
      }

      const directionsByProblem = await reader.readForCandidates(
        enriched.map((candidate) => candidate.ranking.problemId),
      );

      const offered: SuccessfulDirectionAwareMemoryCandidate[] = [];
      for (const candidate of enriched) {
        const directions = directionsByProblem.get(candidate.ranking.problemId);
        if (directions === undefined) {
          // Deleted, switched off, or never this owner's since the previous
          // stage read it — one outcome for all of them, and it is simply
          // gone. Distinct from an empty list, which means the Memory is here
          // and has nothing that may be offered as a direction that worked.
          continue;
        }

        offered.push({
          // Rebuilt rather than passed through: the position changes when
          // something ahead of it drops, and the caller's candidates must not
          // be edited to say so.
          ranking: {
            ...candidate.ranking,
            rankingRank: offered.length + 1,
            matchedDimensions: [...candidate.ranking.matchedDimensions],
          },
          revalidation: candidate.revalidation,
          deadEndWarnings: candidate.deadEndWarnings,
          successfulDirections: directions,
        });
      }

      return offered;
    },
  };
}

export { MAX_RANKED_CANDIDATES };
