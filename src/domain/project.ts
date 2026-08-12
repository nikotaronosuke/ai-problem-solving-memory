/**
 * Project identity and field rules.
 *
 * A project is the long-lived unit development happens in. Its id is a UUID
 * the application issues, like the owner id, and is not derived from a
 * repository, a hosting provider or anything outside this service.
 *
 * `ProjectId` is a branded string, so a plain string cannot be passed where a
 * project is expected.
 */

import { randomUUID } from 'node:crypto';

import { isNormalisedUuid, normaliseUuid } from './uuid.js';

declare const projectIdBrand: unique symbol;

/** A validated project identifier. Always lowercase. */
export type ProjectId = string & { readonly [projectIdBrand]: true };

/** Raised when a value cannot be a project id. Never echoes the value. */
export class InvalidProjectIdError extends Error {
  constructor(reason: string) {
    super(`Not a usable project id: ${reason}.`);
    this.name = 'InvalidProjectIdError';
  }
}

/** Raised when a project field is unusable. */
export class InvalidProjectFieldError extends Error {
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`Project ${field} is unusable: ${reason}.`);
    this.name = 'InvalidProjectFieldError';
    this.field = field;
  }
}

/** Whether a value is already a well-formed, normalised project id. */
export function isProjectId(value: unknown): value is ProjectId {
  return isNormalisedUuid(value);
}

/** Validates a string as a project id, normalising case and whitespace. */
export function toProjectId(value: string): ProjectId {
  if (value.trim() === '') {
    throw new InvalidProjectIdError('it is empty');
  }

  const normalised = normaliseUuid(value);
  if (normalised === undefined) {
    throw new InvalidProjectIdError('it is not a UUID');
  }

  return normalised as ProjectId;
}

/** Issues a new project id. Uses the Node.js standard generator. */
export function generateProjectId(): ProjectId {
  return randomUUID() as ProjectId;
}

/**
 * Validates a project name.
 *
 * A name is required and must carry something. Surrounding whitespace is
 * removed so that names differing only by padding are not treated as
 * different. No length limit is imposed yet — there is no evidence for where
 * one should fall.
 */
export function toProjectName(value: string): string {
  const normalised = value.trim();

  if (normalised === '') {
    throw new InvalidProjectFieldError('name', 'it is blank');
  }

  return normalised;
}

// `repo` and `platform` are normalised by `normaliseOptionalText` in
// `./text.js` and are otherwise unconstrained: a project may have no
// repository, a platform may be undetermined, and pinning either to a
// provider-specific shape would bake an assumption in too early.
