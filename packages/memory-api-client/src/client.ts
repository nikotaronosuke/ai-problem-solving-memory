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
import { isProjectListBody, type ProjectResource } from './project.js';
import {
  isMemorySearchRequest,
  isMemorySearchResponse,
  type MemorySearchOutcome,
  type MemorySearchRequest,
} from './search.js';

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
 * How long a search may take before it is abandoned.
 *
 * Longer than an ordinary read, and it has to be. A cold search embeds the
 * query, searches, asks a model to compare structure, then reads five kinds of
 * material for every candidate — two provider calls in series, each with its own
 * ceiling on the server side. A client that gave up after the ordinary timeout
 * would abandon searches the server was about to answer, every time, and the
 * caller would learn nothing except that the Memory is unreachable, which would
 * not be true.
 *
 * Still finite, and deliberately: an unbounded request is a hung caller, and
 * there is no version of "wait forever" that a person watching an assistant
 * work would prefer.
 *
 * The number is an implementation constant, like its ordinary counterpart. What
 * is worth recording is that a search has its own longer default; the value
 * belongs to whatever the slowest configured stack actually does, and should
 * move when that moves rather than be defended.
 */
export const MEMORY_API_SEARCH_TIMEOUT_MS = 300_000;

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

  /**
   * Per-request ceiling, for every operation.
   *
   * Left unset, each operation uses its own default:
   * `MEMORY_API_REQUEST_TIMEOUT_MS` for an ordinary read and
   * `MEMORY_API_SEARCH_TIMEOUT_MS` for a search. Set, it applies to all of them
   * — one knob rather than one per method, because a caller that wants a ceiling
   * wants a ceiling, and a second option would only create a precedence
   * question for somebody to get wrong.
   */
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

  /**
   * Lists every Project this owner has.
   *
   * Returns them in the order the server sent, which is deterministic and is
   * the server's — nothing here sorts, filters or de-duplicates. The list
   * envelope's single field is unwrapped and nothing else about the answer
   * changes; every element is validated, and one malformed Project makes the
   * whole answer a protocol failure rather than being skipped, because a list
   * quietly missing a Project reads as an owner who does not have it.
   *
   * An owner with no Projects gets an empty array, which is an answer rather
   * than a fault.
   */
  listProjects(): Promise<readonly ProjectResource[]>;

  /**
   * Finds past memory worth reading for the Problem being worked on.
   *
   * Searches every Project this owner has and returns candidates with the
   * material to judge them — what each was true of, where it did and did not
   * lead, and what contradicts it. Never a recommendation: what the material
   * means for the situation in front of the caller is the caller's to decide,
   * and nothing here reads it.
   *
   * Four outcomes, all returned rather than raised. Three are the server's:
   * candidates (possibly none), reading turned off for this Problem, and a
   * Problem that changed while the search ran. The fourth is this client's
   * naming of a `404` — for a search the Problem is the *context*, and losing
   * the context is something a caller handles rather than an exception to its
   * plan.
   *
   * Everything else raises, unchanged in meaning: a refusal is a
   * `MemoryApiError` — including a `500`, which may mean the server's provider
   * integration is broken and never means the request was wrong — an
   * unanswerable request is a `MemoryApiUnreachableError`, and an answer this
   * contract cannot read is a `MemoryApiProtocolError`.
   *
   * Nothing is retried, nothing is judged, nothing is transformed. The body that
   * passes validation is the body that is returned.
   */
  search(problemId: string, request: MemorySearchRequest): Promise<MemorySearchOutcome>;
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
  // Left as the caller gave it — `undefined` included — because "no ceiling was
  // asked for" is what selects the per-operation default below. Collapsing it to
  // one number here is what made a search inherit an ordinary read's ten
  // seconds.
  const timeoutMs = options.timeoutMs;

  /**
   * One request, one response, and every failure turned into one of the three
   * kinds before it leaves.
   *
   * The credential goes in exactly one place: the `Authorization` header. Not
   * the query string, where it would reach every access log between here and
   * the server; not the body, where it would be echoed by anything that logs
   * requests; not the URL, which is printed by every HTTP client's own error.
   */
  async function send(
    path: string,
    options: {
      readonly method: 'GET' | 'POST';
      readonly body?: string;
      readonly timeoutMs: number;
    },
  ): Promise<{ status: number; body: unknown }> {
    let response: Response;
    try {
      response = await transport(`${baseUrl}${path}`, {
        method: options.method,
        headers: {
          authorization: `Bearer ${credential}`,
          accept: 'application/json',
          // Only when there is one. A `Content-Type` on a request with no body
          // describes something that is not there.
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(options.body === undefined ? {} : { body: options.body }),
        // Built-in, so nothing is added to make a request finite.
        signal: AbortSignal.timeout(options.timeoutMs),
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
   * Reads a non-2xx answer as the refusal it claims to be.
   *
   * Returns the error rather than throwing it, because one caller needs to look
   * at it first: a search turns a `NOT_FOUND` into a typed outcome, and it can
   * only do that by knowing the code. Everything that is *not* a refusal this
   * contract describes still leaves from here — an envelope with no `error`, a
   * code nobody has heard of, a proxy's own JSON — because none of that came
   * from a server implementing this contract, and reporting it as though it had
   * would tell a caller the Memory refused something it never saw.
   *
   * One copy, deliberately. Envelope validation duplicated per method is
   * envelope validation that drifts per method.
   */
  function readApiError(status: number, body: unknown): MemoryApiError {
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

    return new MemoryApiError(status, code, requestId);
  }

  return {
    async getProblem(problemId): Promise<ProblemResource> {
      if (!PATH_SAFE_ID.test(problemId)) {
        // Before the request, so a malformed id never becomes a URL — and so
        // no request is spent finding out what could be known here.
        throw new MemoryApiArgumentError('problem id');
      }

      const { status, body } = await send(`/v1/problems/${problemId}`, {
        method: 'GET',
        timeoutMs: timeoutMs ?? MEMORY_API_REQUEST_TIMEOUT_MS,
      });

      if (status < 200 || status >= 300) {
        throw readApiError(status, body);
      }

      if (!isProblemResource(body)) {
        throw new MemoryApiProtocolError('RESOURCE_MALFORMED', status);
      }

      return body;
    },

    async listProjects(): Promise<readonly ProjectResource[]> {
      const { status, body } = await send('/v1/projects', {
        method: 'GET',
        timeoutMs: timeoutMs ?? MEMORY_API_REQUEST_TIMEOUT_MS,
      });

      if (status < 200 || status >= 300) {
        throw readApiError(status, body);
      }

      if (!isProjectListBody(body)) {
        throw new MemoryApiProtocolError('RESOURCE_MALFORMED', status);
      }

      return body.projects;
    },

    async search(problemId, request): Promise<MemorySearchOutcome> {
      if (!PATH_SAFE_ID.test(problemId)) {
        throw new MemoryApiArgumentError('problem id');
      }
      if (!isMemorySearchRequest(request)) {
        // Before the request, and without the request in the message. A search
        // is made of somebody's own words about their own problem, and the
        // argument's name is the whole of what is safe to say.
        throw new MemoryApiArgumentError('search request');
      }

      const { status, body } = await send(`/v1/problems/${problemId}/search`, {
        method: 'POST',
        // Written out field by field rather than serialising the caller's
        // object, so an extra property on it cannot travel even if validation
        // one day stopped noticing.
        body: JSON.stringify({
          source_ai: request.source_ai,
          lexical_text: request.lexical_text,
          semantic_text: request.semantic_text,
          current_features: request.current_features,
        }),
        timeoutMs: timeoutMs ?? MEMORY_API_SEARCH_TIMEOUT_MS,
      });

      if (status < 200 || status >= 300) {
        const error = readApiError(status, body);

        // Only this exact pairing. A `404` whose envelope is malformed, or whose
        // code is something else, has already left through `readApiError` or
        // falls through to be raised — because deciding from the status alone
        // would turn any 404-shaped answer, including a proxy's, into "your
        // Problem is gone".
        if (status === 404 && error.code === 'NOT_FOUND') {
          return { kind: 'CURRENT_PROBLEM_NOT_AVAILABLE' };
        }

        throw error;
      }

      if (!isMemorySearchResponse(body)) {
        throw new MemoryApiProtocolError('SEARCH_RESPONSE_MALFORMED', status);
      }

      return body;
    },
  };
}
