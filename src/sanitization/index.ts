/**
 * The sanitization boundary.
 *
 * One entry point, so nothing outside this directory reaches into its parts.
 * What crosses the boundary is the policy interface — which P3-02 and P3-03
 * will implement — and the wrapper that guarantees the policy is consulted.
 */

export {
  createPermissivePolicy,
  formatFieldPath,
  SanitizationRejectedError,
  type FieldPath,
  type SanitizationOutcome,
  type SanitizationPolicy,
} from './policy.js';
export { sanitizeValue } from './sanitize.js';
export { isSanitizedOperation, withSanitization } from './sanitizing-repository.js';
