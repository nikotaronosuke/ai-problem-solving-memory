/**
 * Semantic search before any database is involved.
 *
 * Two pure surfaces. The query resolution — shared bounds with the lexical
 * search except for the text length, whose difference is principled — and the
 * service's own gate: the one decision it makes entirely by itself is that a
 * query holding a confirmed credential is never transmitted to an embedding
 * provider. That gate is proven here with counting fakes on both sides of the
 * service, so "the provider was never called" and "the reader was never
 * called" are counted facts rather than inferences.
 *
 * Every credential fixture is synthetic.
 */

import { describe, expect, it } from 'vitest';

import {
  createRetrievalVectorSearchService,
  type VectorSearchOutcome,
} from '../../src/app/index.js';
import type { EmbeddingProvider } from '../../src/domain/retrieval-embedding.js';
import {
  DEFAULT_SEARCH_LIMIT,
  InvalidFullTextSearchError,
  MAX_SEARCH_LIMIT,
  MAX_SEARCH_TEXT_LENGTH,
  MAX_VECTOR_SEARCH_TEXT_LENGTH,
  resolveFullTextSearchQuery,
  resolveVectorSearchQuery,
} from '../../src/domain/retrieval-search.js';
import type { ProblemId } from '../../src/domain/problem.js';
import type { ProjectId } from '../../src/domain/project.js';
import type { RetrievalVectorSearchReader } from '../../src/repository/index.js';

const PROJECT = '5a0b1c2d-0000-4000-8000-000000000001' as ProjectId;
const PROBLEM = '5a0b1c2d-0000-4000-8000-000000000002' as ProblemId;

const SECRET_QUERY = 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/fakeNn4Zg9S0123456789';

function countingProvider(): EmbeddingProvider & { calls: number } {
  const provider = {
    modelId: 'fixture-embedding-model',
    modelVersion: '2',
    dimensions: 3,
    calls: 0,
    embed() {
      provider.calls += 1;
      return Promise.resolve([0.1, 0.2, 0.3]);
    },
  };
  return provider;
}

function countingReader(): RetrievalVectorSearchReader & { calls: number } {
  const reader = {
    ownerId: 'unused' as never,
    calls: 0,
    searchByVector() {
      reader.calls += 1;
      return Promise.resolve([]);
    },
  };
  return reader;
}

describe('resolving a semantic query', () => {
  it('shares the lexical filters and their defaults', () => {
    const resolved = resolveVectorSearchQuery({ text: 'a deployment failure' });

    expect(resolved.limit).toBe(DEFAULT_SEARCH_LIMIT);
    expect(resolved.projectId).toBeNull();
    expect(resolved.excludeProblemId).toBeNull();

    const narrowed = resolveVectorSearchQuery({
      text: 'a deployment failure',
      projectId: PROJECT,
      excludeProblemId: PROBLEM,
      limit: MAX_SEARCH_LIMIT,
    });
    expect(narrowed.projectId).toBe(PROJECT);
    expect(narrowed.excludeProblemId).toBe(PROBLEM);
    expect(narrowed.limit).toBe(MAX_SEARCH_LIMIT);
  });

  it.each([
    ['empty', ''],
    ['blank', '   \t\n'],
  ])('refuses %s text', (_label, text) => {
    expect(() => resolveVectorSearchQuery({ text })).toThrow(InvalidFullTextSearchError);
  });

  it('accepts up to its own bound, which is the summary bound', () => {
    // The canonical semantic query is a whole normalized summary — "find
    // memories like this Problem" — and a summary may be up to 4000. The
    // lexical bound would refuse a legitimate semantic query.
    expect(MAX_VECTOR_SEARCH_TEXT_LENGTH).toBe(4000);
    expect(
      resolveVectorSearchQuery({ text: 'a'.repeat(MAX_VECTOR_SEARCH_TEXT_LENGTH) }).text,
    ).toHaveLength(MAX_VECTOR_SEARCH_TEXT_LENGTH);
    expect(() =>
      resolveVectorSearchQuery({ text: 'a'.repeat(MAX_VECTOR_SEARCH_TEXT_LENGTH + 1) }),
    ).toThrow(InvalidFullTextSearchError);
  });

  it('leaves the lexical bound exactly where it was', () => {
    // The two bounds differ on purpose and neither leaks into the other: a
    // 1000-plus query is still refused by the lexical resolver and accepted by
    // the semantic one.
    expect(MAX_SEARCH_TEXT_LENGTH).toBe(1000);
    const long = 'a'.repeat(MAX_SEARCH_TEXT_LENGTH + 1);
    expect(() => resolveFullTextSearchQuery({ text: long })).toThrow(InvalidFullTextSearchError);
    expect(resolveVectorSearchQuery({ text: long }).text).toHaveLength(MAX_SEARCH_TEXT_LENGTH + 1);
  });

  it.each([
    ['zero', 0],
    ['past the maximum', MAX_SEARCH_LIMIT + 1],
    ['fractional', 2.5],
    ['not a number', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
  ])('refuses a limit that is %s', (_label, limit) => {
    expect(() => resolveVectorSearchQuery({ text: 'oauth', limit })).toThrow(
      InvalidFullTextSearchError,
    );
  });
});

describe('the sensitive-query gate', () => {
  it('answers with a typed outcome and calls nothing at all', async () => {
    const provider = countingProvider();
    const reader = countingReader();
    const service = createRetrievalVectorSearchService(provider, reader);

    const outcome = await service.search({ text: `find the incident about ${SECRET_QUERY}` });

    expect(outcome.kind).toBe('SENSITIVE_QUERY_NOT_EMBEDDED');
    // The two counts are the whole point: the credential was not transmitted
    // to the provider, and no search ran on its behalf either.
    expect(provider.calls).toBe(0);
    expect(reader.calls).toBe(0);
  });

  it('carries nothing but its kind', async () => {
    const service = createRetrievalVectorSearchService(countingProvider(), countingReader());

    const outcome: VectorSearchOutcome = await service.search({ text: SECRET_QUERY });

    // Not the query, not a category, not a reason: anything repeated here
    // would be a credential-bearing string travelling onward, which is the
    // exact thing the outcome exists to prevent.
    expect(Object.keys(outcome)).toEqual(['kind']);
    expect(JSON.stringify(outcome).includes('Nn4Zg9S'), 'the outcome carried the query').toBe(
      false,
    );
  });

  it('lets a query that merely talks about credentials through', async () => {
    // The same certainty line the whole system draws: suspected and status
    // prose pass, so the Memory about an expired token stays findable.
    const provider = countingProvider();
    const reader = countingReader();
    const service = createRetrievalVectorSearchService(provider, reader);

    const outcome = await service.search({ text: 'the token expired during deployment' });

    expect(outcome.kind).toBe('CANDIDATES');
    expect(provider.calls).toBe(1);
    expect(reader.calls).toBe(1);
  });

  it('refuses construction on a provider with a broken identity', () => {
    expect(() =>
      createRetrievalVectorSearchService(
        { ...countingProvider(), dimensions: 0 },
        countingReader(),
      ),
    ).toThrow();
  });
});
