/**
 * What may be stored as a repository boundary.
 *
 * `repo` and `platform` are labels: nothing compares them in order to decide
 * anything, so anything a person typed is as good as anything else. This is
 * compared — two Projects on one repository are told apart by it — which makes
 * a nearly-right value worse than a refused one. `apps/web/` and `/apps/web`
 * look like boundaries and match no session at all.
 *
 * So the rule is that the value is already canonical, and a value that is not
 * is refused rather than tidied. Refusing is the honest half: quietly rewriting
 * a path would store a boundary the owner did not declare.
 */

import { describe, expect, it } from 'vitest';

import {
  InvalidProjectFieldError,
  toOptionalProjectRepoSubpath,
  toProjectRepoSubpath,
} from '../../src/domain/project.js';

describe('a boundary that is already repository-relative', () => {
  it.each([
    ['one segment', 'apps'],
    ['two segments', 'apps/web'],
    ['several segments', 'services/payments/worker'],
    ['a single character', 'a'],
    ['spaces, which directories legitimately have', 'a b/c d'],
    ['a dot inside a segment', 'apps/web.old'],
    ['a leading dot on a segment', 'apps/.config'],
    ['characters beyond ASCII', 'サービス/決済'],
    ['a hyphenated neighbour of another boundary', 'apps/web-old'],
  ])('accepts %s', (_name, value) => {
    expect(toProjectRepoSubpath(value)).toBe(value);
  });

  it('returns exactly what it was given, with nothing trimmed or rewritten', () => {
    // Not `path.normalize`, not `path.resolve`, not a trim. Any of those would
    // store a boundary that differs from the one somebody declared.
    const value = 'apps/web';
    expect(toProjectRepoSubpath(value)).toBe(value);
  });
});

describe('a boundary that is not', () => {
  it.each([
    ['empty', ''],
    ['a leading separator', '/apps/web'],
    ['a trailing separator', 'apps/web/'],
    ['both', '/apps/web/'],
    ['an empty segment', 'apps//web'],
    ['a current-directory segment', 'apps/./web'],
    ['a parent segment', 'apps/../web'],
    ['a leading parent segment', '../web'],
    ['a bare current directory', '.'],
    ['a bare parent directory', '..'],
    ['a trailing parent segment', 'apps/..'],
    ['a Windows separator', 'apps\\web'],
    ['a Windows absolute path', 'C:\\Users\\someone\\checkout'],
    ['a POSIX absolute path', '/home/someone/checkout'],
    ['only separators', '//'],
  ])('refuses %s', (_name, value) => {
    expect(() => toProjectRepoSubpath(value)).toThrow(InvalidProjectFieldError);
  });

  it('names the field and never the value it refused', () => {
    // A rejected path is still somebody's path, and an error message is the
    // least controlled place a value can end up.
    const planted = '/home/someone-private/clients/acme/checkout';

    try {
      toProjectRepoSubpath(planted);
      expect.unreachable('an absolute path must be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidProjectFieldError);
      expect((error as InvalidProjectFieldError).field).toBe('repository boundary');
      expect((error as Error).message.includes(planted)).toBe(false);
      expect((error as Error).message.includes('someone-private')).toBe(false);
    }
  });
});

describe('an optional boundary', () => {
  it('treats absent and null alike as no boundary', () => {
    expect(toOptionalProjectRepoSubpath(undefined)).toBeNull();
    expect(toOptionalProjectRepoSubpath(null)).toBeNull();
  });

  it('validates a value that is there', () => {
    expect(toOptionalProjectRepoSubpath('apps/web')).toBe('apps/web');
  });

  it('refuses an empty string rather than reading it as no boundary', () => {
    // Unlike the free-form text fields, empty is not a way of saying "the
    // whole repository" — `null` says that, and an empty value is a caller
    // mistake worth reporting.
    expect(() => toOptionalProjectRepoSubpath('')).toThrow(InvalidProjectFieldError);
  });

  it('accepts a value made of spaces, because that is a directory somebody could have', () => {
    // Not trimmed and not refused. A segment of spaces is a legal directory
    // name, and the database constraint takes the same view — an application
    // rule stricter than the column it writes to is a rule that surfaces as a
    // mystery later.
    expect(toOptionalProjectRepoSubpath('   ')).toBe('   ');
  });
});
