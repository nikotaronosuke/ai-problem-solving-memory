/**
 * Reading everything a retrieval summary is generated from, as one document.
 *
 * **One statement, one snapshot.** Four ordinary reads — the Problem, its
 * Environment, its Events, its Verifications — take four snapshots under the
 * default isolation level, so a write landing between the second and the third
 * produces a document describing a state that never existed: a Problem whose
 * Events include a conclusion its status does not, or an Environment that
 * belongs to a Problem as it was a moment ago. That document would then be
 * fingerprinted, and the fingerprint would claim a source state that no
 * transaction ever saw. One statement sees one snapshot by definition, needs
 * no transaction, sets no isolation level and blocks no writer. The export
 * reads its eight tables the same way and for the same reason.
 *
 * It also matters that this is *short*. A generator may take seconds and may be
 * a network call, and the alternative way to get a consistent read — open a
 * transaction, hold it across the generation — would keep a connection and a
 * snapshot checked out for the duration of somebody else's inference. So the
 * read finishes before the generator starts, and the check that the source has
 * not moved is a second read of the same kind rather than a lock held over the
 * first.
 *
 * **The document is built here, in SQL, and returned as text.** Not assembled
 * in JavaScript from parsed rows, and the reason is measurable: an Environment
 * snapshot is `jsonb`, which stores numbers as `numeric`, and the driver parses
 * that into a JavaScript number — so a build identifier like
 * 12345678901234567890 comes back as ...567000 before anything here could
 * notice. Text out of PostgreSQL keeps the digits. The same choice settles key
 * ordering for free: `jsonb` normalises key order on the way in, so two
 * snapshots written with the same fields in different orders render as the same
 * bytes, and the fingerprint of a Memory does not depend on the order somebody's
 * adapter happened to serialise a JSON object.
 *
 * **What is in the document is what the generator is shown.** No owner id and
 * no problem id: identifiers are not evidence about a problem, and putting them
 * in would invite a summary that names them. No `confidence`, `freshness`,
 * `importance`, `suppressed` or memory controls either — those are judgements
 * about a Memory rather than content of one, they are read live by whatever
 * ranks results, and a summary that had to be regenerated because a confidence
 * was adjusted would be regenerated for no reason. No `source_ai`, no
 * `evidence_ref`, no `client_event_id`, no identifiers and no timestamps.
 *
 * Timestamps do appear in the `order by`, and only there. The order of Events
 * is part of what an investigation means; the wall-clock time it happened is
 * not something a search compares.
 */

import type { ProblemStatus } from '../domain/enums.js';
import type { OwnerContext } from '../domain/owner.js';
import type { ProblemId } from '../domain/problem.js';
import type { ProjectId } from '../domain/project.js';
import { RETRIEVAL_SOURCE_SCHEMA_VERSION } from '../domain/retrieval-summary.js';
import type { DatabaseExecutor } from './executor.js';

/**
 * One consistent read of a Problem, as a summary generator needs it.
 *
 * `canonicalSource` is the document itself. The rest are facts *about* the
 * Problem that the generator is not shown: whether its owner has turned
 * automatic reading off, what may legitimately be claimed about a fix, and
 * which Project the Problem is in. They travel beside the document rather than
 * inside it because none is semantic content — including them would make a
 * summary regenerate when a control was toggled, and would let a generator
 * read its own permission.
 *
 * `projectId` was added for retrieval rather than for generation, and the
 * distinction is the point: it is metadata, so it is **not** in the canonical
 * document and cannot move the fingerprint. A search needs to know which
 * Project the work is happening in, and asking the caller would let a caller
 * name one Problem and a different Project's neighbourhood; reading it from
 * the same row makes that contradiction unstateable.
 */
export interface RetrievalSummarySource {
  readonly canonicalSource: string;
  readonly memoryReadEnabled: boolean;
  readonly status: ProblemStatus;
  readonly hasSuccessfulVerification: boolean;
  readonly projectId: ProjectId;
}

interface SourceRow {
  canonical_source: string;
  memory_read_enabled: boolean;
  status: ProblemStatus;
  has_successful_verification: boolean;
  project_id: string;
}

/**
 * The Events an investigation is made of, oldest first.
 *
 * All six types, every one of them. A summary that dropped `DEAD_END` would
 * lose the half of the experience that says where not to look; one that dropped
 * `USER_CORRECTION` could describe a superseded misunderstanding as current;
 * one that dropped `DISCOVERY` would lose the established cause, which is where
 * concluding a Problem records what turned out to be true. `HYPOTHESIS` and
 * `ATTEMPT` are kept for the same reason in reverse — what was suspected and
 * what was tried are the conditions a later reader matches against.
 *
 * The tie-break on the identifier matters more than it looks: concluding a
 * Problem writes several Events in one transaction, so they share a timestamp
 * to the microsecond, and without it their order — and therefore the digest —
 * would be whatever the plan happened to produce.
 */
const EVENTS = `
      coalesce((
        select json_agg(json_build_object(
                 'event_type', ev.event_type,
                 'summary', ev.summary,
                 'result', ev.result,
                 'reason', ev.reason
               ) order by ev.created_at asc, ev.event_id asc)
          from public.events ev
         where ev.owner_id = pr.owner_id and ev.problem_id = pr.problem_id
      ), '[]'::json)`;

/**
 * What was checked, and whether it held.
 *
 * `result` is the whole reason Verifications are separate from fixes: a failed
 * check is evidence too, and a summary that only carried successes would read
 * as though everything tried had worked.
 */
const VERIFICATIONS = `
      coalesce((
        select json_agg(json_build_object(
                 'verification_type', v.verification_type,
                 'result', v.result,
                 'summary', v.summary
               ) order by v.created_at asc, v.verification_id asc)
          from public.verifications v
         where v.owner_id = pr.owner_id and v.problem_id = pr.problem_id
      ), '[]'::json)`;

/**
 * The document, and the three facts that travel beside it.
 *
 * `json_build_object` rather than `jsonb_build_object` for the outer shape, so
 * the keys stay in the order written here and the document reads top-down as a
 * person would describe the Problem. The Environment snapshot is embedded as
 * the `jsonb` it is stored as, which is what makes its own key order canonical
 * and its numbers exact — the two properties this whole approach exists for.
 *
 * Every subquery is scoped by owner as well as by problem. The composite
 * foreign keys already make a cross-owner row unstorable, so matching on the
 * problem alone would happen to be safe today; it would also be one schema edit
 * away from not being, and the owner predicate costs nothing.
 */
export const RETRIEVAL_SUMMARY_SOURCE_STATEMENT = `
  select json_build_object(
           'schema_version', $3::text,
           'problem', json_build_object(
             'title', pr.title,
             'symptoms', pr.symptoms,
             'problem_domain', pr.problem_domain,
             'suspected_boundary', pr.suspected_boundary,
             'status', pr.status,
             'fix_kind', pr.fix_kind
           ),
           'environment', e.snapshot,
           'events', ${EVENTS},
           'verifications', ${VERIFICATIONS}
         )::text as canonical_source,
         pr.memory_read_enabled as memory_read_enabled,
         pr.status as status,
         -- Beside the document, never inside it. The object above is what the
         -- fingerprint is taken over, and a Project identifier appearing there
         -- would make every artifact regenerate for a fact no summary
         -- describes.
         pr.project_id as project_id,
         exists (
           select 1
             from public.verifications sv
            where sv.owner_id = pr.owner_id
              and sv.problem_id = pr.problem_id
              and sv.result
         ) as has_successful_verification
    from public.problems pr
    join public.environments e
      on e.owner_id = pr.owner_id
     and e.environment_id = pr.environment_id
   where pr.owner_id = $1
     and pr.problem_id = $2`;

/**
 * Reads one Problem's generation source, if this owner has one.
 *
 * `undefined` for a Problem that does not exist and for one belonging to
 * somebody else, which are the same answer here as everywhere else: a caller
 * able to tell them apart would have an oracle for whether an identifier is in
 * use. A Problem deleted between two calls answers `undefined` too, which is
 * what makes the second read a real check rather than a formality.
 *
 * This module reads and returns. It writes nothing, and generating a summary
 * must never be a way to change the record it was generated from.
 */
export async function readRetrievalSummarySource(
  executor: DatabaseExecutor,
  context: OwnerContext,
  problemId: ProblemId,
): Promise<RetrievalSummarySource | undefined> {
  const result = await executor.query<SourceRow>(RETRIEVAL_SUMMARY_SOURCE_STATEMENT, [
    context.ownerId,
    problemId,
    RETRIEVAL_SOURCE_SCHEMA_VERSION,
  ]);

  const row = result.rows[0];
  if (row === undefined) {
    return undefined;
  }

  return {
    canonicalSource: row.canonical_source,
    memoryReadEnabled: row.memory_read_enabled,
    status: row.status,
    hasSuccessfulVerification: row.has_successful_verification,
    projectId: row.project_id as ProjectId,
  };
}
