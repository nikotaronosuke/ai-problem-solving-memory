/**
 * Errors shared by the append paths.
 *
 * Events and Verifications are separate kinds of write with the same two
 * failure modes. They live here rather than in one of the two modules so that
 * neither has to depend on the other.
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

/**
 * Raised when this owner has already recorded a write with the same
 * `client_event_id`.
 *
 * The namespace is per table: an Event and a Verification may each carry the
 * same value, since they are separate writes.
 *
 * Only Verifications raise this now. P2-04 replaced the Event rejection with
 * returning the original event, so an Event retry is a no-op rather than an
 * error; P2-05 does the same for Verifications. Until then the two behave
 * differently on purpose, and this stays because the Verification path still
 * needs it.
 */
export class DuplicateClientEventIdError extends Error {
  constructor() {
    super('This client event id has already been recorded for this owner.');
    this.name = 'DuplicateClientEventIdError';
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
