/**
 * The production search composition: eleven stages, one owner, per request.
 *
 * ## What it shares and what it does not
 *
 * Shared for the life of the process: the pool, the configured provider ports,
 * and **one rerank cache**. The cache has the owner inside its key by design,
 * so a single instance serves everybody without leaking between them — and a
 * per-request cache would be empty on arrival every time, which is the one
 * thing a five-minute cache must not be.
 *
 * Built per request: the owner-scoped readers, the eight stage services, and
 * the usage-log writer. The writer is why: it records under the context that
 * authenticated *this* request, and a shared writer would either record under
 * whichever request built it or need the context passed to every call.
 *
 * Nothing here is retained after `resolve` returns. There is no per-owner cache
 * of search services — that belongs to the maintenance runtime, whose work is
 * background and long-lived; a search is a request, and a request's context is
 * not something to keep.
 *
 * ## Vendor-neutral, like everything above the provider boundary
 *
 * The ports arrive already anonymous. This module names no vendor, holds no
 * credential, reaches no network and could not tell one provider from another
 * — the tests exploit exactly that, and a guard asserts it.
 *
 * ## Both ports are optional
 *
 * A server with no configured retrieval stack still answers searches: the
 * lexical channel is unaffected, the semantic channel degrades to
 * `PROVIDER_UNAVAILABLE`, and the structural stage to `RERANKER_UNAVAILABLE`.
 * The optionality lives in the two stage services rather than here, so this
 * module passes what it has and the degradation is one contract rather than
 * two. No stand-in provider is constructed: production should not contain an
 * object whose only purpose is to fail.
 */

import { createRetrievalConflictService } from '../app/retrieval-conflict-service.js';
import { createRetrievalDeadEndService } from '../app/retrieval-dead-end-service.js';
import { createRetrievalHybridSearchService } from '../app/retrieval-hybrid-search-service.js';
import { createRetrievalRankingService } from '../app/retrieval-ranking-service.js';
import { createRetrievalRevalidationService } from '../app/retrieval-revalidation-service.js';
import type { RetrievalSearchCache } from '../app/retrieval-search-cache.js';
import { createRetrievalSearchCache } from '../app/retrieval-search-cache.js';
import type { RetrievalSearchServiceResolver } from '../app/retrieval-search-resolver.js';
import {
  createRetrievalSearchService,
  type RetrievalSearchService,
} from '../app/retrieval-search-service.js';
import { createRetrievalStructuralRerankService } from '../app/retrieval-structural-rerank-service.js';
import { createRetrievalSuccessfulDirectionService } from '../app/retrieval-successful-direction-service.js';
import { createRetrievalUsageLogWriter } from '../app/retrieval-usage-log-writer.js';
import { createRetrievalVectorSearchService } from '../app/retrieval-vector-search-service.js';
import type { AuthenticatedRequestContext } from '../app/request-context.js';
import type { RetrievalUsageLogFailureReporter } from '../app/retrieval-usage-log-writer.js';
import type { DatabasePool } from '../db/pool.js';
import type { EmbeddingProvider } from '../domain/retrieval-embedding.js';
import type { StructuralReranker } from '../domain/retrieval-structural-rerank.js';
import { resolveOwnerContextFor } from '../owner/context.js';
import {
  createRetrievalConflictReader,
  createRetrievalDeadEndReader,
  createRetrievalRankingReader,
  createRetrievalRevalidationReader,
  createRetrievalSearchReader,
  createRetrievalStructuralReader,
  createRetrievalSuccessfulDirectionReader,
  createRetrievalSummarySourceReader,
  createRetrievalVectorSearchReader,
} from '../repository/index.js';

export interface RetrievalSearchRuntimeDependencies {
  readonly pool: DatabasePool;
  /**
   * The semantic port, when this deployment has one. Absent is ordinary and
   * degrades the semantic channel rather than the search.
   */
  readonly embeddingProvider?: EmbeddingProvider | undefined;
  /** The structural port, when this deployment has one. Absent degrades too. */
  readonly structuralReranker?: StructuralReranker | undefined;
  /**
   * The shared rerank cache. Defaulted here so a composition cannot forget
   * one and quietly get a per-request cache; a test may pass its own.
   */
  readonly cache?: RetrievalSearchCache;
}

/**
 * Builds the resolver.
 *
 * The cache is created once, right here, and closed over — the one piece of
 * state in the whole module.
 */
export function createRetrievalSearchRuntime(
  dependencies: RetrievalSearchRuntimeDependencies,
): RetrievalSearchServiceResolver {
  const { pool, embeddingProvider, structuralReranker } = dependencies;
  const cache = dependencies.cache ?? createRetrievalSearchCache();

  return {
    async resolve(
      context: AuthenticatedRequestContext,
      failureReporter: RetrievalUsageLogFailureReporter,
    ): Promise<RetrievalSearchService> {
      // The owner comes from the context's own owner-scoped repositories,
      // which authentication established — never from a body, header or
      // query. The two are cross-checked because they are two objects that
      // should agree; if they ever did not, one of them would be somebody
      // else's and the composition below would mix two owners' Memory into
      // one result.
      const trustedOwnerId = context.repository.ownerId;
      if (context.retrievalArtifacts.ownerId !== trustedOwnerId) {
        throw new Error('A request context carries two owners.');
      }

      // Through the same gate as every other owner resolution, never a cast:
      // an `OwnerContext` asserted into existence is an owner nobody checked
      // is still there.
      const ownerContext = await resolveOwnerContextFor(pool, trustedOwnerId);

      const hybridService = createRetrievalHybridSearchService(
        createRetrievalSearchReader(pool, ownerContext),
        createRetrievalVectorSearchService(
          embeddingProvider,
          createRetrievalVectorSearchReader(pool, ownerContext),
        ),
      );

      return createRetrievalSearchService(
        createRetrievalSummarySourceReader(pool, ownerContext),
        hybridService,
        createRetrievalStructuralRerankService(
          createRetrievalStructuralReader(pool, ownerContext),
          structuralReranker,
        ),
        createRetrievalRankingService(createRetrievalRankingReader(pool, ownerContext)),
        createRetrievalRevalidationService(createRetrievalRevalidationReader(pool, ownerContext)),
        createRetrievalDeadEndService(createRetrievalDeadEndReader(pool, ownerContext)),
        createRetrievalSuccessfulDirectionService(
          createRetrievalSuccessfulDirectionReader(pool, ownerContext),
        ),
        createRetrievalConflictService(createRetrievalConflictReader(pool, ownerContext)),
        cache,
        // The writer takes the request context directly: what it records is
        // that *this* client, on behalf of this owner, surfaced these
        // Memories.
        createRetrievalUsageLogWriter(context),
        failureReporter,
      );
    },
  };
}
