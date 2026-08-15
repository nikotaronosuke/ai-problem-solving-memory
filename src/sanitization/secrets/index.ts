/**
 * Secret detection.
 *
 * Two pieces, kept apart on purpose: a detector that says what a string is,
 * and a policy that says what happens to it. P3-03 changes the second without
 * reopening the first.
 */

export {
  SECRET_CATEGORIES,
  SECRET_CERTAINTIES,
  type SecretCategory,
  type SecretCertainty,
  type SecretFinding,
} from './finding.js';
export { createSecretDetector, type SecretDetector } from './detector.js';
export { createSecretRedactor, type SecretRedactor } from './redactor.js';
export { REDACTION_MARKER } from './patterns.js';
export {
  createArtifactInspectionPolicy,
  createExportInspectionPolicy,
  createSemanticQueryInspectionPolicy,
  createSecretDetectionPolicy,
} from './policy.js';
