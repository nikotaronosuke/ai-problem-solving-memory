/**
 * The seam between a route and the search pipeline behind it.
 *
 * A search needs eleven owner-scoped stages built over a connection pool, plus
 * whichever semantic and structural provider ports this deployment has. None
 * of that is transport's business: a route that assembled it would be a route
 * holding a pool, and the layering that has kept `src/http/` free of the
 * driver since Phase 2 would end at the one endpoint with the most machinery
 * behind it.
 *
 * So the route asks for a service and receives one. What it passes is the
 * authenticated context — which is how owner scope travels in this codebase,
 * carrying repositories rather than an owner id — and a reporter for the one
 * failure the pipeline can suffer without failing the search.
 *
 * The service is resolved per request, deliberately. The usage-log writer
 * inside it records under *this* request's context, and a shared instance
 * would either record under whichever request built it first or need the
 * context threaded through every call. What is shared instead is what should
 * be: the pool, the provider ports, and the process-lifetime rerank cache.
 */

import type { AuthenticatedRequestContext } from './request-context.js';
import type { RetrievalSearchService } from './retrieval-search-service.js';
import type { RetrievalUsageLogFailureReporter } from './retrieval-usage-log-writer.js';

export interface RetrievalSearchServiceResolver {
  /**
   * Builds the search pipeline for one request.
   *
   * Owner scope comes from `context` and from nowhere else. An implementation
   * must resolve the owner through the same gate every other owner resolution
   * uses rather than asserting one, and must not keep the context after the
   * service it returns is finished with.
   */
  resolve(
    context: AuthenticatedRequestContext,
    failureReporter: RetrievalUsageLogFailureReporter,
  ): Promise<RetrievalSearchService>;
}
