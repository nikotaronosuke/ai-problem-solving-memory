/**
 * What `listProjects()` sends, and what it accepts back.
 *
 * The list envelope is where a client is tempted to be helpful: skip the element
 * it cannot read, sort the result, drop a field it does not need. Each of those
 * makes a Project that exists look like one that does not, so each of them is
 * tested for and refused.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createMemoryApiClient,
  MemoryApiError,
  MemoryApiProtocolError,
  MemoryApiUnreachableError,
  MEMORY_API_REQUEST_TIMEOUT_MS,
  PROJECT_RESOURCE_FIELDS,
  type FetchLike,
} from '../src/index.js';

/** A synthetic value in the shape of a credential. Not one. */
const CREDENTIAL = 'memory_test_0000000000000000000000000000';

const FIRST = {
  project_id: '11111111-2222-4333-8444-555555555555',
  owner_id: '99999999-8888-4777-8666-555555555555',
  project_name: 'widget',
  repo: 'github.com/acme/widget',
  platform: 'typescript',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
};

const SECOND = {
  ...FIRST,
  project_id: '22222222-3333-4444-8555-666666666666',
  project_name: 'gadget',
  repo: null,
  platform: null,
  created_at: '2026-02-01T00:00:00.000Z',
  updated_at: '2026-02-01T00:00:00.000Z',
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

describe('what listing Projects sends', () => {
  it('reads the collection with the credential in one place', async () => {
    const { calls, memory } = answering(200, { projects: [] });

    await memory.listProjects();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://127.0.0.1:3000/v1/projects');
    expect(calls[0]?.init?.method).toBe('GET');
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe(`Bearer ${CREDENTIAL}`);
    // A read has no body, which is the strongest form of "the credential is not
    // in the body".
    expect(calls[0]?.init?.body ?? null).toBeNull();
    expect(calls[0]?.url.includes('?')).toBe(false);
  });

  it('sends no content type, because it sends nothing', async () => {
    const { calls, memory } = answering(200, { projects: [] });

    await memory.listProjects();

    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers['content-type']).toBeUndefined();
    expect(headers['accept']).toBe('application/json');
  });

  it('takes the ordinary ceiling rather than the search one', async () => {
    // Watching the one call that makes a request finite, the same way the search
    // suite does — a five-minute ceiling here would be a read waiting for a
    // provider that this route never calls.
    const deadlines: number[] = [];
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      deadlines.push(ms);
      return new AbortController().signal;
    });
    try {
      const { memory } = answering(200, { projects: [] });
      await memory.listProjects();
    } finally {
      spy.mockRestore();
    }

    expect(deadlines).toEqual([MEMORY_API_REQUEST_TIMEOUT_MS]);
  });

  it('makes exactly one request, whatever comes back', async () => {
    for (const answer of [
      () => jsonResponse(200, { projects: [FIRST] }),
      () => jsonResponse(401, errorEnvelope('UNAUTHENTICATED')),
      () => jsonResponse(200, { projects: 'nonsense' }),
      () => new Response('nope', { status: 200 }),
    ]) {
      const { fetch, calls } = recordingFetch(answer);
      await createMemoryApiClient({ credential: CREDENTIAL, fetch })
        .listProjects()
        .catch(() => undefined);

      expect(calls).toHaveLength(1);
    }
  });
});

describe('what listing Projects returns', () => {
  it('returns the Projects exactly as they arrived, in the order sent', async () => {
    // Given in an order no sort would produce: `widget` before `gadget` by name,
    // and the older `created_at` first. The first version of this test happened
    // to list them in name order, and a mutation that sorted by name survived —
    // an order fixture has to contradict the orders it is ruling out.
    const { memory } = answering(200, { projects: [FIRST, SECOND] });

    const projects = await memory.listProjects();

    // Whole equality and the server's order. The server orders deterministically
    // — `created_at` then id — and a client that re-sorted would be answering a
    // question nobody asked.
    expect(projects).toEqual([FIRST, SECOND]);
    expect(projects.map((entry) => entry.project_name)).toEqual(['widget', 'gadget']);
  });

  it('returns an empty list as an answer', async () => {
    const { memory } = answering(200, { projects: [] });

    expect(await memory.listProjects()).toEqual([]);
  });

  it('keeps nulls rather than dropping the fields', async () => {
    const { memory } = answering(200, { projects: [SECOND] });

    const projects = await memory.listProjects();

    // "Nobody recorded a repository" and "this contract has no repo field" are
    // different statements, and only one of them is true.
    expect(Object.keys(projects[0] ?? {}).sort()).toEqual([...PROJECT_RESOURCE_FIELDS].sort());
    expect(projects[0]?.repo).toBeNull();
    expect(projects[0]?.platform).toBeNull();
  });
});

describe('an answer this contract cannot read', () => {
  it.each([
    ['a body that is not the envelope', { items: [] }],
    ['an envelope with a second field', { projects: [], total: 0 }],
    ['projects that are not a list', { projects: {} }],
    ['a Project missing a field', { projects: [{ ...FIRST, updated_at: undefined }] }],
    ['a Project with a field nobody has heard of', { projects: [{ ...FIRST, archived: false }] }],
    ['a Project whose id is not a string', { projects: [{ ...FIRST, project_id: 7 }] }],
    ['a Project whose repo is neither text nor null', { projects: [{ ...FIRST, repo: 7 }] }],
    ['a Project that is not an object', { projects: ['widget'] }],
  ])('refuses %s', async (_case, body) => {
    const { memory } = answering(200, body);

    const error = await memory.listProjects().catch((raised: unknown) => raised);

    expect(error).toBeInstanceOf(MemoryApiProtocolError);
    expect((error as MemoryApiProtocolError).failure).toBe('RESOURCE_MALFORMED');
  });

  it('refuses the whole answer rather than skipping the unreadable Project', async () => {
    const { memory } = answering(200, { projects: [FIRST, { ...SECOND, project_name: 7 }] });

    // Skipping it would report an owner who does not have that Project, and the
    // next thing that happens is a Project created because none was found.
    await expect(memory.listProjects()).rejects.toBeInstanceOf(MemoryApiProtocolError);
  });

  it('keeps the body it could not read out of what it raises', async () => {
    const planted = 'plantedprojectmarker-Zx9Q';
    const { memory } = answering(200, { projects: [{ ...FIRST, secret_field: planted }] });

    const error = await memory.listProjects().catch((raised: unknown) => raised);

    const serialised = `${(error as Error).message} ${JSON.stringify(error)}`;
    expect(`leaked:${serialised.includes(planted)}`).toBe('leaked:false');
  });
});

describe('when the Memory refuses or says nothing', () => {
  it.each([
    [401, 'UNAUTHENTICATED'],
    [500, 'INTERNAL_ERROR'],
  ])('raises a %i as the refusal it is', async (status, code) => {
    const { memory } = answering(status, errorEnvelope(code));

    const error = await memory.listProjects().catch((raised: unknown) => raised);

    expect(error).toBeInstanceOf(MemoryApiError);
    expect((error as MemoryApiError).code).toBe(code);
  });

  it('raises rather than returning an empty list when it cannot be reached', async () => {
    const fetch: FetchLike = () => Promise.reject(new Error('connect ECONNREFUSED'));

    // An empty list would say "this owner has no Projects", which would lead
    // straight to a Project being created because none was found.
    await expect(
      createMemoryApiClient({ credential: CREDENTIAL, fetch }).listProjects(),
    ).rejects.toBeInstanceOf(MemoryApiUnreachableError);
  });
});
