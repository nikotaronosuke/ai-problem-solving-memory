/**
 * What a Memory was true of, and what has to be checked before believing it
 * still is.
 *
 * The specification is blunt about this: a search result is a candidate, not
 * an answer, and before acting on one an assistant re-checks the current code,
 * the current environment, the relevant versions and the current official
 * specification. This module is how the server says that — and, just as
 * importantly, the limit of what it says.
 *
 * **The server does not decide whether a Memory is still true.** It cannot.
 * It has no working tree, no package manifest, no running process and no way
 * to read a vendor's documentation; the things that would settle the question
 * live where the work is happening. So nothing here compares anything to
 * "now". What is returned is the conditions the Memory was recorded under, the
 * checks that were done at the time, and a fixed list of what to re-establish
 * before relying on it.
 *
 * **The checklist does not shrink.** Not for a Memory marked current, not for
 * one verified twice, not for one from the Project being worked in. The
 * specification says the confirmation is not skipped for a trusted Memory and
 * not skipped for an important one, and a `freshness` of `CURRENT` is a
 * statement about the record rather than about the world — it means nobody has
 * marked it superseded, which is not the same as somebody having checked.
 * Making the list conditional would turn "always re-check" into "re-check when
 * the server is unsure", which is a different and much weaker promise.
 */

import type { VerificationType } from './enums.js';
import type { EnvironmentSnapshot } from './environment.js';
import type { RankedMemoryCandidate } from './retrieval-ranking.js';

/**
 * What has to be re-established before a Memory is acted on.
 *
 * The specification's own four, in its own words. Not a taxonomy invented
 * here, and not a superset: extra checks would be this system inventing
 * obligations for an assistant it knows nothing about.
 *
 * Frozen, not merely `readonly`. The type disappears at run time and this
 * array is shared by every candidate of every search in the process — a
 * caller that sorted or emptied it would quietly change what every later
 * search asks for. `readonly` documents the intent; `Object.freeze` is what
 * survives compilation.
 */
export const REVALIDATION_CHECKS = Object.freeze([
  'CURRENT_CODE',
  'CURRENT_ENVIRONMENT',
  'RELEVANT_VERSION',
  'OFFICIAL_SPEC',
] as const);

export type RevalidationCheck = (typeof REVALIDATION_CHECKS)[number];

/**
 * One check that was performed at the time, and how it went.
 *
 * Both outcomes are kept. A check that failed is evidence too — it says what
 * was tried and did not settle the matter, which is exactly the sort of thing
 * a later reader needs in order to avoid repeating it. Keeping only the
 * successes would make every Memory read as though everything attempted had
 * worked.
 *
 * `evidenceRef` is a reference and stays one: a path, a URL, a commit, a test
 * name. Nothing here fetches it, resolves it or checks that it still exists.
 * Whether the thing it points at is still there, and still says what it said,
 * is a question about now — which is the caller's to answer, and the reason
 * this whole contract exists.
 *
 * The identifiers are absent on purpose. A verification's own id, its owner,
 * its Problem and the idempotency key it arrived under answer questions
 * nobody is asking here; the Problem is already named by the candidate.
 * `verifiedBy` is left out for the same reason `source_ai` is descriptive
 * elsewhere — who confirmed it is not what has to be re-established.
 */
export interface VerificationEvidence {
  readonly verificationType: VerificationType;
  /** Whether the check confirmed the state. Both values are kept. */
  readonly result: boolean;
  readonly summary: string;
  readonly evidenceRef: string | null;
  readonly createdAt: Date;
}

/**
 * Everything a caller needs in order to decide what to re-check.
 *
 * No `freshness`. It is already on the ranking view, and one fact with two
 * homes is one fact that will eventually disagree with itself. There is also
 * no derived judgement — no `isStale`, no `needsUpdate`, no `isSafe` — because
 * every one of those would be the server answering the question it has just
 * said it cannot answer.
 */
export interface RevalidationContext {
  /**
   * The conditions recorded when the Problem occurred.
   *
   * Returned exactly as stored, uninterpreted. The snapshot holds whatever was
   * relevant to that Problem — a runtime, a framework, a browser, a commit,
   * some versions — and which keys appear is not fixed. Picking values out of
   * it to build a tidier shape would mean guessing at a schema that does not
   * exist, and an empty object is a perfectly ordinary snapshot: it means the
   * conditions were not recorded, not that there were none.
   */
  readonly historicalEnvironment: EnvironmentSnapshot;
  /** Oldest first. Empty is ordinary — most Problems are never verified. */
  readonly evidence: readonly VerificationEvidence[];
  /** Always the four. See `REVALIDATION_CHECKS`. */
  readonly requiredChecks: readonly RevalidationCheck[];
}

/**
 * One Memory as a search finally offers it.
 *
 * The ranking view is nested rather than spread, so the two halves stay
 * legible: `ranking` is why this Memory is here and in this position,
 * `revalidation` is what must happen before it is believed. It also leaves
 * room — the later tasks that add dead-end handling and conflict comparison
 * have somewhere to put them that does not involve widening a stage's own
 * type.
 */
export interface RetrievalMemoryCandidate {
  readonly ranking: RankedMemoryCandidate;
  readonly revalidation: RevalidationContext;
}
