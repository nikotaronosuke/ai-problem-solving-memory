/**
 * What a sanitization policy is, and what it is allowed to decide.
 *
 * This phase builds the boundary, not the judgement. Which strings are secrets
 * is P3-02's, and what to do about one — refuse the write or store it with the
 * value irreversibly removed — is P3-03's. Both arrive as a policy, behind the
 * one interface here, and neither will need the boundary to change shape to
 * accommodate it.
 *
 * The interface is deliberately narrow. A policy is shown one string and where
 * it came from, and answers with one of three outcomes. It is not given the
 * whole record, cannot reach the database, and cannot decide whether a write
 * happens — only whether this value may be stored, and in what form. Keeping it
 * that small is what lets the boundary guarantee the policy was consulted for
 * every value: there is nothing else the policy could have needed.
 */

/**
 * Where a value was found, outermost first.
 *
 * The first element is the repository operation, the second the argument
 * position, and the rest are object keys and array indices as they were
 * traversed — so `appendEvent.1.summary` and
 * `createEnvironment.0.snapshot.deployment` both say exactly where the string
 * was, including inside caller-supplied JSON.
 *
 * A policy needs this because the same string means different things in
 * different places: a long opaque token in `evidence_ref` is a reference, and
 * in `symptoms` it is probably a leaked credential. P3-02 is where that
 * judgement belongs, and this is what it will judge on.
 */
export type FieldPath = readonly string[];

/** Renders a path for a message or a log line. Never includes the value. */
export function formatFieldPath(path: FieldPath): string {
  return path.join('.');
}

/**
 * What a policy decided about one string.
 *
 * `replace` exists so P3-03 can keep the surrounding meaning while removing the
 * value — a summary that says what happened, with the token gone. It returns
 * the replacement rather than mutating anything, so the boundary stays the only
 * thing that decides what is actually written.
 */
export type SanitizationOutcome =
  | { readonly kind: 'keep' }
  | { readonly kind: 'replace'; readonly value: string }
  | { readonly kind: 'reject'; readonly reason: string };

export interface SanitizationPolicy {
  /** Identifies the policy in operational logs. Not part of any API. */
  readonly name: string;

  /**
   * Decides whether one string may be persisted, and in what form.
   *
   * Called for every string reachable in a write, including inside nested
   * objects and arrays. Must be pure: the boundary may call it in any order,
   * and calls it before anything reaches the database.
   */
  inspect(value: string, field: FieldPath): SanitizationOutcome;
}

/**
 * Raised when a policy refuses a value.
 *
 * The offending string is deliberately absent from the error, and must stay
 * absent. An error object travels: into a log line, possibly into a report, and
 * through several layers on its way out. Putting the rejected value in it would
 * mean the one mechanism built to keep secrets out of storage is also the
 * mechanism that copies them somewhere nobody thought to check.
 *
 * What it carries instead is where the value was and why it was refused — the
 * two things an operator needs, and neither of which is the secret.
 */
export class SanitizationRejectedError extends Error {
  /** Where the refused value was found. Contains no part of the value. */
  readonly field: string;

  /** Why the policy refused it. Written by the policy; never the value. */
  readonly reason: string;

  constructor(field: FieldPath, reason: string) {
    super(`A value at ${formatFieldPath(field)} cannot be stored: ${reason}`);
    this.name = 'SanitizationRejectedError';
    this.field = formatFieldPath(field);
    this.reason = reason;
  }
}

/**
 * The policy this phase ships: it decides nothing.
 *
 * P3-01 exists to make the boundary unavoidable, and a boundary is easier to
 * verify when nothing passing through it changes. Every string is kept, so the
 * API contract, the stored data and every Phase 2 test behave exactly as they
 * did — which is the evidence that the boundary was installed without altering
 * what it now sits in front of.
 *
 * This is not a provisional secret check and must not be mistaken for one.
 * There is no pattern list here, no threshold, and no guess. Detection is
 * P3-02, and refusal or redaction is P3-03; until those exist, the honest
 * behaviour is to say so rather than to half-implement them.
 */
export function createPermissivePolicy(): SanitizationPolicy {
  return {
    name: 'permissive/p3-01-boundary-only',
    inspect: () => ({ kind: 'keep' }),
  };
}
