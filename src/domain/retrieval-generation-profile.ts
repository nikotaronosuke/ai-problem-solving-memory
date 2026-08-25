/**
 * What a current artifact is expected to have been generated with.
 *
 * Reconciliation needs one question answered per artifact: was this produced
 * by the generation stack that is configured right now? The profile is that
 * stack's identity, written down as data — which generator, which embedding
 * model, how many dimensions. It deliberately carries no vendor name as a
 * concept: the values are free text exactly as artifact rows store them, and
 * whether one of them happens to name a vendor is the configuration's
 * business, decided at the composition edge and nowhere else.
 *
 * Two versions are *not* here, on purpose. The source schema version and the
 * structural feature schema version belong to this codebase rather than to a
 * configured provider — they change when this code changes — so reconciliation
 * takes them from the domain constants directly. A profile that restated them
 * would be a copy that drifts.
 *
 * The distinction the profile feeds is soft, not hard: an artifact whose
 * profile is outdated still describes the current canonical source, so it
 * keeps serving the channels that can use it until regeneration replaces it
 * through the ordinary locked gate. Only a source-schema mismatch is hard,
 * and that gate lives in the readers, not here.
 */

import { isBlankText } from './text.js';

/** What the configured embedding side is expected to have produced. */
export interface RetrievalSemanticGenerationExpectation {
  /** Which embedding model produces vectors now. */
  readonly embeddingModel: string;
  /** Which version of it. */
  readonly embeddingModelVersion: string;
  /** How many dimensions those vectors have. */
  readonly embeddingDimensions: number;
}

/** The generation stack's identity, as reconciliation compares it. */
export interface RetrievalGenerationProfile {
  /** Which summary generator implementation produces drafts now. */
  readonly summaryGeneratorId: string;
  /** Which version of it — its prompt and schema contract included. */
  readonly summaryGeneratorVersion: string;
  /**
   * The embedding expectation, whole — or `null` for the deterministic
   * stack, which produces no vectors and, deliberately, claims nothing about
   * rows that carry one: an artifact a configured provider once enriched
   * stays as it is rather than being regenerated downward.
   */
  readonly semantic: RetrievalSemanticGenerationExpectation | null;
}

/**
 * Checks a profile once, where it is configured.
 *
 * The same posture as the provider identity checks: a blank identity would
 * make every comparison vacuously false or vacuously true, and either way
 * reconciliation would be answering a different question than it was asked.
 */
export function requireRetrievalGenerationProfile(
  profile: RetrievalGenerationProfile,
): RetrievalGenerationProfile {
  if (isBlankText(profile.summaryGeneratorId)) {
    throw new Error('A generation profile must name its summary generator.');
  }
  if (isBlankText(profile.summaryGeneratorVersion)) {
    throw new Error('A generation profile must name its summary generator version.');
  }
  if (profile.semantic !== null) {
    if (isBlankText(profile.semantic.embeddingModel)) {
      throw new Error('A generation profile must name its embedding model.');
    }
    if (isBlankText(profile.semantic.embeddingModelVersion)) {
      throw new Error('A generation profile must name its embedding model version.');
    }
    if (
      !Number.isInteger(profile.semantic.embeddingDimensions) ||
      profile.semantic.embeddingDimensions <= 0
    ) {
      throw new Error(
        'A generation profile must declare a positive whole number of embedding dimensions.',
      );
    }
  }
  return profile;
}
