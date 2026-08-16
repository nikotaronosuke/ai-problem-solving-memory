/**
 * Directions that were tried and did not work.
 *
 * Half of what makes past experience worth keeping is knowing where not to
 * look, and the specification is unusually firm about how that knowledge may
 * be used: a dead end is **warning material**. It informs, it can lower a
 * candidate's priority, it can be compared against — and it never forbids
 * trying again. Four separate places say so, and one of them is an acceptance
 * test: past dead ends must be detected without hard-blocking a retry.
 *
 * The reason is not politeness. A direction that failed under one runtime, one
 * library version or one reading of a specification may be exactly right under
 * another, and the record cannot know which. So there is no `retryBlocked`
 * here, no `forbidden`, no severity and no approval gate. There is what
 * happened, and when.
 *
 * **What this is not.** It is not a judgement about now. Whether a past dead
 * end still applies depends on the current code, environment and versions —
 * which live where the work is happening, not here — and the revalidation
 * contract already asks for exactly those to be re-established. Nor is it a
 * prediction: whether an assistant is *about to* walk into one of these needs
 * to know what it is about to do, and no search request carries that.
 */

/**
 * One direction recorded as a dead end, exactly as it was recorded.
 *
 * The fields keep their meanings from the Event they came from: `summary` is
 * what was tried and found to be a dead end, `result` is what happened, and
 * `reason` is why it was judged one. Two of those are nullable in storage and
 * stay nullable here — an attempt may have no result worth stating separately,
 * and one may have no reason beyond the attempt itself. Nothing is filled in.
 *
 * `evidenceRef` is a reference and stays one: a path, a commit, a test name, a
 * URL. Nothing fetches it, resolves it or checks that it still exists. Whether
 * it still points at anything is a question about now.
 *
 * `createdAt` is the Event's own timestamp, and it earns its place: read
 * beside the historical Environment it tells a reader *when* this direction
 * failed, which is most of what decides whether the conditions have moved on.
 * It is a different fact from the Memory's `freshness`, which is a control
 * somebody set on the record as a whole.
 *
 * The identifiers are absent. The Event's own id, its owner and its Problem
 * answer questions nobody is asking — the candidate already names the Problem
 * — and the idempotency key it arrived under is a transport detail.
 * `sourceAi` is left out too: which assistant hit the dead end is not part of
 * deciding whether the direction is worth retrying, and the audit question it
 * would answer belongs to the usage log.
 */
export interface DeadEndWarning {
  /** What was tried and found to be a dead end. Never blank. */
  readonly summary: string;
  /** What happened, when that was recorded separately. */
  readonly result: string | null;
  /** Why it was judged a dead end, when that was recorded. */
  readonly reason: string | null;
  /** A reference to supporting material. Never followed. */
  readonly evidenceRef: string | null;
  /** When the dead end was recorded. */
  readonly createdAt: Date;
}
