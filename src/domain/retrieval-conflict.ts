/**
 * Memories that disagree, and the material for comparing them.
 *
 * The specification is unusually specific about this one. When two Memories
 * conflict, the answer is **not** decided by majority: what gets compared is
 * the difference in environment, the difference in version, the difference in
 * symptoms, the stated reason, and the strength of the verification behind
 * each — and if that comparison cannot settle it, the record is kept as
 * `CONFLICTED` rather than resolved.
 *
 * Every one of those five is something the server can supply and none of them
 * is something it can judge. So this module carries material and no verdict.
 * There is no winner, no preferred Memory, no resolution and no score. Which
 * of two disagreeing Memories applies to the work happening now depends on the
 * environment the work is happening in, which is the one thing this process
 * cannot see.
 *
 * **Two different things travel under the word "conflict", and they are kept
 * apart.** A Problem's own `confidence` may be `CONFLICTED` — a statement about
 * that one record, meaning it holds evidence pointing both ways. A
 * `CONTRADICTS` Relation is a link somebody stored between two Problems, with
 * a required reason. Neither implies the other: a `CONTRADICTS` link does not
 * change either Problem's confidence, and a `CONFLICTED` Problem with no link
 * recorded gets no link invented for it. All four combinations occur and all
 * four are reported as they are.
 *
 * **The subject is here because a difference needs two sides.** A search result
 * already carries the candidate's own conditions and evidence, but not its
 * symptoms — and "symptom difference" is one of the five comparisons. Returning
 * only the other Memory's symptoms would give a reader half of a subtraction.
 */

import type { Confidence, FixKind, Freshness, ProblemStatus } from './enums.js';
import type { EnvironmentSnapshot } from './environment.js';
import type { ProblemId } from './problem.js';
import type { ProjectId } from './project.js';
import type { VerificationEvidence } from './retrieval-revalidation.js';

/**
 * Raised when a readable contradicting Problem has no Environment.
 *
 * The same invariant the revalidation contract protects, applied to the other
 * end of a disagreement: `environment_id` is not null and a composite foreign
 * key points at a row that exists, so this cannot happen while the schema
 * holds. If it somehow does, a comparison would be handed one side's
 * conditions and silently not the other's — which reads as a Memory recorded
 * under nothing in particular rather than as a broken database.
 *
 * Carries no identifier, no snapshot and no reason. This error travels.
 *
 * It lives in the domain rather than beside the query that notices it, so that
 * the application layer can name the failure without importing storage.
 */
export class MissingConflictEnvironmentError extends Error {
  constructor() {
    super('A readable contradicting Problem has no environment.');
    this.name = 'MissingConflictEnvironmentError';
  }
}

/**
 * The candidate's own side of a comparison.
 *
 * Only what is missing elsewhere. The Problem's identifier, Project, trust and
 * currency are in the ranking view, and its conditions and evidence are in the
 * revalidation context; repeating any of them here would give one fact two
 * homes, and two homes is one edit away from two answers.
 *
 * `title` is not here either. It names a Problem for a person reading a list,
 * and `symptoms` is what a comparison is actually made against.
 */
export interface ConflictSubject {
  readonly symptoms: string;
  readonly problemDomain: string | null;
  readonly suspectedBoundary: string | null;
  readonly status: ProblemStatus;
  readonly fixKind: FixKind | null;
}

/**
 * The other Memory in a recorded disagreement.
 *
 * A snapshot rather than a search result: it was never a candidate of this
 * search, so it has no rank, no structural score and no position. Giving it
 * one would mean inventing a placement nobody computed.
 *
 * It carries the two halves of every comparison the specification asks for on
 * its side — semantics, conditions, evidence — plus the trust and currency of
 * the record itself. What it does not carry is anything recursive: no dead-end
 * warnings, no conflicts of its own, no relations. One hop is the whole of it,
 * and a Memory that disagrees with a Memory that disagrees with something else
 * is a graph this phase does not walk.
 *
 * `requiredChecks` is absent on purpose. The four checks are one obligation
 * about using a Memory at all, they never vary, and copying them onto every
 * contradiction would turn a fixed rule into something a reader might think
 * differs per item.
 */
export interface ConflictMemorySnapshot {
  readonly problemId: ProblemId;
  readonly projectId: ProjectId;

  readonly symptoms: string;
  readonly problemDomain: string | null;
  readonly suspectedBoundary: string | null;
  readonly status: ProblemStatus;
  readonly fixKind: FixKind | null;

  readonly confidence: Confidence;
  readonly freshness: Freshness;

  /** Returned exactly as stored, uninterpreted. See `RevalidationContext`. */
  readonly historicalEnvironment: EnvironmentSnapshot;
  /** Oldest first, failures included. Empty is ordinary. */
  readonly evidence: readonly VerificationEvidence[];
}

/**
 * One recorded disagreement, from the candidate's side.
 *
 * `reason` is why somebody linked the two, required and non-blank when it was
 * written. It is returned as stored — never summarised, re-read or handed to a
 * model, because the account of a disagreement is exactly the part a paraphrase
 * would flatten.
 *
 * `relationCreatedAt` says when the link was recorded. Whether it still holds
 * is a question for the same re-checking every Memory gets; there is no
 * per-relation freshness, because nothing in the record supports one.
 *
 * The stored row's `from` and `to` do not appear. `CONTRADICTS` reads the same
 * both ways, so which end somebody happened to record it from is not a fact
 * about the disagreement, and making a reader work it out would be handing
 * over an implementation detail as if it meant something.
 */
export interface Contradiction {
  readonly reason: string;
  readonly relationCreatedAt: Date;
  readonly other: ConflictMemorySnapshot;
}

/**
 * What a search says about a Memory disagreeing with another.
 *
 * An empty `contradictions` list means no `CONTRADICTS` Relation was recorded
 * against this Memory. It is not a statement that nothing disagrees with it —
 * only that nobody wrote one down.
 *
 * There is no `hasConflict` and no self-conflict marker. A Memory whose own
 * record holds evidence both ways already says so through its confidence, and
 * a second field repeating it in another form would be a second source for one
 * fact.
 */
export interface ConflictContext {
  readonly subject: ConflictSubject;
  readonly contradictions: readonly Contradiction[];
}
