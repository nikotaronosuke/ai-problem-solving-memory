/**
 * What happens to a credential, now that there is somewhere to put the answer.
 *
 * Three components, and this one holds the decision. The detector says what a
 * string is; the redactor says what removing the credential would leave; this
 * decides between storing that and refusing the write. Neither of the other
 * two knows which way it went, which is what let redaction be added to P3-02
 * without reopening detection.
 *
 * The rule, in order:
 *
 * A `suspected` finding is kept. Refusing configuration templates and
 * documentation examples would make the record unusable, and nothing about a
 * suspected finding is logged either — "we saw something that might be a
 * secret" only helps someone who already has the data.
 *
 * A confirmed credential in an object *key* is refused. Replacing a key can
 * collide with a key already present and silently merge two fields into one,
 * and the caller loses data without being told. Refusing hands the problem
 * back to them, where it can be fixed.
 *
 * A confirmed credential in a value is redacted if that can be done safely,
 * and refused if it cannot. `null` from the redactor is a refusal, not a
 * shrug.
 *
 * And then the part that matters most: the redacted text is shown to the
 * detector again, and if a confirmed credential is still there the write is
 * refused anyway. Partial removal is the worst available outcome — a record
 * that looks sanitised, reads as safe, and still holds a credential, with the
 * caller told it succeeded. Everything here fails closed toward refusing.
 */

import type { SanitizationPolicy } from '../policy.js';
import { createSecretDetector, type SecretDetector } from './detector.js';
import { createSecretRedactor, type SecretRedactor } from './redactor.js';

/**
 * Builds the policy the server runs with.
 *
 * Both collaborators are parameters so a test can substitute either, and so a
 * later phase can change one without disturbing the other.
 */
export function createSecretDetectionPolicy(
  detector: SecretDetector = createSecretDetector(),
  redactor: SecretRedactor = createSecretRedactor(),
): SanitizationPolicy {
  return {
    inspect(text, at) {
      const finding = detector.detect(text, at);

      if (finding?.certainty !== 'confirmed') {
        // Nothing found, or found and not certain. P3-02 settled this.
        return { kind: 'keep' };
      }

      if (at.kind === 'key') {
        // Key replacement is not something the boundary supports, and giving
        // two keys the same redacted name would lose a field silently.
        return { kind: 'reject' };
      }

      const redacted = redactor.redact(text, at);
      if (redacted === null) {
        return { kind: 'reject' };
      }

      // Fail closed. If anything confirmed survived the removal, the write does
      // not happen — a half-cleaned credential stored under a green light is
      // worse than a refusal the caller can act on.
      if (detector.detect(redacted, at)?.certainty === 'confirmed') {
        return { kind: 'reject' };
      }

      // No reason accompanies either outcome, and there is no field for one.
      // What the boundary reports is a safe locator and whether it was a key
      // or a value; the category stays here.
      return { kind: 'replace', value: redacted };
    },
  };
}
