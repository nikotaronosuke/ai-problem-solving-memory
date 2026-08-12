import { describe, expect, it } from 'vitest';

import * as domainEnums from '../../src/domain/enums.js';
import { ENUM_DOMAIN_BINDINGS } from '../../src/db/enum-domains.js';

/**
 * Every value set exported by the domain module, found by inspection rather
 * than by a second hand-written list. A new set added there but never bound to
 * a database DOMAIN fails the coverage test below.
 */
const allExports: Record<string, unknown> = domainEnums;
const exportedValueSets = Object.entries(allExports).filter(
  (entry): entry is [string, readonly string[]] => Array.isArray(entry[1]),
);

describe('enum domain bindings', () => {
  it('binds every exported domain value set to a database DOMAIN', () => {
    const boundValueSets = new Set(ENUM_DOMAIN_BINDINGS.map((binding) => binding.values));
    const unbound = exportedValueSets
      .filter(([, values]) => !boundValueSets.has(values))
      .map(([name]) => name);

    expect(unbound).toEqual([]);
    expect(ENUM_DOMAIN_BINDINGS).toHaveLength(exportedValueSets.length);
  });

  it('uses a distinct DOMAIN and constraint name for each set', () => {
    const domainNames = ENUM_DOMAIN_BINDINGS.map((binding) => binding.domainName);
    const constraintNames = ENUM_DOMAIN_BINDINGS.map((binding) => binding.constraintName);

    expect(new Set(domainNames).size).toBe(domainNames.length);
    expect(new Set(constraintNames).size).toBe(constraintNames.length);
  });

  it('uses identifiers safe to interpolate into SQL', () => {
    for (const binding of ENUM_DOMAIN_BINDINGS) {
      expect(binding.domainName).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(binding.constraintName).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('carries a non-empty value set for each binding', () => {
    for (const binding of ENUM_DOMAIN_BINDINGS) {
      expect(binding.values.length).toBeGreaterThan(0);
    }
  });
});
