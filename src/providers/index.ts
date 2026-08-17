/**
 * The provider composition boundary: where a vendor becomes a stack.
 *
 * This is the one file that knows both sides. Inward, it knows which vendor
 * family exists and how its pieces fit — one credential, one transport,
 * three adapters sharing it. Outward, it speaks only the vendor-neutral
 * ports: the composition root learns whether a retrieval stack exists and
 * receives the ports and the profile, never a vendor name, never a model
 * name, and never the credential — which flows into the transport and is not
 * readable off anything returned here.
 *
 * Disabled is the ordinary answer, not a failure. A server without the
 * credential is a Memory Server exactly as it always was: recording,
 * reading, everything except rendering artifacts. Nothing vendor-shaped is
 * even constructed in that case — no transport, no timers to come, nothing
 * that could make an outbound request.
 */

import type { RetrievalSummaryGenerator } from '../app/retrieval-summary-service.js';
import type { EmbeddingProvider } from '../domain/retrieval-embedding.js';
import type { RetrievalGenerationProfile } from '../domain/retrieval-generation-profile.js';
import type { StructuralReranker } from '../domain/retrieval-structural-rerank.js';
import {
  createOpenAiEmbeddingProvider,
  createOpenAiStructuralReranker,
  createOpenAiSummaryGenerator,
  createOpenAiTransport,
  resolveOpenAiRetrievalConfig,
  retrievalGenerationProfileFor,
  type FetchLike,
} from './openai/index.js';

/**
 * What the composition root learns.
 *
 * The whole stack or nothing: the three ports come from one configured
 * family, and half a stack — an embedding provider without a generator —
 * could only produce artifacts whose halves disagree about where they came
 * from. The structural reranker rides along for the search composition
 * (P5-02c); maintenance never calls it.
 */
export type ConfiguredRetrievalProviders =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly summaryGenerator: RetrievalSummaryGenerator;
      readonly embeddingProvider: EmbeddingProvider;
      readonly structuralReranker: StructuralReranker;
      readonly generationProfile: RetrievalGenerationProfile;
    };

/**
 * Builds the configured retrieval stack, or reports that there is none.
 *
 * `fetchLike` exists for tests; production passes nothing and the transport
 * uses the platform's fetch. The profile is derived from the actual provider
 * objects — the same derivation reconciliation trusts — so the description
 * of the stack cannot drift from the stack.
 */
export function createConfiguredRetrievalProviders(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  fetchLike?: FetchLike,
): ConfiguredRetrievalProviders {
  const config = resolveOpenAiRetrievalConfig(environment);
  if (!config.enabled) {
    return { enabled: false };
  }

  const transport = createOpenAiTransport(config.apiKey, fetchLike);
  const summaryGenerator = createOpenAiSummaryGenerator(transport);
  const embeddingProvider = createOpenAiEmbeddingProvider(transport);
  const structuralReranker = createOpenAiStructuralReranker(transport);

  return {
    enabled: true,
    summaryGenerator,
    embeddingProvider,
    structuralReranker,
    generationProfile: retrievalGenerationProfileFor(summaryGenerator, embeddingProvider),
  };
}
