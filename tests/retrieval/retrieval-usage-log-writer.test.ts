/**
 * What a search writes down about a Memory it surfaced.
 *
 * The reason is permanent text, composed by the server from a closed
 * vocabulary, and these tests fix its exact shape. Two things they are really
 * checking:
 *
 * **That it says only what was observed.** A rerank naming a dimension means
 * both Problems had content in that dimension, not that the contents agree —
 * so the reason records what was *compared*, never what "matched". A degraded
 * rerank named nothing, and the reason must not imply otherwise.
 *
 * **That it carries no text anybody typed.** Every field is an enum, a number
 * or a fixed word. Nothing a caller wrote and nothing a model returned can
 * reach it, which is what keeps a query — allowed to contain
 * credential-shaped text because it is used and discarded — out of a row that
 * is kept.
 */

import { describe, expect, it } from 'vitest';

import {
  composeSearchedReason,
  NO_COMPARISON_DIMENSIONS,
  SEARCHED_REASON_PREFIX,
} from '../../src/app/retrieval-usage-log-writer.js';
import type { ProblemId } from '../../src/domain/problem.js';
import type { ProjectId } from '../../src/domain/project.js';
import type { ProjectRelation, RankedMemoryCandidate } from '../../src/domain/retrieval-ranking.js';
import type { StructuralComparisonDimension } from '../../src/domain/retrieval-structural-rerank.js';

const PROBLEM = 'dd000000-0000-4000-8000-000000000001' as ProblemId;
const PROJECT = 'cc000000-0000-4000-8000-000000000001' as ProjectId;

const candidate = (overrides: Partial<RankedMemoryCandidate> = {}): RankedMemoryCandidate => ({
  problemId: PROBLEM,
  projectId: PROJECT,
  rankingRank: 1,
  projectRelation: 'CURRENT_PROJECT',
  confidence: 'HIGH',
  freshness: 'CURRENT',
  suppressed: false,
  structuralScore: 0.75,
  hybridRank: 1,
  matchedDimensions: [],
  ...overrides,
});

describe('the reason a search writes down', () => {
  it('has one fixed shape', () => {
    // Fixed rather than prose: this text is permanent and something will read
    // it later, so a format that varied by case would be a parsing problem
    // handed to whoever wants to know what a search found.
    expect(
      composeSearchedReason(
        candidate({
          rankingRank: 2,
          projectRelation: 'SAME_TECH_OTHER_PROJECT',
          matchedDimensions: ['symptom_patterns', 'suspected_boundaries'],
        }),
        'USED',
        'USED',
      ),
    ).toBe(
      'Surfaced by retrieval search; ranking_rank=2; project_relation=SAME_TECH_OTHER_PROJECT; ' +
        'semantic_status=USED; structural_status=USED; ' +
        'comparison_dimensions=symptom_patterns,suspected_boundaries.',
    );
  });

  it('opens with the same words every time', () => {
    expect(SEARCHED_REASON_PREFIX).toBe('Surfaced by retrieval search');
    expect(
      composeSearchedReason(candidate(), 'USED', 'NOT_NEEDED').startsWith(SEARCHED_REASON_PREFIX),
    ).toBe(true);
  });

  it('reports the position the search actually offered', () => {
    for (const rankingRank of [1, 3, 5]) {
      expect(composeSearchedReason(candidate({ rankingRank }), 'USED', 'USED')).toContain(
        `ranking_rank=${String(rankingRank)};`,
      );
    }
  });

  it.each([['CURRENT_PROJECT'], ['SAME_TECH_OTHER_PROJECT'], ['OTHER_TECH'], ['UNKNOWN_TECH']] as [
    ProjectRelation,
  ][])('reports where the Memory came from: %s', (projectRelation) => {
    expect(composeSearchedReason(candidate({ projectRelation }), 'USED', 'USED')).toContain(
      `project_relation=${projectRelation};`,
    );
  });

  it.each([['USED'], ['SKIPPED_SENSITIVE_QUERY'], ['PROVIDER_UNAVAILABLE']] as const)(
    'reports the semantic channel outcome: %s',
    (semanticStatus) => {
      expect(composeSearchedReason(candidate(), semanticStatus, 'USED')).toContain(
        `semantic_status=${semanticStatus};`,
      );
    },
  );

  it.each([
    ['USED'],
    ['NOT_NEEDED'],
    ['SKIPPED_SENSITIVE_INPUT'],
    ['RERANKER_UNAVAILABLE'],
    ['STRUCTURAL_DATA_UNAVAILABLE'],
  ] as const)('reports the structural outcome: %s', (structuralStatus) => {
    expect(composeSearchedReason(candidate(), 'USED', structuralStatus)).toContain(
      `structural_status=${structuralStatus};`,
    );
  });

  describe('what the two Problems were compared on', () => {
    it('lists the dimensions the rerank named', () => {
      const dimensions: StructuralComparisonDimension[] = [
        'problem_domain',
        'occurrence_conditions',
      ];
      expect(
        composeSearchedReason(candidate({ matchedDimensions: dimensions }), 'USED', 'USED'),
      ).toContain('comparison_dimensions=problem_domain,occurrence_conditions.');
    });

    it('says none when the rerank named nothing', () => {
      expect(composeSearchedReason(candidate({ matchedDimensions: [] }), 'USED', 'USED')).toContain(
        `comparison_dimensions=${NO_COMPARISON_DIMENSIONS}.`,
      );
      expect(NO_COMPARISON_DIMENSIONS).toBe('none');
    });

    it('never claims the two agreed', () => {
      // The rerank guarantees both sides had content in a named dimension. It
      // does not guarantee — and this code never checked — that the contents
      // mean the same thing. "Matched" would claim a verification nobody
      // performed.
      const reason = composeSearchedReason(
        candidate({ matchedDimensions: ['symptom_patterns'] }),
        'USED',
        'USED',
      );
      for (const overclaim of ['matched', 'match', 'similar', 'identical', 'equivalent']) {
        expect(reason.toLowerCase().includes(overclaim), `the reason claims ${overclaim}`).toBe(
          false,
        );
      }
    });

    it('claims nothing structural when no rerank ran', () => {
      const reason = composeSearchedReason(
        candidate({ matchedDimensions: [] }),
        'USED',
        'RERANKER_UNAVAILABLE',
      );
      expect(reason).toContain('structural_status=RERANKER_UNAVAILABLE;');
      expect(reason).toContain('comparison_dimensions=none.');
    });
  });

  describe('what it leaves out', () => {
    it('carries no identifier, no score and no trust control', () => {
      const reason = composeSearchedReason(
        candidate({
          confidence: 'CONFLICTED',
          freshness: 'INVALID',
          suppressed: true,
          structuralScore: 0.8125,
          hybridRank: 17,
        }),
        'USED',
        'USED',
      );

      // The identifiers have their own columns. Trust, currency and
      // suppression decide an order — they are not an account of what looked
      // similar, and a reason is where that account goes. A raw structural
      // score is one model's internal number and means nothing a year later.
      for (const absent of [PROBLEM, PROJECT, 'CONFLICTED', 'INVALID', '0.8125', '17']) {
        expect(reason.includes(absent), `the reason carries ${absent}`).toBe(false);
      }
      expect(reason.includes('suppressed'), 'the reason carries a control').toBe(false);
      expect(reason.includes('confidence'), 'the reason carries a control').toBe(false);
      expect(reason.includes('freshness'), 'the reason carries a control').toBe(false);
    });

    it('is built only from values this code chose', () => {
      // Every field is an enum, a small number or a fixed word — so there is
      // no path by which text anybody typed could arrive in it.
      const reason = composeSearchedReason(
        candidate({ rankingRank: 4, matchedDimensions: ['environment_facts'] }),
        'PROVIDER_UNAVAILABLE',
        'STRUCTURAL_DATA_UNAVAILABLE',
      );
      expect(reason).toMatch(
        /^Surfaced by retrieval search; ranking_rank=\d; project_relation=[A-Z_]+; semantic_status=[A-Z_]+; structural_status=[A-Z_]+; comparison_dimensions=[a-z_,]+\.$/,
      );
    });

    it('never runs blank, whatever it is given', () => {
      // The column refuses a blank reason, so a composition that could produce
      // one would fail at the database rather than here.
      expect(composeSearchedReason(candidate(), 'USED', 'NOT_NEEDED').trim()).not.toBe('');
    });
  });
});
