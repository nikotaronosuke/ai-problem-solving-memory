/**
 * Removing a credential while leaving the sentence around it.
 *
 * The reason this exists rather than the boundary simply refusing everything
 * is that a refusal costs the record. "The deploy failed because
 * `API_KEY=abc123` was stale" is a genuinely useful thing to have written
 * down, and refusing it means the investigation is not recorded at all — which
 * is the failure this whole system exists to prevent. Removing four characters
 * keeps the finding and loses nothing worth keeping.
 *
 * It works from the same spans the detector uses, in `patterns.ts`, so the two
 * cannot disagree about where a credential is. Those offsets never leave this
 * directory: an offset and a length are information about a secret, and
 * `SecretFinding` stays two closed identifiers precisely so nothing of that
 * shape can reach an error or a log.
 *
 * Returning `null` means "this cannot be removed safely", and the caller must
 * treat that as a refusal. That is the important half of the contract. A
 * redactor that did its best and returned something would be the worst
 * possible outcome: a write that succeeds, looks clean, and still holds a
 * credential. Whenever the extent of a secret is not knowable — an
 * unterminated key block — or no span was found at all, this refuses to guess.
 */

import type { SanitizationSite } from '../policy.js';
import {
  findAssignmentValues,
  findAuthorizationSpans,
  findCookieValueSpans,
  findJwtSpans,
  findPrivateKeyBlocks,
  hasUnterminatedPrivateKey,
  replaceSpans,
  structuredFieldCertainty,
  REDACTION_MARKER,
  type Span,
} from './patterns.js';

export interface SecretRedactor {
  /**
   * Returns `text` with every confirmed credential replaced, or `null`.
   *
   * `null` means the credential could not be bounded safely and the write must
   * be refused instead. It is never "nothing to do" — a string with nothing in
   * it comes back unchanged.
   */
  redact(text: string, at: SanitizationSite): string | null;
}

export function createSecretRedactor(): SecretRedactor {
  return {
    redact(text: string, at: SanitizationSite): string | null {
      // The caller's own structure first. When a field is named `api_key`, the
      // whole value is the credential however it happens to be written, so
      // there is nothing to preserve around it and nothing to locate. This
      // also covers a truncated key block sitting under such a field: the
      // whole value goes, which is safe even though bounding it would not be.
      if (structuredFieldCertainty(text, at) === 'confirmed') {
        return REDACTION_MARKER;
      }

      // An unterminated key block has no knowable end. Refusing is the only
      // honest answer; guessing at where the key material stops would leave
      // part of it stored.
      if (hasUnterminatedPrivateKey(text)) {
        return null;
      }

      const spans: Span[] = [
        ...findPrivateKeyBlocks(text),
        ...findJwtSpans(text),
        ...findAuthorizationSpans(text),
        ...findCookieValueSpans(text),
        ...findAssignmentValues(text)
          .filter((found) => found.certainty === 'confirmed')
          .map((found) => found.span),
      ];

      if (spans.length === 0) {
        // The detector saw something this cannot locate. That should not
        // happen while both read `patterns.ts`, and if it ever does the answer
        // is to refuse rather than to store text nobody could account for.
        return null;
      }

      // Every span, not the first: a `.env` paste holds several credentials
      // and removing one of them is barely better than removing none.
      return replaceSpans(text, spans);
    },
  };
}
