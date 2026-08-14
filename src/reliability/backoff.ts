/**
 * How long to wait before trying again.
 *
 * A pure function of the attempt number and the policy, with no clock, no
 * timer and no randomness. That makes the schedule something a test can state
 * exactly rather than approximately, and it is the reason nothing in this
 * module sleeps: the queue records *when* an item may next be tried and the
 * caller decides when to look, so a test moves a fake clock instead of waiting.
 *
 * Doubling, capped. The first failure waits `baseDelayMs`, the second twice
 * that, and so on until `maxDelayMs`. Nothing more elaborate is warranted: the
 * failure this exists for is a server that is down for a while, and the shape
 * that matters is "quickly at first, then stop hammering".
 *
 * No jitter. Jitter spreads a thundering herd, and there is no herd here — one
 * person's assistant, retrying one person's writes. Adding it would mean
 * injecting a random source and threading it through everything, to solve a
 * problem this deployment does not have.
 */

export interface RetryPolicy {
  /** The wait after the first retryable failure. */
  readonly baseDelayMs: number;
  /** The ceiling the doubling stops at. */
  readonly maxDelayMs: number;
  /**
   * How many retryable failures an item survives.
   *
   * Reaching it makes the item terminal rather than deleting it: the write is
   * still something the person wanted recorded, and the point of stopping is
   * to stop trying, not to stop caring.
   */
  readonly maxAttempts: number;
}

/**
 * The delay after `attemptCount` retryable failures.
 *
 * `attemptCount` is the count *including* the failure just seen, so the first
 * call is with 1 and returns `baseDelayMs`.
 *
 * A `Retry-After` from the server overrides the schedule when it asks for
 * longer, and never when it asks for less. Being told to wait is information
 * the client does not have; being told to hurry is not something a client
 * should accept from a server that has just failed to serve it.
 */
export function nextDelayMs(
  policy: RetryPolicy,
  attemptCount: number,
  retryAfterMs?: number,
): number {
  const doubled = policy.baseDelayMs * 2 ** Math.max(0, attemptCount - 1);
  const delay = Math.min(doubled, policy.maxDelayMs);

  return retryAfterMs === undefined ? delay : Math.max(delay, retryAfterMs);
}
