/**
 * The seam between a canonical write and the rendering it just outdated.
 *
 * When a write changes what a Problem's artifact would be generated from, the
 * write's own statement has already deleted the old rendering — that is the
 * correctness half, and it is done by the time anything here is involved.
 * This interface is the liveness half's doorbell: the service that performed
 * the write says *this Problem could use a new rendering now*, and whatever
 * is behind the interface decides when and whether that happens.
 *
 * The contract, all of it about what the caller may rely on:
 *
 * - **Called after the write is committed**, never inside its transaction. A
 *   scheduling layer that could hold a transaction open would put somebody's
 *   inference time inside everybody's lock time.
 * - **It cannot fail the write.** No return value, no exceptions surfacing to
 *   the caller, no waiting. The Event was recorded; whether a summary of it
 *   exists yet is invisible to the person who recorded it.
 * - **It is optional.** A composition without a generation stack — every
 *   composition, until the providers exist — passes nothing, and the writes
 *   behave exactly as they always have. Reconciliation covers whatever a
 *   missing doorbell missed, which is also why a lost call is never a
 *   correctness problem.
 *
 * The context travels with the request because generation is owner-scoped
 * work and the context is how this codebase carries owner scope without
 * naming an owner. What an implementation does with it — resolve a per-owner
 * coordinator, read nothing at all — is the composition's decision, made
 * where the concrete generation stack is chosen.
 */

import type { ProblemId } from '../domain/problem.js';
import type { AuthenticatedRequestContext } from './request-context.js';

export interface RetrievalArtifactMaintenance {
  /**
   * Notes that this Problem's artifact should be (re)generated, eventually.
   *
   * Best-effort by contract: returns nothing, throws nothing, waits for
   * nothing.
   */
  requestGeneration(context: AuthenticatedRequestContext, problemId: ProblemId): void;
}

/**
 * Rings the doorbell without letting it interrupt anything.
 *
 * The maintenance implementation promises not to throw; this is what makes
 * the promise unnecessary. A write that succeeded reports success, whatever
 * the scheduling layer did with the news.
 */
export function requestGenerationQuietly(
  maintenance: RetrievalArtifactMaintenance | undefined,
  context: AuthenticatedRequestContext,
  problemId: ProblemId,
): void {
  if (maintenance === undefined) {
    return;
  }
  try {
    maintenance.requestGeneration(context, problemId);
  } catch {
    // Deliberately swallowed. The canonical write this follows has committed,
    // and reconciliation will find the Problem whether or not this call was
    // heard.
  }
}
