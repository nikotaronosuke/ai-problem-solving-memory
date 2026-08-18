/**
 * What `transitionProblemStatus` sends, and what it accepts back.
 *
 * The write in this client whose *answer* matters most. Every other mutation
 * creates something and the caller learns its identity; this one moves a record
 * somebody is about to act on, and a caller told a Problem was resumed will
 * carry on as though it were. So the checks here are about the two things the
 * request actually claimed — this Problem, that status — and deliberately about
 * nothing else the server owns.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createMemoryApiClient,
  MemoryApiArgumentError,
  MemoryApiError,
  MemoryApiProtocolError,
  MemoryApiUnreachableError,
  MEMORY_API_REQUEST_TIMEOUT_MS,
  PROBLEM_STATUSES,
  TRANSITION_PROBLEM_STATUS_REQUEST_FIELDS,
  type FetchLike,
  type ProblemStatus,
  type TransitionProblemStatusRequest,
} from '../src/index.js';

/** A synthetic value in the shape of a credential. Not one. */
const CREDENTIAL = 'memory_test_0000000000000000000000000000';

const PROBLEM_ID = 'aaaaaaaa-1111-4222-8333-444444444444';

const PAUSED = {
  problem_id: PROBLEM_ID,
  owner_id: '99999999-8888-4777-8666-555555555555',
  project_id: '11111111-2222-4333-8444-555555555555',
  environment_id: '22222222-3333-4444-8555-666666666666',
  title: 'a cached artifact is reused after invalidation',
  symptoms: 'the stale artifact is served until the process restarts',
  problem_domain: null,
  suspected_boundary: null,
  source_ai: 'claude-code',
  status: 'PAUSED',
  fix_kind: null,
  importance: false,
  confidence: 'MEDIUM',
  freshness: 'CURRENT',
  memory_read_enabled: true,
  memory_write_enabled: true,
  suppressed: false,
  version: 4,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
};

/** The same Problem, after a transition the server accepted. */
function transitionedTo(status: ProblemStatus, overrides: Record<string, unknown> = {}): unknown {
  return { ...PAUSED, status, version: PAUSED.version + 1, ...overrides };
}

const RESUME: TransitionProblemStatusRequest = {
  target_status: 'INVESTIGATING',
  expected_version: 4,
  changed_by: 'claude-code',
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

function bodyOf(call: Call | undefined): Record<string, unknown> {
  const body = call?.init?.body;
  return JSON.parse(typeof body === 'string' ? body : '{}') as Record<string, unknown>;
}

describe('what a transition sends', () => {
  it('posts to the Problem status-transitions route', async () => {
    const { memory, calls } = answering(200, transitionedTo('INVESTIGATING'));

    await memory.transitionProblemStatus(PROBLEM_ID, RESUME);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      `http://127.0.0.1:3000/v1/problems/${PROBLEM_ID}/status-transitions`,
    );
    expect(calls[0]?.init?.method).toBe('POST');
  });

  it('sends exactly the three fields the route accepts', async () => {
    const { memory, calls } = answering(200, transitionedTo('INVESTIGATING'));

    await memory.transitionProblemStatus(PROBLEM_ID, RESUME);

    expect(bodyOf(calls[0])).toEqual({
      target_status: 'INVESTIGATING',
      expected_version: 4,
      changed_by: 'claude-code',
    });
  });

  it('does not carry an extra property a caller attached', async () => {
    // The route refuses extras, so this would be a `400` a round trip later —
    // but the reason to write the body out field by field is that `status` or
    // `version` arriving from a caller is a different kind of mistake than a
    // typo, and neither should be able to leave this process.
    const { memory, calls } = answering(200, transitionedTo('INVESTIGATING'));
    const request = { ...RESUME, version: 99 } as unknown as TransitionProblemStatusRequest;

    await expect(memory.transitionProblemStatus(PROBLEM_ID, request)).rejects.toBeInstanceOf(
      MemoryApiArgumentError,
    );
    expect(calls).toHaveLength(0);
  });

  it('uses the ordinary request timeout', async () => {
    const seen: number[] = [];
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      seen.push(ms);
      return timeout(ms);
    });

    const { memory } = answering(200, transitionedTo('INVESTIGATING'));
    await memory.transitionProblemStatus(PROBLEM_ID, RESUME);

    expect(seen).toEqual([MEMORY_API_REQUEST_TIMEOUT_MS]);
    spy.mockRestore();
  });
});

describe('what a transition will ask for', () => {
  it('accepts every canonical status as a target', async () => {
    // The client is not the authority on which move is legal. That depends on
    // the record's current state, the server checks it against the record, and
    // a matrix mirrored here would refuse requests a correct server accepts.
    for (const status of PROBLEM_STATUSES) {
      const { memory, calls } = answering(200, transitionedTo(status));

      await memory.transitionProblemStatus(PROBLEM_ID, { ...RESUME, target_status: status });

      expect(bodyOf(calls[0])).toMatchObject({ target_status: status });
    }
  });

  it('will still ask to close a Problem, because that is not its judgement', async () => {
    // Named on its own because it is the one an adapter policy restricts. This
    // client is transport: `CLOSED_UNRESOLVED` is a canonical status and a
    // legal move from several states, so refusing it here would put a lifecycle
    // rule in the layer with no record to check it against. Whether *this*
    // Problem may be closed is the server's answer, and whether a "resume"
    // means it is the adapter's.
    const { memory, calls } = answering(200, transitionedTo('CLOSED_UNRESOLVED'));

    await expect(
      memory.transitionProblemStatus(PROBLEM_ID, {
        ...RESUME,
        target_status: 'CLOSED_UNRESOLVED',
      }),
    ).resolves.toMatchObject({ status: 'CLOSED_UNRESOLVED' });
    expect(bodyOf(calls[0])).toMatchObject({ target_status: 'CLOSED_UNRESOLVED' });
  });

  it('refuses a target status the contract does not have', async () => {
    const { memory, calls } = answering(200, transitionedTo('INVESTIGATING'));
    const request = {
      ...RESUME,
      target_status: 'REOPENED',
    } as unknown as TransitionProblemStatusRequest;

    await expect(memory.transitionProblemStatus(PROBLEM_ID, request)).rejects.toBeInstanceOf(
      MemoryApiArgumentError,
    );
    expect(calls).toHaveLength(0);
  });

  it('refuses a version no record could be at', async () => {
    for (const expected_version of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { memory, calls } = answering(200, transitionedTo('INVESTIGATING'));

      await expect(
        memory.transitionProblemStatus(PROBLEM_ID, { ...RESUME, expected_version }),
      ).rejects.toBeInstanceOf(MemoryApiArgumentError);
      expect(calls).toHaveLength(0);
    }
  });

  it('refuses a version that is text shaped like one', async () => {
    const { memory, calls } = answering(200, transitionedTo('INVESTIGATING'));
    const request = {
      ...RESUME,
      expected_version: '4',
    } as unknown as TransitionProblemStatusRequest;

    await expect(memory.transitionProblemStatus(PROBLEM_ID, request)).rejects.toBeInstanceOf(
      MemoryApiArgumentError,
    );
    expect(calls).toHaveLength(0);
  });

  it('refuses a blank changed_by', async () => {
    for (const changed_by of ['', '   ', '\n']) {
      const { memory, calls } = answering(200, transitionedTo('INVESTIGATING'));

      await expect(
        memory.transitionProblemStatus(PROBLEM_ID, { ...RESUME, changed_by }),
      ).rejects.toBeInstanceOf(MemoryApiArgumentError);
      expect(calls).toHaveLength(0);
    }
  });

  it('refuses a request missing any of the three', async () => {
    for (const field of TRANSITION_PROBLEM_STATUS_REQUEST_FIELDS) {
      const request = { ...RESUME } as Record<string, unknown>;
      delete request[field];
      const { memory, calls } = answering(200, transitionedTo('INVESTIGATING'));

      await expect(
        memory.transitionProblemStatus(
          PROBLEM_ID,
          request as unknown as TransitionProblemStatusRequest,
        ),
      ).rejects.toBeInstanceOf(MemoryApiArgumentError);
      expect(calls).toHaveLength(0);
    }
  });

  it('refuses a problem id that would have to be escaped into a path', async () => {
    const { memory, calls } = answering(200, transitionedTo('INVESTIGATING'));

    await expect(
      memory.transitionProblemStatus('../problems/other', RESUME),
    ).rejects.toBeInstanceOf(MemoryApiArgumentError);
    expect(calls).toHaveLength(0);
  });

  it('says which argument was refused and never what was in it', async () => {
    const { memory } = answering(200, transitionedTo('INVESTIGATING'));
    const raised = await memory
      .transitionProblemStatus(PROBLEM_ID, { ...RESUME, changed_by: '  ' })
      .catch((error: unknown) => error);

    expect(raised).toBeInstanceOf(MemoryApiArgumentError);
    expect((raised as MemoryApiArgumentError).argument).toBe('status transition');
  });
});

describe('what a transition accepts back', () => {
  it('returns the Problem the server sent', async () => {
    const answer = transitionedTo('INVESTIGATING');
    const { memory } = answering(200, answer);

    await expect(memory.transitionProblemStatus(PROBLEM_ID, RESUME)).resolves.toEqual(answer);
  });

  it('refuses a body that is not a Problem', async () => {
    const { memory } = answering(200, { problem: { problem_id: PROBLEM_ID } });

    await expect(memory.transitionProblemStatus(PROBLEM_ID, RESUME)).rejects.toBeInstanceOf(
      MemoryApiProtocolError,
    );
  });

  it('refuses a Problem that is not the one asked about', async () => {
    const { memory } = answering(
      200,
      transitionedTo('INVESTIGATING', { problem_id: 'bbbbbbbb-1111-4222-8333-444444444444' }),
    );

    await expect(memory.transitionProblemStatus(PROBLEM_ID, RESUME)).rejects.toBeInstanceOf(
      MemoryApiProtocolError,
    );
  });

  it('refuses a Problem that did not end up in the status asked for', async () => {
    // The quiet one. A caller about to record "resumed" would otherwise record
    // it about a Problem still sitting where it was.
    const { memory } = answering(200, transitionedTo('FIX_CANDIDATE'));

    await expect(memory.transitionProblemStatus(PROBLEM_ID, RESUME)).rejects.toBeInstanceOf(
      MemoryApiProtocolError,
    );
  });

  it('refuses a Problem that did not move at all', async () => {
    const { memory } = answering(200, { ...PAUSED });

    await expect(memory.transitionProblemStatus(PROBLEM_ID, RESUME)).rejects.toBeInstanceOf(
      MemoryApiProtocolError,
    );
  });

  it('refuses a transitioned Problem at a version no record could be at', async () => {
    const { memory } = answering(200, transitionedTo('INVESTIGATING', { version: 0 }));

    await expect(memory.transitionProblemStatus(PROBLEM_ID, RESUME)).rejects.toBeInstanceOf(
      MemoryApiProtocolError,
    );
  });

  it('accepts whatever version the server moved to', async () => {
    // Deliberately not `expected_version + 1`. How far a version moves is the
    // server's, the contract promises no step, and a client asserting one would
    // break the first time a transition wrote something else alongside.
    for (const version of [5, 6, 40]) {
      const { memory } = answering(200, transitionedTo('INVESTIGATING', { version }));

      await expect(memory.transitionProblemStatus(PROBLEM_ID, RESUME)).resolves.toMatchObject({
        version,
      });
    }
  });

  it('accepts fields the transition never mentioned having changed', async () => {
    const { memory } = answering(
      200,
      transitionedTo('INVESTIGATING', {
        updated_at: '2026-03-03T00:00:00.000Z',
        confidence: 'LOW',
      }),
    );

    await expect(memory.transitionProblemStatus(PROBLEM_ID, RESUME)).resolves.toMatchObject({
      confidence: 'LOW',
    });
  });
});

describe('refusals stay refusals', () => {
  it('raises a conflict as an ordinary refusal, with its code intact', async () => {
    const { memory } = answering(409, errorEnvelope('VERSION_CONFLICT'));
    const raised = await memory
      .transitionProblemStatus(PROBLEM_ID, RESUME)
      .catch((error: unknown) => error);

    expect(raised).toBeInstanceOf(MemoryApiError);
    expect((raised as MemoryApiError).status).toBe(409);
    expect((raised as MemoryApiError).code).toBe('VERSION_CONFLICT');
  });

  it('raises the rest of the taxonomy unchanged', async () => {
    const cases: readonly (readonly [number, string])[] = [
      [400, 'INVALID_REQUEST'],
      [401, 'UNAUTHENTICATED'],
      [404, 'NOT_FOUND'],
      [500, 'INTERNAL_ERROR'],
    ];

    for (const [status, code] of cases) {
      const { memory } = answering(status, errorEnvelope(code));
      const raised = await memory
        .transitionProblemStatus(PROBLEM_ID, RESUME)
        .catch((error: unknown) => error);

      expect(raised).toBeInstanceOf(MemoryApiError);
      expect((raised as MemoryApiError).status).toBe(status);
      expect((raised as MemoryApiError).code).toBe(code);
    }
  });

  it('raises an unanswerable request as unreachable', async () => {
    const fetch: FetchLike = () => Promise.reject(new Error('synthetic'));
    const memory = createMemoryApiClient({ credential: CREDENTIAL, fetch });

    await expect(memory.transitionProblemStatus(PROBLEM_ID, RESUME)).rejects.toBeInstanceOf(
      MemoryApiUnreachableError,
    );
  });
});

describe('one call is one request', () => {
  it('sends once for a conflict', async () => {
    const { memory, calls } = answering(409, errorEnvelope('VERSION_CONFLICT'));

    await memory.transitionProblemStatus(PROBLEM_ID, RESUME).catch(() => undefined);

    expect(calls).toHaveLength(1);
  });

  it('sends once when nothing answers', async () => {
    let attempts = 0;
    const fetch: FetchLike = () => {
      attempts += 1;
      return Promise.reject(new Error('synthetic'));
    };
    const memory = createMemoryApiClient({ credential: CREDENTIAL, fetch });

    await memory.transitionProblemStatus(PROBLEM_ID, RESUME).catch(() => undefined);

    expect(attempts).toBe(1);
  });

  it('sends once for a server failure', async () => {
    const { memory, calls } = answering(500, errorEnvelope('INTERNAL_ERROR'));

    await memory.transitionProblemStatus(PROBLEM_ID, RESUME).catch(() => undefined);

    expect(calls).toHaveLength(1);
  });

  it('sends once for an answer it cannot read', async () => {
    const { memory, calls } = answering(200, { not: 'a problem' });

    await memory.transitionProblemStatus(PROBLEM_ID, RESUME).catch(() => undefined);

    expect(calls).toHaveLength(1);
  });
});
