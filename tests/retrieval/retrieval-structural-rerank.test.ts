/**
 * The pure half of structural reranking: what a request must look like, what a
 * reranker's answer must look like, and how judged candidates are ordered.
 *
 * The output parser carries most of the weight, and one rule in it is worth
 * reading closely. A reranker must return every candidate it was given, exactly
 * once. Allowing omissions would put a hidden threshold inside the model — this
 * stage deliberately has none, so that a candidate with no structural
 * similarity is ranked last rather than made to disappear, and a model quietly
 * dropping candidates would take that decision somewhere nobody can see it.
 * Cutting to a handful is this code's job.
 *
 * What none of this establishes is whether a real model judges structure well.
 * A scripted reranker returns whatever a test tells it to. Semantic quality is
 * measured against evaluation fixtures, later.
 */

import { describe, expect, it } from 'vitest';

import type { ProblemId } from '../../src/domain/problem.js';
import type { ProjectId } from '../../src/domain/project.js';
import type { HybridCandidate } from '../../src/domain/retrieval-hybrid-search.js';
import {
  DEFAULT_STRUCTURAL_RERANK_LIMIT,
  InvalidStructuralRerankError,
  InvalidStructuralRerankerOutputError,
  MAX_STRUCTURAL_RERANK_CANDIDATES,
  MAX_STRUCTURAL_RERANK_LIMIT,
  MIN_STRUCTURAL_RERANK_LIMIT,
  orderStructuralCandidates,
  parseStructuralRerankerOutput,
  resolveStructuralRerankRequest,
  STRUCTURAL_COMPARISON_DIMENSIONS,
  type StructuralCandidate,
  type StructuralRerankRequest,
} from '../../src/domain/retrieval-structural-rerank.js';
import {
  parseStructuralFeatures,
  STRUCTURAL_FEATURE_LISTS,
  type StructuralFeatures,
} from '../../src/domain/retrieval-summary.js';

const PROJECT = 'cc000000-0000-4000-8000-000000000001' as ProjectId;

const problem = (name: string): ProblemId =>
  `dd000000-0000-4000-8000-${name.padStart(12, '0')}` as ProblemId;

/** A valid v1 profile as plain data, so a test can spoil one field of it. */
function rawFeatures(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: '1',
    problem_domain: 'deployment',
    symptom_patterns: ['works locally, fails once deployed'],
    suspected_boundaries: ['configuration read at build time'],
    occurrence_conditions: ['only in the deployed environment'],
    successful_directions: [],
    dead_end_directions: ['raising the timeout'],
    environment_facts: ['node 22.12.0'],
    ...overrides,
  };
}

const features = (overrides: Record<string, unknown> = {}): StructuralFeatures =>
  parseStructuralFeatures(rawFeatures(overrides));

const candidate = (name: string, index: number): HybridCandidate => ({
  problemId: problem(name),
  projectId: PROJECT,
  fusionScore: 1 / (10 + index + 1),
  lexicalRank: index + 1,
  vectorRank: null,
});

const request = (overrides: Partial<StructuralRerankRequest> = {}): StructuralRerankRequest => ({
  currentFeatures: features(),
  candidates: [candidate('a', 0), candidate('b', 1)],
  ...overrides,
});

describe('the comparison dimensions', () => {
  it('are the seven similarity factors, and exclude the schema version', () => {
    // The schema version says which shape the object is in. That is a fact for
    // the parser, not something two Problems can be alike in.
    expect([...STRUCTURAL_COMPARISON_DIMENSIONS]).toEqual([
      'problem_domain',
      ...STRUCTURAL_FEATURE_LISTS,
    ]);
    expect(STRUCTURAL_COMPARISON_DIMENSIONS).toHaveLength(7);
    expect((STRUCTURAL_COMPARISON_DIMENSIONS as readonly string[]).includes('schema_version')).toBe(
      false,
    );
  });
});

describe('the shared structural parser', () => {
  it('accepts a valid v1 profile: eight keys, six of them lists', () => {
    const parsed = features();
    expect(Object.keys(parsed).sort()).toEqual(
      ['schema_version', 'problem_domain', ...STRUCTURAL_FEATURE_LISTS].sort(),
    );
    expect(Object.keys(parsed)).toHaveLength(8);
    expect(STRUCTURAL_FEATURE_LISTS).toHaveLength(6);
  });

  const badProfiles: [string, unknown][] = [
    ['not an object', 'a profile'],
    ['missing a field', { schema_version: '1', problem_domain: null }],
    ['carrying an unknown field', rawFeatures({ extra: 'something' })],
    ['built for a schema this code does not produce', rawFeatures({ schema_version: '2' })],
    ['holding a list that is null', rawFeatures({ symptom_patterns: null })],
    ['holding a list of something other than text', rawFeatures({ symptom_patterns: [7] })],
  ];

  it.each(badProfiles)('refuses a profile %s', (_label, value) => {
    expect(() => parseStructuralFeatures(value)).toThrow();
  });

  it('does not apply the generation-time provenance gate', () => {
    // The parser validates shape. Whether a summary may *claim* a successful
    // direction depends on the Problem's status and its Verifications — facts a
    // reader of stored artifacts cannot see and has no business re-deciding.
    // That check stays on the generation path, and this is the split: a stored
    // profile naming a successful direction parses here without complaint.
    const parsed = parseStructuralFeatures(
      rawFeatures({ successful_directions: ['read the host at run time'] }),
    );
    expect(parsed.successful_directions).toEqual(['read the host at run time']);
  });
});

describe('resolving a rerank request', () => {
  it('fills in the default limit, which is the ceiling', () => {
    // How many to show a person is a presentation decision, and a ranking stage
    // still sits between this and a reader.
    expect(resolveStructuralRerankRequest(request(), parseStructuralFeatures).limit).toBe(
      DEFAULT_STRUCTURAL_RERANK_LIMIT,
    );
    expect(DEFAULT_STRUCTURAL_RERANK_LIMIT).toBe(MAX_STRUCTURAL_RERANK_LIMIT);
    expect(DEFAULT_STRUCTURAL_RERANK_LIMIT).toBe(5);
  });

  it('parses the caller’s profile rather than trusting the annotation', () => {
    // The type says `StructuralFeatures`; the value came from outside. A
    // profile that does not parse is a bad request, not a degraded search.
    expect(() =>
      resolveStructuralRerankRequest(
        request({ currentFeatures: { schema_version: '1' } as unknown as StructuralFeatures }),
        parseStructuralFeatures,
      ),
    ).toThrow(InvalidStructuralRerankError);
  });

  it('names no value when it refuses a profile', () => {
    const secretish = 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI-fake-Rr8Dl3W0123456789';
    let raised: unknown;
    try {
      resolveStructuralRerankRequest(
        request({
          currentFeatures: rawFeatures({
            problem_domain: secretish,
            extra: secretish,
          }) as unknown as StructuralFeatures,
        }),
        parseStructuralFeatures,
      );
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(InvalidStructuralRerankError);
    expect((raised as Error).message.includes('Rr8Dl3W'), 'the error quoted the profile').toBe(
      false,
    );
  });

  it('refuses more candidates than one stage-one window', () => {
    // Twenty-one written out, not `MAX + 1`: a bound compared against itself
    // moves whenever the bound does, and the point is that this one does not.
    expect(MAX_STRUCTURAL_RERANK_CANDIDATES).toBe(20);
    const many = Array.from({ length: 21 }, (_unused, index) =>
      candidate(`c${String(index)}`, index),
    );
    expect(() =>
      resolveStructuralRerankRequest(request({ candidates: many }), parseStructuralFeatures),
    ).toThrow(InvalidStructuralRerankError);

    const exactly = many.slice(0, MAX_STRUCTURAL_RERANK_CANDIDATES);
    expect(
      resolveStructuralRerankRequest(request({ candidates: exactly }), parseStructuralFeatures)
        .candidates,
    ).toHaveLength(MAX_STRUCTURAL_RERANK_CANDIDATES);
  });

  it('accepts an empty candidate list, which the earlier stage can produce', () => {
    expect(
      resolveStructuralRerankRequest(request({ candidates: [] }), parseStructuralFeatures)
        .candidates,
    ).toEqual([]);
  });

  const badCandidates: [string, HybridCandidate[]][] = [
    ['a Problem appears twice', [candidate('a', 0), candidate('a', 1)]],
    ['a fusion score is not a number', [{ ...candidate('a', 0), fusionScore: Number.NaN }]],
    [
      'a fusion score is not finite',
      [{ ...candidate('a', 0), fusionScore: Number.NEGATIVE_INFINITY }],
    ],
    ['a source rank is zero', [{ ...candidate('a', 0), lexicalRank: 0 }]],
    ['a source rank is fractional', [{ ...candidate('a', 0), vectorRank: 1.5 }]],
  ];

  it.each(badCandidates)('refuses candidates when %s', (_label, candidates) => {
    expect(() =>
      resolveStructuralRerankRequest(request({ candidates }), parseStructuralFeatures),
    ).toThrow(InvalidStructuralRerankError);
  });

  it('accepts a null source rank, which is ordinary', () => {
    // A null rank means one channel did not place this Problem in its window.
    // Not a defect, and not evidence against the Memory.
    expect(() =>
      resolveStructuralRerankRequest(
        request({ candidates: [{ ...candidate('a', 0), lexicalRank: null, vectorRank: 3 }] }),
        parseStructuralFeatures,
      ),
    ).not.toThrow();
  });

  const badLimits: [string, number][] = [
    ['zero', 0],
    ['negative', -1],
    ['above the ceiling', 6],
    ['fractional', 2.5],
    ['not a number', Number.NaN],
  ];

  it.each(badLimits)('refuses a limit that is %s', (_label, limit) => {
    expect(() =>
      resolveStructuralRerankRequest(request({ limit }), parseStructuralFeatures),
    ).toThrow(InvalidStructuralRerankError);
  });

  it('accepts the whole one-to-five range', () => {
    for (const limit of [MIN_STRUCTURAL_RERANK_LIMIT, 3, MAX_STRUCTURAL_RERANK_LIMIT]) {
      expect(
        resolveStructuralRerankRequest(request({ limit }), parseStructuralFeatures).limit,
      ).toBe(limit);
    }
    expect(MIN_STRUCTURAL_RERANK_LIMIT).toBe(1);
    expect(MAX_STRUCTURAL_RERANK_LIMIT).toBe(5);
  });

  it('leaves out the Problem being worked on', () => {
    const resolved = resolveStructuralRerankRequest(
      request({ excludeProblemId: problem('a') }),
      parseStructuralFeatures,
    );
    expect(resolved.candidates.map((entry) => entry.problemId)).toEqual([problem('b')]);
  });
});

describe('reading a reranker’s answer', () => {
  const expected = [problem('a'), problem('b')];
  const answer = (candidates: unknown): unknown => ({ candidates });
  const entry = (name: string, score: unknown, dimensions: readonly string[]): unknown => ({
    problemId: problem(name),
    structuralScore: score,
    matchedDimensions: [...dimensions],
  });

  it('accepts a well-formed answer covering every candidate', () => {
    const parsed = parseStructuralRerankerOutput(
      answer([entry('a', 0.8, ['suspected_boundaries']), entry('b', 0, [])]),
      expected,
    );
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.structuralScore).toBe(0.8);
    expect(parsed[0]?.matchedDimensions).toEqual(['suspected_boundaries']);
  });

  const badShapes: [string, unknown][] = [
    ['not an object', 'ranked'],
    ['a list', []],
    ['carrying something other than a candidate list', { ranked: [] }],
    ['whose candidates are not a list', { candidates: 'none' }],
    ['whose candidate is not an object', { candidates: ['a'] }],
  ];

  it.each(badShapes)('refuses an answer %s', (_label, output) => {
    expect(() => parseStructuralRerankerOutput(output, expected)).toThrow(
      InvalidStructuralRerankerOutputError,
    );
  });

  it('refuses an answer carrying more than a candidate list', () => {
    // Otherwise complete, so only the exact-key rule stands between this and a
    // reranker growing a second output channel nothing here reads.
    expect(() =>
      parseStructuralRerankerOutput(
        {
          candidates: [entry('a', 0.5, ['symptom_patterns']), entry('b', 0, [])],
          note: 'both looked like configuration problems',
        },
        expected,
      ),
    ).toThrow(InvalidStructuralRerankerOutputError);
  });

  it('refuses a candidate carrying fields it was not asked for', () => {
    expect(() =>
      parseStructuralRerankerOutput(
        answer([
          {
            problemId: problem('a'),
            structuralScore: 0.5,
            matchedDimensions: ['symptom_patterns'],
            whyItMatches: 'both fail at a boundary',
          },
          entry('b', 0, []),
        ]),
        expected,
      ),
    ).toThrow(InvalidStructuralRerankerOutputError);
  });

  describe('coverage', () => {
    it('refuses an answer that leaves a candidate out', () => {
      // The rule that keeps a hidden threshold out of the model. This stage has
      // none on purpose; a model allowed to omit candidates would reintroduce
      // one where nobody could inspect it.
      expect(() =>
        parseStructuralRerankerOutput(answer([entry('a', 0.5, ['symptom_patterns'])]), expected),
      ).toThrow(InvalidStructuralRerankerOutputError);
    });

    it('refuses an answer that returns nothing at all', () => {
      expect(() => parseStructuralRerankerOutput(answer([]), expected)).toThrow(
        InvalidStructuralRerankerOutputError,
      );
    });

    it('refuses an answer that invents a candidate', () => {
      expect(() =>
        parseStructuralRerankerOutput(
          answer([
            entry('a', 0.5, ['symptom_patterns']),
            entry('b', 0, []),
            entry('z', 0.9, ['symptom_patterns']),
          ]),
          expected,
        ),
      ).toThrow(InvalidStructuralRerankerOutputError);
    });

    it('refuses an invented candidate even when the count comes out right', () => {
      // Substitution, not addition: two answers for two candidates, one of
      // which was never asked about. Counting alone would let this through.
      expect(() =>
        parseStructuralRerankerOutput(
          answer([entry('a', 0.5, ['symptom_patterns']), entry('z', 0.9, ['symptom_patterns'])]),
          expected,
        ),
      ).toThrow(InvalidStructuralRerankerOutputError);
    });

    it('refuses an answer that names one candidate twice', () => {
      expect(() =>
        parseStructuralRerankerOutput(
          answer([entry('a', 0.5, ['symptom_patterns']), entry('a', 0.2, ['symptom_patterns'])]),
          expected,
        ),
      ).toThrow(InvalidStructuralRerankerOutputError);
    });

    it('refuses a repeated candidate even when the count comes out right', () => {
      // One candidate, answered for twice. Nothing is missing and nothing is
      // invented, so only the duplicate check stands between this and a
      // Problem occupying two places in the result.
      expect(() =>
        parseStructuralRerankerOutput(
          answer([entry('a', 0.5, ['symptom_patterns']), entry('a', 0.2, ['symptom_patterns'])]),
          [problem('a')],
        ),
      ).toThrow(InvalidStructuralRerankerOutputError);
    });
  });

  describe('scores and evidence', () => {
    const badScores: [string, unknown][] = [
      ['below zero', -0.1],
      ['above one', 1.1],
      ['not finite', Number.POSITIVE_INFINITY],
      ['not a number', Number.NaN],
      ['text', 'high'],
      ['absent', null],
    ];

    it.each(badScores)('refuses a score %s', (_label, score) => {
      expect(() =>
        parseStructuralRerankerOutput(
          answer([entry('a', score, ['symptom_patterns']), entry('b', 0, [])]),
          expected,
        ),
      ).toThrow(InvalidStructuralRerankerOutputError);
    });

    it('accepts both ends of the zero-to-one range', () => {
      const parsed = parseStructuralRerankerOutput(
        answer([entry('a', 1, ['symptom_patterns']), entry('b', 0, [])]),
        expected,
      );
      expect(parsed.map((item) => item.structuralScore)).toEqual([1, 0]);
    });

    it.each([['schema_version'], ['keywords'], ['confidence']])(
      'refuses %s as a matched dimension',
      (dimension) => {
        expect(() =>
          parseStructuralRerankerOutput(
            answer([entry('a', 0.5, [dimension]), entry('b', 0, [])]),
            expected,
          ),
        ).toThrow(InvalidStructuralRerankerOutputError);
      },
    );

    it('refuses matched dimensions that are not a list', () => {
      expect(() =>
        parseStructuralRerankerOutput(
          answer([
            {
              problemId: problem('a'),
              structuralScore: 0.5,
              matchedDimensions: 'symptom_patterns',
            },
            entry('b', 0, []),
          ]),
          expected,
        ),
      ).toThrow(InvalidStructuralRerankerOutputError);
    });

    it('refuses a repeated dimension', () => {
      expect(() =>
        parseStructuralRerankerOutput(
          answer([entry('a', 0.5, ['symptom_patterns', 'symptom_patterns']), entry('b', 0, [])]),
          expected,
        ),
      ).toThrow(InvalidStructuralRerankerOutputError);
    });

    it('requires a scored candidate to say in what respect', () => {
      // A model that can rate a pair but cannot name one dimension they are
      // alike in has not produced a structural judgement.
      expect(() =>
        parseStructuralRerankerOutput(answer([entry('a', 0.7, []), entry('b', 0, [])]), expected),
      ).toThrow(InvalidStructuralRerankerOutputError);
    });

    it('requires an unscored candidate to claim nothing', () => {
      expect(() =>
        parseStructuralRerankerOutput(
          answer([entry('a', 0, ['symptom_patterns']), entry('b', 0, [])]),
          expected,
        ),
      ).toThrow(InvalidStructuralRerankerOutputError);
    });

    it('accepts every one of the seven dimensions', () => {
      const parsed = parseStructuralRerankerOutput(
        answer([entry('a', 0.9, [...STRUCTURAL_COMPARISON_DIMENSIONS]), entry('b', 0, [])]),
        expected,
      );
      expect(parsed[0]?.matchedDimensions).toHaveLength(STRUCTURAL_COMPARISON_DIMENSIONS.length);
    });
  });

  it('quotes nothing of the answer when it refuses', () => {
    const secretish = 'API_KEY=fake-Ss9Em4X-0123456789abcdef';
    let raised: unknown;
    try {
      parseStructuralRerankerOutput(
        answer([{ problemId: secretish, structuralScore: 1, matchedDimensions: [] }]),
        expected,
      );
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(InvalidStructuralRerankerOutputError);
    expect((raised as Error).message.includes('Ss9Em4X'), 'the error quoted the answer').toBe(
      false,
    );
  });
});

describe('ordering judged candidates', () => {
  const judged = (
    name: string,
    structuralScore: number | null,
    hybridRank: number,
  ): StructuralCandidate => ({
    problemId: problem(name),
    projectId: PROJECT,
    structuralScore,
    hybridRank,
    matchedDimensions: [],
  });

  it('puts structure first, then the earlier stage’s position, then the id', () => {
    const ordered = orderStructuralCandidates(
      [judged('a', 0.2, 1), judged('b', 0.9, 3), judged('c', 0.2, 2)],
      5,
    );
    expect(ordered.map((item) => item.problemId)).toEqual([
      problem('b'),
      problem('a'),
      problem('c'),
    ]);
  });

  it('does not let the earlier stage overrule a structural judgement', () => {
    // A rerank that could not move the top result would not be a rerank.
    const ordered = orderStructuralCandidates([judged('a', 0.1, 1), judged('b', 0.8, 20)], 5);
    expect(ordered[0]?.problemId).toBe(problem('b'));
  });

  it('breaks a full tie on the problem id', () => {
    const ordered = orderStructuralCandidates([judged('c', 0.5, 1), judged('a', 0.5, 1)], 5);
    expect(ordered.map((item) => item.problemId)).toEqual([problem('a'), problem('c')]);
  });

  it('keeps a candidate with no structural similarity rather than dropping it', () => {
    // No threshold, deliberately: a zero means "nothing in common the reranker
    // could name", and deciding that makes a Memory not worth offering belongs
    // to a later stage with more to go on.
    const ordered = orderStructuralCandidates([judged('a', 0.9, 1), judged('b', 0, 2)], 5);
    expect(ordered.map((item) => item.problemId)).toEqual([problem('a'), problem('b')]);
  });

  it('treats an unjudged candidate as the bottom without inventing a number', () => {
    const ordered = orderStructuralCandidates([judged('a', null, 2), judged('b', 0.1, 1)], 5);
    expect(ordered[0]?.problemId).toBe(problem('b'));
    expect(ordered[1]?.structuralScore).toBeNull();
  });

  it('orders wholly unjudged candidates by the earlier stage alone', () => {
    const ordered = orderStructuralCandidates(
      [judged('c', null, 3), judged('a', null, 1), judged('b', null, 2)],
      5,
    );
    expect(ordered.map((item) => item.hybridRank)).toEqual([1, 2, 3]);
  });

  it('cuts to the limit, and a smaller limit is a prefix of a larger one', () => {
    const all = [
      judged('a', 0.9, 1),
      judged('b', 0.7, 2),
      judged('c', 0.5, 3),
      judged('d', 0.1, 4),
    ];
    expect(orderStructuralCandidates(all, 5)).toHaveLength(4);
    expect(orderStructuralCandidates(all, 2).map((item) => item.problemId)).toEqual(
      orderStructuralCandidates(all, 5)
        .slice(0, 2)
        .map((item) => item.problemId),
    );
  });

  it('never pads a short list to reach the limit', () => {
    expect(orderStructuralCandidates([judged('a', 0.5, 1)], 5)).toHaveLength(1);
    expect(orderStructuralCandidates([], 5)).toEqual([]);
  });

  it('leaves its input alone', () => {
    const all = [judged('a', 0.1, 1), judged('b', 0.9, 2)];
    orderStructuralCandidates(all, 5);
    expect(all.map((item) => item.problemId)).toEqual([problem('a'), problem('b')]);
  });
});
