/**
 * Ownership identity.
 *
 * An owner id is a UUID the Memory Server issues and manages. It is
 * deliberately not an AI vendor account id, a GitHub user id, or anything
 * derived from an external provider: Memory belongs to the person, and must
 * survive changing the AI, the account or the protocol in front of it.
 *
 * `OwnerId` is a branded string, so a plain string cannot be passed where an
 * owner is expected. The only way to obtain one is to validate a value.
 */

import { randomUUID } from 'node:crypto';

declare const ownerIdBrand: unique symbol;

/** A validated owner identifier. Always lowercase. */
export type OwnerId = string & { readonly [ownerIdBrand]: true };

/**
 * RFC 4122 layout, versions 1–8 with a valid variant nibble.
 *
 * The all-zero nil UUID fails this, which is intended: it is a placeholder,
 * not an owner.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Raised when a value cannot be an owner id. Never echoes the value. */
export class InvalidOwnerIdError extends Error {
  constructor(reason: string) {
    // The rejected value is deliberately omitted. A misconfigured variable can
    // hold something that was never meant to be printed.
    super(`Not a usable owner id: ${reason}.`);
    this.name = 'InvalidOwnerIdError';
  }
}

/** Whether a value is already a well-formed, normalised owner id. */
export function isOwnerId(value: unknown): value is OwnerId {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * Validates a string as an owner id.
 *
 * UUIDs are case-insensitive and PostgreSQL returns them lowercase, so the
 * value is normalised here. Otherwise the same owner could compare unequal
 * depending on which side it came from.
 */
export function toOwnerId(value: string): OwnerId {
  const normalised = value.trim().toLowerCase();

  if (normalised === '') {
    throw new InvalidOwnerIdError('it is empty');
  }

  if (!UUID_PATTERN.test(normalised)) {
    throw new InvalidOwnerIdError('it is not a UUID');
  }

  return normalised as OwnerId;
}

/** Issues a new owner id. Uses the Node.js standard generator. */
export function generateOwnerId(): OwnerId {
  return randomUUID() as OwnerId;
}

declare const ownerContextBrand: unique symbol;

/**
 * Proof that an owner is established for the current operation.
 *
 * Owner-scoped work takes one of these rather than a bare id, so an operation
 * cannot begin before ownership is settled.
 *
 * The brand is declared but never exported, and no constructor is offered
 * here on purpose: holding a valid `OwnerId` is not the same as having
 * confirmed that the owner exists. The only way to obtain a context is
 * `resolveOwnerContext`, which checks the database and fails closed when the
 * owner is missing, malformed or absent.
 */
export interface OwnerContext {
  readonly ownerId: OwnerId;
  readonly [ownerContextBrand]: true;
}
