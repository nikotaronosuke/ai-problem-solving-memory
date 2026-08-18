/**
 * What can survive the journey to the server unchanged.
 *
 * An Environment snapshot is the one place this API accepts a shape it does not
 * describe: the conditions that mattered to a problem differ by problem, so the
 * keys inside are the caller's. That freedom stops at what JSON can carry, and
 * the gap between "a JavaScript object" and "a JSON object" is where a client
 * quietly sends something other than what it was handed.
 *
 * `JSON.stringify` does not fail on the difference — it papers over it.
 * `undefined`, a function and a symbol vanish from an object; `NaN` and
 * `Infinity` become `null`; a `Date` becomes a string; a `Map` becomes `{}`; a
 * `bigint` throws only sometimes, depending on where it sits. Every one of
 * those is a snapshot that records something the caller did not say, stored
 * permanently as though they had.
 *
 * So a snapshot is checked before it is serialised, and nothing is coerced. A
 * value this contract cannot carry is a mistake to report, not a value to
 * convert on somebody's behalf — the caller knows whether that timestamp should
 * have been an ISO string or a number of seconds, and this module does not.
 */

/** The scalars JSON has. */
export type JsonPrimitive = string | number | boolean | null;

/** Anything JSON can hold. */
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** A JSON object: the shape a snapshot has to be at the top level. */
export type JsonObject = { readonly [key: string]: JsonValue };

/**
 * Whether this is a plain object rather than something wearing one's shape.
 *
 * A `Date`, a `Map`, a `RegExp` and a class instance are all `typeof 'object'`
 * and none of them survives serialisation as itself. The prototype check is
 * what separates the object literals and `Object.create(null)` records this
 * contract can carry from everything else.
 */
function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Whether a value is JSON all the way down.
 *
 * `seen` holds the objects on the path from the root to here, so a structure
 * that points back at one of its own ancestors is refused while a value
 * referenced twice in different branches — which serialises perfectly well — is
 * not.
 */
function isJsonValue(value: unknown, seen: Set<object>): boolean {
  if (value === null) {
    return true;
  }

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    // `NaN` and both infinities have no JSON spelling, and `stringify` writes
    // `null` for each of them rather than refusing.
    case 'number':
      return Number.isFinite(value);
    // Everything below is a value that either disappears or changes shape.
    case 'undefined':
    case 'function':
    case 'symbol':
    case 'bigint':
      return false;
    default:
      break;
  }

  if (typeof value !== 'object') {
    return false;
  }

  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.every((entry) => isJsonValue(entry, seen));
    }
    if (!isPlainObject(value)) {
      return false;
    }
    // `Object.values` skips symbol-keyed properties, which is what serialisation
    // does too, so a symbol key is not a reason to refuse an otherwise good
    // object — its value was never going to travel and nothing is lost.
    return Object.values(value).every((entry) => isJsonValue(entry, seen));
  } finally {
    seen.delete(value);
  }
}

/**
 * Whether a value is a JSON object this client can send unchanged.
 *
 * The top level must be an object: an array, a string or a number is a
 * different thing from a snapshot, and the server says so too.
 */
export function isJsonObject(value: unknown): value is JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  return isJsonValue(value, new Set<object>());
}
