/**
 * Turning this host's configuration into a Memory client.
 *
 * That is the whole of what an adapter package is for, and at this point it is
 * the whole of what this one does. There is no MCP server here, no tool, no
 * transport, no hook and no notion of a project or a session: each of those
 * belongs to a task that has a reason for it, and a package that shipped empty
 * versions of them now would be shipping guesses that later tasks have to
 * argue with.
 *
 * ## Where the credential comes from
 *
 * The environment, and only the environment. It is not in this repository, not
 * in a settings file this package writes, and not in anything a model can see:
 * a value in the process environment reaches the adapter and stops there,
 * which is the shortest path there is between a person's own secret store and
 * an `Authorization` header.
 *
 * ## Which rules live here
 *
 * Exactly one: whether the variable was set. Everything about whether the
 * *values* mean anything — that a base URL is a URL, that it carries no
 * credential of its own, that a credential is not blank — belongs to the
 * client factory and is not repeated here. The division is real rather than
 * cosmetic: "you have not configured this host" is something only the host's
 * adapter can say, and "this is not a usable base URL" is true wherever the
 * value came from.
 */

import {
  createMemoryApiClient,
  type FetchLike,
  type MemoryApiClient,
} from '@ai-problem-solving-memory/api-client';

/** Where the Memory Server is, if it is not on the default loopback address. */
export const MEMORY_API_URL_ENV = 'MEMORY_API_URL';

/** The Memory credential. Required; there is no default and cannot be one. */
export const MEMORY_API_TOKEN_ENV = 'MEMORY_API_TOKEN';

/**
 * Raised when the credential variable is not set at all.
 *
 * Names the variable, never a value — there is no value, which is the point,
 * and the next version of this mistake is a variable holding something that
 * should not be read back out either.
 */
export class MissingMemoryCredentialError extends Error {
  readonly variable: string;

  constructor() {
    super(`${MEMORY_API_TOKEN_ENV} is not set, so no Memory credential is available.`);
    this.name = 'MissingMemoryCredentialError';
    this.variable = MEMORY_API_TOKEN_ENV;
  }
}

/** What this adapter reads from the environment. */
export interface ClaudeCodeMemoryEnvironment {
  readonly [key: string]: string | undefined;
}

/**
 * Builds the Memory client this host will use.
 *
 * Returns a `MemoryApiClient` and nothing else. There is deliberately no
 * configuration object beside it: a returned `{ client, credential, baseUrl }`
 * would be convenient exactly once and would then be the reason a credential
 * is in a diagnostic dump, so the credential leaves this function only inside
 * the client that presents it.
 *
 * Reading `process.env` by default and taking it as an argument is what lets a
 * test set one variable without setting it for the process — and what keeps
 * this function from being the thing that decides where an environment comes
 * from.
 */
export function createClaudeCodeMemoryClient(
  environment: ClaudeCodeMemoryEnvironment = process.env,
  fetch?: FetchLike,
): MemoryApiClient {
  const credential = environment[MEMORY_API_TOKEN_ENV];
  if (credential === undefined) {
    throw new MissingMemoryCredentialError();
  }

  const baseUrl = environment[MEMORY_API_URL_ENV];

  return createMemoryApiClient({
    credential,
    // Absent means the client's own default, which is loopback. Passing
    // `undefined` explicitly would be refused by `exactOptionalPropertyTypes`,
    // and rightly: "unset" and "set to nothing" are different claims.
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(fetch === undefined ? {} : { fetch }),
  });
}
