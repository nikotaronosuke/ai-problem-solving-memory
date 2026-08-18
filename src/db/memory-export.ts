/**
 * Reading one owner's whole Memory, as one document, in one statement.
 *
 * Every other read here returns rows that TypeScript maps into records. This
 * one returns finished JSON text, and the two reasons are worth stating before
 * the SQL, because both of them are the answer to "why not eight ordinary
 * queries and an object literal?".
 *
 * **One statement, one snapshot.** An export has to be internally consistent:
 * every Problem it names must have its events, and every relation it carries
 * must point at a Problem that is also in the file. Eight statements under the
 * default isolation level take eight snapshots, so a delete landing between the
 * third and the fourth produces an artifact describing a state that never
 * existed — a Problem with no events, or a relation pointing at nothing. A
 * single statement sees one snapshot by definition. It needs no transaction, no
 * isolation level to remember to set, and it blocks no writer.
 *
 * **Precision that does not survive JavaScript.** Two kinds of value in this
 * schema cannot make the trip through a JS object:
 *
 *   - `timestamptz` keeps microseconds. The driver returns a `Date`, which
 *     keeps milliseconds, so `2026-08-14T05:29:00.123456Z` becomes
 *     `...00.123Z` before anything here could notice. The timestamps below are
 *     formatted by PostgreSQL, to six digits, and never become a `Date`.
 *   - `jsonb` keeps numbers as `numeric`. `JSON.parse` turns
 *     12345678901234567890 into 12345678901234567000. An environment snapshot
 *     is whatever the conditions were and may well contain a build number
 *     larger than JavaScript can hold, so the snapshot is embedded as JSON by
 *     the database and the whole document is fetched as `text`.
 *
 * The second point is why the result is text rather than the driver's parsed
 * JSON: asking for `json` would have the driver parse it, which is the loss
 * this exists to avoid.
 *
 * `owner_id` is on all eight tables and is on none of the records below. It
 * appears once, as `source_owner_id`, at the top. Repeating the same UUID on
 * every row of a large file says nothing new, and the artifact should not read
 * as though ownership were a property of each record when it is a property of
 * the export.
 *
 * Every subquery is scoped by owner. The composite foreign keys make a
 * cross-owner reference impossible in the first place, so the artifact is
 * closed under its own references — but a statement that matched on anything
 * less would be one edit from not being.
 */

import type { DatabaseExecutor } from './executor.js';
import {
  MEMORY_EXPORT_SCHEMA_VERSION,
  type MemoryExportArtifact,
} from '../domain/memory-export.js';
import type { OwnerContext } from '../domain/owner.js';

/**
 * A timestamp as the database holds it: UTC, six fractional digits.
 *
 * `to_char` rather than a cast, because a cast would go through the driver's
 * `Date` and lose the last three digits.
 */
const ts = (column: string): string =>
  `to_char(${column} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * One collection, aggregated and ordered.
 *
 * `coalesce(..., '[]')` so an owner with no problems gets an empty array rather
 * than `null`. A reader should not have to tell "no rows" from "this export
 * does not cover problems".
 *
 * The ordering matches every other list in this codebase — oldest first, with
 * the primary key breaking ties — so two exports of the same data are the same
 * bytes, and a diff between two exports means something.
 */
const collection = (fields: string, from: string, alias: string, id: string): string => `
    coalesce((
      select json_agg(json_build_object(${fields}) order by ${alias}.created_at asc, ${alias}.${id} asc)
        from public.${from} ${alias}
       where ${alias}.owner_id = $1
    ), '[]'::json)`;

const PROJECTS = collection(
  `'project_id', p.project_id,
       'project_name', p.project_name,
       'repo', p.repo,
       'platform', p.platform,
       'repo_subpath', p.repo_subpath,
       'created_at', ${ts('p.created_at')},
       'updated_at', ${ts('p.updated_at')}`,
  'projects',
  'p',
  'project_id',
);

const ENVIRONMENTS = collection(
  `'environment_id', e.environment_id,
       'project_id', e.project_id,
       'snapshot', e.snapshot,
       'created_at', ${ts('e.created_at')}`,
  'environments',
  'e',
  'environment_id',
);

const PROBLEMS = collection(
  `'problem_id', pr.problem_id,
       'project_id', pr.project_id,
       'environment_id', pr.environment_id,
       'title', pr.title,
       'symptoms', pr.symptoms,
       'problem_domain', pr.problem_domain,
       'suspected_boundary', pr.suspected_boundary,
       'source_ai', pr.source_ai,
       'status', pr.status,
       'fix_kind', pr.fix_kind,
       'importance', pr.importance,
       'confidence', pr.confidence,
       'freshness', pr.freshness,
       'memory_read_enabled', pr.memory_read_enabled,
       'memory_write_enabled', pr.memory_write_enabled,
       'suppressed', pr.suppressed,
       'version', pr.version,
       'created_at', ${ts('pr.created_at')},
       'updated_at', ${ts('pr.updated_at')}`,
  'problems',
  'pr',
  'problem_id',
);

const EVENTS = collection(
  `'event_id', ev.event_id,
       'problem_id', ev.problem_id,
       'event_type', ev.event_type,
       'summary', ev.summary,
       'result', ev.result,
       'reason', ev.reason,
       'source_ai', ev.source_ai,
       'evidence_ref', ev.evidence_ref,
       'client_event_id', ev.client_event_id,
       'created_at', ${ts('ev.created_at')}`,
  'events',
  'ev',
  'event_id',
);

const VERIFICATIONS = collection(
  `'verification_id', v.verification_id,
       'problem_id', v.problem_id,
       'verification_type', v.verification_type,
       'result', v.result,
       'summary', v.summary,
       'evidence_ref', v.evidence_ref,
       'verified_by', v.verified_by,
       'client_event_id', v.client_event_id,
       'created_at', ${ts('v.created_at')}`,
  'verifications',
  'v',
  'verification_id',
);

const RELATIONS = collection(
  `'relation_id', r.relation_id,
       'from_id', r.from_id,
       'to_id', r.to_id,
       'relation_type', r.relation_type,
       'reason', r.reason,
       'created_at', ${ts('r.created_at')}`,
  'relations',
  'r',
  'relation_id',
);

const USAGE_LOGS = collection(
  `'usage_log_id', u.usage_log_id,
       'problem_id', u.problem_id,
       'source_ai', u.source_ai,
       'action', u.action,
       'memory_id', u.memory_id,
       'reason', u.reason,
       'result', u.result,
       'created_at', ${ts('u.created_at')}`,
  'usage_logs',
  'u',
  'usage_log_id',
);

const CHANGE_LOGS = collection(
  `'change_log_id', c.change_log_id,
       'problem_id', c.problem_id,
       'changed_by', c.changed_by,
       'from_version', c.from_version,
       'to_version', c.to_version,
       'changes', c.changes,
       'created_at', ${ts('c.created_at')}`,
  'change_logs',
  'c',
  'change_log_id',
);

/**
 * The whole document.
 *
 * Exported so an architecture test can inspect the statement that actually
 * runs rather than the template above that builds it. Reading the source text
 * would check the shape of the generator; reading this checks the SQL, which
 * is where an owner filter would go missing.
 *
 * `statement_timestamp()` rather than `now()`: it is the moment this statement
 * began, which is the moment the snapshot describes. `now()` is the start of
 * the surrounding transaction, which for an export run inside one would be
 * earlier than the data it reports.
 */
export const MEMORY_EXPORT_STATEMENT = `
select json_build_object(
  'schema_version', $2::text,
  'exported_at', ${ts('statement_timestamp()')},
  'source_owner_id', $1::uuid,
  'projects', ${PROJECTS},
  'environments', ${ENVIRONMENTS},
  'problems', ${PROBLEMS},
  'events', ${EVENTS},
  'verifications', ${VERIFICATIONS},
  'relations', ${RELATIONS},
  'usage_logs', ${USAGE_LOGS},
  'change_logs', ${CHANGE_LOGS}
)::text as artifact`;

/**
 * The collections an export carries, in the order they appear.
 *
 * Exported so a test can assert the inventory is exactly these eight. A ninth
 * Memory table added without joining the export would otherwise be missing
 * from every artifact and from every backup, silently.
 */
export const MEMORY_EXPORT_COLLECTIONS = [
  'projects',
  'environments',
  'problems',
  'events',
  'verifications',
  'relations',
  'usage_logs',
  'change_logs',
] as const;

/**
 * Exports everything belonging to the context owner.
 *
 * Reads only, writes nothing, and takes no lock: exporting a Memory must not
 * change it, and must not stop anyone from working while it runs.
 */
export async function exportOwnerMemory(
  executor: DatabaseExecutor,
  context: OwnerContext,
): Promise<MemoryExportArtifact> {
  const result = await executor.query<{ artifact: string }>(MEMORY_EXPORT_STATEMENT, [
    context.ownerId,
    MEMORY_EXPORT_SCHEMA_VERSION,
  ]);

  const row = result.rows[0];
  if (row === undefined) {
    // `json_build_object` over scalar subqueries always produces one row, so
    // this is unreachable rather than a case to handle. Returning an empty
    // artifact would be inventing an export nobody made.
    throw new Error('Memory export returned no row.');
  }

  return { json: row.artifact };
}
