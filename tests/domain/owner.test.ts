import { describe, expect, it } from 'vitest';

import {
  InvalidOwnerIdError,
  createOwnerContext,
  generateOwnerId,
  isOwnerId,
  toOwnerId,
} from '../../src/domain/owner.js';

/** Synthetic UUIDs. Never a real owner id from anyone's environment. */
const VALID_UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const VALID_UUID_UPPER = '3F2504E0-4F89-41D3-9A0C-0305E82C3301';

describe('toOwnerId', () => {
  it('accepts a UUID', () => {
    expect(toOwnerId(VALID_UUID)).toBe(VALID_UUID);
  });

  it('normalises case, so a database round trip compares equal', () => {
    expect(toOwnerId(VALID_UUID_UPPER)).toBe(VALID_UUID);
  });

  it('trims surrounding whitespace', () => {
    expect(toOwnerId(`  ${VALID_UUID}  `)).toBe(VALID_UUID);
  });

  it('rejects an empty or blank value', () => {
    expect(() => toOwnerId('')).toThrow(InvalidOwnerIdError);
    expect(() => toOwnerId('   ')).toThrow(InvalidOwnerIdError);
  });

  it.each([
    ['arbitrary text', 'owner-1'],
    ['a numeric id', '12345'],
    ['a provider-style id', 'github|1234567'],
    ['an email', 'someone@example.com'],
    ['a truncated UUID', '3f2504e0-4f89-41d3-9a0c'],
    ['a UUID with a bad separator', '3f2504e0f89441d39a0c0305e82c3301'],
    ['a non-hex character', '3f2504e0-4f89-41d3-9a0c-0305e82c330g'],
    ['the nil UUID', '00000000-0000-0000-0000-000000000000'],
    ['an invalid variant nibble', '3f2504e0-4f89-41d3-0a0c-0305e82c3301'],
  ])('rejects %s', (_label, value) => {
    expect(() => toOwnerId(value)).toThrow(InvalidOwnerIdError);
  });

  it('does not echo the rejected value, which may not be safe to print', () => {
    const looksLikeASecret = 'sk-live-not-a-real-token-2f8c';

    try {
      toOwnerId(looksLikeASecret);
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(looksLikeASecret);
    }
  });
});

describe('isOwnerId', () => {
  it('recognises a normalised owner id', () => {
    expect(isOwnerId(VALID_UUID)).toBe(true);
  });

  it('rejects non-strings and malformed values', () => {
    expect(isOwnerId(undefined)).toBe(false);
    expect(isOwnerId(null)).toBe(false);
    expect(isOwnerId(42)).toBe(false);
    expect(isOwnerId('owner-1')).toBe(false);
    // Not normalised, so not yet an owner id.
    expect(isOwnerId(VALID_UUID_UPPER)).toBe(false);
  });
});

describe('generateOwnerId', () => {
  it('issues ids the validator accepts', () => {
    const id = generateOwnerId();

    expect(isOwnerId(id)).toBe(true);
    expect(toOwnerId(id)).toBe(id);
  });

  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateOwnerId()));

    expect(ids.size).toBe(50);
  });
});

describe('createOwnerContext', () => {
  it('carries the owner it was built for', () => {
    const ownerId = toOwnerId(VALID_UUID);

    expect(createOwnerContext(ownerId).ownerId).toBe(ownerId);
  });
});
