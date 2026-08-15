/**
 * Owner-scoped semantic search over retrieval artifacts.
 *
 * A reader, like the lexical search reader and for the same reason: one
 * operation, and it reads. It takes a *validated* embedding and the identity
 * of the space it lives in — it does not know the provider, the network, or
 * how the vector came to exist. Producing the vector is the service's job
 * above; this layer's job is one statement, owner-scoped by construction.
 *
 * The embedding parameter here is not a way around the text-only service
 * contract: this reader is a storage boundary handed its inputs by the
 * service, not an application surface. What a caller of the *application* can
 * supply is text.
 */

import type { DatabaseExecutor } from '../db/executor.js';
import {
  searchArtifactsByVector,
  type VectorSearchParameters,
} from '../db/retrieval-vector-search.js';
import type { OwnerContext, OwnerId } from '../domain/owner.js';
import type { ResolvedVectorSearchQuery, VectorCandidate } from '../domain/retrieval-search.js';

export interface RetrievalVectorSearchReader {
  /** The owner every search through this reader is scoped to. */
  readonly ownerId: OwnerId;

  /**
   * The nearest compatible artifacts, closest first.
   *
   * Compatible means the exact model, model version and measured dimensions
   * in `parameters` — rows from any other space are filtered out before any
   * distance is computed, so they neither error nor occupy the limit.
   */
  searchByVector(
    parameters: VectorSearchParameters,
    query: ResolvedVectorSearchQuery,
  ): Promise<VectorCandidate[]>;
}

export function createRetrievalVectorSearchReader(
  executor: DatabaseExecutor,
  context: OwnerContext,
): RetrievalVectorSearchReader {
  return {
    ownerId: context.ownerId,
    searchByVector: (parameters, query) =>
      searchArtifactsByVector(executor, context, parameters, query),
  };
}
