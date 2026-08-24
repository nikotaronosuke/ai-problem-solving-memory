/** Event and Verification append methods at the JSON boundary. */

import { describe, expect, it, vi } from 'vitest';

import {
  APPEND_EVENT_REQUEST_FIELDS,
  APPEND_VERIFICATION_REQUEST_FIELDS,
  createMemoryApiClient,
  EVENT_RESOURCE_FIELDS,
  EVENT_TYPES,
  MemoryApiArgumentError,
  MemoryApiError,
  MemoryApiProtocolError,
  MemoryApiUnreachableError,
  MEMORY_API_REQUEST_TIMEOUT_MS,
  VERIFICATION_RESOURCE_FIELDS,
  VERIFICATION_TYPES,
  type AppendEventRequest,
  type AppendVerificationRequest,
  type FetchLike,
} from '../src/index.js';

/** Synthetic. It is shaped like a credential and is not one. */
const CREDENTIAL = 'memory_test_0000000000000000000000000000';
const PROBLEM_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
const OTHER_PROBLEM_ID = 'bbbbbbbb-1111-4222-8333-444444444444';
const EVENT_KEY = 'cccccccc-1111-4222-8333-444444444444';
const VERIFICATION_KEY = 'dddddddd-1111-4222-8333-444444444444';

const EVENT_REQUEST: AppendEventRequest = {
  event_type: 'DEAD_END',
  summary: 'clearing the cache did not change the failure',
  client_event_id: EVENT_KEY,
};

const EVENT = {
  event_id: 'eeeeeeee-1111-4222-8333-444444444444',
  owner_id: '99999999-8888-4777-8666-555555555555',
  problem_id: PROBLEM_ID,
  event_type: 'DEAD_END',
  summary: EVENT_REQUEST.summary,
  result: null,
  reason: null,
  source_ai: 'claude-code',
  evidence_ref: null,
  client_event_id: EVENT_KEY,
  created_at: '2026-01-01T00:00:00.000Z',
};

const VERIFICATION_REQUEST: AppendVerificationRequest = {
  verification_type: 'TEST',
  result: true,
  summary: 'the regression suite passed',
  client_event_id: VERIFICATION_KEY,
};

const VERIFICATION = {
  verification_id: 'ffffffff-1111-4222-8333-444444444444',
  owner_id: EVENT.owner_id,
  problem_id: PROBLEM_ID,
  verification_type: 'TEST',
  result: true,
  summary: VERIFICATION_REQUEST.summary,
  evidence_ref: null,
  verified_by: 'claude-code',
  client_event_id: VERIFICATION_KEY,
  created_at: '2026-01-01T00:01:00.000Z',
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

function omit(value: Record<string, unknown>, field: string): Record<string, unknown> {
  const copy = { ...value };
  delete copy[field];
  return copy;
}

function prototypeCarrier(fields: Record<string, unknown>): Record<string, unknown> {
  const request: Record<string, unknown> = {};
  Object.defineProperty(request, '__proto__', {
    enumerable: true,
    value: fields,
  });
  return request;
}

describe('appending an Event', () => {
  it('posts exactly the required fields to the nested Event route', async () => {
    const { memory, calls } = answering(201, EVENT);

    await memory.appendEvent(PROBLEM_ID, EVENT_REQUEST);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`http://127.0.0.1:3000/v1/problems/${PROBLEM_ID}/events`);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(bodyOf(calls[0])).toEqual(EVENT_REQUEST);
  });

  it('preserves every optional field, including explicit null', async () => {
    const { memory, calls } = answering(201, EVENT);
    const request: AppendEventRequest = {
      ...EVENT_REQUEST,
      result: 'still failed',
      reason: null,
      source_ai: 'claude-code',
      evidence_ref: '',
    };

    await memory.appendEvent(PROBLEM_ID, request);

    expect(bodyOf(calls[0])).toEqual(request);
    expect('reason' in bodyOf(calls[0])).toBe(true);
  });

  it('accepts every canonical Event type without deciding its meaning', async () => {
    for (const event_type of EVENT_TYPES) {
      const { memory, calls } = answering(201, { ...EVENT, event_type });
      await memory.appendEvent(PROBLEM_ID, { ...EVENT_REQUEST, event_type });
      expect(bodyOf(calls[0])['event_type']).toBe(event_type);
    }
  });

  it.each([
    ['an unknown type', { ...EVENT_REQUEST, event_type: 'OBSERVATION' }],
    ['a blank summary', { ...EVENT_REQUEST, summary: ' \n ' }],
    ['a malformed key', { ...EVENT_REQUEST, client_event_id: 'not-an-id' }],
    ['a missing key', omit(EVENT_REQUEST as unknown as Record<string, unknown>, 'client_event_id')],
    ['an extra field', { ...EVENT_REQUEST, problem_id: PROBLEM_ID }],
    ['an undefined optional field', { ...EVENT_REQUEST, reason: undefined }],
  ])('refuses %s before spending a request', async (_label, request) => {
    const { memory, calls } = answering(201, EVENT);

    await expect(memory.appendEvent(PROBLEM_ID, request as never)).rejects.toBeInstanceOf(
      MemoryApiArgumentError,
    );
    expect(calls).toHaveLength(0);
  });

  it('refuses an accessor without evaluating it as an idempotency key', async () => {
    let reads = 0;
    const request = { ...EVENT_REQUEST };
    Object.defineProperty(request, 'client_event_id', {
      enumerable: true,
      get() {
        reads += 1;
        return EVENT_KEY;
      },
    });
    const { memory, calls } = answering(201, EVENT);

    await expect(memory.appendEvent(PROBLEM_ID, request)).rejects.toBeInstanceOf(
      MemoryApiArgumentError,
    );

    expect(reads).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('refuses required Event fields smuggled through an own __proto__ key', async () => {
    const { memory, calls } = answering(201, EVENT);

    await expect(
      memory.appendEvent(
        PROBLEM_ID,
        prototypeCarrier(EVENT_REQUEST as unknown as Record<string, unknown>) as never,
      ),
    ).rejects.toBeInstanceOf(MemoryApiArgumentError);

    expect(calls).toHaveLength(0);
  });

  it('refuses an unsafe Problem id before building a URL', async () => {
    const { memory, calls } = answering(201, EVENT);
    await expect(memory.appendEvent('../other', EVENT_REQUEST)).rejects.toBeInstanceOf(
      MemoryApiArgumentError,
    );
    expect(calls).toHaveLength(0);
  });

  it('accepts a first-write-wins replay from another Problem with its original payload', async () => {
    const replay = {
      ...EVENT,
      problem_id: OTHER_PROBLEM_ID,
      event_type: 'DISCOVERY',
      summary: 'the first write under this key',
    };
    const { memory } = answering(201, replay);

    await expect(memory.appendEvent(PROBLEM_ID, EVENT_REQUEST)).resolves.toEqual(replay);
  });

  it('accepts the server-normalised spelling of the same UUID key', async () => {
    const upper = EVENT_KEY.toUpperCase();
    const { memory } = answering(201, EVENT);

    await expect(
      memory.appendEvent(PROBLEM_ID, { ...EVENT_REQUEST, client_event_id: upper }),
    ).resolves.toEqual(EVENT);
  });

  it('refuses a well-shaped Event returned under another idempotency key', async () => {
    const { memory } = answering(201, { ...EVENT, client_event_id: VERIFICATION_KEY });
    await expect(memory.appendEvent(PROBLEM_ID, EVENT_REQUEST)).rejects.toBeInstanceOf(
      MemoryApiProtocolError,
    );
  });

  it.each([
    ['a missing field', omit(EVENT, 'created_at')],
    ['an extra field', { ...EVENT, updated_at: EVENT.created_at }],
    ['an unknown type', { ...EVENT, event_type: 'OBSERVATION' }],
    ['a non-nullable wrong result', { ...EVENT, result: false }],
  ])('refuses an Event response with %s', async (_label, body) => {
    const { memory } = answering(201, body);
    await expect(memory.appendEvent(PROBLEM_ID, EVENT_REQUEST)).rejects.toBeInstanceOf(
      MemoryApiProtocolError,
    );
  });
});

describe('appending a Verification', () => {
  it('posts exactly the required fields to the nested Verification route', async () => {
    const { memory, calls } = answering(201, VERIFICATION);

    await memory.appendVerification(PROBLEM_ID, VERIFICATION_REQUEST);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`http://127.0.0.1:3000/v1/problems/${PROBLEM_ID}/verifications`);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(bodyOf(calls[0])).toEqual(VERIFICATION_REQUEST);
  });

  it('preserves optional fields, false, empty text and explicit null', async () => {
    const request: AppendVerificationRequest = {
      ...VERIFICATION_REQUEST,
      result: false,
      evidence_ref: '',
      verified_by: null,
    };
    const { memory, calls } = answering(201, { ...VERIFICATION, result: false });

    await memory.appendVerification(PROBLEM_ID, request);

    expect(bodyOf(calls[0])).toEqual(request);
  });

  it('accepts every canonical Verification type', async () => {
    for (const verification_type of VERIFICATION_TYPES) {
      const { memory, calls } = answering(201, { ...VERIFICATION, verification_type });
      await memory.appendVerification(PROBLEM_ID, {
        ...VERIFICATION_REQUEST,
        verification_type,
      });
      expect(bodyOf(calls[0])['verification_type']).toBe(verification_type);
    }
  });

  it.each([
    ['an unknown type', { ...VERIFICATION_REQUEST, verification_type: 'MANUAL' }],
    ['a non-boolean result', { ...VERIFICATION_REQUEST, result: 'true' }],
    ['a blank summary', { ...VERIFICATION_REQUEST, summary: '\t' }],
    ['a malformed key', { ...VERIFICATION_REQUEST, client_event_id: 'not-an-id' }],
    ['an extra field', { ...VERIFICATION_REQUEST, event_id: EVENT.event_id }],
    ['an undefined optional field', { ...VERIFICATION_REQUEST, verified_by: undefined }],
  ])('refuses %s before spending a request', async (_label, request) => {
    const { memory, calls } = answering(201, VERIFICATION);
    await expect(memory.appendVerification(PROBLEM_ID, request as never)).rejects.toBeInstanceOf(
      MemoryApiArgumentError,
    );
    expect(calls).toHaveLength(0);
  });

  it('refuses an accessor without evaluating it as an idempotency key', async () => {
    let reads = 0;
    const request = { ...VERIFICATION_REQUEST };
    Object.defineProperty(request, 'client_event_id', {
      enumerable: true,
      get() {
        reads += 1;
        return VERIFICATION_KEY;
      },
    });
    const { memory, calls } = answering(201, VERIFICATION);

    await expect(memory.appendVerification(PROBLEM_ID, request)).rejects.toBeInstanceOf(
      MemoryApiArgumentError,
    );

    expect(reads).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('refuses required Verification fields smuggled through an own __proto__ key', async () => {
    const { memory, calls } = answering(201, VERIFICATION);

    await expect(
      memory.appendVerification(
        PROBLEM_ID,
        prototypeCarrier(VERIFICATION_REQUEST as unknown as Record<string, unknown>) as never,
      ),
    ).rejects.toBeInstanceOf(MemoryApiArgumentError);

    expect(calls).toHaveLength(0);
  });

  it('accepts a first-write-wins replay without comparing Problem, result, or payload', async () => {
    const replay = {
      ...VERIFICATION,
      problem_id: OTHER_PROBLEM_ID,
      verification_type: 'BUILD',
      result: false,
      summary: 'the original check failed',
    };
    const { memory } = answering(201, replay);

    await expect(memory.appendVerification(PROBLEM_ID, VERIFICATION_REQUEST)).resolves.toEqual(
      replay,
    );
  });

  it('refuses a well-shaped Verification returned under another idempotency key', async () => {
    const { memory } = answering(201, { ...VERIFICATION, client_event_id: EVENT_KEY });
    await expect(
      memory.appendVerification(PROBLEM_ID, VERIFICATION_REQUEST),
    ).rejects.toBeInstanceOf(MemoryApiProtocolError);
  });

  it.each([
    ['a missing field', omit(VERIFICATION, 'created_at')],
    ['an extra field', { ...VERIFICATION, event_id: EVENT.event_id }],
    ['an unknown type', { ...VERIFICATION, verification_type: 'MANUAL' }],
    ['a non-boolean result', { ...VERIFICATION, result: 'true' }],
  ])('refuses a Verification response with %s', async (_label, body) => {
    const { memory } = answering(201, body);
    await expect(
      memory.appendVerification(PROBLEM_ID, VERIFICATION_REQUEST),
    ).rejects.toBeInstanceOf(MemoryApiProtocolError);
  });
});

describe('append failures and transport policy', () => {
  it.each([
    [400, 'INVALID_REQUEST'],
    [401, 'UNAUTHENTICATED'],
    [404, 'NOT_FOUND'],
    [500, 'INTERNAL_ERROR'],
  ])('keeps an Event refusal at %d as %s', async (status, code) => {
    const { memory } = answering(status, errorEnvelope(code));
    const raised = await memory
      .appendEvent(PROBLEM_ID, EVENT_REQUEST)
      .catch((error: unknown) => error);
    expect(raised).toBeInstanceOf(MemoryApiError);
    expect((raised as MemoryApiError).code).toBe(code);
  });

  it('never retries either append when no answer arrives', async () => {
    let attempts = 0;
    const fetch: FetchLike = () => {
      attempts += 1;
      return Promise.reject(new Error('synthetic'));
    };
    const memory = createMemoryApiClient({ credential: CREDENTIAL, fetch });

    await expect(memory.appendEvent(PROBLEM_ID, EVENT_REQUEST)).rejects.toBeInstanceOf(
      MemoryApiUnreachableError,
    );
    await expect(
      memory.appendVerification(PROBLEM_ID, VERIFICATION_REQUEST),
    ).rejects.toBeInstanceOf(MemoryApiUnreachableError);
    expect(attempts).toBe(2);
  });

  it('uses the ordinary request timeout for both appends', async () => {
    const seen: number[] = [];
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      seen.push(ms);
      return timeout(ms);
    });

    await answering(201, EVENT).memory.appendEvent(PROBLEM_ID, EVENT_REQUEST);
    await answering(201, VERIFICATION).memory.appendVerification(PROBLEM_ID, VERIFICATION_REQUEST);

    expect(seen).toEqual([MEMORY_API_REQUEST_TIMEOUT_MS, MEMORY_API_REQUEST_TIMEOUT_MS]);
    spy.mockRestore();
  });

  it('publishes the closed request and resource field inventories', () => {
    expect(APPEND_EVENT_REQUEST_FIELDS).toEqual([
      'event_type',
      'summary',
      'client_event_id',
      'result',
      'reason',
      'source_ai',
      'evidence_ref',
    ]);
    expect(APPEND_VERIFICATION_REQUEST_FIELDS).toEqual([
      'verification_type',
      'result',
      'summary',
      'client_event_id',
      'evidence_ref',
      'verified_by',
    ]);
    expect(EVENT_RESOURCE_FIELDS).toHaveLength(11);
    expect(VERIFICATION_RESOURCE_FIELDS).toHaveLength(10);
  });
});
