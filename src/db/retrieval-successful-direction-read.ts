/**
 * Reading the directions a Memory's record supports calling successful.
 *
 * ## Why this reads derived material when the dead-end stage reads Events
 *
 * The asymmetry is deliberate, and it is about what storage can honestly say.
 *
 * A `DEAD_END` Event *is* the historical fact: somebody tried a direction and
 * recorded that it did not lead anywhere. Nothing else is needed to report it,
 * which is why dead-end warnings come from the Events themselves.
 *
 * A `FIX` Event is not the same kind of fact. It records that a fix was tried
 * or applied — **a recorded fix is not a verified one**, which is the rule the
 * whole status model is built on. There is no link between a `FIX` Event and
 * the Verification that later passed, so a Problem with three `FIX` Events and
 * one successful Verification does not say which of the three worked. Reporting
 * all three as successful would be a fabricated causal claim; picking the last
 * one, or the one nearest the Verification in time, would be a guess wearing a
 * rule's clothing. So no `FIX` Event is read here at all.
 *
 * What *can* be said comes from the summary generator, which reads the whole
 * canonical history and states what the successful direction was — and is
 * refused outright at generation time if it claims one for a Problem the record
 * does not support. That gate is `requiresSuccessfulVerification(status) &&
 * hasSuccessfulVerification`, and this statement applies exactly the same test
 * again, freshly.
 *
 * ## Why the gate is applied again here
 *
 * The stored artifact records what was true when it was generated, and nothing
 * rewrites it if the record it describes stops supporting the claim.
 *
 * Through the supported surface that is not currently reachable: `VERIFIED` is
 * terminal, so a Problem does not leave it. But the gate is a property of this
 * read rather than a consequence of today's lifecycle — a write through a lower
 * layer, an imported record, or a later change to which statuses are terminal
 * would each leave a persisted state the gate no longer holds for, with an
 * artifact still naming directions.
 *
 * So the status and the existence of a successful Verification are re-read in
 * the same statement as the artifact, and the directions come back only when
 * both hold now. Trusting the generation-time gate for ever would make this
 * answer depend on a lifecycle rule enforced somewhere else.
 */

import { requiresSuccessfulVerification } from '../domain/problem-status.js';
import type { OwnerContext } from '../domain/owner.js';
import type { ProblemId } from '../domain/problem.js';
import type { ProblemStatus } from '../domain/enums.js';
import { parseStructuralFeatures } from '../domain/retrieval-summary.js';
import type { DatabaseExecutor } from './executor.js';

interface Row {
  problem_id: string | null;
  status: ProblemStatus | null;
  has_successful_verification: boolean | null;
  structural_features: unknown;
}

/**
 * One statement, owner-scoped, with the read control applied again.
 *
 * The artifact is left-joined because it is derived data: a Memory whose
 * artifact has not been generated yet, or was removed, is still a perfectly
 * good Memory and must not be dropped from a search for it.
 *
 * `exists` rather than a join for the Verification, because the question is
 * whether one passed and not which — joining would multiply the row per check
 * for an answer that is a single boolean.
 *
 * No Event table appears here. See the note above: none of what this reports
 * can be established from an Event.
 */
export const SUCCESSFUL_DIRECTION_STATEMENT = `
  select pr.problem_id as problem_id,
         pr.status as status,
         exists (
           select 1
             from public.verifications v
            where v.owner_id = pr.owner_id
              and v.problem_id = pr.problem_id
              and v.result
         ) as has_successful_verification,
         ra.structural_features as structural_features
    from unnest($2::uuid[]) with ordinality as requested(problem_id, position)
    left join public.problems pr
      on pr.owner_id = $1
     and pr.problem_id = requested.problem_id
     and pr.memory_read_enabled
    left join public.retrieval_artifacts ra
      on ra.owner_id = pr.owner_id
     and ra.problem_id = pr.problem_id
   order by requested.position asc`;

/**
 * The directions each readable Memory's record currently supports.
 *
 * A Problem present with an empty list either has no artifact, has one that
 * names no successful direction, or no longer passes the evidence gate. Those
 * are not distinguished, and deliberately: all three mean the same thing to a
 * caller — there is nothing here that may be offered as a direction that
 * worked. A Problem absent from the result cannot be seen by this owner.
 *
 * A read, and only a read.
 */
export async function readSuccessfulDirections(
  executor: DatabaseExecutor,
  context: OwnerContext,
  problemIds: readonly ProblemId[],
): Promise<Map<ProblemId, readonly string[]>> {
  if (problemIds.length === 0) {
    // Nothing to ask about, and the answer could not change this empty map.
    return new Map();
  }

  const result = await executor.query<Row>(SUCCESSFUL_DIRECTION_STATEMENT, [
    context.ownerId,
    [...problemIds],
  ]);

  const byProblem = new Map<ProblemId, readonly string[]>();

  for (const row of result.rows) {
    if (row.problem_id === null || row.status === null) {
      // The left join reporting a Problem that is gone, was never this
      // owner's, or has automatic reading switched off. `status` is not null
      // in storage, so its absence is the join rather than a malformed row.
      continue;
    }

    const problemId = row.problem_id as ProblemId;

    // The gate, applied to the record as it is now rather than as it was when
    // the artifact was written.
    const supported =
      requiresSuccessfulVerification(row.status) && row.has_successful_verification === true;
    if (!supported || row.structural_features === null || row.structural_features === undefined) {
      byProblem.set(problemId, []);
      continue;
    }

    // Parsed rather than trusted. The column is `jsonb` and its type here is a
    // compile-time claim about a row written by an earlier version of this
    // process; a malformed profile raises rather than quietly becoming an
    // empty list, because an empty list is a statement and this would not be
    // one. The error names no value and no identifier.
    byProblem.set(
      problemId,
      parseStructuralFeatures(row.structural_features).successful_directions,
    );
  }

  return byProblem;
}
