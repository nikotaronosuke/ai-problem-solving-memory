/**
 * What the transport sends, where it refuses to send it, and what its
 * failures never carry.
 *
 * No test here reaches a network. Every request is captured by an injected
 * fetch, which is also production's seam — the assertions read the request
 * production would have sent.
 *
 * Absence is asserted as booleans throughout: a failing equality assertion
 * prints both sides, and one side would be the credential or a Memory body.
 */

import { describe, expect, it } from 'vitest';

import {
  createOpenAiTransport,
  OPENAI_API_BASE_URL,
  OpenAiRequestError,
  resolveOpenAiRetrievalConfig,
  OPENAI_API_KEY_ENV,
  type FetchLike,
} from '../../src/providers/openai/index.js';

/** A synthetic value in the shape of a key. Not one. */
const API_KEY = 'sk-test-000000000000000000000000000000000000';

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

function recordingFetch(answer: () => Promise<Response> | Response) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ url: urlOf(input), init });
    return answer();
  };
  return { fetch, calls };
}

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('the OpenAI transport', () => {
  it('posts JSON to the fixed official host, and only there', async () => {
    const { fetch, calls } = recordingFetch(() => ok({ fine: true }));

    await createOpenAiTransport(API_KEY, fetch).postJson('/responses', { a: 1 });

    expect(OPENAI_API_BASE_URL).toBe('https://api.openai.com/v1');
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/responses');
    expect(calls[0]?.init?.method).toBe('POST');
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get('content-type')).toBe('application/json');
  });

  it('offers no way to point the credential at another host', () => {
    // The factory takes a key and a fetch. No base URL parameter exists, so
    // the mistake is unstateable rather than merely discouraged.
    expect(createOpenAiTransport.length).toBeLessThanOrEqual(2);
  });

  it('presents the credential as a bearer header and nowhere else', async () => {
    const { fetch, calls } = recordingFetch(() => ok({}));

    await createOpenAiTransport(API_KEY, fetch).postJson('/embeddings', { input: 'x' });

    const call = calls[0];
    const headers = new Headers(call?.init?.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${API_KEY}`);
    expect(call?.url.includes(API_KEY)).toBe(false);
    const body = typeof call?.init?.body === 'string' ? call.init.body : '';
    expect(body.includes(API_KEY)).toBe(false);
  });

  it('arms every request with an abort signal, and reports a fired one as unreachable', async () => {
    let signal: AbortSignal | undefined;
    const { fetch } = (() => {
      const inner: FetchLike = (_input, init) => {
        signal = init?.signal ?? undefined;
        return Promise.resolve(ok({}));
      };
      return { fetch: inner };
    })();

    await createOpenAiTransport(API_KEY, fetch).postJson('/responses', {});
    // The deadline exists on the request itself, so no call can hang the
    // maintenance loop whatever the network does.
    expect(signal).toBeInstanceOf(AbortSignal);

    const timedOut = new Error('The operation was aborted due to timeout');
    timedOut.name = 'TimeoutError';
    const failing: FetchLike = () => Promise.reject(timedOut);
    const error = await createOpenAiTransport(API_KEY, failing)
      .postJson('/responses', {})
      .catch((thrown: unknown) => thrown);
    expect((error as OpenAiRequestError).failure).toBe('UNREACHABLE');
  });

  it('makes exactly one request, whatever the answer', async () => {
    for (const answer of [
      () => new Response('{"error":{}}', { status: 429 }),
      () => new Response('{"error":{}}', { status: 500 }),
      () => ok({}),
      () => {
        throw new TypeError('fetch failed');
      },
    ]) {
      const { fetch, calls } = recordingFetch(answer);
      await createOpenAiTransport(API_KEY, fetch)
        .postJson('/responses', {})
        .catch(() => undefined);
      expect(calls).toHaveLength(1);
    }
  });

  it('fails closed on 429, 5xx, network failure and malformed JSON', async () => {
    const cases: readonly [() => Response, string, number | undefined][] = [
      [() => new Response('slow down', { status: 429 }), 'HTTP_ERROR', 429],
      [() => new Response('boom', { status: 500 }), 'HTTP_ERROR', 500],
      [() => new Response('not json', { status: 200 }), 'MALFORMED_RESPONSE', 200],
    ];
    for (const [answer, failure, status] of cases) {
      const { fetch } = recordingFetch(answer);
      const error = await createOpenAiTransport(API_KEY, fetch)
        .postJson('/responses', {})
        .catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(OpenAiRequestError);
      expect((error as OpenAiRequestError).failure).toBe(failure);
      expect((error as OpenAiRequestError).status).toBe(status);
    }

    const { fetch } = recordingFetch(() => {
      throw new TypeError('fetch failed: connect ECONNREFUSED');
    });
    const error = await createOpenAiTransport(API_KEY, fetch)
      .postJson('/responses', {})
      .catch((thrown: unknown) => thrown);
    expect((error as OpenAiRequestError).failure).toBe('UNREACHABLE');
  });

  it('keeps the credential and the provider body out of every failure', async () => {
    const planted = 'a-provider-error-that-quotes-things-back';
    const answers = [
      () => new Response(planted, { status: 500 }),
      () => new Response(planted, { status: 200 }),
      () => {
        throw new Error(`refused while sending ${API_KEY}`);
      },
    ];
    for (const answer of answers) {
      const { fetch } = recordingFetch(answer);
      const error = await createOpenAiTransport(API_KEY, fetch)
        .postJson('/responses', { memory: 'somebody’s problem text' })
        .catch((thrown: unknown) => thrown);

      const rendered = `${String(error)}${JSON.stringify(error)}${(error as Error).stack ?? ''}`;
      expect(rendered.includes(API_KEY)).toBe(false);
      expect(rendered.includes(planted)).toBe(false);
      expect(rendered.includes('somebody')).toBe(false);
      expect((error as Error).cause).toBeUndefined();
    }
  });
});

describe('the provider config', () => {
  it('reads exactly one variable', () => {
    expect(OPENAI_API_KEY_ENV).toBe('OPENAI_API_KEY');
  });

  it('is disabled without a usable credential, never a startup failure', () => {
    expect(resolveOpenAiRetrievalConfig({})).toEqual({ enabled: false });
    expect(resolveOpenAiRetrievalConfig({ OPENAI_API_KEY: '' })).toEqual({ enabled: false });
    expect(resolveOpenAiRetrievalConfig({ OPENAI_API_KEY: '   ' })).toEqual({ enabled: false });
  });

  it('passes a present credential through without judging its shape', () => {
    const config = resolveOpenAiRetrievalConfig({ OPENAI_API_KEY: API_KEY });
    expect(config.enabled).toBe(true);
    if (config.enabled) {
      expect(config.apiKey === API_KEY).toBe(true);
    }
  });
});
