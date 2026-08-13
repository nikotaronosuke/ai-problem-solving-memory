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
  describeInspectionPath,
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
    seen,
    inspect(text: string, at: SanitizationSite) {
      seen.push({ text, at: describeInspectionPath(at.path), kind: at.kind });
      return { kind: 'keep' };
    },
  };
}

/** Rewrites every value it sees, and leaves keys alone. */
function replacingPolicy(replacement: string): SanitizationPolicy {
  return {
    inspect: (_text, at) =>
      at.kind === 'value' ? { kind: 'replace', value: replacement } : { kind: 'keep' },
  };
}

/** Refuses any string equal to `secret`, key or value. */
function refusingPolicy(secret: string): SanitizationPolicy {
  return {
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

      // The locator keeps the shape of the descent and none of the keys —
      // not even `snapshot` and `api_key`, which the policy kept. Keeping a
      // string is a statement about storing it, not about logging it.
      expect(rejected.locator).toBe('operation[0].<key>.<key>');
      expect(rejected.kind).toBe('value');
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
      expect(rejected.locator).toBe('operation[0].<key>.<redacted>');
      expect(rejected.kind).toBe('key');
      expectNoTraceOf(rejected, secret);
    }
  });

  it('stops the write before the value it names is even looked at', () => {
    const seen: string[] = [];
    const policy: SanitizationPolicy = {
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

describe('an ancestor key the policy kept', () => {
  // The distinction this suite exists for. A secret detector keeps an email
  // address, because an email address is not a secret — and that is a
  // statement about whether it may be stored, not about whether it may be
  // copied into a log file. The two questions have different answers and only
  // one of them is the policy's.
  const pii = 'customer@example.com';
  const secret = 'sk-live-under-a-kept-key';

  const secretDetector: SanitizationPolicy = {
    inspect: (text) => (text.includes('sk-live') ? { kind: 'reject' } : { kind: 'keep' }),
  };

  it('is shown to the policy in full, because detection needs the context', () => {
    const policy = recordingPolicy();

    sanitizeValue({ snapshot: { [pii]: { api_key: 'ok' } } }, policy, AT_ROOT);

    // The internal path keeps the raw keys: `snapshot.<something>.api_key` is
    // exactly what tells a detector how to read the value underneath.
    expect(policy.seen.some((sighting) => sighting.at.includes(pii))).toBe(true);
  });

  it('is not in the error raised for a secret beneath it', () => {
    try {
      sanitizeValue({ snapshot: { [pii]: { api_key: secret } } }, secretDetector, AT_ROOT);
      expect.unreachable('the policy should have refused the value');
    } catch (error) {
      const rejected = error as SanitizationRejectedError;

      expect(rejected.locator).toBe('operation[0].<key>.<key>.<key>');
      // Neither the secret that was refused, nor the caller text on the way
      // down to it that the policy was perfectly right to keep.
      expectNoTraceOf(rejected, secret);
      expectNoTraceOf(rejected, pii);
    }
  });

  it('is not in an error raised for a refused sibling key either', () => {
    try {
      sanitizeValue({ snapshot: { [pii]: { [secret]: 'v' } } }, secretDetector, AT_ROOT);
      expect.unreachable('the policy should have refused the key');
    } catch (error) {
      expectNoTraceOf(error as Error, pii);
      expectNoTraceOf(error as Error, secret);
    }
  });
});

describe('a policy cannot name itself into a log line', () => {
  const marker = 'sk-live-policy-name-secret';

  it('has nowhere to put a name', () => {
    const named = {
      // @ts-expect-error A policy has no name field. This directive fails if
      // one is ever added back, which is the point: free text fixed at
      // construction is still free text, and a configuration mistake can put
      // a credential in it.
      name: marker,
      inspect: () => ({ kind: 'reject' }),
    } satisfies SanitizationPolicy;

    expect(named.inspect()).toEqual({ kind: 'reject' });
  });

  it('leaves no trace of one forced in, on a refusal', () => {
    const named = {
      name: marker,
      inspect: () => ({ kind: 'reject' }),
    } as unknown as SanitizationPolicy;

    try {
      sanitizeValue({ title: 'anything' }, named, AT_ROOT);
      expect.unreachable('the policy should have refused');
    } catch (error) {
      expectNoTraceOf(error as Error, marker);
    }
  });

  it('leaves no trace of one on an unsupported outcome either', () => {
    // This one matters more, not less: it is not caught anywhere, so the
    // generic handler logs the whole error including its message and stack.
    const named = {
      name: marker,
      inspect: (_text: string, at: SanitizationSite) =>
        at.kind === 'key' ? { kind: 'replace', value: 'renamed' } : { kind: 'keep' },
    } as unknown as SanitizationPolicy;

    try {
      sanitizeValue({ title: 'anything' }, named, AT_ROOT);
      expect.unreachable('renaming a key is not supported');
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedSanitizationOutcomeError);
      expectNoTraceOf(error as Error, marker);
    }
  });

  it('leaves no trace of one on a cycle', () => {
    const named = {
      name: marker,
      inspect: () => ({ kind: 'keep' }),
    } as unknown as SanitizationPolicy;
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    try {
      sanitizeValue(cyclic, named, AT_ROOT);
      expect.unreachable('a cycle cannot be stored');
    } catch (error) {
      expectNoTraceOf(error as Error, marker);
    }
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

  it('has nothing on it but the one method', () => {
    // No name, and nothing else a configuration mistake could fill with a
    // credential that then reaches a log line.
    expect(Object.keys(permissive)).toEqual(['inspect']);
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
