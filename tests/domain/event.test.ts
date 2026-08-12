import { describe, expect, it } from 'vitest';

import {
  InvalidClientEventIdError,
  generateClientEventId,
  isClientEventId,
  toClientEventId,
} from '../../src/domain/client-event-id.js';
import {
  InvalidEventFieldError,
  InvalidEventIdError,
  generateEventId,
  isEventId,
  toEventId,
  toEventSummary,
} from '../../src/domain/event.js';

/** Synthetic UUIDs. Never a real id from anyone's environment. */
const VALID_UUID = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
const VALID_UUID_UPPER = '6BA7B810-9DAD-41D1-80B4-00C04FD430C8';

const INVALID_IDS: readonly (readonly [string, string])[] = [
  ['an empty value', ''],
  ['a blank value', '   '],
  ['arbitrary text', 'event-1'],
  ['a truncated UUID', '6ba7b810-9dad-41d1-80b4'],
  ['the nil UUID', '00000000-0000-0000-0000-000000000000'],
];

describe('toEventId', () => {
  it('accepts a UUID', () => {
    expect(toEventId(VALID_UUID)).toBe(VALID_UUID);
  });

  it('normalises case and whitespace', () => {
    expect(toEventId(VALID_UUID_UPPER)).toBe(VALID_UUID);
    expect(toEventId(`  ${VALID_UUID}  `)).toBe(VALID_UUID);
  });

  it.each(INVALID_IDS)('rejects %s', (_label, value) => {
    expect(() => toEventId(value)).toThrow(InvalidEventIdError);
  });

  it('does not echo the rejected value', () => {
    const looksLikeASecret = 'sk-live-not-a-real-token-2f8c';

    try {
      toEventId(looksLikeASecret);
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(looksLikeASecret);
    }
  });
});

describe('isEventId', () => {
  it('recognises a normalised event id', () => {
    expect(isEventId(VALID_UUID)).toBe(true);
  });

  it('rejects non-strings and malformed values', () => {
    expect(isEventId(undefined)).toBe(false);
    expect(isEventId(42)).toBe(false);
    expect(isEventId('event-1')).toBe(false);
    expect(isEventId(VALID_UUID_UPPER)).toBe(false);
  });
});

describe('generateEventId', () => {
  it('issues ids the validator accepts', () => {
    const id = generateEventId();

    expect(isEventId(id)).toBe(true);
    expect(toEventId(id)).toBe(id);
  });

  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateEventId()));

    expect(ids.size).toBe(50);
  });
});

describe('toClientEventId', () => {
  it('accepts a UUID', () => {
    expect(toClientEventId(VALID_UUID)).toBe(VALID_UUID);
  });

  it('normalises case and whitespace', () => {
    expect(toClientEventId(VALID_UUID_UPPER)).toBe(VALID_UUID);
    expect(toClientEventId(`  ${VALID_UUID}  `)).toBe(VALID_UUID);
  });

  it.each(INVALID_IDS)('rejects %s', (_label, value) => {
    expect(() => toClientEventId(value)).toThrow(InvalidClientEventIdError);
  });

  it('does not echo the rejected value', () => {
    const looksLikeASecret = 'sk-live-not-a-real-token-2f8c';

    try {
      toClientEventId(looksLikeASecret);
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(looksLikeASecret);
    }
  });
});

describe('isClientEventId', () => {
  it('recognises a normalised client event id', () => {
    expect(isClientEventId(VALID_UUID)).toBe(true);
    expect(isClientEventId('client-1')).toBe(false);
  });
});

describe('generateClientEventId', () => {
  it('issues ids the validator accepts', () => {
    const id = generateClientEventId();

    expect(isClientEventId(id)).toBe(true);
    expect(toClientEventId(id)).toBe(id);
  });

  it('does not repeat, so two separate writes are never confused', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateClientEventId()));

    expect(ids.size).toBe(50);
  });
});

describe('toEventSummary', () => {
  it('accepts a description of what happened', () => {
    expect(toEventSummary('Suspected the bundler cache')).toBe('Suspected the bundler cache');
  });

  it('trims surrounding whitespace', () => {
    expect(toEventSummary('  Suspected the bundler cache  ')).toBe('Suspected the bundler cache');
  });

  it.each([
    ['an empty string', ''],
    ['spaces only', '   '],
    ['a tab only', '\t'],
    ['a newline only', '\n'],
  ])('rejects %s, since it records that something happened but not what', (_label, value) => {
    expect(() => toEventSummary(value)).toThrow(InvalidEventFieldError);
  });

  it('names the field it rejected', () => {
    try {
      toEventSummary('  ');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as InvalidEventFieldError).field).toBe('summary');
    }
  });
});
