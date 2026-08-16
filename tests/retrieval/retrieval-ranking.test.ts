/**
 * The pure half of ranking: what a request must look like, how a Project's
 * relation to the current one is decided, and what order candidates come out
 * in.
 *
 * Two rules carry most of the weight here.
 *
 * **A structural score of zero and no structural score are different.** Zero
 * means the reranker looked and found nothing in common; null means no
 * reranker ran. Turning null into zero would make an absence of judgement look
 * like a judgement, and every degraded result would silently claim the
 * reranker had rated everything as unalike.
 *
 * **A matching technology name does not outrank structural similarity.** The
 * specification asks for the current Project first, then the same technology,
 * then a different technology with similar structure — and says in the same
 * breath that a technology name alone must not decide. Where those pull apart,
 * structure wins, and the fixtures below are where that is pinned.
 */

import { describe, expect, it } from 'vitest';

import type { ProblemId } from '../../src/domain/problem.js';
import type { ProjectId } from '../../src/domain/project.js';
import {
  classifyProjectRelation,
  InvalidRetrievalRankingError,
  MAX_RANKED_CANDIDATES,
  PROJECT_RELATIONS,
  rankCandidates,
  resolveRetrievalRankingRequest,
  type ProjectRelation,
  type RankableCandidate,
  type RetrievalRankingRequest,
} from '../../src/domain/retrieval-ranking.js';
import type {
  StructuralCandidate,
  StructuralRerankResult,
  StructuralRerankStatus,
} from '../../src/domain/retrieval-structural-rerank.js';

const CURRENT_PROJECT = 'cc000000-0000-4000-8000-000000000001' as ProjectId;
const OTHER_PROJECT = 'cc000000-0000-4000-8000-000000000002' as ProjectId;

const problem = (name: string): ProblemId =>
  `dd000000-0000-4000-8000-${name.padStart(12, '0')}` as ProblemId;

const structural = (
  name: string,
  overrides: Partial<StructuralCandidate> = {},
): StructuralCandidate => ({
  problemId: problem(name),
  projectId: CURRENT_PROJECT,
  structuralScore: 0.5,
  hybridRank: 1,
  matchedDimensions: [],
  ...overrides,
});

const request = (
  candidates: readonly StructuralCandidate[],
  status: StructuralRerankStatus = 'USED',
  currentProjectId: ProjectId = CURRENT_PROJECT,
): RetrievalRankingRequest => ({
  currentProjectId,
  structuralResult: { candidates, status } satisfies StructuralRerankResult,
});

/** A rankable candidate; every field a comparison reads, defaulted to neutral. */
const rankable = (name: string, overrides: Partial<RankableCandidate> = {}): RankableCandidate => ({
  problemId: problem(name),
  projectId: CURRENT_PROJECT,
  confidence: 'HIGH',
  freshness: 'CURRENT',
  suppressed: false,
  projectRelation: 'CURRENT_PROJECT',
  structuralScore: 0.5,
  hybridRank: 1,
  matchedDimensions: [],
  ...overrides,
});

const order = (
  candidates: readonly RankableCandidate[],
  status: StructuralRerankStatus = 'USED',
): string[] => rankCandidates(candidates, status).map((candidate) => candidate.problemId);

describe('validating a ranking request', () => {
  it('accepts nothing through to five candidates', () => {
    for (const count of [0, 1, 3, MAX_RANKED_CANDIDATES]) {
      const candidates = Array.from({ length: count }, (_unused, index) =>
        structural(`c${String(index)}`, { hybridRank: index + 1 }),
      );
      expect(resolveRetrievalRankingRequest(request(candidates)).candidates).toHaveLength(count);
    }
    expect(MAX_RANKED_CANDIDATES).toBe(5);
  });

  it('refuses more than the rerank stage can produce', () => {
    // Six written out rather than `MAX + 1`: a bound compared against itself
    // moves whenever the bound does.
    const six = Array.from({ length: 6 }, (_unused, index) =>
      structural(`c${String(index)}`, { hybridRank: index + 1 }),
    );
    expect(() => resolveRetrievalRankingRequest(request(six))).toThrow(
      InvalidRetrievalRankingError,
    );
  });

  it('refuses a current Project that is not an identifier', () => {
    expect(() =>
      resolveRetrievalRankingRequest(
        request([structural('a')], 'USED', 'the current one' as ProjectId),
      ),
    ).toThrow(InvalidRetrievalRankingError);
  });

  it('refuses a Problem that appears twice', () => {
    expect(() =>
      resolveRetrievalRankingRequest(request([structural('a'), structural('a')])),
    ).toThrow(InvalidRetrievalRankingError);
  });

  it('refuses a structural result that is not one', () => {
    expect(() =>
      resolveRetrievalRankingRequest({
        currentProjectId: CURRENT_PROJECT,
        structuralResult: 'ranked' as unknown as StructuralRerankResult,
      }),
    ).toThrow(InvalidRetrievalRankingError);
  });

  it('refuses an outcome the rerank stage cannot report', () => {
    // The candidate carries no score, so the score invariant has nothing to
    // object to and the unknown outcome is the only thing wrong here.
    expect(() =>
      resolveRetrievalRankingRequest(
        request(
          [structural('a', { structuralScore: null })],
          'PROBABLY_FINE' as StructuralRerankStatus,
        ),
      ),
    ).toThrow(InvalidRetrievalRankingError);
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['not a number', Number.NaN],
  ])('refuses a hybrid rank that is %s', (_label, hybridRank) => {
    expect(() =>
      resolveRetrievalRankingRequest(request([structural('a', { hybridRank })])),
    ).toThrow(InvalidRetrievalRankingError);
  });

  it('accepts a gap in the hybrid ranks, which is ordinary', () => {
    // A gap is the trace of a candidate that disappeared between the earlier
    // stages. It is provenance, not damage.
    const resolved = resolveRetrievalRankingRequest(
      request([structural('a', { hybridRank: 1 }), structural('b', { hybridRank: 3 })]),
    );
    expect(resolved.candidates.map((candidate) => candidate.hybridRank)).toEqual([1, 3]);
  });

  describe('the structural score invariant', () => {
    it('requires every score when the rerank was used', () => {
      expect(() =>
        resolveRetrievalRankingRequest(
          request([structural('a'), structural('b', { structuralScore: null })]),
        ),
      ).toThrow(InvalidRetrievalRankingError);
    });

    it('refuses a used rerank whose candidates carry no scores at all', () => {
      // Separate from the mixed case above, which the "no score without a
      // judgement" rule would also catch. Here every score is absent, so only
      // the used-rerank branch stands between this and a ranking that treats a
      // full set of nulls as though a reranker had produced them.
      expect(() =>
        resolveRetrievalRankingRequest(
          request([
            structural('a', { structuralScore: null }),
            structural('b', { structuralScore: null }),
          ]),
        ),
      ).toThrow(InvalidRetrievalRankingError);
    });

    it.each([
      ['below zero', -0.1],
      ['above one', 1.1],
      ['not finite', Number.POSITIVE_INFINITY],
    ])('refuses a score %s on a used rerank', (_label, structuralScore) => {
      expect(() =>
        resolveRetrievalRankingRequest(request([structural('a', { structuralScore })])),
      ).toThrow(InvalidRetrievalRankingError);
    });

    it.each([
      ['NOT_NEEDED'],
      ['SKIPPED_SENSITIVE_INPUT'],
      ['RERANKER_UNAVAILABLE'],
      ['STRUCTURAL_DATA_UNAVAILABLE'],
    ] as const)('requires every score to be absent on %s', (status) => {
      expect(() =>
        resolveRetrievalRankingRequest(
          request([structural('a', { structuralScore: null }), structural('b')], status),
        ),
      ).toThrow(InvalidRetrievalRankingError);

      expect(() =>
        resolveRetrievalRankingRequest(
          request(
            [
              structural('a', { structuralScore: null }),
              structural('b', { structuralScore: null }),
            ],
            status,
          ),
        ),
      ).not.toThrow();
    });

    it('refuses a zero score on a degraded rerank', () => {
      // Zero is a judgement. If no judgement was made, a zero is somebody
      // having filled the gap in — and the whole point of the null is that
      // nobody may.
      expect(() =>
        resolveRetrievalRankingRequest(
          request([structural('a', { structuralScore: 0 })], 'RERANKER_UNAVAILABLE'),
        ),
      ).toThrow(InvalidRetrievalRankingError);
    });
  });

  it('names no value when it refuses', () => {
    const secretish = 'API_KEY=fake-Ww3Nx7L-0123456789abcdef';
    let raised: unknown;
    try {
      resolveRetrievalRankingRequest(request([structural('a')], 'USED', secretish as ProjectId));
    } catch (error) {
      raised = error;
    }
    expect(raised).toBeInstanceOf(InvalidRetrievalRankingError);
    expect((raised as Error).message.includes('Ww3Nx7L'), 'the error quoted the request').toBe(
      false,
    );
  });
});

describe('how a Project relates to the current one', () => {
  const relate = (
    currentPlatform: string | null,
    candidatePlatform: string | null,
    candidateProjectId: ProjectId = OTHER_PROJECT,
  ): ProjectRelation =>
    classifyProjectRelation(
      CURRENT_PROJECT,
      currentPlatform,
      candidateProjectId,
      candidatePlatform,
    );

  it('offers exactly four relations', () => {
    expect([...PROJECT_RELATIONS]).toEqual([
      'CURRENT_PROJECT',
      'SAME_TECH_OTHER_PROJECT',
      'OTHER_TECH',
      'UNKNOWN_TECH',
    ]);
  });

  it('calls the current Project the current Project, whatever it is built on', () => {
    // Exclusive by construction: a Problem in the current Project cannot also
    // be counted as sharing its technology, so proximity is never doubled.
    expect(relate('react', 'react', CURRENT_PROJECT)).toBe('CURRENT_PROJECT');
    expect(relate('react', 'fastify', CURRENT_PROJECT)).toBe('CURRENT_PROJECT');
    expect(relate(null, null, CURRENT_PROJECT)).toBe('CURRENT_PROJECT');
  });

  it('matches a technology label ignoring case', () => {
    expect(relate('React', 'react')).toBe('SAME_TECH_OTHER_PROJECT');
    expect(relate('REACT', 'React')).toBe('SAME_TECH_OTHER_PROJECT');
  });

  it.each([
    ['Node.js', 'node'],
    ['React', 'React Native'],
    ['react', 'react-dom'],
  ])('does not stretch %s to match %s', (current, candidate) => {
    // A coarse instrument, deliberately. Closing these gaps means synonym
    // tables, version stripping or token overlap — a technology-identity model
    // invented inside a ranking function and tuned against nothing. A missed
    // match costs a tie-break; an invented one asserts a shared stack nobody
    // claimed.
    expect(relate(current, candidate)).toBe('OTHER_TECH');
  });

  it.each([
    ['the current Project has no label', null, 'react'],
    ['the candidate has no label', 'react', null],
    ['neither has one', null, null],
  ])('calls it unknown when %s', (_label, current, candidate) => {
    // Not `OTHER_TECH`: silence is not a claim of difference, and treating it
    // as one would demote every Project nobody has got round to labelling.
    expect(relate(current, candidate)).toBe('UNKNOWN_TECH');
  });
});

describe('the ranking order', () => {
  it('puts an unsuppressed candidate above a suppressed one', () => {
    // "Show this less" is expressed here and nowhere else. It is not
    // "hide this": the suppressed candidate is still in the list.
    const ranked = rankCandidates(
      [rankable('a', { suppressed: true }), rankable('b', { suppressed: false })],
      'USED',
    );
    expect(ranked.map((candidate) => candidate.problemId)).toEqual([problem('b'), problem('a')]);
    expect(ranked).toHaveLength(2);
  });

  it('outranks everything else with suppression', () => {
    // A suppressed Memory that is trusted, current, in the current Project and
    // structurally perfect still goes below a weak one nobody suppressed.
    expect(
      order([
        rankable('a', { suppressed: true, structuralScore: 1 }),
        rankable('b', {
          suppressed: false,
          confidence: 'CONFLICTED',
          freshness: 'INVALID',
          structuralScore: 0,
          projectRelation: 'OTHER_TECH',
        }),
      ]),
    ).toEqual([problem('b'), problem('a')]);
  });

  // The identifiers in these two run against the expected order on purpose. If
  // they agreed with it, dropping the key under test would still produce the
  // right answer by way of the final tie-break, and the test would prove
  // nothing.
  it('orders freshness from current to invalid', () => {
    expect(
      order([
        rankable('a', { freshness: 'INVALID' }),
        rankable('c', { freshness: 'STALE_UNKNOWN' }),
        rankable('d', { freshness: 'CURRENT' }),
        rankable('b', { freshness: 'SUPERSEDED' }),
      ]),
    ).toEqual([problem('d'), problem('c'), problem('b'), problem('a')]);
  });

  it('orders confidence from high to conflicted', () => {
    expect(
      order([
        rankable('a', { confidence: 'CONFLICTED' }),
        rankable('b', { confidence: 'LOW' }),
        rankable('d', { confidence: 'HIGH' }),
        rankable('c', { confidence: 'MEDIUM' }),
      ]),
    ).toEqual([problem('d'), problem('c'), problem('b'), problem('a')]);
  });

  it('weighs currency before trust', () => {
    // A Memory known to be wrong should not lead on being well verified. That
    // is the "do not blindly trust an old Memory" requirement.
    expect(
      order([
        rankable('a', { freshness: 'INVALID', confidence: 'HIGH' }),
        rankable('b', { freshness: 'CURRENT', confidence: 'MEDIUM' }),
      ]),
    ).toEqual([problem('b'), problem('a')]);
  });

  it('keeps every demoted candidate rather than removing it', () => {
    const ranked = rankCandidates(
      [
        rankable('a', { suppressed: true }),
        rankable('b', { freshness: 'INVALID' }),
        rankable('c', { confidence: 'CONFLICTED' }),
        rankable('d', { structuralScore: 0 }),
        rankable('e', { freshness: 'SUPERSEDED' }),
      ],
      'USED',
    );
    // Low trust, invalidity and suppression change the order and nothing else.
    // Removing one here would turn "surface this less" into a deletion.
    expect(ranked).toHaveLength(5);
  });

  it('orders by structure before proximity, at equal trust', () => {
    expect(
      order([
        rankable('a', { projectRelation: 'CURRENT_PROJECT', structuralScore: 0.7 }),
        rankable('b', { projectRelation: 'SAME_TECH_OTHER_PROJECT', structuralScore: 0.8 }),
        rankable('c', { projectRelation: 'OTHER_TECH', structuralScore: 0.95 }),
      ]),
    ).toEqual([problem('c'), problem('b'), problem('a')]);
  });

  it('does not let a shared technology name beat a real structural match', () => {
    // The acceptance condition for the whole system: a problem of the same
    // shape in a different stack must be findable. A same-technology candidate
    // with almost nothing in common must not bury it.
    expect(
      order([
        rankable('a', { projectRelation: 'SAME_TECH_OTHER_PROJECT', structuralScore: 0.05 }),
        rankable('b', { projectRelation: 'OTHER_TECH', structuralScore: 0.95 }),
      ]),
    ).toEqual([problem('b'), problem('a')]);
  });

  it('does not let a shared technology name beat structure it has none of', () => {
    expect(
      order([
        rankable('a', { projectRelation: 'SAME_TECH_OTHER_PROJECT', structuralScore: 0 }),
        rankable('b', { projectRelation: 'OTHER_TECH', structuralScore: 1 }),
      ]),
    ).toEqual([problem('b'), problem('a')]);
  });

  it('does not let the current Project beat a much better match elsewhere', () => {
    expect(
      order([
        rankable('a', { projectRelation: 'CURRENT_PROJECT', structuralScore: 0.4 }),
        rankable('b', { projectRelation: 'OTHER_TECH', structuralScore: 0.9 }),
      ]),
    ).toEqual([problem('b'), problem('a')]);
  });

  it('does not let the current Project outrank a more trustworthy Memory elsewhere', () => {
    expect(
      order([
        rankable('a', {
          projectRelation: 'CURRENT_PROJECT',
          confidence: 'LOW',
          freshness: 'STALE_UNKNOWN',
          suppressed: true,
          structuralScore: 0.8,
        }),
        rankable('b', {
          projectRelation: 'OTHER_TECH',
          confidence: 'HIGH',
          freshness: 'CURRENT',
          suppressed: false,
          structuralScore: 0.8,
        }),
      ]),
    ).toEqual([problem('b'), problem('a')]);
  });

  it('applies the specification’s search order when structure ties', () => {
    // The order is still here. It decides between candidates that are equally
    // trusted and equally similar, which is what "widen the search" means.
    expect(
      order([
        rankable('c', { projectRelation: 'OTHER_TECH' }),
        rankable('a', { projectRelation: 'CURRENT_PROJECT' }),
        rankable('b', { projectRelation: 'SAME_TECH_OTHER_PROJECT' }),
      ]),
    ).toEqual([problem('a'), problem('b'), problem('c')]);
  });

  it('ranks an unlabelled Project level with a differently labelled one', () => {
    // Not knowing is not evidence of difference. They tie, and the tie falls
    // through to the earlier stage's position.
    expect(
      order([
        rankable('a', { projectRelation: 'UNKNOWN_TECH', hybridRank: 2 }),
        rankable('b', { projectRelation: 'OTHER_TECH', hybridRank: 1 }),
      ]),
    ).toEqual([problem('b'), problem('a')]);
    expect(
      order([
        rankable('a', { projectRelation: 'OTHER_TECH', hybridRank: 2 }),
        rankable('b', { projectRelation: 'UNKNOWN_TECH', hybridRank: 1 }),
      ]),
    ).toEqual([problem('b'), problem('a')]);
  });

  describe('when the rerank did not run', () => {
    const nulls = (name: string, overrides: Partial<RankableCandidate> = {}): RankableCandidate =>
      rankable(name, { structuralScore: null, ...overrides });

    it('falls through to the specification’s search order', () => {
      expect(
        order(
          [
            nulls('c', { projectRelation: 'OTHER_TECH' }),
            nulls('a', { projectRelation: 'CURRENT_PROJECT' }),
            nulls('b', { projectRelation: 'SAME_TECH_OTHER_PROJECT' }),
          ],
          'RERANKER_UNAVAILABLE',
        ),
      ).toEqual([problem('a'), problem('b'), problem('c')]);
    });

    it('then to the earlier stage’s position', () => {
      // Identifiers against the expected order again, so the position is doing
      // the work rather than the final tie-break.
      expect(
        order(
          [
            nulls('a', { hybridRank: 3 }),
            nulls('c', { hybridRank: 1 }),
            nulls('b', { hybridRank: 2 }),
          ],
          'NOT_NEEDED',
        ),
      ).toEqual([problem('c'), problem('b'), problem('a')]);
    });

    it('still applies trust, currency and suppression', () => {
      expect(
        order(
          [
            nulls('a', { suppressed: true }),
            nulls('b', { freshness: 'INVALID' }),
            nulls('c', { confidence: 'HIGH', freshness: 'CURRENT' }),
          ],
          'STRUCTURAL_DATA_UNAVAILABLE',
        ),
      ).toEqual([problem('c'), problem('b'), problem('a')]);
    });
  });

  describe('a score of zero is not the absence of a score', () => {
    // Three cases, one distinction. A judged zero is ranked; an absent score
    // on a degraded status is skipped; an absent score on a used rerank is
    // refused. What never happens is a null becoming a number.
    it('refuses a missing score when the status says a rerank ran', () => {
      // Straight at the exported function, past the request check. The two
      // guarantees are separate on purpose: if this one rested on the other,
      // the rule would hold only as long as every caller went through the
      // service — and the one conversion this stage exists to prevent would be
      // one direct call away.
      expect(() =>
        rankCandidates(
          [rankable('a', { structuralScore: 0.5 }), rankable('b', { structuralScore: null })],
          'USED',
        ),
      ).toThrow(InvalidRetrievalRankingError);
    });

    it('names no candidate when it refuses one', () => {
      let raised: unknown;
      try {
        rankCandidates([rankable('a'), rankable('b', { structuralScore: null })], 'USED');
      } catch (error) {
        raised = error;
      }
      expect(raised).toBeInstanceOf(InvalidRetrievalRankingError);
      expect((raised as Error).message.includes(problem('b')), 'the refusal named a Problem').toBe(
        false,
      );
    });

    it('ranks a judged zero without complaint', () => {
      const ranked = rankCandidates(
        [rankable('a', { structuralScore: 0 }), rankable('b', { structuralScore: 0 })],
        'USED',
      );
      // Zero is a judgement — the reranker looked and found nothing in common
      // — so it orders like any other score rather than raising.
      expect(ranked).toHaveLength(2);
      expect(ranked.map((candidate) => candidate.structuralScore)).toEqual([0, 0]);
    });

    it('lets a judged zero lose to a judged score, as a judgement should', () => {
      expect(
        order([
          rankable('a', { structuralScore: 0, projectRelation: 'CURRENT_PROJECT' }),
          rankable('b', { structuralScore: 0.1, projectRelation: 'OTHER_TECH' }),
        ]),
      ).toEqual([problem('b'), problem('a')]);
    });

    it('consults no score at all when the status says none was made', () => {
      // `rankCandidates` is exported, and its contract is that the structural
      // step is *skipped* on a degraded status rather than defaulted. The
      // service cannot produce this input — the request check refuses a score
      // without a judgement behind it — but the function is reachable on its
      // own, and "skipped" and "read as zero" are only the same answer while
      // that check holds. Pinning the function directly keeps the two
      // guarantees independent instead of leaving one resting on the other.
      expect(
        order(
          [
            rankable('a', { structuralScore: 0.1, projectRelation: 'CURRENT_PROJECT' }),
            rankable('b', { structuralScore: 0.9, projectRelation: 'OTHER_TECH' }),
          ],
          'STRUCTURAL_DATA_UNAVAILABLE',
        ),
      ).toEqual([problem('a'), problem('b')]);
    });

    it('does not let an absent score lose the same way', () => {
      // The same two candidates, with no judgement behind them. If null were
      // read as zero the second would win again; instead the comparison skips
      // structure entirely and the current Project comes first.
      expect(
        order(
          [
            rankable('a', { structuralScore: null, projectRelation: 'CURRENT_PROJECT' }),
            rankable('b', { structuralScore: null, projectRelation: 'OTHER_TECH' }),
          ],
          'RERANKER_UNAVAILABLE',
        ),
      ).toEqual([problem('a'), problem('b')]);
    });
  });

  it('breaks a full tie on the Problem identifier', () => {
    expect(order([rankable('c'), rankable('a'), rankable('b')])).toEqual([
      problem('a'),
      problem('b'),
      problem('c'),
    ]);
  });

  it('does not use the position it was handed as a hidden tie-break', () => {
    // Same candidates, two orders in, one order out.
    const forwards = order([rankable('c'), rankable('a'), rankable('b')]);
    const backwards = order([rankable('b'), rankable('a'), rankable('c')]);
    expect(forwards).toEqual(backwards);
  });

  it('ignores what the reranker found the Problems alike in', () => {
    // Carried as provenance, never weighed. Counting matched dimensions would
    // be this stage re-judging a semantic question it was not asked.
    const many = rankable('a', {
      matchedDimensions: ['symptom_patterns', 'suspected_boundaries', 'occurrence_conditions'],
      structuralScore: 0.5,
      hybridRank: 2,
    });
    const none = rankable('b', { matchedDimensions: [], structuralScore: 0.5, hybridRank: 1 });
    expect(order([many, none])).toEqual([problem('b'), problem('a')]);
  });

  it('numbers the result from one, without gaps', () => {
    const ranked = rankCandidates(
      [
        rankable('a', { hybridRank: 1 }),
        rankable('b', { hybridRank: 4 }),
        rankable('c', { hybridRank: 9 }),
      ],
      'USED',
    );
    expect(ranked.map((candidate) => candidate.rankingRank)).toEqual([1, 2, 3]);
  });

  it('keeps the earlier stage’s positions exactly as they came', () => {
    // Two different facts: where the first retrieval stage put a candidate,
    // and where this stage put it. Overwriting one with the other would lose
    // whichever it replaced — and the gaps are the trace of a candidate that
    // disappeared along the way.
    const ranked = rankCandidates(
      [rankable('a', { hybridRank: 1 }), rankable('b', { hybridRank: 3 })],
      'USED',
    );
    expect(ranked.map((candidate) => candidate.hybridRank)).toEqual([1, 3]);
    expect(ranked.map((candidate) => candidate.rankingRank)).toEqual([1, 2]);
  });

  it('returns an empty list for no candidates', () => {
    expect(rankCandidates([], 'USED')).toEqual([]);
  });

  it('leaves its input alone', () => {
    const input = [rankable('c'), rankable('a')];
    rankCandidates(input, 'USED');
    expect(input.map((candidate) => candidate.problemId)).toEqual([problem('c'), problem('a')]);
  });
});

describe('the canonical fixtures', () => {
  // The five comparisons the design was settled against, kept together so a
  // change to the policy shows up as a change to all of them at once.
  it('ranks better structure above closer origin at equal trust', () => {
    expect(
      order([
        rankable('a', { projectRelation: 'CURRENT_PROJECT', structuralScore: 0.7 }),
        rankable('b', { projectRelation: 'SAME_TECH_OTHER_PROJECT', structuralScore: 0.8 }),
        rankable('c', { projectRelation: 'OTHER_TECH', structuralScore: 0.95 }),
      ]),
    ).toEqual([problem('c'), problem('b'), problem('a')]);
  });

  it('ranks a trustworthy stranger above a doubtful neighbour', () => {
    expect(
      order([
        rankable('a', {
          projectRelation: 'CURRENT_PROJECT',
          confidence: 'LOW',
          freshness: 'STALE_UNKNOWN',
          suppressed: true,
          structuralScore: 0.9,
        }),
        rankable('b', { projectRelation: 'OTHER_TECH', structuralScore: 0.3 }),
      ]),
    ).toEqual([problem('b'), problem('a')]);
  });

  it('ranks an unsuppressed weaker Memory above a suppressed stronger one', () => {
    expect(
      order([
        rankable('a', { suppressed: true, confidence: 'HIGH', structuralScore: 0.9 }),
        rankable('b', {
          suppressed: false,
          confidence: 'MEDIUM',
          projectRelation: 'OTHER_TECH',
          structuralScore: 0.8,
        }),
      ]),
    ).toEqual([problem('b'), problem('a')]);
  });

  it('ranks a current Memory above an invalid one that is better verified', () => {
    expect(
      order([
        rankable('a', { freshness: 'INVALID', confidence: 'HIGH', structuralScore: 0.9 }),
        rankable('b', {
          freshness: 'CURRENT',
          confidence: 'MEDIUM',
          projectRelation: 'OTHER_TECH',
          structuralScore: 0.8,
        }),
      ]),
    ).toEqual([problem('b'), problem('a')]);
  });
});
