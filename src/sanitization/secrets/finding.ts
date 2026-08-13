/**
 * What a detector is allowed to say it found.
 *
 * The shape here is the whole of it: a category and a certainty, both from
 * closed sets written in this file. There is no matched text, no excerpt, no
 * prefix, no offset and no hash.
 *
 * That is a hard rule rather than a preference. A finding travels — into a
 * policy, possibly into an error, and from there into an operational log — and
 * the entire purpose of producing one is that the string it describes must not
 * be copied anywhere. A field holding "the bit that matched" would be the one
 * place the secret is guaranteed to end up, written by the mechanism built to
 * stop exactly that. `JSON.stringify` of a finding is two short identifiers.
 *
 * No fingerprint or hash either. Those would only be worth their risk if
 * something needed to recognise the same secret twice, and nothing does: there
 * is no deduplication requirement, no rotation tracking and no cross-request
 * correlation in this phase. A hash of a low-entropy secret is also not the
 * one-way door it appears to be.
 */

/**
 * The forms a credential takes, named after how it was recognised.
 *
 * Deliberately about shape rather than vendor. `AWS_ACCESS_KEY_ID` and
 * `STRIPE_SECRET_KEY` are both a credential-named field holding a
 * credential-shaped value, and describing them that way is what keeps this from
 * becoming a token dictionary that is out of date the week it is written.
 *
 * Closed, and small. A category may be useful to a later phase deciding what to
 * do about a finding; it is never rendered into an error or a log, because
 * P3-02 has no need to say which rule fired and every string that has ever
 * escaped from this boundary escaped through a field someone added for
 * debugging.
 */
export const SECRET_CATEGORIES = [
  /** A PEM-encoded private key. */
  'PRIVATE_KEY',
  /** A JSON Web Token, verified by decoding its header. */
  'JWT',
  /** An `Authorization` header, or a bare `Bearer`/`Basic` credential. */
  'AUTHORIZATION',
  /** A `Cookie` or `Set-Cookie` header. */
  'COOKIE',
  /** `API_KEY=...`, `client_secret: ...` — a credential named inline. */
  'CREDENTIAL_ASSIGNMENT',
  /** A credential-named field holding the value, as in a snapshot. */
  'CREDENTIAL_FIELD',
] as const;

export type SecretCategory = (typeof SECRET_CATEGORIES)[number];

/**
 * How sure the detector is, which is not the same as how bad it would be.
 *
 * `confirmed` means the string has a form that is a credential and is not
 * plausibly anything else: a PEM private key block, a decodable JWT, an
 * `Authorization` header, or a credential-named field holding a value that
 * looks like a value rather than a word.
 *
 * `suspected` means the context says credential and the content does not
 * agree — `{"password": "changeme"}`, `{"session": "morning"}`. Something is
 * named like a secret and holds something that reads like a placeholder or an
 * ordinary word. Refusing those would refuse documentation examples and
 * configuration templates, and the cost of a false refusal here is a caller
 * unable to record what happened, which is the failure this whole record exists
 * to prevent.
 *
 * P3-02 acts on `confirmed` only. What should happen to `suspected` — refuse,
 * redact, warn, or nothing — is P3-03's, and the separation exists so that
 * decision can be made on evidence rather than inherited from whatever was
 * convenient here.
 */
export const SECRET_CERTAINTIES = ['confirmed', 'suspected'] as const;

export type SecretCertainty = (typeof SECRET_CERTAINTIES)[number];

/** Everything a detector reports. Contains no part of what it found. */
export interface SecretFinding {
  readonly category: SecretCategory;
  readonly certainty: SecretCertainty;
}
