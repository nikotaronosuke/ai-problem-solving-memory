/**
 * One search intent, two channels, one bounded list of Problems to look at.
 *
 * This is the first of the specification's two retrieval stages: the database
 * narrows to ten or twenty candidates, and a later stage compares them
 * structurally and narrows to a handful. What this file owns is running both
 * channels safely and handing the fusion clean orderings; the fusion itself is
 * a pure function that knows nothing about databases or providers.
 *
 * Four decisions carry the weight here.
 *
 * **Two texts, because the channels are not the same question.** A lexical
 * query is a handful of terms joined with AND and bounded at a thousand
 * characters; a semantic query is a description — canonically a whole
 * normalized summary — bounded at four thousand. Forcing one string through
 * both would make any query over a thousand characters fail outright, and
 * deriving one from the other would mean inventing keyword extraction here,
 * which is a retrieval policy nobody has asked this stage to own. So the
 * caller supplies both, and this stage does no rewriting of either: no
 * extraction, no summarising, no truncation, no stop words.
 *
 * **Everything is validated before anything runs.** Both texts and every
 * filter are checked first, so a malformed request cannot reach an embedding
 * provider — which under a concrete deployment is a network call to somebody
 * else's computer, made on behalf of a request that was never going to
 * succeed.
 *
 * **The two channels must belong to the same owner, structurally.** Each
 * channel is owner-safe on its own; neither can check the other. A composition
 * that paired one owner's lexical reader with another owner's vector service
 * would produce a result mixing two people's Memory, with both halves behaving
 * correctly. So the owners are compared once, at construction, and a mismatch
 * refuses to build.
 *
 * **Only one kind of failure degrades.** The specification says a Memory
 * failure must not stop ordinary work, and an embedding provider being
 * unreachable is exactly that: the semantic half is skipped, the lexical half
 * answers, and the result says so. Everything else — a provider returning
 * something malformed, a database error, a broken invariant — is raised.
 * Degrading on those would hide a broken provider or a broken database behind
 * results that look fine, which is the failure mode that takes longest to
 * notice.
 */

import type { OwnerId } from '../domain/owner.js';
import type { ProblemId } from '../domain/problem.js';
import type { ProjectId } from '../domain/project.js';
import { EmbeddingGenerationFailedError } from '../domain/retrieval-embedding.js';
import {
  DEFAULT_HYBRID_LIMIT,
  fuseHybridCandidates,
  HYBRID_SOURCE_LIMIT,
  InvalidHybridSearchError,
  MAX_HYBRID_LIMIT,
  MIN_HYBRID_LIMIT,
  type HybridCandidate,
} from '../domain/retrieval-hybrid-search.js';
import {
  resolveFullTextSearchQuery,
  resolveVectorSearchQuery,
  type FullTextCandidate,
  type VectorCandidate,
} from '../domain/retrieval-search.js';
import type { RetrievalSearchReader } from '../repository/index.js';
import type { RetrievalVectorSearchService } from './retrieval-vector-search-service.js';

/**
 * What a caller asks for.
 *
 * The filters appear once and apply to both channels. Per-channel filters are
 * deliberately impossible: they would let one channel search a Project the
 * other could not, and a fused list assembled from two different questions is
 * not an answer to either.
 */
export interface HybridSearchRequest {
  /** Terms for the lexical channel. Bounded at the lexical maximum. */
  readonly lexicalText: string;
  /** A description for the semantic channel. Bounded at the semantic maximum. */
  readonly semanticText: string;
  readonly projectId?: ProjectId;
  readonly excludeProblemId?: ProblemId;
  readonly limit?: number;
}

/**
 * Whether the semantic half contributed, and if not, why in the broadest
 * possible terms.
 *
 * Three values, and none of them carries detail. `SKIPPED_SENSITIVE_QUERY`
 * says a credential was recognised in the semantic text and the provider was
 * therefore not called; it does not say which value, which category, or what
 * the query was — repeating any of that would move a credential onward, which
 * is the thing the skip exists to prevent. `PROVIDER_UNAVAILABLE` says the
 * provider did not answer; it carries nothing the provider said.
 *
 * There is no lexical status. The lexical channel either succeeds or the whole
 * search fails, so a status could only ever read `USED`.
 */
export type SemanticChannelStatus = 'USED' | 'SKIPPED_SENSITIVE_QUERY' | 'PROVIDER_UNAVAILABLE';

export interface HybridSearchResult {
  readonly candidates: readonly HybridCandidate[];
  readonly semanticStatus: SemanticChannelStatus;
}

export interface RetrievalHybridSearchService {
  /** The owner both channels are scoped to. */
  readonly ownerId: OwnerId;

  /**
   * Candidates for one search intent, best first. Writes nothing.
   *
   * `USED` with an empty list means both channels ran and nothing matched —
   * a real answer, and a different one from a channel being unavailable.
   */
  search(request: HybridSearchRequest): Promise<HybridSearchResult>;
}

/**
 * The limit this stage will actually use.
 *
 * Exported because a caller composing the stages needs the *effective* value
 * rather than the one that was typed: asking for twenty and not asking at all
 * are the same search, and anything keyed on the request has to see them as
 * the same search too. Pure, and unchanged in behaviour from when it was
 * private to this file.
 */
export function resolveHybridSearchLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_HYBRID_LIMIT;
  }
  if (!Number.isInteger(limit)) {
    throw new InvalidHybridSearchError('limit', 'it is not a whole number');
  }
  if (limit < MIN_HYBRID_LIMIT || limit > MAX_HYBRID_LIMIT) {
    // The floor is the point of the stage, not a safety margin: this is the
    // wide net a reranker narrows, and a caller asking it for one result would
    // be taking the reranker's decision with none of the reranker's evidence.
    throw new InvalidHybridSearchError(
      'limit',
      `it is outside ${String(MIN_HYBRID_LIMIT)} to ${String(MAX_HYBRID_LIMIT)}`,
    );
  }
  return limit;
}

/**
 * Builds the service.
 *
 * The owner check happens here, once, rather than on every search: the two
 * channels are fixed at construction, so a mismatch is a fact about this
 * object rather than about a request, and a wrongly-built service should not
 * exist rather than fail later on somebody's query.
 *
 * The message names no identifier. A refusal that printed the two owner ids
 * would put them wherever the error goes.
 */
export function createRetrievalHybridSearchService(
  lexicalReader: RetrievalSearchReader,
  vectorService: RetrievalVectorSearchService,
): RetrievalHybridSearchService {
  if (lexicalReader.ownerId !== vectorService.ownerId) {
    throw new Error('Hybrid search channels must belong to the same owner.');
  }
  const ownerId = lexicalReader.ownerId;

  return {
    ownerId,

    async search(request): Promise<HybridSearchResult> {
      // One set of filters, applied identically to both channels. Written
      // once so the two searches cannot drift into asking different questions.
      const filters = {
        ...(request.projectId === undefined ? {} : { projectId: request.projectId }),
        ...(request.excludeProblemId === undefined
          ? {}
          : { excludeProblemId: request.excludeProblemId }),
        // The caller's limit governs the final list, never how deep each
        // channel is read: rank fusion is sensitive to the window, and letting
        // it vary would make the same query answer differently depending on
        // how many results somebody wanted.
        limit: HYBRID_SOURCE_LIMIT,
      };
      const lexicalQuery = { text: request.lexicalText, ...filters };
      const semanticQuery = { text: request.semanticText, ...filters };

      // All of it, before either channel starts, through each channel's own
      // resolver — so both are bounded and validated exactly as they are when
      // run alone, and an invalid request reaches neither the database nor a
      // provider. The channels resolve again internally; resolution is pure
      // and idempotent, and doing it here is what makes the ordering a
      // guarantee rather than a coincidence of who happens to run first.
      resolveFullTextSearchQuery(lexicalQuery);
      resolveVectorSearchQuery(semanticQuery);
      const limit = resolveHybridSearchLimit(request.limit);

      // Parallel, because the semantic channel is dominated by a provider
      // round trip and the lexical channel is a single statement. Neither
      // holds a transaction, so there is no connection pinned across the wait.
      const [lexicalSettled, semanticSettled] = await Promise.allSettled([
        lexicalReader.searchFullText(lexicalQuery),
        vectorService.search(semanticQuery),
      ]);

      // The lexical channel first, and unconditionally: it has no degraded
      // form. A lexical failure returned as a semantic-only result would be a
      // database problem dressed up as a search.
      if (lexicalSettled.status === 'rejected') {
        throw lexicalSettled.reason instanceof Error
          ? lexicalSettled.reason
          : new Error('The lexical search failed.');
      }
      const lexicalCandidates: readonly FullTextCandidate[] = lexicalSettled.value;

      let vectorCandidates: readonly VectorCandidate[] = [];
      let semanticStatus: SemanticChannelStatus = 'USED';

      if (semanticSettled.status === 'rejected') {
        // Exactly one class degrades. A provider that cannot be reached is the
        // failure the specification says must not stop ordinary work; a
        // provider returning something malformed, a database error and a
        // broken invariant are all still raised, because hiding them behind a
        // plausible-looking result is how a broken component survives.
        if (semanticSettled.reason instanceof EmbeddingGenerationFailedError) {
          semanticStatus = 'PROVIDER_UNAVAILABLE';
        } else {
          throw semanticSettled.reason instanceof Error
            ? semanticSettled.reason
            : new Error('The semantic search failed.');
        }
      } else if (semanticSettled.value.kind === 'SENSITIVE_QUERY_NOT_EMBEDDED') {
        // The credential never left the process, and the lexical half still
        // ran — which is the whole reason that outcome is typed rather than
        // thrown.
        semanticStatus = 'SKIPPED_SENSITIVE_QUERY';
      } else {
        vectorCandidates = semanticSettled.value.candidates;
      }

      return {
        candidates: fuseHybridCandidates(lexicalCandidates, vectorCandidates, limit),
        semanticStatus,
      };
    },
  };
}
