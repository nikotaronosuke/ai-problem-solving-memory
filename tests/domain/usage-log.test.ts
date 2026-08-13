/**
 * Usage log identity and field rules, on their own.
 *
 * No database and no HTTP: what a usage log id is, and which of its text
 * fields must say something. `result` is the interesting one — null and blank
 * are different answers, and only one of them is allowed.
 */

import { describe, expect, it } from 'vitest';

import { USAGE_ACTIONS } from '../../src/domain/enums.js';
import {
  generateUsageLogId,
  InvalidUsageLogFieldError,
  InvalidUsageLogIdError,
  isUsageLogId,
  toUsageLogId,
  toUsageReason,
  toUsageResult,
  toUsageSourceAi,
} from '../../src/domain/usage-log.js';

describe('usage log id', () => {
  it('issues a normalised UUID', () => {
    const id = generateUsageLogId();

    expect(isUsageLogId(id)).toBe(true);
    expect(id).toBe(id.toLowerCase());
  });

  it('issues a different one each time', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateUsageLogId()));

    expect(ids.size).toBe(50);
  });

  it('accepts a well-formed id, normalising case and whitespace', () => {
    const id = generateUsageLogId();

    expect(toUsageLogId(`  ${id.toUpperCase()}  `)).toBe(id);
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['not a UUID', 'usage-1'],
    ['a truncated UUID', '3f2504e0-4f89-41d3-9a0c'],
  ])('refuses one that is %s', (_label, value) => {
    expect(() => toUsageLogId(value)).toThrow(InvalidUsageLogIdError);
  });

  it('never echoes the value it refused', () => {
    expect(() => toUsageLogId('secret-looking-value')).toThrow(
      /^Not a usable usage log id: it is not a UUID\.$/,
    );
  });

  it.each([
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
    ['an object', {}],
  ])('does not consider %s a usage log id', (_label, value) => {
    expect(isUsageLogId(value)).toBe(false);
  });
});

describe('source ai', () => {
  it('keeps what was written, trimmed', () => {
    expect(toUsageSourceAi('  claude-code  ')).toBe('claude-code');
  });

  it.each(['claude-code', 'codex', 'chatgpt', 'claude-ai', 'manual'])('accepts %s', (name) => {
    // Free-form on purpose: provider and model names change, and manual and
    // imported entries exist alongside AI ones.
    expect(toUsageSourceAi(name)).toBe(name);
  });

  it.each([
    ['empty', ''],
    ['spaces', '   '],
    ['a tab', '\t'],
    ['a newline', '\n'],
  ])('refuses one that is %s', (_label, value) => {
    // An entry that does not say who used the memory answers nothing.
    expect(() => toUsageSourceAi(value)).toThrow(InvalidUsageLogFieldError);
  });

  it('names the field it refused', () => {
    try {
      toUsageSourceAi('');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as InvalidUsageLogFieldError).field).toBe('source_ai');
    }
  });
});

describe('reason', () => {
  it('keeps what was written, trimmed', () => {
    expect(toUsageReason('  Same auth boundary.  ')).toBe('Same auth boundary.');
  });

  it.each([
    ['empty', ''],
    ['spaces', '   '],
    ['a tab', '\t'],
  ])('refuses one that is %s', (_label, value) => {
    // Without it the log is a hit counter, and the question worth answering
    // later is whether the memory deserved to be used.
    expect(() => toUsageReason(value)).toThrow(InvalidUsageLogFieldError);
  });

  it('names the field it refused', () => {
    try {
      toUsageReason('   ');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as InvalidUsageLogFieldError).field).toBe('reason');
    }
  });
});

describe('result', () => {
  it('keeps what was written, trimmed', () => {
    expect(toUsageResult('  It worked.  ')).toBe('It worked.');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('treats %s as no outcome yet', (_label, value) => {
    // The ordinary state for a memory that was merely found or read.
    // Inventing an outcome would be worse than leaving it open.
    expect(toUsageResult(value)).toBeNull();
  });

  it.each([
    ['empty', ''],
    ['spaces', '   '],
    ['a tab', '\t'],
  ])('refuses one that is %s', (_label, value) => {
    // Blank is not the same as null: it would record that there was a result
    // and that it was nothing.
    expect(() => toUsageResult(value)).toThrow(InvalidUsageLogFieldError);
  });

  it('names the field it refused', () => {
    try {
      toUsageResult('');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as InvalidUsageLogFieldError).field).toBe('result');
    }
  });
});

describe('usage actions', () => {
  it('are exactly the five the specification names', () => {
    expect([...USAGE_ACTIONS]).toEqual([
      'SEARCHED',
      'REFERENCED',
      'ADOPTED',
      'EXCLUDED',
      'CHANGED_STRATEGY',
    ]);
  });

  it('carry no order between them', () => {
    // Observations, not stages. Nothing in the domain relates one action to
    // another, so an adapter that only ever reports ADOPTED is recording
    // something true rather than skipping a step.
    const domainModule = Object.keys({ toUsageSourceAi, toUsageReason, toUsageResult });

    expect(domainModule).not.toContain('nextAction');
    expect(domainModule).not.toContain('canTransitionTo');
  });
});
