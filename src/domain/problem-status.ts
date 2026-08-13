/**
 * When a Problem may move from one status to another.
 *
 * This is the whole rule, in one place, as plain data and plain functions. It
 * knows nothing about HTTP, storage or the repository: it is given the status
 * a Problem is in, the status someone wants it in, and whether a successful
 * Verification exists, and it answers whether that is allowed and why not.
 *
 * Keeping it here rather than in the service is what stops the matrix being
 * re-derived somewhere else. A route that decided for itself which moves were
 * legal would be a second copy of this rule, and the two would drift.
 *
 * The five statuses come from the specification, not from this file, and their
 * meanings are:
 *
 * - `INVESTIGATING` — being looked into
 * - `FIX_CANDIDATE` — there is a candidate fix, not yet confirmed to work
 * - `VERIFIED` — confirmed by an actual check
 * - `PAUSED` — set aside, resumable
 * - `CLOSED_UNRESOLVED` — stopped without a resolution
 *
 * `fix_kind` is a separate axis and is not touched here: whether a fix
 * addressed the cause or worked around it is a different question from where
 * the Problem stands.
 */

import type { ProblemStatus } from './enums.js';

/**
 * Where a Problem may go from each status.
 *
 * `VERIFIED` and `CLOSED_UNRESOLVED` are terminal: nothing leads out of them.
 * That is not an oversight — reopening a resolved or abandoned Problem is a
 * real requirement with real questions attached (does the old evidence still
 * count? is it the same Problem?), and inventing an answer here would settle
 * them by accident. A new investigation is a new Problem until something says
 * otherwise.
 *
 * `PAUSED` is deliberately not terminal. Setting work aside and coming back to
 * it is the ordinary case, so it leads back to both working statuses.
 *
 * `VERIFIED` is reachable only from `FIX_CANDIDATE`. A Problem nobody has
 * proposed a fix for cannot be confirmed fixed, whatever evidence exists —
 * the two steps are "we think this is the fix" and "we checked, and it holds",
 * and collapsing them loses the first.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<ProblemStatus, readonly ProblemStatus[]>> = {
  INVESTIGATING: ['FIX_CANDIDATE', 'PAUSED', 'CLOSED_UNRESOLVED'],
  FIX_CANDIDATE: ['INVESTIGATING', 'VERIFIED', 'PAUSED', 'CLOSED_UNRESOLVED'],
  PAUSED: ['INVESTIGATING', 'FIX_CANDIDATE', 'CLOSED_UNRESOLVED'],
  VERIFIED: [],
  CLOSED_UNRESOLVED: [],
};

/** Statuses nothing leads out of. */
export const TERMINAL_PROBLEM_STATUSES: readonly ProblemStatus[] = [
  'VERIFIED',
  'CLOSED_UNRESOLVED',
];

/**
 * The status that has to be earned with evidence.
 *
 * Asked rather than assumed, so a caller knows whether to go looking for a
 * successful Verification without having to know which status that is. Keeping
 * it here means the fact lives beside the rule that enforces it: a service
 * that hard-coded the comparison would be a second place to update if the
 * evidence requirement ever moved.
 */
const EVIDENCE_GATED_STATUS: ProblemStatus = 'VERIFIED';

/** Whether reaching this status requires a successful Verification. */
export function requiresSuccessfulVerification(status: ProblemStatus): boolean {
  return status === EVIDENCE_GATED_STATUS;
}

/** Whether a Problem in this status can still move anywhere. */
export function isTerminalProblemStatus(status: ProblemStatus): boolean {
  return ALLOWED_TRANSITIONS[status].length === 0;
}

/** The statuses reachable in one step, for a Problem in this status. */
export function allowedTransitionsFrom(status: ProblemStatus): readonly ProblemStatus[] {
  return ALLOWED_TRANSITIONS[status];
}

/** Why a transition was refused. */
export type TransitionRefusal =
  /** The target is the status the Problem is already in. */
  | 'SAME_STATUS'
  /** Nothing leads out of the current status. */
  | 'TERMINAL_STATUS'
  /** The move is not one the matrix allows. */
  | 'NOT_ALLOWED'
  /** `VERIFIED` was asked for without a successful Verification to support it. */
  | 'VERIFICATION_REQUIRED';

export type TransitionDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly refusal: TransitionRefusal; readonly reason: string };

export interface TransitionRequest {
  readonly currentStatus: ProblemStatus;
  readonly targetStatus: ProblemStatus;
  /**
   * Whether this Problem has at least one Verification recording a successful
   * check.
   *
   * The caller establishes this from the Problem's own Verifications, reading
   * the boolean `result`. It is passed in rather than looked up because this
   * module has no storage — and because stating it as a fact makes it obvious
   * that nothing else may stand in for it. Not a FIX Event, not a summary that
   * sounds conclusive, not a confidence level, not an assistant's word.
   */
  readonly hasSuccessfulVerification: boolean;
}

/**
 * Decides whether a Problem may move to the requested status.
 *
 * Refusals are ordered from most specific to least so that the reason
 * reported is the useful one: asking for `VERIFIED` from `FIX_CANDIDATE`
 * without evidence says the evidence is missing, rather than that the move is
 * not allowed.
 */
export function decideTransition(request: TransitionRequest): TransitionDecision {
  const { currentStatus, targetStatus, hasSuccessfulVerification } = request;

  if (currentStatus === targetStatus) {
    // Not a no-op: it would move `updated_at` and record a change that never
    // happened, which is the reasoning an empty patch follows too.
    return {
      allowed: false,
      refusal: 'SAME_STATUS',
      reason: 'The problem is already in that status.',
    };
  }

  if (isTerminalProblemStatus(currentStatus)) {
    return {
      allowed: false,
      refusal: 'TERMINAL_STATUS',
      reason: 'A problem in that status cannot be moved.',
    };
  }

  if (!ALLOWED_TRANSITIONS[currentStatus].includes(targetStatus)) {
    return {
      allowed: false,
      refusal: 'NOT_ALLOWED',
      reason: 'That status change is not allowed from the problem’s current status.',
    };
  }

  if (requiresSuccessfulVerification(targetStatus) && !hasSuccessfulVerification) {
    // The rule the whole Verification entity exists to make enforceable. An
    // assistant reporting that something works is not evidence that it does,
    // so the claim has to be backed by a check that was actually carried out.
    return {
      allowed: false,
      refusal: 'VERIFICATION_REQUIRED',
      reason: 'A problem can only be verified once a successful verification exists.',
    };
  }

  return { allowed: true };
}
