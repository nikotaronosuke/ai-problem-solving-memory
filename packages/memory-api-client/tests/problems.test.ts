/**
 * What `listProblems(projectId)` sends, and what it accepts back.
 *
 * The same temptations as the Project list, plus one this route has and that
 * one does not: the path names a Project, so the body can disagree with the
 * request that produced it. A Problem from another Project arriving in this
 * answer is not a Problem this caller asked about, and the thing downstream of
 * here decides what somebody is working on — so it is refused rather than
 * filtered, because filtering would leave a shorter list that looks correct.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createMemoryApiClient,
  MemoryApiArgumentError,
  MemoryApiError,
  MemoryApiProtocolError,
  MemoryApiUnreachableError,
  MEMORY_API_REQUEST_TIMEOUT_MS,
  PROBLEM_RESOURCE_FIELDS,
  type FetchLike,
} from '../src/index.js';

/** A synthetic value in the shape of a credential. Not one. */
const CREDENTIAL = 'memory_test_0000000000000000000000000000';

const PROJECT_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_PROJECT_ID = '77777777-6666-4555-8444-333333333333';

const INVESTIGATING = {
  problem_id: 'aaaaaaaa-1111-4222-8333-444444444444',
  owner_id: '99999999-8888-4777-8666-555555555555',
  project_id: PROJECT_ID,
  environment_id: 'bbbbbbbb-1111-4222-8333-444444444444',
  title: 'the build fails only on the second run',
  symptoms: 'a cached artifact is reused after it should have been invalidated',
  problem_domain: 'build',
  suspected_boundary: 'cache',
  source_ai: 'claude-code',
  status: 'INVESTIGATING',
  fix_kind: null,
  importance: true,
  confidence: 'MEDIUM',
  freshness: 'CURRENT',
  memory_read_enabled: true,
  memory_write_enabled: true,
  suppressed: false,
  version: 1,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
};

const PAUSED = {
  ...INVESTIGATING,
  problem_id: 'cccccccc-1111-4222-8333-444444444444',
  title: 'intermittent timeout against the staging database',
  status: 'PAUSED',
  problem_domain: null,
  suspected_boundary: null,
  source_ai: null,
  fix_kind: null,
  importance: false,
  version: 4,
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

describe('what reading one Problem accepts back', () => {
  it('returns the Problem the route named', async () => {
    const { memory } = answering(200, INVESTIGATING);

    await expect(memory.getProblem(INVESTIGATING.problem_id)).resolves.toEqual(INVESTIGATING);
  });

  it('refuses a body describing a different Problem', async () => {
    // The route named one Problem. A well-formed answer about another is not
    // an answer to that request — and a caller reads a Problem in order to
    // act on it, so accepting this would let a decision about A be made from
    // B's status, Project and version, with nothing downstream able to tell.
    const { memory } = answering(200, PAUSED);

    await expect(memory.getProblem(INVESTIGATING.problem_id)).rejects.toBeInstanceOf(
      MemoryApiProtocolError,
    );
  });

  it('refuses a version no record could be at', async () => {
    // A version is a write's concurrency token now. Left to pass here, a `0`
    // would travel as though it were real and be refused later as though the
    // caller had made the mistake.
    for (const version of [0, -1, 0.5]) {
      const { memory } = answering(200, { ...INVESTIGATING, version });

      await expect(memory.getProblem(INVESTIGATING.problem_id)).rejects.toBeInstanceOf(
        MemoryApiProtocolError,
      );
    }
  });

  it('accepts any version a record could be at', async () => {
    for (const version of [1, 2, 4096]) {
      const { memory } = answering(200, { ...INVESTIGATING, version });

      await expect(memory.getProblem(INVESTIGATING.problem_id)).resolves.toMatchObject({
        version,
      });
    }
  });

  it('does not ask twice for an answer it cannot read', async () => {
    const { memory, calls } = answering(200, PAUSED);

    await memory.getProblem(INVESTIGATING.problem_id).catch(() => undefined);

    expect(calls).toHaveLength(1);
  });
});

describe('what listing Problems sends', () => {
  it('reads the project’s collection with the credential in one place', async () => {
    const { calls, memory } = answering(200, { problems: [] });

    await memory.listProblems(PROJECT_ID);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`http://127.0.0.1:3000/v1/projects/${PROJECT_ID}/problems`);
    expect(calls[0]?.init?.method).toBe('GET');
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe(`Bearer ${CREDENTIAL}`);
    // A read has no body, which is the strongest form of "the credential is not
    // in the body".
    expect(calls[0]?.init?.body ?? null).toBeNull();
    expect(calls[0]?.url.includes('?')).toBe(false);
  });

  it('refuses a project id that is not one, before spending a request', async () => {
    const { calls, memory } = answering(200, { problems: [] });

    await expect(memory.listProblems('../projects')).rejects.toBeInstanceOf(MemoryApiArgumentError);
    await expect(memory.listProblems('')).rejects.toBeInstanceOf(MemoryApiArgumentError);
    await expect(memory.listProblems('not-a-uuid')).rejects.toBeInstanceOf(MemoryApiArgumentError);

    expect(calls).toHaveLength(0);
  });

  it('names the argument and never the value it rejected', async () => {
    const { memory } = answering(200, { problems: [] });

    await expect(memory.listProblems('../../etc/passwd')).rejects.toMatchObject({
      argument: 'project id',
    });

    const raised = await memory.listProblems('../../etc/passwd').catch((error: unknown) => error);
    expect((raised as Error).message.includes('etc/passwd')).toBe(false);
  });

  it('uses the ordinary read deadline rather than the search one', async () => {
    const seen: number[] = [];
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      seen.push(ms);
      return timeout(ms);
    });

    const { memory } = answering(200, { problems: [] });
    await memory.listProblems(PROJECT_ID);

    expect(seen).toEqual([MEMORY_API_REQUEST_TIMEOUT_MS]);
    spy.mockRestore();
  });

  it('still honours an explicit ceiling the caller set', async () => {
    const seen: number[] = [];
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      seen.push(ms);
      return timeout(ms);
    });

    const { fetch } = recordingFetch(() => jsonResponse(200, { problems: [] }));
    const memory = createMemoryApiClient({ credential: CREDENTIAL, fetch, timeoutMs: 1234 });
    await memory.listProblems(PROJECT_ID);

    expect(seen).toEqual([1234]);
    spy.mockRestore();
  });
});

describe('what listing Problems returns', () => {
  it('gives an empty list for a project with none, which is an answer', async () => {
    const { memory } = answering(200, { problems: [] });

    await expect(memory.listProblems(PROJECT_ID)).resolves.toEqual([]);
  });

  it('returns every Problem exactly as it arrived', async () => {
    const { memory } = answering(200, { problems: [INVESTIGATING, PAUSED] });

    await expect(memory.listProblems(PROJECT_ID)).resolves.toEqual([INVESTIGATING, PAUSED]);
  });

  it('preserves the server’s order rather than one of its own', async () => {
    const { memory } = answering(200, { problems: [PAUSED, INVESTIGATING] });

    const problems = await memory.listProblems(PROJECT_ID);

    expect(problems.map((problem) => problem.problem_id)).toEqual([
      PAUSED.problem_id,
      INVESTIGATING.problem_id,
    ]);
  });

  it('does not de-duplicate, because two rows are the server’s to explain', async () => {
    const { memory } = answering(200, { problems: [INVESTIGATING, INVESTIGATING] });

    await expect(memory.listProblems(PROJECT_ID)).resolves.toHaveLength(2);
  });
});

/** The first Problem with its status removed — malformed, and not by type. */
function withoutStatus(): unknown {
  return Object.fromEntries(Object.entries(INVESTIGATING).filter(([key]) => key !== 'status'));
}

describe('answers this contract cannot read', () => {
  it('refuses the whole list when one element is malformed', async () => {
    const { memory } = answering(200, { problems: [withoutStatus(), PAUSED] });

    await expect(memory.listProblems(PROJECT_ID)).rejects.toBeInstanceOf(MemoryApiProtocolError);
  });

  it('does not skip the unreadable element and return the rest', async () => {
    const { memory } = answering(200, { problems: [withoutStatus(), PAUSED] });

    const raised = await memory.listProblems(PROJECT_ID).catch((error: unknown) => error);

    expect(raised).toBeInstanceOf(MemoryApiProtocolError);
    expect(Array.isArray(raised)).toBe(false);
  });

  it('refuses a Problem carrying a field this contract does not describe', async () => {
    const { memory } = answering(200, {
      problems: [{ ...INVESTIGATING, escalated: true }],
    });

    await expect(memory.listProblems(PROJECT_ID)).rejects.toBeInstanceOf(MemoryApiProtocolError);
  });

  it('refuses an envelope carrying a field beside the list', async () => {
    const { memory } = answering(200, { problems: [INVESTIGATING], total: 1 });

    await expect(memory.listProblems(PROJECT_ID)).rejects.toBeInstanceOf(MemoryApiProtocolError);
  });

  it('refuses an envelope that is not the one this route returns', async () => {
    for (const body of [{ items: [] }, [INVESTIGATING], { problems: {} }, {}]) {
      const { memory } = answering(200, body);
      await expect(memory.listProblems(PROJECT_ID)).rejects.toBeInstanceOf(MemoryApiProtocolError);
    }
  });

  it('refuses a Problem belonging to a different project than the one asked about', async () => {
    const { memory } = answering(200, {
      problems: [INVESTIGATING, { ...PAUSED, project_id: OTHER_PROJECT_ID }],
    });

    await expect(memory.listProblems(PROJECT_ID)).rejects.toBeInstanceOf(MemoryApiProtocolError);
  });

  it('does not quietly drop the foreign Problem and answer with the rest', async () => {
    const { memory } = answering(200, {
      problems: [INVESTIGATING, { ...PAUSED, project_id: OTHER_PROJECT_ID }],
    });

    const raised = await memory.listProblems(PROJECT_ID).catch((error: unknown) => error);

    expect(raised).toBeInstanceOf(MemoryApiProtocolError);
  });
});

describe('refusals stay refusals', () => {
  it('raises NOT_FOUND rather than answering with an empty list', async () => {
    const { memory } = answering(404, errorEnvelope('NOT_FOUND'));

    const raised = await memory.listProblems(PROJECT_ID).catch((error: unknown) => error);

    expect(raised).toBeInstanceOf(MemoryApiError);
    expect((raised as MemoryApiError).status).toBe(404);
    expect((raised as MemoryApiError).code).toBe('NOT_FOUND');
    expect(Array.isArray(raised)).toBe(false);
  });

  it('raises on a server fault rather than answering with an empty list', async () => {
    const { memory } = answering(500, errorEnvelope('INTERNAL_ERROR'));

    await expect(memory.listProblems(PROJECT_ID)).rejects.toBeInstanceOf(MemoryApiError);
  });

  it('raises when nothing answered at all', async () => {
    const fetch: FetchLike = () => Promise.reject(new Error('connect ECONNREFUSED'));
    const memory = createMemoryApiClient({ credential: CREDENTIAL, fetch });

    await expect(memory.listProblems(PROJECT_ID)).rejects.toBeInstanceOf(MemoryApiUnreachableError);
  });
});

describe('one call is one request', () => {
  it('does not retry a transport failure', async () => {
    let attempts = 0;
    const fetch: FetchLike = () => {
      attempts += 1;
      return Promise.reject(new Error('connect ECONNREFUSED'));
    };
    const memory = createMemoryApiClient({ credential: CREDENTIAL, fetch });

    await expect(memory.listProblems(PROJECT_ID)).rejects.toBeInstanceOf(MemoryApiUnreachableError);
    expect(attempts).toBe(1);
  });

  it('does not retry a server fault', async () => {
    const { calls, memory } = answering(500, errorEnvelope('INTERNAL_ERROR'));

    await expect(memory.listProblems(PROJECT_ID)).rejects.toBeInstanceOf(MemoryApiError);
    expect(calls).toHaveLength(1);
  });

  it('does not retry a success', async () => {
    const { calls, memory } = answering(200, { problems: [INVESTIGATING] });

    await memory.listProblems(PROJECT_ID);
    expect(calls).toHaveLength(1);
  });
});

describe('the resource contract this list is checked against', () => {
  it('names every field the wire shape carries', () => {
    expect([...PROBLEM_RESOURCE_FIELDS].sort()).toEqual(Object.keys(INVESTIGATING).sort());
  });
});
