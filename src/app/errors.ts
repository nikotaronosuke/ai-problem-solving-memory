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
