import { describe, expect, it } from 'vitest';

import {
  InvalidProjectFieldError,
  InvalidProjectIdError,
  generateProjectId,
  isProjectId,
  toProjectId,
  toProjectName,
} from '../../src/domain/project.js';

/** Synthetic UUIDs. Never a real id from anyone's environment. */
const VALID_UUID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const VALID_UUID_UPPER = '7C9E6679-7425-40DE-944B-E07FC1F90AE7';

describe('toProjectId', () => {
  it('accepts a UUID', () => {
    expect(toProjectId(VALID_UUID)).toBe(VALID_UUID);
  });

  it('normalises case and whitespace', () => {
    expect(toProjectId(VALID_UUID_UPPER)).toBe(VALID_UUID);
    expect(toProjectId(`  ${VALID_UUID}  `)).toBe(VALID_UUID);
  });

  it.each([
    ['an empty value', ''],
    ['a blank value', '   '],
    ['arbitrary text', 'project-1'],
    ['a repository URL', 'https://github.com/example/repo'],
    ['a truncated UUID', '7c9e6679-7425-40de-944b'],
    ['the nil UUID', '00000000-0000-0000-0000-000000000000'],
  ])('rejects %s', (_label, value) => {
    expect(() => toProjectId(value)).toThrow(InvalidProjectIdError);
  });

  it('does not echo the rejected value', () => {
    const looksLikeASecret = 'sk-live-not-a-real-token-2f8c';

    try {
      toProjectId(looksLikeASecret);
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(looksLikeASecret);
    }
  });
});

describe('isProjectId', () => {
  it('recognises a normalised project id', () => {
    expect(isProjectId(VALID_UUID)).toBe(true);
  });

  it('rejects non-strings and malformed values', () => {
    expect(isProjectId(undefined)).toBe(false);
    expect(isProjectId(42)).toBe(false);
    expect(isProjectId('project-1')).toBe(false);
    expect(isProjectId(VALID_UUID_UPPER)).toBe(false);
  });
});

describe('generateProjectId', () => {
  it('issues ids the validator accepts', () => {
    const id = generateProjectId();

    expect(isProjectId(id)).toBe(true);
    expect(toProjectId(id)).toBe(id);
  });

  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateProjectId()));

    expect(ids.size).toBe(50);
  });
});

describe('toProjectName', () => {
  it('accepts a name', () => {
    expect(toProjectName('memory-service')).toBe('memory-service');
  });

  it('trims, so names differing only by padding are the same name', () => {
    expect(toProjectName('  memory-service  ')).toBe('memory-service');
  });

  it.each([
    ['an empty string', ''],
    ['spaces only', '   '],
    ['a tab only', '\t'],
    ['a newline only', '\n'],
  ])('rejects %s', (_label, value) => {
    expect(() => toProjectName(value)).toThrow(InvalidProjectFieldError);
  });

  it('imposes no length limit yet', () => {
    const long = 'a'.repeat(500);

    expect(toProjectName(long)).toBe(long);
  });
});

// `repo` and `platform` are normalised by the shared helper, covered in
// `tests/domain/text.test.ts`.
