/**
 * Deciding whether a failed delivery is worth trying again.
 *
 * The input is a closed shape and never an error object. That is the rule
 * P3-01 through P3-03 arrived at from the other direction — anything an
 * outside party writes eventually reaches a log — applied to a decision rather
 * than to storage: a retry policy that reads `error.message` is a policy whose
 * behaviour is chosen by whatever produced the message. A proxy changes its
 * wording and writes start being dropped.
 *
 * Three answers, because there are three genuinely different situations:
 *
 * `RETRYABLE` — nobody has said no. The server was unreachable, or it answered
 * in a way that says "not now". The write is still worth having.
 *
 * `AUTH_REQUIRED` — the credential is the problem, and no amount of waiting
 * fixes it. It is deliberately not permanent: a revoked credential is replaced
 * by a new one, and the Event recorded before the rotation is still worth
 * saving. So the item waits rather than dying.
 *
 * `PERMANENT` — the server understood and refused. Sending it again produces
 * the same refusal, and the only thing more attempts achieve is to delay the
 * moment somebody is told.
 *
 * The status codes below are the ones this server actually produces, plus the
 * ones a proxy in front of it produces. `429` and `408` are in the table
 * although nothing here emits them: they are unambiguous, and a table that
 * omits them would classify them by the fallback rule, which is the wrong
 * answer for both.
 */

import type { ErrorCode } from '../http/errors.js';

/** What a delivery attempt reported. Closed, and free of anything raw. */
export type DeliveryOutcome =
  /** It reached the server and the write happened. */
  | { readonly kind: 'SUCCESS' }
  /**
   * It never got an answer: connection refused, reset, DNS, timeout.
   *
   * Deliberately carries nothing. Which of those it was makes no difference
   * to the decision, and the detail is a string somebody else wrote.
   */
  | { readonly kind: 'TRANSPORT_FAILURE' }
  /** The server answered, and did not accept the write. */
  | {
      readonly kind: 'HTTP_FAILURE';
      readonly status: number;
      /** The `error.code` from the envelope, when the body had one. */
      readonly errorCode?: ErrorCode;
      /** From `Retry-After`, already converted to milliseconds. */
      readonly retryAfterMs?: number;
    };

export const RETRY_DECISIONS = ['RETRYABLE', 'AUTH_REQUIRED', 'PERMANENT'] as const;

export type RetryDecision = (typeof RETRY_DECISIONS)[number];

/**
 * Statuses that mean "not now" rather than "no".
 *
 * `408` and `429` are the client-side pair: a request timeout and a rate
 * limit, both of which resolve on their own. The `5xx` entries are the server
 * saying it failed or is unavailable.
 *
 * `500` is in this list and the reasoning is worth writing down, because it is
 * the ambiguous one. This server answers `500` both for a database that is
 * momentarily gone and for a bug in its own code, and nothing in the response
 * distinguishes them. Treating it as permanent would discard a write whenever
 * the database blinked; treating it as retryable spends a bounded number of
 * attempts on a bug and then stops, and the item is kept either way. Bounded
 * waste is the cheaper mistake.
 */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);

export function classifyDeliveryOutcome(
  outcome: Exclude<DeliveryOutcome, { kind: 'SUCCESS' }>,
): RetryDecision {
  if (outcome.kind === 'TRANSPORT_FAILURE') {
    // Nothing answered, so nothing refused. This is the case the queue exists
    // for: the server is down, or the network is.
    return 'RETRYABLE';
  }

  if (outcome.status === 401) {
    return 'AUTH_REQUIRED';
  }

  if (RETRYABLE_STATUSES.has(outcome.status)) {
    return 'RETRYABLE';
  }

  // Everything else the server can say about a queued write is a refusal it
  // will repeat. `400` means the payload is wrong, `404` means the Problem is
  // gone — deleted, and P3-05 leaves nothing to bring back — and `409` cannot
  // be reached by an append at all, since neither queued operation carries a
  // version. A `4xx` nobody has thought about lands here too, which is the
  // safe direction: it stops, keeps the item, and something has to look at it.
  //
  // A `5xx` outside the list above is the one case where the fallback is
  // arguable. It is refused rather than retried, because an unrecognised `5xx`
  // from something in the path is not evidence that waiting will help, and the
  // item survives to be reported either way.
  return 'PERMANENT';
}
