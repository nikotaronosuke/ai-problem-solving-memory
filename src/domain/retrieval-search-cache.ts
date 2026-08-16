/**
 * What identifies one search, and how long an answer to it stays usable.
 *
 * The specification asks that the same search for the same Problem in the same
 * state not be run repeatedly in a short window. Every word of that is load-
 * bearing, and this file is where "the same" is defined.
 *
 * **The key is a digest, and the inputs are not kept.** A search carries the
 * words somebody typed and a structural description of their own Problem. A
 * query is allowed to contain credential-shaped text — that rule exists so
 * that searching for the Memory about a leaked credential works — and it is
 * allowed precisely because a query is bound, used and gone. A cache is a new
 * place text could stay, so nothing here stores any: the inputs are hashed and
 * the digest is what lives in memory.
 *
 * **Sameness is exact.** The key is built from the values as they were given,
 * with no trimming, folding, sorting or deduplication. Two searches that a
 * person would call equivalent but that differ by a character are different
 * searches here, and that is the safe direction to be wrong in: a missed reuse
 * costs one extra call, while an invented equivalence returns an answer to a
 * question nobody asked. The one normalisation applied is on the limits, and
 * only because "not specified" and "specified as the default" are the same
 * request rather than two similar ones.
 *
 * **State is the canonical source, not a version number.** A Problem's
 * `version` does not move when an Event or a Verification is appended —
 * measured, not assumed — so a key built on it would go on answering with a
 * search made before half the investigation existed. The generation source
 * (P4-02) covers exactly the right ground: the Problem's own semantic fields,
 * its Environment, every Event and every Verification, and none of the
 * controls. Reusing its fingerprint means understanding and trust stay
 * separate here for the same reason they are separate everywhere else.
 */

import { createHash } from 'node:crypto';

import type { OwnerId } from './owner.js';
import type { ProblemId } from './problem.js';
import type { ProjectId } from './project.js';
import type { StructuralRerankResult } from './retrieval-structural-rerank.js';
import { STRUCTURAL_FEATURE_LISTS, type StructuralFeatures } from './retrieval-summary.js';

/**
 * How long a cached search stays usable.
 *
 * Five minutes, and the number is chosen against what the window actually
 * protects. A change in the Problem being worked on already misses, because
 * the fingerprint moves; an edit to a candidate's trust, currency or
 * suppression is already reflected, because ranking re-reads them every time.
 * What is left is the rest of the Memory: a Problem verified in another
 * Project a moment ago, or an artifact just regenerated. Five minutes is long
 * enough to cover the repeated searching of one investigation step and short
 * enough that a Memory written during it surfaces while it is still the same
 * piece of work.
 *
 * Not configurable. A caller able to set it could hold an answer for an hour,
 * and how stale a Memory search may be is not a per-call decision.
 */
export const RETRIEVAL_SEARCH_CACHE_TTL_MS = 300_000;

/**
 * How many searches are remembered at once.
 *
 * A bound rather than a tuning parameter: without one, a long-running process
 * accumulates an entry per distinct search forever. A hundred covers many
 * concurrent investigations at a few hundred bytes each, and the eviction it
 * causes costs one recomputation.
 */
export const RETRIEVAL_SEARCH_CACHE_MAX_ENTRIES = 100;

/** Separates this digest's meaning from every other digest in the system. */
export const RETRIEVAL_SEARCH_CACHE_KEY_PREFIX = 'retrieval-cache-v1';

/**
 * Everything that makes two searches the same search.
 *
 * Note what is absent. There is no current Project: proximity is a ranking
 * input, ranking is never cached, and the Project is derived from the Problem
 * anyway. There is no excluded Problem: the Problem being worked on is always
 * the excluded one, so carrying it twice would let the two disagree.
 */
export interface RetrievalSearchCacheKeyInput {
  readonly ownerId: OwnerId;
  readonly currentProblemId: ProblemId;
  /** P4-02's fingerprint of the Problem's canonical source. */
  readonly understandingFingerprint: string;
  readonly lexicalText: string;
  readonly semanticText: string;
  readonly projectId: ProjectId | null;
  /** After defaults are applied, so an absent limit keys as the default. */
  readonly effectiveHybridLimit: number;
  readonly effectiveRerankLimit: number;
  readonly currentFeatures: StructuralFeatures;
}

/**
 * The digest that identifies a search.
 *
 * A fixed-order array, JSON-encoded, then SHA-256 over its UTF-8 bytes. The
 * array rather than concatenation with a separator, because a separator can
 * always be smuggled in — two fields joined by a colon cannot be told apart
 * from one field containing one — and JSON escapes for us. Fixed order rather
 * than object keys, because an object's key order is a property of how it was
 * built, and a digest must not be.
 *
 * The structural profile is spelled out field by field in schema order for the
 * same reason: its exact key set is fixed (eight keys, six of them lists), so
 * the order can be written down here rather than depending on how the object
 * happened to be constructed. The lists go in as they are — a rerank sees them
 * in that order, so two orderings are two inputs.
 *
 * Returns the digest. The values that went into it are not retained by anyone.
 */
export function computeRetrievalSearchCacheKey(input: RetrievalSearchCacheKeyInput): string {
  const features = input.currentFeatures;
  const canonical = JSON.stringify([
    RETRIEVAL_SEARCH_CACHE_KEY_PREFIX,
    input.ownerId,
    input.currentProblemId,
    input.understandingFingerprint,
    input.lexicalText,
    input.semanticText,
    input.projectId,
    input.effectiveHybridLimit,
    input.effectiveRerankLimit,
    [
      features.schema_version,
      features.problem_domain,
      ...STRUCTURAL_FEATURE_LISTS.map((name) => features[name]),
    ],
  ]);

  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return `${RETRIEVAL_SEARCH_CACHE_KEY_PREFIX}:${digest}`;
}

/**
 * What is remembered about one search.
 *
 * The rerank stage's result and nothing else. Not the query, not the profile,
 * not the summaries or keywords or vectors the candidates were found by — an
 * entry holds identifiers, scores, positions and an outcome.
 *
 * The semantic channel's status is not stored either, and its absence is a
 * consequence rather than an omission: only a search whose semantic half ran
 * normally is ever cached, so a hit's status is known without recording it.
 */
export interface RetrievalSearchCacheEntry {
  readonly result: StructuralRerankResult;
  /** Fixed at the moment the search completed, and never extended. */
  readonly expiresAt: number;
}

/**
 * Rebuilds a rerank result from the ground up.
 *
 * Used in both directions — storing and reading — so a caller holding a result
 * shares no object with the cache. TypeScript's `readonly` is a compile-time
 * courtesy and disappears at run time; a caller that sorted the array it was
 * handed would otherwise reorder what the next caller gets.
 *
 * Written out rather than deep-cloned generically. Five candidates of
 * primitives is a small thing to copy, and a hand-written copy fails to
 * compile when the shape changes, where a generic clone would quietly carry a
 * new field into the cache.
 */
export function copyStructuralRerankResult(result: StructuralRerankResult): StructuralRerankResult {
  return {
    status: result.status,
    candidates: result.candidates.map((candidate) => ({
      problemId: candidate.problemId,
      projectId: candidate.projectId,
      structuralScore: candidate.structuralScore,
      hybridRank: candidate.hybridRank,
      matchedDimensions: [...candidate.matchedDimensions],
    })),
  };
}
