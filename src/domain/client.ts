/**
 * Who is connecting, as distinct from who owns the data.
 *
 * A client is an assistant, a command-line tool, or a future adapter acting on
 * an owner's behalf. Keeping it separate from the owner is what stops an AI
 * vendor's account from becoming the ownership boundary — the specification is
 * explicit that it must not, and the way that stays true is that nothing here
 * knows what a vendor is.
 *
 * A `label` is the only human-facing part, and it is free text on purpose.
 * "Claude Code on the laptop" is what somebody needs to read when deciding
 * what to revoke; an enumeration of vendors would be out of date within a
 * month and would quietly make the vendor part of the identity.
 */

import { randomUUID } from 'node:crypto';

declare const clientIdBrand: unique symbol;

/** Identifies one connecting client. Server-issued, never client-supplied. */
export type ClientId = string & { readonly [clientIdBrand]: 'ClientId' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Raised when a value cannot be a client id. */
export class InvalidClientIdError extends Error {
  constructor(detail: string) {
    super(`Not a usable client id: ${detail}`);
    this.name = 'InvalidClientIdError';
  }
}

export function toClientId(value: string): ClientId {
  const trimmed = value.trim();
  if (!UUID.test(trimmed)) {
    // The value is not echoed. A malformed identifier arriving here came from
    // somewhere, and that somewhere may have sent something else by mistake.
    throw new InvalidClientIdError('it is not a UUID');
  }
  return trimmed.toLowerCase() as ClientId;
}

export function generateClientId(): ClientId {
  return randomUUID() as ClientId;
}

/** Raised when a label says nothing. */
export class InvalidClientLabelError extends Error {
  constructor() {
    super('A client label cannot be blank.');
    this.name = 'InvalidClientLabelError';
  }
}

/**
 * Normalises a label.
 *
 * Trimmed, and refused when nothing is left. A client nobody can identify is
 * a client nobody will dare revoke.
 */
export function toClientLabel(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new InvalidClientLabelError();
  }
  return trimmed;
}
