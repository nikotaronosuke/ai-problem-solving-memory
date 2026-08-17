/**
 * The client for the Memory JSON API.
 *
 * ## What this is for
 *
 * The Memory Server's JSON API is the contract every assistant reaches the
 * Memory through. This package is the one place that knows how to speak it —
 * how a path is built, where the credential goes, what a refusal looks like —
 * so that an adapter for a particular assistant contains only what is
 * particular to that assistant.
 *
 * Nothing here knows which assistant is calling. No host, no protocol, no
 * model, no session: those belong to an adapter, and a guard in the server's
 * test suite fails if one of them appears in this package.
 *
 * ## No generic escape hatch
 *
 * There is no public `request(path, init)`. It would be one line to add and it
 * would end this package's usefulness: every caller that reached for it would
 * be building paths, choosing methods, reading status codes and deciding what
 * `snake_case` means — which is exactly the knowledge this package exists to
 * hold in one place. Adding a method costs a few lines and keeps that true.
 *
 * ## One call, one request
 *
 * No retries, of any kind, for any reason. Not on a network failure, not on a
 * 5xx, not on a timeout. A hidden retry turns one recorded Event into two, and
 * the caller that could have decided whether resending was safe never found
 * out that anything was resent. Retrying is a policy about the caller's work
 * rather than about HTTP, and it belongs to the task that owns the retry queue.
 */

import { DEFAULT_MEMORY_API_BASE_URL, normalizeBaseUrl, requireCredential } from './config.js';
import {
  isMemoryApiErrorCode,
  MemoryApiError,
  MemoryApiProtocolError,
  MemoryApiUnreachableError,
} from './errors.js';
import { isProblemResource, type ProblemResource } from './problem.js';

/**
 * How long a single request may take before it is abandoned.
 *
 * A number that exists so no call can hang forever, and not a promise about
 * how fast the Memory is. It is a constant here rather than a recorded
 * invariant because the right value depends on what the server ends up doing
 * on the slowest path — and when that changes, this should change with it
 * rather than be defended.
 */
export const MEMORY_API_REQUEST_TIMEOUT_MS = 10_000;

/**
 * The shape of `fetch`, so a test can supply one.
 *
 * Taken from the platform's own type rather than restated, so an injected
 * double cannot drift from what production actually calls.
 */
export type FetchLike = typeof globalThis.fetch;

export interface MemoryApiClientOptions {
  /** Where the Memory Server is. Defaults to loopback. */
  readonly baseUrl?: string;

  /** The Memory credential. Required, and never optional. */
  readonly credential: string;

  /** Substitute transport. Production uses the platform's `fetch`. */
  readonly fetch?: FetchLike;

  /** Per-request ceiling. Defaults to `MEMORY_API_REQUEST_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

export interface MemoryApiClient {
  /**
   * Reads one Problem.
   *
   * Returns exactly what the API returned. A Problem that does not exist, or
   * belongs to somebody else, is a `MemoryApiError` with `NOT_FOUND` — the
   * server answers both the same way on purpose, and this client does not try
   * to tell them apart.
   */
  getProblem(problemId: string): Promise<ProblemResource>;
}

/**
 * A value that is safe to put in a path segment and is shaped like an id.
 *
 * This is a check about path construction, not a second opinion on what the
 * server accepts: anything matching this needs no escaping, and anything that
 * does not is refused before a request is built rather than encoded into one.
 * The server remains the authority on whether a well-formed id exists.
 */
const PATH_SAFE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Raised for an argument that could not be part of a request. */
export class MemoryApiArgumentError extends Error {
  readonly argument: string;

  constructor(argument: string) {
    // The argument's *name*, never its value. A malformed id is often a
    // mistyped variable holding something else entirely.
    super(`The Memory API client was given an unusable ${argument}.`);
    this.name = 'MemoryApiArgumentError';
    this.argument = argument;
  }
}

/** Whether a thrown value is the platform's way of saying "abandoned". */
function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/**
 * Builds a client.
 *
 * Everything that can be wrong with the configuration is wrong here, before a
 * request exists. The credential is closed over and is not readable from the
 * returned object: a client is something you use, not something you read a
 * secret back out of.
 */
export function createMemoryApiClient(options: MemoryApiClientOptions): MemoryApiClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_MEMORY_API_BASE_URL);
  const credential = requireCredential(options.credential);
  const transport = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? MEMORY_API_REQUEST_TIMEOUT_MS;

  /**
   * One request, one response, and every failure turned into one of the three
   * kinds before it leaves.
   *
   * The credential goes in exactly one place: the `Authorization` header. Not
   * the query string, where it would reach every access log between here and
   * the server; not the body, where it would be echoed by anything that logs
   * requests; not the URL, which is printed by every HTTP client's own error.
   */
  async function send(path: string): Promise<{ status: number; body: unknown }> {
    let response: Response;
    try {
      response = await transport(`${baseUrl}${path}`, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${credential}`,
          accept: 'application/json',
        },
        // Built-in, so nothing is added to make a request finite.
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // Deliberately not inspected further. Whatever this is, no answer came
      // back, and the original is not attached — see the note in `errors.ts`.
      throw new MemoryApiUnreachableError(isAbort(error) ? 'ABORTED' : 'TRANSPORT');
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      // A status line arrived and the body did not. There is no answer to
      // read, so this is the same situation as never hearing back.
      throw new MemoryApiUnreachableError('TRANSPORT');
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new MemoryApiProtocolError('BODY_NOT_JSON', response.status);
    }

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new MemoryApiProtocolError('BODY_NOT_AN_OBJECT', response.status);
    }

    return { status: response.status, body };
  }

  /**
   * Turns a non-2xx answer into the right kind of failure.
   *
   * A refusal this contract describes becomes `MemoryApiError`. Anything else
   * — an envelope with no `error`, a code nobody has heard of, a proxy's own
   * JSON — becomes a protocol failure, because it did not come from a server
   * implementing this contract and should not be reported as though it had.
   */
  function refuse(status: number, body: unknown): never {
    const envelope = body as Record<string, unknown>;
    const error = envelope['error'];
    const requestId = envelope['request_id'];

    if (
      typeof error !== 'object' ||
      error === null ||
      Array.isArray(error) ||
      typeof requestId !== 'string'
    ) {
      throw new MemoryApiProtocolError('ERROR_ENVELOPE_MALFORMED', status);
    }

    const code = (error as Record<string, unknown>)['code'];
    if (!isMemoryApiErrorCode(code)) {
      // Including the unknown code in the message would be the obvious thing
      // and would put a value chosen by whatever answered into a log line.
      throw new MemoryApiProtocolError('ERROR_CODE_UNKNOWN', status);
    }

    throw new MemoryApiError(status, code, requestId);
  }

  return {
    async getProblem(problemId): Promise<ProblemResource> {
      if (!PATH_SAFE_ID.test(problemId)) {
        // Before the request, so a malformed id never becomes a URL — and so
        // no request is spent finding out what could be known here.
        throw new MemoryApiArgumentError('problem id');
      }

      const { status, body } = await send(`/v1/problems/${problemId}`);

      if (status < 200 || status >= 300) {
        refuse(status, body);
      }

      if (!isProblemResource(body)) {
        throw new MemoryApiProtocolError('RESOURCE_MALFORMED', status);
      }

      return body;
    },
  };
}
