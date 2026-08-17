/**
 * What the client's types promise, checked by the compiler rather than at run
 * time.
 *
 * Every other test in this package runs. These do not, in the sense that
 * matters: their assertions are discharged by `tsc`, and the run is only what
 * reports that the file compiled. That is the point — the defect this file
 * exists for is invisible to a running test.
 *
 * P5-02c-impl-2's formal review found it. `MemorySearchStructuralFeatures`
 * declared `schema_version: string` while the validator required exactly `'1'`,
 * so this compiled:
 *
 *     const features: MemorySearchStructuralFeatures = { schema_version: '999', … };
 *
 * and failed at run time. Every runtime test still passed, because every runtime
 * test that sends a wrong version asserts it is *refused* — which it was. The
 * mismatch was between the contract the client mirrors and the contract its own
 * types describe, and only the compiler can see that.
 *
 * Two shapes are used, and each catches something the other does not:
 *
 * - `expectTypeOf(...).toEqualTypeOf<'1'>()` fails if the type is widened *or*
 *   narrowed to something else. It is an equality, not an assignability check,
 *   so `string` fails it.
 * - `@ts-expect-error` on a wrong version fails if the error stops happening —
 *   which is exactly what widening the field back to `string` would do. tsc
 *   reports an unused directive, so loosening the type breaks the build rather
 *   than quietly passing it.
 *
 * No new dependency: `expectTypeOf` ships with the test runner already in use,
 * and `@ts-expect-error` is the language's own.
 */

import { describe, expectTypeOf, it } from 'vitest';

import {
  MEMORY_SEARCH_STRUCTURAL_FEATURE_SCHEMA_VERSION,
  type MemorySearchRequest,
  type MemorySearchStructuralFeatures,
} from '../src/index.js';

/** The six lists, at their emptiest, so each case below is about one field. */
const LISTS = {
  symptom_patterns: [],
  suspected_boundaries: [],
  occurrence_conditions: [],
  successful_directions: [],
  dead_end_directions: [],
  environment_facts: [],
} as const;

describe('the structural feature vocabulary, as a type', () => {
  it('is the one version and nothing else', () => {
    expectTypeOf<MemorySearchStructuralFeatures['schema_version']>().toEqualTypeOf<'1'>();
  });

  it('is the same value the runtime check compares against', () => {
    // The type and the validator read one constant. This is what makes the
    // chain hold end to end: the server's own constant, the client's mirror of
    // it (compared in the server's drift suite), this public type, and the
    // runtime check are four things and one value.
    expectTypeOf<MemorySearchStructuralFeatures['schema_version']>().toEqualTypeOf<
      typeof MEMORY_SEARCH_STRUCTURAL_FEATURE_SCHEMA_VERSION
    >();
  });

  it('accepts a features block written against the contract', () => {
    // The annotation is the assertion: a block built from the constant compiles.
    // Closing the field would be worthless if it also refused the one value the
    // contract names.
    const features: MemorySearchStructuralFeatures = {
      schema_version: MEMORY_SEARCH_STRUCTURAL_FEATURE_SCHEMA_VERSION,
      problem_domain: null,
      ...LISTS,
    };

    void features;
  });

  it('refuses a version this client does not speak, at compile time', () => {
    const features: MemorySearchStructuralFeatures = {
      // @ts-expect-error a version other than the contract's is not this type
      schema_version: '999',
      problem_domain: null,
      ...LISTS,
    };

    void features;
  });

  it('refuses a version chosen at run time, at compile time', () => {
    const fromSomewhereElse: string = String(Math.trunc(2));

    const features: MemorySearchStructuralFeatures = {
      // @ts-expect-error a plain string is not the one version either
      schema_version: fromSomewhereElse,
      problem_domain: null,
      ...LISTS,
    };

    void features;
  });

  it('carries the same closure into a whole request', () => {
    // The field is reached through `MemorySearchRequest`, which is the type a
    // caller actually writes against. A closed field on a type nobody uses
    // would be a promise kept somewhere nobody looks.
    expectTypeOf<MemorySearchRequest['current_features']['schema_version']>().toEqualTypeOf<'1'>();

    const request: MemorySearchRequest = {
      source_ai: 'some-assistant',
      lexical_text: 'deployment configuration',
      semantic_text: 'the app works locally but fails once deployed',
      current_features: {
        // @ts-expect-error the closure survives one level of nesting
        schema_version: '2',
        problem_domain: null,
        ...LISTS,
      },
    };

    void request;
  });
});
