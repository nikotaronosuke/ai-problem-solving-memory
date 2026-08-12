import { describe, expect, it } from 'vitest';

import {
  InvalidProblemFieldError,
  InvalidProblemIdError,
  generateProblemId,
  isProblemId,
  toProblemId,
  toProblemSymptoms,
  toProblemTitle,
} from '../../src/domain/problem.js';

/** Synthetic UUIDs. Never a real id from anyone's environment. */
const VALID_UUID = '5d41402a-bc4b-4a76-b971-9d911017c592';
const VALID_UUID_UPPER = '5D41402A-BC4B-4A76-B971-9D911017C592';

describe('toProblemId', () => {
  it('accepts a UUID', () => {
    expect(toProblemId(VALID_UUID)).toBe(VALID_UUID);
  });

  it('normalises case and whitespace', () => {
    expect(toProblemId(VALID_UUID_UPPER)).toBe(VALID_UUID);
    expect(toProblemId(`  ${VALID_UUID}  `)).toBe(VALID_UUID);
  });

  it.each([
    ['an empty value', ''],
    ['a blank value', '   '],
    ['arbitrary text', 'problem-1'],
    ['a truncated UUID', '5d41402a-bc4b-4a76-b971'],
    ['the nil UUID', '00000000-0000-0000-0000-000000000000'],
  ])('rejects %s', (_label, value) => {
    expect(() => toProblemId(value)).toThrow(InvalidProblemIdError);
  });

  it('does not echo the rejected value', () => {
    const looksLikeASecret = 'sk-live-not-a-real-token-2f8c';

    try {
      toProblemId(looksLikeASecret);
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(looksLikeASecret);
    }
  });
});

describe('isProblemId', () => {
  it('recognises a normalised problem id', () => {
    expect(isProblemId(VALID_UUID)).toBe(true);
  });

  it('rejects non-strings and malformed values', () => {
    expect(isProblemId(undefined)).toBe(false);
    expect(isProblemId(42)).toBe(false);
    expect(isProblemId('problem-1')).toBe(false);
    expect(isProblemId(VALID_UUID_UPPER)).toBe(false);
  });
});

describe('generateProblemId', () => {
  it('issues ids the validator accepts', () => {
    const id = generateProblemId();

    expect(isProblemId(id)).toBe(true);
    expect(toProblemId(id)).toBe(id);
  });

  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateProblemId()));

    expect(ids.size).toBe(50);
  });
});

describe('toProblemTitle', () => {
  it('accepts a title', () => {
    expect(toProblemTitle('Build fails on clean checkout')).toBe('Build fails on clean checkout');
  });

  it('trims surrounding whitespace', () => {
    expect(toProblemTitle('  Build fails  ')).toBe('Build fails');
  });

  it.each([
    ['an empty string', ''],
    ['spaces only', '   '],
    ['a tab only', '\t'],
    ['a newline only', '\n'],
  ])('rejects %s, since an untitled problem cannot be recognised later', (_label, value) => {
    expect(() => toProblemTitle(value)).toThrow(InvalidProblemFieldError);
  });

  it('names the field it rejected', () => {
    try {
      toProblemTitle('');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as InvalidProblemFieldError).field).toBe('title');
    }
  });
});

describe('toProblemSymptoms', () => {
  it('accepts a description', () => {
    expect(toProblemSymptoms('Crashes on launch')).toBe('Crashes on launch');
  });

  it('trims surrounding whitespace', () => {
    expect(toProblemSymptoms('  Crashes on launch  ')).toBe('Crashes on launch');
  });

  it('keeps prose describing several symptoms, rather than requiring a list', () => {
    const several = 'Build fails on CI.\nLocally it succeeds.\nOnly on the release branch.';

    expect(toProblemSymptoms(several)).toBe(several);
  });

  it.each([
    ['an empty string', ''],
    ['spaces only', '   '],
    ['a newline only', '\n'],
  ])('rejects %s', (_label, value) => {
    expect(() => toProblemSymptoms(value)).toThrow(InvalidProblemFieldError);
  });

  it('names the field it rejected', () => {
    try {
      toProblemSymptoms('  ');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as InvalidProblemFieldError).field).toBe('symptoms');
    }
  });
});
