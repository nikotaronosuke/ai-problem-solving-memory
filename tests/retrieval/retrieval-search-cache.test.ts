/**
 * What makes two searches the same search, and how long an answer lasts.
 *
 * Two things carry the weight here.
 *
 * **The key.** Every input that can change a result has to change the digest,
 * or a search will be answered with somebody else's answer — a different
 * owner's above all. And every input has to be absent from what is kept: a
 * query may legitimately contain credential-shaped text, which is safe only
 * because a query is used and discarded, and a cache is exactly the place that
 * could stop being true.
 *
 * **The clock.** Expiry is asserted at the millisecond either side of the
 * boundary against an injected clock. A test that slept would be slow, and a
 * test that slept for five minutes would not be run.
 */

import { describe, expect, it } from 'vitest';

import {
  createRetrievalSearchCache,
  RETRIEVAL_SEARCH_CACHE_MAX_ENTRIES,
  RETRIEVAL_SEARCH_CACHE_TTL_MS,
} from '../../src/app/retrieval-search-cache.js';
import type { OwnerId } from '../../src/domain/owner.js';
import type { ProblemId } from '../../src/domain/problem.js';
import type { ProjectId } from '../../src/domain/project.js';
import {
  computeRetrievalSearchCacheKey,
  copyStructuralRerankResult,
  RETRIEVAL_SEARCH_CACHE_KEY_PREFIX,
  type RetrievalSearchCacheKeyInput,
} from '../../src/domain/retrieval-search-cache.js';
import type { StructuralRerankResult } from '../../src/domain/retrieval-structural-rerank.js';
import {
  parseStructuralFeatures,
  type StructuralFeatures,
} from '../../src/domain/retrieval-summary.js';

const OWNER = 'aa000000-0000-4000-8000-000000000001' as OwnerId;
const OTHER_OWNER = 'aa000000-0000-4000-8000-000000000002' as OwnerId;
const PROBLEM = 'dd000000-0000-4000-8000-000000000001' as ProblemId;
const PROJECT = 'cc000000-0000-4000-8000-000000000001' as ProjectId;

const features = (overrides: Record<string, unknown> = {}): StructuralFeatures =>
  parseStructuralFeatures({
    schema_version: '1',
    problem_domain: 'deployment',
    symptom_patterns: ['works locally, fails once deployed'],
    suspected_boundaries: ['configuration read at build time'],
    occurrence_conditions: ['only in the deployed environment'],
    successful_directions: [],
    dead_end_directions: ['raising the timeout'],
    environment_facts: ['node 22.12.0'],
    ...overrides,
  });

const baseInput = (): RetrievalSearchCacheKeyInput => ({
  ownerId: OWNER,
  currentProblemId: PROBLEM,
  understandingFingerprint: 'retrieval-source-v1:abc123',
  lexicalText: 'deployment configuration',
  semanticText: 'the app works locally but not once deployed',
  projectId: null,
  effectiveHybridLimit: 20,
  effectiveRerankLimit: 5,
  currentFeatures: features(),
});

const key = (overrides: Partial<RetrievalSearchCacheKeyInput> = {}): string =>
  computeRetrievalSearchCacheKey({ ...baseInput(), ...overrides });

const result = (problemIds: readonly string[] = ['one']): StructuralRerankResult => ({
  status: 'USED',
  candidates: problemIds.map((name, index) => ({
    problemId: `dd000000-0000-4000-8000-${name.padStart(12, '0')}` as ProblemId,
    projectId: PROJECT,
    structuralScore: 0.5,
    hybridRank: index + 1,
    matchedDimensions: ['symptom_patterns'],
  })),
});

/** A clock a test moves by hand. */
function testClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

describe('the cache key', () => {
  it('carries its own prefix, so no other digest can be mistaken for it', () => {
    expect(key().startsWith(`${RETRIEVAL_SEARCH_CACHE_KEY_PREFIX}:`)).toBe(true);
    expect(RETRIEVAL_SEARCH_CACHE_KEY_PREFIX).toBe('retrieval-cache-v1');
  });

  it('is the same for the same search', () => {
    expect(key()).toBe(key());
  });

  const distinguishing: [string, Partial<RetrievalSearchCacheKeyInput>][] = [
    ['the owner', { ownerId: OTHER_OWNER }],
    [
      'the Problem being worked on',
      { currentProblemId: 'dd000000-0000-4000-8000-000000000009' as ProblemId },
    ],
    [
      'what the Problem is understood to be',
      { understandingFingerprint: 'retrieval-source-v1:def456' },
    ],
    ['the lexical text', { lexicalText: 'deployment config' }],
    ['the semantic text', { semanticText: 'it fails after deploying' }],
    ['a Project filter', { projectId: PROJECT }],
    ['the candidate window', { effectiveHybridLimit: 10 }],
    ['the final cut', { effectiveRerankLimit: 3 }],
    ['the problem domain', { currentFeatures: features({ problem_domain: 'runtime' }) }],
    ['a structural list', { currentFeatures: features({ dead_end_directions: ['restarting'] }) }],
    [
      'an empty list becoming non-empty',
      { currentFeatures: features({ successful_directions: ['x'] }) },
    ],
  ];

  it.each(distinguishing)('changes when %s changes', (_label, overrides) => {
    expect(key(overrides)).not.toBe(key());
  });

  it('separates owners even when everything else matches', () => {
    // The single most important property of a cache shared by a whole process.
    expect(key({ ownerId: OWNER })).not.toBe(key({ ownerId: OTHER_OWNER }));
  });

  it('distinguishes a list reordered from the same list', () => {
    // A rerank is shown these in order, so two orderings are two inputs. This
    // is the direction to be strict in: sorting here would answer one question
    // with another question's result.
    const one = features({ symptom_patterns: ['a', 'b'] });
    const other = features({ symptom_patterns: ['b', 'a'] });
    expect(key({ currentFeatures: one })).not.toBe(key({ currentFeatures: other }));
  });

  it('does not fold whitespace or case of its own accord', () => {
    // The search stages take these verbatim; inventing an equivalence here
    // would make the cache answer a question the stages would not have.
    expect(key({ lexicalText: 'Deployment' })).not.toBe(key({ lexicalText: 'deployment' }));
    expect(key({ lexicalText: 'deployment ' })).not.toBe(key({ lexicalText: 'deployment' }));
  });

  it('cannot be confused by a value that looks like a separator', () => {
    // Encoded as JSON rather than joined with a delimiter, so no value can
    // impersonate a field boundary.
    const one = key({ lexicalText: 'a', semanticText: 'b' });
    const other = key({ lexicalText: 'a","b', semanticText: '' });
    expect(one).not.toBe(other);
  });

  it('keeps no part of the search in what it produces', () => {
    const secretish = 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI-fake-Xx5Pq9R0123456789';
    const digest = key({
      lexicalText: secretish,
      semanticText: secretish,
      currentFeatures: features({ environment_facts: [secretish] }),
    });
    // A query is allowed to contain credential-shaped text because it is used
    // and discarded. A digest keeps that true.
    expect(digest.includes('Xx5Pq9R'), 'the key carried the query').toBe(false);
    expect(digest.includes('deployment'), 'the key carried the query').toBe(false);
    expect(digest).toMatch(/^retrieval-cache-v1:[0-9a-f]{64}$/);
  });
});

describe('copying a result', () => {
  it('shares nothing with what it was given', () => {
    const original = result(['one', 'two']);
    const copy = copyStructuralRerankResult(original);

    expect(copy).toEqual(original);
    expect(copy).not.toBe(original);
    expect(copy.candidates).not.toBe(original.candidates);
    expect(copy.candidates[0]).not.toBe(original.candidates[0]);
    expect(copy.candidates[0]?.matchedDimensions).not.toBe(
      original.candidates[0]?.matchedDimensions,
    );
  });
});

describe('storing and reading a search', () => {
  it('answers with what was stored', () => {
    const clock = testClock();
    const cache = createRetrievalSearchCache(clock.now);
    const stored = result(['one', 'two']);

    cache.set('k', stored);
    expect(cache.get('k')).toEqual(stored);
  });

  it('knows nothing about a search it was not given', () => {
    expect(createRetrievalSearchCache(testClock().now).get('k')).toBeUndefined();
  });

  describe('expiry', () => {
    it('answers at the last usable millisecond and not the next one', () => {
      // Written out rather than derived from the constant: a boundary compared
      // against itself moves whenever the constant does.
      expect(RETRIEVAL_SEARCH_CACHE_TTL_MS).toBe(300_000);

      const clock = testClock();
      const cache = createRetrievalSearchCache(clock.now);
      cache.set('k', result());

      clock.advance(299_999);
      expect(cache.get('k')).toBeDefined();

      clock.advance(1);
      expect(cache.get('k')).toBeUndefined();
    });

    it('does not hand out an expired answer even once', () => {
      const clock = testClock();
      const cache = createRetrievalSearchCache(clock.now);
      cache.set('k', result());
      clock.advance(300_000);

      expect(cache.get('k')).toBeUndefined();
      expect(cache.get('k')).toBeUndefined();
    });

    it('does not extend a lifetime by reading', () => {
      // Otherwise a search repeated every four minutes would be answered
      // forever from a result nobody ever recomputed.
      const clock = testClock();
      const cache = createRetrievalSearchCache(clock.now);
      cache.set('k', result());

      clock.advance(200_000);
      expect(cache.get('k')).toBeDefined();
      clock.advance(100_000);
      expect(cache.get('k')).toBeUndefined();
    });

    it('starts a fresh lifetime when the same search is stored again', () => {
      const clock = testClock();
      const cache = createRetrievalSearchCache(clock.now);
      cache.set('k', result());

      clock.advance(200_000);
      cache.set('k', result(['two']));
      clock.advance(200_000);

      expect(cache.get('k')).toBeDefined();
    });
  });

  describe('bounds', () => {
    it('holds a hundred searches', () => {
      expect(RETRIEVAL_SEARCH_CACHE_MAX_ENTRIES).toBe(100);

      const cache = createRetrievalSearchCache(testClock().now);
      for (let index = 0; index < 100; index += 1) {
        cache.set(`k${String(index)}`, result());
      }
      expect(cache.get('k0')).toBeDefined();
      expect(cache.get('k99')).toBeDefined();
    });

    it('drops the least recently used one to make room for the hundred-and-first', () => {
      const cache = createRetrievalSearchCache(testClock().now);
      for (let index = 0; index < 100; index += 1) {
        cache.set(`k${String(index)}`, result());
      }

      cache.set('k100', result());

      expect(cache.get('k0')).toBeUndefined();
      expect(cache.get('k1')).toBeDefined();
      expect(cache.get('k100')).toBeDefined();
    });

    it('counts a read as use, so a busy search is not the one evicted', () => {
      const cache = createRetrievalSearchCache(testClock().now);
      for (let index = 0; index < 100; index += 1) {
        cache.set(`k${String(index)}`, result());
      }

      // The oldest, read once, is now the newest.
      expect(cache.get('k0')).toBeDefined();
      cache.set('k100', result());

      expect(cache.get('k0')).toBeDefined();
      expect(cache.get('k1')).toBeUndefined();
    });

    it('never grows past the bound however many searches arrive', () => {
      const cache = createRetrievalSearchCache(testClock().now);
      for (let index = 0; index < 500; index += 1) {
        cache.set(`k${String(index)}`, result());
      }

      // The last hundred survive and everything before them is gone.
      expect(cache.get('k399')).toBeUndefined();
      expect(cache.get('k400')).toBeDefined();
      expect(cache.get('k499')).toBeDefined();
    });
  });

  describe('what a caller can reach', () => {
    it('is unaffected by a caller changing what it stored', () => {
      const clock = testClock();
      const cache = createRetrievalSearchCache(clock.now);
      const stored = result(['one', 'two']);

      cache.set('k', stored);
      // Nothing here is `readonly` at run time — that is a compile-time
      // courtesy, and a caller with a plain object can do all of this.
      (stored.candidates as unknown as unknown[]).length = 0;

      expect(cache.get('k')?.candidates).toHaveLength(2);
    });

    it('is unaffected by a caller changing what it was handed', () => {
      const clock = testClock();
      const cache = createRetrievalSearchCache(clock.now);
      cache.set('k', result(['one', 'two']));

      const first = cache.get('k');
      (first?.candidates as unknown as unknown[]).reverse();
      (first?.candidates[0]?.matchedDimensions as unknown as string[]).push('problem_domain');

      const second = cache.get('k');
      expect(second?.candidates.map((candidate) => candidate.hybridRank)).toEqual([1, 2]);
      expect(second?.candidates[0]?.matchedDimensions).toEqual(['symptom_patterns']);
    });

    it('hands two callers separate objects', () => {
      const cache = createRetrievalSearchCache(testClock().now);
      cache.set('k', result());

      expect(cache.get('k')).not.toBe(cache.get('k'));
    });
  });

  it('keeps two owners apart when they share one process', () => {
    const cache = createRetrievalSearchCache(testClock().now);
    const mine = key({ ownerId: OWNER });
    const theirs = key({ ownerId: OTHER_OWNER });

    cache.set(mine, result(['one']));

    expect(cache.get(mine)).toBeDefined();
    expect(cache.get(theirs)).toBeUndefined();
  });
});
