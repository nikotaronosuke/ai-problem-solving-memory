/**
 * Reading the dead ends recorded against a handful of Memories, in one
 * statement.
 *
 * Only `DEAD_END` Events, and only for Problems this owner can still see. The
 * shape follows the revalidation read for the same reason: the requested
 * identifiers become rows through `unnest(...) with ordinality`, and the
 * Problem and its Events are joined outwards from them, so two answers stay
 * apart that an inner join would merge —
 *
 *   - the Problem is gone, or was never this owner's, or has had automatic
 *     reading switched off: no Problem row, and the candidate is dropped;
 *   - the Problem is there and nothing was ever recorded as a dead end:
 *     completely ordinary, and an empty list.
 *
 * Those must not look the same. "Nowhere is known not to lead" and "this
 * Memory is no longer available" are different statements, and the second
 * should never be delivered as the first.
 *
 * The event type sits in the join rather than in a `where`, for the same
 * reason the owner does: a `where` on a left-joined table turns it back into
 * an inner join and takes the distinction with it.
 */

import type { OwnerContext } from '../domain/owner.js';
import type { ProblemId } from '../domain/problem.js';
import type { DeadEndWarning } from '../domain/retrieval-dead-end.js';
import type { DatabaseExecutor } from './executor.js';

interface Row {
  problem_id: string | null;
  event_id: string | null;
  summary: string | null;
  result: string | null;
  reason: string | null;
  evidence_ref: string | null;
  created_at: Date | null;
}

/**
 * One statement, owner-scoped, with the read control applied again.
 *
 * Ordered by the caller's position first, then oldest dead end first. The
 * tie-break on the identifier is not decoration: several Events written in one
 * transaction share a timestamp to the microsecond, and without it their order
 * would be whatever the plan happened to produce.
 */
export const DEAD_END_STATEMENT = `
  select pr.problem_id as problem_id,
         ev.event_id as event_id,
         ev.summary as summary,
         ev.result as result,
         ev.reason as reason,
         ev.evidence_ref as evidence_ref,
         ev.created_at as created_at
    from unnest($2::uuid[]) with ordinality as requested(problem_id, position)
    left join public.problems pr
      on pr.owner_id = $1
     and pr.problem_id = requested.problem_id
     and pr.memory_read_enabled
    left join public.events ev
      on ev.owner_id = pr.owner_id
     and ev.problem_id = pr.problem_id
     and ev.event_type = 'DEAD_END'
   order by requested.position asc, ev.created_at asc, ev.event_id asc`;

/**
 * The dead ends recorded against whichever of these Problems is still
 * readable.
 *
 * A Problem present in the result with an empty list has none recorded; one
 * absent from the result cannot be seen by this owner, and which of the four
 * reasons applies is deliberately not knowable from here.
 *
 * A read, and only a read.
 */
export async function readDeadEndWarnings(
  executor: DatabaseExecutor,
  context: OwnerContext,
  problemIds: readonly ProblemId[],
): Promise<Map<ProblemId, DeadEndWarning[]>> {
  if (problemIds.length === 0) {
    // Nothing to ask about. An empty array would work and would still be a
    // round trip.
    return new Map();
  }

  const result = await executor.query<Row>(DEAD_END_STATEMENT, [context.ownerId, [...problemIds]]);

  const byProblem = new Map<ProblemId, DeadEndWarning[]>();

  for (const row of result.rows) {
    if (row.problem_id === null) {
      continue;
    }

    const problemId = row.problem_id as ProblemId;
    let warnings = byProblem.get(problemId);
    if (warnings === undefined) {
      warnings = [];
      byProblem.set(problemId, warnings);
    }

    // Null across the Event columns is the left join reporting that this
    // Problem has no dead ends, not a malformed row. `summary` is not null in
    // storage, so its absence is what distinguishes the two.
    if (row.event_id === null || row.summary === null || row.created_at === null) {
      continue;
    }

    warnings.push({
      summary: row.summary,
      result: row.result,
      reason: row.reason,
      evidenceRef: row.evidence_ref,
      createdAt: row.created_at,
    });
  }

  return byProblem;
}
