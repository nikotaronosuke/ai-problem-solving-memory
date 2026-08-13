/**
 * Connecting detection to the boundary, and deciding as little as possible.
 *
 * The detector says what a string is. This says what happens to it, and the
 * split is the point: P3-03 owns refusal and redaction policy in full, and it
 * should arrive to find a question it can answer rather than an answer already
 * baked into the detector.
 *
 * What this does today is the minimum that satisfies P3-02's own completion
 * condition — a representative secret must not be stored in plaintext. A
 * confirmed credential is refused. Nothing is redacted, nothing is summarised,
 * and no attempt is made to keep the surrounding meaning while removing the
 * value; all of that is P3-03's and doing any of it here would be inventing a
 * policy nobody has designed.
 *
 * So the refusal is deliberately blunt and deliberately temporary. It is not
 * "the reject policy"; it is fail-closed holding the line until there is one.
 * When P3-03 decides that a credential inside a long summary should be replaced
 * rather than refused, the change is here — a different outcome for the same
 * finding — and neither the detector nor the boundary moves.
 *
 * `suspected` findings are kept. Widening refusal to cover them would refuse
 * configuration templates and documentation examples, and a caller who cannot
 * record what happened is the failure this record exists to prevent. Nothing is
 * logged about them either: "we saw something that might be a secret at this
 * path" is a sentence that only helps someone who already has the data, and it
 * puts a claim about caller content into an operational log for no one's
 * benefit.
 */

import type { SanitizationPolicy } from '../policy.js';
import { createSecretDetector, type SecretDetector } from './detector.js';

/**
 * Builds the policy the server runs with.
 *
 * The detector is a parameter so a test can supply a different one, and so
 * P3-03 can wrap or replace the decision without touching detection.
 */
export function createSecretDetectionPolicy(
  detector: SecretDetector = createSecretDetector(),
): SanitizationPolicy {
  return {
    inspect(text, at) {
      const finding = detector.detect(text, at);

      if (finding?.certainty === 'confirmed') {
        // No reason accompanies this, and there is no field for one. What the
        // boundary reports is a safe locator and whether it was a key or a
        // value; the category stays here, because P3-02 has no need to publish
        // which rule fired and every string that has escaped this boundary
        // escaped through a field added for debugging.
        return { kind: 'reject' };
      }

      return { kind: 'keep' };
    },
  };
}
