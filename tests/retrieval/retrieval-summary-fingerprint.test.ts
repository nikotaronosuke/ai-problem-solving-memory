/**
 * The digest, and what a generated summary has to look like to be believed.
 *
 * Nothing here touches a database. These are the two pure questions in the
 * task: whether the same source always produces the same name, and whether an
 * arbitrary value returned by something outside this process can be turned into
 * a draft.
 *
 * The second one is worth being blunt about. A generator is a model behind an
 * interface. It can return a string, an array, an object missing half its
 * fields, an object with a field nobody defined, twenty-five keywords, a
 * four-thousand-character summary, or a confident claim that a fix worked on a
 * Problem that was never verified. Every one of those is checked here, because
 * a type annotation asserting the shape would be an assertion about something
 * this code cannot see.
 *
 * What is *not* claimed: that any of this makes the words true. A well-formed
 * summary of a version that was never mentioned passes every check below. That
 * is measured by evaluation fixtures against real generators, and calling it
 * prevented here would be a claim this file cannot support.
 */

import { describe, expect, it } from 'vitest';

import {
  fingerprintRetrievalSource,
  InvalidRetrievalSummaryError,
  MAX_KEYWORDS,
  MAX_KEYWORD_LENGTH,
  MAX_NORMALIZED_SUMMARY_LENGTH,
  MAX_STRUCTURAL_FEATURE_ITEMS,
  MAX_STRUCTURAL_FEATURE_LENGTH,
  RETRIEVAL_SOURCE_FINGERPRINT_PREFIX,
  STRUCTURAL_FEATURE_LISTS,
  STRUCTURAL_FEATURE_SCHEMA_VERSION,
  toGeneratedRetrievalSummary,
  toRetrievalSummaryDraft,
} from '../../src/domain/retrieval-summary.js';
import type { ProblemId } from '../../src/domain/problem.js';

/** A structurally valid feature object, before whatever a test breaks in it. */
function featuresWith(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: STRUCTURAL_FEATURE_SCHEMA_VERSION,
    problem_domain: 'deployment',
    symptom_patterns: ['a request succeeds locally and fails once deployed'],
    suspected_boundaries: ['configuration read at build time rather than run time'],
    occurrence_conditions: ['only in the deployed environment'],
    successful_directions: [],
    dead_end_directions: ['raising the timeout'],
    environment_facts: ['node 22.12.0'],
    ...overrides,
  };
}

function outputWith(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    normalizedSummary: 'a callback fails only after deployment, because the host is baked in',
    keywords: ['callback', 'deployment'],
    structuralFeatures: featuresWith(),
    ...overrides,
  };
}

describe('the source digest', () => {
  it('names the schema it was taken under', () => {
    expect(fingerprintRetrievalSource('{"schema_version":"1"}')).toMatch(
      new RegExp(`^${RETRIEVAL_SOURCE_FINGERPRINT_PREFIX}:[0-9a-f]{64}$`),
    );
  });

  it('is the same for the same bytes', () => {
    const document = '{"schema_version":"1","problem":{"title":"a"}}';
    expect(fingerprintRetrievalSource(document)).toBe(fingerprintRetrievalSource(document));
  });

  it('differs for any difference at all', () => {
    // Including one that changes nothing about the meaning. That is the point
    // of hashing the exact document rather than a chosen list of fields: the
    // digest answers "were these the same bytes?", and a generation is only
    // reusable when the generator would have seen exactly the same thing.
    expect(fingerprintRetrievalSource('{"a":1}')).not.toBe(fingerprintRetrievalSource('{"a":2}'));
    expect(fingerprintRetrievalSource('{"a":1}')).not.toBe(fingerprintRetrievalSource('{"a":1} '));
  });

  it('separates values that differ only in characters above the ASCII range', () => {
    // Hashed as UTF-8 rather than through any lossy narrowing.
    expect(fingerprintRetrievalSource('{"s":"café"}')).not.toBe(
      fingerprintRetrievalSource('{"s":"cafe"}'),
    );
  });
});

describe('reading what a generator returned', () => {
  it('accepts a well-formed summary', () => {
    const summary = toGeneratedRetrievalSummary(outputWith(), false);

    expect(summary.normalizedSummary).toContain('deployment');
    expect(summary.keywords).toEqual(['callback', 'deployment']);
    expect(summary.structuralFeatures.problem_domain).toBe('deployment');
    expect(summary.structuralFeatures.dead_end_directions).toEqual(['raising the timeout']);
  });

  it.each([
    ['a string', 'a summary'],
    ['null', null],
    ['an array', [{ normalizedSummary: 'x' }]],
    ['a number', 4],
  ])('refuses %s in place of an object', (_label, generated) => {
    expect(() => toGeneratedRetrievalSummary(generated, false)).toThrow(
      InvalidRetrievalSummaryError,
    );
  });

  describe('the summary itself', () => {
    it.each([
      ['missing', { normalizedSummary: undefined }],
      ['not a string', { normalizedSummary: 42 }],
      ['blank', { normalizedSummary: '   \t\n' }],
      ['empty', { normalizedSummary: '' }],
    ])('is refused when it is %s', (_label, override) => {
      expect(() => toGeneratedRetrievalSummary(outputWith(override), false)).toThrow(
        InvalidRetrievalSummaryError,
      );
    });

    it('is refused past its bound rather than cut to fit', () => {
      const tooLong = 'a'.repeat(MAX_NORMALIZED_SUMMARY_LENGTH + 1);
      expect(() =>
        toGeneratedRetrievalSummary(outputWith({ normalizedSummary: tooLong }), false),
      ).toThrow(InvalidRetrievalSummaryError);

      // A summary cut at the limit stops mid-sentence and reads as though the
      // generator meant to stop there.
      const atBound = 'a'.repeat(MAX_NORMALIZED_SUMMARY_LENGTH);
      expect(
        toGeneratedRetrievalSummary(outputWith({ normalizedSummary: atBound }), false)
          .normalizedSummary,
      ).toHaveLength(MAX_NORMALIZED_SUMMARY_LENGTH);
    });

    it('accepts a short one, because a simple Problem has a short summary', () => {
      expect(
        toGeneratedRetrievalSummary(
          outputWith({ normalizedSummary: 'a typo in a host name' }),
          true,
        ).normalizedSummary,
      ).toBe('a typo in a host name');
    });
  });

  describe('the keywords', () => {
    it('are trimmed, and keep the case they were written in', () => {
      const summary = toGeneratedRetrievalSummary(
        outputWith({ keywords: ['  PostgreSQL  ', 'Node.js'] }),
        false,
      );

      // Case is left alone: the full-text search these feed normalises them
      // itself, and folding here would discard the original spelling to
      // duplicate work that is done properly downstream.
      expect(summary.keywords).toEqual(['PostgreSQL', 'Node.js']);
    });

    it('drop an exact repeat, keeping the first', () => {
      const summary = toGeneratedRetrievalSummary(
        outputWith({ keywords: ['deployment', 'callback', 'deployment', ' deployment '] }),
        false,
      );

      expect(summary.keywords).toEqual(['deployment', 'callback']);
    });

    it('keep two spellings that differ only in case, because they are two words here', () => {
      const summary = toGeneratedRetrievalSummary(
        outputWith({ keywords: ['PostgreSQL', 'postgresql'] }),
        false,
      );

      expect(summary.keywords).toEqual(['PostgreSQL', 'postgresql']);
    });

    it('are counted after repeats are removed', () => {
      // A generator repeating itself produced fewer keywords than it looked
      // like, not too many.
      const keywords = [
        ...Array.from({ length: MAX_KEYWORDS }, (_, index) => `keyword ${String(index)}`),
        'keyword 0',
      ];

      expect(toGeneratedRetrievalSummary(outputWith({ keywords }), false).keywords).toHaveLength(
        MAX_KEYWORDS,
      );
    });

    it('are refused past their bound rather than cut to fit', () => {
      const keywords = Array.from({ length: MAX_KEYWORDS + 1 }, (_, index) => `k${String(index)}`);
      expect(() => toGeneratedRetrievalSummary(outputWith({ keywords }), false)).toThrow(
        InvalidRetrievalSummaryError,
      );
    });

    it.each([
      ['not an array', 'callback'],
      ['holding a blank entry', ['callback', '   ']],
      ['holding a non-string', ['callback', 7]],
      ['missing', undefined],
    ])('are refused when %s', (_label, keywords) => {
      expect(() => toGeneratedRetrievalSummary(outputWith({ keywords }), false)).toThrow(
        InvalidRetrievalSummaryError,
      );
    });

    it('are refused when one is longer than its bound', () => {
      const keywords = ['a'.repeat(MAX_KEYWORD_LENGTH + 1)];
      expect(() => toGeneratedRetrievalSummary(outputWith({ keywords }), false)).toThrow(
        InvalidRetrievalSummaryError,
      );
    });

    it('accept an empty list, which is a real answer', () => {
      expect(toGeneratedRetrievalSummary(outputWith({ keywords: [] }), false).keywords).toEqual([]);
    });
  });

  describe('the structural features', () => {
    it('refuse a field nobody defined', () => {
      // Dropped rather than refused would hide a generator answering a
      // question that was not asked.
      expect(() =>
        toGeneratedRetrievalSummary(
          outputWith({ structuralFeatures: featuresWith({ severity: 'high' }) }),
          false,
        ),
      ).toThrow(InvalidRetrievalSummaryError);
    });

    it.each(STRUCTURAL_FEATURE_LISTS)('refuse %s when it is missing', (field) => {
      const features = featuresWith();
      delete features[field];

      expect(() =>
        toGeneratedRetrievalSummary(outputWith({ structuralFeatures: features }), false),
      ).toThrow(InvalidRetrievalSummaryError);
    });

    it.each(STRUCTURAL_FEATURE_LISTS)('refuse %s when it is null', (field) => {
      // Null is not an empty list. "Nothing to say here" and "this question
      // went unanswered" look the same afterwards, and only one is a summary
      // worth keeping.
      expect(() =>
        toGeneratedRetrievalSummary(
          outputWith({ structuralFeatures: featuresWith({ [field]: null }) }),
          false,
        ),
      ).toThrow(InvalidRetrievalSummaryError);
    });

    it('refuse a schema version this code does not produce', () => {
      expect(() =>
        toGeneratedRetrievalSummary(
          outputWith({ structuralFeatures: featuresWith({ schema_version: '2' }) }),
          false,
        ),
      ).toThrow(InvalidRetrievalSummaryError);
    });

    it('accept a null problem domain, and refuse a blank one', () => {
      expect(
        toGeneratedRetrievalSummary(
          outputWith({ structuralFeatures: featuresWith({ problem_domain: null }) }),
          false,
        ).structuralFeatures.problem_domain,
      ).toBeNull();

      expect(() =>
        toGeneratedRetrievalSummary(
          outputWith({ structuralFeatures: featuresWith({ problem_domain: '  ' }) }),
          false,
        ),
      ).toThrow(InvalidRetrievalSummaryError);
    });

    it('are refused past their bounds rather than cut to fit', () => {
      const tooMany = Array.from({ length: MAX_STRUCTURAL_FEATURE_ITEMS + 1 }, (_, index) =>
        String(index),
      );
      expect(() =>
        toGeneratedRetrievalSummary(
          outputWith({ structuralFeatures: featuresWith({ symptom_patterns: tooMany }) }),
          false,
        ),
      ).toThrow(InvalidRetrievalSummaryError);

      const tooLong = ['a'.repeat(MAX_STRUCTURAL_FEATURE_LENGTH + 1)];
      expect(() =>
        toGeneratedRetrievalSummary(
          outputWith({ structuralFeatures: featuresWith({ symptom_patterns: tooLong }) }),
          false,
        ),
      ).toThrow(InvalidRetrievalSummaryError);
    });

    it('hold structural language rather than a list of technologies', () => {
      // Not enforceable by code, and asserted as an example rather than a
      // rule: what matters for the phase's acceptance condition is that the
      // vocabulary is free-form enough to say why two problems in different
      // technologies are the same problem.
      const summary = toGeneratedRetrievalSummary(
        outputWith({
          structuralFeatures: featuresWith({
            suspected_boundaries: ['state read before the component that owns it finished writing'],
          }),
        }),
        false,
      );

      expect(summary.structuralFeatures.suspected_boundaries[0]).toContain('before');
    });
  });

  describe('the successful-direction gate', () => {
    it('accepts a claim when the Problem is verified by a successful Verification', () => {
      const summary = toGeneratedRetrievalSummary(
        outputWith({
          structuralFeatures: featuresWith({
            successful_directions: ['read the host at run time instead of at build time'],
          }),
        }),
        true,
      );

      expect(summary.structuralFeatures.successful_directions).toHaveLength(1);
    });

    it('refuses a claim when the record does not support one', () => {
      // The claim being refused is the whole reason the gate exists. Nothing
      // in the data model links a FIX Event to a Verification, so "this is what
      // worked" cannot be read out of storage — only assumed, and an assumption
      // written into a summary reads as evidence to whoever finds it later.
      expect(() =>
        toGeneratedRetrievalSummary(
          outputWith({
            structuralFeatures: featuresWith({
              successful_directions: ['the fix that was recorded last'],
            }),
          }),
          false,
        ),
      ).toThrow(InvalidRetrievalSummaryError);
    });

    it('refuses rather than quietly emptying the list', () => {
      // Clearing it would leave a normalized summary that had been written
      // around a claim the features no longer make, and would hide that the
      // generator asserted something unsupported.
      let raised: unknown;
      try {
        toGeneratedRetrievalSummary(
          outputWith({
            structuralFeatures: featuresWith({ successful_directions: ['something'] }),
          }),
          false,
        );
      } catch (error) {
        raised = error;
      }

      expect(raised).toBeInstanceOf(InvalidRetrievalSummaryError);
      expect((raised as InvalidRetrievalSummaryError).field).toBe('successful directions');
    });

    it('accepts an empty list on an unverified Problem', () => {
      expect(
        toGeneratedRetrievalSummary(outputWith(), false).structuralFeatures.successful_directions,
      ).toEqual([]);
    });

    it('accepts an empty list on a verified one too', () => {
      // Verified does not oblige a generator to name a direction. It only
      // permits one.
      expect(
        toGeneratedRetrievalSummary(outputWith(), true).structuralFeatures.successful_directions,
      ).toEqual([]);
    });
  });

  describe('the error a refusal raises', () => {
    it('names the field and never the value', () => {
      const secretish = 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/fakeAa1Qv7X0123456789';
      let raised: unknown;
      try {
        toGeneratedRetrievalSummary(
          outputWith({ keywords: [secretish, 7] }),
          // The refusal here is the number, but the error must not be able to
          // carry the neighbour either.
          false,
        );
      } catch (error) {
        raised = error;
      }

      expect(raised).toBeInstanceOf(InvalidRetrievalSummaryError);
      const message = (raised as Error).message;
      expect(message.includes('Aa1Qv7X'), 'the error quoted a value').toBe(false);
      expect(message).toContain('keyword at 1');
    });
  });
});

describe('assembling the draft', () => {
  it('takes the identity and the digest from the caller, not the generator', () => {
    // A generator naming its own Problem could name the wrong one, and a
    // generator reporting its own source state could report a state it did not
    // read. Both are facts the caller already holds.
    const summary = toGeneratedRetrievalSummary(outputWith(), false);
    const problemId = 'e2b0c1a4-0000-4000-8000-000000000001' as ProblemId;

    const draft = toRetrievalSummaryDraft(problemId, 'retrieval-source-v1:abc', summary);

    expect(draft.problemId).toBe(problemId);
    expect(draft.sourceFingerprint).toBe('retrieval-source-v1:abc');
    expect(draft.normalizedSummary).toBe(summary.normalizedSummary);
    expect(Object.keys(draft).sort()).toEqual([
      'keywords',
      'normalizedSummary',
      'problemId',
      'sourceFingerprint',
      'structuralFeatures',
    ]);
  });

  it('carries no embedding, no model and no generation time', () => {
    // An artifact's `generated_at` describes the moment its complete content
    // existed, and that moment has not arrived while the embedding is still
    // missing. Naming one here would be a second, different timestamp.
    const draft = toRetrievalSummaryDraft(
      'e2b0c1a4-0000-4000-8000-000000000002' as ProblemId,
      'retrieval-source-v1:abc',
      toGeneratedRetrievalSummary(outputWith(), false),
    );

    for (const absent of ['embedding', 'embeddingModel', 'embeddingModelVersion', 'generatedAt']) {
      expect(Object.hasOwn(draft, absent), `${absent} is on the draft`).toBe(false);
    }
  });
});
