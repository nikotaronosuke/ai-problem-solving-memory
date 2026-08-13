/**
 * Walking a value so a policy sees every string in it.
 *
 * The problem this solves is that caller data is not flat, and not only its
 * values are caller-written. An Environment snapshot is arbitrary JSON the
 * caller composed — both the keys and the values are theirs — and a change
 * log's `changes` is a map whose shape depends on which fields moved. A
 * boundary that checked named fields would be correct for exactly as long as
 * nobody added a field, would never reach inside a snapshot at all, and would
 * miss anything written into a key.
 *
 * So nothing here is named. The traversal descends through objects and arrays
 * until it reaches primitives, and hands every string to the policy: keys as
 * well as values.
 *
 * Order is deliberate. A key is inspected before it is appended to the path,
 * and before its value is looked at, so a key the policy refuses never enters a
 * path at all and its value is never even reached.
 *
 * That ordering is not what makes anything safe to log, and an earlier version
 * of this comment claimed it was. The path built here keeps raw caller keys,
 * because detection needs them — `snapshot.auth.token` is what tells a policy
 * how to read the value beneath it. A policy keeping a key means it may be
 * persisted, which is a different question from whether it may be copied into
 * an operational log: a secret detector keeps an email address for being
 * not-a-secret, and that says nothing about log files. So the path assembled
 * here is context for a decision and is not safe to render outward.
 * `formatSafeLocator` is what errors and logs use, and it drops every caller
 * key unconditionally, kept or refused.
 *
 * Two other properties matter.
 *
 * It rebuilds rather than mutates. The caller's object is never written to, so
 * a service cannot be surprised by its own input changing underneath it, and a
 * rejection partway through leaves nothing half-altered.
 *
 * It preserves shape exactly. Same keys in the same order, keys whose value is
 * `undefined` still present, arrays the same length, `null` still `null`. That
 * is not tidiness: `undefined` and `null` mean different things on the way into
 * a Problem update — leave this field alone, versus clear it — and a traversal
 * that quietly collapsed them would change what a patch does. With a policy
 * that keeps every string, the result is indistinguishable from the input, and
 * a test asserts exactly that against the real request shapes.
 */

import {
  SanitizationRejectedError,
  UnsupportedSanitizationOutcomeError,
  type FieldPath,
  type SanitizationPolicy,
  type SanitizationSite,
} from './policy.js';

/**
 * Values passed through without being descended into.
 *
 * A `Date` is a value, not a container: walking its properties would produce
 * an object that is no longer a date. The rest cannot hold a string at all.
 */
function isOpaque(value: unknown): boolean {
  return value instanceof Date;
}

/**
 * Returns `value` with every string in it replaced by what the policy allows.
 *
 * Throws `SanitizationRejectedError` at the first refusal, which is what stops
 * the write: this runs before anything reaches the database, so a refusal means
 * no statement was issued at all.
 */
export function sanitizeValue<T>(value: T, policy: SanitizationPolicy, path: FieldPath): T {
  return walk(value, policy, path, new WeakSet()) as T;
}

function walk(
  value: unknown,
  policy: SanitizationPolicy,
  path: FieldPath,
  seen: WeakSet<object>,
): unknown {
  if (typeof value === 'string') {
    return decide(value, policy, { path, kind: 'value' });
  }

  if (value === null || typeof value !== 'object' || isOpaque(value)) {
    // Numbers, booleans, undefined, bigint, symbols and dates: nothing a
    // policy inspects, and nothing to descend into.
    return value;
  }

  if (seen.has(value)) {
    // A cycle cannot be stored — it has no JSON representation — so refusing
    // is both the honest answer and the one that avoids recursing forever.
    throw new UnsupportedSanitizationOutcomeError(
      { path, kind: 'value' },
      'A value refers to itself and cannot be stored',
    );
  }
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) =>
        walk(entry, policy, [...path, { kind: 'element', index }], seen),
      );
    }

    // Own enumerable keys, in their original order, including any whose value
    // is `undefined` — dropping those would turn "leave this alone" into
    // "clear this" on a partial update.
    const rebuilt: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      // The key first, and while the path still ends at this object. A refusal
      // here therefore reports the parent plus a redacted step, and the
      // refused text never reaches a locator.
      const kept = decideKey(key, policy, { path, kind: 'key' });
      rebuilt[kept] = walk(entry, policy, [...path, { kind: 'key', name: kept }], seen);
    }
    return rebuilt;
  } finally {
    // Released so a value legitimately appearing twice in different branches
    // is not mistaken for a cycle.
    seen.delete(value);
  }
}

function decide(text: string, policy: SanitizationPolicy, at: SanitizationSite): string {
  const outcome = policy.inspect(text, at);

  switch (outcome.kind) {
    case 'keep':
      return text;
    case 'replace':
      return outcome.value;
    case 'reject':
      // Built from the site alone, with the caller's keys already stripped out
      // of it. A policy has no way to contribute text, so there is nothing here
      // that could be the value or anything else it was shown.
      throw new SanitizationRejectedError(at);
  }
}

/**
 * Decides a key, and refuses to rename one.
 *
 * Replacing a key is not the same act as replacing a value: the replacement can
 * collide with a key already present and silently merge two fields into one.
 * What should happen then is a real design question, and it belongs with
 * P3-03's redaction rules rather than being settled here by whichever behaviour
 * was easiest to implement.
 *
 * A refusal is reported against the parent path with a redacted step, so the
 * key — which is exactly the string being refused — is not named anywhere.
 */
function decideKey(key: string, policy: SanitizationPolicy, at: SanitizationSite): string {
  const outcome = policy.inspect(key, at);

  switch (outcome.kind) {
    case 'keep':
      return key;
    case 'replace':
      throw new UnsupportedSanitizationOutcomeError(
        redacted(at),
        'A policy asked to rename an object key, which is not supported',
      );
    case 'reject':
      throw new SanitizationRejectedError(redacted(at));
  }
}

/** The site of a refused key: the parent path, plus a step that has no text. */
function redacted(at: SanitizationSite): SanitizationSite {
  return { path: [...at.path, { kind: 'redactedKey' }], kind: at.kind };
}
