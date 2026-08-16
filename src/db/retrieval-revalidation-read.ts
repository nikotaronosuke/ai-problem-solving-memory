/**
 * Reading what a handful of Memories were recorded under, in one statement.
 *
 * Three things are wanted per candidate: whether this owner can still see the
 * Problem at all, the Environment it occurred under, and every Verification
 * performed on it. Five candidates, one query.
 *
 * **The shape of the query is the interesting decision.** The requested
 * identifiers are turned into rows with `unnest(...) with ordinality` and
 * everything else is joined *outwards* from them. That is what makes the three
 * cases below distinguishable, and they must be distinguishable:
 *
 *   - the Problem is gone, or was never this owner's, or has had automatic
 *     reading switched off — the row comes back with no Problem, and the
 *     candidate is simply dropped;
 *   - the Problem is there and its Environment is not — impossible against a
 *     non-null column and a foreign key, so a fact about the database rather
 *     than about the search, and raised;
 *   - the Problem is there and has no Verifications — completely ordinary,
 *     and returned as an empty list.
 *
 * An inner join would collapse the first two into one answer, and the second
 * would be silently reported as a Memory that had disappeared. The `with
 * ordinality` also keeps the caller's order intact without a second sort.
 *
 * Verifications are joined rather than aggregated into JSON. One row per
 * (candidate, verification) is a handful of rows at this size, and it keeps
 * every value a real column with a real type — a timestamp stays a timestamp
 * rather than becoming text that has to be parsed back.
 */

import type { VerificationType } from '../domain/enums.js';
import type { EnvironmentSnapshot } from '../domain/environment.js';
import type { OwnerContext } from '../domain/owner.js';
import type { ProblemId } from '../domain/problem.js';
import type { DatabaseExecutor } from './executor.js';

/** One Verification, as stored, in the order it was performed. */
export interface RevalidationEvidenceRow {
  readonly verificationType: VerificationType;
  readonly result: boolean;
  readonly summary: string;
  readonly evidenceRef: string | null;
  readonly createdAt: Date;
}

/**
 * What one candidate came back as.
 *
 * `historicalEnvironment` is `undefined` only in the impossible case above;
 * the caller raises rather than returning a Memory with no conditions.
 */
export interface RevalidationRow {
  readonly problemId: ProblemId;
  readonly historicalEnvironment: EnvironmentSnapshot | undefined;
  readonly evidence: readonly RevalidationEvidenceRow[];
}

interface Row {
  problem_id: string | null;
  snapshot: EnvironmentSnapshot | null;
  verification_id: string | null;
  verification_type: VerificationType | null;
  result: boolean | null;
  summary: string | null;
  evidence_ref: string | null;
  created_at: Date | null;
}

/**
 * One statement, owner-scoped, with the read control applied again.
 *
 * The owner predicate sits in the join rather than in a `where`, because a
 * `where` on a left-joined table turns it back into an inner join and takes
 * the distinction above with it.
 */
export const REVALIDATION_STATEMENT = `
  select pr.problem_id as problem_id,
         e.snapshot as snapshot,
         v.verification_id as verification_id,
         v.verification_type as verification_type,
         v.result as result,
         v.summary as summary,
         v.evidence_ref as evidence_ref,
         v.created_at as created_at
    from unnest($2::uuid[]) with ordinality as requested(problem_id, position)
    left join public.problems pr
      on pr.owner_id = $1
     and pr.problem_id = requested.problem_id
     and pr.memory_read_enabled
    left join public.environments e
      on e.owner_id = pr.owner_id
     and e.environment_id = pr.environment_id
    left join public.verifications v
      on v.owner_id = pr.owner_id
     and v.problem_id = pr.problem_id
   order by requested.position asc, v.created_at asc, v.verification_id asc`;

/**
 * What each of these Problems was recorded under, for the ones still readable.
 *
 * Keyed by Problem so the caller can drop what is missing without having to
 * match up positions. Unknown, another owner's, deleted and read-disabled all
 * come back the same way — absent — as everywhere else.
 *
 * A read, and only a read.
 */
export async function readRevalidationContext(
  executor: DatabaseExecutor,
  context: OwnerContext,
  problemIds: readonly ProblemId[],
): Promise<Map<ProblemId, RevalidationRow>> {
  if (problemIds.length === 0) {
    // Nothing to ask about. An empty array would work and would still be a
    // round trip.
    return new Map();
  }

  const result = await executor.query<Row>(REVALIDATION_STATEMENT, [
    context.ownerId,
    [...problemIds],
  ]);

  const byProblem = new Map<
    ProblemId,
    { snapshot: EnvironmentSnapshot | null; evidence: RevalidationEvidenceRow[] }
  >();

  for (const row of result.rows) {
    if (row.problem_id === null) {
      // The candidate is not this owner's to see any more. Which of the four
      // reasons applies is deliberately not knowable from here.
      continue;
    }

    const problemId = row.problem_id as ProblemId;
    let entry = byProblem.get(problemId);
    if (entry === undefined) {
      entry = { snapshot: row.snapshot, evidence: [] };
      byProblem.set(problemId, entry);
    }

    // Null across every verification column is the left join reporting that
    // this Problem has none, not a malformed row.
    if (
      row.verification_id === null ||
      row.verification_type === null ||
      row.result === null ||
      row.summary === null ||
      row.created_at === null
    ) {
      continue;
    }

    entry.evidence.push({
      verificationType: row.verification_type,
      result: row.result,
      summary: row.summary,
      evidenceRef: row.evidence_ref,
      createdAt: row.created_at,
    });
  }

  return new Map(
    [...byProblem].map(([problemId, entry]) => [
      problemId,
      {
        problemId,
        historicalEnvironment: entry.snapshot ?? undefined,
        evidence: entry.evidence,
      },
    ]),
  );
}
