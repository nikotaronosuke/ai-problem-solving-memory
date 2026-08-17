/**
 * The generation profile, derived from the providers rather than restated.
 *
 * Reconciliation compares stored artifacts against "the stack that is
 * configured now", and this is where that description comes from. It is a
 * pure read of the actual provider objects — the generator's own identity,
 * the embedding provider's own model, version and width — so the profile and
 * the providers cannot disagree: there is no second copy of any constant to
 * fall behind. A drift test asserts the derivation anyway, because "cannot"
 * deserves a witness.
 */

import type { RetrievalSummaryGenerator } from '../../app/retrieval-summary-service.js';
import type { EmbeddingProvider } from '../../domain/retrieval-embedding.js';
import {
  requireRetrievalGenerationProfile,
  type RetrievalGenerationProfile,
} from '../../domain/retrieval-generation-profile.js';

/**
 * Describes the configured stack, for reconciliation to compare against.
 */
export function retrievalGenerationProfileFor(
  generator: RetrievalSummaryGenerator,
  embedding: EmbeddingProvider,
): RetrievalGenerationProfile {
  return requireRetrievalGenerationProfile({
    summaryGeneratorId: generator.generatorId,
    summaryGeneratorVersion: generator.generatorVersion,
    embeddingModel: embedding.modelId,
    embeddingModelVersion: embedding.modelVersion,
    embeddingDimensions: embedding.dimensions,
  });
}
