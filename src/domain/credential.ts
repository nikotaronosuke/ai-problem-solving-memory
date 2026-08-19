/**
 * What a Memory credential looks like, and what may be kept of one.
 *
 * A token is two halves joined by a prefix:
 *
 *     mem_<lookup>.<secret>
 *
 * The `lookup` is a public selector. It is stored in the clear, indexed, and
 * proves nothing on its own — its only job is to find one row in one query so
 * that verifying the secret is a single comparison against a single candidate.
 * Finding a lookup value in the database is not a leak.
 *
 * The `secret` is 256 bits of randomness and is never stored. What the server
 * keeps is its SHA-256 digest, and the token itself exists exactly once: in
 * the output of the command that issued it. Losing it means issuing another,
 * which is why a client may hold several.
 *
 * SHA-256 rather than a password KDF, deliberately. Argon2 and scrypt exist to
 * make guessing expensive when the input is something a human chose; this
 * input is 32 random bytes, where guessing is not a strategy at any cost per
 * attempt. A KDF here would buy nothing and charge for it on every request.
 *
 * Parsing is strict and total. A token is the whole string or it is not a
 * token: no surrounding whitespace, no extra segments, no near-miss lengths.
 * Anything lenient here becomes an accepted shape somewhere later.
 *
 * ## Why the halves are joined by a dot
 *
 * They used to be joined by an underscore, and an underscore is itself a legal
 * base64url character. That made the grammar ambiguous rather than merely ugly:
 * a token rendered with its halves swapped was *accepted* whenever the original
 * secret happened to carry an underscore at index 16, because the fixed lengths
 * could then re-align around it — 1 in 64 of all issued tokens, measured at
 * 7833 of 500000.
 *
 * A dot cannot appear in either half, so there is exactly one way to cut the
 * string and a swapped rendering fails on length alone. The refusal is
 * structural; no probability is involved, and no parser cleverness could have
 * supplied it while the delimiter stayed inside the payload alphabet.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';

declare const credentialIdBrand: unique symbol;

/** Identifies one credential row. Not a secret and not a token. */
export type CredentialId = string & { readonly [credentialIdBrand]: 'CredentialId' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Raised when a value cannot be a credential id. */
export class InvalidCredentialIdError extends Error {
  constructor(detail: string) {
    super(`Not a usable credential id: ${detail}`);
    this.name = 'InvalidCredentialIdError';
  }
}

export function toCredentialId(value: string): CredentialId {
  const trimmed = value.trim();
  if (!UUID.test(trimmed)) {
    throw new InvalidCredentialIdError('it is not a UUID');
  }
  return trimmed.toLowerCase() as CredentialId;
}

export function generateCredentialId(): CredentialId {
  return randomUUID() as CredentialId;
}

/** Marks a Memory-issued token, so an unrelated bearer value is refused early. */
export const TOKEN_PREFIX = 'mem';

/**
 * What separates the halves, and the whole of why they can be told apart.
 *
 * Outside the base64url alphabet on purpose: a delimiter a payload can contain
 * is not a delimiter. Defined once, so the parser and the formatter cannot
 * disagree about where one half ends.
 */
const TOKEN_DELIMITER = '.';

/** Bytes behind each half. The rendered lengths below follow from these. */
const LOOKUP_BYTES = 12;
const SECRET_BYTES = 32;

/** Rendered lengths: base64url of 12 and 32 bytes, unpadded. */
export const LOOKUP_LENGTH = 16;
export const SECRET_LENGTH = 43;

/**
 * The one shape a token may have.
 *
 * Anchored at both ends, so trailing whitespace or an extra segment is a
 * different string rather than a tolerated variation.
 */
const TOKEN = new RegExp(
  `^${TOKEN_PREFIX}_([A-Za-z0-9_-]{${String(LOOKUP_LENGTH)}})[${TOKEN_DELIMITER}]([A-Za-z0-9_-]{${String(SECRET_LENGTH)}})$`,
);

/** The two halves of a presented token. */
export interface CredentialToken {
  /** Public selector, safe to store and to index. */
  readonly lookup: string;
  /** The half that proves anything. Never stored, never logged. */
  readonly secret: string;
}

/** Raised when a presented string is not a Memory token. */
export class InvalidCredentialTokenError extends Error {
  constructor() {
    // No detail, and none available to give: the string this was raised about
    // is a credential someone typed, and saying which part was wrong would
    // both narrow a guess and put the value one careless line from a log.
    super('Not a Memory credential token.');
    this.name = 'InvalidCredentialTokenError';
  }
}

/** Issues a new token. The only place a secret comes into existence. */
export function generateCredentialToken(): CredentialToken {
  return {
    lookup: randomBytes(LOOKUP_BYTES).toString('base64url'),
    secret: randomBytes(SECRET_BYTES).toString('base64url'),
  };
}

/** Renders a token for the one moment it is shown to a person. */
export function formatCredentialToken(token: CredentialToken): string {
  return `${TOKEN_PREFIX}_${token.lookup}${TOKEN_DELIMITER}${token.secret}`;
}

/**
 * Reads a presented token, or refuses it.
 *
 * Total and side-effect free: same input, same answer, no database and no
 * clock. Whether the credential exists is a separate question asked later.
 */
export function parseCredentialToken(presented: string): CredentialToken {
  const match = TOKEN.exec(presented);
  const lookup = match?.[1];
  const secret = match?.[2];
  if (lookup === undefined || secret === undefined) {
    throw new InvalidCredentialTokenError();
  }
  return { lookup, secret };
}

/**
 * The digest a row holds in place of the secret.
 *
 * Thirty-two bytes, which the table checks, so a row that could never match
 * anything cannot be written by mistake.
 */
export function hashCredentialSecret(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}
