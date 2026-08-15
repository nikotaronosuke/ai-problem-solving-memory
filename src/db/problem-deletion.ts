/**
 * Removing a Problem and everything that refers to it.
 *
 * This is the only destructive operation in the system, and it is deliberately
 * one function rather than a set of smaller ones a caller assembles. The order
 * the rows have to go in is a fact about the foreign key graph, not a product
 * decision, and a service that composed the order itself could get it wrong in
 * a way nothing above the database would notice until a delete failed halfway
 * through.
 *
 * What goes, and why it is this set:
 *
 *     change_logs    problem_id  = target
 *     events         problem_id  = target
 *     verifications  problem_id  = target
 *     usage_logs     problem_id  = target  or  memory_id = target
 *     relations      from_id     = target  or  to_id     = target
 *     problems       problem_id  = target
 *
 * The last two are the ones worth stopping at. A Relation and a UsageLog can
 * point *into* the target from another Problem that survives — `A relates to
 * B`, `A used B as memory` — and both carry free text explaining why, written
 * while looking at B. Leaving those behind would leave sentences about the
 * deleted Problem in the database after a request that asked for it to be
 * gone, which is exactly what someone deleting a mis-saved credential is
 * trying to prevent. So the surviving Problem loses those rows. That is a
 * consequence of the delete rather than an oversight: the request to remove
 * something wins over another record's account of it.
 *
 * Every statement carries `owner_id`. The foreign keys into `problems` are all
 * composite `(owner_id, problem_id)`, so a row belonging to another owner
 * cannot reference this one in the first place — but a statement that matched
 * on the id alone would still be one edit away from touching another owner's
 * rows, and there is no reason to write it that way.
 *
 * Nothing here cascades. Every foreign key in the schema is `ON DELETE
 * RESTRICT` (D-034) and stays that way, which makes this function's list the
 * single description of what a delete reaches. If a later table gains a
 * reference to `problems` and is not added here, the final statement fails on
 * the foreign key and the whole transaction rolls back — the table keeps its
 * rows, the Problem keeps existing, and the omission is loud. That is the
 * behaviour cascade would take away, and it is why cascade was not the answer
 * to a delete path being tedious.
 *
 * A failure of that kind is a programming mistake, not a conflict, and it is
 * left to surface as one. It is deliberately not translated into a version
 * conflict: telling a caller their version was stale, when what actually
 * happened is that this file forgot a table, would hide the bug behind a
 * plausible retry.
 */

import type { DatabaseExecutor } from './executor.js';
import type { OwnerContext } from '../domain/owner.js';
import type { ProblemId } from '../domain/problem.js';

/**
 * What a delete attempt did.
 *
 * A closed set, and the only thing that leaves this layer. The database layer
 * does not know what an HTTP status is, and nothing here is built from a
 * value the caller sent — the same discipline the authentication failures
 * follow.
 */
export type DeleteProblemOutcome =
  /** The Problem and everything referring to it are gone. */
  | 'DELETED'
  /** No such Problem for this owner. Includes one already deleted. */
  | 'NOT_FOUND'
  /** It exists, at a different version than the caller expected. */
  | 'VERSION_CONFLICT';

/**
 * Deletes one of the context owner's Problems and everything that refers to
 * it.
 *
 * Must be called inside a transaction. The executor handed in has to be the
 * transactional one: the row lock taken below is held until that transaction
 * ends, and six statements outside a transaction are six chances to stop
 * halfway with a Problem partly erased.
 *
 * The first statement locks the Problem row rather than merely reading it, and
 * it is worth being exact about what that buys, because it is less than it
 * looks. Correctness comes from the predicate on the last statement: the
 * Problem is removed only if it is still at the version the caller named, so a
 * writer landing between the read and the delete is refused rather than
 * overwritten. That would hold with no lock at all.
 *
 * What the lock adds is determinism. Without it there is a window between
 * reading the version and deleting where another transaction can move the
 * Problem, and the delete then does five statements' worth of work before
 * discovering it has to roll back. With it, a concurrent writer waits, and the
 * outcome is decided once rather than raced for.
 *
 * A concurrent append is blocked either way, which is why removing this lock
 * does not fail the concurrency tests: deleting the Problem takes its own lock
 * on the row a moment later, and an insert whose foreign key names that row
 * waits behind it. An architecture test pins the lock instead, since no
 * behaviour distinguishes the two.
 */
export async function deleteProblemAggregate(
  executor: DatabaseExecutor,
  context: OwnerContext,
  problemId: ProblemId,
  expectedVersion: number,
): Promise<DeleteProblemOutcome> {
  const locked = await executor.query<{ version: number }>(
    `select version
       from public.problems
      where owner_id = $1 and problem_id = $2
      for update`,
    [context.ownerId, problemId],
  );

  const current = locked.rows[0];
  if (current === undefined) {
    // Not this owner's, or not anyone's. The caller is told the same thing
    // either way, as everywhere else.
    return 'NOT_FOUND';
  }
  if (current.version !== expectedVersion) {
    return 'VERSION_CONFLICT';
  }

  const scope = [context.ownerId, problemId];

  // Children first, then the rows pointing in from elsewhere, then the
  // Problem. Each statement names the owner as well as the Problem.
  // The derived search data first. It is regenerable and never a source of
  // truth, which makes it easy to forget — and forgetting it would leave a
  // summary, a set of keywords and an embedding of a Problem somebody asked to
  // have removed. An embedding is not readable, but it is derived from the text
  // and answers questions about it, so "derived" is not a reason to keep it.
  await executor.query(
    `delete from public.retrieval_artifacts where owner_id = $1 and problem_id = $2`,
    scope,
  );
  await executor.query(
    `delete from public.change_logs where owner_id = $1 and problem_id = $2`,
    scope,
  );
  await executor.query(`delete from public.events where owner_id = $1 and problem_id = $2`, scope);
  await executor.query(
    `delete from public.verifications where owner_id = $1 and problem_id = $2`,
    scope,
  );

  // Both of this table's foreign keys in one statement. Written separately,
  // the second could be dropped in an edit and the delete would still appear
  // to work until a Problem that had been used as memory was removed.
  await executor.query(
    `delete from public.usage_logs
      where owner_id = $1 and (problem_id = $2 or memory_id = $2)`,
    scope,
  );
  await executor.query(
    `delete from public.relations
      where owner_id = $1 and (from_id = $2 or to_id = $2)`,
    scope,
  );

  // The version predicate, which is the actual guarantee rather than a
  // restatement of the check above. It is what refuses a delete whose caller
  // was looking at an older Problem, and it holds on its own — reading this
  // statement does not require trusting the twenty lines above it, or the
  // lock.
  const removed = await executor.query(
    `delete from public.problems
      where owner_id = $1 and problem_id = $2 and version = $3`,
    [context.ownerId, problemId, expectedVersion],
  );

  if ((removed.rowCount ?? 0) === 0) {
    // Unreachable while the lock is held: nothing else can have moved the
    // version between the check and here. Treated as a conflict rather than
    // reported as success, because the alternative is claiming a delete that
    // did not happen.
    return 'VERSION_CONFLICT';
  }

  return 'DELETED';
}
