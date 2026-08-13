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
 * happens, and cannot contribute any text of its own — no reason, no name,
 * nothing. That last part is not tidiness: see `SanitizationOutcome`.
 *
 * Keys are inspected as well as values. A caller can put arbitrary text in an
 * object key — an Environment snapshot accepts whatever JSON was sent — so a
 * boundary that only looked at values would let a secret through by the simple
 * trick of naming a field after it.
 *
 * Two kinds of safety are kept apart here, and conflating them was a real bug
 * in an earlier version of this file. "May be persisted" is what a policy
 * decides. "May be copied into an operational log" is a different question with
 * a different answer, and the boundary answers it alone. A secret detector
 * keeps an email address, a customer name and a file path — all correct, none
 * of them things to write into a log line. So nothing a caller sent, and
 * nothing a policy supplied, is ever rendered into an error or a log.
 */

/**
 * One step in the path to a string, and who chose it.
 *
 * Structured rather than a plain string array because the difference matters
 * for what may leave the process. `operation`, `argument` and `element` are the
 * boundary's own; a `key` is text the caller chose and could be anything at
 * all.
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
 * Carries raw caller keys, because a policy needs them: the same string means
 * different things in different places, and `snapshot.auth.token` is what tells
 * a detector how to read the value under it. This is in-process context for
 * making a decision, and it is not safe to render anywhere else.
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
 * Renders a path with its caller-written keys intact.
 *
 * NOT SAFE TO LOG, and not safe to put in an error. It exists so a policy can
 * reason about where it is, and so tests can assert what a policy was shown.
 * Anything leaving the process wants `formatSafeLocator`.
 */
export function describeInspectionPath(path: FieldPath): string {
  return render(path, (name) => `.${name}`);
}

/**
 * Renders a path with every caller-written key removed.
 *
 * This is the only form that goes into an error or a log. It keeps what the
 * server chose — the operation, the argument position, array indices — and the
 * shape of the descent, and drops every key name.
 *
 * Keys are dropped whether or not the policy kept them. An earlier version
 * rendered approved keys, on the reasoning that the policy had cleared them,
 * and that was wrong: a secret detector keeps an email address because it is
 * not a secret, not because it belongs in a log file. Deciding what may be
 * stored and deciding what may be copied into operational output are different
 * questions, and only one of them is the policy's.
 *
 * The cost is real. `createEnvironment[0].<key>.<key>.<redacted>` says less
 * than a field name would; an operator gets the operation, the depth, the array
 * positions and whether a key or a value was refused, then reproduces it
 * locally from the request id. That is a worse debugging experience and a
 * correct one, and there is no version of this that is both maximally helpful
 * and safe.
 */
export function formatSafeLocator(path: FieldPath): string {
  return render(path, () => '.<key>');
}

function render(path: FieldPath, key: (name: string) => string): string {
  return path
    .map((segment) => {
      switch (segment.kind) {
        case 'operation':
          return segment.name;
        case 'argument':
        case 'element':
          return `[${String(segment.index)}]`;
        case 'key':
          return key(segment.name);
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
 * explain itself, because an explanation is free text written by someone who
 * has the offending value in hand, and the obvious thing to write is the value.
 * A refusal then travels into an error, into a log line, and possibly into a
 * report — so the one mechanism built to keep a secret out of storage would be
 * the mechanism that copied it somewhere nobody checks.
 *
 * There is no field here to put it in. TypeScript refuses the version written
 * with an explicit return type, and — the guarantee that does not depend on how
 * someone happened to write their function — the boundary reads `kind` and
 * `value` from an outcome and nothing else, so anything a policy attaches
 * regardless goes nowhere at all.
 *
 * When P3-02 has defined its detection categories, a closed union of codes can
 * be added here deliberately. A fixed set of identifiers is safe in a way that
 * free text is not, and the difference is exactly that nobody can write a value
 * into an enum.
 */
export type SanitizationOutcome =
  | { readonly kind: 'keep' }
  | { readonly kind: 'replace'; readonly value: string }
  | { readonly kind: 'reject' };

/**
 * A policy: one method, and no text of its own.
 *
 * There is deliberately no `name`. An earlier version had one and put it in
 * every refusal, on the reasoning that it was fixed at construction rather than
 * chosen per value — but fixed-at-construction free text is still free text
 * that a configuration mistake can fill with a credential, and it reached the
 * operational log by the same route the removed `reason` field had. Which
 * policy is configured is a deployment fact; if it needs to be visible it
 * belongs in a startup line written by the composition root, not attached to
 * every failure.
 */
export interface SanitizationPolicy {
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
 * Everything on it is written by the boundary. There is no caller text and no
 * policy text, because neither is available to put here: the locator has had
 * its keys removed, and a policy has nothing it could have contributed.
 *
 * What remains is where it happened and which of a key or a value it was.
 */
export class SanitizationRejectedError extends Error {
  /** Where it happened, with every caller-written key removed. */
  readonly locator: string;

  /** Whether the refused string was a value or the key naming one. */
  readonly kind: SanitizationLocationKind;

  constructor(site: SanitizationSite) {
    super(`A ${site.kind} at ${formatSafeLocator(site.path)} cannot be stored.`);
    this.name = 'SanitizationRejectedError';
    this.locator = formatSafeLocator(site.path);
    this.kind = site.kind;
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
 * This is a programming error rather than a bad request, so nothing catches it
 * and it surfaces as an internal failure — which means the whole error, message
 * and stack included, is written to the log by the generic handler. `detail` is
 * therefore a literal from this module's own call sites, never anything a
 * policy or a caller supplied.
 */
export class UnsupportedSanitizationOutcomeError extends Error {
  /** Where it happened, with every caller-written key removed. */
  readonly locator: string;

  constructor(site: SanitizationSite, detail: string) {
    super(`${detail} at ${formatSafeLocator(site.path)}.`);
    this.name = 'UnsupportedSanitizationOutcomeError';
    this.locator = formatSafeLocator(site.path);
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
  return { inspect: () => ({ kind: 'keep' }) };
}
