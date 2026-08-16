/**
 * Combining two searches that disagree about what a good score looks like.
 *
 * The lexical search returns a `lexicalScore` where higher is better, on a
 * scale that shifts with the query. The vector search returns a
 * `cosineDistance` where *lower* is better, on [0, 2]. Adding them is
 * meaningless, averaging them is meaningless, and normalising them is a trap:
 * min-max collapses to a constant when a channel returns one candidate or a
 * run of equal scores, and one outlier flattens everything below it — all
 * measured. So the raw scores are read by nobody here. Only the *order* each
 * channel produced is used, and both channels order deterministically.
 *
 * Reciprocal rank fusion does the rest: each channel contributes
 * `1 / (k + rank)` for the candidates it ranked, and the contributions add.
 * A candidate both channels surfaced gets two contributions, which is the
 * whole point of running two searches whose failure modes differ — lexical is
 * exact where semantic is fuzzy, so agreement between them is evidence neither
 * one produces alone.
 *
 * **On `k`.** The constant decides how much agreement is worth against a
 * single channel's confidence, and the published value of 60 is wrong here.
 * It was calibrated for result lists about a thousand deep; against this
 * system's twenty-deep window it flattens the contribution of rank 1 and rank
 * 20 to a ratio of 1.31, which erases almost all of the ordering each channel
 * worked to produce, and it lets a candidate that placed *last* in both
 * channels outrank one that placed *first* in a channel. Measured across the
 * window: k=60 gives 1.31, k=20 gives 1.90, k=10 gives 2.73, k=0 gives 20.
 * At k=10 agreement wins down to about rank 11 — half the window — so two
 * channels agreeing on a mid-ranked candidate beats one channel's best, while
 * two channels agreeing on their worst does not. That is the trade this file
 * is choosing, and it is chosen from the window size rather than from custom.
 *
 * Nothing here judges a Memory. Confidence, freshness, suppression, project
 * proximity and structural similarity are all absent, and they are absent for
 * different later stages. This produces a bounded, deterministic list of
 * Problems worth looking at, and stops.
 */

import type { ProblemId } from './problem.js';
import type { ProjectId } from './project.js';
import type { FullTextCandidate, VectorCandidate } from './retrieval-search.js';

/**
 * The rank-fusion constant.
 *
 * Fixed here and reachable from no request, configuration or provider. A
 * caller able to set it could change what "most relevant" means per call,
 * which would make two searches of the same Memory incomparable and any
 * evaluation of the ranking meaningless. Changing it is a decision this
 * project records, not a parameter.
 */
export const HYBRID_RRF_K = 10;

/**
 * How deep each channel is read, regardless of what the caller asked for.
 *
 * Fixed for a reason that is easy to miss: rank fusion is sensitive to the
 * window. Deriving the source depth from the caller's limit was measured to
 * change the top ten — the same Memory, the same query, a different answer
 * because somebody asked for fewer results. With the depth fixed, a limit of
 * ten returns exactly the first ten of what a limit of twenty returns.
 */
export const HYBRID_SOURCE_LIMIT = 20;

/**
 * What a hybrid search may be asked for.
 *
 * Ten to twenty, and the floor is deliberate. This is the first of the
 * specification's two stages: the database narrows to ten or twenty
 * candidates, and a reranking stage narrows those to a handful. A caller
 * asking this stage for one result would be doing the second stage's job with
 * the first stage's information — no structural comparison, no ranking policy
 * — so the contract does not offer it.
 *
 * Fewer than ten candidates existing is different, and fine: what is found is
 * what is returned, never padded.
 */
export const DEFAULT_HYBRID_LIMIT = 20;
export const MIN_HYBRID_LIMIT = 10;
export const MAX_HYBRID_LIMIT = 20;

/** Raised when a hybrid search cannot be accepted as asked. */
export class InvalidHybridSearchError extends Error {
  readonly field: string;

  constructor(field: string, reason: string) {
    // The field and a fixed reason. Never the query: two searches' worth of
    // caller text passes through here, and an error travels.
    super(`Hybrid search ${field} is unusable: ${reason}.`);
    this.name = 'InvalidHybridSearchError';
    this.field = field;
  }
}

/**
 * Raised when the two channels disagree about a fact they cannot disagree
 * about.
 *
 * Both channels read `problems` through the same join, so one Problem has one
 * Project, and one channel cannot return a Problem twice. If either happens,
 * something upstream is wrong — a mis-composition, or a fake in a test that
 * does not model reality — and quietly picking a winner would let the fusion
 * produce a confident answer built on a contradiction. It carries no
 * identifier: which rows disagreed is a debugging question, and this error
 * travels.
 */
export class HybridCandidateInvariantError extends Error {
  constructor(reason: string) {
    super(`Hybrid candidates are inconsistent: ${reason}.`);
    this.name = 'HybridCandidateInvariantError';
  }
}

/**
 * One candidate, with where it came from.
 *
 * A rank of `null` means the channel did not place this Problem in its window,
 * and that is emphatically **not** a mark against it. It can mean the channel
 * genuinely did not match, or that the candidate fell outside the twenty this
 * channel was read to, or — for the vector channel — that the artifact was
 * embedded by a model that is no longer configured, or that the semantic
 * channel did not run at all. None of those are facts about the Memory, so
 * nothing here penalises an absence; a missing rank simply contributes
 * nothing.
 *
 * The raw scores are deliberately gone. Fusion used the ordering, and carrying
 * a `lexicalScore` and a `cosineDistance` onward would leave two incomparable
 * numbers sitting next to each other in every later stage, which is an
 * invitation to combine them a second time and differently.
 */
export interface HybridCandidate {
  readonly problemId: ProblemId;
  readonly projectId: ProjectId;
  /**
   * The fused rank score: higher is better.
   *
   * Not a probability, not a confidence, and not a promise that the Memory is
   * useful. It says the two searches, between them, put this Problem near the
   * top — which is a reason to look, and the only claim this stage makes.
   */
  readonly fusionScore: number;
  /** 1-based position in the lexical window, or null if it was not in it. */
  readonly lexicalRank: number | null;
  /** 1-based position in the vector window, or null if it was not in it. */
  readonly vectorRank: number | null;
}

function requireDistinct(seen: Set<string>, problemId: ProblemId, channel: string): void {
  if (seen.has(problemId)) {
    throw new HybridCandidateInvariantError(`${channel} returned one Problem twice`);
  }
  seen.add(problemId);
}

/**
 * Fuses two channels' orderings into one bounded, deterministic list.
 *
 * Pure: no database, no network, no provider, no clock. Both inputs are read
 * as *orderings* — position in the array is the rank — because each channel
 * already sorted deterministically and its own score scale is its own
 * business.
 *
 * The ordering out is `fusionScore` descending, then problem id. No extra
 * "candidates found by both first" rule: the formula already gives such a
 * candidate two contributions, and a tie-break repeating that would count the
 * same evidence twice.
 */
export function fuseHybridCandidates(
  lexical: readonly FullTextCandidate[],
  vector: readonly VectorCandidate[],
  limit: number,
): HybridCandidate[] {
  const byProblem = new Map<
    ProblemId,
    { projectId: ProjectId; lexicalRank: number | null; vectorRank: number | null }
  >();

  const place = (
    problemId: ProblemId,
    projectId: ProjectId,
    rank: number,
    channel: 'lexical' | 'vector',
  ): void => {
    const existing = byProblem.get(problemId);
    if (existing === undefined) {
      byProblem.set(problemId, {
        projectId,
        lexicalRank: channel === 'lexical' ? rank : null,
        vectorRank: channel === 'vector' ? rank : null,
      });
      return;
    }
    if (existing.projectId !== projectId) {
      // Both channels join `problems` on the same key, so this cannot happen
      // against a real database. It happening means the inputs are not what
      // they claim to be.
      throw new HybridCandidateInvariantError('one Problem was reported under two Projects');
    }
    byProblem.set(problemId, {
      projectId,
      lexicalRank: channel === 'lexical' ? rank : existing.lexicalRank,
      vectorRank: channel === 'vector' ? rank : existing.vectorRank,
    });
  };

  const lexicalSeen = new Set<string>();
  lexical.forEach((candidate, index) => {
    requireDistinct(lexicalSeen, candidate.problemId, 'the lexical channel');
    place(candidate.problemId, candidate.projectId, index + 1, 'lexical');
  });

  const vectorSeen = new Set<string>();
  vector.forEach((candidate, index) => {
    requireDistinct(vectorSeen, candidate.problemId, 'the vector channel');
    place(candidate.problemId, candidate.projectId, index + 1, 'vector');
  });

  const contribution = (rank: number | null): number =>
    rank === null ? 0 : 1 / (HYBRID_RRF_K + rank);

  return [...byProblem.entries()]
    .map(([problemId, entry]) => ({
      problemId,
      projectId: entry.projectId,
      fusionScore: contribution(entry.lexicalRank) + contribution(entry.vectorRank),
      lexicalRank: entry.lexicalRank,
      vectorRank: entry.vectorRank,
    }))
    .sort(
      (a, b) =>
        b.fusionScore - a.fusionScore ||
        (a.problemId < b.problemId ? -1 : a.problemId > b.problemId ? 1 : 0),
    )
    .slice(0, limit);
}
