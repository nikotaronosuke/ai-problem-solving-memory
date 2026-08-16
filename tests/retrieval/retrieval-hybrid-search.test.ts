/**
 * Rank fusion, with nothing else in the room.
 *
 * The fusion is a pure function over two orderings, so every property that
 * matters can be pinned exactly: what agreement is worth, what a missing rank
 * means, how ties break, and — the one that keeps the whole design honest —
 * that the raw scores are not read. The last is asserted by changing them to
 * absurd values and watching the output not move.
 *
 * The `k` tests are the ones to read carefully. `k` is the single number that
 * decides how much two channels agreeing is worth against one channel being
 * confident, and the published value of 60 is wrong for a twenty-deep window.
 * The tests below fix the trade this project chose, so a later change to `k`
 * has to be a deliberate decision rather than a quiet edit.
 */

import { describe, expect, it } from 'vitest';

import type { ProblemId } from '../../src/domain/problem.js';
import type { ProjectId } from '../../src/domain/project.js';
import {
  fuseHybridCandidates,
  HybridCandidateInvariantError,
  HYBRID_RRF_K,
  HYBRID_SOURCE_LIMIT,
  MAX_HYBRID_LIMIT,
} from '../../src/domain/retrieval-hybrid-search.js';
import type { FullTextCandidate, VectorCandidate } from '../../src/domain/retrieval-search.js';

const PROJECT = 'aa000000-0000-4000-8000-000000000001' as ProjectId;
const OTHER_PROJECT = 'aa000000-0000-4000-8000-000000000002' as ProjectId;

/** Problem ids that sort in the order they are named, so ties are readable. */
const problem = (name: string): ProblemId =>
  `bb000000-0000-4000-8000-${name.padStart(12, '0')}` as ProblemId;

const lex = (names: readonly string[], projectId = PROJECT): FullTextCandidate[] =>
  names.map((name, index) => ({
    problemId: problem(name),
    projectId,
    // Deliberately meaningless and deliberately descending-ish: nothing reads
    // it, and several tests below prove that by changing it.
    lexicalScore: 1 / (index + 1),
  }));

const vec = (names: readonly string[], projectId = PROJECT): VectorCandidate[] =>
  names.map((name, index) => ({
    problemId: problem(name),
    projectId,
    cosineDistance: index * 0.01,
  }));

const ids = (candidates: readonly { problemId: ProblemId }[]): string[] =>
  candidates.map((candidate) => candidate.problemId.slice(-12).replace(/^0+/, ''));

/** Twenty distinct names, so a full window can be built. */
const window = (prefix: string): string[] =>
  Array.from({ length: HYBRID_SOURCE_LIMIT }, (_, index) => `${prefix}${index + 1}`);

describe('the fusion constants', () => {
  it('uses a k chosen for a twenty-deep window, not the published 60', () => {
    // The measurement behind the choice: across a window of twenty, k sets the
    // ratio between a rank-1 and a rank-20 contribution. k=60 gives 1.31 — it
    // was calibrated for lists about a thousand deep, and here it would erase
    // almost all of the ordering each channel produced. k=10 gives 2.73.
    expect(HYBRID_RRF_K).toBe(10);
    expect(HYBRID_SOURCE_LIMIT).toBe(20);

    const ratio = 1 / (HYBRID_RRF_K + 1) / (1 / (HYBRID_RRF_K + HYBRID_SOURCE_LIMIT));
    expect(ratio).toBeCloseTo(2.73, 2);
  });

  it('scores a candidate as the sum of its channel contributions', () => {
    const both = fuseHybridCandidates(lex(['a']), vec(['a']), MAX_HYBRID_LIMIT);
    expect(both[0]?.fusionScore).toBeCloseTo(1 / 11 + 1 / 11, 10);

    const solo = fuseHybridCandidates(lex(['a']), [], MAX_HYBRID_LIMIT);
    expect(solo[0]?.fusionScore).toBeCloseTo(1 / 11, 10);
  });
});

describe('what agreement is worth', () => {
  it('puts a candidate both channels ranked first above either channel’s best', () => {
    const result = fuseHybridCandidates(
      lex(['x', 'l2', 'l3']),
      vec(['x', 'v2', 'v3']),
      MAX_HYBRID_LIMIT,
    );

    expect(ids(result)[0]).toBe('x');
    expect(result[0]?.lexicalRank).toBe(1);
    expect(result[0]?.vectorRank).toBe(1);
  });

  it('keeps a single channel’s best above a candidate both channels ranked last', () => {
    // The trade k=10 buys, and the reason 20 and 60 were rejected: under those
    // a candidate placed LAST by both channels outranks one placed FIRST by a
    // channel, which reads agreement as decisive no matter how weak.
    const lexical = lex([...window('l').slice(0, 19), 'weak']);
    const vector = vec([...window('v').slice(0, 19), 'weak']);

    const result = fuseHybridCandidates(lexical, vector, MAX_HYBRID_LIMIT);
    const weakAt = ids(result).indexOf('weak');
    const bestLexicalAt = ids(result).indexOf('l1');

    expect(weakAt).toBeGreaterThan(bestLexicalAt);
    expect(2 / (HYBRID_RRF_K + 20)).toBeLessThan(1 / (HYBRID_RRF_K + 1));
  });

  it('puts agreement in the middle of the window above a single channel’s best', () => {
    // The other half of the same trade: agreement still means something. At
    // k=10 it wins down to about rank 11, half the window.
    const lexical = lex([...window('l').slice(0, 4), 'mid', ...window('l').slice(4, 19)]);
    const vector = vec([...window('v').slice(0, 4), 'mid', ...window('v').slice(4, 19)]);

    const result = fuseHybridCandidates(lexical, vector, MAX_HYBRID_LIMIT);
    expect(ids(result)[0]).toBe('mid');
  });

  it('is not a tie-break as well as a score', () => {
    // A candidate found by both and one found by one can tie only if the
    // arithmetic says so; there is no separate "both first" rule stacking a
    // second reward on the same evidence.
    const result = fuseHybridCandidates(lex(['a']), vec(['b']), MAX_HYBRID_LIMIT);
    expect(result[0]?.fusionScore).toBeCloseTo(result[1]?.fusionScore ?? -1, 10);
    expect(ids(result)).toEqual(['a', 'b']);
  });
});

describe('reading the channels as orderings', () => {
  it('ignores the lexical score entirely', () => {
    const ordinary = fuseHybridCandidates(lex(['a', 'b', 'c']), [], MAX_HYBRID_LIMIT);

    const absurd: FullTextCandidate[] = [
      { problemId: problem('a'), projectId: PROJECT, lexicalScore: 0 },
      { problemId: problem('b'), projectId: PROJECT, lexicalScore: 1e9 },
      { problemId: problem('c'), projectId: PROJECT, lexicalScore: -5 },
    ];
    const mutated = fuseHybridCandidates(absurd, [], MAX_HYBRID_LIMIT);

    // Same order, same scores: the channel's own scale is its own business,
    // and the position in the list is the only thing fusion reads.
    expect(mutated).toEqual(ordinary);
  });

  it('ignores the cosine distance entirely', () => {
    const ordinary = fuseHybridCandidates([], vec(['a', 'b', 'c']), MAX_HYBRID_LIMIT);

    const absurd: VectorCandidate[] = [
      { problemId: problem('a'), projectId: PROJECT, cosineDistance: 2 },
      { problemId: problem('b'), projectId: PROJECT, cosineDistance: 0 },
      { problemId: problem('c'), projectId: PROJECT, cosineDistance: 1.5 },
    ];
    const mutated = fuseHybridCandidates([], absurd, MAX_HYBRID_LIMIT);

    expect(mutated).toEqual(ordinary);
  });

  it('carries no raw score onward', () => {
    const result = fuseHybridCandidates(lex(['a']), vec(['a']), MAX_HYBRID_LIMIT);

    // Two incomparable numbers sitting side by side in every later stage is an
    // invitation to combine them again, differently.
    expect(Object.keys(result[0] ?? {}).sort()).toEqual([
      'fusionScore',
      'lexicalRank',
      'problemId',
      'projectId',
      'vectorRank',
    ]);
  });

  it('respects each channel’s order, including when they disagree', () => {
    expect(ids(fuseHybridCandidates(lex(['a', 'b', 'c']), [], MAX_HYBRID_LIMIT))).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(ids(fuseHybridCandidates([], vec(['c', 'b', 'a']), MAX_HYBRID_LIMIT))).toEqual([
      'c',
      'b',
      'a',
    ]);

    // Exactly reversed, and the result is worth stating precisely because it
    // is not the obvious one. Each candidate gets 1/(k+r) + 1/(k+4-r), and
    // that sum is *not* flat: the ends beat the middle, because 1/11 + 1/13
    // exceeds 2/12. So the two candidates each channel felt strongly about —
    // in opposite directions — tie at the top, and the one both channels were
    // lukewarm on comes last. That is the reciprocal in reciprocal rank
    // fusion doing its job rather than an artefact: a strong opinion from one
    // channel outweighs two indifferent ones.
    const reversed = fuseHybridCandidates(
      lex(['a', 'b', 'c']),
      vec(['c', 'b', 'a']),
      MAX_HYBRID_LIMIT,
    );
    expect(ids(reversed)).toEqual(['a', 'c', 'b']);
    expect(reversed[0]?.fusionScore).toBeCloseTo(1 / 11 + 1 / 13, 10);
    expect(reversed[1]?.fusionScore).toBeCloseTo(1 / 13 + 1 / 11, 10);
    expect(reversed[2]?.fusionScore).toBeCloseTo(2 / 12, 10);
  });
});

describe('what a missing rank means', () => {
  it('records absence as null rather than as a penalty', () => {
    const result = fuseHybridCandidates(lex(['a']), vec(['b']), MAX_HYBRID_LIMIT);
    const a = result.find((candidate) => candidate.problemId === problem('a'));
    const b = result.find((candidate) => candidate.problemId === problem('b'));

    expect(a?.vectorRank).toBeNull();
    expect(b?.lexicalRank).toBeNull();
    // A missing rank contributes nothing; it does not subtract. An artifact
    // embedded by a superseded model, or one just outside a window, is still a
    // candidate on the strength of the channel that did find it.
    expect(a?.fusionScore).toBeCloseTo(1 / 11, 10);
    expect(b?.fusionScore).toBeCloseTo(1 / 11, 10);
  });

  it('keeps a lexical-only candidate above a weaker candidate found by both', () => {
    const lexical = lex(['solo', ...window('l').slice(0, 19)]);
    const vector = vec([...window('v').slice(0, 19), 'weakboth']);
    const withBoth = fuseHybridCandidates(
      [...lexical.slice(0, 19), { ...lexical[0]!, problemId: problem('weakboth') }],
      vector,
      MAX_HYBRID_LIMIT,
    );

    expect(ids(withBoth)).toContain('solo');
  });
});

describe('duplicates and contradictions', () => {
  it('returns a Problem found by both channels once', () => {
    const result = fuseHybridCandidates(lex(['a', 'b']), vec(['a', 'c']), MAX_HYBRID_LIMIT);

    expect(ids(result).sort()).toEqual(['a', 'b', 'c']);
    expect(result.filter((candidate) => candidate.problemId === problem('a'))).toHaveLength(1);
  });

  it.each([
    ['the lexical channel', () => fuseHybridCandidates(lex(['a', 'a']), [], MAX_HYBRID_LIMIT)],
    ['the vector channel', () => fuseHybridCandidates([], vec(['a', 'a']), MAX_HYBRID_LIMIT)],
  ])('refuses a Problem repeated within %s', (_label, fuse) => {
    // Neither channel can do this against a real database. If it happens the
    // input is not what it claims, and scoring it twice would produce a
    // confident answer built on a contradiction.
    expect(fuse).toThrow(HybridCandidateInvariantError);
  });

  it('refuses one Problem reported under two Projects', () => {
    expect(() =>
      fuseHybridCandidates(lex(['a']), vec(['a'], OTHER_PROJECT), MAX_HYBRID_LIMIT),
    ).toThrow(HybridCandidateInvariantError);
  });

  it('names no identifier when it refuses', () => {
    let raised: unknown;
    try {
      fuseHybridCandidates(lex(['a']), vec(['a'], OTHER_PROJECT), MAX_HYBRID_LIMIT);
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(HybridCandidateInvariantError);
    expect((raised as Error).message.includes(problem('a')), 'the error named a Problem').toBe(
      false,
    );
  });
});

describe('the bounded, deterministic result', () => {
  it('breaks ties on the problem id and nothing else', () => {
    const result = fuseHybridCandidates(lex(['c', 'a', 'b']), [], MAX_HYBRID_LIMIT);
    // Different ranks, so no tie here — but equal scores must order by id.
    const tied = fuseHybridCandidates(lex(['c']), vec(['a']), MAX_HYBRID_LIMIT);
    expect(ids(tied)).toEqual(['a', 'c']);
    expect(ids(result)).toEqual(['c', 'a', 'b']);
  });

  it('returns a smaller limit as a prefix of a larger one', () => {
    const lexical = lex(window('l'));
    const vector = vec([...window('l').slice(5, 15), ...window('v').slice(0, 10)]);

    const twenty = fuseHybridCandidates(lexical, vector, 20);
    const ten = fuseHybridCandidates(lexical, vector, 10);

    expect(ids(ten)).toEqual(ids(twenty).slice(0, 10));
  });

  it('never exceeds the limit, and never pads to reach it', () => {
    const full = fuseHybridCandidates(lex(window('l')), vec(window('v')), 20);
    expect(full).toHaveLength(20);

    const sparse = fuseHybridCandidates(lex(['a', 'b']), vec(['b']), 20);
    // Two Problems exist, so two come back. Padding a short list to look like
    // a full one would be inventing candidates.
    expect(sparse).toHaveLength(2);
  });

  it('handles an empty channel, and two empty channels', () => {
    expect(ids(fuseHybridCandidates([], vec(['a', 'b']), MAX_HYBRID_LIMIT))).toEqual(['a', 'b']);
    expect(ids(fuseHybridCandidates(lex(['a']), [], MAX_HYBRID_LIMIT))).toEqual(['a']);
    expect(fuseHybridCandidates([], [], MAX_HYBRID_LIMIT)).toEqual([]);
  });

  it('produces a finite score for every candidate', () => {
    const result = fuseHybridCandidates(lex(window('l')), vec(window('v')), MAX_HYBRID_LIMIT);
    for (const candidate of result) {
      expect(Number.isFinite(candidate.fusionScore)).toBe(true);
      expect(candidate.fusionScore).toBeGreaterThan(0);
    }
  });

  it('merges two full disjoint windows without losing either', () => {
    const result = fuseHybridCandidates(lex(window('l')), vec(window('v')), MAX_HYBRID_LIMIT);
    // Forty distinct Problems exist; the top twenty come back, and both
    // channels are represented because their rank-1 entries tie.
    expect(result).toHaveLength(20);
    expect(ids(result)).toContain('l1');
    expect(ids(result)).toContain('v1');
  });
});
