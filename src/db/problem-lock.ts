/**
 * Holding a Problem still for the length of one short transaction.
 *
 * The artifact's final gate has to read the source, compare its fingerprint
 * and write the artifact as one act — a plain re-read followed by a write
 * leaves a gap between them that a concurrent Event can land in, and the
 * artifact would then claim a source state that was already gone when it was
 * committed. `FOR UPDATE` on the Problem row closes the gap, and it closes it
 * because of how the schema is built rather than by convention. Measured, all
 * of it: while the lock is held, an Event append blocks (its foreign-key check
 * needs a key-share lock on this row), a Verification append blocks for the
 * same reason, every Problem update blocks — the read control included — a
 * delete blocks, and so does another session's artifact upsert, whose own
 * foreign key points here too. Plain reads proceed untouched.
 *
 * So everything that could invalidate the fingerprint, and every competing
 * artifact write, waits for the commit; nothing that merely reads waits at
 * all. One row is locked and only ever this one, so there is no ordering
 * between multiple locks to get wrong and no deadlock to have.
 *
 * The Environment is deliberately not locked. A Problem's Environment cannot
 * change — there is no update path and the Problem cannot be re-pointed — so
 * locking it would guard against a write that cannot be expressed. A change
 * that makes Environments mutable must revisit this gate in the same change
 * set.
 *
 * The lock lives exactly as long as the transaction that took it. Callers
 * must not take it around anything slow — the generator and the embedding
 * provider are both called before the transaction begins, never inside it.
 */

import type { OwnerContext } from '../domain/owner.js';
import type { ProblemId } from '../domain/problem.js';
import type { DatabaseExecutor } from './executor.js';

/**
 * Locks one Problem row until the surrounding transaction ends.
 *
 * `false` when this owner has no such Problem — unknown and somebody else's
 * are one answer, as with every read. Must be called with a transactional
 * executor; on a pool connection the lock would be released the moment the
 * implicit transaction ended, which is to say immediately, guarding nothing.
 */
export async function lockProblemForArtifactWrite(
  executor: DatabaseExecutor,
  context: OwnerContext,
  problemId: ProblemId,
): Promise<boolean> {
  const result = await executor.query(
    `select 1 from public.problems
      where owner_id = $1 and problem_id = $2
        for update`,
    [context.ownerId, problemId],
  );

  return result.rows.length > 0;
}
