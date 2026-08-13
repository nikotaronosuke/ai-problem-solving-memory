/**
 * Relation identity and field rules.
 *
 * A Relation is a meaningful link between two of one owner's Problems: the
 * same trouble met twice, a cause found in another investigation, a conclusion
 * that replaced an earlier one. It is what lets experience from one problem
 * reach another instead of being filed away where nobody looks.
 *
 * A link, not an inheritance. Relating a verified Problem to an unverified one
 * says they are connected; it does not make the second verified, and nothing
 * here carries status, confidence, freshness or evidence across. Each Problem
 * still stands on its own record.
 *
 * Only one row is stored per link, whichever direction it was stated from.
 * `CAUSED_BY`, `SUPERSEDES` and `DERIVED_FROM` read from `from` to `to` and
 * mean something different reversed; `SIMILAR_TO`, `RELATED_TO` and
 * `CONTRADICTS` read the same both ways. Neither case writes a mirror row —
 * two rows would have to be kept in step by something, and nothing would keep
 * them in step. Listing a Problem's relations looks at both ends instead.
 *
 * There is no update path in this phase, so there is no `updated_at` and no
 * version. How a mistaken link is corrected or withdrawn is deliberately not
 * decided here.
 */

import { randomUUID } from 'node:crypto';

import { isNormalisedUuid, normaliseUuid } from './uuid.js';

declare const relationIdBrand: unique symbol;

/** A validated relation identifier. Always lowercase. */
export type RelationId = string & { readonly [relationIdBrand]: true };

/** Raised when a value cannot be a relation id. Never echoes the value. */
export class InvalidRelationIdError extends Error {
  constructor(reason: string) {
    super(`Not a usable relation id: ${reason}.`);
    this.name = 'InvalidRelationIdError';
  }
}

/** Raised when a required Relation field is unusable. */
export class InvalidRelationFieldError extends Error {
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`Relation ${field} is unusable: ${reason}.`);
    this.name = 'InvalidRelationFieldError';
    this.field = field;
  }
}

/** Raised when a Relation would join a Problem to itself. */
export class SelfRelationError extends Error {
  constructor() {
    super('A relation cannot join a problem to itself.');
    this.name = 'SelfRelationError';
  }
}

/** Whether a value is already a well-formed, normalised relation id. */
export function isRelationId(value: unknown): value is RelationId {
  return isNormalisedUuid(value);
}

/** Validates a string as a relation id, normalising case and whitespace. */
export function toRelationId(value: string): RelationId {
  if (value.trim() === '') {
    throw new InvalidRelationIdError('it is empty');
  }

  const normalised = normaliseUuid(value);
  if (normalised === undefined) {
    throw new InvalidRelationIdError('it is not a UUID');
  }

  return normalised as RelationId;
}

/** Issues a new relation id. Uses the Node.js standard generator. */
export function generateRelationId(): RelationId {
  return randomUUID() as RelationId;
}

/**
 * Validates why two Problems are linked.
 *
 * Required and non-blank. A link nobody can account for later is a link nobody
 * can act on — and "these two look alike" is exactly the judgement that needs
 * its reasoning attached, since the next reader has only the record to go on.
 *
 * Free text rather than a taxonomy. What makes two problems worth linking is
 * not yet known well enough to enumerate, and a category list invented now
 * would be answered around rather than used.
 */
export function toRelationReason(value: string): string {
  const normalised = value.trim();

  if (normalised === '') {
    throw new InvalidRelationFieldError('reason', 'it is blank');
  }

  return normalised;
}

/**
 * Whether these two ends would join a Problem to itself.
 *
 * True for any relation type: a Problem is not similar to, caused by or a
 * replacement for itself under any of the six meanings, and the self-loop
 * would be something every later traversal had to special-case.
 */
export function isSelfRelation(fromId: string, toId: string): boolean {
  return fromId === toId;
}
