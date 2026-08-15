/**
 * Finding retrieval artifacts by the words in them.
 *
 * One statement, four things it is careful about.
 *
 * **The owner, in the statement rather than above it.** Another owner's
 * artifact is never scored, never ordered and never truncated away by a
 * `LIMIT` — it is excluded by the `where` clause, so it cannot influence what
 * comes back even indirectly. The join carries the owner too, although the
 * composite foreign key already makes a cross-owner pair unstorable: matching
 * on the problem alone would be correct today and one schema edit from not
 * being.
 *
 * **`memory_read_enabled`, in the statement for a reason that is easy to get
 * wrong.** Generation already refuses a Problem whose owner has turned reading
 * off, so it might look as though no artifact could exist for one. It can:
 * the flag can be turned off *after* the artifact was written, and the row
 * stays — turning off automatic reading is not a delete, and the specification
 * keeps those separate. Filtering above the query would mean the rows were
 * fetched, ranked and counted first, which is the wrong place for a decision
 * the owner made about their own Memory.
 *
 * **The stored column, not the expression.** The `where` and the `order by`
 * both name `search_document`. Recomputing the document inline would be
 * correct, would produce identical results, and would silently stop using the
 * index — measured at 218 ms against 0.1 ms on twenty thousand rows. Naming the
 * column makes that mistake a missing-column error instead of a slow search.
 *
 * **The order is total.** Ties on the score break on the problem id, so two
 * runs of the same search return the same rows in the same order and a smaller
 * `limit` returns a prefix of the larger one's answer rather than an arbitrary
 * subset. `generated_at` is deliberately not the tie-break: it is not evidence
 * of anything about currency, which is the whole reason the fingerprint exists.
 *
 * What is *not* here: any notion of a good Memory. Suppressed, stale,
 * superseded, invalid and low-confidence artifacts all come back. Ordering
 * them by anything but word overlap is a policy decision that belongs to the
 * task that owns ranking, and quietly filtering them here would make that task
 * impossible to write correctly.
 */

import type { OwnerContext } from '../domain/owner.js';
import type { ProblemId } from '../domain/problem.js';
import type { ProjectId } from '../domain/project.js';
import {
  RETRIEVAL_TEXT_SEARCH_CONFIG,
  type FullTextCandidate,
  type ResolvedFullTextSearchQuery,
} from '../domain/retrieval-search.js';
import type { DatabaseExecutor } from './executor.js';

interface CandidateRow {
  problem_id: string;
  project_id: string;
  lexical_score: number;
}

/**
 * The query, parsed by PostgreSQL's web-search grammar.
 *
 * `websearch_to_tsquery` rather than `to_tsquery`, which raises a syntax error
 * on ordinary prose — `oauth redirect` is not valid `tsquery` input, and a
 * search surface whose failure mode is a database error for normal text is not
 * a search surface. This one accepts anything: quoted phrases, `OR`, and a
 * leading `-` to exclude are understood, and everything else becomes terms.
 *
 * The configuration is a fixed literal from the domain, interpolated here and
 * never taken from a caller. Everything else is a bound parameter.
 */
const TSQUERY = `websearch_to_tsquery('${RETRIEVAL_TEXT_SEARCH_CONFIG}', $2)`;

/**
 * `$3` and `$4` are optional filters expressed as "null means everything".
 *
 * Written as `($3::uuid is null or ...)` so one statement serves all four
 * combinations. Building the SQL conditionally would put four texts in front of
 * the planner and give this module a reason to assemble SQL from parts, which
 * is how a filter ends up interpolated.
 */
export const FULL_TEXT_SEARCH_STATEMENT = `
  select ra.problem_id as problem_id,
         pr.project_id as project_id,
         ts_rank_cd(ra.search_document, ${TSQUERY}) as lexical_score
    from public.retrieval_artifacts ra
    join public.problems pr
      on pr.owner_id = ra.owner_id
     and pr.problem_id = ra.problem_id
   where ra.owner_id = $1
     and pr.memory_read_enabled
     and ra.search_document @@ ${TSQUERY}
     and ($3::uuid is null or pr.project_id = $3::uuid)
     and ($4::uuid is null or ra.problem_id <> $4::uuid)
   order by lexical_score desc, ra.problem_id asc
   limit $5`;

/**
 * Candidates whose artifact text matches, best first.
 *
 * An empty list is an ordinary answer, and today it is the usual one: nothing
 * in this system generates artifacts yet, so there is normally nothing to find.
 * This looks at what is stored and never creates it — a search that generated
 * what it could not find would turn a read into a write, and would do it at the
 * moment somebody was waiting for an answer.
 */
export async function searchArtifactsByText(
  executor: DatabaseExecutor,
  context: OwnerContext,
  query: ResolvedFullTextSearchQuery,
): Promise<FullTextCandidate[]> {
  const result = await executor.query<CandidateRow>(FULL_TEXT_SEARCH_STATEMENT, [
    context.ownerId,
    query.text,
    query.projectId,
    query.excludeProblemId,
    query.limit,
  ]);

  return result.rows.map((row) => ({
    problemId: row.problem_id as ProblemId,
    projectId: row.project_id as ProjectId,
    // `real` in the database, a number here. Compared and ordered, never
    // tested for equality: what it is for is saying which of two candidates
    // matched better.
    lexicalScore: row.lexical_score,
  }));
}
