/**
 * The embedding adapter: one summary in, one vector of the declared width
 * out, and a refusal for everything else.
 */

import { describe, expect, it } from 'vitest';

import { toProviderEmbedding } from '../../src/domain/retrieval-embedding.js';
import { RetrievalProviderCallError } from '../../src/domain/retrieval-provider-failure.js';
import {
  createOpenAiEmbeddingProvider,
  createOpenAiTransport,
  OPENAI_EMBEDDING_DIMENSIONS,
  OPENAI_EMBEDDING_MODEL,
  type FetchLike,
} from '../../src/providers/openai/index.js';

const API_KEY = 'sk-test-000000000000000000000000000000000000';

const SUMMARY = 'A callback fails only after deployment because the host is fixed at build time.';

const VECTOR = Array.from({ length: OPENAI_EMBEDDING_DIMENSIONS }, (_, index) =>
  index === 0 ? 0.5 : 1 / (index + 1),
);

function embeddingsBody(overrides: Record<string, unknown> = {}) {
  return {
    object: 'list',
    data: [{ object: 'embedding', index: 0, embedding: VECTOR }],
    model: OPENAI_EMBEDDING_MODEL,
    usage: { prompt_tokens: 10, total_tokens: 10 },
    ...overrides,
  };
}

function urlOf(input: Parameters<FetchLike>[0]): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function bodyOf(init: RequestInit | undefined): string {
  return typeof init?.body === 'string' ? init.body : '';
}

/**
 * Asserts a rejection classified as the provider having answered unusably.
 *
 * The kind is asserted, not merely the class: the whole point of the P5-02c
 * correction is that `INVALID_RESPONSE` and `UNAVAILABLE` mean different things
 * one layer up, so a test that accepted either would pass for the wrong reason.
 */
async function expectInvalidResponse(call: Promise<unknown>): Promise<void> {
  await expect(call).rejects.toBeInstanceOf(RetrievalProviderCallError);
  await expect(call).rejects.toMatchObject({ failure: 'INVALID_RESPONSE' });
}

/** A provider whose transport answers with one status and an empty body. */
function providerAnswering(status: number) {
  const fetch: FetchLike = () => Promise.resolve(new Response('{}', { status }));
  return createOpenAiEmbeddingProvider(createOpenAiTransport(API_KEY, fetch));
}

function harness(answer: () => unknown) {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const fetch: FetchLike = (input, init) => {
    requests.push({ url: urlOf(input), body: JSON.parse(bodyOf(init)) as never });
    return Promise.resolve(new Response(JSON.stringify(answer()), { status: 200 }));
  };
  return {
    requests,
    provider: createOpenAiEmbeddingProvider(createOpenAiTransport(API_KEY, fetch)),
  };
}

describe('the OpenAI embedding provider', () => {
  it('declares the frozen identity, version equal to model by honest limitation', () => {
    const { provider } = harness(() => embeddingsBody());

    expect(provider.modelId).toBe('text-embedding-3-large');
    expect(provider.modelVersion).toBe('text-embedding-3-large');
    expect(provider.dimensions).toBe(1024);
    expect(OPENAI_EMBEDDING_MODEL).toBe(provider.modelId);
  });

  it('sends the normalized summary alone, with the exact model and width', async () => {
    const { requests, provider } = harness(() => embeddingsBody());

    await provider.embed({ text: SUMMARY });

    const request = requests[0];
    expect(request?.url).toBe('https://api.openai.com/v1/embeddings');
    expect(request?.body).toEqual({
      model: OPENAI_EMBEDDING_MODEL,
      input: SUMMARY,
      dimensions: OPENAI_EMBEDDING_DIMENSIONS,
      encoding_format: 'float',
    });
    // Nothing else: no keywords, no features, no identifiers — the equality
    // above is exhaustive, which is the point of asserting the whole body.
  });

  it('returns the one vector, and the domain contract accepts it', async () => {
    const { provider } = harness(() => embeddingsBody());

    const output = await provider.embed({ text: SUMMARY });

    expect(Array.isArray(output)).toBe(true);
    const embedding = toProviderEmbedding(output, provider);
    expect(embedding).toHaveLength(OPENAI_EMBEDDING_DIMENSIONS);
  });

  it('refuses a vector of the wrong width', async () => {
    const { provider } = harness(() =>
      embeddingsBody({ data: [{ embedding: VECTOR.slice(0, 512) }] }),
    );

    await expectInvalidResponse(provider.embed({ text: SUMMARY }));
  });

  it('refuses non-finite values', async () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 'nope', null]) {
      const withBad = [...VECTOR];
      withBad[3] = bad as never;
      const { provider } = harness(() => embeddingsBody({ data: [{ embedding: withBad }] }));
      await expectInvalidResponse(provider.embed({ text: SUMMARY }));
    }
  });

  it('lets the existing contract refuse a zero vector', async () => {
    const zeroes = VECTOR.map(() => 0);
    const { provider } = harness(() => embeddingsBody({ data: [{ embedding: zeroes }] }));

    // The adapter passes it — all finite, right width — and the domain
    // refuses it, which is where that rule has always lived.
    const output = await provider.embed({ text: SUMMARY });
    expect(() => toProviderEmbedding(output, provider)).toThrow();
  });

  it('refuses empty, plural or malformed data', async () => {
    for (const data of [[], [{}, {}], [{ embedding: 'not-a-list' }], 'nonsense', undefined]) {
      const { provider } = harness(() => embeddingsBody({ data }));
      await expectInvalidResponse(provider.embed({ text: SUMMARY }));
    }
  });

  it('refuses an answer echoed from some other model', async () => {
    // The identity columns are what similarity search trusts; a vector from
    // another model stored under this identity would poison the space.
    const { provider } = harness(() => embeddingsBody({ model: 'text-embedding-ada-002' }));

    await expectInvalidResponse(provider.embed({ text: SUMMARY }));
  });

  it('refuses a different identifier that merely starts with the configured one', async () => {
    // A prefix check would wave this through, and it is not this model: an
    // identifier is equal or it is another identifier. Implicit compatibility
    // is exactly the invented version information the honest-identity rule
    // refuses — if the upstream ever changes what it echoes, the contract
    // changes deliberately, against fresh official docs.
    const { provider } = harness(() =>
      embeddingsBody({ model: `${OPENAI_EMBEDDING_MODEL}-something-else` }),
    );

    await expectInvalidResponse(provider.embed({ text: SUMMARY }));
  });

  it.each([
    // Both are the provider temporarily unable to answer. Nothing is wrong with
    // the integration, so the semantic channel degrades and the search answers.
    [429, 'UNAVAILABLE'],
    [500, 'UNAVAILABLE'],
    [503, 'UNAVAILABLE'],
    // Every other refusal is the request being rejected — a bad body, a
    // rejected key, a forbidden or absent endpoint. None of them improve by
    // waiting, and a caller's search had no part in any of them.
    [400, 'UPSTREAM_REJECTED_REQUEST'],
    [401, 'UPSTREAM_REJECTED_REQUEST'],
    [403, 'UPSTREAM_REJECTED_REQUEST'],
    [404, 'UPSTREAM_REJECTED_REQUEST'],
  ])('classifies HTTP %i as %s', async (status, failure) => {
    const provider = providerAnswering(status);

    const call = provider.embed({ text: SUMMARY });
    await expect(call).rejects.toBeInstanceOf(RetrievalProviderCallError);
    await expect(call).rejects.toMatchObject({ failure });
  });

  it('classifies an unreachable provider as unavailable', async () => {
    const fetch: FetchLike = () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:443'));
    const provider = createOpenAiEmbeddingProvider(createOpenAiTransport(API_KEY, fetch));

    const call = provider.embed({ text: SUMMARY });
    await expect(call).rejects.toBeInstanceOf(RetrievalProviderCallError);
    await expect(call).rejects.toMatchObject({ failure: 'UNAVAILABLE' });
  });

  it('classifies a success whose body is not JSON as an unusable answer', async () => {
    const fetch: FetchLike = () =>
      Promise.resolve(new Response('not json at all', { status: 200 }));
    const provider = createOpenAiEmbeddingProvider(createOpenAiTransport(API_KEY, fetch));

    await expectInvalidResponse(provider.embed({ text: SUMMARY }));
  });

  it('says nothing about the provider in what it raises', async () => {
    const fetch: FetchLike = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: { message: 'Incorrect API key provided: sk-live-x' } }),
          {
            status: 401,
          },
        ),
      );
    const provider = createOpenAiEmbeddingProvider(createOpenAiTransport(API_KEY, fetch));

    const error = await provider.embed({ text: SUMMARY }).catch((raised: unknown) => raised);

    // A classified failure carries a kind chosen in this repository and nothing
    // else. The upstream message quoted a credential back; an error travels
    // into logs, so none of it may be attached.
    //
    // The stack is swept too, for everything the *provider* said. It is not
    // swept for the vendor's name: a stack trace names the source files it
    // passed through and one of them is `providers/openai/failure.ts`, which is
    // this repository's own path rather than anything the provider supplied.
    const attached = `${(error as Error).message} ${JSON.stringify(error)}`;
    const withStack = `${attached} ${String((error as Error).stack)}`;
    for (const supplied of ['sk-live-x', 'Incorrect API key', 'api.openai.com', '401']) {
      expect(`${supplied} leaked:${withStack.includes(supplied)}`).toBe(`${supplied} leaked:false`);
    }
    expect(`vendor named:${attached.toLowerCase().includes('openai')}`).toBe('vendor named:false');
    expect((error as { cause?: unknown }).cause).toBeUndefined();
    // And the whole message is the fixed sentence, not a wrapped one.
    expect((error as Error).message).toBe(
      'A retrieval provider call failed: UPSTREAM_REJECTED_REQUEST.',
    );
  });

  it('makes exactly one request per embedding', async () => {
    const { requests, provider } = harness(() => embeddingsBody());

    await provider.embed({ text: SUMMARY });

    expect(requests).toHaveLength(1);
  });
});
