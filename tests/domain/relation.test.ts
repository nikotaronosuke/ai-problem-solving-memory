/**
 * Relation identity and field rules, on their own.
 *
 * No database and no HTTP: what a relation id is, what a reason must be, and
 * the one structural rule that holds regardless of relation type.
 */

import { describe, expect, it } from 'vitest';

import { RELATION_TYPES } from '../../src/domain/enums.js';
import {
  generateRelationId,
  InvalidRelationFieldError,
  InvalidRelationIdError,
  isRelationId,
  isSelfRelation,
  toRelationId,
  toRelationReason,
} from '../../src/domain/relation.js';

describe('relation id', () => {
  it('issues a normalised UUID', () => {
    const id = generateRelationId();

    expect(isRelationId(id)).toBe(true);
    expect(id).toBe(id.toLowerCase());
  });

  it('issues a different one each time', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateRelationId()));

    expect(ids.size).toBe(50);
  });

  it('accepts a well-formed id, normalising case', () => {
    const id = generateRelationId().toUpperCase();

    expect(toRelationId(id)).toBe(id.toLowerCase());
  });

  it('accepts one padded with whitespace', () => {
    const id = generateRelationId();

    expect(toRelationId(`  ${id}  `)).toBe(id);
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['not a UUID', 'relation-1'],
    ['a truncated UUID', '3f2504e0-4f89-41d3-9a0c'],
    ['a UUID with extra characters', `${'3f2504e0-4f89-41d3-9a0c-0305e82c3301'}x`],
  ])('refuses one that is %s', (_label, value) => {
    expect(() => toRelationId(value)).toThrow(InvalidRelationIdError);
  });

  it('never echoes the value it refused', () => {
    // An error message is a place a bad value can end up in a log.
    expect(() => toRelationId('secret-looking-value')).toThrow(
      /^Not a usable relation id: it is not a UUID\.$/,
    );
  });

  it.each([
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
    ['an object', {}],
  ])('does not consider %s a relation id', (_label, value) => {
    expect(isRelationId(value)).toBe(false);
  });
});

describe('relation reason', () => {
  it('keeps what was written, trimmed', () => {
    expect(toRelationReason('  Same stale-session symptoms.  ')).toBe(
      'Same stale-session symptoms.',
    );
  });

  it.each([
    ['empty', ''],
    ['spaces', '   '],
    ['a tab', '\t'],
    ['a newline', '\n'],
  ])('refuses a reason that is %s', (_label, value) => {
    // A link nobody can account for later is a link nobody can act on.
    expect(() => toRelationReason(value)).toThrow(InvalidRelationFieldError);
  });

  it('names the field it refused', () => {
    try {
      toRelationReason('');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidRelationFieldError);
      expect((error as InvalidRelationFieldError).field).toBe('reason');
    }
  });

  it('does not impose a taxonomy', () => {
    // Free text on purpose: what makes two problems worth linking is not yet
    // known well enough to enumerate.
    const prose = 'Both fail only behind the CDN, and the earlier fix was reverted.';

    expect(toRelationReason(prose)).toBe(prose);
  });
});

describe('self relation', () => {
  it('recognises a problem linked to itself', () => {
    expect(isSelfRelation('a', 'a')).toBe(true);
  });

  it('allows two different problems', () => {
    expect(isSelfRelation('a', 'b')).toBe(false);
  });

  it('is independent of the relation type', () => {
    // Not similar to, caused by or a replacement for itself under any of the
    // six meanings, so the rule takes no type and needs no per-type
    // exception — which is the point worth stating.
    expect(RELATION_TYPES).toHaveLength(6);
    expect(isSelfRelation.length).toBe(2);
  });
});

describe('relation types', () => {
  it('are exactly the six the specification names', () => {
    expect([...RELATION_TYPES]).toEqual([
      'SIMILAR_TO',
      'RELATED_TO',
      'CAUSED_BY',
      'SUPERSEDES',
      'CONTRADICTS',
      'DERIVED_FROM',
    ]);
  });
});
