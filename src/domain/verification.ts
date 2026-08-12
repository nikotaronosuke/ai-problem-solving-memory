/**
 * Verification identity and field rules.
 *
 * A Verification is not the fix. It is the record of someone or something
 * actually checking whether the state holds — a test run, a build, a real
 * device, an API or database result, a person confirming it. Making the fix
 * and the confirmation separate records is the point: an assistant saying "it
 * works" is not evidence that it does.
 *
 * It belongs to the Problem directly, not to an Event. A Problem can have a
 * Verification with no Event at all, and that record still means exactly what
 * it says.
 *
 * Verifications are append-only. A later check is another Verification.
 */

import { randomUUID } from 'node:crypto';

import { isNormalisedUuid, normaliseUuid } from './uuid.js';

declare const verificationIdBrand: unique symbol;

/** A validated verification identifier. Always lowercase. */
export type VerificationId = string & { readonly [verificationIdBrand]: true };

/** Raised when a value cannot be a verification id. Never echoes the value. */
export class InvalidVerificationIdError extends Error {
  constructor(reason: string) {
    super(`Not a usable verification id: ${reason}.`);
    this.name = 'InvalidVerificationIdError';
  }
}

/** Raised when a required Verification field is unusable. */
export class InvalidVerificationFieldError extends Error {
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`Verification ${field} is unusable: ${reason}.`);
    this.name = 'InvalidVerificationFieldError';
    this.field = field;
  }
}

/** Whether a value is already a well-formed, normalised verification id. */
export function isVerificationId(value: unknown): value is VerificationId {
  return isNormalisedUuid(value);
}

/** Validates a string as a verification id, normalising case and whitespace. */
export function toVerificationId(value: string): VerificationId {
  if (value.trim() === '') {
    throw new InvalidVerificationIdError('it is empty');
  }

  const normalised = normaliseUuid(value);
  if (normalised === undefined) {
    throw new InvalidVerificationIdError('it is not a UUID');
  }

  return normalised as VerificationId;
}

/** Issues a new verification id. Uses the Node.js standard generator. */
export function generateVerificationId(): VerificationId {
  return randomUUID() as VerificationId;
}

/**
 * Validates what was checked and what came of it.
 *
 * Required. The outcome itself is a boolean so it can be judged mechanically;
 * this is where the human-readable account lives. It stays short — raw logs
 * and full responses belong at the other end of `evidence_ref`, not here.
 */
export function toVerificationSummary(value: string): string {
  const normalised = value.trim();

  if (normalised === '') {
    throw new InvalidVerificationFieldError('summary', 'it is blank');
  }

  return normalised;
}
