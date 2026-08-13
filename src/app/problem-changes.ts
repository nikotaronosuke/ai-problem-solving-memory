/**
 * Turning a Problem mutation into the record of what moved.
 *
 * Only the fields the mutation actually named appear. A patch that set
 * `confidence` says something about confidence and nothing about the title,
 * even though the title exists — recording every field on every change would
 * bury the one that moved.
 *
 * Two treatments, and the split is the point:
 *
 * Controlled values come from closed sets and are recorded exactly. A reader
 * following how judgement about a Problem changed needs `LOW → HIGH`, and a
 * value from a fixed list cannot be a secret.
 *
 * Free text is described, not copied. Titles and symptom notes can hold
 * anything someone wrote, including things that later have to be removed, and
 * a copy here would outlive the removal. What is kept is whether the field was
 * part of the change, whether it went from or to absent, and whether the value
 * actually differed.
 *
 * This lives in the application layer rather than the domain because it reads
 * a stored record, and the domain does not know about storage. The rule it
 * applies — which fields may be copied — is the domain's, in
 * `src/domain/change-log.ts`.
 */

import {
  exactChange,
  redactedTextChange,
  type ProblemChange,
  type ProblemChanges,
} from '../domain/change-log.js';
import type { ProblemRecord } from '../repository/index.js';

/**
 * Fields recorded exactly, paired with the wire name a reader will recognise.
 *
 * `fix_kind` is here although nothing writes it yet: when close and review
 * arrive they will move it, and the treatment it should get is decided now
 * rather than left to whoever adds the write.
 */
const EXACT_FIELDS = {
  status: (problem: ProblemRecord) => problem.status,
  fix_kind: (problem: ProblemRecord) => problem.fixKind,
  importance: (problem: ProblemRecord) => problem.importance,
  confidence: (problem: ProblemRecord) => problem.confidence,
  freshness: (problem: ProblemRecord) => problem.freshness,
  memory_read_enabled: (problem: ProblemRecord) => problem.memoryReadEnabled,
  memory_write_enabled: (problem: ProblemRecord) => problem.memoryWriteEnabled,
  suppressed: (problem: ProblemRecord) => problem.suppressed,
} as const satisfies Record<string, (problem: ProblemRecord) => string | boolean | null>;

/** Fields described without their contents. */
const REDACTED_TEXT_FIELDS = {
  title: (problem: ProblemRecord) => problem.title,
  symptoms: (problem: ProblemRecord) => problem.symptoms,
  problem_domain: (problem: ProblemRecord) => problem.problemDomain,
  suspected_boundary: (problem: ProblemRecord) => problem.suspectedBoundary,
  source_ai: (problem: ProblemRecord) => problem.sourceAi,
} as const satisfies Record<string, (problem: ProblemRecord) => string | null>;

/** Every field a change may describe. Nothing outside this is recorded. */
export const LOGGED_PROBLEM_FIELDS = [
  ...Object.keys(EXACT_FIELDS),
  ...Object.keys(REDACTED_TEXT_FIELDS),
] as const;

/**
 * Describes how the named fields moved between two versions of a Problem.
 *
 * `fields` are wire names — the ones a caller sent and a reader will
 * recognise. Anything not in the two tables above is ignored rather than
 * guessed at: a field with no decided treatment must not be copied by default.
 *
 * Same-value changes are described honestly. Writing `LOW` over `LOW` is a
 * real thing that happens, and the entry says the value did not move rather
 * than pretending the field was untouched.
 */
export function describeProblemChanges(
  before: ProblemRecord,
  after: ProblemRecord,
  fields: readonly string[],
): ProblemChanges {
  const changes: Record<string, ProblemChange> = {};

  for (const field of fields) {
    if (field in EXACT_FIELDS) {
      const read = EXACT_FIELDS[field as keyof typeof EXACT_FIELDS];
      changes[field] = exactChange(read(before), read(after));
      continue;
    }

    if (field in REDACTED_TEXT_FIELDS) {
      const read = REDACTED_TEXT_FIELDS[field as keyof typeof REDACTED_TEXT_FIELDS];
      changes[field] = redactedTextChange(read(before), read(after));
    }
  }

  return changes;
}
