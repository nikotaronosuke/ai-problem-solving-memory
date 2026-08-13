/**
 * The traversal, on its own.
 *
 * Two things are being checked, and the second matters more.
 *
 * That a policy is shown every string, however deeply it is buried — because
 * caller data is not flat, and a boundary that only reached the top level
 * would miss an Environment snapshot entirely.
 *
 * And that walking a value changes nothing else about it. `undefined` and
 * `null` mean different things on the way into a Problem update, key order is
 * observable, and an array is not a map. If the traversal normalised any of
 * that, it would be altering requests rather than inspecting them, and the
 * damage would show up as behaviour changes far from here.
 */

import { describe, expect, it } from 'vitest';

import {
  createPermissivePolicy,
  sanitizeValue,
  SanitizationRejectedError,
  type FieldPath,
  type SanitizationPolicy,
} from '../../src/sanitization/index.js';

const permissive = createPermissivePolicy();

/** Records everything it is shown, and keeps all of it. */
function recordingPolicy(): SanitizationPolicy & { seen: { value: string; field: string }[] } {
  const seen: { value: string; field: string }[] = [];
  return {
    name: 'recording',
    seen,
    inspect(value: string, field: FieldPath) {
      seen.push({ value, field: field.join('.') });
      return { kind: 'keep' };
    },
  };
}

/** Rewrites every string it sees. */
function replacingPolicy(replacement: string): SanitizationPolicy {
  return { name: 'replacing', inspect: () => ({ kind: 'replace', value: replacement }) };
}

/** Refuses any string equal to `secret`. */
function refusingPolicy(secret: string): SanitizationPolicy {
  return {
    name: 'refusing',
    inspect: (value) =>
      value === secret ? { kind: 'reject', reason: 'looks like a credential' } : { kind: 'keep' },
  };
}

const AT_ROOT: FieldPath = ['operation', '0'];

describe('every string is shown to the policy', () => {
  it('finds one at the top level', () => {
    const policy = recordingPolicy();

    sanitizeValue({ title: 'Sign-in fails' }, policy, AT_ROOT);

    expect(policy.seen).toEqual([{ value: 'Sign-in fails', field: 'operation.0.title' }]);
  });

  it('finds one inside a caller-composed snapshot', () => {
    const policy = recordingPolicy();

    // The shape here is whatever the caller sent. Nothing named it, and
    // nothing could have.
    sanitizeValue(
      { snapshot: { runtime: 'node 22.12.0', auth: { provider: 'oauth2' } } },
      policy,
      AT_ROOT,
    );

    expect(policy.seen).toEqual([
      { value: 'node 22.12.0', field: 'operation.0.snapshot.runtime' },
      { value: 'oauth2', field: 'operation.0.snapshot.auth.provider' },
    ]);
  });

  it('finds one inside an array, and says which position', () => {
    const policy = recordingPolicy();

    sanitizeValue({ tags: ['auth', ['nested', 'deeper']] }, policy, AT_ROOT);

    expect(policy.seen.map((entry) => entry.field)).toEqual([
      'operation.0.tags.0',
      'operation.0.tags.1.0',
      'operation.0.tags.1.1',
    ]);
  });

  it('finds one at any depth', () => {
    const policy = recordingPolicy();
    const deep = { a: { b: { c: { d: { e: { f: 'buried' } } } } } };

    sanitizeValue(deep, policy, AT_ROOT);

    expect(policy.seen).toEqual([{ value: 'buried', field: 'operation.0.a.b.c.d.e.f' }]);
  });

  it('finds a bare string passed as a whole argument', () => {
    const policy = recordingPolicy();

    sanitizeValue('an-identifier', policy, AT_ROOT);

    expect(policy.seen).toEqual([{ value: 'an-identifier', field: 'operation.0' }]);
  });

  it('shows the same string twice when it appears twice', () => {
    const policy = recordingPolicy();

    // Not deduplicated: each occurrence is a separate thing that would be
    // stored, and a policy may judge them differently by where they are.
    sanitizeValue({ summary: 'same', reason: 'same' }, policy, AT_ROOT);

    expect(policy.seen).toHaveLength(2);
  });

  it.each([
    ['a number', 42],
    ['a boolean', true],
    ['null', null],
    ['undefined', undefined],
    ['a date', new Date('2026-01-01T00:00:00.000Z')],
  ])('does not ask about %s', (_label, value) => {
    const policy = recordingPolicy();

    sanitizeValue({ field: value }, policy, AT_ROOT);

    expect(policy.seen).toEqual([]);
  });
});

describe('the value that comes back', () => {
  it.each([
    [
      'a problem create input',
      {
        environmentId: 'e1',
        title: 'Sign-in fails',
        symptoms: 'Only after deploying',
        problemDomain: null,
        suspectedBoundary: undefined,
        sourceAi: 'claude-code',
      },
    ],
    ['a partial update', { title: 'New title', problemDomain: null, importance: true }],
    ['an environment snapshot', { snapshot: { runtime: 'node', versions: ['22.12.0', '24'] } }],
    [
      'a change log entry',
      {
        changedBy: 'claude-code',
        fromVersion: 1,
        toVersion: 2,
        changes: {
          status: { kind: 'exact', before: 'INVESTIGATING', after: 'PAUSED' },
          title: {
            kind: 'text_redacted',
            before_present: true,
            after_present: true,
            changed: true,
          },
        },
      },
    ],
    ['an empty object', {}],
    ['an empty array', []],
  ])(
    'is indistinguishable from the input for %s, under a policy that keeps everything',
    (_label, input) => {
      // The evidence that installing the boundary changed nothing: with the
      // policy this phase ships, what goes in is what comes out.
      expect(sanitizeValue(input, permissive, AT_ROOT)).toEqual(input);
    },
  );

  it('keeps a key whose value is undefined', () => {
    const result = sanitizeValue({ title: 'kept', problemDomain: undefined }, permissive, AT_ROOT);

    // Absent and null are different instructions on a partial update. A
    // traversal that dropped this key would turn "leave it alone" into
    // "clear it".
    expect(Object.keys(result)).toEqual(['title', 'problemDomain']);
    expect('problemDomain' in result).toBe(true);
    expect(result.problemDomain).toBeUndefined();
  });

  it('keeps null as null', () => {
    expect(sanitizeValue({ repo: null }, permissive, AT_ROOT)).toEqual({ repo: null });
  });

  it('keeps key order', () => {
    const input = { z: 'one', a: 'two', m: 'three' };

    expect(Object.keys(sanitizeValue(input, permissive, AT_ROOT))).toEqual(['z', 'a', 'm']);
  });

  it('keeps an array an array, at its original length', () => {
    const result = sanitizeValue({ items: ['a', 'b', 'c'] }, permissive, AT_ROOT);

    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items).toHaveLength(3);
  });

  it('keeps a date as the same instant', () => {
    const when = new Date('2026-01-01T00:00:00.000Z');

    const result = sanitizeValue({ when }, permissive, AT_ROOT);

    // Walked into, a date would come back as an object that is no longer one.
    expect(result.when).toBeInstanceOf(Date);
    expect(result.when.toISOString()).toBe(when.toISOString());
  });

  it('leaves the caller’s object untouched', () => {
    const input = { title: 'original', nested: { summary: 'original' } };

    const result = sanitizeValue(input, replacingPolicy('rewritten'), AT_ROOT);

    // Rebuilt rather than mutated, so a service is never surprised by its own
    // input changing, and a refusal partway through leaves nothing altered.
    expect(input).toEqual({ title: 'original', nested: { summary: 'original' } });
    expect(result).toEqual({ title: 'rewritten', nested: { summary: 'rewritten' } });
    expect(result.nested).not.toBe(input.nested);
  });

  it('carries a replacement through, at any depth', () => {
    const result = sanitizeValue(
      { snapshot: { token: 'value', list: ['value'] } },
      replacingPolicy('[removed]'),
      AT_ROOT,
    );

    expect(result).toEqual({ snapshot: { token: '[removed]', list: ['[removed]'] } });
  });
});

describe('a refusal', () => {
  it('stops the whole value, not just the field', () => {
    const refusing = refusingPolicy('sk-live-do-not-store');

    expect(() =>
      sanitizeValue({ summary: 'fine', reason: 'sk-live-do-not-store' }, refusing, AT_ROOT),
    ).toThrow(SanitizationRejectedError);
  });

  it('reaches into nested input to find it', () => {
    const refusing = refusingPolicy('sk-live-do-not-store');

    expect(() =>
      sanitizeValue({ snapshot: { env: { API_KEY: 'sk-live-do-not-store' } } }, refusing, AT_ROOT),
    ).toThrow(SanitizationRejectedError);
  });

  it('names where it was and why, and never the value', () => {
    const secret = 'sk-live-do-not-store';

    try {
      sanitizeValue({ snapshot: { api_key: secret } }, refusingPolicy(secret), AT_ROOT);
      expect.unreachable('the policy should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(SanitizationRejectedError);
      const rejected = error as SanitizationRejectedError;

      expect(rejected.field).toBe('operation.0.snapshot.api_key');
      expect(rejected.reason).toBe('looks like a credential');
      // An error travels — into a log, into a report, through several layers.
      // The one mechanism built to keep a secret out of storage must not be
      // the mechanism that copies it somewhere else.
      expect(rejected.message).not.toContain(secret);
      expect(JSON.stringify(rejected)).not.toContain(secret);
      expect(rejected.stack ?? '').not.toContain(secret);
    }
  });

  it('refuses a value that refers to itself', () => {
    const cyclic: Record<string, unknown> = { title: 'a problem' };
    cyclic.self = cyclic;

    // Nothing cyclic can be stored, so refusing is both honest and what stops
    // the traversal recursing forever.
    expect(() => sanitizeValue(cyclic, permissive, AT_ROOT)).toThrow(SanitizationRejectedError);
  });

  it('does not mistake the same object appearing twice for a cycle', () => {
    const shared = { runtime: 'node 22.12.0' };

    expect(() => sanitizeValue({ a: shared, b: shared }, permissive, AT_ROOT)).not.toThrow();
  });
});

describe('the policy this phase ships', () => {
  it('decides nothing', () => {
    // P3-01 installs the boundary. Detection is P3-02 and refusal is P3-03,
    // and a provisional guess here would be worse than an honest absence.
    for (const value of [
      'sk-live-51H8fakeexamplekeyvalue',
      'password=hunter2',
      '-----BEGIN PRIVATE KEY-----',
      'ordinary prose about a redirect',
      '',
    ]) {
      expect(permissive.inspect(value, AT_ROOT)).toEqual({ kind: 'keep' });
    }
  });

  it('says what it is', () => {
    expect(permissive.name).toContain('p3-01');
  });
});
