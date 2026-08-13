/**
 * What a sanitization policy is, and what it is allowed to decide.
 *
 * This phase builds the boundary, not the judgement. Which strings are secrets
 * is P3-02's, and what to do about one — refuse the write or store it with the
 * value irreversibly removed — is P3-03's. Both arrive as a policy, behind the
 * one interface here, and neither will need the boundary to change shape to
 * accommodate it.
 *
 * The interface is deliberately narrow, and narrower than it first looks. A
 * policy is shown one string and where it came from, and answers with one of
 * three outcomes. It cannot reach the database, cannot decide whether a write
 * happens, and — the part that matters most — cannot attach prose of its own to
 * a refusal. See `SanitizationOutcome`.
 *
 * Keys are inspected as well as values. A caller can put arbitrary text in an
 * object key — an Environment snapshot accepts whatever JSON was sent — so a
 * boundary that only looked at values would let a secret through by the simple
 * trick of naming a field after it.
 */

/**
 * One step in the path to a string, and who chose it.
 *
 * Structured rather than a plain string array because the difference matters
 * for what may safely leave the process. `operation`, `argument` and `element`
 * are the boundary's own; a `key` is text the caller chose and could be
 * anything at all, including the secret being refused.
 *
 * A `key` segment only ever appears once the policy has approved that key —
 * keys are inspected before they are appended — which is what makes a rendered
 * path safe by construction rather than by anyone remembering to check.
 * `redactedKey` is what a refused key becomes, and it never carries the text.
 */
export type PathSegment =
  | { readonly kind: 'operation'; readonly name: string }
  | { readonly kind: 'argument'; readonly index: number }
  | { readonly kind: 'element'; readonly index: number }
  | { readonly kind: 'key'; readonly name: string }
  | { readonly kind: 'redactedKey' };

/**
 * Where a string was found, outermost first.
 *
 * A policy needs this because the same string means different things in
 * different places: a long opaque token in `evidenceRef` is a reference, and in
 * `symptoms` it is probably a leaked credential.
 */
export type FieldPath = readonly PathSegment[];

/** Whether the inspected string is a value, or the key naming one. */
export type SanitizationLocationKind = 'value' | 'key';

/** What is being inspected, and where it sits. */
export interface SanitizationSite {
  readonly path: FieldPath;
  readonly kind: SanitizationLocationKind;
}

/**
 * Renders a path for a message or a log line.
 *
 * Safe to log. Every `key` segment was approved by the policy before it was
 * appended, and a refused key is a `redactedKey`, which has no text to render.
 */
export function formatFieldPath(path: FieldPath): string {
  return path
    .map((segment) => {
      switch (segment.kind) {
        case 'operation':
          return segment.name;
        case 'argument':
        case 'element':
          return `[${String(segment.index)}]`;
        case 'key':
          return `.${segment.name}`;
        case 'redactedKey':
          return '.<redacted>';
      }
    })
    .join('');
}

/**
 * What a policy decided about one string.
 *
 * `replace` exists so P3-03 can keep the surrounding meaning while removing the
 * value — a summary that says what happened, with the token gone. It returns
 * the replacement rather than mutating anything, so the boundary stays the only
 * thing that decides what is actually written.
 *
 * `reject` carries nothing. That is the whole point of it: a policy cannot
 * explain itself, because an explanation is free text written by a policy
 * author who has the offending value in hand, and the obvious thing to write is
 * the value. A refusal then travels into an error, into a log line, and
 * possibly into a report — so the one mechanism built to keep a secret out of
 * storage would be the mechanism that copied it somewhere nobody checks.
 *
 * There is no field here to put it in. TypeScript refuses the version written
 * with an explicit return type, and — the guarantee that does not depend on how
 * someone happened to write their function — the boundary reads `kind` and
 * `value` from an outcome and nothing else, so anything a policy attaches
 * regardless goes nowhere at all.
 *
 * What an operator gets instead is the policy's name, the locator and whether
 * it was a key or a value, all of which the boundary controls.
 *
 * When P3-02 has defined its detection categories, a closed union of codes can
 * be added here deliberately — a fixed set of identifiers, never prose.
 */
export type SanitizationOutcome =
  | { readonly kind: 'keep' }
  | { readonly kind: 'replace'; readonly value: string }
  | { readonly kind: 'reject' };

export interface SanitizationPolicy {
  /**
   * Identifies the policy in operational logs.
   *
   * Fixed when the policy is built, not chosen per value, so it can be logged
   * on a refusal without any risk of carrying one.
   */
  readonly name: string;

  /**
   * Decides whether one string may be persisted, and in what form.
   *
   * Called for every string reachable in a write — every value, and every key
   * naming one — including inside nested objects and arrays. Must be pure: the
   * boundary may call it in any order, and calls it before anything reaches the
   * database.
   */
  inspect(text: string, at: SanitizationSite): SanitizationOutcome;
}

/**
 * Raised when a policy refuses a value or a key.
 *
 * Everything on it is the boundary's own. The refused string is absent, and so
 * is anything the policy wrote, because a policy cannot write anything. What
 * remains is where it happened, which of a key or a value it was, and which
 * policy refused — the three things an operator needs, and none of them the
 * secret.
 */
export class SanitizationRejectedError extends Error {
  /** Where it happened. Contains no caller text that was not approved. */
  readonly locator: string;

  /** Whether the refused string was a value or the key naming one. */
  readonly kind: SanitizationLocationKind;

  /** Which policy refused it. Fixed at construction, never per value. */
  readonly policy: string;

  constructor(site: SanitizationSite, policy: string) {
    super(`A ${site.kind} at ${formatFieldPath(site.path)} cannot be stored (policy: ${policy}).`);
    this.name = 'SanitizationRejectedError';
    this.locator = formatFieldPath(site.path);
    this.kind = site.kind;
    this.policy = policy;
  }
}

/**
 * Raised when a policy asks for something the boundary cannot do safely.
 *
 * Only one case today: renaming an object key. Replacing a key is not the same
 * act as replacing a value — it can collide with a key already present and
 * silently merge two fields into one, and deciding what should happen then is a
 * design question that belongs with P3-03's redaction rules rather than being
 * invented here.
 *
 * Refusing loudly is the honest answer. Quietly treating it as a rejection, or
 * quietly applying it and hoping, would both hide a decision nobody has made.
 * This is a programming error rather than a bad request, so it is not caught
 * anywhere and surfaces as an internal failure.
 */
export class UnsupportedSanitizationOutcomeError extends Error {
  readonly locator: string;
  readonly policy: string;

  constructor(site: SanitizationSite, policy: string, detail: string) {
    super(`${detail} at ${formatFieldPath(site.path)} (policy: ${policy}).`);
    this.name = 'UnsupportedSanitizationOutcomeError';
    this.locator = formatFieldPath(site.path);
    this.policy = policy;
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
