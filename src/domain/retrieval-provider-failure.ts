/**
 * How a retrieval provider call failed, in words no vendor owns.
 *
 * ## Why this exists
 *
 * The two retrieval ports return `unknown` and are free to throw, and until
 * P5-02c-impl-1's formal review that was the whole contract. It turned out not
 * to be enough. Both stage services treated *any* throw as "the provider could
 * not be reached" and degraded the channel, so a production adapter that
 * detected a malformed answer — a vector of the wrong width, an echo from
 * another model, a rerank answer missing a candidate — reported itself as
 * unavailable. A broken integration then looked exactly like a deployment that
 * had deliberately configured no provider, for as long as it stayed broken, and
 * every search kept answering with the lexical half as though that were the
 * intended shape.
 *
 * So a failure now says which of three things happened, and the three must not
 * be mixed:
 *
 * - `UNAVAILABLE` — nothing usable came back and nothing is wrong with the
 *   integration: a network failure, a timeout, a rate limit, a server error.
 *   Transient by nature. This is what a degraded channel is *for*.
 * - `INVALID_RESPONSE` — the provider answered, and the answer is not one this
 *   system can use. Nothing about waiting will fix it.
 * - `UPSTREAM_REJECTED_REQUEST` — the provider refused the request itself: a
 *   bad request, a rejected credential, a forbidden or missing resource. Also
 *   not transient, and never the caller's fault — the caller cannot see this
 *   request, let alone shape it.
 *
 * The last two are integration failures, and they must never be converted
 * into a complaint about the caller's query: a search request has no bearing
 * on whether a credential is valid or a provider kept its contract. What each
 * stage does with them differs, and deliberately:
 *
 * - `UPSTREAM_REJECTED_REQUEST` fails the search everywhere. A refused
 *   request is deterministic — the next search builds the same request and is
 *   refused the same way — so degrading would hide a broken integration
 *   behind ordinary-looking results forever.
 * - `INVALID_RESPONSE` fails the search in the embedding stage, whose answer
 *   has no smaller honest form. The structural rerank stage instead discards
 *   the whole answer and degrades explicitly to `RERANKER_OUTPUT_INVALID`:
 *   one unusable model answer is a fact about that answer, the stage has an
 *   honest smaller result to give, and the status says exactly what happened
 *   rather than dressing it as an outage.
 *
 * ## What a failure may carry
 *
 * The kind, and nothing else. No provider name, no URL, no HTTP status, no
 * response body, no request body, no upstream message, no `cause`, no
 * credential. The message is a fixed sentence built from the kind, which is a
 * word chosen in this file. A provider error travels into logs, and the request
 * that produced it held somebody's Memory rendered as text along with the
 * credential.
 *
 * ## Where the translation happens
 *
 * At the provider boundary, which is the only place that knows a vendor's own
 * failure vocabulary. `src/providers/openai/failure.ts` performs it; everything
 * above the ports sees these three words and could not name the vendor if it
 * tried.
 */

/** The three ways a provider call can fail. Exactly three, deliberately. */
export const RETRIEVAL_PROVIDER_CALL_FAILURES = [
  'UNAVAILABLE',
  'INVALID_RESPONSE',
  'UPSTREAM_REJECTED_REQUEST',
] as const;

export type RetrievalProviderCallFailure = (typeof RETRIEVAL_PROVIDER_CALL_FAILURES)[number];

/**
 * A provider call that failed, classified.
 *
 * Deliberately not a subclass per kind: a caller decides what to do from
 * `failure`, and three classes would invite a fourth added without anyone
 * deciding what it means for degradation.
 */
export class RetrievalProviderCallError extends Error {
  readonly failure: RetrievalProviderCallFailure;

  constructor(failure: RetrievalProviderCallFailure) {
    // The kind is this file's own word. Nothing from the provider, and no
    // second argument — `cause` is exactly how a driver message or a response
    // body would arrive here by accident.
    super(`A retrieval provider call failed: ${failure}.`);
    this.name = 'RetrievalProviderCallError';
    this.failure = failure;
  }
}

/**
 * Whether a failure means the integration is broken rather than unreachable.
 *
 * Used by the embedding stage, where both kinds fail the search: a vector
 * channel has no smaller honest answer. The structural rerank stage does not
 * read this predicate — it sorts the same kinds itself, because it is the one
 * stage that treats `INVALID_RESPONSE` as an explicit degraded status
 * (`RERANKER_OUTPUT_INVALID`) rather than a search failure. Its reasoning
 * lives beside its catch; the vocabulary here stays one vocabulary.
 *
 * A failure that is not one of these is degraded, and so is anything that is
 * not a `RetrievalProviderCallError` at all. That second part is not laziness:
 * the ports are still free to throw whatever they like, a port written before
 * this vocabulary existed throws a plain `Error` to mean an outage, and the
 * P4-era contract those were written against is not broken by this addition.
 */
export function isRetrievalProviderIntegrationFailure(
  error: unknown,
): error is RetrievalProviderCallError {
  return (
    error instanceof RetrievalProviderCallError &&
    (error.failure === 'INVALID_RESPONSE' || error.failure === 'UPSTREAM_REJECTED_REQUEST')
  );
}
