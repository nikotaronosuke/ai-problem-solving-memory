/**
 * A search resolver for suites that are not about search.
 *
 * `buildMemoryHttpApp` takes the resolver as a required dependency, because the
 * search operation is part of the API rather than part of a deployment's
 * configuration — see the field's own comment. That makes every HTTP suite pass
 * one, including the thirty-odd that were written years of decisions before
 * search existed and test something else entirely.
 *
 * This is what they pass. It resolves nothing: any call is a test reaching a
 * route it did not mean to reach, and failing loudly there is far better than
 * handing back an empty result that looks like an answer.
 *
 * Note what it is not. It is not a stand-in provider — production has none, and
 * must not: the two provider ports are optional all the way down, so a server
 * with neither configured still serves this route from the lexical channel.
 * This is a transport-level seam filler, in `tests/`, for suites whose subject
 * is a different route.
 */

import type { RetrievalSearchServiceResolver } from '../../src/app/index.js';

export function createUnusedSearchResolver(): RetrievalSearchServiceResolver {
  return {
    resolve() {
      return Promise.reject(
        new Error('A suite that does not test search reached the search route.'),
      );
    },
  };
}
