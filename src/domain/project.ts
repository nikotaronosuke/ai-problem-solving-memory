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

/**
 * Validates an owner-declared repository boundary.
 *
 * A Project may name the part of a repository it covers: `apps/web` in a
 * repository whose other directories are other Projects. Null means no
 * subdirectory boundary — the Project stands for the repository as a whole,
 * which is what every Project meant before this field existed.
 *
 * ## Why this is identity material rather than free-form text
 *
 * `repo` and `platform` are labels; nothing compares them for equality in
 * order to decide anything. This is compared: two Projects on one repository
 * are told apart by their boundaries, so a value that is *nearly* right —
 * `apps/web/`, `/apps/web`, `apps\web` — would be a boundary that silently
 * fails to match the session it was meant to cover. So the shape is checked
 * rather than tidied, and a value that is not already canonical is refused.
 *
 * Refusing rather than normalising is the same choice the remote canonicaliser
 * made for a different reason: there, a raw URL may carry a credential; here, a
 * quietly rewritten path is a boundary the owner did not declare. Neither is
 * something to fix on somebody's behalf.
 *
 * ## What canonical means
 *
 * Repository-relative and POSIX-separated: the exact shape the detector
 * already produces from a repository root and a project directory. No leading
 * or trailing separator, no empty segment, no `.` or `..` segment, and no
 * backslash — a Windows separator here would be a path from one machine rather
 * than a location in a repository anybody can see.
 *
 * Ordinary characters are not policed. A directory legitimately called `a b`
 * or `déjà-vu` is a directory in somebody's repository, and refusing it because
 * another filesystem might dislike it would be this service inventing a
 * restriction git does not have.
 *
 * **Never an absolute path.** A path on a machine carries a user name and
 * sometimes an employer's, and it names nothing anybody else can find. The
 * detector already refuses to emit one; this refuses to store one.
 */
export function toProjectRepoSubpath(value: string): string {
  if (value === '') {
    throw new InvalidProjectFieldError('repository boundary', 'it is empty');
  }
  if (value.includes('\\')) {
    throw new InvalidProjectFieldError(
      'repository boundary',
      'it is not repository-relative and POSIX-separated',
    );
  }
  if (value.startsWith('/') || value.endsWith('/')) {
    throw new InvalidProjectFieldError(
      'repository boundary',
      'it is not repository-relative and POSIX-separated',
    );
  }

  for (const segment of value.split('/')) {
    if (segment === '') {
      throw new InvalidProjectFieldError('repository boundary', 'it has an empty segment');
    }
    if (segment === '.' || segment === '..') {
      throw new InvalidProjectFieldError('repository boundary', 'it has a relative segment');
    }
  }

  return value;
}

/**
 * Validates an optional repository boundary.
 *
 * Absent and null both mean no boundary. Unlike `normaliseOptionalText`, a
 * blank string is not quietly treated as null: an empty boundary is a mistake
 * in the caller rather than a way of saying "the whole repository", and the
 * caller that means that has `null` to say it with.
 */
export function toOptionalProjectRepoSubpath(value: string | null | undefined): string | null {
  return value === undefined || value === null ? null : toProjectRepoSubpath(value);
}
