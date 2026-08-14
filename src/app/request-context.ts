/**
 * Establishing who a request acts as.
 *
 * A route handler never resolves an owner and never sees an owner id it could
 * pass somewhere. It asks for a context and receives an owner-scoped
 * repository — already bound, with no argument that could name someone else.
 *
 * Since P3-04 that context comes from a credential and from nothing else:
 *
 *     Authorization: Bearer mem_…
 *         → the credential is verified
 *         → which names a client
 *         → which belongs to an owner
 *         → whose existence is confirmed
 *         → and only then is a repository handed out
 *
 * There is no other way in. The environment used to establish an HTTP context
 * and deliberately no longer can: knowing an owner's identifier is not the same
 * as holding a credential for it, and a fallback that quietly accepted the
 * former would make an identifier that lives in configuration files into a
 * password that cannot be revoked. That identifier remains what it always was
 * for local tooling — bootstrap, issuing and revoking credentials — and has no
 * route into this function.
 *
 * Two things this is still not:
 *
 * An owner id is not a credential. Nothing accepts one from a header or a body
 * and treats the request as authenticated on that basis.
 *
 * The reason a context could not be established does not leave this module in
 * a form a client can read. Missing, malformed, unknown, wrong and revoked are
 * five different failures to an operator reading a log, and one
 * indistinguishable rejection to a client — otherwise the endpoint answers
 * questions about credentials the caller does not hold.
 */

import type { CredentialAuthenticator } from '../credentials/index.js';
import { CredentialAuthenticationError } from '../credentials/index.js';
import type { DatabaseExecutor } from '../db/executor.js';
import type { DatabaseTransactionRunner } from '../db/transaction.js';
import type { ClientId } from '../domain/client.js';
import { resolveOwnerContextFor } from '../owner/context.js';
import { createMemoryRepository, type MemoryRepository } from '../repository/index.js';
import {
  createSecretDetectionPolicy,
  withSanitization,
  type SanitizationPolicy,
} from '../sanitization/index.js';

/**
 * A request that has an established owner.
 *
 * Carries the repository rather than an owner id, so owner scope is a thing
 * you hold rather than a value you remember to pass.
 *
 * `clientId` is the exception, and it is not an owner: it says which
 * connection this request came through. Nothing consults it yet. It is here so
 * that when read, write and delete permissions are decided per client, the
 * decision has somewhere to be made rather than requiring the whole
 * authentication path to be rethreaded — and because "which client did this"
 * is the question an audit trail will eventually ask.
 */
export interface AuthenticatedRequestContext {
  readonly clientId: ClientId;

  readonly repository: MemoryRepository;

  /**
   * Runs work as one transaction, against a repository bound to the same
   * owner.
   *
   * The repository handed in is the same scope as `repository` but on a
   * single connection, so several writes commit or roll back together.
   * Throwing rolls back — which is how a service refuses partway through, and
   * also what happens if something unexpected fails.
   *
   * Deliberately owner-scoped rather than exposing the transaction itself: a
   * service still cannot name an owner, and still has no way to reach a
   * connection or a driver type.
   */
  runInTransaction<T>(work: (repository: MemoryRepository) => Promise<T>): Promise<T>;
}

/**
 * Why no owner context could be established, for the server's own record.
 *
 * The five authentication failures, plus the two this layer adds. A closed set
 * rather than a `string`: P3-04 established that the reason must not be built
 * from what was presented, and P3-10 finished the job by removing the type's
 * permission to be free text at all. The previous signature took a `string`,
 * and one call site had already used it for a sentence — harmless in itself,
 * and exactly the shape a caller-derived value would arrive in.
 */
export const REQUEST_CONTEXT_FAILURES = [
  /** No credential was presented. */
  'MISSING',
  /** Presented, but not a Memory token. */
  'MALFORMED',
  /** Well-formed, but its selector matches no row. */
  'UNKNOWN',
  /** Selector matched, secret did not. */
  'INVALID',
  /** Matched a credential that has been revoked. */
  'REVOKED',
  /** The credential named an owner that is no longer there. */
  'OWNER_UNAVAILABLE',
  /** A handler ran without the hook that should have preceded it. */
  'CONTEXT_NOT_ESTABLISHED',
] as const;

export type RequestContextFailure = (typeof REQUEST_CONTEXT_FAILURES)[number];

/** Raised when no owner could be established for a request. */
export class RequestContextUnavailableError extends Error {
  /**
   * For the server log only, and never rendered into a response.
   *
   * Since P3-04 this is filled from a closed set of authentication reasons
   * rather than from a message built at the failure site. The rule P3-01
   * through P3-03 arrived at the hard way is that any string an outside party
   * can influence eventually reaches a log, and a presented credential is the
   * most outside-influenced string there is.
   */
  readonly internalReason: RequestContextFailure;

  constructor(internalReason: RequestContextFailure) {
    super('No owner context could be established for this request.');
    this.name = 'RequestContextUnavailableError';
    this.internalReason = internalReason;
  }
}

export interface RequestContextService {
  /**
   * Verifies a request's credential and hands back its context.
   *
   * Takes the raw `Authorization` header, which is the only place a
   * credential is read. The header does not travel any further: routes and
   * services receive a context, never the value that produced it.
   */
  authenticate(authorizationHeader: string | undefined): Promise<AuthenticatedRequestContext>;
}

/**
 * Builds the request-context service.
 *
 * `executor` is whatever can run a statement, and `transactionRunner` is what
 * turns several statements into one. Both are required: a context that could
 * not start a transaction would have to fail at the moment a service tried,
 * which is far too late to notice.
 *
 * The owner is resolved once per request and closed over, so the transactional
 * repository is the same scope as the ordinary one by construction rather than
 * by a caller remembering to pass the same context twice.
 *
 * `policy` is the sanitization policy every write is checked against. It
 * defaults to secret detection, so a server built without saying anything
 * about sanitization is checked rather than open.
 */
export function createRequestContextService(
  executor: DatabaseExecutor,
  transactionRunner: DatabaseTransactionRunner,
  authenticator: CredentialAuthenticator,
  policy: SanitizationPolicy = createSecretDetectionPolicy(),
): RequestContextService {
  return {
    async authenticate(authorizationHeader): Promise<AuthenticatedRequestContext> {
      let principal;
      try {
        // Every request, against the database. Nothing about a credential is
        // held between requests, which is what makes a revocation take effect
        // on the next call rather than at the next restart.
        principal = await authenticator.authenticate(authorizationHeader);
      } catch (error) {
        if (error instanceof CredentialAuthenticationError) {
          // The reason is one of five identifiers this codebase chose. No part
          // of what was presented is in it.
          throw new RequestContextUnavailableError(error.reason);
        }
        throw error;
      }

      let ownerContext;
      try {
        // The credential named an owner; this confirms the owner is still
        // there. An id read out of a foreign key is not the same as a row, and
        // `OwnerContext` means somebody checked.
        ownerContext = await resolveOwnerContextFor(executor, principal.ownerId);
      } catch {
        throw new RequestContextUnavailableError('OWNER_UNAVAILABLE');
      }

      // Both repositories are wrapped, and this is the only place either is
      // built. A service receives a repository and never constructs one, so
      // the boundary is on the path of every write there is — including the
      // transactional path, where forgetting it would leave exactly the writes
      // that matter most unchecked.
      return {
        clientId: principal.clientId,
        repository: withSanitization(createMemoryRepository(executor, ownerContext), policy),
        runInTransaction: (work) =>
          transactionRunner.run((transactional) =>
            work(withSanitization(createMemoryRepository(transactional, ownerContext), policy)),
          ),
      };
    },
  };
}
