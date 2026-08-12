/**
 * Problem identity and field rules.
 *
 * A Problem is the centre of the Memory model: what went wrong, what was
 * suspected, what was tried, and eventually what fixed it. This module covers
 * identity and the fields a Problem is created with.
 *
 * State transitions, the rule that `VERIFIED` requires a successful
 * Verification, and optimistic locking on `version` are Phase 2. Nothing here
 * anticipates them beyond leaving room.
 */

import { randomUUID } from 'node:crypto';

import { isNormalisedUuid, normaliseUuid } from './uuid.js';

declare const problemIdBrand: unique symbol;

/** A validated problem identifier. Always lowercase. */
export type ProblemId = string & { readonly [problemIdBrand]: true };

/** Raised when a value cannot be a problem id. Never echoes the value. */
export class InvalidProblemIdError extends Error {
  constructor(reason: string) {
    super(`Not a usable problem id: ${reason}.`);
    this.name = 'InvalidProblemIdError';
  }
}

/** Raised when a required Problem field is unusable. */
export class InvalidProblemFieldError extends Error {
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`Problem ${field} is unusable: ${reason}.`);
    this.name = 'InvalidProblemFieldError';
    this.field = field;
  }
}

/** Whether a value is already a well-formed, normalised problem id. */
export function isProblemId(value: unknown): value is ProblemId {
  return isNormalisedUuid(value);
}

/** Validates a string as a problem id, normalising case and whitespace. */
export function toProblemId(value: string): ProblemId {
  if (value.trim() === '') {
    throw new InvalidProblemIdError('it is empty');
  }

  const normalised = normaliseUuid(value);
  if (normalised === undefined) {
    throw new InvalidProblemIdError('it is not a UUID');
  }

  return normalised as ProblemId;
}

/** Issues a new problem id. Uses the Node.js standard generator. */
export function generateProblemId(): ProblemId {
  return randomUUID() as ProblemId;
}

function toRequiredField(field: string, value: string): string {
  const normalised = value.trim();

  if (normalised === '') {
    throw new InvalidProblemFieldError(field, 'it is blank');
  }

  return normalised;
}

/**
 * Validates the short description of the problem.
 *
 * Required: a Problem with no title cannot be recognised later, which defeats
 * the point of recording it.
 */
export function toProblemTitle(value: string): string {
  return toRequiredField('title', value);
}

/**
 * Validates the observed symptoms.
 *
 * Required, and free-form text rather than a list or a structured shape.
 * Several symptoms are expressed perfectly well in prose, and fixing a symptom
 * taxonomy now would commit to categories the retrieval work has not yet
 * justified. Search-oriented features are derived separately later, so the
 * stored Memory keeps the meaningful description rather than a parsed form.
 */
export function toProblemSymptoms(value: string): string {
  return toRequiredField('symptoms', value);
}
