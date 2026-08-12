/**
 * Event identity and field rules.
 *
 * An Event is a meaningful change while a Problem is being solved: a
 * hypothesis, an attempt, a dead end, a discovery, a fix, or a correction from
 * the user. Dead ends are recorded as carefully as successes — knowing which
 * direction did not work is half of what makes past experience reusable.
 *
 * Events are append-only. There is no update path here or anywhere below.
 *
 * What is stored is what was tried and what was learned, not the raw material:
 * conversations, logs and code dumps do not belong in an Event.
 */

import { randomUUID } from 'node:crypto';

import { isNormalisedUuid, normaliseUuid } from './uuid.js';

declare const eventIdBrand: unique symbol;

/** A validated event identifier. Always lowercase. */
export type EventId = string & { readonly [eventIdBrand]: true };

/** Raised when a value cannot be an event id. Never echoes the value. */
export class InvalidEventIdError extends Error {
  constructor(reason: string) {
    super(`Not a usable event id: ${reason}.`);
    this.name = 'InvalidEventIdError';
  }
}

/** Raised when a required Event field is unusable. */
export class InvalidEventFieldError extends Error {
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`Event ${field} is unusable: ${reason}.`);
    this.name = 'InvalidEventFieldError';
    this.field = field;
  }
}

/** Whether a value is already a well-formed, normalised event id. */
export function isEventId(value: unknown): value is EventId {
  return isNormalisedUuid(value);
}

/** Validates a string as an event id, normalising case and whitespace. */
export function toEventId(value: string): EventId {
  if (value.trim() === '') {
    throw new InvalidEventIdError('it is empty');
  }

  const normalised = normaliseUuid(value);
  if (normalised === undefined) {
    throw new InvalidEventIdError('it is not a UUID');
  }

  return normalised as EventId;
}

/** Issues a new event id. Uses the Node.js standard generator. */
export function generateEventId(): EventId {
  return randomUUID() as EventId;
}

/**
 * Validates what happened.
 *
 * Required: an Event with nothing to say records that something occurred
 * without recording what, which is not reusable later.
 */
export function toEventSummary(value: string): string {
  const normalised = value.trim();

  if (normalised === '') {
    throw new InvalidEventFieldError('summary', 'it is blank');
  }

  return normalised;
}
