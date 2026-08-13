/**
 * Establishing who a request acts as.
 *
 * A route handler never resolves an owner and never sees an owner id it could
 * pass somewhere. It asks for a context and receives an owner-scoped
 * repository — already bound, with no argument that could name someone else.
 *
 * How the owner is identified is deliberately behind this one function. In
 * this phase it comes from `MEMORY_OWNER_ID`, the same local development
 * identity Phase 1 established. When real client credentials arrive in P3-04,
 * the resolver changes here and route handlers do not change at all.
 *
 * Two things this is not:
 *
 * An owner id is not a credential. Nothing accepts an owner id from a header
 * or a body and treats the request as authenticated on that basis — knowing an
 * identifier is not the same as being that person, and wiring it up "just for
 * now" is how that distinction gets lost.
 *
 * The reason a context could not be established does not leave this module in
 * a form a client can read. Missing, malformed and unknown are three different
 * failures to an operator reading the log, and one indistinguishable rejection
 * to a client — otherwise the endpoint answers "does this owner exist?" for
 * anyone who asks.
 */

import type { EnvSource } from '../config/env.js';
import type { DatabaseExecutor } from '../db/executor.js';
import type { DatabaseTransactionRunner } from '../db/transaction.js';
import { resolveOwnerContext } from '../owner/context.js';
import { createMemoryRepository, type MemoryRepository } from '../repository/index.js';
import {
  createSecretDetectionPolicy,
  withSanitization,
  type SanitizationPolicy,
} from '../sanitization/index.js';

/**
 * A request that has an established owner.
 *
 * Carries the repository rather than an id, so owner scope is a thing you
 * hold, not a value you remember to pass.
 */
export interface AuthenticatedRequestContext {
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

/** Raised when no owner could be established for a request. */
export class RequestContextUnavailableError extends Error {
  /** For the server log only. Never rendered into a response. */
  readonly internalReason: string;

  constructor(internalReason: string) {
    super('No owner context could be established for this request.');
    this.name = 'RequestContextUnavailableError';
    this.internalReason = internalReason;
  }
}

export interface RequestContextService {
  authenticate(): Promise<AuthenticatedRequestContext>;
}

/**
 * Builds the request-context service.
 *
 * `executor` is whatever can run a statement, and `transactionRunner` is what
 * turns several statements into one. Both are required: a context that could
 * not start a transaction would have to fail at the moment a service tried,
 * which is far too late to notice.
 *
 * The owner is resolved once and closed over, so the transactional repository
 * is the same scope as the ordinary one by construction rather than by a
 * caller remembering to pass the same context twice.
 *
 * `policy` is the sanitization policy every write is checked against. It
 * defaults to secret detection, so a server built without saying anything about
 * sanitization is checked rather than open — the direction a default should
 * fail in when the alternative is storing a credential.
 *
 * P3-01 installed the boundary, P3-02 supplies this detector, and P3-03 will
 * decide refusal and redaction in full. Each arrives by passing a different
 * policy here rather than by moving where the check happens.
 */
export function createRequestContextService(
  executor: DatabaseExecutor,
  transactionRunner: DatabaseTransactionRunner,
  source: EnvSource = process.env,
  policy: SanitizationPolicy = createSecretDetectionPolicy(),
): RequestContextService {
  return {
    async authenticate(): Promise<AuthenticatedRequestContext> {
      let ownerContext;
      try {
        ownerContext = await resolveOwnerContext(executor, source);
      } catch (error) {
        // The distinction between missing, malformed and unknown is kept for
        // the log and collapsed for the caller.
        const internalReason = error instanceof Error ? error.message : 'owner resolution failed';
        throw new RequestContextUnavailableError(internalReason);
      }

      // Both repositories are wrapped, and this is the only place either is
      // built. A service receives a repository and never constructs one, so
      // the boundary is on the path of every write there is — including the
      // transactional path, where forgetting it would leave exactly the writes
      // that matter most unchecked.
      return {
        repository: withSanitization(createMemoryRepository(executor, ownerContext), policy),
        runInTransaction: (work) =>
          transactionRunner.run((transactional) =>
            work(withSanitization(createMemoryRepository(transactional, ownerContext), policy)),
          ),
      };
    },
  };
}
