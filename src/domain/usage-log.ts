/**
 * Usage log identity and field rules.
 *
 * A UsageLog records that past memory was actually used while solving a
 * problem — found, read, taken, set aside, or decisive enough to change the
 * approach. It is separate from the Memory itself on purpose: a Problem
 * records what was learned, and this records that someone consulted it.
 * Folding one into the other would make the record of an investigation depend
 * on who has been reading it.
 *
 * It is Memory-specific and nothing more. Tool calls, deploys, model
 * invocations and approvals are not logged here; a Global Audit Layer for
 * those belongs to the wider system, and this has to stay something that
 * layer could read from rather than something already pretending to be it.
 *
 * `source_ai` names who did the using. It is descriptive and never a
 * credential: whatever a caller writes there, the owner whose data it can
 * reach comes from the established context and from nowhere else.
 *
 * There is no update path, so no `updated_at` and no version. How long usage
 * history is kept, and whether it can be removed, are questions this phase
 * does not answer — it only adds rows.
 */

import { randomUUID } from 'node:crypto';

import { isNormalisedUuid, normaliseUuid } from './uuid.js';

declare const usageLogIdBrand: unique symbol;

/** A validated usage log identifier. Always lowercase. */
export type UsageLogId = string & { readonly [usageLogIdBrand]: true };

/** Raised when a value cannot be a usage log id. Never echoes the value. */
export class InvalidUsageLogIdError extends Error {
  constructor(reason: string) {
    super(`Not a usable usage log id: ${reason}.`);
    this.name = 'InvalidUsageLogIdError';
  }
}

/** Raised when a required UsageLog field is unusable. */
export class InvalidUsageLogFieldError extends Error {
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`Usage log ${field} is unusable: ${reason}.`);
    this.name = 'InvalidUsageLogFieldError';
    this.field = field;
  }
}

/** Whether a value is already a well-formed, normalised usage log id. */
export function isUsageLogId(value: unknown): value is UsageLogId {
  return isNormalisedUuid(value);
}

/** Validates a string as a usage log id, normalising case and whitespace. */
export function toUsageLogId(value: string): UsageLogId {
  if (value.trim() === '') {
    throw new InvalidUsageLogIdError('it is empty');
  }

  const normalised = normaliseUuid(value);
  if (normalised === undefined) {
    throw new InvalidUsageLogIdError('it is not a UUID');
  }

  return normalised as UsageLogId;
}

/** Issues a new usage log id. Uses the Node.js standard generator. */
export function generateUsageLogId(): UsageLogId {
  return randomUUID() as UsageLogId;
}

/**
 * Validates who used the memory.
 *
 * Required and non-blank. The point of the log is being able to tell later
 * which AI relied on what, and an entry that does not say who is one that
 * answers nothing.
 *
 * Free-form rather than an enum. Provider and model names change, and manual
 * and imported entries exist alongside AI ones — the same reasoning that keeps
 * `source_ai` free-form on an Event.
 */
export function toUsageSourceAi(value: string): string {
  const normalised = value.trim();

  if (normalised === '') {
    throw new InvalidUsageLogFieldError('source_ai', 'it is blank');
  }

  return normalised;
}

/**
 * Validates why the memory was used.
 *
 * Required and non-blank. Without it the log is a hit counter: the question
 * worth answering later is not how often a memory was consulted but whether
 * it deserved to be, and that needs the judgement written down — what looked
 * similar, or why it was set aside.
 */
export function toUsageReason(value: string): string {
  const normalised = value.trim();

  if (normalised === '') {
    throw new InvalidUsageLogFieldError('reason', 'it is blank');
  }

  return normalised;
}

/**
 * Validates what came of using the memory, when that is already known.
 *
 * Null is a real answer here and the common one: a memory that was found or
 * read has no outcome yet, and inventing one would be worse than leaving it
 * open. Blank is not the same as null, though — an empty string would record
 * that there was a result and that it was nothing, so it is refused rather
 * than quietly turned into null.
 */
export function toUsageResult(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const normalised = value.trim();

  if (normalised === '') {
    throw new InvalidUsageLogFieldError('result', 'it is blank');
  }

  return normalised;
}
