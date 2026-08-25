/**
 * Owner-scoped lexical search over retrieval artifacts.
 *
 * A reader, like the summary source reader and for the same reason: there is
 * one operation and it reads. Searching cannot become a way to write, because
 * there is nothing here to write through.
 *
 * Kept apart from `RetrievalArtifactRepository`, which owns an artifact's
 * lifecycle — writing one and fetching one by identity. "Which Problems are
 * worth looking at?" is a different question from "what is this Problem's
 * artifact?", and the two will diverge further as retrieval grows: the search
 * side is about to gain a vector query, a hybrid merge and a reranking stage,
 * none of which have anything to do with storing an artifact.
 *
 * The owner is fixed when the reader is built and no method takes one, so a
 * caller cannot search somebody else's Memory by passing a different
 * identifier. As everywhere else, the scope is the object.
 */

import { searchArtifactsByText } from '../db/retrieval-full-text-search.js';
import type { DatabaseExecutor } from '../db/executor.js';
import type { OwnerContext, OwnerId } from '../domain/owner.js';
import {
  relaxedLexicalTextOf,
  resolveFullTextSearchQuery,
  type FullTextCandidate,
  type FullTextSearchQuery,
} from '../domain/retrieval-search.js';

/** Which grammar produced a lexical answer: the strict pass, or the fallback. */
export type LexicalSearchMode = 'STRICT' | 'RELAXED';

/** A lexical answer, and which pass produced it. */
export interface LexicalSearchResult {
  readonly candidates: FullTextCandidate[];
  readonly mode: LexicalSearchMode;
}

export interface RetrievalSearchReader {
  /** The owner every search through this reader is scoped to. */
  readonly ownerId: OwnerId;

  /**
   * Candidates whose artifact text matches, best match first.
   *
   * Refuses a blank or oversized query, and a limit outside its bounds, before
   * reaching the database. Returns an empty list when nothing matches, which
   * includes the ordinary case of a Memory that has no artifacts yet.
   */
  searchFullText(query: FullTextSearchQuery): Promise<FullTextCandidate[]>;

  /**
   * The strict search, then — only when it found nothing — one relaxed pass.
   *
   * The strict pass is exactly `searchFullText`, and a strict hit is returned
   * untouched: the fallback never runs beside a result, only instead of an
   * absence. The relaxed pass re-asks the same terms as an alternation,
   * through the same resolver, the same statement and the same safe parser —
   * no second grammar exists. A query the relaxation cannot change (one term,
   * or already an alternation) is not searched twice. `mode` says which pass
   * produced the answer, so what a usage record claims about the search can
   * be true.
   */
  searchFullTextWithFallback(query: FullTextSearchQuery): Promise<LexicalSearchResult>;
}

export function createRetrievalSearchReader(
  executor: DatabaseExecutor,
  context: OwnerContext,
): RetrievalSearchReader {
  const searchFullText = (query: FullTextSearchQuery): Promise<FullTextCandidate[]> =>
    searchArtifactsByText(executor, context, resolveFullTextSearchQuery(query));

  return {
    ownerId: context.ownerId,
    searchFullText,

    async searchFullTextWithFallback(query): Promise<LexicalSearchResult> {
      const strict = await searchFullText(query);
      if (strict.length > 0) {
        return { candidates: strict, mode: 'STRICT' };
      }

      const relaxed = relaxedLexicalTextOf(query.text);
      if (relaxed === undefined) {
        return { candidates: strict, mode: 'STRICT' };
      }

      return {
        candidates: await searchFullText({ ...query, text: relaxed }),
        mode: 'RELAXED',
      };
    },
  };
}
