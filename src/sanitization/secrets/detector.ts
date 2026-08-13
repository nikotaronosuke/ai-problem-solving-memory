/**
 * Recognising a credential, and nothing else.
 *
 * This module decides what a secret is. It does not decide what happens to
 * one — that is the policy next to it, and keeping the two apart is what lets
 * P3-03 change the response without reopening the question of what was found.
 *
 * The organising rule is that a string is a secret because of what it *means*,
 * never because of how it looks in isolation. There is no entropy score and no
 * length threshold, deliberately: "long random-looking string" describes a
 * UUID, a commit SHA, a content hash, a database id and half the identifiers in
 * this system, and a detector built on it would refuse the evidence references
 * that make a Memory worth keeping. Every rule below needs a signal that says
 * *credential* — a PEM header, a decodable JWT, an `Authorization` line, a
 * credential-named variable, or a credential-named field in the caller's own
 * structure.
 *
 * That choice has a known cost, and it is the honest one: a bare secret with no
 * context — a raw API key pasted alone into a summary field, with nothing
 * naming it — is not detected here. Catching it would mean guessing from shape,
 * and guessing from shape is what produces the false refusals that make people
 * stop recording things. The specification's answer to this is defence in
 * depth: the adapter sanitises before sending, and this is the server-side
 * re-check. This is the re-check, not the only check.
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
 * Field and variable names that mean "the value here is a credential".
 *
 * Matched against a normalised form — lowercased with `-`, `_` and spaces
 * removed — so `API_KEY`, `api-key` and `apiKey` are one entry. Compared whole
 * rather than as substrings, so `tokenizer` and `passwordless` are not names of
 * credentials.
 */
const CREDENTIAL_NAMES: ReadonlySet<string> = new Set([
  'password',
  'passwd',
  'pwd',
  'passphrase',
  'secret',
  'clientsecret',
  'apikey',
  'apisecret',
  'accesskey',
  'secretkey',
  'accesstoken',
  'refreshtoken',
  'authtoken',
  'idtoken',
  'sessiontoken',
  'securitytoken',
  'sessionid',
  'session',
  'token',
  'authorization',
  'cookie',
  'setcookie',
  'privatekey',
  'credential',
  'credentials',
]);

/**
 * Endings that make a compound name a credential name.
 *
 * `db_password`, `github_token` and `stripe_api_key` are all credentials, and
 * enumerating every prefix anyone might use is the dictionary this file exists
 * to avoid. Suffixes are specific enough that `token_count` and `secretary` do
 * not match.
 */
const CREDENTIAL_NAME_SUFFIXES: readonly string[] = [
  'password',
  'passphrase',
  'secret',
  'apikey',
  'token',
  'privatekey',
  'credential',
];

/**
 * Values that are already standing in for a secret rather than being one.
 *
 * A configuration template, a documentation example and the output of someone
 * else's redaction all look like credentials by context and contain nothing
 * worth protecting. Refusing them would refuse the very act of writing down
 * that a credential was involved.
 */
const REDACTION_PLACEHOLDERS =
  /^(?:\[?redacted\]?|\*+|x+|<[^>]*>|\.{3,}|-+|_+|change[_-]?me|your[_-]?\w+[_-]?here|todo|tbd|n\/a|none|null|nil|undefined|example|placeholder|replace[_-]?with[_-]?\w*)$/i;

/** Normalises a field or variable name for comparison. */
function normaliseName(name: string): string {
  return name.toLowerCase().replace(/[\s_-]/g, '');
}

function isCredentialName(name: string): boolean {
  const normalised = normaliseName(name);
  // A plural names the same thing: `api_keys` holds api keys. Checked as a
  // separate form rather than by stripping trailing letters generally, which
  // would start matching names that merely end in the right letters.
  const singular = normalised.endsWith('s') ? normalised.slice(0, -1) : normalised;

  for (const candidate of new Set([normalised, singular])) {
    if (CREDENTIAL_NAMES.has(candidate)) {
      return true;
    }
    if (
      CREDENTIAL_NAME_SUFFIXES.some(
        (suffix) => candidate.endsWith(suffix) && candidate.length > suffix.length,
      )
    ) {
      return true;
    }
  }
  return false;
}

function isPlaceholder(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === '' || REDACTION_PLACEHOLDERS.test(trimmed);
}

/**
 * Whether a string reads like a value rather than a word.
 *
 * This is the discriminator that keeps `password: unknown` and `token: expired`
 * from being refused while `PASSWORD=hunter2` is. A credential is typically not
 * a lowercase English word: it carries a digit, punctuation, mixed case, or
 * enough length that no word is plausible. None of that is an entropy measure
 * and none of it fires on its own — it only ever narrows something a credential
 * name already pointed at.
 */
function looksLikeCredentialValue(text: string): boolean {
  if (/\s/.test(text) || text.length < 6 || isPlaceholder(text)) {
    return false;
  }
  return (
    /\d/.test(text) ||
    /[^A-Za-z0-9]/.test(text) ||
    (/[a-z]/.test(text) && /[A-Z]/.test(text)) ||
    text.length >= 20
  );
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

/**
 * An `Authorization` header, or a bare scheme and credential.
 *
 * The credential must be long enough not to be the word after "bearer" in a
 * sentence — "use a Bearer token to authenticate" says `token`, which is short
 * and followed by a space.
 */
const AUTHORIZATION_HEADER =
  /(?:^|\n)\s*authorization\s*:\s*\S+|(?:^|[\s"'([])(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}/i;

/** A `Cookie:` or `Set-Cookie:` header line carrying an actual pair. */
const COOKIE_HEADER = /(?:^|\n)\s*(?:set-)?cookie\s*:\s*[^\s=]+=[^\s;]+/i;

/**
 * `NAME=value` or `NAME: value`, where the name means credential.
 *
 * Anchored to a line start or a separator so that prose mentioning a password
 * does not match, and applied per match so a multi-line `.env` paste is covered
 * line by line without a separate rule for it.
 */
const ASSIGNMENT = /(?:^|[\s,;{("'])([A-Za-z][A-Za-z0-9_.-]{1,60})\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/g;

function unquote(value: string): string {
  const quoted = /^(["'])(.*)\1$/s.exec(value);
  return quoted?.[2] ?? value;
}

function containsCredentialAssignment(text: string): boolean {
  for (const match of text.matchAll(ASSIGNMENT)) {
    const name = match[1];
    const value = match[2];
    if (name === undefined || value === undefined) {
      continue;
    }
    if (isCredentialName(name) && looksLikeCredentialValue(unquote(value))) {
      return true;
    }
  }
  return false;
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
      if (AUTHORIZATION_HEADER.test(text)) {
        return { category: 'AUTHORIZATION', certainty: 'confirmed' };
      }
      if (COOKIE_HEADER.test(text)) {
        return { category: 'COOKIE', certainty: 'confirmed' };
      }
      if (containsCredentialAssignment(text)) {
        return { category: 'CREDENTIAL_ASSIGNMENT', certainty: 'confirmed' };
      }

      // Then the caller's own structure. A key naming a credential is a
      // statement about the value under it, which is how
      // `{"api_key": "9f2c..."}` is recognised without the value having any
      // recognisable form of its own.
      //
      // Only for values: applying it to a key would ask whether the key's own
      // parent named a credential, which says nothing about the key text.
      if (at.kind === 'value') {
        const name = nearestKey(at.path);
        if (name !== undefined && isCredentialName(name) && !isPlaceholder(text)) {
          return {
            category: 'CREDENTIAL_FIELD',
            certainty: looksLikeCredentialValue(text) ? 'confirmed' : 'suspected',
          };
        }
      }

      return null;
    },
  };
}
