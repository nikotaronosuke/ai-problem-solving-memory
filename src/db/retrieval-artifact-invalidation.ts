/**
 * The one place a canonical write is allowed to say "and the artifact is gone".
 *
 * ## Why an artifact is deleted when the record changes
 *
 * A retrieval artifact is a rendering of one exact canonical source, and it
 * says so: its fingerprint is a digest of the bytes it was generated from. The
 * moment an Event lands, a Verification is recorded, or a canonical Problem
 * field moves, that claim is false — and a search that still offers the old
 * rendering is offering a summary of a record that no longer exists in that
 * form. The rule this module implements is the lifecycle invariant: **a
 * searchable artifact describes the current canonical source, and a stale one
 * is not degraded, warned about or ranked lower — it is absent.**
 *
 * Absence is the whole mechanism. There is no dirty flag, no revision column
 * and no job row, because a missing row already means everything those would
 * record: not generated yet, invalidated by a mutation, or failed and awaiting
 * another attempt. Reconciliation finds missing rows; nothing needs to know
 * which of the three ways the row came to be missing.
 *
 * ## Why it is a second statement in the write's transaction, not a CTE
 *
 * The delete must be atomic with the canonical write, and the obvious way —
 * a data-modifying CTE riding the write's own statement — was measured and
 * does not survive one real interleaving. A statement takes its snapshot when
 * it begins. A canonical write that has to *wait* for the generation gate's
 * row lock resumes with the snapshot it started with, and the artifact the
 * generation committed while it waited is invisible to that snapshot: the CTE
 * delete scans, finds nothing, and the append commits with a freshly stale
 * artifact intact. The race test caught it; the design moved.
 *
 * A second statement inside the same transaction has neither problem. Under
 * read committed it begins with a fresh snapshot — taken after the write
 * completed, and therefore after anything the write waited on committed — so
 * the freshly stored artifact is visible and dies. The transaction keeps the
 * atom: a rolled-back write takes the delete with it, and a delete cannot
 * happen without the write it follows.
 *
 * The caller performs the gating that the CTE's `exists` used to: the delete
 * runs only after the write reported that it actually wrote — a returned row,
 * not a replay, not a version conflict. That decision is visible in each
 * write's own code instead of embedded in SQL.
 *
 * ## What must never appear here
 *
 * A provider call, a network round trip, anything slow: this runs inside the
 * canonical write's transaction, and the rule that external work stays out of
 * Memory transactions is load-bearing (the generation service is built around
 * it). This module issues one bounded delete and nothing else.
 *
 * This is deliberately the only file besides the delete path that removes
 * rows, and the architecture test pins both facts: the delete path owns
 * Memory rows, this file owns exactly one derived table, and nothing else
 * deletes anything.
 */

import type { OwnerContext } from '../domain/owner.js';
import type { ProblemId } from '../domain/problem.js';
import type { DatabaseExecutor } from './executor.js';

/**
 * The delete itself. Owner and problem both, always: the composite foreign
 * key would make a cross-owner artifact row unstorable anyway, and the
 * predicate keeps this correct even one schema edit away from that being
 * true.
 */
export const ARTIFACT_INVALIDATION_STATEMENT = `
  delete from public.retrieval_artifacts
   where owner_id = $1
     and problem_id = $2`;

/**
 * Removes the Problem's artifact, whatever generation it came from.
 *
 * Call it on the same executor as the canonical write it follows, inside the
 * same transaction, and only after that write reported a row — those three
 * conditions are the atomicity, the freshness and the replay-safety of the
 * whole mechanism, and each write path holds them in its own code.
 *
 * Idempotent by shape: deleting an absent row deletes nothing, so a close
 * that invalidates once per Event it appends is merely thorough.
 */
export async function invalidateRetrievalArtifact(
  executor: DatabaseExecutor,
  context: OwnerContext,
  problemId: ProblemId,
): Promise<void> {
  await executor.query(ARTIFACT_INVALIDATION_STATEMENT, [context.ownerId, problemId]);
}
