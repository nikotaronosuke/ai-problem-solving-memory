/**
 * What the two write methods send, and what they refuse to send.
 *
 * A read that gets something wrong can be repeated. A write cannot: what goes
 * out is stored, and an Environment in particular is never updated or deleted.
 * So the interesting assertions here are the ones about what never leaves —
 * a snapshot value JSON would have quietly rewritten, a field the caller
 * attached that the contract does not have, an `undefined` standing where a
 * deliberate `null` was meant.
 *
 * The rest is the discipline every method here shares: one call is one request,
 * nothing is retried, and an answer that does not match what was asked for is a
 * protocol failure rather than a result.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createMemoryApiClient,
  MemoryApiArgumentError,
  MemoryApiError,
  MemoryApiProtocolError,
  MemoryApiUnreachableError,
  MEMORY_API_REQUEST_TIMEOUT_MS,
  type FetchLike,
} from '../src/index.js';

/** A synthetic value in the shape of a credential. Not one. */
const CREDENTIAL = 'memory_test_0000000000000000000000000000';

const PROJECT_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_PROJECT_ID = '77777777-6666-4555-8444-333333333333';
const ENVIRONMENT_ID = 'bbbbbbbb-1111-4222-8333-444444444444';
const OTHER_ENVIRONMENT_ID = 'dddddddd-1111-4222-8333-444444444444';

const ENVIRONMENT = {
  environment_id: ENVIRONMENT_ID,
  owner_id: '99999999-8888-4777-8666-555555555555',
  project_id: PROJECT_ID,
  snapshot: { branch: 'main', commit: '0f1e2d3c' },
  created_at: '2026-01-01T00:00:00.000Z',
};

const PROBLEM = {
  problem_id: 'aaaaaaaa-1111-4222-8333-444444444444',
  owner_id: '99999999-8888-4777-8666-555555555555',
  project_id: PROJECT_ID,
  environment_id: ENVIRONMENT_ID,
  title: 'the build fails only on the second run',
  symptoms: 'a cached artifact is reused after it should have been invalidated',
  problem_domain: null,
  suspected_boundary: null,
  source_ai: 'claude-code',
  status: 'INVESTIGATING',
  fix_kind: null,
  importance: false,
  confidence: 'LOW',
  freshness: 'CURRENT',
  memory_read_enabled: true,
  memory_write_enabled: true,
  suppressed: false,
  version: 1,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const VALID_PROBLEM_REQUEST = {
  environment_id: ENVIRONMENT_ID,
  title: 'the build fails only on the second run',
  symptoms: 'a cached artifact is reused',
};

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function urlOf(input: Parameters<FetchLike>[0]): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function recordingFetch(answer: () => Response): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = (input, init) => {
    calls.push({ url: urlOf(input), init });
    return Promise.resolve(answer());
  };
  return { fetch, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function errorEnvelope(code: string): unknown {
  return { error: { code, message: 'a fixed sentence' }, request_id: 'req-0000000000000000' };
}

function answering(status: number, body: unknown) {
  const { fetch, calls } = recordingFetch(() => jsonResponse(status, body));
  return { calls, memory: createMemoryApiClient({ credential: CREDENTIAL, fetch }) };
}

/** The same object without one field, for the malformed-answer cases. */
function omit<T extends object>(value: T, field: keyof T & string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
}

function bodyOf(call: Call | undefined): Record<string, unknown> {
  const body = call?.init?.body;
  return JSON.parse(typeof body === 'string' ? body : '{}') as Record<string, unknown>;
}

describe('recording an Environment', () => {
  it('posts to the project’s collection with the credential in one place', async () => {
    const { calls, memory } = answering(201, ENVIRONMENT);

    await memory.createEnvironment(PROJECT_ID, { snapshot: { branch: 'main' } });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`http://127.0.0.1:3000/v1/projects/${PROJECT_ID}/environments`);
    expect(calls[0]?.init?.method).toBe('POST');
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe(`Bearer ${CREDENTIAL}`);
    expect(headers['content-type']).toBe('application/json');
    expect(bodyOf(calls[0])).toEqual({ snapshot: { branch: 'main' } });
  });

  it('refuses a project id that is not one, before spending a request', async () => {
    const { calls, memory } = answering(201, ENVIRONMENT);

    for (const bad of ['', 'not-a-uuid', '../projects']) {
      await expect(memory.createEnvironment(bad, { snapshot: {} })).rejects.toBeInstanceOf(
        MemoryApiArgumentError,
      );
    }
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['an empty snapshot', {}],
    ['nested objects', { git: { branch: 'main', tags: { latest: 'v1' } } }],
    ['nested arrays', { versions: ['1', '2', { patch: 3 }] }],
    ['nulls', { branch: null }],
    ['finite numbers', { attempts: 3, ratio: -0.5 }],
    ['booleans', { dirty: false }],
  ])('accepts a snapshot carrying %s', async (_name, snapshot) => {
    const { calls, memory } = answering(201, { ...ENVIRONMENT, snapshot });

    await memory.createEnvironment(PROJECT_ID, { snapshot });

    expect(bodyOf(calls[0])).toEqual({ snapshot });
  });

  it.each([
    ['undefined', { branch: undefined }],
    ['NaN', { attempts: Number.NaN }],
    ['Infinity', { ratio: Number.POSITIVE_INFINITY }],
    ['-Infinity', { ratio: Number.NEGATIVE_INFINITY }],
    ['a bigint', { size: 10n }],
    ['a function', { read: () => 'x' }],
    ['a symbol', { tag: Symbol('x') }],
    ['a Date', { at: new Date('2026-01-01T00:00:00.000Z') }],
    ['a Map', { entries: new Map() }],
    ['a class instance', { error: new Error('a fixed sentence') }],
    ['a nested undefined', { git: { branch: undefined } }],
    ['a nested NaN', { git: { attempts: [1, Number.NaN] } }],
  ])('refuses a snapshot carrying %s, before spending a request', async (_name, snapshot) => {
    // Each of these serialises into something other than what was written:
    // dropped, turned into null, turned into a string, or emptied. A stored
    // snapshot that says something the caller did not is worse than a refusal.
    const { calls, memory } = answering(201, ENVIRONMENT);

    await expect(
      memory.createEnvironment(PROJECT_ID, { snapshot: snapshot as never }),
    ).rejects.toBeInstanceOf(MemoryApiArgumentError);
    expect(calls).toHaveLength(0);
  });

  describe('own properties serialisation would not carry', () => {
    // Every case here passed validation before and then arrived at the server
    // missing something, or holding something the caller never wrote. The
    // validator said one structure and the wire recorded another, which is the
    // one thing this whole check exists to prevent.

    it('refuses a symbol-keyed property, which would vanish silently', async () => {
      const snapshot = { branch: 'main', [Symbol('hidden')]: 'value' };
      const { calls, memory } = answering(201, ENVIRONMENT);

      await expect(memory.createEnvironment(PROJECT_ID, { snapshot })).rejects.toBeInstanceOf(
        MemoryApiArgumentError,
      );
      expect(calls).toHaveLength(0);
    });

    it('refuses a symbol-keyed property nested deeper down', async () => {
      const snapshot = { git: { branch: 'main', [Symbol('hidden')]: 'value' } };
      const { calls, memory } = answering(201, ENVIRONMENT);

      await expect(memory.createEnvironment(PROJECT_ID, { snapshot })).rejects.toBeInstanceOf(
        MemoryApiArgumentError,
      );
      expect(calls).toHaveLength(0);
    });

    it.each([
      [
        'a hole at the start',
        () => {
          const a: unknown[] = new Array<unknown>(2);
          a[1] = 'x';
          return a;
        },
      ],
      [
        'a hole at the end',
        () => {
          const a: unknown[] = ['x'];
          a.length = 3;
          return a;
        },
      ],
      [
        'a hole in the middle',
        () => {
          const a: unknown[] = [];
          a[0] = 'x';
          a[2] = 'y';
          return a;
        },
      ],
    ])('refuses an array with %s, which would serialise as null', async (_name, build) => {
      const { calls, memory } = answering(201, ENVIRONMENT);

      await expect(
        memory.createEnvironment(PROJECT_ID, { snapshot: { versions: build() } as never }),
      ).rejects.toBeInstanceOf(MemoryApiArgumentError);
      expect(calls).toHaveLength(0);
    });

    it('refuses an enormous sparse array without walking it', async () => {
      // A billion holes, refused from the shape of its own key list rather
      // than by counting to a billion. If this ever starts iterating, it stops
      // being a test and starts being a hang.
      const huge = new Array(1_000_000_000);
      const { calls, memory } = answering(201, ENVIRONMENT);

      const started = Date.now();
      await expect(
        memory.createEnvironment(PROJECT_ID, { snapshot: { huge } }),
      ).rejects.toBeInstanceOf(MemoryApiArgumentError);

      expect(Date.now() - started).toBeLessThan(1_000);
      expect(calls).toHaveLength(0);
    });

    it('refuses an extra property hung off an array, which would vanish', async () => {
      const versions: unknown[] = ['a'];
      (versions as unknown as Record<string, string>)['extra'] = 'x';
      const { calls, memory } = answering(201, ENVIRONMENT);

      await expect(
        memory.createEnvironment(PROJECT_ID, { snapshot: { versions } as never }),
      ).rejects.toBeInstanceOf(MemoryApiArgumentError);
      expect(calls).toHaveLength(0);
    });

    it('refuses a non-enumerable property, which serialisation skips', async () => {
      const snapshot = { branch: 'main' };
      Object.defineProperty(snapshot, 'hidden', { value: 'x', enumerable: false });
      const { calls, memory } = answering(201, ENVIRONMENT);

      await expect(memory.createEnvironment(PROJECT_ID, { snapshot })).rejects.toBeInstanceOf(
        MemoryApiArgumentError,
      );
      expect(calls).toHaveLength(0);
    });

    it('refuses an accessor without ever running it', async () => {
      // Two things at once. An accessor is computed rather than stored, so it
      // is not the data it looks like — and a validator that answered by
      // *calling* it would be running arbitrary caller code to decide whether
      // that code's result is data, then sending a value computed a second
      // time and possibly differently.
      let invocations = 0;
      const snapshot = { branch: 'main' };
      Object.defineProperty(snapshot, 'computed', {
        enumerable: true,
        configurable: true,
        get() {
          invocations += 1;
          return 'x';
        },
      });
      const { calls, memory } = answering(201, ENVIRONMENT);

      await expect(memory.createEnvironment(PROJECT_ID, { snapshot })).rejects.toBeInstanceOf(
        MemoryApiArgumentError,
      );
      expect(invocations).toBe(0);
      expect(calls).toHaveLength(0);
    });

    it('refuses a getter that would have thrown, without letting it throw', async () => {
      const snapshot = { branch: 'main' };
      Object.defineProperty(snapshot, 'explodes', {
        enumerable: true,
        configurable: true,
        get() {
          throw new Error('a getter nobody should have called');
        },
      });
      const { calls, memory } = answering(201, ENVIRONMENT);

      // An argument error, not the getter's own error escaping through the
      // client — which is what would happen if this were validated by reading.
      await expect(memory.createEnvironment(PROJECT_ID, { snapshot })).rejects.toBeInstanceOf(
        MemoryApiArgumentError,
      );
      expect(calls).toHaveLength(0);
    });

    it('refuses an accessor sitting at an array index', async () => {
      let invocations = 0;
      const versions: unknown[] = ['a'];
      Object.defineProperty(versions, 1, {
        enumerable: true,
        configurable: true,
        get() {
          invocations += 1;
          return 'b';
        },
      });
      const { calls, memory } = answering(201, ENVIRONMENT);

      await expect(
        memory.createEnvironment(PROJECT_ID, { snapshot: { versions } as never }),
      ).rejects.toBeInstanceOf(MemoryApiArgumentError);
      expect(invocations).toBe(0);
      expect(calls).toHaveLength(0);
    });

    it('refuses an own toJSON, which would replace the value entirely', async () => {
      const snapshot = {
        branch: 'main',
        toJSON() {
          return 'something else';
        },
      };
      const { calls, memory } = answering(201, ENVIRONMENT);

      await expect(
        memory.createEnvironment(PROJECT_ID, { snapshot: snapshot as never }),
      ).rejects.toBeInstanceOf(MemoryApiArgumentError);
      expect(calls).toHaveLength(0);
    });
  });

  describe('ordinary structures still travel', () => {
    // The other half of tightening a check: it has to keep accepting the
    // things it was always meant to carry.

    it.each([
      ['a dense array', { versions: ['1', '2', '3'] }],
      ['nested arrays and objects', { git: { tags: [{ name: 'v1' }, { name: 'v2' }] } }],
      ['an empty array', { versions: [] }],
      ['an empty nested object', { git: {} }],
      ['every scalar JSON has', { s: 'x', n: -1.5, b: false, nil: null }],
      ['an array of scalars including null', { mixed: ['a', 1, true, null] }],
    ])('accepts %s', async (_name, snapshot) => {
      const { calls, memory } = answering(201, { ...ENVIRONMENT, snapshot });

      await memory.createEnvironment(PROJECT_ID, { snapshot });

      expect(bodyOf(calls[0])).toEqual({ snapshot });
    });

    it('accepts a record with no prototype at all', async () => {
      // `Object.create(null)` is a plain data bag and serialises as one; the
      // prototype check is about `Date` and class instances, not about this.
      const bare = Object.create(null) as Record<string, string>;
      bare['branch'] = 'main';
      const { calls, memory } = answering(201, ENVIRONMENT);

      await memory.createEnvironment(PROJECT_ID, { snapshot: bare });

      expect(bodyOf(calls[0])).toEqual({ snapshot: { branch: 'main' } });
    });

    it('accepts an array of the length it claims', async () => {
      const versions = new Array(3).fill('x') as string[];
      const { calls, memory } = answering(201, ENVIRONMENT);

      await memory.createEnvironment(PROJECT_ID, { snapshot: { versions } });

      expect(bodyOf(calls[0])).toEqual({ snapshot: { versions: ['x', 'x', 'x'] } });
    });
  });

  it('refuses a snapshot that points back at itself', async () => {
    const cyclic: Record<string, unknown> = { git: {} };
    (cyclic['git'] as Record<string, unknown>)['self'] = cyclic;
    const { calls, memory } = answering(201, ENVIRONMENT);

    await expect(
      memory.createEnvironment(PROJECT_ID, { snapshot: cyclic as never }),
    ).rejects.toBeInstanceOf(MemoryApiArgumentError);
    expect(calls).toHaveLength(0);
  });

  it('accepts the same value referenced twice, which is not a cycle', async () => {
    const shared = { version: '1' };
    const { calls, memory } = answering(201, ENVIRONMENT);

    await memory.createEnvironment(PROJECT_ID, { snapshot: { a: shared, b: shared } });

    expect(bodyOf(calls[0])).toEqual({ snapshot: { a: shared, b: shared } });
  });

  it.each([
    ['a snapshot that is not an object', { snapshot: 'main' }],
    ['a snapshot that is an array', { snapshot: [] }],
    ['a snapshot that is null', { snapshot: null }],
    ['no snapshot at all', {}],
    ['a field beside the snapshot', { snapshot: {}, label: 'x' }],
  ])('refuses %s', async (_name, request) => {
    const { calls, memory } = answering(201, ENVIRONMENT);

    await expect(memory.createEnvironment(PROJECT_ID, request as never)).rejects.toBeInstanceOf(
      MemoryApiArgumentError,
    );
    expect(calls).toHaveLength(0);
  });

  it('names the argument and never the snapshot it refused', async () => {
    const planted = 'a-snapshot-value-nobody-should-log';
    const { memory } = answering(201, ENVIRONMENT);

    const raised = await memory
      .createEnvironment(PROJECT_ID, { snapshot: { note: planted, bad: undefined } as never })
      .catch((error: unknown) => error);

    expect((raised as MemoryApiArgumentError).argument).toBe('environment snapshot');
    expect((raised as Error).message.includes(planted)).toBe(false);
    expect(JSON.stringify(raised).includes(planted)).toBe(false);
  });

  it('returns the Environment exactly as it arrived', async () => {
    const { memory } = answering(201, ENVIRONMENT);

    await expect(memory.createEnvironment(PROJECT_ID, { snapshot: {} })).resolves.toEqual(
      ENVIRONMENT,
    );
  });

  it.each([
    ['a missing field', omit(ENVIRONMENT, 'created_at')],
    ['an extra field', { ...ENVIRONMENT, recorded_by: 'someone' }],
    ['a snapshot that is not an object', { ...ENVIRONMENT, snapshot: 'main' }],
    ['a snapshot that is an array', { ...ENVIRONMENT, snapshot: [] }],
    ['an id that is not a string', { ...ENVIRONMENT, environment_id: 7 }],
  ])('refuses an answer carrying %s', async (_name, body) => {
    const { memory } = answering(201, body);

    await expect(memory.createEnvironment(PROJECT_ID, { snapshot: {} })).rejects.toBeInstanceOf(
      MemoryApiProtocolError,
    );
  });

  it('refuses an answer whose snapshot is not JSON this contract can carry', async () => {
    // "It was parsed from JSON, so it is JSON" is nearly true. `JSON.parse`
    // reads `1e999` as `Infinity` — a number JavaScript has and JSON does not —
    // so a proxy, a rewriting intermediary or a server this contract does not
    // describe can hand back a snapshot that cannot be serialised back into
    // the thing it arrived as.
    //
    // The fixture is a raw body on purpose: `JSON.stringify` would turn the
    // value into `null` on the way in and the test would prove nothing.
    const raw = `{"environment_id":"${ENVIRONMENT_ID}","owner_id":"${ENVIRONMENT.owner_id}","project_id":"${PROJECT_ID}","snapshot":{"attempts":1e999},"created_at":"2026-01-01T00:00:00.000Z"}`;
    expect(
      Number.isFinite((JSON.parse(raw) as { snapshot: { attempts: number } }).snapshot.attempts),
    ).toBe(false);

    const fetch: FetchLike = () =>
      Promise.resolve(
        new Response(raw, { status: 201, headers: { 'content-type': 'application/json' } }),
      );
    const memory = createMemoryApiClient({ credential: CREDENTIAL, fetch });

    await expect(memory.createEnvironment(PROJECT_ID, { snapshot: {} })).rejects.toBeInstanceOf(
      MemoryApiProtocolError,
    );
  });

  it('accepts an ordinary snapshot coming back', async () => {
    // The other half: tightening the inbound check must not start refusing the
    // answers a real server gives.
    const snapshot = { branch: 'main', versions: ['1', '2'], nested: { dirty: false, n: null } };
    const { memory } = answering(201, { ...ENVIRONMENT, snapshot });

    await expect(memory.createEnvironment(PROJECT_ID, { snapshot: {} })).resolves.toMatchObject({
      snapshot,
    });
  });

  it('refuses an Environment recorded against another project', async () => {
    const { memory } = answering(201, { ...ENVIRONMENT, project_id: OTHER_PROJECT_ID });

    await expect(memory.createEnvironment(PROJECT_ID, { snapshot: {} })).rejects.toBeInstanceOf(
      MemoryApiProtocolError,
    );
  });

  it.each([
    [400, 'INVALID_REQUEST'],
    [404, 'NOT_FOUND'],
    [500, 'INTERNAL_ERROR'],
  ])('raises on %d', async (status, code) => {
    const { memory } = answering(status, errorEnvelope(code));

    await expect(memory.createEnvironment(PROJECT_ID, { snapshot: {} })).rejects.toBeInstanceOf(
      MemoryApiError,
    );
  });

  it('raises when nothing answered, and does not try again', async () => {
    let attempts = 0;
    const fetch: FetchLike = () => {
      attempts += 1;
      return Promise.reject(new Error('connect ECONNREFUSED'));
    };
    const memory = createMemoryApiClient({ credential: CREDENTIAL, fetch });

    await expect(memory.createEnvironment(PROJECT_ID, { snapshot: {} })).rejects.toBeInstanceOf(
      MemoryApiUnreachableError,
    );
    // The whole point of a write with no retry: one call is one request, so a
    // caller that does not know whether it committed at least knows how many
    // times it was attempted.
    expect(attempts).toBe(1);
  });

  it('uses the ordinary deadline, and honours an explicit one', async () => {
    const seen: number[] = [];
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      seen.push(ms);
      return timeout(ms);
    });

    const { memory } = answering(201, ENVIRONMENT);
    await memory.createEnvironment(PROJECT_ID, { snapshot: {} });
    expect(seen).toEqual([MEMORY_API_REQUEST_TIMEOUT_MS]);

    const { fetch } = recordingFetch(() => jsonResponse(201, ENVIRONMENT));
    const capped = createMemoryApiClient({ credential: CREDENTIAL, fetch, timeoutMs: 1234 });
    await capped.createEnvironment(PROJECT_ID, { snapshot: {} });
    expect(seen).toEqual([MEMORY_API_REQUEST_TIMEOUT_MS, 1234]);

    spy.mockRestore();
  });
});

describe('starting a Problem', () => {
  it('posts to the project’s collection with the required fields', async () => {
    const { calls, memory } = answering(201, PROBLEM);

    await memory.createProblem(PROJECT_ID, VALID_PROBLEM_REQUEST);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`http://127.0.0.1:3000/v1/projects/${PROJECT_ID}/problems`);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(bodyOf(calls[0])).toEqual(VALID_PROBLEM_REQUEST);
  });

  it('sends every field when they are all given', async () => {
    const { calls, memory } = answering(201, PROBLEM);

    await memory.createProblem(PROJECT_ID, {
      ...VALID_PROBLEM_REQUEST,
      problem_domain: 'build',
      suspected_boundary: 'cache',
      source_ai: 'claude-code',
    });

    expect(bodyOf(calls[0])).toEqual({
      ...VALID_PROBLEM_REQUEST,
      problem_domain: 'build',
      suspected_boundary: 'cache',
      source_ai: 'claude-code',
    });
  });

  it('keeps absent and null apart on the wire', async () => {
    // They mean different things to the server — leave it alone, and state
    // there is no answer — and this is the layer where they would collapse.
    const { calls, memory } = answering(201, PROBLEM);

    await memory.createProblem(PROJECT_ID, {
      ...VALID_PROBLEM_REQUEST,
      problem_domain: null,
    });

    const body = bodyOf(calls[0]);
    expect('problem_domain' in body).toBe(true);
    expect(body['problem_domain']).toBeNull();
    expect('suspected_boundary' in body).toBe(false);
    expect('source_ai' in body).toBe(false);
  });

  it('refuses a project id that is not one, before spending a request', async () => {
    const { calls, memory } = answering(201, PROBLEM);

    await expect(memory.createProblem('nope', VALID_PROBLEM_REQUEST)).rejects.toBeInstanceOf(
      MemoryApiArgumentError,
    );
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['an environment id that is not one', { ...VALID_PROBLEM_REQUEST, environment_id: 'nope' }],
    ['no environment id', { title: 't', symptoms: 's' }],
    ['a blank title', { ...VALID_PROBLEM_REQUEST, title: '' }],
    ['a whitespace-only title', { ...VALID_PROBLEM_REQUEST, title: '   \t\n ' }],
    ['a blank symptoms', { ...VALID_PROBLEM_REQUEST, symptoms: '' }],
    ['a whitespace-only symptoms', { ...VALID_PROBLEM_REQUEST, symptoms: ' \n ' }],
    ['a title that is not a string', { ...VALID_PROBLEM_REQUEST, title: 7 }],
    ['a status', { ...VALID_PROBLEM_REQUEST, status: 'VERIFIED' }],
    ['a fix kind', { ...VALID_PROBLEM_REQUEST, fix_kind: 'ROOT_FIX' }],
    ['a version', { ...VALID_PROBLEM_REQUEST, version: 3 }],
    ['an owner', { ...VALID_PROBLEM_REQUEST, owner_id: PROJECT_ID }],
    ['a misspelled field', { ...VALID_PROBLEM_REQUEST, problem_domian: 'build' }],
    ['a non-string optional', { ...VALID_PROBLEM_REQUEST, problem_domain: 7 }],
  ])('refuses a request carrying %s, before spending a request', async (_name, request) => {
    const { calls, memory } = answering(201, PROBLEM);

    await expect(memory.createProblem(PROJECT_ID, request as never)).rejects.toBeInstanceOf(
      MemoryApiArgumentError,
    );
    expect(calls).toHaveLength(0);
  });

  it('accepts an empty string where the server accepts one', async () => {
    // The server declares these nullable free-form text, and an empty string is
    // a legal value. A client stricter than its own contract is a client that
    // refuses requests the API would have taken.
    const { calls, memory } = answering(201, PROBLEM);

    await memory.createProblem(PROJECT_ID, { ...VALID_PROBLEM_REQUEST, problem_domain: '' });

    expect(bodyOf(calls[0])['problem_domain']).toBe('');
  });

  it('names one argument and never the words it refused', async () => {
    const planted = 'somebody-elses-private-symptoms';
    const { memory } = answering(201, PROBLEM);

    const raised = await memory
      .createProblem(PROJECT_ID, { ...VALID_PROBLEM_REQUEST, symptoms: planted, extra: 1 } as never)
      .catch((error: unknown) => error);

    expect((raised as MemoryApiArgumentError).argument).toBe('problem');
    expect((raised as Error).message.includes(planted)).toBe(false);
    expect(JSON.stringify(raised).includes(planted)).toBe(false);
  });

  it('returns the Problem exactly as it arrived', async () => {
    const { memory } = answering(201, PROBLEM);

    await expect(memory.createProblem(PROJECT_ID, VALID_PROBLEM_REQUEST)).resolves.toEqual(PROBLEM);
  });

  it.each([
    ['a missing field', omit(PROBLEM, 'version')],
    ['an extra field', { ...PROBLEM, escalated: true }],
    ['a status nobody here knows', { ...PROBLEM, status: 'ESCALATED' }],
  ])('refuses an answer carrying %s', async (_name, body) => {
    const { memory } = answering(201, body);

    await expect(memory.createProblem(PROJECT_ID, VALID_PROBLEM_REQUEST)).rejects.toBeInstanceOf(
      MemoryApiProtocolError,
    );
  });

  it('refuses a Problem started under another project', async () => {
    const { memory } = answering(201, { ...PROBLEM, project_id: OTHER_PROJECT_ID });

    await expect(memory.createProblem(PROJECT_ID, VALID_PROBLEM_REQUEST)).rejects.toBeInstanceOf(
      MemoryApiProtocolError,
    );
  });

  it('refuses a Problem attached to an Environment nobody asked for', async () => {
    // The conditions were captured a moment ago and this Problem points at
    // different ones. Whatever it describes, it is not what was requested.
    const { memory } = answering(201, { ...PROBLEM, environment_id: OTHER_ENVIRONMENT_ID });

    await expect(memory.createProblem(PROJECT_ID, VALID_PROBLEM_REQUEST)).rejects.toBeInstanceOf(
      MemoryApiProtocolError,
    );
  });

  it.each([
    [400, 'INVALID_REQUEST'],
    [404, 'NOT_FOUND'],
    [500, 'INTERNAL_ERROR'],
  ])('raises on %d', async (status, code) => {
    const { memory } = answering(status, errorEnvelope(code));

    await expect(memory.createProblem(PROJECT_ID, VALID_PROBLEM_REQUEST)).rejects.toBeInstanceOf(
      MemoryApiError,
    );
  });

  it('raises when nothing answered, and does not try again', async () => {
    let attempts = 0;
    const fetch: FetchLike = () => {
      attempts += 1;
      return Promise.reject(new Error('socket hang up'));
    };
    const memory = createMemoryApiClient({ credential: CREDENTIAL, fetch });

    await expect(memory.createProblem(PROJECT_ID, VALID_PROBLEM_REQUEST)).rejects.toBeInstanceOf(
      MemoryApiUnreachableError,
    );
    // A resend here could create a second Problem for the same trouble. The
    // caller is the one that can list and look.
    expect(attempts).toBe(1);
  });

  it('does not retry a server fault either', async () => {
    const { calls, memory } = answering(500, errorEnvelope('INTERNAL_ERROR'));

    await expect(memory.createProblem(PROJECT_ID, VALID_PROBLEM_REQUEST)).rejects.toBeInstanceOf(
      MemoryApiError,
    );
    expect(calls).toHaveLength(1);
  });

  it('uses the ordinary deadline', async () => {
    const seen: number[] = [];
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      seen.push(ms);
      return timeout(ms);
    });

    const { memory } = answering(201, PROBLEM);
    await memory.createProblem(PROJECT_ID, VALID_PROBLEM_REQUEST);

    expect(seen).toEqual([MEMORY_API_REQUEST_TIMEOUT_MS]);
    spy.mockRestore();
  });
});
