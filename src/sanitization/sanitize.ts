/**
 * Walking a value so a policy sees every string in it.
 *
 * The problem this solves is that caller data is not flat. An Environment
 * snapshot is arbitrary JSON the caller composed; a change log's `changes` is a
 * map whose shape depends on which fields moved. A boundary that checked named
 * fields would be correct for exactly as long as nobody added a field, and
 * would never reach inside a snapshot at all.
 *
 * So nothing here is named. The traversal descends through objects and arrays
 * until it reaches primitives, and hands every string to the policy with the
 * path it was found at.
 *
 * Two properties matter more than anything else here.
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

import { SanitizationRejectedError, type FieldPath, type SanitizationPolicy } from './policy.js';

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
    return decide(value, policy, path);
  }

  if (value === null || typeof value !== 'object' || isOpaque(value)) {
    // Numbers, booleans, undefined, bigint, symbols and dates: nothing a
    // policy inspects, and nothing to descend into.
    return value;
  }

  if (seen.has(value)) {
    // A cycle cannot be stored — it has no JSON representation — so refusing
    // is both the honest answer and the one that avoids recursing forever.
    // The reason names the shape, never the contents.
    throw new SanitizationRejectedError(path, 'the value contains a cycle');
  }
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) => walk(entry, policy, [...path, String(index)], seen));
    }

    // Own enumerable keys, in their original order, including any whose value
    // is `undefined` — dropping those would turn "leave this alone" into
    // "clear this" on a partial update.
    const rebuilt: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      rebuilt[key] = walk(entry, policy, [...path, key], seen);
    }
    return rebuilt;
  } finally {
    // Released so a value legitimately appearing twice in different branches
    // is not mistaken for a cycle.
    seen.delete(value);
  }
}

function decide(value: string, policy: SanitizationPolicy, path: FieldPath): string {
  const outcome = policy.inspect(value, path);

  switch (outcome.kind) {
    case 'keep':
      return value;
    case 'replace':
      return outcome.value;
    case 'reject':
      throw new SanitizationRejectedError(path, outcome.reason);
  }
}
