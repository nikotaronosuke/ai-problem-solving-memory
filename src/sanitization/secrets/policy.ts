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

/**
 * The policy an export is checked against.
 *
 * A second policy rather than a flag on the first, because the two answer
 * different questions. Writing asks "may this be stored?", and redacting is a
 * good answer: the record is kept, minus the credential. Reading an export asks
 * "may all of this leave?", and redacting is the wrong answer there — the
 * artifact has to be a copy of the Memory, and one that silently differs from
 * the database is not a copy. Restoring it would replace real content with
 * markers.
 *
 * So the outcomes are only two. A confirmed credential refuses the export,
 * which the caller can act on: the delete path exists, and removing the record
 * that holds it is the fix. Everything else keeps, including `suspected` —
 * withholding somebody's own Memory on a guess is a worse failure than the
 * guess being right occasionally, and it is the same certainty line the write
 * boundary draws.
 *
 * It lives here rather than in the export service for the reason the whole
 * directory exists: what a credential looks like is a privacy rule, and a
 * service that could ask the detector directly could also decide to disagree
 * with it. An architecture test pins that nothing outside this directory names
 * the detector at all.
 */
export function createExportInspectionPolicy(
  detector: SecretDetector = createSecretDetector(),
): SanitizationPolicy {
  return {
    inspect(text, at) {
      return detector.detect(text, at)?.certainty === 'confirmed'
        ? { kind: 'reject' }
        : { kind: 'keep' };
    },
  };
}
