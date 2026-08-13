/**
 * The traversal, on its own.
 *
 * Three things are being checked.
 *
 * That a policy is shown every string, however deeply it is buried, and
 * whether it is a value or the key naming one — because caller data is not
 * flat and its keys are caller-written too. An Environment snapshot stores
 * whatever JSON was sent, so a boundary that inspected only values could be
 * walked around by naming a field after the secret.
 *
 * That walking a value changes nothing else about it. `undefined` and `null`
 * mean different things on the way into a Problem update, key order is
 * observable, and an array is not a map. If the traversal normalised any of
 * that, it would be altering requests rather than inspecting them, and the
 * damage would show up as behaviour changes far from here.
 *
 * And that the boundary does not leak what it refused. A refused key is
 * exactly the string that must not escape, and it is also what a naive locator
 * would be built from.
 */

import { describe, expect, it } from 'vitest';

import {
  createPermissivePolicy,
  formatFieldPath,
  sanitizeValue,
  SanitizationRejectedError,
  UnsupportedSanitizationOutcomeError,
  type FieldPath,
  type SanitizationOutcome,
  type SanitizationPolicy,
  type SanitizationSite,
} from '../../src/sanitization/index.js';

const permissive = createPermissivePolicy();

interface Sighting {
  readonly text: string;
  readonly at: string;
  readonly kind: 'key' | 'value';
}

/** Records everything it is shown, and keeps all of it. */
function recordingPolicy(): SanitizationPolicy & { seen: Sighting[] } {
  const seen: Sighting[] = [];
  return {
    name: 'recording',
    seen,
    inspect(text: string, at: SanitizationSite) {
      seen.push({ text, at: formatFieldPath(at.path), kind: at.kind });
      return { kind: 'keep' };
    },
  };
}

/** Rewrites every value it sees, and leaves keys alone. */
function replacingPolicy(replacement: string): SanitizationPolicy {
  return {
    name: 'replacing',
    inspect: (_text, at) =>
      at.kind === 'value' ? { kind: 'replace', value: replacement } : { kind: 'keep' },
  };
}

/** Refuses any string equal to `secret`, key or value. */
function refusingPolicy(secret: string): SanitizationPolicy {
  return {
    name: 'refusing',
    inspect: (text) => (text === secret ? { kind: 'reject' } : { kind: 'keep' }),
  };
}

const AT_ROOT: FieldPath = [
  { kind: 'operation', name: 'operation' },
  { kind: 'argument', index: 0 },
];

const values = (policy: { seen: Sighting[] }): Sighting[] =>
  policy.seen.filter((sighting) => sighting.kind === 'value');
const keys = (policy: { seen: Sighting[] }): Sighting[] =>
  policy.seen.filter((sighting) => sighting.kind === 'key');

describe('every string is shown to the policy', () => {
  it('finds a value at the top level', () => {
    const policy = recordingPolicy();

    sanitizeValue({ title: 'Sign-in fails' }, policy, AT_ROOT);

    expect(values(policy)).toEqual([
      { text: 'Sign-in fails', at: 'operation[0].title', kind: 'value' },
    ]);
  });

  it('finds the key naming it', () => {
    const policy = recordingPolicy();

    sanitizeValue({ title: 'Sign-in fails' }, policy, AT_ROOT);

    // A key is caller-written text on its way into storage, exactly like a
    // value. It is reported against its parent, because it is not part of the
    // path until the policy has approved it.
    expect(keys(policy)).toEqual([{ text: 'title', at: 'operation[0]', kind: 'key' }]);
  });

  it('finds keys and values inside a caller-composed snapshot', () => {
    const policy = recordingPolicy();

    // The shape here is whatever the caller sent. Nothing named it, and
    // nothing could have.
    sanitizeValue(
      { snapshot: { runtime: 'node 22.12.0', auth: { provider: 'oauth2' } } },
      policy,
      AT_ROOT,
    );

    expect(keys(policy).map((sighting) => `${sighting.at} :: ${sighting.text}`)).toEqual([
      'operation[0] :: snapshot',
      'operation[0].snapshot :: runtime',
      'operation[0].snapshot :: auth',
      'operation[0].snapshot.auth :: provider',
    ]);
    expect(values(policy).map((sighting) => sighting.at)).toEqual([
      'operation[0].snapshot.runtime',
      'operation[0].snapshot.auth.provider',
    ]);
  });

  it('inspects a key before descending into what it names', () => {
    const policy = recordingPolicy();

    sanitizeValue({ outer: { inner: 'value' } }, policy, AT_ROOT);

    // The ordering is what makes a locator safe: by the time any path
    // contains a key, the policy has already approved that key.
    expect(policy.seen.map((sighting) => `${sighting.kind}:${sighting.text}`)).toEqual([
      'key:outer',
      'key:inner',
      'value:value',
    ]);
  });

  it('finds a value inside an array, and says which position', () => {
    const policy = recordingPolicy();

    sanitizeValue({ tags: ['auth', ['nested', 'deeper']] }, policy, AT_ROOT);

    expect(values(policy).map((sighting) => sighting.at)).toEqual([
      'operation[0].tags[0]',
      'operation[0].tags[1][0]',
      'operation[0].tags[1][1]',
    ]);
  });

  it('finds a value at any depth', () => {
    const policy = recordingPolicy();

    sanitizeValue({ a: { b: { c: { d: { e: { f: 'buried' } } } } } }, policy, AT_ROOT);

    expect(values(policy)).toEqual([
      { text: 'buried', at: 'operation[0].a.b.c.d.e.f', kind: 'value' },
    ]);
  });

  it('finds a bare string passed as a whole argument', () => {
    const policy = recordingPolicy();

    sanitizeValue('an-identifier', policy, AT_ROOT);

    expect(policy.seen).toEqual([{ text: 'an-identifier', at: 'operation[0]', kind: 'value' }]);
  });

  it.each([
    ['a number', 42],
    ['a boolean', true],
    ['null', null],
    ['undefined', undefined],
    ['a date', new Date('2026-01-01T00:00:00.000Z')],
  ])('does not ask about %s as a value', (_label, value) => {
    const policy = recordingPolicy();

    sanitizeValue({ field: value }, policy, AT_ROOT);

    // The key is still inspected; only the value has nothing to inspect.
    expect(values(policy)).toEqual([]);
    expect(keys(policy).map((sighting) => sighting.text)).toEqual(['field']);
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

describe('a refused value', () => {
  const secret = 'sk-live-do-not-store';

  it('stops the whole write, not just the field', () => {
    expect(() =>
      sanitizeValue({ summary: 'fine', reason: secret }, refusingPolicy(secret), AT_ROOT),
    ).toThrow(SanitizationRejectedError);
  });

  it('is found inside nested input', () => {
    expect(() =>
      sanitizeValue({ snapshot: { env: { API_KEY: secret } } }, refusingPolicy(secret), AT_ROOT),
    ).toThrow(SanitizationRejectedError);
  });

  it('is located by its approved path, and never quoted', () => {
    try {
      sanitizeValue({ snapshot: { api_key: secret } }, refusingPolicy(secret), AT_ROOT);
      expect.unreachable('the policy should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(SanitizationRejectedError);
      const rejected = error as SanitizationRejectedError;

      // Every key in the locator was shown to the policy and kept, so naming
      // them reveals nothing the policy would have refused.
      expect(rejected.locator).toBe('operation[0].snapshot.api_key');
      expect(rejected.kind).toBe('value');
      expect(rejected.policy).toBe('refusing');
      expectNoTraceOf(rejected, secret);
    }
  });
});

describe('a refused key', () => {
  const secret = 'sk-live-in-the-key-name';

  it('is refused rather than stored', () => {
    // The bypass this closes: a caller putting the secret in the key instead
    // of the value, which an Environment snapshot happily accepts.
    expect(() =>
      sanitizeValue({ snapshot: { [secret]: 'anything' } }, refusingPolicy(secret), AT_ROOT),
    ).toThrow(SanitizationRejectedError);
  });

  it('is refused at any depth, and in a change log map', () => {
    for (const input of [
      { snapshot: { [secret]: 'v' } },
      { snapshot: { deployment: { env: { [secret]: 'v' } } } },
      { changes: { [secret]: { kind: 'exact', before: null, after: 'x' } } },
      { [secret]: 'top level' },
    ]) {
      expect(() => sanitizeValue(input, refusingPolicy(secret), AT_ROOT)).toThrow(
        SanitizationRejectedError,
      );
    }
  });

  it('never appears in the error that refused it', () => {
    try {
      sanitizeValue({ snapshot: { [secret]: 'anything' } }, refusingPolicy(secret), AT_ROOT);
      expect.unreachable('the policy should have refused');
    } catch (error) {
      const rejected = error as SanitizationRejectedError;

      // The refused key is exactly the string that must not escape, and it is
      // also what a locator built from raw keys would have been made of. It is
      // reported as a redacted step against its parent instead.
      expect(rejected.locator).toBe('operation[0].snapshot.<redacted>');
      expect(rejected.kind).toBe('key');
      expectNoTraceOf(rejected, secret);
    }
  });

  it('stops the write before the value it names is even looked at', () => {
    const seen: string[] = [];
    const policy: SanitizationPolicy = {
      name: 'refusing',
      inspect: (text) => {
        seen.push(text);
        return text === secret ? { kind: 'reject' } : { kind: 'keep' };
      },
    };

    expect(() =>
      sanitizeValue({ snapshot: { [secret]: 'the value under it' } }, policy, AT_ROOT),
    ).toThrow(SanitizationRejectedError);
    expect(seen).not.toContain('the value under it');
  });
});

describe('what a policy is not allowed to ask for', () => {
  it('cannot rename a key', () => {
    const renaming: SanitizationPolicy = {
      name: 'renaming',
      inspect: (_text, at) =>
        at.kind === 'key' ? { kind: 'replace', value: 'renamed' } : { kind: 'keep' },
    };

    // Replacing a key can collide with one already present and silently merge
    // two fields. What should happen then belongs with P3-03's redaction
    // rules, so the boundary refuses loudly rather than inventing an answer.
    expect(() => sanitizeValue({ original: 'v' }, renaming, AT_ROOT)).toThrow(
      UnsupportedSanitizationOutcomeError,
    );
  });

  it('does not name the key it declined to rename', () => {
    const secret = 'sk-live-key-name';
    const renaming: SanitizationPolicy = {
      name: 'renaming',
      inspect: (_text, at) =>
        at.kind === 'key' ? { kind: 'replace', value: 'renamed' } : { kind: 'keep' },
    };

    try {
      sanitizeValue({ [secret]: 'v' }, renaming, AT_ROOT);
      expect.unreachable('renaming a key is not supported');
    } catch (error) {
      expectNoTraceOf(error as Error, secret);
    }
  });

  it('has no field to attach prose to', () => {
    const inspect = (text: string): SanitizationOutcome =>
      // @ts-expect-error A reject outcome has no field for a reason. This
      // directive fails if one is ever added, which is the point: the shape
      // that would let a policy hand back the value it just refused should
      // not be expressible.
      ({ kind: 'reject', reason: text });

    expect(inspect('anything')).toMatchObject({ kind: 'reject' });
  });

  it('has nothing read from it beyond the outcome, even when prose is forced in', () => {
    const secret = 'sk-live-smuggled-in-the-reason';
    // The structural guarantee, and the one that does not depend on how a
    // policy author happened to write their function: TypeScript only refuses
    // the annotated form above, but the boundary reads `kind` and `value` and
    // nothing else, so anything else a policy returns goes nowhere at all.
    const dangerous = {
      name: 'dangerous',
      inspect: (text: string) =>
        text === secret ? { kind: 'reject', reason: text, detail: text } : { kind: 'keep' },
    } as unknown as SanitizationPolicy;

    try {
      sanitizeValue({ summary: secret }, dangerous, AT_ROOT);
      expect.unreachable('the policy should have refused');
    } catch (error) {
      expectNoTraceOf(error as Error, secret);
    }
  });

  it('ignores prose forced into a refused key as well', () => {
    const secret = 'sk-live-key-with-smuggled-reason';
    const dangerous = {
      name: 'dangerous',
      inspect: (text: string) =>
        text === secret ? { kind: 'reject', reason: text } : { kind: 'keep' },
    } as unknown as SanitizationPolicy;

    try {
      sanitizeValue({ snapshot: { [secret]: 'v' } }, dangerous, AT_ROOT);
      expect.unreachable('the policy should have refused');
    } catch (error) {
      expectNoTraceOf(error as Error, secret);
    }
  });

  it('refuses a value that refers to itself', () => {
    const cyclic: Record<string, unknown> = { title: 'a problem' };
    cyclic.self = cyclic;

    // Nothing cyclic can be stored, so refusing is both honest and what stops
    // the traversal recursing forever.
    expect(() => sanitizeValue(cyclic, permissive, AT_ROOT)).toThrow(
      UnsupportedSanitizationOutcomeError,
    );
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
    for (const text of [
      'sk-live-51H8fakeexamplekeyvalue',
      'password=hunter2',
      '-----BEGIN PRIVATE KEY-----',
      'ordinary prose about a redirect',
      '',
    ]) {
      for (const kind of ['value', 'key'] as const) {
        expect(permissive.inspect(text, { path: AT_ROOT, kind })).toEqual({ kind: 'keep' });
      }
    }
  });

  it('says what it is', () => {
    expect(permissive.name).toContain('p3-01');
  });
});

/**
 * Asserts a secret is nowhere an error could carry it.
 *
 * An error travels: into a log line, into a serialised report, through several
 * layers on its way out. Checking only the message would miss the properties
 * an object spread or a JSON dump would pick up.
 */
function expectNoTraceOf(error: Error, secret: string): void {
  expect(error.message).not.toContain(secret);
  expect(JSON.stringify(error)).not.toContain(secret);
  expect(JSON.stringify({ ...error })).not.toContain(secret);
  expect(Object.values(error).join(' ')).not.toContain(secret);
  expect(error.stack ?? '').not.toContain(secret);
}
