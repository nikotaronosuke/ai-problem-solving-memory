/**
 * Failures the application layer reports to whatever is calling it.
 *
 * Transport maps these to status codes and knows nothing about PostgreSQL,
 * the repository, or which of them actually failed. That is the point: if
 * transport had to recognise a driver error, the driver would be part of the
 * HTTP contract.
 */

/**
 * The resource is not available to this owner.
 *
 * Deliberately one error for two situations — the resource does not exist, or
 * it belongs to someone else. Telling them apart would answer "does this id
 * exist?" for anyone who asks, which is the same existence oracle the storage
 * layer was careful to avoid.
 */
export class ResourceNotFoundError extends Error {
  constructor() {
    super('No such resource for this owner.');
    this.name = 'ResourceNotFoundError';
  }
}

/**
 * The request was well-formed for the transport but meaningless as an
 * operation — an update that changes nothing, for instance.
 *
 * Schema validation catches most bad input before it reaches here. This covers
 * what a schema cannot express.
 */
export class InvalidApplicationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidApplicationInputError';
  }
}

/**
 * The problem changed since the caller last read it.
 *
 * Raised when a write names a version the problem is no longer at. The write
 * did not happen and nothing was partially applied.
 *
 * Distinct from `ResourceNotFoundError` on purpose, and reachable only after
 * the problem has been confirmed to be this owner's. A conflict answered for a
 * problem someone does not own would say "this exists, you just guessed the
 * version wrong" — the existence oracle every other decision here avoids.
 *
 * It carries no version number. A client that gets one already knows what it
 * sent, and can re-read the problem to see where things stand; reporting the
 * current version would hand out a fact about a record rather than about the
 * request.
 */
export class ProblemVersionConflictError extends Error {
  constructor() {
    super('The problem has changed since it was read.');
    this.name = 'ProblemVersionConflictError';
  }
}

/**
 * Raised when an export would carry a credential out of the system.
 *
 * Not a version conflict and not a bad request: the request is correct and the
 * server is working. What is wrong is the state of the Memory — it holds
 * something that must not leave in a file — and the owner can fix it, with the
 * delete path P3-05 built.
 *
 * Carries nothing. No locator, no field, no category, no fragment of what was
 * found. An error that named where the credential was would put a map to it in
 * a response, and the response is exactly the thing being kept clean.
 */
export class ExportBlockedError extends Error {
  constructor() {
    super('Export refused: the memory holds a credential.');
    this.name = 'ExportBlockedError';
  }
}
