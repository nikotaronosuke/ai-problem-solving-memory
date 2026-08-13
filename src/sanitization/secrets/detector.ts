/**
 * Recognising a credential, and nothing else.
 *
 * This module decides what a secret is. It does not decide what happens to
 * one — that is the policy next to it, and keeping the two apart is what lets
 * P3-03 change the response without reopening the question of what was found.
 *
 * The organising rule is that a string is a secret because of what it *means*,
 * never because of how it looks in isolation. There is no entropy score and no
 * length threshold as evidence: "long random-looking string" describes a UUID,
 * a commit SHA, a content hash, a database id and half the identifiers in this
 * system, and a detector built on it would refuse the evidence references that
 * make a Memory worth keeping. Every rule below needs a signal that says
 * *credential* — a PEM header, a decodable JWT, an `Authorization` line, a
 * credential-named variable, or a credential-named field in the caller's own
 * structure.
 *
 * The corollary took a review round to get right, and it is the more important
 * half. Once a credential signal is present, the *shape* of the value is not
 * evidence against it. `PASSWORD=letmein` is a password. `{"api_key":"abcdef"}`
 * is an api key. People choose credentials that look like words, and an earlier
 * version of this file required a digit or punctuation before believing an
 * explicit `PASSWORD=` — which meant the weakest real passwords were exactly
 * the ones it let through. Value shape now only separates degrees of confidence
 * where the *name* was ambiguous; it never overrides an explicit one.
 *
 * That leaves a known and stated gap: a bare credential with no context at
 * all — pasted alone into a summary, with nothing naming it — is not detected.
 * Catching it would mean guessing from shape, and guessing from shape is what
 * produces the false refusals that make people stop recording things. The
 * specification's answer is defence in depth: the adapter sanitises before
 * sending, and this is the server-side re-check. This is the re-check, not the
 * only check.
 *
 * Everything here is pure and deterministic. No clock, no network, no
 * database, no model. The same string at the same site is the same answer every
 * time, which is what makes the behaviour testable and the refusals explicable.
 */

import type { FieldPath, SanitizationSite } from '../policy.js';
import type { SecretFinding } from './finding.js';

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
 * How strongly a name says "what follows is a credential".
 *
 * `strong` names have no ordinary reading: a field called `password` or
 * `client_secret` holds a credential or holds nothing. `ambiguous` names have
 * one — `token` appears in "token bucket", `session` in "session length",
 * `secret` in "secret sauce" — so for those the value gets a say.
 */
type NameStrength = 'strong' | 'ambiguous' | 'none';

/**
 * Names with no ordinary reading.
 *
 * Matched against a normalised form — lowercased with `-`, `_` and spaces
 * removed — so `API_KEY`, `api-key` and `apiKey` are one entry. Compared whole
 * rather than as substrings, so `passwordless` is not one of these.
 */
const STRONG_NAMES: ReadonlySet<string> = new Set([
  'password',
  'passwd',
  'pwd',
  'passphrase',
  'apikey',
  'apisecret',
  'clientsecret',
  'accesstoken',
  'refreshtoken',
  'authtoken',
  'idtoken',
  'sessiontoken',
  'securitytoken',
  'accesskey',
  'secretkey',
  'privatekey',
  'credential',
  'credentials',
  'authorization',
]);

/** Names that usually mean a credential but have an ordinary reading too. */
const AMBIGUOUS_NAMES: ReadonlySet<string> = new Set([
  'token',
  'secret',
  'session',
  'sessionid',
  'cookie',
  'setcookie',
  'auth',
]);

/**
 * Endings that make a compound name a credential name.
 *
 * `db_password`, `github_token` and `stripe_api_key` are all credentials, and
 * enumerating every prefix anyone might use is the dictionary this file exists
 * to avoid. They inherit the strength of the ending, so `github_token` is
 * ambiguous for the same reason `token` is.
 */
const STRONG_SUFFIXES: readonly string[] = [
  'password',
  'passphrase',
  'apikey',
  'clientsecret',
  'accesstoken',
  'refreshtoken',
  'authtoken',
  'sessiontoken',
  'privatekey',
  'credential',
];

const AMBIGUOUS_SUFFIXES: readonly string[] = ['token', 'secret'];

/**
 * What a string is doing where it sits.
 *
 * `placeholder` — someone already removed the value, or never had one.
 * `status` — describing the state of a credential rather than holding one.
 * `value` — anything else, which under a credential name means a credential.
 */
type ContentReading = 'placeholder' | 'status' | 'value';

/**
 * Values standing in for a secret rather than being one.
 *
 * A configuration template, a documentation example and the output of someone
 * else's redaction all look like credentials by context and contain nothing
 * worth protecting. Refusing them would refuse the very act of writing down
 * that a credential was involved. Used identically by every rule here, so a
 * caller sees the same answer whether the placeholder arrived in an
 * assignment, a structured field, an `Authorization` header or a cookie.
 */
const REDACTION_PLACEHOLDERS =
  /^(?:\[?redacted\]?|\*+|x+|<[^>]*>|\.{3,}|-+|_+|change[_-]?me|your[_-]?\w+[_-]?here|todo|tbd|n\/a|example|placeholder|replace[_-]?with[_-]?\w*)$/i;

/**
 * Words describing a credential's state instead of being one.
 *
 * Deliberately small and closed. `password: unknown` and `token: expired` are
 * notes about a credential, not the credential, and a caller has to be able to
 * write them down. Anything not on this list counts as a value, which is the
 * direction to err in: being wrong here costs a refused note, and being wrong
 * the other way stores a password.
 */
const STATUS_WORDS: ReadonlySet<string> = new Set([
  'unknown',
  'unset',
  'notset',
  'set',
  'empty',
  'missing',
  'absent',
  'present',
  'expired',
  'rotated',
  'revoked',
  'invalid',
  'valid',
  'disabled',
  'enabled',
  'hidden',
  'required',
  'optional',
  'forgotten',
  'wrong',
  'incorrect',
  'unchanged',
  'unavailable',
  'none',
  'null',
  'nil',
  'undefined',
  'true',
  'false',
  'yes',
  'no',
  'ok',
]);

/** Normalises a field or variable name for comparison. */
function normaliseName(name: string): string {
  return name.toLowerCase().replace(/[\s_-]/g, '');
}

function nameStrength(name: string): NameStrength {
  const normalised = normaliseName(name);
  // A plural names the same thing: `api_keys` holds api keys. Checked as a
  // separate form rather than by stripping trailing letters generally, which
  // would start matching names that merely end in the right letters.
  const candidates = new Set([
    normalised,
    normalised.endsWith('s') ? normalised.slice(0, -1) : normalised,
  ]);

  const endsWithAny = (suffixes: readonly string[], candidate: string): boolean =>
    suffixes.some((suffix) => candidate.endsWith(suffix) && candidate.length > suffix.length);

  for (const candidate of candidates) {
    if (STRONG_NAMES.has(candidate) || endsWithAny(STRONG_SUFFIXES, candidate)) {
      return 'strong';
    }
  }
  for (const candidate of candidates) {
    if (AMBIGUOUS_NAMES.has(candidate) || endsWithAny(AMBIGUOUS_SUFFIXES, candidate)) {
      return 'ambiguous';
    }
  }
  return 'none';
}

function readContent(text: string): ContentReading {
  const trimmed = text.trim();
  if (trimmed === '' || REDACTION_PLACEHOLDERS.test(trimmed)) {
    return 'placeholder';
  }
  if (STATUS_WORDS.has(trimmed.toLowerCase())) {
    return 'status';
  }
  return 'value';
}

/**
 * Whether a string reads like a credential rather than an ordinary word.
 *
 * An auxiliary signal, and only that. It never overrides an explicit
 * credential name — `PASSWORD=letmein` is a password whatever this returns —
 * and is consulted in exactly two places: to separate `confirmed` from
 * `suspected` under an *ambiguous* name, and to decide whether a bare
 * `Bearer x` is a credential or the start of a sentence.
 */
function looksLikeCredentialValue(text: string): boolean {
  if (/\s/.test(text) || text.length < 6) {
    return false;
  }
  return (
    /\d/.test(text) ||
    /[^A-Za-z0-9]/.test(text) ||
    (/[a-z]/.test(text) && /[A-Z]/.test(text)) ||
    text.length >= 20
  );
}

/**
 * The certainty a credential name and its value together justify.
 *
 * `null` where there is nothing to protect. A strong name does not consult the
 * value's shape at all, which is the whole of the correction: a lowercase word
 * under `password` is a password.
 */
function certaintyFor(strength: NameStrength, text: string): SecretFinding['certainty'] | null {
  if (strength === 'none') {
    return null;
  }

  if (readContent(text) !== 'value') {
    return null;
  }

  if (strength === 'strong') {
    return 'confirmed';
  }
  return looksLikeCredentialValue(text) ? 'confirmed' : 'suspected';
}

/** The nearest object key above this string, if it sits under one. */
function nearestKey(path: FieldPath): string | undefined {
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const segment = path[index];
    if (segment?.kind === 'key') {
      return segment.name;
    }
    // An array index does not break the association: every element of
    // `{"api_keys": ["...", "..."]}` sits under the same name.
    if (segment?.kind !== 'element') {
      return undefined;
    }
  }
  return undefined;
}

// ---- content rules ---------------------------------------------------------
//
// Each answers only about the string itself, so they apply to a value and to an
// object key alike — a caller can write a credential into either.

/**
 * A PEM private key block.
 *
 * `PUBLIC KEY` is deliberately not matched. Publishing a public key is the
 * point of having one, and refusing to record it would be refusing ordinary
 * evidence.
 */
const PRIVATE_KEY_BLOCK = /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/;

/** Three base64url segments, which is a JWT's shape but not yet proof. */
const JWT_SHAPE = /\b[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g;

/**
 * Whether a candidate really is a JWT.
 *
 * Shape alone matches `1.2.3-alpha.build.7` and other dotted identifiers, so
 * the header is decoded and required to be a JSON object naming an algorithm.
 * That is what a JWT is, and nothing that is not one passes it by accident.
 */
function isJwt(candidate: string): boolean {
  const [header] = candidate.split('.');
  if (header === undefined || header.length < 4) {
    return false;
  }

  try {
    const json: unknown = JSON.parse(
      Buffer.from(header.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    );
    return typeof json === 'object' && json !== null && 'alg' in json;
  } catch {
    return false;
  }
}

function containsJwt(text: string): boolean {
  for (const match of text.matchAll(JWT_SHAPE)) {
    if (isJwt(match[0])) {
      return true;
    }
  }
  return false;
}

/** Authentication schemes that are followed by a credential. */
const AUTH_SCHEMES = /^(?:bearer|basic|digest|token)$/i;

/** An explicit `Authorization:` header line, whatever follows it. */
const AUTHORIZATION_LINE = /(?:^|\n)[ \t]*authorization[ \t]*:[ \t]*([^\n]*)/gi;

/** A scheme and what follows it, anywhere in the text. */
const BARE_SCHEME = /(?:^|[\s"'([])(bearer|basic|digest)[ \t]+(\S+)/gi;

/**
 * An `Authorization` header, or a bare scheme and credential.
 *
 * Parsed rather than pattern-matched, because "the line exists" is not the same
 * claim as "a credential is present". `Authorization: disabled` is a note about
 * configuration, `Authorization: Bearer` on its own carries nothing, and
 * `Authorization: Bearer [REDACTED]` is something a careful caller already
 * cleaned. An earlier version confirmed all three, which is how a detector
 * teaches people to ignore it.
 *
 * The header form trusts its own context: an explicit `Authorization:` line
 * with a scheme and a non-placeholder credential is a credential, whatever the
 * credential looks like. The bare form has no such context — `Bearer` is an
 * ordinary English word — so it additionally requires the following token to
 * read like a credential rather than like the next word of a sentence.
 */
function containsAuthorizationCredential(text: string): boolean {
  for (const match of text.matchAll(AUTHORIZATION_LINE)) {
    const parts = (match[1] ?? '').trim().split(/[ \t]+/);
    const [scheme, credential] = parts;
    if (
      scheme !== undefined &&
      AUTH_SCHEMES.test(scheme) &&
      credential !== undefined &&
      readContent(credential) === 'value'
    ) {
      return true;
    }
  }

  for (const match of text.matchAll(BARE_SCHEME)) {
    // Trailing sentence punctuation is the sentence's, not the token's.
    // Without this, "The endpoint expects Bearer tokens." offers `tokens.`,
    // whose full stop reads as the punctuation a credential would have.
    const credential = match[2]?.replace(/[.,;:!?)\]}"']+$/, '');
    if (
      credential !== undefined &&
      readContent(credential) === 'value' &&
      looksLikeCredentialValue(credential)
    ) {
      return true;
    }
  }

  return false;
}

/** A `Cookie:` or `Set-Cookie:` header line. */
const COOKIE_LINE = /(?:^|\n)[ \t]*(?:set-)?cookie[ \t]*:[ \t]*([^\n]*)/gi;

/**
 * A cookie header carrying at least one actual value.
 *
 * `Cookie: sid=[REDACTED]` and `Set-Cookie: session=<token>; HttpOnly` are
 * already-redacted content, and are treated exactly as a redacted assignment or
 * field would be — so a caller does not have to learn which rule happened to
 * see their string.
 */
function containsCookieCredential(text: string): boolean {
  for (const match of text.matchAll(COOKIE_LINE)) {
    for (const pair of (match[1] ?? '').split(';')) {
      const separator = pair.indexOf('=');
      if (separator <= 0) {
        continue;
      }
      if (readContent(pair.slice(separator + 1).trim()) === 'value') {
        return true;
      }
    }
  }
  return false;
}

/**
 * `NAME=value` or `NAME: value`, where the name means credential.
 *
 * Anchored to a line start or a separator so that prose mentioning a password
 * does not match, and applied per match so a multi-line `.env` paste is covered
 * line by line without a separate rule for it.
 *
 * A quoted value is taken whole, spaces included: a passphrase is allowed to
 * contain them, and `PASSWORD="correct horse battery staple"` is exactly the
 * kind of credential that reads least like one.
 */
const ASSIGNMENT =
  /(?:^|[\s,;{("'])([A-Za-z][A-Za-z0-9_.-]{1,60})[ \t]*([:=])[ \t]*("[^"]*"|'[^']*'|\S+)/g;

/**
 * Header names that have a parser of their own above.
 *
 * `Authorization: Bearer` and `Cookie: sid=[REDACTED]` are header lines, and
 * reading them a second time as `NAME: value` gets the wrong answer — the
 * "value" is the scheme, or a cookie pair whose punctuation reads as a
 * credential. Those rules already decided, so each line is judged once.
 *
 * Only for the `:` form. `authorization=rawtoken` is a variable assignment
 * rather than a header, and is judged as one.
 */
const HEADER_NAMES: ReadonlySet<string> = new Set(['authorization', 'cookie', 'setcookie']);

function unquote(value: string): string {
  const quoted = /^(["'])(.*)\1$/s.exec(value);
  return quoted?.[2] ?? value;
}

/** The strongest certainty any credential assignment in this text justifies. */
function assignmentCertainty(text: string): SecretFinding['certainty'] | null {
  let best: SecretFinding['certainty'] | null = null;

  for (const match of text.matchAll(ASSIGNMENT)) {
    const name = match[1];
    const separator = match[2];
    const value = match[3];
    if (name === undefined || value === undefined) {
      continue;
    }
    if (separator === ':' && HEADER_NAMES.has(normaliseName(name))) {
      continue;
    }

    const certainty = certaintyFor(nameStrength(name), unquote(value));
    if (certainty === 'confirmed') {
      return 'confirmed';
    }
    if (certainty === 'suspected') {
      best = 'suspected';
    }
  }

  return best;
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
      if (PRIVATE_KEY_BLOCK.test(text)) {
        return { category: 'PRIVATE_KEY', certainty: 'confirmed' };
      }
      if (containsJwt(text)) {
        return { category: 'JWT', certainty: 'confirmed' };
      }
      if (containsAuthorizationCredential(text)) {
        return { category: 'AUTHORIZATION', certainty: 'confirmed' };
      }
      if (containsCookieCredential(text)) {
        return { category: 'COOKIE', certainty: 'confirmed' };
      }

      const inline = assignmentCertainty(text);
      if (inline !== null) {
        return { category: 'CREDENTIAL_ASSIGNMENT', certainty: inline };
      }

      // Then the caller's own structure. A key naming a credential is a
      // statement about the value under it, which is how
      // `{"api_key": "abcdef"}` is recognised without the value having any
      // recognisable form of its own.
      //
      // Only for values: applying it to a key would ask whether the key's own
      // parent named a credential, which says nothing about the key text.
      if (at.kind === 'value') {
        const name = nearestKey(at.path);
        const certainty = name === undefined ? null : certaintyFor(nameStrength(name), text);
        if (certainty !== null) {
          return { category: 'CREDENTIAL_FIELD', certainty };
        }
      }

      return null;
    },
  };
}
