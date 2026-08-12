/**
 * Environment identity and snapshot rules.
 *
 * An Environment is the conditions that were in place when a problem occurred
 * — OS, device, framework, runtime, browser, SDK, library, relevant versions,
 * deployment, branch, commit. It records what is relevant to the problem, not
 * a complete picture of a machine, and is explicitly not a place to dump a
 * full dependency listing, raw logs or secrets.
 *
 * It is a point in time. When conditions change, the answer is a new snapshot
 * rather than an edit, which is why there is no update path in this phase.
 */

import { randomUUID } from 'node:crypto';

import { isNormalisedUuid, normaliseUuid } from './uuid.js';

declare const environmentIdBrand: unique symbol;

/** A validated environment identifier. Always lowercase. */
export type EnvironmentId = string & { readonly [environmentIdBrand]: true };

/**
 * The recorded conditions.
 *
 * A JSON object with no required keys. Which conditions matter differs by
 * project and by problem, so fixing a column per field would mean either
 * demanding values nobody has or migrating every time a new one appears.
 */
export type EnvironmentSnapshot = Readonly<Record<string, unknown>>;

/** Raised when a value cannot be an environment id. Never echoes the value. */
export class InvalidEnvironmentIdError extends Error {
  constructor(reason: string) {
    super(`Not a usable environment id: ${reason}.`);
    this.name = 'InvalidEnvironmentIdError';
  }
}

/** Raised when a snapshot is not a shape this service can store. */
export class InvalidEnvironmentSnapshotError extends Error {
  constructor(reason: string) {
    super(`Environment snapshot is unusable: ${reason}.`);
    this.name = 'InvalidEnvironmentSnapshotError';
  }
}

/** Whether a value is already a well-formed, normalised environment id. */
export function isEnvironmentId(value: unknown): value is EnvironmentId {
  return isNormalisedUuid(value);
}

/** Validates a string as an environment id, normalising case and whitespace. */
export function toEnvironmentId(value: string): EnvironmentId {
  if (value.trim() === '') {
    throw new InvalidEnvironmentIdError('it is empty');
  }

  const normalised = normaliseUuid(value);
  if (normalised === undefined) {
    throw new InvalidEnvironmentIdError('it is not a UUID');
  }

  return normalised as EnvironmentId;
}

/** Issues a new environment id. Uses the Node.js standard generator. */
export function generateEnvironmentId(): EnvironmentId {
  return randomUUID() as EnvironmentId;
}

/** Whether a value is a JSON object rather than an array or a scalar. */
export function isEnvironmentSnapshot(value: unknown): value is EnvironmentSnapshot {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates a snapshot.
 *
 * Only a JSON object is accepted. An array or a bare scalar would leave the
 * meaning of each entry undefined, and the database enforces the same rule so
 * the two cannot disagree.
 *
 * An empty object is allowed on purpose: "the relevant conditions have not
 * been captured yet" is a real state, and forcing a placeholder value would
 * record something untrue instead.
 */
export function toEnvironmentSnapshot(value: unknown): EnvironmentSnapshot {
  if (value === null) {
    throw new InvalidEnvironmentSnapshotError('it is null, not an object');
  }

  if (Array.isArray(value)) {
    throw new InvalidEnvironmentSnapshotError('it is an array, not an object');
  }

  if (typeof value !== 'object') {
    throw new InvalidEnvironmentSnapshotError(`it is a ${typeof value}, not an object`);
  }

  return value as EnvironmentSnapshot;
}
