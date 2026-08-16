/**
 * Attaching what disagrees with a Memory, and the material for comparing it.
 *
 * The last thing a search does to a candidate. Ranking put it where it is, the
 * revalidation contract said what to re-establish, dead-end handling said
 * where it does not lead, and this says what contradicts it.
 *
 * **Material, never a verdict.** The specification says that when two Memories
 * conflict the answer is not decided by majority — what gets compared is the
 * difference in environment, in version, in symptoms, the stated reason, and
 * the strength of the verification behind each; and if that cannot settle it,
 * the record stays `CONFLICTED` rather than being resolved. Every one of those
 * five is something this stage can supply and none is something it can judge,
 * so there is no winner here, no preferred Memory, no resolution and no score.
 * Which of two disagreeing Memories applies to the work happening now depends
 * on the conditions that work is happening under, which is the one thing this
 * process cannot see.
 *
 * **A disagreement never costs a candidate its place.** Nothing is dropped,
 * demoted or reordered for having contradictions. A Memory that records its
 * disagreements is not a worse Memory, and the one already-existing effect of
 * conflict on order — `CONFLICTED` confidence ranking last — belongs to the
 * ranking stage and is left exactly as it was.
 *
 * **Two things called conflict, kept apart.** A `CONTRADICTS` Relation does not
 * change either Problem's confidence, and a `CONFLICTED` Problem with no link
 * recorded gets none invented. All four combinations occur; all four are
 * reported as they are.
 */

import type { OwnerId } from '../domain/owner.js';
import { MAX_RANKED_CANDIDATES } from '../domain/retrieval-ranking.js';
import type {
  SuccessfulDirectionAwareMemoryCandidate,
  RetrievalMemoryCandidate,
} from '../domain/retrieval-result.js';
import type { RetrievalConflictReader } from '../repository/index.js';

/** Raised when a set of candidates cannot be enriched as given. */
export class InvalidConflictRequestError extends Error {
  readonly field: string;

  constructor(field: string, reason: string) {
    // A field and a fixed reason. Never an identifier: this error travels.
    super(`Retrieval conflict ${field} is unusable: ${reason}.`);
    this.name = 'InvalidConflictRequestError';
    this.field = field;
  }
}

export interface RetrievalConflictService {
  /** The owner every read through this service is scoped to. */
  readonly ownerId: OwnerId;

  /**
   * Attaches recorded disagreements to each candidate still worth offering.
   *
   * Returns them in the order given, with any that have become unreadable
   * removed and the remaining positions closed up. Writes nothing.
   */
  enrich(
    candidates: readonly SuccessfulDirectionAwareMemoryCandidate[],
  ): Promise<readonly RetrievalMemoryCandidate[]>;
}

export function createRetrievalConflictService(
  reader: RetrievalConflictReader,
): RetrievalConflictService {
  return {
    ownerId: reader.ownerId,

    async enrich(candidates): Promise<readonly RetrievalMemoryCandidate[]> {
      // The type says these came from the stage before. This function is
      // exported, so that is a claim rather than a fact, and these are the
      // cheap checks that keep a malformed list from reaching a query. The
      // same four the two stages before make, because the same reasoning
      // applies to this entry point independently.
      if (!Array.isArray(candidates)) {
        throw new InvalidConflictRequestError('candidates', 'they are not a list');
      }
      // Held under its declared type: `Array.isArray` widens a readonly array
      // to `any[]`, and every field below is read from it.
      const enriched: readonly SuccessfulDirectionAwareMemoryCandidate[] = candidates;

      if (enriched.length > MAX_RANKED_CANDIDATES) {
        throw new InvalidConflictRequestError(
          'candidates',
          `there are more than ${String(MAX_RANKED_CANDIDATES)} of them`,
        );
      }

      const seen = new Set<string>();
      for (const [index, candidate] of enriched.entries()) {
        if (seen.has(candidate.ranking.problemId)) {
          throw new InvalidConflictRequestError('candidates', 'one Problem appears twice');
        }
        seen.add(candidate.ranking.problemId);

        // The array's order and each candidate's stated position have to be
        // the same fact, because a candidate dropping out below is renumbered
        // from its place in the array.
        if (candidate.ranking.rankingRank !== index + 1) {
          throw new InvalidConflictRequestError(
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

      const conflictByProblem = await reader.readForCandidates(
        enriched.map((candidate) => candidate.ranking.problemId),
      );

      const offered: RetrievalMemoryCandidate[] = [];
      for (const candidate of enriched) {
        const conflict = conflictByProblem.get(candidate.ranking.problemId);
        if (conflict === undefined) {
          // Deleted, switched off, or never this owner's since the previous
          // stage read it — one outcome for all of them, and it is simply
          // gone. Distinct from an empty contradiction list, which means the
          // Memory is here and nothing was recorded as disagreeing with it.
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
          successfulDirections: candidate.successfulDirections,
          conflict,
        });
      }

      return offered;
    },
  };
}

export { MAX_RANKED_CANDIDATES };
