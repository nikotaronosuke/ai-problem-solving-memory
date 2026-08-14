/**
 * Recognising a credential, and nothing else.
 *
 * This module decides what a secret is. It does not decide what happens to
 * one — that is the policy, and the redactor beside it decides what a removal
 * would look like. Keeping the three apart is what let redaction be added
 * without reopening the question of what counts as a secret.
 *
 * The rules themselves live in `patterns.ts`, shared with the redactor so the
 * two cannot disagree about what a credential is or where it sits. What this
 * file adds is the reading: which category a match belongs to, and how sure
 * that makes us. It throws the positions away — a `SecretFinding` is two
 * closed identifiers and never an offset, a length or a fragment.
 *
 * The organising rule is that a string is a secret because of what it *means*,
 * never because of how it looks in isolation. There is no entropy score and no
 * length threshold as evidence: "long random-looking string" describes a UUID,
 * a commit SHA, a content hash and half the identifiers in this system.
 *
 * The corollary matters as much. Once a credential signal is present, the
 * *shape* of the value is not evidence against it. `PASSWORD=letmein` is a
 * password. Value shape only separates degrees of confidence where the name
 * was ambiguous; it never overrides an explicit one.
 *
 * That leaves a known and stated gap: a bare credential with no context at
 * all is not detected, because catching it would mean guessing from shape. The
 * specification's answer is defence in depth — the adapter sanitises before
 * sending, and this is the server-side re-check.
 *
 * Everything here is pure and deterministic. No clock, no network, no
 * database, no model.
 */

import type { SanitizationSite } from '../policy.js';
import type { SecretFinding } from './finding.js';
import {
  findAssignmentValues,
  findAuthorizationSpans,
  findCookieValueSpans,
  findJwtSpans,
  findPrivateKeyBlocks,
  hasUnterminatedPrivateKey,
  structuredFieldCertainty,
} from './patterns.js';

export interface SecretDetector {
  /**
   * Reports what kind of credential this string is, or `null`.
   *
   * `at` is the boundary's own structured path, which is what makes context
   * available: `{"api_key": "..."}` is recognisable because the field is named
   * `api_key`, not because the value looks like anything in particular.
   */
  detect(text: string, at: SanitizationSite): SecretFinding | null;
}

/**
 * Builds the detector.
 *
 * Stateless: the returned object closes over nothing that changes, so it can be
 * shared across requests and reasoned about one string at a time.
 */
export function createSecretDetector(): SecretDetector {
  return {
    detect(text: string, at: SanitizationSite): SecretFinding | null {
      // Content first, because a credential written into an object key is
      // still a credential and these rules do not care which it was.
      //
      // An unterminated key block counts. It cannot be removed safely, which
      // is the redactor's problem, but it is unmistakably a private key and
      // saying otherwise here would store one.
      if (findPrivateKeyBlocks(text).length > 0 || hasUnterminatedPrivateKey(text)) {
        return { category: 'PRIVATE_KEY', certainty: 'confirmed' };
      }
      if (findJwtSpans(text).length > 0) {
        return { category: 'JWT', certainty: 'confirmed' };
      }
      if (findAuthorizationSpans(text).length > 0) {
        return { category: 'AUTHORIZATION', certainty: 'confirmed' };
      }
      if (findCookieValueSpans(text).length > 0) {
        return { category: 'COOKIE', certainty: 'confirmed' };
      }

      const assignments = findAssignmentValues(text);
      if (assignments.some((found) => found.certainty === 'confirmed')) {
        return { category: 'CREDENTIAL_ASSIGNMENT', certainty: 'confirmed' };
      }
      if (assignments.length > 0) {
        return { category: 'CREDENTIAL_ASSIGNMENT', certainty: 'suspected' };
      }

      // Then the caller's own structure. A key naming a credential is a
      // statement about the value under it, which is how
      // `{"api_key": "abcdef"}` is recognised without the value having any
      // recognisable form of its own.
      const structured = structuredFieldCertainty(text, at);
      if (structured !== null) {
        return { category: 'CREDENTIAL_FIELD', certainty: structured };
      }

      return null;
    },
  };
}
