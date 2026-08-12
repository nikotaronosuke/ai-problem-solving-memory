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
import { resolveOwnerContext } from '../owner/context.js';
import { createMemoryRepository, type MemoryRepository } from '../repository/index.js';

/**
 * A request that has an established owner.
 *
 * Carries the repository rather than an id, so owner scope is a thing you
 * hold, not a value you remember to pass.
 */
export interface AuthenticatedRequestContext {
  readonly repository: MemoryRepository;
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
 * `executor` is whatever can run a statement, so a future transactional path
 * can supply a checked-out client without this changing.
 */
export function createRequestContextService(
  executor: DatabaseExecutor,
  source: EnvSource = process.env,
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

      return { repository: createMemoryRepository(executor, ownerContext) };
    },
  };
}
