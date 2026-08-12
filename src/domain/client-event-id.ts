/**
 * Client-issued write identifier.
 *
 * A client mints one of these before its first attempt to record something,
 * and reuses the same value if that attempt has to be retried. Two writes
 * carrying the same id are the same write, so a retry after an ambiguous
 * failure cannot register twice.
 *
 * Shared rather than per-entity: Verification writes need exactly the same
 * guarantee as Event writes, and one concept avoids two near-identical ones.
 *
 * The identifier is required. Anything that can record a write can generate a
 * UUID first, including manual entry, so there is no case for making it
 * optional and losing the protection.
 */

import { randomUUID } from 'node:crypto';

import { isNormalisedUuid, normaliseUuid } from './uuid.js';

declare const clientEventIdBrand: unique symbol;

/** A validated client write identifier. Always lowercase. */
export type ClientEventId = string & { readonly [clientEventIdBrand]: true };

/** Raised when a value cannot be a client event id. Never echoes the value. */
export class InvalidClientEventIdError extends Error {
  constructor(reason: string) {
    super(`Not a usable client event id: ${reason}.`);
    this.name = 'InvalidClientEventIdError';
  }
}

/** Whether a value is already a well-formed, normalised client event id. */
export function isClientEventId(value: unknown): value is ClientEventId {
  return isNormalisedUuid(value);
}

/** Validates a string as a client event id, normalising case and whitespace. */
export function toClientEventId(value: string): ClientEventId {
  if (value.trim() === '') {
    throw new InvalidClientEventIdError('it is empty');
  }

  const normalised = normaliseUuid(value);
  if (normalised === undefined) {
    throw new InvalidClientEventIdError('it is not a UUID');
  }

  return normalised as ClientEventId;
}

/**
 * Issues a new client event id.
 *
 * Callers generate this before their first attempt and keep it for retries.
 * The append path deliberately does not generate one itself: an id minted per
 * attempt would be different on every retry and protect nothing.
 */
export function generateClientEventId(): ClientEventId {
  return randomUUID() as ClientEventId;
}
