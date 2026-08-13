/**
 * Errors shared by the append paths.
 *
 * Events and Verifications are separate kinds of write reaching for the same
 * failure. It lives here rather than in one of the two modules so that neither
 * has to depend on the other.
 *
 * There used to be a second one, raised when a `client_event_id` had already
 * been used. Both append paths now return the original record instead — P2-04
 * for Events, P2-05 for Verifications — so nothing raised it any more and it
 * was removed. The `(owner_id, client_event_id)` unique constraints are
 * untouched: they are what makes the replay safe, and a direct insert past the
 * append path is still refused by the database.
 */

/**
 * Raised when the target problem is not one of the context owner's.
 *
 * Deliberately the same error whether the problem does not exist at all or
 * belongs to someone else, so the outcome cannot be used to discover whether
 * someone else's problem id is real.
 */
export class ProblemNotAvailableError extends Error {
  constructor() {
    super('No such problem for this owner.');
    this.name = 'ProblemNotAvailableError';
  }
}

/** Whether an error is PostgreSQL rejecting a specific constraint. */
export function violatesConstraint(error: unknown, code: string, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === code && candidate.constraint === constraint;
}

/** PostgreSQL error code for a foreign key violation. */
export const FOREIGN_KEY_VIOLATION = '23503';

/** PostgreSQL error code for a unique constraint violation. */
export const UNIQUE_VIOLATION = '23505';
