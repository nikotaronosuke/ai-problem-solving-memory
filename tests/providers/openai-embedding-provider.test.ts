/**
 * The embedding adapter: one summary in, one vector of the declared width
 * out, and a refusal for everything else.
 */

import { describe, expect, it } from 'vitest';

import { toProviderEmbedding } from '../../src/domain/retrieval-embedding.js';
import {
  createOpenAiEmbeddingProvider,
  createOpenAiTransport,
  OpenAiRequestError,
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

    await expect(provider.embed({ text: SUMMARY })).rejects.toBeInstanceOf(OpenAiRequestError);
  });

  it('refuses non-finite values', async () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 'nope', null]) {
      const withBad = [...VECTOR];
      withBad[3] = bad as never;
      const { provider } = harness(() => embeddingsBody({ data: [{ embedding: withBad }] }));
      await expect(provider.embed({ text: SUMMARY })).rejects.toBeInstanceOf(OpenAiRequestError);
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
      await expect(provider.embed({ text: SUMMARY })).rejects.toBeInstanceOf(OpenAiRequestError);
    }
  });

  it('refuses an answer echoed from some other model', async () => {
    // The identity columns are what similarity search trusts; a vector from
    // another model stored under this identity would poison the space.
    const { provider } = harness(() => embeddingsBody({ model: 'text-embedding-ada-002' }));

    await expect(provider.embed({ text: SUMMARY })).rejects.toBeInstanceOf(OpenAiRequestError);
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

    await expect(provider.embed({ text: SUMMARY })).rejects.toBeInstanceOf(OpenAiRequestError);
  });

  it('makes exactly one request per embedding', async () => {
    const { requests, provider } = harness(() => embeddingsBody());

    await provider.embed({ text: SUMMARY });

    expect(requests).toHaveLength(1);
  });
});
