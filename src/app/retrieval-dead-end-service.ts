/**
 * Attaching what a Memory already knows does not work.
 *
 * The last thing a search does to a candidate. Ranking put it where it is, the
 * revalidation contract said what to re-establish, and this adds the
 * directions that were tried and recorded as dead ends.
 *
 * **A warning, and only ever a warning.** Nothing here removes a candidate,
 * moves it, or marks it as not to be retried. A direction that failed under
 * one runtime or one library version may be right under another, and the
 * record cannot tell which — the specification says so in four places and
 * makes it an acceptance test. So a candidate with ten dead ends comes back in
 * exactly the position ranking gave it, alongside the historical Environment
 * that lets a caller decide whether the conditions have moved on.
 *
 * **The Event is the source, not the search profile.** A stored artifact
 * carries `dead_end_directions` and that is a different thing: a regenerable
 * rendering used to compare Problems structurally, produced by a generator and
 * never checked against the Events it came from. What is reported here as
 * something that happened is read from the Event that recorded it happening.
 *
 * **No cancellation is inferred.** A later `USER_CORRECTION` may say the dead
 * end was a misreading, and nothing links the two: an Event states what was
 * true when it was recorded, and corrections are separate Events with no
 * reference between them. Deciding that one retracts another would mean
 * reading free text and guessing, so a dead end recorded stays a dead end
 * recorded — a historical fact, whose present applicability is exactly what
 * the revalidation contract asks to be re-established.
 */

import type { OwnerId } from '../domain/owner.js';
import { MAX_RANKED_CANDIDATES } from '../domain/retrieval-ranking.js';
import type {
  RetrievalMemoryCandidate,
  RevalidatedMemoryCandidate,
} from '../domain/retrieval-result.js';
import type { RetrievalDeadEndReader } from '../repository/index.js';

/** Raised when a set of candidates cannot be enriched as given. */
export class InvalidDeadEndRequestError extends Error {
  readonly field: string;

  constructor(field: string, reason: string) {
    // A field and a fixed reason. Never an identifier: this error travels.
    super(`Retrieval dead-end ${field} is unusable: ${reason}.`);
    this.name = 'InvalidDeadEndRequestError';
    this.field = field;
  }
}

export interface RetrievalDeadEndService {
  /** The owner every read through this service is scoped to. */
  readonly ownerId: OwnerId;

  /**
   * Attaches recorded dead ends to each candidate still worth offering.
   *
   * Returns them in the order given, with any that have become unreadable
   * removed and the remaining positions closed up. Writes nothing.
   */
  enrich(
    candidates: readonly RevalidatedMemoryCandidate[],
  ): Promise<readonly RetrievalMemoryCandidate[]>;
}

export function createRetrievalDeadEndService(
  reader: RetrievalDeadEndReader,
): RetrievalDeadEndService {
  return {
    ownerId: reader.ownerId,

    async enrich(candidates): Promise<readonly RetrievalMemoryCandidate[]> {
      // The type says these came from the stage before. This function is
      // exported, so that is a claim rather than a fact, and these are the
      // cheap checks that keep a malformed list from reaching a query. The
      // same four the previous stage makes, because the same reasoning
      // applies to this entry point independently.
      if (!Array.isArray(candidates)) {
        throw new InvalidDeadEndRequestError('candidates', 'they are not a list');
      }
      // Held under its declared type: `Array.isArray` widens a readonly array
      // to `any[]`, and every field below is read from it.
      const revalidated: readonly RevalidatedMemoryCandidate[] = candidates;

      if (revalidated.length > MAX_RANKED_CANDIDATES) {
        throw new InvalidDeadEndRequestError(
          'candidates',
          `there are more than ${String(MAX_RANKED_CANDIDATES)} of them`,
        );
      }

      const seen = new Set<string>();
      for (const [index, candidate] of revalidated.entries()) {
        if (seen.has(candidate.ranking.problemId)) {
          throw new InvalidDeadEndRequestError('candidates', 'one Problem appears twice');
        }
        seen.add(candidate.ranking.problemId);

        // The array's order and each candidate's stated position have to be
        // the same fact, because a candidate dropping out below is renumbered
        // from its place in the array.
        if (candidate.ranking.rankingRank !== index + 1) {
          throw new InvalidDeadEndRequestError(
            'candidates',
            'their ranking positions are inconsistent',
          );
        }
      }

      if (revalidated.length === 0) {
        // Nothing to look up, and asking would be a round trip whose answer
        // could not change this empty list.
        return [];
      }

      const warningsByProblem = await reader.readForCandidates(
        revalidated.map((candidate) => candidate.ranking.problemId),
      );

      const offered: RetrievalMemoryCandidate[] = [];
      for (const candidate of revalidated) {
        const warnings = warningsByProblem.get(candidate.ranking.problemId);
        if (warnings === undefined) {
          // Deleted, switched off, or never this owner's since the previous
          // stage read it — one outcome for all of them, and it is simply
          // gone. Distinct from an empty list, which means the Memory is here
          // and nothing was recorded as a dead end.
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
          deadEndWarnings: warnings,
        });
      }

      return offered;
    },
  };
}

export { MAX_RANKED_CANDIDATES };
