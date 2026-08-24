/** The atomic Problem conclusion method at the JSON boundary. */

import { describe, expect, it, vi } from 'vitest';

import {
  CLOSE_PROBLEM_REQUEST_FIELDS,
  CLOSE_PROBLEM_TARGET_STATUSES,
  createMemoryApiClient,
  MemoryApiArgumentError,
  MemoryApiError,
  MemoryApiProtocolError,
  MemoryApiUnreachableError,
  MEMORY_API_REQUEST_TIMEOUT_MS,
  type CloseProblemRequest,
  type FetchLike,
} from '../src/index.js';

/** Synthetic. It is shaped like a credential and is not one. */
const CREDENTIAL = 'memory_test_0000000000000000000000000000';
const PROBLEM_ID = 'aaaaaaaa-1111-4222-8333-444444444444';

const PROBLEM = {
  problem_id: PROBLEM_ID,
  owner_id: '99999999-8888-4777-8666-555555555555',
  project_id: '11111111-2222-4333-8444-555555555555',
  environment_id: '22222222-3333-4444-8555-666666666666',
  title: 'a cached artifact is reused after invalidation',
  symptoms: 'the stale artifact is served until the process restarts',
  problem_domain: null,
  suspected_boundary: null,
  source_ai: 'claude-code',
  status: 'VERIFIED',
  fix_kind: 'ROOT_FIX',
  importance: false,
  confidence: 'MEDIUM',
  freshness: 'CURRENT',
  memory_read_enabled: true,
  memory_write_enabled: true,
  suppressed: false,
  version: 5,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
};

const CLOSE: CloseProblemRequest = {
  expected_version: 4,
  changed_by: 'claude-code',
  target_status: 'VERIFIED',
};

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function urlOf(input: Parameters<FetchLike>[0]): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function answering(status: number, body: unknown) {
  const calls: Call[] = [];
  const fetch: FetchLike = (input, init) => {
    calls.push({ url: urlOf(input), init });
    return Promise.resolve(jsonResponse(status, body));
  };
  return { calls, memory: createMemoryApiClient({ credential: CREDENTIAL, fetch }) };
}

function bodyOf(call: Call | undefined): Record<string, unknown> {
  const body = call?.init?.body;
  return JSON.parse(typeof body === 'string' ? body : '{}') as Record<string, unknown>;
}

function errorEnvelope(code: string): unknown {
  return { error: { code, message: 'a fixed sentence' }, request_id: 'req-fixed' };
}

function problemAt(status: CloseProblemRequest['target_status'], overrides = {}): unknown {
  return { ...PROBLEM, status, ...overrides };
}

function prototypeCarrier(fields: Record<string, unknown>): Record<string, unknown> {
  const request: Record<string, unknown> = {};
  Object.defineProperty(request, '__proto__', {
    enumerable: true,
    value: fields,
  });
  return request;
}

describe('what closeProblem sends', () => {
  it('posts exactly the required fields to the Problem close route', async () => {
    const { memory, calls } = answering(200, PROBLEM);

    await memory.closeProblem(PROBLEM_ID, CLOSE);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`http://127.0.0.1:3000/v1/problems/${PROBLEM_ID}/close`);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(bodyOf(calls[0])).toEqual(CLOSE);
  });

  it('canonicalises an uppercase Problem id before the non-retryable close', async () => {
    const { memory, calls } = answering(200, PROBLEM);

    await expect(memory.closeProblem(PROBLEM_ID.toUpperCase(), CLOSE)).resolves.toEqual(PROBLEM);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`http://127.0.0.1:3000/v1/problems/${PROBLEM_ID}/close`);
  });

  it('sends every optional conclusion field without collapsing null or absence', async () => {
    const request: CloseProblemRequest = {
      ...CLOSE,
      fix_kind: null,
      final_cause_summary: 'the invalidation skipped one artifact class',
      effective_direction: 'invalidate that class in the same transaction',
      dead_end_summary: 'clearing the process cache changed nothing',
      unresolved_points: 'older artifact formats still need checking',
    };
    const { memory, calls } = answering(200, { ...PROBLEM, fix_kind: null });

    await memory.closeProblem(PROBLEM_ID, request);

    expect(bodyOf(calls[0])).toEqual(request);
    expect('fix_kind' in bodyOf(calls[0])).toBe(true);
  });

  it('asks for each conclusion target and leaves legality to the server', async () => {
    for (const target_status of CLOSE_PROBLEM_TARGET_STATUSES) {
      const { memory, calls } = answering(200, problemAt(target_status));
      await memory.closeProblem(PROBLEM_ID, { ...CLOSE, target_status });
      expect(bodyOf(calls[0])['target_status']).toBe(target_status);
    }
  });

  it.each([
    ['a working target', { ...CLOSE, target_status: 'FIX_CANDIDATE' }],
    ['an unknown target', { ...CLOSE, target_status: 'REOPENED' }],
    ['version zero', { ...CLOSE, expected_version: 0 }],
    ['a fractional version', { ...CLOSE, expected_version: 1.5 }],
    ['a textual version', { ...CLOSE, expected_version: '4' }],
    ['a blank actor', { ...CLOSE, changed_by: ' \n ' }],
    ['an unknown fix kind', { ...CLOSE, fix_kind: 'PARTIAL' }],
    ['a blank review', { ...CLOSE, effective_direction: '\t' }],
    ['an explicit undefined', { ...CLOSE, unresolved_points: undefined }],
    ['an extra field', { ...CLOSE, status: 'VERIFIED' }],
  ])('refuses %s before spending a request', async (_label, request) => {
    const { memory, calls } = answering(200, PROBLEM);
    await expect(memory.closeProblem(PROBLEM_ID, request as never)).rejects.toBeInstanceOf(
      MemoryApiArgumentError,
    );
    expect(calls).toHaveLength(0);
  });

  it('refuses an accessor without evaluating it as the compare-and-swap version', async () => {
    let reads = 0;
    const request = { ...CLOSE };
    Object.defineProperty(request, 'expected_version', {
      enumerable: true,
      get() {
        reads += 1;
        return CLOSE.expected_version;
      },
    });
    const { memory, calls } = answering(200, PROBLEM);

    await expect(memory.closeProblem(PROBLEM_ID, request)).rejects.toBeInstanceOf(
      MemoryApiArgumentError,
    );

    expect(reads).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('refuses conclusion fields smuggled through an own __proto__ key', async () => {
    const { memory, calls } = answering(200, PROBLEM);

    await expect(
      memory.closeProblem(
        PROBLEM_ID,
        prototypeCarrier(CLOSE as unknown as Record<string, unknown>) as never,
      ),
    ).rejects.toBeInstanceOf(MemoryApiArgumentError);

    expect(calls).toHaveLength(0);
  });

  it('refuses each missing required field', async () => {
    for (const field of ['expected_version', 'changed_by', 'target_status'] as const) {
      const request = { ...CLOSE } as Record<string, unknown>;
      delete request[field];
      const { memory, calls } = answering(200, PROBLEM);
      await expect(memory.closeProblem(PROBLEM_ID, request as never)).rejects.toBeInstanceOf(
        MemoryApiArgumentError,
      );
      expect(calls).toHaveLength(0);
    }
  });

  it('refuses an unsafe Problem id before building a URL', async () => {
    const { memory, calls } = answering(200, PROBLEM);
    await expect(memory.closeProblem(`${PROBLEM_ID}/close`, CLOSE)).rejects.toBeInstanceOf(
      MemoryApiArgumentError,
    );
    expect(calls).toHaveLength(0);
  });
});

describe('what closeProblem accepts back', () => {
  it('returns the Problem the server sent', async () => {
    const { memory } = answering(200, PROBLEM);
    await expect(memory.closeProblem(PROBLEM_ID, CLOSE)).resolves.toEqual(PROBLEM);
  });

  it('refuses a Problem with another identity', async () => {
    const { memory } = answering(200, {
      ...PROBLEM,
      problem_id: 'bbbbbbbb-1111-4222-8333-444444444444',
    });
    await expect(memory.closeProblem(PROBLEM_ID, CLOSE)).rejects.toBeInstanceOf(
      MemoryApiProtocolError,
    );
  });

  it('refuses a Problem that did not reach the requested conclusion', async () => {
    const { memory } = answering(200, { ...PROBLEM, status: 'PAUSED' });
    await expect(memory.closeProblem(PROBLEM_ID, CLOSE)).rejects.toBeInstanceOf(
      MemoryApiProtocolError,
    );
  });

  it('refuses a Problem that did not retain the explicitly requested fix kind', async () => {
    const { memory } = answering(200, { ...PROBLEM, fix_kind: 'WORKAROUND' });
    await expect(
      memory.closeProblem(PROBLEM_ID, { ...CLOSE, fix_kind: 'ROOT_FIX' }),
    ).rejects.toBeInstanceOf(MemoryApiProtocolError);
  });

  it('also checks an explicitly requested null fix kind', async () => {
    const { memory } = answering(200, PROBLEM);
    await expect(
      memory.closeProblem(PROBLEM_ID, { ...CLOSE, fix_kind: null }),
    ).rejects.toBeInstanceOf(MemoryApiProtocolError);
  });

  it('accepts any valid version the server returns', async () => {
    for (const version of [5, 6, 40]) {
      const { memory } = answering(200, { ...PROBLEM, version });
      await expect(memory.closeProblem(PROBLEM_ID, CLOSE)).resolves.toMatchObject({ version });
    }
  });

  it.each([
    ['a missing Problem field', { problem_id: PROBLEM_ID, status: 'VERIFIED' }],
    ['an extra Problem field', { ...PROBLEM, review: 'copied' }],
    ['an invalid version', { ...PROBLEM, version: 0 }],
  ])('refuses %s', async (_label, body) => {
    const { memory } = answering(200, body);
    await expect(memory.closeProblem(PROBLEM_ID, CLOSE)).rejects.toBeInstanceOf(
      MemoryApiProtocolError,
    );
  });
});

describe('close refusal and transport policy', () => {
  it.each([
    [400, 'INVALID_REQUEST'],
    [401, 'UNAUTHENTICATED'],
    [404, 'NOT_FOUND'],
    [409, 'VERSION_CONFLICT'],
    [500, 'INTERNAL_ERROR'],
  ])('keeps a refusal at %d as %s', async (status, code) => {
    const { memory } = answering(status, errorEnvelope(code));
    const raised = await memory.closeProblem(PROBLEM_ID, CLOSE).catch((error: unknown) => error);
    expect(raised).toBeInstanceOf(MemoryApiError);
    expect((raised as MemoryApiError).status).toBe(status);
    expect((raised as MemoryApiError).code).toBe(code);
  });

  it('does not retry a conflict', async () => {
    const { memory, calls } = answering(409, errorEnvelope('VERSION_CONFLICT'));
    await memory.closeProblem(PROBLEM_ID, CLOSE).catch(() => undefined);
    expect(calls).toHaveLength(1);
  });

  it('does not retry when no answer arrives', async () => {
    let attempts = 0;
    const fetch: FetchLike = () => {
      attempts += 1;
      return Promise.reject(new Error('synthetic'));
    };
    const memory = createMemoryApiClient({ credential: CREDENTIAL, fetch });
    await expect(memory.closeProblem(PROBLEM_ID, CLOSE)).rejects.toBeInstanceOf(
      MemoryApiUnreachableError,
    );
    expect(attempts).toBe(1);
  });

  it('uses the ordinary request timeout', async () => {
    const seen: number[] = [];
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      seen.push(ms);
      return timeout(ms);
    });

    await answering(200, PROBLEM).memory.closeProblem(PROBLEM_ID, CLOSE);

    expect(seen).toEqual([MEMORY_API_REQUEST_TIMEOUT_MS]);
    spy.mockRestore();
  });

  it('publishes exactly the close fields the route accepts', () => {
    expect(CLOSE_PROBLEM_REQUEST_FIELDS).toEqual([
      'expected_version',
      'changed_by',
      'target_status',
      'fix_kind',
      'final_cause_summary',
      'effective_direction',
      'dead_end_summary',
      'unresolved_points',
    ]);
  });
});
