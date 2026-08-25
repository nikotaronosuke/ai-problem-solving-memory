/**
 * The relaxed lexical derivation, and the one word it adds to a usage reason.
 *
 * Pure-function tests: the derivation must be deterministic hygiene and
 * nothing more — no stemming, no stop-list, no ranking opinion — and it must
 * never manufacture query syntax out of a caller's characters. The reason
 * composer must say `lexical=RELAXED` exactly when the fallback produced the
 * answer, and keep every strict reason byte-identical to what it always was.
 */

import { describe, expect, it } from 'vitest';

import { composeSearchedReason } from '../../src/app/retrieval-usage-log-writer.js';
import type { RankedMemoryCandidate } from '../../src/domain/retrieval-ranking.js';
import {
  MAX_SEARCH_TEXT_LENGTH,
  relaxedLexicalTextOf,
  RELAXED_LEXICAL_JOINER,
} from '../../src/domain/retrieval-search.js';

describe('the relaxed lexical derivation', () => {
  it('joins distinct whitespace terms with the parser’s own alternation', () => {
    expect(relaxedLexicalTextOf('buffer cleared increments')).toBe(
      'buffer or cleared or increments',
    );
  });

  it('is deterministic', () => {
    const text = 'buffer  cleared\tincrements cleared';
    expect(relaxedLexicalTextOf(text)).toBe(relaxedLexicalTextOf(text));
  });

  it('declines a single term: relaxing one word changes nothing', () => {
    expect(relaxedLexicalTextOf('buffer')).toBeUndefined();
    expect(relaxedLexicalTextOf('   buffer   ')).toBeUndefined();
  });

  it('declines a query that is already this alternation', () => {
    expect(relaxedLexicalTextOf('buffer or cleared')).toBeUndefined();
  });

  it('drops exact repeats, keeping first appearances', () => {
    expect(relaxedLexicalTextOf('flush buffer flush buffer flush')).toBe('flush or buffer');
  });

  it('drops pieces that could not be terms', () => {
    expect(relaxedLexicalTextOf('foo && ... !! bar')).toBe('foo or bar');
  });

  it('keeps hyphens, underscores and code identifiers as they are', () => {
    expect(relaxedLexicalTextOf('dead-end errors_total LogShipper.flush')).toBe(
      'dead-end or errors_total or LogShipper.flush',
    );
  });

  it('strips quotes so a phrase cannot reassemble around the alternation', () => {
    const relaxed = relaxedLexicalTextOf('"alpha beta" gamma');
    expect(relaxed).toBe('alpha or beta or gamma');
    expect(relaxed).not.toContain('"');
  });

  it('strips the exclusion prefix rather than smuggling a negation into an OR', () => {
    expect(relaxedLexicalTextOf('-alpha beta')).toBe('alpha or beta');
  });

  it('stays inside the ordinary text bound by keeping a prefix of the terms', () => {
    const terms = Array.from({ length: 400 }, (_unused, index) => `term${String(index)}`);
    const relaxed = relaxedLexicalTextOf(terms.join(' '));
    expect(relaxed).toBeDefined();
    expect(relaxed!.length).toBeLessThanOrEqual(MAX_SEARCH_TEXT_LENGTH);
    expect(relaxed!.startsWith(`term0${RELAXED_LEXICAL_JOINER}term1`)).toBe(true);
  });

  it('builds no tsquery syntax of its own', () => {
    // Characters that would be operators in raw `tsquery` are ordinary data
    // to the websearch parser this text is destined for; the derivation's job
    // is only to never *assemble* syntax — no quotes that could close into a
    // phrase, no bare `or` beyond the joiner, and the caller's words intact.
    const relaxed = relaxedLexicalTextOf("pg'); drop table x; -- buffer flush");
    expect(relaxed).toBeDefined();
    expect(relaxed).not.toContain('"');
    expect(relaxed).not.toContain("'");
    expect(relaxed).toContain('buffer');
    expect(relaxed).toContain('flush');
    expect(relaxed!.split(RELAXED_LEXICAL_JOINER).every((term) => term.trim().length > 0)).toBe(
      true,
    );
  });
});

describe('the searched reason and the relaxed word', () => {
  const candidate: RankedMemoryCandidate = {
    problemId: 'aaaaaaaa-1111-4222-8333-444444444444' as never,
    projectId: '22222222-3333-4444-8555-666666666666' as never,
    rankingRank: 1,
    projectRelation: 'CURRENT_PROJECT',
    confidence: 'HIGH',
    freshness: 'CURRENT',
    suppressed: false,
    structuralScore: null,
    hybridRank: 1,
    matchedDimensions: [],
  };

  it('keeps a strict reason byte-identical to what it always was', () => {
    const withoutFlag = composeSearchedReason(candidate, 'PROVIDER_UNAVAILABLE', 'NOT_NEEDED');
    const explicitlyStrict = composeSearchedReason(
      candidate,
      'PROVIDER_UNAVAILABLE',
      'NOT_NEEDED',
      false,
    );
    expect(explicitlyStrict).toBe(withoutFlag);
    expect(withoutFlag).not.toContain('lexical=');
  });

  it('says lexical=RELAXED only when the fallback produced the answer', () => {
    const relaxed = composeSearchedReason(candidate, 'PROVIDER_UNAVAILABLE', 'NOT_NEEDED', true);
    expect(relaxed).toContain('; lexical=RELAXED.');
  });
});
