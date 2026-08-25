/**
 * The provider composition boundary: a whole stack or nothing, and never the
 * credential back out.
 */

import { describe, expect, it } from 'vitest';

import { createConfiguredRetrievalProviders } from '../../src/providers/index.js';
import type { FetchLike } from '../../src/providers/openai/index.js';

const API_KEY = 'sk-test-000000000000000000000000000000000000';

describe('the configured retrieval providers', () => {
  it('is disabled without a credential, and constructs nothing', () => {
    let touched = 0;
    const fetch: FetchLike = () => {
      touched += 1;
      return Promise.reject(new Error('must not be called'));
    };

    for (const environment of [{}, { OPENAI_API_KEY: '' }, { OPENAI_API_KEY: '  ' }]) {
      const configured = createConfiguredRetrievalProviders(environment, fetch);
      expect(configured.enabled).toBe(false);
      // Nothing vendor-shaped exists on the disabled answer — no provider,
      // no profile, nothing that could hold a transport.
      expect(Object.keys(configured)).toEqual(['enabled']);
    }
    expect(touched).toBe(0);
  });

  it('builds the whole stack from one credential', () => {
    const configured = createConfiguredRetrievalProviders({ OPENAI_API_KEY: API_KEY });

    expect(configured.enabled).toBe(true);
    if (!configured.enabled) {
      return;
    }
    expect(typeof configured.summaryGenerator.generate).toBe('function');
    expect(typeof configured.embeddingProvider.embed).toBe('function');
    expect(typeof configured.structuralReranker.rerank).toBe('function');
  });

  it('shares one transport: all three ports reach the same host through the same fetch', async () => {
    const urls: string[] = [];
    const fetch: FetchLike = (input) => {
      urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return Promise.resolve(new Response('{}', { status: 500 }));
    };
    const configured = createConfiguredRetrievalProviders({ OPENAI_API_KEY: API_KEY }, fetch);
    expect(configured.enabled).toBe(true);
    if (!configured.enabled) {
      return;
    }

    await configured.summaryGenerator.generate({ source: '{}' }).catch(() => undefined);
    await configured.embeddingProvider.embed({ text: 'x' }).catch(() => undefined);
    await configured.structuralReranker
      .rerank({ current: {} as never, candidates: [] })
      .catch(() => undefined);

    expect(urls).toHaveLength(3);
    for (const url of urls) {
      expect(url.startsWith('https://api.openai.com/v1/')).toBe(true);
    }
  });

  it('derives the profile from the actual providers', () => {
    const configured = createConfiguredRetrievalProviders({ OPENAI_API_KEY: API_KEY });
    expect(configured.enabled).toBe(true);
    if (!configured.enabled) {
      return;
    }

    expect(configured.generationProfile).toEqual({
      summaryGeneratorId: configured.summaryGenerator.generatorId,
      summaryGeneratorVersion: configured.summaryGenerator.generatorVersion,
      semantic: {
        embeddingModel: configured.embeddingProvider.modelId,
        embeddingModelVersion: configured.embeddingProvider.modelVersion,
        embeddingDimensions: configured.embeddingProvider.dimensions,
      },
    });
  });

  it('does not hand the credential back', () => {
    const configured = createConfiguredRetrievalProviders({ OPENAI_API_KEY: API_KEY });

    // Serialised whole: the key exists inside a closure the transport holds,
    // and nowhere a caller can read.
    expect(JSON.stringify(configured).includes(API_KEY)).toBe(false);
  });
});
