import { describe, expect, it } from 'vitest';

import {
  CONFIDENCES,
  EVENT_TYPES,
  FIX_KINDS,
  FRESHNESSES,
  PROBLEM_STATUSES,
  VERIFICATION_TYPES,
} from '../../src/domain/enums.js';

/**
 * Written out literally rather than derived, so that an accidental edit to the
 * source tuples fails here instead of quietly redefining the specification.
 */
const EXPECTED = {
  PROBLEM_STATUSES: ['INVESTIGATING', 'FIX_CANDIDATE', 'VERIFIED', 'PAUSED', 'CLOSED_UNRESOLVED'],
  FIX_KINDS: ['ROOT_FIX', 'WORKAROUND'],
  EVENT_TYPES: ['HYPOTHESIS', 'ATTEMPT', 'DEAD_END', 'DISCOVERY', 'FIX', 'USER_CORRECTION'],
  VERIFICATION_TYPES: [
    'TEST',
    'REAL_DEVICE',
    'BUILD',
    'API_RESULT',
    'DB_RESULT',
    'USER_CONFIRMATION',
  ],
  CONFIDENCES: ['HIGH', 'MEDIUM', 'LOW', 'CONFLICTED'],
  FRESHNESSES: ['CURRENT', 'STALE_UNKNOWN', 'SUPERSEDED', 'INVALID'],
} as const;

const ALL_SETS: readonly (readonly [string, readonly string[]])[] = [
  ['PROBLEM_STATUSES', PROBLEM_STATUSES],
  ['FIX_KINDS', FIX_KINDS],
  ['EVENT_TYPES', EVENT_TYPES],
  ['VERIFICATION_TYPES', VERIFICATION_TYPES],
  ['CONFIDENCES', CONFIDENCES],
  ['FRESHNESSES', FRESHNESSES],
];

describe('domain value sets', () => {
  it('matches the specification exactly, including order', () => {
    expect(PROBLEM_STATUSES).toEqual(EXPECTED.PROBLEM_STATUSES);
    expect(FIX_KINDS).toEqual(EXPECTED.FIX_KINDS);
    expect(EVENT_TYPES).toEqual(EXPECTED.EVENT_TYPES);
    expect(VERIFICATION_TYPES).toEqual(EXPECTED.VERIFICATION_TYPES);
    expect(CONFIDENCES).toEqual(EXPECTED.CONFIDENCES);
    expect(FRESHNESSES).toEqual(EXPECTED.FRESHNESSES);
  });

  it.each(ALL_SETS)('%s contains no duplicates', (_name, values) => {
    expect(new Set(values).size).toBe(values.length);
  });

  it.each(ALL_SETS)('%s uses SCREAMING_SNAKE_CASE with no padding', (_name, values) => {
    for (const value of values) {
      expect(value).toMatch(/^[A-Z][A-Z_]*[A-Z]$/);
      expect(value).toBe(value.trim());
    }
  });

  it('keeps the sets disjoint where the specification treats them as separate axes', () => {
    // FIX appears as an EventType; ROOT_FIX / WORKAROUND are a separate axis.
    expect(FIX_KINDS).not.toContain('FIX');
    // Confidence and freshness are deliberately independent.
    const freshnessValues: readonly string[] = FRESHNESSES;
    expect(CONFIDENCES.some((value) => freshnessValues.includes(value))).toBe(false);
  });
});
