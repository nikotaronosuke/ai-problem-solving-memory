/**
 * The checklist, and the promise that it does not shrink.
 *
 * The specification says an assistant re-checks the current code, environment,
 * versions and official specification before acting on a Memory — and says
 * separately that this is not skipped for a well-verified Memory or an
 * important one. So the interesting property here is not what the list
 * contains but what cannot change it: no `freshness`, no confidence, no
 * proximity, and no caller.
 *
 * The last of those is why the array is frozen rather than merely `readonly`.
 * One array is shared by every candidate of every search in the process; a
 * type that vanishes at compile time is not what stops somebody emptying it.
 */

import { describe, expect, it } from 'vitest';

import {
  REVALIDATION_CHECKS,
  type RevalidationCheck,
} from '../../src/domain/retrieval-revalidation.js';

describe('what must be re-established', () => {
  it('is the specification’s own four', () => {
    // Not a taxonomy invented here, and not a superset — extra checks would be
    // this system inventing obligations for an assistant it knows nothing
    // about.
    expect([...REVALIDATION_CHECKS]).toEqual([
      'CURRENT_CODE',
      'CURRENT_ENVIRONMENT',
      'RELEVANT_VERSION',
      'OFFICIAL_SPEC',
    ]);
    expect(REVALIDATION_CHECKS).toHaveLength(4);
  });

  it('cannot be changed at run time', () => {
    // `readonly` documents the intent and is gone once this compiles. One
    // caller emptying this array would quietly change what every later search
    // in the process asks for.
    expect(Object.isFrozen(REVALIDATION_CHECKS)).toBe(true);

    const mutable = REVALIDATION_CHECKS as unknown as RevalidationCheck[];
    expect(() => mutable.push('CURRENT_CODE')).toThrow();
    expect(() => mutable.splice(0, 1)).toThrow();
    expect(() => {
      mutable[0] = 'OFFICIAL_SPEC';
    }).toThrow();

    expect([...REVALIDATION_CHECKS]).toEqual([
      'CURRENT_CODE',
      'CURRENT_ENVIRONMENT',
      'RELEVANT_VERSION',
      'OFFICIAL_SPEC',
    ]);
  });

  it('says nothing about how to check, or to whom', () => {
    // The server says what to re-establish. How — a shell, a browser, a
    // package manifest, a person — is the assistant's own capability, and
    // naming one here would tie a vendor-neutral contract to a vendor.
    const words = REVALIDATION_CHECKS.join(' ').toLowerCase();
    for (const vendor of ['claude', 'codex', 'chatgpt', 'mcp', 'browser', 'shell', 'please']) {
      expect(words.includes(vendor), `the checklist names ${vendor}`).toBe(false);
    }
  });
});
