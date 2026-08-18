/**
 * What can survive the journey to the server unchanged.
 *
 * An Environment snapshot is the one place this API accepts a shape it does not
 * describe: the conditions that mattered to a problem differ by problem, so the
 * keys inside are the caller's. That freedom stops at what JSON can carry, and
 * the gap between "a JavaScript object" and "a JSON object" is where a client
 * quietly sends something other than what it was handed.
 *
 * `JSON.stringify` does not fail on the difference — it papers over it. Values
 * disappear (`undefined`, functions, symbols, non-enumerable properties,
 * anything under a symbol key), values change (`NaN` and `Infinity` become
 * `null`, `-0` becomes `0`, a `Date` becomes a string, a hole in an array
 * becomes `null`), and a `Map` becomes `{}`. A value can also replace itself
 * wholesale through a `toJSON` method it inherited. Every one of those is a
 * snapshot that records something the caller did not say, stored permanently
 * as though they had.
 *
 * So a snapshot is checked before it is serialised, and nothing is coerced. A
 * value this contract cannot carry is a mistake to report, not a value to
 * convert on somebody's behalf — the caller knows whether that timestamp should
 * have been an ISO string or a number of seconds, and this module does not.
 *
 * ## Why descriptors rather than values
 *
 * The obvious way to walk an object is `Object.values`, and it is wrong twice.
 * It cannot see a symbol key or a non-enumerable property, so both pass
 * validation and then vanish on the wire. And it *invokes getters* — so a
 * validator built on it runs arbitrary caller code while deciding whether that
 * code's result is data, which is both a side effect nobody asked for and an
 * answer about a value that will be computed again later, possibly differently.
 *
 * Reading a property descriptor answers the same question without either
 * problem. An accessor's descriptor carries `get` and `set` and no `value`, so
 * it is refused by shape rather than by evaluation, and the getter is never
 * called.
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
 * Whether serialising this value would run code that replaces it.
 *
 * `JSON.stringify` looks up `toJSON` the ordinary way — through the prototype
 * chain — and if it finds a function it calls it and serialises the result
 * instead. So a value can pass every structural check here and still arrive as
 * something else entirely, which is what an array subclass carrying a
 * `toJSON` does: its own keys are a perfectly dense list, and the wire gets
 * whatever the method returned.
 *
 * The lookup is done with descriptors and stops at the first own `toJSON`
 * found, which is how shadowing works. Three outcomes:
 *
 * - an accessor — refused, because `stringify`'s own lookup would run the
 *   getter, and so would this check if it read the property instead;
 * - a callable data property — refused, because it would be invoked;
 * - a data property that is not callable — safe. It shadows anything deeper
 *   and `stringify` treats it as the ordinary data it is, so a value is not
 *   refused merely for having a key with this name.
 *
 * Nothing here is invoked, and nothing is read by ordinary property access.
 */
function hasExecutableSerializationHook(value: object): boolean {
  let current: object | null = value;

  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, 'toJSON');
    if (descriptor !== undefined) {
      if (!('value' in descriptor)) {
        return true;
      }
      return typeof descriptor.value === 'function';
    }
    current = Object.getPrototypeOf(current) as object | null;
  }

  return false;
}

/**
 * Whether an own property is one `JSON.stringify` would write out as data.
 *
 * Three ways to fail, and each of them is silent in serialisation: an accessor
 * is computed rather than stored, a non-enumerable property is skipped, and a
 * missing descriptor means the key was not really there.
 */
function isDataProperty(descriptor: PropertyDescriptor | undefined): boolean {
  return descriptor !== undefined && 'value' in descriptor && descriptor.enumerable === true;
}

/**
 * Whether an array is dense plain data.
 *
 * The count check first, and it is what keeps this cheap: `Reflect.ownKeys`
 * returns one entry per property that actually exists, so a million-element
 * sparse array reports a handful of keys against a huge `length` and is refused
 * without walking anything. Only an array whose key count already matches its
 * length is worth iterating, which bounds the work to the elements that are
 * genuinely there.
 *
 * What that count rules out, together: a hole anywhere, an extra property
 * hung off the array, and a symbol key. The per-index pass then rules out an
 * accessor or a non-enumerable index, and checks the values.
 */
function isJsonArray(value: readonly unknown[], seen: Set<object>): boolean {
  const keys = Reflect.ownKeys(value);

  // Every index, plus `length` itself, and nothing else.
  if (keys.length !== value.length + 1) {
    return false;
  }
  // Stated rather than left to the count, because "a symbol key is refused" is
  // the rule, and a rule that holds only as a side effect of arithmetic is one
  // somebody can break without noticing.
  if (keys.some((key) => typeof key === 'symbol')) {
    return false;
  }

  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!isDataProperty(descriptor)) {
      return false;
    }
    if (!isJsonValue(descriptor?.value, seen)) {
      return false;
    }
  }

  return true;
}

/** Whether a plain object holds nothing but string-keyed JSON data. */
function isJsonRecord(value: object, seen: Set<object>): boolean {
  if (!isPlainObject(value)) {
    return false;
  }

  for (const key of Reflect.ownKeys(value)) {
    // A symbol-keyed property is invisible to serialisation, so a snapshot
    // carrying one would arrive missing something the caller put in it.
    if (typeof key === 'symbol') {
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!isDataProperty(descriptor)) {
      return false;
    }
    if (!isJsonValue(descriptor?.value, seen)) {
      return false;
    }
  }

  return true;
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
    // `null` for each of them rather than refusing. Negative zero is the same
    // problem wearing a subtler disguise: it is a finite number, it survives
    // every check a finite number passes, and it comes back as `0` — a
    // different value that compares equal to the one sent, so nothing
    // downstream would ever notice the difference.
    case 'number':
      return Number.isFinite(value) && !Object.is(value, -0);
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

  // Before the structure, because the structure stops mattering the moment
  // something else is serialised in its place.
  if (hasExecutableSerializationHook(value)) {
    return false;
  }

  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  try {
    return Array.isArray(value) ? isJsonArray(value, seen) : isJsonRecord(value, seen);
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
