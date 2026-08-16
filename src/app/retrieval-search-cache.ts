/**
 * A bounded, short-lived memory of searches already run.
 *
 * A `Map` and a clock. No table, no external store, no dependency — and that
 * is a decision rather than a shortcut. What this holds is an optimisation
 * with a five-minute life: losing it costs one recomputation, and it is never
 * the reason an answer is right. A persistent store would have to arrive with
 * a delete path, an export exclusion and a place in the deletion guarantees,
 * all so that something disposable could survive a restart it does not need to
 * survive.
 *
 * One instance is shared by every owner in a process, which is why the owner
 * is inside the key rather than around the cache: a per-owner cache would have
 * to be created somewhere, and the natural somewhere is the per-request scope,
 * where it would be empty every time.
 *
 * The clock is injected. A cache is one of the few things whose behaviour is
 * *about* time, and a test that has to sleep to observe an expiry is a test
 * that is slow and occasionally wrong.
 */

import {
  copyStructuralRerankResult,
  RETRIEVAL_SEARCH_CACHE_MAX_ENTRIES,
  RETRIEVAL_SEARCH_CACHE_TTL_MS,
  type RetrievalSearchCacheEntry,
} from '../domain/retrieval-search-cache.js';
import type { StructuralRerankResult } from '../domain/retrieval-structural-rerank.js';

/** Milliseconds since the epoch. */
export type Clock = () => number;

export interface RetrievalSearchCache {
  /**
   * The result stored under this key, if one is still usable.
   *
   * A copy, so nothing a caller does to it reaches the entry. An expired entry
   * is removed and reported as absent — it is never returned once.
   */
  get(key: string): StructuralRerankResult | undefined;

  /**
   * Remembers a result for the next five minutes.
   *
   * A copy again, so nothing the caller does afterwards reaches the entry. The
   * lifetime starts now and is not extended by later reads.
   */
  set(key: string, result: StructuralRerankResult): void;
}

/**
 * Builds the cache.
 *
 * Recency is the `Map`'s own insertion order: deleting a key and setting it
 * again moves it to the end, so the first entry the iterator yields is the
 * least recently used one. That is a documented property of `Map`, it costs
 * nothing, and it means eviction needs no list, no counters and no package.
 */
export function createRetrievalSearchCache(clock: Clock = () => Date.now()): RetrievalSearchCache {
  const entries = new Map<string, RetrievalSearchCacheEntry>();

  return {
    get(key): StructuralRerankResult | undefined {
      const entry = entries.get(key);
      if (entry === undefined) {
        return undefined;
      }

      if (clock() >= entry.expiresAt) {
        // Gone rather than stale: an expired answer is never handed out, not
        // even the once that would let a caller decide for itself.
        entries.delete(key);
        return undefined;
      }

      // Recency only. The expiry stays where it was set — a search repeated
      // every four minutes would otherwise be answered from a cache that
      // never refreshes, which is the opposite of a short-lived one.
      entries.delete(key);
      entries.set(key, entry);

      return copyStructuralRerankResult(entry.result);
    },

    set(key, result): void {
      // Delete first so a replacement counts as recent rather than keeping the
      // position the old value had.
      entries.delete(key);
      entries.set(key, {
        result: copyStructuralRerankResult(result),
        expiresAt: clock() + RETRIEVAL_SEARCH_CACHE_TTL_MS,
      });

      while (entries.size > RETRIEVAL_SEARCH_CACHE_MAX_ENTRIES) {
        const oldest = entries.keys().next();
        if (oldest.done === true) {
          break;
        }
        entries.delete(oldest.value);
      }
    },
  };
}

export { RETRIEVAL_SEARCH_CACHE_MAX_ENTRIES, RETRIEVAL_SEARCH_CACHE_TTL_MS };
