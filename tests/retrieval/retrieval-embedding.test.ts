/**
 * The embedding seam, before any database is involved.
 *
 * Two pure questions. Whether a provider's declared identity is one the
 * service can build on, and whether an arbitrary value returned from outside
 * the process can be believed as a vector. The second is the one with teeth:
 * a provider is a model behind a network, and it can return a string, an
 * object, the wrong number of dimensions, a NaN, or a vector of nothing but
 * zeros — and every one of those, stored, is a row that breaks a similarity
 * query later and elsewhere.
 *
 * The zero-vector rule is backed by a measurement rather than a preference:
 * PostgreSQL stores an all-zero vector without complaint, and cosine distance
 * against one is NULL.
 */

import { describe, expect, it } from 'vitest';

import { InvalidRetrievalArtifactError, toEmbedding } from '../../src/domain/retrieval-artifact.js';
import {
  InvalidEmbeddingProviderOutputError,
  requireEmbeddingProviderIdentity,
  toProviderEmbedding,
  type EmbeddingProvider,
} from '../../src/domain/retrieval-embedding.js';

function providerWith(overrides: Partial<EmbeddingProvider> = {}): EmbeddingProvider {
  return {
    modelId: 'fixture-embedding-model',
    modelVersion: '1',
    dimensions: 3,
    embed: () => Promise.resolve([0.1, 0.2, 0.3]),
    ...overrides,
  };
}

describe('a provider’s identity', () => {
  it('is accepted when complete', () => {
    expect(() => requireEmbeddingProviderIdentity(providerWith())).not.toThrow();
  });

  it.each([
    ['a blank model id', { modelId: '   ' }],
    ['an empty model id', { modelId: '' }],
    ['a blank model version', { modelVersion: '\t' }],
  ])('is refused with %s', (_label, overrides) => {
    expect(() => requireEmbeddingProviderIdentity(providerWith(overrides))).toThrow();
  });

  it.each([
    ['zero', 0],
    ['negative', -3],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
  ])('is refused when the dimensions are %s', (_label, dimensions) => {
    // The dimension count is the one property of a model's output that can be
    // checked without understanding the output; a provider that cannot state
    // it cannot be validated against.
    expect(() => requireEmbeddingProviderIdentity(providerWith({ dimensions }))).toThrow();
  });

  it('does not quote the model strings back', () => {
    const secretish = 'API_KEY=fake-Kk1Zd8P-0123456789abcdef';
    let raised: unknown;
    try {
      requireEmbeddingProviderIdentity(providerWith({ modelId: secretish, dimensions: 0 }));
    } catch (error) {
      raised = error;
    }

    expect(raised).toBeInstanceOf(Error);
    expect((raised as Error).message.includes('Kk1Zd8P'), 'the error quoted the model id').toBe(
      false,
    );
  });
});

describe('reading what a provider returned', () => {
  const provider = providerWith({ dimensions: 3 });

  it('accepts a vector of the declared shape', () => {
    expect(toProviderEmbedding([0.5, -0.25, 0.125], provider)).toEqual([0.5, -0.25, 0.125]);
  });

  it.each([
    ['a string', 'an embedding'],
    ['null', null],
    ['an object', { vector: [1, 2, 3] }],
    ['a number', 3],
  ])('refuses %s in place of an array', (_label, output) => {
    expect(() => toProviderEmbedding(output, provider)).toThrow(
      InvalidEmbeddingProviderOutputError,
    );
  });

  it.each([
    ['one short', [0.1, 0.2]],
    ['one long', [0.1, 0.2, 0.3, 0.4]],
    ['empty', []],
  ])('refuses a vector that is %s of the declared dimensions', (_label, output) => {
    // Not truncated and not padded: a vector the model never produced must not
    // be stored, and vectors of different lengths cannot even be compared —
    // measured, a distance across dimensions is an error — so a wrong-size row
    // would be unfindable rather than merely wrong.
    expect(() => toProviderEmbedding(output, provider)).toThrow(
      InvalidEmbeddingProviderOutputError,
    );
  });

  it.each([
    ['a NaN', [0.1, Number.NaN, 0.3]],
    ['an infinity', [0.1, Number.POSITIVE_INFINITY, 0.3]],
    ['a string entry', [0.1, 'x', 0.3]],
    ['a null entry', [0.1, null, 0.3]],
  ])('refuses a vector holding %s', (_label, output) => {
    expect(() => toProviderEmbedding(output, provider)).toThrow(
      InvalidEmbeddingProviderOutputError,
    );
  });

  it.each([
    ['zeros', [0, 0, 0]],
    ['negative zeros', [-0, 0, -0]],
  ])('refuses a vector of nothing but %s', (_label, output) => {
    // Stored, this saves cleanly; queried, its cosine distance is NULL —
    // measured against the real database. A row that vanishes from or
    // corrupts every later similarity query is the worst available outcome,
    // and no real model produces a zero vector for real text.
    expect(() => toProviderEmbedding(output, provider)).toThrow(
      InvalidEmbeddingProviderOutputError,
    );
  });

  it('does not measure the values it refuses into the error', () => {
    let raised: unknown;
    try {
      toProviderEmbedding([123456.789, Number.NaN], providerWith({ dimensions: 2 }));
    } catch (error) {
      raised = error;
    }

    expect(raised).toBeInstanceOf(InvalidEmbeddingProviderOutputError);
    expect((raised as Error).message.includes('123456'), 'the error quoted a value').toBe(false);
  });
});

describe('the storage boundary behind it', () => {
  it('refuses an all-zero embedding too', () => {
    // The provider check is the first line, not the only one. Whatever path an
    // embedding takes towards storage — including a caller using the artifact
    // repository directly — a zero vector is refused at the domain.
    expect(() => toEmbedding([0, 0, 0])).toThrow(InvalidRetrievalArtifactError);
    expect(() => toEmbedding([-0, -0])).toThrow(InvalidRetrievalArtifactError);
  });

  it('still accepts an ordinary vector, negatives and all', () => {
    expect(toEmbedding([0, -0.5, 0.25])).toEqual([0, -0.5, 0.25]);
  });
});
