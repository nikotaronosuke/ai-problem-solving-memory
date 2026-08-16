/**
 * Turning ranked Memories into Memories somebody can safely act on.
 *
 * The ranking stage decided which Memories to offer and in what order. This
 * one attaches what each was recorded under — the conditions at the time, the
 * checks that were done — and the fixed list of things to re-establish before
 * relying on any of it.
 *
 * Three things it is careful about:
 *
 * **It never decides whether a Memory is still true.** No comparison against
 * anything current, because nothing current is available here and asking for
 * it would put the judgement in the wrong place. See the domain module.
 *
 * **A Memory that has since gone is dropped, not returned hollow.** Ranking
 * read the Problems a moment ago and then time passed. One deleted, switched
 * off, or never this owner's simply is not in the answer — and the four cases
 * are indistinguishable, so a search cannot be used to learn that somebody
 * else's Problem exists. What is not done is returning it with an empty
 * context, which would offer a Memory while implying it had no conditions.
 *
 * **The positions are renumbered and the provenance is not.** `rankingRank`
 * is where a candidate sits in the list actually offered, so when one drops
 * out the rest close up. `hybridRank` records where the first retrieval stage
 * put it and keeps its gaps, because that is a different fact — and the two
 * being different facts is why both exist.
 */

import type { OwnerId } from '../domain/owner.js';
import { MAX_RANKED_CANDIDATES, type RankedMemoryCandidate } from '../domain/retrieval-ranking.js';
import {
  REVALIDATION_CHECKS,
  type RetrievalMemoryCandidate,
} from '../domain/retrieval-revalidation.js';
import type { RetrievalRevalidationReader } from '../repository/index.js';

/** Raised when a set of ranked candidates cannot be enriched as given. */
export class InvalidRevalidationRequestError extends Error {
  readonly field: string;

  constructor(field: string, reason: string) {
    // A field and a fixed reason. Never an identifier: this error travels.
    super(`Retrieval revalidation ${field} is unusable: ${reason}.`);
    this.name = 'InvalidRevalidationRequestError';
    this.field = field;
  }
}

/**
 * Raised when a readable Problem has no Environment.
 *
 * `problems.environment_id` is not null and is a foreign key, so this cannot
 * happen — which is exactly why it is raised rather than treated as a Memory
 * that vanished. Reporting it as a race would hide a broken database behind an
 * ordinary-looking short result, and short results are ordinary here.
 *
 * Names nothing. Every identifier it could carry belongs to somebody's Memory.
 */
export class MissingHistoricalEnvironmentError extends Error {
  constructor() {
    super('A readable Problem has no historical Environment.');
    this.name = 'MissingHistoricalEnvironmentError';
  }
}

export interface RetrievalRevalidationService {
  /** The owner every read through this service is scoped to. */
  readonly ownerId: OwnerId;

  /**
   * Attaches historical context to each candidate still worth offering.
   *
   * Returns them in the order given, with any that have become unreadable
   * removed and the remaining positions closed up. Writes nothing.
   */
  enrich(
    candidates: readonly RankedMemoryCandidate[],
  ): Promise<readonly RetrievalMemoryCandidate[]>;
}

export function createRetrievalRevalidationService(
  reader: RetrievalRevalidationReader,
): RetrievalRevalidationService {
  return {
    ownerId: reader.ownerId,

    async enrich(candidates): Promise<readonly RetrievalMemoryCandidate[]> {
      // The type says these came from the ranking stage. This function is
      // exported, so that is a claim rather than a fact, and the checks are
      // the cheap ones that keep a malformed list from reaching a query.
      if (!Array.isArray(candidates)) {
        throw new InvalidRevalidationRequestError('candidates', 'they are not a list');
      }
      // Held under its declared type: `Array.isArray` widens a readonly array
      // to `any[]`, and every field below is read from it.
      const ranked: readonly RankedMemoryCandidate[] = candidates;

      if (ranked.length > MAX_RANKED_CANDIDATES) {
        throw new InvalidRevalidationRequestError(
          'candidates',
          `there are more than ${String(MAX_RANKED_CANDIDATES)} of them`,
        );
      }

      const seen = new Set<string>();
      for (const candidate of ranked) {
        if (seen.has(candidate.problemId)) {
          throw new InvalidRevalidationRequestError('candidates', 'one Problem appears twice');
        }
        seen.add(candidate.problemId);
      }

      if (ranked.length === 0) {
        // Nothing to look up, and asking would be a round trip whose answer
        // could not change this empty list.
        return [];
      }

      const context = await reader.readForCandidates(
        ranked.map((candidate) => candidate.problemId),
      );

      const offered: RetrievalMemoryCandidate[] = [];
      for (const candidate of ranked) {
        const found = context.get(candidate.problemId);
        if (found === undefined) {
          // Deleted, switched off, or never this owner's — one outcome for all
          // of them, and it is simply gone.
          continue;
        }
        if (found.historicalEnvironment === undefined) {
          throw new MissingHistoricalEnvironmentError();
        }

        offered.push({
          // Rebuilt rather than passed through: the position changes when
          // something ahead of it drops, and the caller's array must not be
          // edited to say so. The dimensions are copied for the same reason —
          // `readonly` is gone at run time, and two callers holding the same
          // array is one caller away from a surprise.
          ranking: {
            ...candidate,
            rankingRank: offered.length + 1,
            matchedDimensions: [...candidate.matchedDimensions],
          },
          revalidation: {
            historicalEnvironment: found.historicalEnvironment,
            evidence: found.evidence,
            // The same four for every candidate, from the same frozen array.
            // Nothing about the Memory — how current it is, how trusted, how
            // close to hand — makes any of them unnecessary.
            requiredChecks: REVALIDATION_CHECKS,
          },
        });
      }

      return offered;
    },
  };
}

export { MAX_RANKED_CANDIDATES };
