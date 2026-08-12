import { describe, expect, it } from 'vitest';

import { isClientEventId, generateClientEventId } from '../../src/domain/client-event-id.js';
import { normaliseOptionalText } from '../../src/domain/text.js';
import {
  InvalidVerificationFieldError,
  InvalidVerificationIdError,
  generateVerificationId,
  isVerificationId,
  toVerificationId,
  toVerificationSummary,
} from '../../src/domain/verification.js';

/** Synthetic UUIDs. Never a real id from anyone's environment. */
const VALID_UUID = 'c56a4180-65aa-42ec-a945-5fd21dec0538';
const VALID_UUID_UPPER = 'C56A4180-65AA-42EC-A945-5FD21DEC0538';

describe('toVerificationId', () => {
  it('accepts a UUID', () => {
    expect(toVerificationId(VALID_UUID)).toBe(VALID_UUID);
  });

  it('normalises case and whitespace', () => {
    expect(toVerificationId(VALID_UUID_UPPER)).toBe(VALID_UUID);
    expect(toVerificationId(`  ${VALID_UUID}  `)).toBe(VALID_UUID);
  });

  it.each([
    ['an empty value', ''],
    ['a blank value', '   '],
    ['arbitrary text', 'verification-1'],
    ['a truncated UUID', 'c56a4180-65aa-42ec-a945'],
    ['the nil UUID', '00000000-0000-0000-0000-000000000000'],
  ])('rejects %s', (_label, value) => {
    expect(() => toVerificationId(value)).toThrow(InvalidVerificationIdError);
  });

  it('does not echo the rejected value', () => {
    const looksLikeASecret = 'sk-live-not-a-real-token-2f8c';

    try {
      toVerificationId(looksLikeASecret);
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(looksLikeASecret);
    }
  });
});

describe('isVerificationId', () => {
  it('recognises a normalised verification id', () => {
    expect(isVerificationId(VALID_UUID)).toBe(true);
  });

  it('rejects non-strings and malformed values', () => {
    expect(isVerificationId(undefined)).toBe(false);
    expect(isVerificationId(42)).toBe(false);
    expect(isVerificationId('verification-1')).toBe(false);
    expect(isVerificationId(VALID_UUID_UPPER)).toBe(false);
  });
});

describe('generateVerificationId', () => {
  it('issues ids the validator accepts', () => {
    const id = generateVerificationId();

    expect(isVerificationId(id)).toBe(true);
    expect(toVerificationId(id)).toBe(id);
  });

  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateVerificationId()));

    expect(ids.size).toBe(50);
  });
});

describe('toVerificationSummary', () => {
  it('accepts an account of what was checked', () => {
    expect(toVerificationSummary('Full suite green on CI')).toBe('Full suite green on CI');
  });

  it('trims surrounding whitespace', () => {
    expect(toVerificationSummary('  Full suite green on CI  ')).toBe('Full suite green on CI');
  });

  it.each([
    ['an empty string', ''],
    ['spaces only', '   '],
    ['a tab only', '\t'],
    ['a newline only', '\n'],
  ])('rejects %s', (_label, value) => {
    expect(() => toVerificationSummary(value)).toThrow(InvalidVerificationFieldError);
  });

  it('names the field it rejected', () => {
    try {
      toVerificationSummary('  ');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as InvalidVerificationFieldError).field).toBe('summary');
    }
  });
});

describe('optional verification fields', () => {
  it('collapses an unknown verifier to null rather than a placeholder', () => {
    expect(normaliseOptionalText(undefined)).toBeNull();
    expect(normaliseOptionalText('   ')).toBeNull();
    expect(normaliseOptionalText('  vitest  ')).toBe('vitest');
  });

  it('collapses a blank evidence reference to null', () => {
    expect(normaliseOptionalText('')).toBeNull();
    expect(normaliseOptionalText('  ci/run/1841  ')).toBe('ci/run/1841');
  });
});

describe('client event id', () => {
  it('is the same shared type Events use, not a verification-specific one', () => {
    const id = generateClientEventId();

    expect(isClientEventId(id)).toBe(true);
  });
});
