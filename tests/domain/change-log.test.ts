/**
 * Change log identity and how a change is described, on their own.
 *
 * The substance here is the redaction rule. A controlled value keeps its
 * before and after; free text does not, and what survives instead is enough to
 * follow the shape of an edit without carrying its contents. Getting that
 * wrong would mean a value removed from a Problem later still sitting in its
 * history.
 */

import { describe, expect, it } from 'vitest';

import {
  exactChange,
  generateChangeLogId,
  hasChanges,
  InvalidChangeLogFieldError,
  InvalidChangeLogIdError,
  isChangeLogId,
  redactedTextChange,
  toChangedBy,
  toChangeLogId,
} from '../../src/domain/change-log.js';

describe('change log id', () => {
  it('issues a normalised UUID', () => {
    const id = generateChangeLogId();

    expect(isChangeLogId(id)).toBe(true);
    expect(id).toBe(id.toLowerCase());
  });

  it('issues a different one each time', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateChangeLogId()));

    expect(ids.size).toBe(50);
  });

  it('accepts a well-formed id, normalising case and whitespace', () => {
    const id = generateChangeLogId();

    expect(toChangeLogId(`  ${id.toUpperCase()}  `)).toBe(id);
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['not a UUID', 'change-1'],
    ['a truncated UUID', '3f2504e0-4f89-41d3-9a0c'],
  ])('refuses one that is %s', (_label, value) => {
    expect(() => toChangeLogId(value)).toThrow(InvalidChangeLogIdError);
  });

  it('never echoes the value it refused', () => {
    expect(() => toChangeLogId('secret-looking-value')).toThrow(
      /^Not a usable change log id: it is not a UUID\.$/,
    );
  });

  it.each([
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
  ])('does not consider %s a change log id', (_label, value) => {
    expect(isChangeLogId(value)).toBe(false);
  });
});

describe('changed by', () => {
  it('keeps what was written, trimmed', () => {
    expect(toChangedBy('  claude-code  ')).toBe('claude-code');
  });

  it.each(['claude-code', 'codex', 'chatgpt', 'manual'])('accepts %s', (name) => {
    // Free-form: assistant and tool names change, and manual edits exist too.
    expect(toChangedBy(name)).toBe(name);
  });

  it.each([
    ['empty', ''],
    ['spaces', '   '],
    ['a tab', '\t'],
    ['a newline', '\n'],
  ])('refuses one that is %s', (_label, value) => {
    // An entry that cannot say who changed something answers half the
    // question it exists to answer.
    expect(() => toChangedBy(value)).toThrow(InvalidChangeLogFieldError);
  });

  it('names the field it refused', () => {
    try {
      toChangedBy('');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as InvalidChangeLogFieldError).field).toBe('changed_by');
    }
  });
});

describe('a controlled value', () => {
  it('keeps its before and after exactly', () => {
    expect(exactChange('LOW', 'HIGH')).toEqual({ kind: 'exact', before: 'LOW', after: 'HIGH' });
  });

  it.each([
    ['booleans', false, true],
    ['a value becoming absent', 'ROOT_FIX', null],
    ['a value arriving', null, 'WORKAROUND'],
    ['a value that did not move', 'CURRENT', 'CURRENT'],
  ])('records %s', (_label, before, after) => {
    expect(exactChange(before, after)).toEqual({ kind: 'exact', before, after });
  });
});

describe('a free-text value', () => {
  it('is described without its contents', () => {
    const change = redactedTextChange('a secret token', 'a different secret token');

    // The whole point: nothing of either value survives here, so removing it
    // from the Problem later is not undone by a copy in the history.
    expect(change).toEqual({
      kind: 'text_redacted',
      before_present: true,
      after_present: true,
      changed: true,
    });
    expect(JSON.stringify(change)).not.toContain('secret');
  });

  it('distinguishes clearing from replacing', () => {
    expect(redactedTextChange('something', null)).toMatchObject({
      before_present: true,
      after_present: false,
      changed: true,
    });
    expect(redactedTextChange(null, 'something')).toMatchObject({
      before_present: false,
      after_present: true,
      changed: true,
    });
  });

  it('says when the value did not actually move', () => {
    // Writing the same text again is a real thing that happens, and the
    // history should not imply otherwise.
    expect(redactedTextChange('same', 'same')).toMatchObject({ changed: false });
    expect(redactedTextChange(null, null)).toMatchObject({
      before_present: false,
      after_present: false,
      changed: false,
    });
  });

  it('carries no field that could hold the text', () => {
    const change = redactedTextChange('before value', 'after value');

    expect(Object.keys(change).sort()).toEqual([
      'after_present',
      'before_present',
      'changed',
      'kind',
    ]);
  });
});

describe('whether a change says anything', () => {
  it('is false for nothing', () => {
    expect(hasChanges({})).toBe(false);
  });

  it('is true once a field is described', () => {
    expect(hasChanges({ confidence: exactChange('LOW', 'HIGH') })).toBe(true);
  });
});
