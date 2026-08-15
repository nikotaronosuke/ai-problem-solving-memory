/**
 * What a search has to look like before it reaches the database.
 *
 * Small and pure. The interesting decisions are elsewhere — in the SQL, where
 * the owner boundary lives, and in the migration, where the document is
 * defined — so what is left here is the shape of the request: refuse what
 * cannot be answered, fill in what was not said, and never repeat back what was
 * asked.
 *
 * That last one is the reason the error checks below exist. A search is
 * somebody looking for something, and the words they used are theirs; an error
 * carrying them travels into a caller and possibly into a log, which is the one
 * place this codebase has spent several tasks keeping caller text out of.
 */

import { describe, expect, it } from 'vitest';

import type { ProblemId } from '../../src/domain/problem.js';
import type { ProjectId } from '../../src/domain/project.js';
import {
  DEFAULT_SEARCH_LIMIT,
  InvalidFullTextSearchError,
  MAX_SEARCH_LIMIT,
  MAX_SEARCH_TEXT_LENGTH,
  resolveFullTextSearchQuery,
  RETRIEVAL_TEXT_SEARCH_CONFIG,
} from '../../src/domain/retrieval-search.js';

const PROJECT = '9f0e1d2c-0000-4000-8000-000000000001' as ProjectId;
const PROBLEM = '9f0e1d2c-0000-4000-8000-000000000002' as ProblemId;

describe('the text search configuration', () => {
  it('is named in full, so a session setting cannot change what a search means', () => {
    // `default_text_search_config` is `english` on the server this runs
    // against. A query built without naming a configuration would stem
    // `Fastify` to `fastifi` and would disagree with the stored document.
    expect(RETRIEVAL_TEXT_SEARCH_CONFIG).toBe('pg_catalog.simple');
  });
});

describe('resolving a search query', () => {
  it('fills in the defaults', () => {
    const resolved = resolveFullTextSearchQuery({ text: 'oauth redirect' });

    expect(resolved.text).toBe('oauth redirect');
    expect(resolved.limit).toBe(DEFAULT_SEARCH_LIMIT);
    // Null rather than absent, so the statement can express "no filter" as a
    // bound parameter instead of a different statement.
    expect(resolved.projectId).toBeNull();
    expect(resolved.excludeProblemId).toBeNull();
  });

  it('searches every Project unless one is named', () => {
    // The default the specification asks for: experience from one project is
    // meant to be available to another, so narrowing has to be asked for.
    expect(resolveFullTextSearchQuery({ text: 'oauth' }).projectId).toBeNull();
    expect(resolveFullTextSearchQuery({ text: 'oauth', projectId: PROJECT }).projectId).toBe(
      PROJECT,
    );
  });

  it('keeps a Problem in the results unless it is named for exclusion', () => {
    expect(resolveFullTextSearchQuery({ text: 'oauth' }).excludeProblemId).toBeNull();
    expect(
      resolveFullTextSearchQuery({ text: 'oauth', excludeProblemId: PROBLEM }).excludeProblemId,
    ).toBe(PROBLEM);
  });

  describe('the query text', () => {
    it.each([
      ['empty', ''],
      ['spaces', '    '],
      ['a tab and a newline', '\t\n'],
    ])('is refused when it is %s', (_label, text) => {
      // Refused rather than answered with an empty list. PostgreSQL would parse
      // this into a query matching nothing, so both are defensible — but "you
      // asked for nothing" and "nothing matched" are different answers, and a
      // caller that sent a blank string by accident should be told.
      expect(() => resolveFullTextSearchQuery({ text })).toThrow(InvalidFullTextSearchError);
    });

    it('is accepted at its bound and refused past it', () => {
      const atBound = 'a'.repeat(MAX_SEARCH_TEXT_LENGTH);
      expect(resolveFullTextSearchQuery({ text: atBound }).text).toHaveLength(
        MAX_SEARCH_TEXT_LENGTH,
      );

      expect(() =>
        resolveFullTextSearchQuery({ text: 'a'.repeat(MAX_SEARCH_TEXT_LENGTH + 1) }),
      ).toThrow(InvalidFullTextSearchError);
    });

    it('keeps punctuation and case, which the parser handles', () => {
      // Nothing is stripped or folded here. The web-search grammar understands
      // quotes, `OR` and a leading minus, and `simple` lowercases lexemes
      // itself — doing either here would be guessing at the parser's job.
      const text = '"@fastify/swagger" OR node.js -deprecated';
      expect(resolveFullTextSearchQuery({ text }).text).toBe(text);
    });
  });

  describe('the limit', () => {
    it('defaults to twenty and accepts its whole range', () => {
      expect(DEFAULT_SEARCH_LIMIT).toBe(20);
      expect(resolveFullTextSearchQuery({ text: 'a', limit: 1 }).limit).toBe(1);
      expect(resolveFullTextSearchQuery({ text: 'a', limit: MAX_SEARCH_LIMIT }).limit).toBe(
        MAX_SEARCH_LIMIT,
      );
    });

    it.each([
      ['zero', 0],
      ['negative', -1],
      ['past the maximum', MAX_SEARCH_LIMIT + 1],
      ['fractional', 2.5],
      ['not a number', Number.NaN],
      ['infinite', Number.POSITIVE_INFINITY],
    ])('is refused when it is %s', (_label, limit) => {
      // An unbounded read is the failure this prevents: without it, one call
      // could ask for every artifact an owner has.
      expect(() => resolveFullTextSearchQuery({ text: 'oauth', limit })).toThrow(
        InvalidFullTextSearchError,
      );
    });
  });

  describe('the error a refusal raises', () => {
    it('names the field and never the query', () => {
      // Synthetic, and shaped like something somebody might genuinely search
      // for while looking up a Memory about a credential.
      const text = `API_KEY=fake-Jj0Wc6L-0123456789abcdef ${'x'.repeat(MAX_SEARCH_TEXT_LENGTH)}`;
      let raised: unknown;
      try {
        resolveFullTextSearchQuery({ text });
      } catch (error) {
        raised = error;
      }

      expect(raised).toBeInstanceOf(InvalidFullTextSearchError);
      const message = (raised as Error).message;
      // Booleans, so a failure prints `true` rather than the query it was
      // checking.
      expect(message.includes('Jj0Wc6L'), 'the error quoted the query').toBe(false);
      expect((raised as InvalidFullTextSearchError).field).toBe('text');
    });
  });
});
