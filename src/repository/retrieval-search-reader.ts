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
  resolveFullTextSearchQuery,
  type FullTextCandidate,
  type FullTextSearchQuery,
} from '../domain/retrieval-search.js';

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
}

export function createRetrievalSearchReader(
  executor: DatabaseExecutor,
  context: OwnerContext,
): RetrievalSearchReader {
  return {
    ownerId: context.ownerId,
    searchFullText: (query) =>
      searchArtifactsByText(executor, context, resolveFullTextSearchQuery(query)),
  };
}
