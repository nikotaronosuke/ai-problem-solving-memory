/**
 * Semantic search: text in, nearest memories out.
 *
 * The service exists because a semantic query has to *become* a vector before
 * the database can answer it, and everything about that step is policy rather
 * than plumbing:
 *
 * **The caller supplies text, never a vector.** The embedding is produced here,
 * by the same provider instance the artifacts were embedded with, and the
 * provider's own identity — model, version, dimensions — is what the reader
 * filters compatibility on. That closes the loop structurally: a query vector
 * cannot be from the wrong space, because the only place one can come from is
 * the space being searched. An API accepting a raw vector would turn that
 * guarantee into a convention.
 *
 * **A query that holds a credential is not sent anywhere.** This is the line
 * that separates this search from the lexical one, and it is a difference in
 * *where the text goes*, not a change of mind about queries. A lexical query
 * is a bound parameter that lives and dies inside the database this system
 * already trusts with the Memory itself. A semantic query is transmitted to an
 * embedding provider — under a concrete deployment, to somebody else's
 * computer. So the same detector that guards stored Memory inspects the query,
 * and a confirmed credential means the provider is never called: not refused
 * loudly with an exception, but answered with a typed outcome, because the
 * caller that matters next is the hybrid stage, and "run the lexical half
 * only" is an ordinary degradation rather than a failure to handle. Redacting
 * and embedding anyway was rejected — a redacted query is a different
 * question, and answering a question the caller did not ask is worse than
 * declining this half of it.
 *
 * **What comes back from the provider is not believed until checked.** The
 * same validation the artifact pipeline uses reads the output — exact
 * dimensions, finite, not all zero — so nothing malformed reaches the
 * statement. A zero query vector matters specifically: its cosine distance is
 * not a number, and one bad query would otherwise poison every comparison it
 * appears in.
 *
 * No transaction anywhere: the provider call holds no connection, and the
 * search is one statement reading one snapshot. And nothing here writes — not
 * an artifact, not a regeneration for a model mismatch, not a usage record. A
 * search that wrote would be a read with side effects at the moment somebody
 * is waiting for an answer.
 */

import type { ProblemId } from '../domain/problem.js';
import type { ProjectId } from '../domain/project.js';
import {
  EmbeddingGenerationFailedError,
  requireEmbeddingProviderIdentity,
  toProviderEmbedding,
  type EmbeddingProvider,
} from '../domain/retrieval-embedding.js';
import { resolveVectorSearchQuery, type VectorCandidate } from '../domain/retrieval-search.js';
import type { RetrievalVectorSearchReader } from '../repository/index.js';
import { createSemanticQueryInspectionPolicy } from '../sanitization/index.js';

/** What a caller may ask: text and the shared filters. Never a vector. */
export interface VectorSearchRequest {
  readonly text: string;
  readonly projectId?: ProjectId;
  readonly excludeProblemId?: ProblemId;
  readonly limit?: number;
}

/**
 * What happened.
 *
 * `SENSITIVE_QUERY_NOT_EMBEDDED` carries nothing — not the query, not a
 * category, not a reason. The caller knows what it asked; anything this
 * outcome repeated would be a copy of a credential-bearing string travelling
 * onward, which is the exact thing the outcome exists to prevent. An empty
 * candidate list is not this: finding nothing is `CANDIDATES` with none.
 *
 * A provider outage is deliberately NOT a variant here. Declining to transmit
 * a credential is this service's own policy, decided on its own information;
 * an outage is an infrastructure failure, and how to degrade — retry, skip
 * the semantic half, surface it — is the caller's decision, reached through
 * the thrown `EmbeddingGenerationFailedError`.
 */
export type VectorSearchOutcome =
  | { readonly kind: 'CANDIDATES'; readonly candidates: readonly VectorCandidate[] }
  | { readonly kind: 'SENSITIVE_QUERY_NOT_EMBEDDED' };

export interface RetrievalVectorSearchService {
  /** Semantic candidates for the query, nearest first. Writes nothing. */
  search(request: VectorSearchRequest): Promise<VectorSearchOutcome>;
}

/**
 * Where a query inspection reports from: the operation and the argument
 * position, the same shape every other inspection site uses. No caller text
 * appears in it.
 */
const QUERY_INSPECTION_SITE = {
  path: [
    { kind: 'operation', name: 'searchVector' },
    { kind: 'argument', index: 0 },
  ],
  kind: 'value',
} as const;

/**
 * Builds the service.
 *
 * Two dependencies, and the absence of a third is the point. The provider must
 * be the same one artifacts are generated with — same instance, same
 * configuration — which composition owns; this service simply uses whatever
 * space the provider it was handed declares.
 *
 * The query policy is **not** a parameter. It was one, defaulted to the safe
 * policy, and that was wrong: a default only decides what happens when nobody
 * chooses, and a caller passing a policy that keeps everything would have
 * turned the rule that a credential is never transmitted into a suggestion.
 * "Safe unless overridden" is not a security boundary — the boundary is that
 * there is nothing to override. So the policy is constructed here, where no
 * caller can reach it.
 *
 * It is still built by the sanitization module rather than assembled from a
 * detector, so what a credential looks like stays inside that boundary; what
 * changed is only who may choose the policy, which is nobody.
 */
export function createRetrievalVectorSearchService(
  embeddingProvider: EmbeddingProvider,
  reader: RetrievalVectorSearchReader,
): RetrievalVectorSearchService {
  requireEmbeddingProviderIdentity(embeddingProvider);
  const queryPolicy = createSemanticQueryInspectionPolicy();

  return {
    async search(request): Promise<VectorSearchOutcome> {
      const query = resolveVectorSearchQuery(request);

      // Before the provider, which is the only place "before" means anything:
      // a check after the call would decline to use an answer the credential
      // already paid for. The certainty line is the one the whole system
      // draws — confirmed refuses, suspected and status prose pass — so "the
      // token expired during deployment" is still searchable.
      if (queryPolicy.inspect(query.text, QUERY_INSPECTION_SITE).kind === 'reject') {
        return { kind: 'SENSITIVE_QUERY_NOT_EMBEDDED' };
      }

      let embedded: unknown;
      try {
        embedded = await embeddingProvider.embed({ text: query.text });
      } catch {
        throw new EmbeddingGenerationFailedError();
      }

      // The artifact pipeline's own output validation, reused: exact declared
      // dimensions, all finite, not all zero. Nothing invalid reaches the
      // statement, and in particular no zero vector, whose cosine distance
      // would not be a number.
      const embedding = toProviderEmbedding(embedded, embeddingProvider);

      const candidates = await reader.searchByVector(
        {
          embedding,
          embeddingModel: embeddingProvider.modelId,
          embeddingModelVersion: embeddingProvider.modelVersion,
          dimensions: embeddingProvider.dimensions,
        },
        query,
      );

      return { kind: 'CANDIDATES', candidates };
    },
  };
}
