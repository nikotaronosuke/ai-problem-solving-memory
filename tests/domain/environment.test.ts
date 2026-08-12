import { describe, expect, it } from 'vitest';

import {
  InvalidEnvironmentIdError,
  InvalidEnvironmentSnapshotError,
  generateEnvironmentId,
  isEnvironmentId,
  isEnvironmentSnapshot,
  toEnvironmentId,
  toEnvironmentSnapshot,
} from '../../src/domain/environment.js';

/** Synthetic UUIDs. Never a real id from anyone's environment. */
const VALID_UUID = '9b2f1c4e-6d3a-4b8e-9f10-2c5d7e8a1b34';
const VALID_UUID_UPPER = '9B2F1C4E-6D3A-4B8E-9F10-2C5D7E8A1B34';

describe('toEnvironmentId', () => {
  it('accepts a UUID', () => {
    expect(toEnvironmentId(VALID_UUID)).toBe(VALID_UUID);
  });

  it('normalises case and whitespace', () => {
    expect(toEnvironmentId(VALID_UUID_UPPER)).toBe(VALID_UUID);
    expect(toEnvironmentId(`  ${VALID_UUID}  `)).toBe(VALID_UUID);
  });

  it.each([
    ['an empty value', ''],
    ['a blank value', '   '],
    ['arbitrary text', 'environment-1'],
    ['a truncated UUID', '9b2f1c4e-6d3a-4b8e-9f10'],
    ['the nil UUID', '00000000-0000-0000-0000-000000000000'],
  ])('rejects %s', (_label, value) => {
    expect(() => toEnvironmentId(value)).toThrow(InvalidEnvironmentIdError);
  });

  it('does not echo the rejected value', () => {
    const looksLikeASecret = 'sk-live-not-a-real-token-2f8c';

    try {
      toEnvironmentId(looksLikeASecret);
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(looksLikeASecret);
    }
  });
});

describe('isEnvironmentId', () => {
  it('recognises a normalised environment id', () => {
    expect(isEnvironmentId(VALID_UUID)).toBe(true);
  });

  it('rejects non-strings and malformed values', () => {
    expect(isEnvironmentId(undefined)).toBe(false);
    expect(isEnvironmentId(42)).toBe(false);
    expect(isEnvironmentId('environment-1')).toBe(false);
    expect(isEnvironmentId(VALID_UUID_UPPER)).toBe(false);
  });
});

describe('generateEnvironmentId', () => {
  it('issues ids the validator accepts', () => {
    const id = generateEnvironmentId();

    expect(isEnvironmentId(id)).toBe(true);
    expect(toEnvironmentId(id)).toBe(id);
  });

  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateEnvironmentId()));

    expect(ids.size).toBe(50);
  });
});

describe('toEnvironmentSnapshot', () => {
  it('accepts an object of relevant conditions', () => {
    const snapshot = {
      os: 'macOS 15.2',
      runtime: 'node 22.12.0',
      framework: 'react-native 0.76',
      branch: 'main',
      commit: 'a1b2c3d',
    };

    expect(toEnvironmentSnapshot(snapshot)).toEqual(snapshot);
  });

  it('accepts an empty object, meaning nothing relevant has been captured yet', () => {
    expect(toEnvironmentSnapshot({})).toEqual({});
  });

  it('accepts nesting, since conditions are not all flat', () => {
    const snapshot = { versions: { node: '22.12.0', pnpm: '9.0.0' }, tags: ['ios', 'release'] };

    expect(toEnvironmentSnapshot(snapshot)).toEqual(snapshot);
  });

  it.each([
    ['an array', []],
    ['a populated array', [{ os: 'linux' }]],
    ['a string', 'macOS 15.2'],
    ['a number', 42],
    ['a boolean', true],
    ['null', null],
    ['undefined', undefined],
  ])('rejects %s at the top level', (_label, value) => {
    expect(() => toEnvironmentSnapshot(value)).toThrow(InvalidEnvironmentSnapshotError);
  });

  it('says what it got, without inventing a value', () => {
    expect(() => toEnvironmentSnapshot([])).toThrow(/array/);
    expect(() => toEnvironmentSnapshot(null)).toThrow(/null/);
    expect(() => toEnvironmentSnapshot('text')).toThrow(/string/);
  });
});

describe('isEnvironmentSnapshot', () => {
  it('distinguishes an object from an array or a scalar', () => {
    expect(isEnvironmentSnapshot({})).toBe(true);
    expect(isEnvironmentSnapshot({ os: 'linux' })).toBe(true);
    expect(isEnvironmentSnapshot([])).toBe(false);
    expect(isEnvironmentSnapshot(null)).toBe(false);
    expect(isEnvironmentSnapshot('linux')).toBe(false);
    expect(isEnvironmentSnapshot(1)).toBe(false);
  });
});
