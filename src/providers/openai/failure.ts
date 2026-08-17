/**
 * Where this vendor's failures become the vendor-neutral ones.
 *
 * The transport and the response reader have their own closed vocabularies, and
 * they are the right vocabularies *here*: `HTTP_ERROR` with a status is exactly
 * what a boundary needs in order to tell a rate limit from a rejected
 * credential. Neither word may travel upward, so this file is the one place the
 * translation happens, and it is the last place an HTTP status exists.
 *
 * ## The mapping, and why each line
 *
 * | vendor failure            | classified as               |
 * | ------------------------- | --------------------------- |
 * | `UNREACHABLE`             | `UNAVAILABLE`               |
 * | `HTTP_ERROR` 429          | `UNAVAILABLE`               |
 * | `HTTP_ERROR` ≥ 500        | `UNAVAILABLE`               |
 * | `HTTP_ERROR` other 4xx    | `UPSTREAM_REJECTED_REQUEST` |
 * | `MALFORMED_RESPONSE`      | `INVALID_RESPONSE`          |
 * | any `OpenAiResponseError` | `INVALID_RESPONSE`          |
 *
 * A rate limit and a server error are the provider being temporarily unable to
 * answer; degrading the channel and answering with what is left is the right
 * response, and retrying is not this layer's business. Every other 4xx is the
 * provider refusing this request — a malformed body, a rejected key, a
 * forbidden or absent endpoint — and none of those improve by waiting or by
 * being reported as a channel that was merely quiet.
 *
 * A refusal, an incomplete response and a missing document are all the provider
 * having answered with something that is not the document it was asked for, so
 * they join `INVALID_RESPONSE` rather than getting a class of their own. The
 * distinction that matters downstream is "can this be waited out", and for all
 * three the answer is no.
 *
 * ## Scope
 *
 * The two ports a search calls. The summary generator is deliberately left
 * alone: it is reached only from background maintenance, whose response to every
 * failure is identical — the artifact stays absent and reconciliation asks again
 * — so a classification there would be a distinction with no reader, and its
 * own failure vocabulary is what its tests are written against.
 */

import { RetrievalProviderCallError } from '../../domain/retrieval-provider-failure.js';
import { OpenAiResponseError } from './responses.js';
import { OpenAiRequestError } from './transport.js';

/** How a rate limit arrives, by the HTTP standard's own number. */
const TOO_MANY_REQUESTS = 429;

/** Where server errors begin. */
const SERVER_ERROR_FLOOR = 500;

/**
 * Classifies one vendor failure.
 *
 * Anything that is not one of this directory's two error types is a bug in this
 * directory rather than a provider failure, and is left to propagate unchanged:
 * dressing an unexpected `TypeError` as `UNAVAILABLE` would degrade a channel
 * because of a mistake in the code that reads the answer, which is the exact
 * confusion this whole change exists to remove.
 */
export function classifyOpenAiFailure(error: unknown): RetrievalProviderCallError | undefined {
  if (error instanceof OpenAiResponseError) {
    return new RetrievalProviderCallError('INVALID_RESPONSE');
  }

  if (!(error instanceof OpenAiRequestError)) {
    return undefined;
  }

  if (error.failure === 'MALFORMED_RESPONSE') {
    return new RetrievalProviderCallError('INVALID_RESPONSE');
  }

  if (error.failure === 'HTTP_ERROR') {
    const status = error.status;
    if (status === TOO_MANY_REQUESTS || (status !== undefined && status >= SERVER_ERROR_FLOOR)) {
      return new RetrievalProviderCallError('UNAVAILABLE');
    }
    // Every other non-success status, and a status that somehow did not arrive.
    // Refusing to guess "probably transient" is the point: an unclassifiable
    // rejection that degraded a channel would be the silent failure again.
    return new RetrievalProviderCallError('UPSTREAM_REJECTED_REQUEST');
  }

  return new RetrievalProviderCallError('UNAVAILABLE');
}

/**
 * Runs one provider call with its failures classified.
 *
 * Wrapping the whole call rather than each `throw` inside it is deliberate:
 * every failure on the path — the transport's, the response reader's, and the
 * adapter's own validation of what came back — leaves through here, so a new
 * check added inside an adapter is classified without anyone remembering to.
 */
export async function withClassifiedOpenAiFailures<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const classified = classifyOpenAiFailure(error);
    if (classified !== undefined) {
      throw classified;
    }
    throw error;
  }
}
