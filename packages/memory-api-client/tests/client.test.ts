/**
 * What the client sends, what it accepts back, and what it refuses to say.
 *
 * Every test here drives the real `createMemoryApiClient` through an injected
 * transport. Nothing reaches a network, and nothing is asserted about an
 * internal function that production does not call — the point of the injection
 * is to see the request production would have sent, not to replace it.
 *
 * A recurring shape: several tests assert that the credential is **absent**
 * from something. Those are written as boolean checks rather than as equality
 * against an expected string, because a failing equality assertion prints both
 * sides, and one of the sides would be the credential.
 */

import { describe, expect, it } from 'vitest';

import {
  createMemoryApiClient,
  DEFAULT_MEMORY_API_BASE_URL,
  MemoryApiArgumentError,
  MemoryApiConfigurationError,
  MemoryApiError,
  MemoryApiProtocolError,
  MemoryApiUnreachableError,
  type FetchLike,
} from '../src/index.js';

/** A synthetic value in the shape of a credential. Not one. */
const CREDENTIAL = 'memory_test_0000000000000000000000000000';

const PROBLEM_ID = '11111111-2222-4333-8444-555555555555';

const PROBLEM = {
  problem_id: PROBLEM_ID,
  owner_id: '99999999-8888-4777-8666-555555555555',
  project_id: '12345678-1234-4234-8234-123456789012',
  environment_id: '87654321-4321-4321-8321-210987654321',
  title: 'Requests hang after the pool is exhausted',
  symptoms: 'Every request past the tenth waits forever.',
  problem_domain: 'connection-pooling',
  suspected_boundary: null,
  source_ai: 'claude-code',
  status: 'VERIFIED',
  fix_kind: 'ROOT_FIX',
  importance: true,
  confidence: 'HIGH',
  freshness: 'CURRENT',
  memory_read_enabled: true,
  memory_write_enabled: true,
  suppressed: false,
  version: 3,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
};

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/** Whatever the platform's `fetch` accepts as its first argument. */
type FetchInput = Parameters<FetchLike>[0];

/** The URL a request was aimed at, whichever form `fetch` was handed. */
function urlOf(input: FetchInput): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

/** Records every request and answers with what the test says. */
function recordingFetch(answer: () => Promise<Response> | Response): {
  fetch: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ url: urlOf(input), init });
    return answer();
  };
  return { fetch, calls };
}

/** A JSON response, built the way a server would. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function client(overrides: { baseUrl?: string; fetch?: FetchLike } = {}) {
  return createMemoryApiClient({ credential: CREDENTIAL, ...overrides });
}

/** Everything a request carried, as one string to search for a secret in. */
function requestFootprint(call: Call): string {
  return JSON.stringify({ url: call.url, init: call.init });
}

describe('base URL', () => {
  it('defaults to loopback', async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, PROBLEM));

    await client({ fetch }).getProblem(PROBLEM_ID);

    expect(calls[0]?.url).toBe(`${DEFAULT_MEMORY_API_BASE_URL}/v1/problems/${PROBLEM_ID}`);
    expect(DEFAULT_MEMORY_API_BASE_URL).toBe('http://127.0.0.1:3000');
  });

  it('uses an explicit base URL', async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, PROBLEM));

    await client({ fetch, baseUrl: 'https://memory.example:8443' }).getProblem(PROBLEM_ID);

    expect(calls[0]?.url).toBe(`https://memory.example:8443/v1/problems/${PROBLEM_ID}`);
  });

  it('normalises a trailing slash rather than doubling it', async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, PROBLEM));

    await client({ fetch, baseUrl: 'http://127.0.0.1:3000///' }).getProblem(PROBLEM_ID);

    expect(calls[0]?.url).toBe(`http://127.0.0.1:3000/v1/problems/${PROBLEM_ID}`);
  });

  it('keeps a path prefix, without a trailing slash', async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, PROBLEM));

    await client({ fetch, baseUrl: 'https://host/memory/' }).getProblem(PROBLEM_ID);

    expect(calls[0]?.url).toBe(`https://host/memory/v1/problems/${PROBLEM_ID}`);
  });

  it('refuses an unusable base URL before any request exists', () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, PROBLEM));

    for (const [value, failure] of [
      ['not a url', 'BASE_URL_UNPARSEABLE'],
      ['/v1/problems', 'BASE_URL_UNPARSEABLE'],
      ['ftp://host', 'BASE_URL_SCHEME_UNSUPPORTED'],
      ['file:///etc', 'BASE_URL_SCHEME_UNSUPPORTED'],
      ['http://host/?token=x', 'BASE_URL_HAS_QUERY'],
      ['http://host/#frag', 'BASE_URL_HAS_FRAGMENT'],
    ] as const) {
      expect(() => client({ fetch, baseUrl: value })).toThrowError(MemoryApiConfigurationError);
      try {
        client({ fetch, baseUrl: value });
      } catch (error) {
        expect((error as MemoryApiConfigurationError).failure).toBe(failure);
      }
    }

    expect(calls).toHaveLength(0);
  });

  it('refuses a base URL that carries credentials of its own', () => {
    // Refused rather than stripped: the caller asked to authenticate a way
    // this client does not, and sending the request anyway would honour half
    // of an instruction.
    for (const value of [
      'http://user:secret@host:3000',
      'http://user@host:3000',
      'http://:secret@host:3000',
    ]) {
      try {
        createMemoryApiClient({ credential: CREDENTIAL, baseUrl: value });
        expect.unreachable('a base URL with credentials must be refused');
      } catch (error) {
        expect(error).toBeInstanceOf(MemoryApiConfigurationError);
        expect((error as MemoryApiConfigurationError).failure).toBe('BASE_URL_HAS_CREDENTIALS');
        // The rejected value is not in the message. Checked as a boolean so a
        // failure does not print the URL it was complaining about.
        expect((error as Error).message.includes('secret')).toBe(false);
      }
    }
  });
});

describe('credential', () => {
  it('is required, and blank is not a credential', () => {
    for (const value of ['', '   ', '\t\n']) {
      try {
        createMemoryApiClient({ credential: value });
        expect.unreachable('a blank credential must be refused');
      } catch (error) {
        expect(error).toBeInstanceOf(MemoryApiConfigurationError);
        expect((error as MemoryApiConfigurationError).failure).toBe('CREDENTIAL_BLANK');
      }
    }
  });

  it('is presented as a bearer token and nowhere else', async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, PROBLEM));

    await client({ fetch }).getProblem(PROBLEM_ID);

    const call = calls[0];
    const headers = new Headers(call?.init?.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${CREDENTIAL}`);

    // Present in the header, absent from everything else that travels. There
    // is no body at all on this request, which is the strongest form of "the
    // credential is not in the body".
    expect(call?.url.includes(CREDENTIAL)).toBe(false);
    expect(call?.init?.body ?? null).toBe(null);
  });

  it('is not readable back off the client', () => {
    const built = client();

    // A client is something you use, not somewhere a secret is stored for
    // later reading. Serialised whole so an accessor added anywhere fails.
    expect(JSON.stringify(built).includes(CREDENTIAL)).toBe(false);
    expect(Object.keys(built)).toEqual(['getProblem']);
  });
});

describe('getProblem', () => {
  it('reads one Problem with a GET', async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, PROBLEM));

    await client({ fetch }).getProblem(PROBLEM_ID);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.url).toBe(`${DEFAULT_MEMORY_API_BASE_URL}/v1/problems/${PROBLEM_ID}`);
  });

  it('refuses an id that could not be part of a path, without asking', async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, PROBLEM));
    const built = client({ fetch });

    for (const id of [
      '',
      'not-a-uuid',
      '../../v1/export',
      `${PROBLEM_ID}/events`,
      `${PROBLEM_ID} `,
      '11111111-2222-4333-8444-5555555555',
    ]) {
      await expect(built.getProblem(id)).rejects.toBeInstanceOf(MemoryApiArgumentError);
    }

    // The point of refusing early: no request was spent on any of them.
    expect(calls).toHaveLength(0);
  });

  it('returns what the server said, unchanged', async () => {
    const { fetch } = recordingFetch(() => jsonResponse(200, PROBLEM));

    const problem = await client({ fetch }).getProblem(PROBLEM_ID);

    // Field for field, including the ones a domain model would have renamed
    // or parsed. This client is not a second domain layer.
    expect(problem).toEqual(PROBLEM);
    expect(typeof problem.created_at).toBe('string');
  });

  it('preserves nulls rather than dropping them', async () => {
    const nulled = {
      ...PROBLEM,
      problem_domain: null,
      suspected_boundary: null,
      source_ai: null,
      fix_kind: null,
    };
    const { fetch } = recordingFetch(() => jsonResponse(200, nulled));

    const problem = await client({ fetch }).getProblem(PROBLEM_ID);

    expect(problem.problem_domain).toBeNull();
    expect(problem.fix_kind).toBeNull();
    expect(problem.source_ai).toBeNull();
    expect('problem_domain' in problem).toBe(true);
  });

  it('accepts every value the closed sets name', async () => {
    for (const status of [
      'INVESTIGATING',
      'FIX_CANDIDATE',
      'VERIFIED',
      'PAUSED',
      'CLOSED_UNRESOLVED',
    ]) {
      const { fetch } = recordingFetch(() => jsonResponse(200, { ...PROBLEM, status }));
      expect((await client({ fetch }).getProblem(PROBLEM_ID)).status).toBe(status);
    }

    for (const confidence of ['HIGH', 'MEDIUM', 'LOW', 'CONFLICTED']) {
      const { fetch } = recordingFetch(() => jsonResponse(200, { ...PROBLEM, confidence }));
      expect((await client({ fetch }).getProblem(PROBLEM_ID)).confidence).toBe(confidence);
    }

    for (const freshness of ['CURRENT', 'STALE_UNKNOWN', 'SUPERSEDED', 'INVALID']) {
      const { fetch } = recordingFetch(() => jsonResponse(200, { ...PROBLEM, freshness }));
      expect((await client({ fetch }).getProblem(PROBLEM_ID)).freshness).toBe(freshness);
    }
  });

  it('uses the injected transport rather than the platform one', async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, PROBLEM));

    await client({ fetch }).getProblem(PROBLEM_ID);

    // If the injection were ignored, a real request would be attempted and
    // this counter would stay at zero.
    expect(calls).toHaveLength(1);
  });
});

describe('refusals', () => {
  it('reports a refusal with its status, code and request id', async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse(404, {
        error: { code: 'NOT_FOUND', message: 'Not found.' },
        request_id: 'req-1',
      }),
    );

    try {
      await client({ fetch }).getProblem(PROBLEM_ID);
      expect.unreachable('a 404 must not be a success');
    } catch (error) {
      expect(error).toBeInstanceOf(MemoryApiError);
      expect((error as MemoryApiError).status).toBe(404);
      expect((error as MemoryApiError).code).toBe('NOT_FOUND');
      expect((error as MemoryApiError).requestId).toBe('req-1');
    }
  });

  it('recognises every code the contract names', async () => {
    for (const [status, code] of [
      [400, 'INVALID_REQUEST'],
      [401, 'UNAUTHENTICATED'],
      [404, 'NOT_FOUND'],
      [409, 'VERSION_CONFLICT'],
      [409, 'EXPORT_BLOCKED'],
      [500, 'INTERNAL_ERROR'],
    ] as const) {
      const { fetch } = recordingFetch(() =>
        jsonResponse(status, { error: { code, message: 'x' }, request_id: 'req-2' }),
      );

      await expect(client({ fetch }).getProblem(PROBLEM_ID)).rejects.toMatchObject({
        name: 'MemoryApiError',
        code,
        status,
      });
    }
  });

  it('does not echo the server-supplied message', async () => {
    const planted = 'sensitive-value-from-a-server-message';
    const { fetch } = recordingFetch(() =>
      jsonResponse(400, {
        error: { code: 'INVALID_REQUEST', message: planted },
        request_id: 'req-3',
      }),
    );

    try {
      await client({ fetch }).getProblem(PROBLEM_ID);
      expect.unreachable('a 400 must not be a success');
    } catch (error) {
      // Fixed prose selected by the code, so nothing decided elsewhere is
      // repeated into whatever logs this.
      expect((error as Error).message.includes(planted)).toBe(false);
      expect(JSON.stringify(error).includes(planted)).toBe(false);
    }
  });
});

describe('answers this contract cannot read', () => {
  it('treats a non-JSON body as a protocol failure', async () => {
    const { fetch } = recordingFetch(
      () => new Response('<html>502 Bad Gateway</html>', { status: 502 }),
    );

    await expect(client({ fetch }).getProblem(PROBLEM_ID)).rejects.toMatchObject({
      name: 'MemoryApiProtocolError',
      failure: 'BODY_NOT_JSON',
    });
  });

  it('treats JSON that is not an object as a protocol failure', async () => {
    for (const body of [[], 'text', 7, null]) {
      const { fetch } = recordingFetch(() => jsonResponse(200, body));
      await expect(client({ fetch }).getProblem(PROBLEM_ID)).rejects.toMatchObject({
        failure: 'BODY_NOT_AN_OBJECT',
      });
    }
  });

  it('treats a malformed error envelope as a protocol failure, not a refusal', async () => {
    for (const body of [
      {},
      { error: 'nope', request_id: 'r' },
      { error: { code: 'NOT_FOUND' } },
      { error: { code: 'NOT_FOUND' }, request_id: 5 },
      { message: 'Forbidden' },
    ]) {
      const { fetch } = recordingFetch(() => jsonResponse(403, body));
      const error = await client({ fetch })
        .getProblem(PROBLEM_ID)
        .catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(MemoryApiProtocolError);
      expect(error).not.toBeInstanceOf(MemoryApiError);
    }
  });

  it('does not invent a known code for an unknown one', async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse(429, { error: { code: 'RATE_LIMITED', message: 'x' }, request_id: 'r' }),
    );

    const error = await client({ fetch })
      .getProblem(PROBLEM_ID)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(MemoryApiProtocolError);
    expect((error as MemoryApiProtocolError).failure).toBe('ERROR_CODE_UNKNOWN');
    // The unknown code is not repeated into the message either.
    expect((error as Error).message.includes('RATE_LIMITED')).toBe(false);
  });

  it('refuses a 2xx body that is not the resource it claims to be', async () => {
    for (const body of [
      { ...PROBLEM, status: 'SOLVED' },
      { ...PROBLEM, confidence: 'VERY_HIGH' },
      { ...PROBLEM, fix_kind: 'PATCH' },
      { ...PROBLEM, version: 'three' },
      { ...PROBLEM, version: 1.5 },
      { ...PROBLEM, importance: 'yes' },
      { ...PROBLEM, title: null },
      Object.fromEntries(Object.entries(PROBLEM).filter(([key]) => key !== 'updated_at')),
    ]) {
      const { fetch } = recordingFetch(() => jsonResponse(200, body));
      await expect(client({ fetch }).getProblem(PROBLEM_ID)).rejects.toMatchObject({
        name: 'MemoryApiProtocolError',
        failure: 'RESOURCE_MALFORMED',
      });
    }
  });

  it('keeps the unreadable body out of the failure', async () => {
    const planted = 'a-memory-body-nobody-should-log';
    const { fetch } = recordingFetch(() => jsonResponse(200, { ...PROBLEM, title: [planted] }));

    const error = await client({ fetch })
      .getProblem(PROBLEM_ID)
      .catch((thrown: unknown) => thrown);

    expect((error as Error).message.includes(planted)).toBe(false);
    expect(JSON.stringify(error).includes(planted)).toBe(false);
  });
});

describe('no answer at all', () => {
  it('separates a transport failure from a refusal', async () => {
    const { fetch } = recordingFetch(() => {
      throw new TypeError('fetch failed');
    });

    const error = await client({ fetch })
      .getProblem(PROBLEM_ID)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(MemoryApiUnreachableError);
    expect(error).not.toBeInstanceOf(MemoryApiError);
    expect((error as MemoryApiUnreachableError).reason).toBe('TRANSPORT');
  });

  it('reports an abandoned request as unreachable', async () => {
    const aborted = new Error('The operation was aborted');
    aborted.name = 'TimeoutError';
    const { fetch } = recordingFetch(() => {
      throw aborted;
    });

    const error = await client({ fetch })
      .getProblem(PROBLEM_ID)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(MemoryApiUnreachableError);
    expect((error as MemoryApiUnreachableError).reason).toBe('ABORTED');
  });

  it('abandons a request that never answers', async () => {
    // A transport that never settles unless the signal fires. If the request
    // carried no deadline this test would hang rather than fail.
    const fetch: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'TimeoutError';
          reject(error);
        });
      });

    const built = createMemoryApiClient({ credential: CREDENTIAL, fetch, timeoutMs: 20 });

    await expect(built.getProblem(PROBLEM_ID)).rejects.toBeInstanceOf(MemoryApiUnreachableError);
  });

  it('keeps the text of the underlying failure out of what it throws', async () => {
    const planted = 'connect ECONNREFUSED 127.0.0.1:3000 while sending secret-looking-detail';
    const { fetch } = recordingFetch(() => {
      throw new Error(planted);
    });

    const error = await client({ fetch })
      .getProblem(PROBLEM_ID)
      .catch((thrown: unknown) => thrown);

    expect((error as Error).message.includes('ECONNREFUSED')).toBe(false);
    expect((error as Error).message.includes(planted)).toBe(false);
    // Not as a cause either: a cause is printed by ordinary loggers.
    expect((error as Error).cause).toBeUndefined();
  });
});

describe('one call is one request', () => {
  it('does not retry a transport failure', async () => {
    const { fetch, calls } = recordingFetch(() => {
      throw new TypeError('fetch failed');
    });

    await client({ fetch })
      .getProblem(PROBLEM_ID)
      .catch(() => undefined);

    expect(calls).toHaveLength(1);
  });

  it('does not retry a server error', async () => {
    const { fetch, calls } = recordingFetch(() =>
      jsonResponse(500, { error: { code: 'INTERNAL_ERROR', message: 'x' }, request_id: 'r' }),
    );

    await client({ fetch })
      .getProblem(PROBLEM_ID)
      .catch(() => undefined);

    expect(calls).toHaveLength(1);
  });

  it('does not retry a success', async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, PROBLEM));

    await client({ fetch }).getProblem(PROBLEM_ID);

    expect(calls).toHaveLength(1);
  });
});

describe('the credential in a failure', () => {
  it('is absent whatever went wrong', async () => {
    const answers: (() => Response)[] = [
      () =>
        jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'x' }, request_id: 'r' }),
      () => jsonResponse(200, { broken: true }),
      () => new Response('nonsense', { status: 200 }),
      () => jsonResponse(403, { nothing: 'useful' }),
    ];

    for (const answer of answers) {
      const { fetch } = recordingFetch(answer);
      const error = await client({ fetch })
        .getProblem(PROBLEM_ID)
        .catch((thrown: unknown) => thrown);

      const rendered = `${String(error)}${JSON.stringify(error)}${(error as Error).stack ?? ''}`;
      expect(rendered.includes(CREDENTIAL)).toBe(false);
    }

    const thrown = new TypeError('fetch failed');
    const { fetch } = recordingFetch(() => {
      throw thrown;
    });
    const error = await client({ fetch })
      .getProblem(PROBLEM_ID)
      .catch((caught: unknown) => caught);
    expect(`${String(error)}${JSON.stringify(error)}`.includes(CREDENTIAL)).toBe(false);
  });

  it('is absent from what the request carries, other than the header', async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, PROBLEM));

    await client({ fetch, baseUrl: 'https://host/memory' }).getProblem(PROBLEM_ID);

    const call = calls[0];
    expect(call).toBeDefined();
    if (call === undefined) {
      return;
    }

    const headers = new Headers(call.init?.headers);
    headers.delete('authorization');
    const withoutHeader = requestFootprint({ url: call.url, init: { ...call.init, headers: {} } });

    expect(withoutHeader.includes(CREDENTIAL)).toBe(false);
    expect([...headers.keys()].includes('authorization')).toBe(false);
  });
});
