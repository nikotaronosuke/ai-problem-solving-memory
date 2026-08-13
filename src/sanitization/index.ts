/**
 * The sanitization boundary.
 *
 * One entry point, so nothing outside this directory reaches into its parts.
 * What crosses the boundary is the policy interface — which P3-02 and P3-03
 * will implement — and the wrapper that guarantees the policy is consulted.
 */

export {
  createPermissivePolicy,
  describeInspectionPath,
  formatSafeLocator,
  SanitizationRejectedError,
  UnsupportedSanitizationOutcomeError,
  type FieldPath,
  type PathSegment,
  type SanitizationLocationKind,
  type SanitizationOutcome,
  type SanitizationPolicy,
  type SanitizationSite,
} from './policy.js';
export {
  createSecretDetectionPolicy,
  createSecretDetector,
  SECRET_CATEGORIES,
  SECRET_CERTAINTIES,
  type SecretCategory,
  type SecretCertainty,
  type SecretDetector,
  type SecretFinding,
} from './secrets/index.js';
export { sanitizeValue } from './sanitize.js';
export { isSanitizedOperation, withSanitization } from './sanitizing-repository.js';
