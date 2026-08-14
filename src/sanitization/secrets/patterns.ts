/**
 * Where credentials are, and what the words around them mean.
 *
 * One module, used by both the detector and the redactor, because they have to
 * agree exactly. If the detector recognised a form the redactor could not
 * locate, the write would be refused for something that was removable; if the
 * redactor located a form the detector did not recognise, it would rewrite
 * text nobody asked it to. Two copies of these rules would drift the first
 * time either was edited alone, and the failure would be silent in both
 * directions.
 *
 * So detection and redaction are different *questions* asked of the same
 * answers here. Everything below reports spans — where in a string a
 * credential sits. The detector throws the positions away and keeps the fact;
 * the redactor keeps the positions and replaces what they cover.
 *
 * Those positions never leave this directory. A span is an offset and a
 * length, which is information about a secret — how long it is, where it
 * appeared — and `SecretFinding` stays two closed identifiers precisely so
 * nothing of that shape can travel into an error or a log. Spans are internal
 * working state, and the module boundary is what keeps them that way.
 */

import type { SecretCertainty } from './finding.js';
import type { FieldPath, SanitizationSite } from '../policy.js';

/** What replaces a credential. */
export const REDACTION_MARKER = '[REDACTED]';

/** A half-open range within the string being examined. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

/** A span, and how sure we are that it is a credential. */
export interface CredentialSpan {
  readonly span: Span;
  readonly certainty: SecretCertainty;
}

// ---- vocabulary ------------------------------------------------------------

/**
 * How strongly a name says "what follows is a credential".
 *
 * `strong` names have no ordinary reading: a field called `password` or
 * `client_secret` holds a credential or holds nothing. `ambiguous` names have
 * one — `token` appears in "token bucket", `session` in "session length" — so
 * for those the value gets a say.
 */
export type NameStrength = 'strong' | 'ambiguous' | 'none';

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
 * Compounds that stay strong when something is put in front of them.
 *
 * Real credential variables are almost never bare. They are named after who
 * issues them — `AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, `STRIPE_API_KEY` — so
 * a vocabulary of exact names recognises the word and misses every use of it.
 * A review found exactly that: `AWS_SECRET_ACCESS_KEY=…` read as ordinary
 * prose, because `accesskey` and `secretkey` were exact names and
 * `awssecretaccesskey` matches neither.
 *
 * A suffix belongs here when the compound has no ordinary reading, which is the
 * same test the strong names themselves pass. That is a judgement per word
 * rather than a rule, and three were deliberately left out:
 *
 * `accesskey` stays an exact name. On its own it is a credential often enough
 * to keep, but "access key" has an ordinary reading — HTML gives every element
 * an `accessKey`, and menus and shortcuts use the word the same way. As a
 * suffix it would make `menuAccessKey` a credential. Nothing is lost for AWS:
 * the secret half is `SECRET_ACCESS_KEY`, which is covered below, and the
 * `ACCESS_KEY_ID` half is a public identifier rather than a secret.
 *
 * `pwd` stays an exact name because `OLDPWD` is a directory, not a password.
 *
 * `passwd` stays an exact name because names ending in it tend to be paths.
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
  // Added after the review. `secret` alone is ambiguous — a field may hold a
  // boolean saying something is secret — but "secret key" and "secret access
  // key" name a credential and nothing else, in any prefixed form.
  'secretkey',
  'secretaccesskey',
  // A security token is a credential wherever it appears under a name. Bare
  // `token` stays ambiguous, so `AWS_SECURITY_TOKEN` was reading as one.
  'securitytoken',
];

const AMBIGUOUS_SUFFIXES: readonly string[] = ['token', 'secret'];

/**
 * What a string is doing where it sits.
 *
 * `placeholder` — someone already removed the value, or never had one.
 * `status` — describing the state of a credential rather than holding one.
 * `value` — anything else, which under a credential name means a credential.
 */
export type ContentReading = 'placeholder' | 'status' | 'value';

/**
 * Values standing in for a secret rather than being one.
 *
 * Includes this module's own marker, which is what makes redaction
 * idempotent: redacted text run through again is recognised as already
 * handled rather than as a fresh credential.
 */
const REDACTION_PLACEHOLDERS =
  /^(?:\[?redacted\]?|\*+|x+|<[^>]*>|\.{3,}|-+|_+|change[_-]?me|your[_-]?\w+[_-]?here|todo|tbd|n\/a|example|placeholder|replace[_-]?with[_-]?\w*)$/i;

/**
 * Words describing a credential's state instead of being one.
 *
 * Deliberately small and closed. `password: unknown` and `token: expired` are
 * notes about a credential, and a caller has to be able to write them down.
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
export function normaliseName(name: string): string {
  return name.toLowerCase().replace(/[\s_-]/g, '');
}

export function nameStrength(name: string): NameStrength {
  const normalised = normaliseName(name);
  // A plural names the same thing: `api_keys` holds api keys.
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

export function readContent(text: string): ContentReading {
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
 * An auxiliary signal only. It never overrides an explicit credential name —
 * `PASSWORD=letmein` is a password whatever this returns.
 */
export function looksLikeCredentialValue(text: string): boolean {
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

/** The certainty a credential name and its value together justify. */
export function certaintyFor(strength: NameStrength, text: string): SecretCertainty | null {
  if (strength === 'none' || readContent(text) !== 'value') {
    return null;
  }
  if (strength === 'strong') {
    return 'confirmed';
  }
  return looksLikeCredentialValue(text) ? 'confirmed' : 'suspected';
}

/** The nearest object key above this string, if it sits under one. */
export function nearestKey(path: FieldPath): string | undefined {
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const segment = path[index];
    if (segment?.kind === 'key') {
      return segment.name;
    }
    // An array index does not break the association.
    if (segment?.kind !== 'element') {
      return undefined;
    }
  }
  return undefined;
}

/**
 * What the caller's own structure says about this value.
 *
 * `null` for a key: asking whether a key's parent named a credential says
 * nothing about the key's own text.
 */
export function structuredFieldCertainty(
  text: string,
  at: SanitizationSite,
): SecretCertainty | null {
  if (at.kind !== 'value') {
    return null;
  }
  const name = nearestKey(at.path);
  return name === undefined ? null : certaintyFor(nameStrength(name), text);
}

// ---- span finders ----------------------------------------------------------

/**
 * A PEM private key block, from BEGIN to its matching END.
 *
 * `PUBLIC KEY` is deliberately not matched. Publishing a public key is the
 * point of having one.
 */
const PRIVATE_KEY_BLOCK =
  /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/dg;

const PRIVATE_KEY_BEGIN = /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/dg;

export function findPrivateKeyBlocks(text: string): Span[] {
  return [...text.matchAll(PRIVATE_KEY_BLOCK)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}

/**
 * Whether a key block starts and never finishes.
 *
 * This is the case redaction cannot handle. The end of an unterminated block
 * is unknowable — the key material runs to the end of the string, or stops
 * somewhere a parser cannot see — so there is no span that safely covers it
 * and nothing less than refusing the whole write is honest.
 */
export function hasUnterminatedPrivateKey(text: string): boolean {
  const blocks = findPrivateKeyBlocks(text);
  return [...text.matchAll(PRIVATE_KEY_BEGIN)].some(
    (begin) => !blocks.some((block) => begin.index >= block.start && begin.index < block.end),
  );
}

/** Three base64url segments, which is a JWT's shape but not yet proof. */
const JWT_SHAPE = /\b[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/dg;

/**
 * Whether a candidate really is a JWT.
 *
 * Shape alone matches `1.2.3-alpha.build.7`, so the header is decoded and
 * required to be a JSON object naming an algorithm.
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

export function findJwtSpans(text: string): Span[] {
  return [...text.matchAll(JWT_SHAPE)]
    .filter((match) => isJwt(match[0]))
    .map((match) => ({ start: match.index, end: match.index + match[0].length }));
}

/** Authentication schemes that are followed by a credential. */
const AUTH_SCHEMES = /^(?:bearer|basic|digest|token)$/i;

const AUTHORIZATION_LINE = /(?:^|\n)[ \t]*authorization[ \t]*:[ \t]*([^\n]*)/dgi;
const BARE_SCHEME = /(?:^|[\s"'([])(bearer|basic|digest)[ \t]+(\S+)/dgi;

/** Trailing punctuation belongs to the sentence, not to the credential. */
function trimTrailingPunctuation(token: string): string {
  return token.replace(/[.,;:!?)\]}"']+$/, '');
}

/**
 * The credential inside an `Authorization` header, or after a bare scheme.
 *
 * Parsed rather than pattern-matched: "the line exists" is not the same claim
 * as "a credential is present". `Authorization: disabled` names no scheme,
 * `Authorization: Bearer` carries nothing, and `Authorization: Bearer
 * [REDACTED]` is something already cleaned.
 *
 * The header form trusts its own context, so a word-shaped credential still
 * counts. The bare form has none — `Bearer` is an ordinary English word — so
 * it additionally requires the token to read like a credential.
 */
export function findAuthorizationSpans(text: string): Span[] {
  const spans: Span[] = [];

  for (const match of text.matchAll(AUTHORIZATION_LINE)) {
    const rest = match[1];
    const at = match.indices?.[1]?.[0];
    if (rest === undefined || at === undefined) {
      continue;
    }
    const parsed = /^([ \t]*)(\S+)([ \t]+)(\S+)/.exec(rest);
    const scheme = parsed?.[2];
    const credential = parsed?.[4];
    if (
      parsed === undefined ||
      parsed === null ||
      scheme === undefined ||
      credential === undefined
    ) {
      continue;
    }
    if (!AUTH_SCHEMES.test(scheme) || readContent(credential) !== 'value') {
      continue;
    }
    const start = at + (parsed[1]?.length ?? 0) + scheme.length + (parsed[3]?.length ?? 0);
    spans.push({ start, end: start + credential.length });
  }

  for (const match of text.matchAll(BARE_SCHEME)) {
    const raw = match[2];
    const at = match.indices?.[2]?.[0];
    if (raw === undefined || at === undefined) {
      continue;
    }
    const credential = trimTrailingPunctuation(raw);
    if (readContent(credential) !== 'value' || !looksLikeCredentialValue(credential)) {
      continue;
    }
    spans.push({ start: at, end: at + credential.length });
  }

  return spans;
}

const COOKIE_LINE = /(?:^|\n)[ \t]*(set-)?cookie[ \t]*:[ \t]*([^\n]*)/dgi;

/**
 * Attributes of a `Set-Cookie`, which are not credentials.
 *
 * `Set-Cookie: sid=abc; Path=/; Max-Age=3600` carries exactly one credential —
 * the first pair. Everything after it describes how the browser should treat
 * the cookie, and an earlier version read `Path=/` as a second cookie value
 * and refused the whole string. A caller who writes down a redacted
 * `Set-Cookie` line should not have it refused for the path it kept.
 *
 * A plain `Cookie:` request header is different: every pair in it is a cookie
 * the client is sending, so every value counts.
 */
export function findCookieValueSpans(text: string): Span[] {
  const spans: Span[] = [];

  for (const match of text.matchAll(COOKIE_LINE)) {
    const isSetCookie = match[1] !== undefined;
    const list = match[2];
    const listStart = match.indices?.[2]?.[0];
    if (list === undefined || listStart === undefined) {
      continue;
    }

    let offset = 0;
    for (const [index, pair] of list.split(';').entries()) {
      const pairStart = listStart + offset;
      offset += pair.length + 1;

      // Only the first pair of a `Set-Cookie` is the cookie itself.
      if (isSetCookie && index > 0) {
        continue;
      }

      const separator = pair.indexOf('=');
      if (separator <= 0) {
        continue;
      }
      const rawValue = pair.slice(separator + 1);
      const leading = rawValue.length - rawValue.trimStart().length;
      const value = rawValue.trim();
      if (readContent(value) !== 'value') {
        continue;
      }
      const start = pairStart + separator + 1 + leading;
      spans.push({ start, end: start + value.length });
    }
  }

  return spans;
}

/**
 * `NAME=value` or `NAME: value`, where the name means credential.
 *
 * A quoted value is taken whole, spaces included: a passphrase is allowed to
 * contain them, and `PASSWORD="correct horse battery staple"` is exactly the
 * kind of credential that reads least like one.
 */
const ASSIGNMENT =
  /(?:^|[\s,;{("'])([A-Za-z][A-Za-z0-9_.-]{1,60})[ \t]*([:=])[ \t]*("[^"]*"|'[^']*'|\S+)/dg;

/**
 * Header names that have a parser of their own above.
 *
 * Reading `Authorization: Bearer [REDACTED]` a second time as `NAME: value`
 * gets the wrong answer — the "value" is the scheme. Each line is judged once.
 * Only for the `:` form; `authorization=rawtoken` is a variable assignment.
 */
const HEADER_NAMES: ReadonlySet<string> = new Set(['authorization', 'cookie', 'setcookie']);

function unquote(value: string): string {
  const quoted = /^(["'])(.*)\1$/s.exec(value);
  return quoted?.[2] ?? value;
}

export function findAssignmentValues(text: string): CredentialSpan[] {
  const found: CredentialSpan[] = [];

  for (const match of text.matchAll(ASSIGNMENT)) {
    const name = match[1];
    const separator = match[2];
    const value = match[3];
    const at = match.indices?.[3];
    if (name === undefined || value === undefined || at === undefined) {
      continue;
    }
    if (separator === ':' && HEADER_NAMES.has(normaliseName(name))) {
      continue;
    }

    const certainty = certaintyFor(nameStrength(name), unquote(value));
    if (certainty !== null) {
      found.push({ span: { start: at[0], end: at[1] }, certainty });
    }
  }

  return found;
}

// ---- span arithmetic -------------------------------------------------------

/** Merges overlapping and touching spans into the smallest covering set. */
export function mergeSpans(spans: readonly Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const merged: Span[] = [];

  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.start <= last.end) {
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, span.end) };
      continue;
    }
    merged.push(span);
  }

  return merged;
}

/** Replaces every span with the marker, working backwards so offsets hold. */
export function replaceSpans(text: string, spans: readonly Span[]): string {
  let result = text;
  for (const span of [...mergeSpans(spans)].reverse()) {
    result = result.slice(0, span.start) + REDACTION_MARKER + result.slice(span.end);
  }
  return result;
}
