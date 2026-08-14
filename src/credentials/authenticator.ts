/**
 * Turning a presented credential into a client and an owner.
 *
 * Five things have to be true, and every one of them is checked here:
 *
 *   1. a credential was presented at all,
 *   2. it is a Memory token, in the one shape a Memory token has,
 *   3. its public selector finds a row,
 *   4. that row has not been revoked,
 *   5. and the secret half matches the digest that row holds.
 *
 * Step five is the one that does the work, and it is worth saying why the
 * others are not enough. The selector is stored in the clear and is not a
 * secret; anyone who has seen a token knows a valid one. Accepting a request
 * because the lookup matched would mean the secret half had no purpose, and
 * the failure would look exactly like success. A regression test presents a
 * real lookup with a different well-formed secret for precisely that reason.
 *
 * The comparison is constant-time. Both sides are 32-byte digests by
 * construction — the column is checked to be — so the lengths always agree and
 * the timing of a comparison says nothing about how much of it matched.
 *
 * Every failure is the same failure to a client. Distinguishing "no such
 * credential" from "revoked" from "wrong secret" would answer questions about
 * credentials the caller does not hold, and the reasons below exist only so an
 * operator reading a log can tell them apart. They are a closed set, and no
 * part of a presented token goes anywhere near them.
 */

import { timingSafeEqual } from 'node:crypto';

import type { CredentialRepository } from './repository.js';
import type { ClientId } from '../domain/client.js';
import {
  hashCredentialSecret,
  InvalidCredentialTokenError,
  parseCredentialToken,
} from '../domain/credential.js';
import type { OwnerId } from '../domain/owner.js';

/**
 * Why authentication failed, for the server's own record.
 *
 * A closed set, never free text. P3-01 through P3-03 established the rule the
 * hard way: any string an outside party can influence eventually reaches a log,
 * so a failure carries an identifier the server chose and nothing else.
 */
export type AuthenticationFailure =
  /** No credential was presented. */
  | 'MISSING'
  /** Presented, but not a Memory token. */
  | 'MALFORMED'
  /** Well-formed, but its selector matches no row. */
  | 'UNKNOWN'
  /** Selector matched, secret did not. */
  | 'INVALID'
  /** Matched a credential that has been revoked. */
  | 'REVOKED';

/** Raised when a request cannot be attributed to a client. */
export class CredentialAuthenticationError extends Error {
  readonly reason: AuthenticationFailure;

  constructor(reason: AuthenticationFailure) {
    // The message is built from the reason alone. Nothing derived from what
    // was presented appears in it, so the error is safe wherever it lands.
    super(`Authentication failed (${reason}).`);
    this.name = 'CredentialAuthenticationError';
    this.reason = reason;
  }
}

/** Who a verified credential speaks for. Contains nothing secret. */
export interface AuthenticatedPrincipal {
  readonly clientId: ClientId;
  readonly ownerId: OwnerId;
}

export interface CredentialAuthenticator {
  /**
   * Verifies an `Authorization` header value.
   *
   * Takes the raw header rather than a parsed token so that the whole
   * business of reading a credential lives in one place, and so no route or
   * service ever holds one.
   */
  authenticate(authorizationHeader: string | undefined): Promise<AuthenticatedPrincipal>;
}

/**
 * `Bearer <token>`, with the scheme matched case-insensitively.
 *
 * HTTP says the scheme is case-insensitive, so `bearer` is accepted. The token
 * itself is not treated leniently: it is passed to the parser exactly as sent,
 * and the parser is anchored.
 */
const BEARER = /^Bearer[ \t]+(\S+)$/i;

export function createCredentialAuthenticator(
  repository: CredentialRepository,
): CredentialAuthenticator {
  return {
    async authenticate(authorizationHeader) {
      if (authorizationHeader === undefined || authorizationHeader.trim() === '') {
        throw new CredentialAuthenticationError('MISSING');
      }

      const bearer = BEARER.exec(authorizationHeader.trim())?.[1];
      if (bearer === undefined) {
        throw new CredentialAuthenticationError('MALFORMED');
      }

      let token;
      try {
        token = parseCredentialToken(bearer);
      } catch (error) {
        if (error instanceof InvalidCredentialTokenError) {
          throw new CredentialAuthenticationError('MALFORMED');
        }
        throw error;
      }

      // Read on every request. Nothing about a credential is cached anywhere,
      // which is what makes revocation take effect on the next call rather
      // than at the next restart.
      const found = await repository.findByLookup(token.lookup);
      if (found === undefined) {
        throw new CredentialAuthenticationError('UNKNOWN');
      }
      if (found.revokedAt !== null) {
        throw new CredentialAuthenticationError('REVOKED');
      }

      const presented = hashCredentialSecret(token.secret);
      if (
        presented.length !== found.tokenHash.length ||
        !timingSafeEqual(presented, found.tokenHash)
      ) {
        throw new CredentialAuthenticationError('INVALID');
      }

      return { clientId: found.clientId, ownerId: found.ownerId };
    },
  };
}
