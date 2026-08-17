/**
 * The one way anything in this directory talks to OpenAI.
 *
 * ## The fixed host
 *
 * The endpoint is a constant, and there is deliberately no way to configure
 * it. A configurable base URL would be a surface that sends `OPENAI_API_KEY`
 * to whatever host a configuration names — one mistyped or maliciously set
 * value away from handing the credential to a stranger. Swapping providers is
 * done by swapping provider implementations behind the vendor-neutral ports,
 * not by pointing this one somewhere else.
 *
 * ## What a failure carries
 *
 * A closed kind, and an HTTP status where one exists. Never the response
 * body, the request body, a provider error message, headers, or anything
 * derived from them: the request contains somebody's Memory rendered as text
 * and the credential, the response is whatever the provider chose to say, and
 * an error travels into logs. The generation and search services already
 * convert any thrown failure into their own fixed-sentence errors, so nothing
 * raised here is ever shown to a caller either.
 *
 * ## One request per call
 *
 * No hidden retries — not on 429, not on 5xx, not on a network failure or a
 * timeout. A retry policy buried in a transport is invisible call
 * amplification exactly when the provider is least able to absorb it, and
 * liveness does not need it: a failed generation leaves absence, and
 * reconciliation asks again later. If measurement ever argues for retries,
 * they will be added somewhere visible.
 */

/** Where every request goes. Not configurable, by design. */
export const OPENAI_API_BASE_URL = 'https://api.openai.com/v1';

/**
 * How long one request may take before it is abandoned.
 *
 * A ceiling so no generation can hang the maintenance loop, not a promise
 * about model latency. An implementation constant: the right number moves
 * with observed behaviour and is deliberately not recorded as an invariant.
 */
export const OPENAI_REQUEST_TIMEOUT_MS = 120_000;

/** The ways a request can fail, as a closed set safe to log and to count. */
export const OPENAI_REQUEST_FAILURES = [
  /** No response arrived: network failure, or the timeout fired. */
  'UNREACHABLE',
  /** The provider answered with a non-success status. */
  'HTTP_ERROR',
  /** A success whose body was not the JSON it should have been. */
  'MALFORMED_RESPONSE',
] as const;

export type OpenAiRequestFailure = (typeof OPENAI_REQUEST_FAILURES)[number];

/**
 * Raised for anything the transport could not turn into a parsed body.
 *
 * The status is carried for `HTTP_ERROR` because a number chosen by the HTTP
 * standard leaks nothing; everything else the provider said stays behind this
 * boundary.
 */
export class OpenAiRequestError extends Error {
  readonly failure: OpenAiRequestFailure;
  readonly status: number | undefined;

  constructor(failure: OpenAiRequestFailure, status?: number) {
    super(`The OpenAI request failed: ${failure}.`);
    this.name = 'OpenAiRequestError';
    this.failure = failure;
    this.status = status;
  }
}

/** The shape of `fetch`, so a test can supply one. */
export type FetchLike = typeof globalThis.fetch;

export interface OpenAiTransport {
  /** Sends one POST with a JSON body, returns the parsed JSON body. */
  postJson(path: string, body: unknown): Promise<unknown>;
}

/**
 * Builds the transport around one credential.
 *
 * The credential is closed over and appears in exactly one place: the
 * `Authorization` header. It is not readable back off the transport, not in
 * the URL, and not in anything a failure carries.
 */
export function createOpenAiTransport(apiKey: string, fetchLike?: FetchLike): OpenAiTransport {
  const transport = fetchLike ?? globalThis.fetch;

  return {
    async postJson(path, body): Promise<unknown> {
      let response: Response;
      try {
        response = await transport(`${OPENAI_API_BASE_URL}${path}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(OPENAI_REQUEST_TIMEOUT_MS),
        });
      } catch {
        // Whatever this was — refused connection, DNS, abort — no answer
        // arrived, and the original error is not attached: driver errors
        // carry addresses and sometimes whole request options.
        throw new OpenAiRequestError('UNREACHABLE');
      }

      let text: string;
      try {
        text = await response.text();
      } catch {
        throw new OpenAiRequestError('UNREACHABLE');
      }

      if (!response.ok) {
        // One request, one failure. 429 and 5xx included: the body is
        // deliberately not read into the error, and nothing retries.
        throw new OpenAiRequestError('HTTP_ERROR', response.status);
      }

      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new OpenAiRequestError('MALFORMED_RESPONSE', response.status);
      }
    },
  };
}
