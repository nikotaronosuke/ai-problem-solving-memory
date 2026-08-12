import { describe, expect, it } from 'vitest';

import { normaliseOptionalText } from '../../src/domain/text.js';

describe('normaliseOptionalText', () => {
  it('collapses absent and blank values to a single null', () => {
    expect(normaliseOptionalText(undefined)).toBeNull();
    expect(normaliseOptionalText(null)).toBeNull();
    expect(normaliseOptionalText('')).toBeNull();
    expect(normaliseOptionalText('   ')).toBeNull();
    expect(normaliseOptionalText('\t\n')).toBeNull();
  });

  it('trims a value that carries something', () => {
    expect(normaliseOptionalText('  github.com/example/repo  ')).toBe('github.com/example/repo');
  });

  it('accepts any shape, since these fields are free-form', () => {
    expect(normaliseOptionalText('ios')).toBe('ios');
    expect(normaliseOptionalText('/local/path/without/remote')).toBe('/local/path/without/remote');
    expect(normaliseOptionalText('git@example.com:team/repo.git')).toBe(
      'git@example.com:team/repo.git',
    );
    expect(normaliseOptionalText('build / native boundary')).toBe('build / native boundary');
  });
});
