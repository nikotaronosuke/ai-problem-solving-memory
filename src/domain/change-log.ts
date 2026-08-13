/**
 * Change log identity and how a change is described.
 *
 * A ChangeLog entry says who altered a Problem, when, and what moved. It is
 * written by the service as part of the same change, not posted by a caller —
 * a history someone can write directly is not a history.
 *
 * What may be recorded is the substance of this module. Two kinds of field,
 * treated differently on purpose:
 *
 * Controlled values — status, fix kind, the flags, confidence, freshness —
 * come from closed sets. Their before and after are recorded exactly, because
 * that is what a reader needs in order to follow how judgement about a Problem
 * changed, and because a value from a fixed list cannot be a secret.
 *
 * Free text is not copied. A title or a symptom description can hold anything
 * someone wrote, including things that later have to be removed; a copy here
 * would outlive the removal and quietly defeat it. What is recorded instead is
 * that the field was part of the change, whether it went from or to absent,
 * and whether the value actually differed — enough to follow the shape of an
 * edit without carrying its contents.
 *
 * The distinction is a product decision rather than a storage one, which is
 * why it lives here and not in a trigger.
 */

import { randomUUID } from 'node:crypto';

import { isNormalisedUuid, normaliseUuid } from './uuid.js';

declare const changeLogIdBrand: unique symbol;

/** A validated change log identifier. Always lowercase. */
export type ChangeLogId = string & { readonly [changeLogIdBrand]: true };

/** Raised when a value cannot be a change log id. Never echoes the value. */
export class InvalidChangeLogIdError extends Error {
  constructor(reason: string) {
    super(`Not a usable change log id: ${reason}.`);
    this.name = 'InvalidChangeLogIdError';
  }
}

/** Raised when a required ChangeLog field is unusable. */
export class InvalidChangeLogFieldError extends Error {
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`Change log ${field} is unusable: ${reason}.`);
    this.name = 'InvalidChangeLogFieldError';
    this.field = field;
  }
}

/** Whether a value is already a well-formed, normalised change log id. */
export function isChangeLogId(value: unknown): value is ChangeLogId {
  return isNormalisedUuid(value);
}

/** Validates a string as a change log id, normalising case and whitespace. */
export function toChangeLogId(value: string): ChangeLogId {
  if (value.trim() === '') {
    throw new InvalidChangeLogIdError('it is empty');
  }

  const normalised = normaliseUuid(value);
  if (normalised === undefined) {
    throw new InvalidChangeLogIdError('it is not a UUID');
  }

  return normalised as ChangeLogId;
}

/** Issues a new change log id. Uses the Node.js standard generator. */
export function generateChangeLogId(): ChangeLogId {
  return randomUUID() as ChangeLogId;
}

/**
 * Validates who made the change.
 *
 * Required and non-blank: an entry that does not say who changed something
 * answers half the question it exists to answer.
 *
 * Free-form rather than an enum, like `source_ai` elsewhere — assistant and
 * tool names change, and manual edits exist alongside automated ones. It is
 * descriptive and never consulted for authorisation.
 */
export function toChangedBy(value: string): string {
  const normalised = value.trim();

  if (normalised === '') {
    throw new InvalidChangeLogFieldError('changed_by', 'it is blank');
  }

  return normalised;
}

/** A value from a closed set, recorded as it was and as it became. */
export interface ExactChange {
  readonly kind: 'exact';
  readonly before: string | boolean | null;
  readonly after: string | boolean | null;
}

/**
 * A free-text field that was part of the change, described without its
 * contents.
 *
 * `before_present` and `after_present` say whether there was a value at all,
 * which is how clearing a field is distinguished from replacing one.
 * `changed` says whether the value actually moved — writing the same text
 * again is a real thing that happens, and the history should not imply
 * otherwise.
 */
export interface RedactedTextChange {
  readonly kind: 'text_redacted';
  readonly before_present: boolean;
  readonly after_present: boolean;
  readonly changed: boolean;
}

export type ProblemChange = ExactChange | RedactedTextChange;

/** What moved in one mutation, keyed by field name. */
export type ProblemChanges = Readonly<Record<string, ProblemChange>>;

/** Records a controlled value's move exactly. */
export function exactChange(
  before: string | boolean | null,
  after: string | boolean | null,
): ExactChange {
  return { kind: 'exact', before, after };
}

/**
 * Records that a free-text field was part of a change, without its contents.
 *
 * Takes the values so it can answer whether anything actually differed, and
 * deliberately returns nothing derived from them beyond that.
 */
export function redactedTextChange(
  before: string | null,
  after: string | null,
): RedactedTextChange {
  return {
    kind: 'text_redacted',
    before_present: before !== null,
    after_present: after !== null,
    changed: before !== after,
  };
}

/**
 * Whether a set of changes says anything.
 *
 * An empty object would record that something happened without recording
 * what, which the database refuses too.
 */
export function hasChanges(changes: ProblemChanges): boolean {
  return Object.keys(changes).length > 0;
}
