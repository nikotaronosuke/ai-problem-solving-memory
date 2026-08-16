/**
 * Reading everything a ranking needs, in one statement.
 *
 * Two things are wanted: the current Project's technology label, and, for each
 * candidate, the controls that decide where it belongs in the list. They are
 * fetched together, and the reason is not round trips.
 *
 * **Every field here can change while a search is running.** `platform` is
 * editable, and so are `confidence`, `freshness` and `suppressed`. Read the
 * current Project in one statement and the candidates in another, and a label
 * edited in between produces a comparison against a Project state that never
 * coexisted with the candidates — a "same technology" verdict for a pairing
 * that did not exist at any instant. One statement is one snapshot, so
 * whatever the answer is, it is an answer about a state the database really
 * held.
 *
 * The current Project comes back as its own row rather than being repeated on
 * every candidate row, so that a Project that is missing — or belongs to
 * somebody else — is visible even when no candidate survives the filters. Both
 * of those are the same absence: a caller cannot use a ranking to find out
 * whether another owner's Project identifier is real.
 *
 * **The columns are the ones the policy reads and no others.** No importance,
 * no status, no timestamps, no environment, no artifact. Reading a field
 * "because a later stage might want it" would put it within reach of a
 * comparison that has no business consulting it, and a timestamp especially:
 * currency is what `freshness` says it is, not what a clock implies.
 */

import type { Confidence, Freshness } from '../domain/enums.js';
import type { OwnerContext } from '../domain/owner.js';
import type { ProblemId } from '../domain/problem.js';
import type { ProjectId } from '../domain/project.js';
import type { DatabaseExecutor } from './executor.js';

/** One candidate's ranking controls, exactly as stored. */
export interface RankingMetadataRow {
  readonly problemId: ProblemId;
  readonly projectId: ProjectId;
  readonly confidence: Confidence;
  readonly freshness: Freshness;
  readonly suppressed: boolean;
  /** The candidate Project's free-form technology label, or null. */
  readonly platform: string | null;
}

/**
 * What one snapshot saw.
 *
 * `currentProjectFound` is false when the current Project is not this owner's,
 * whether because it belongs to somebody else or because it does not exist.
 */
export interface RankingMetadataSnapshot {
  readonly currentProjectFound: boolean;
  readonly currentPlatform: string | null;
  readonly candidates: readonly RankingMetadataRow[];
}

interface Row {
  kind: 'current' | 'candidate';
  problem_id: string | null;
  project_id: string | null;
  confidence: Confidence | null;
  freshness: Freshness | null;
  suppressed: boolean | null;
  platform: string | null;
}

/**
 * One statement, two kinds of row, discriminated by `kind`.
 *
 * The owner is applied to the Project and to the Problem, and the join to
 * `projects` is owner-scoped as well, so a candidate cannot pick up another
 * owner's technology label. `memory_read_enabled` is applied again here rather
 * than trusted from the earlier stage: it was true when that stage ran, and
 * that is a fact about then.
 */
export const RANKING_METADATA_STATEMENT = `
  select 'current' as kind,
         null::uuid as problem_id,
         cp.project_id as project_id,
         null::text as confidence,
         null::text as freshness,
         null::boolean as suppressed,
         cp.platform as platform
    from public.projects cp
   where cp.owner_id = $1
     and cp.project_id = $2
   union all
  select 'candidate' as kind,
         pr.problem_id as problem_id,
         pr.project_id as project_id,
         pr.confidence as confidence,
         pr.freshness as freshness,
         pr.suppressed as suppressed,
         pj.platform as platform
    from public.problems pr
    join public.projects pj
      on pj.owner_id = pr.owner_id
     and pj.project_id = pr.project_id
   where pr.owner_id = $1
     and pr.memory_read_enabled
     and pr.problem_id = any($3::uuid[])`;

/**
 * The ranking controls for whichever of these Problems is still readable.
 *
 * Fewer candidate rows than identifiers is ordinary: a Problem can be deleted
 * or have automatic reading switched off between one stage and the next.
 * Unknown, another owner's, deleted and read-disabled are one answer.
 *
 * A read, and only a read.
 */
export async function readRankingMetadata(
  executor: DatabaseExecutor,
  context: OwnerContext,
  currentProjectId: ProjectId,
  problemIds: readonly ProblemId[],
): Promise<RankingMetadataSnapshot> {
  const result = await executor.query<Row>(RANKING_METADATA_STATEMENT, [
    context.ownerId,
    currentProjectId,
    [...problemIds],
  ]);

  let currentProjectFound = false;
  let currentPlatform: string | null = null;
  const candidates: RankingMetadataRow[] = [];

  for (const row of result.rows) {
    if (row.kind === 'current') {
      currentProjectFound = true;
      currentPlatform = row.platform;
      continue;
    }
    candidates.push({
      problemId: row.problem_id as ProblemId,
      projectId: row.project_id as ProjectId,
      confidence: row.confidence as Confidence,
      freshness: row.freshness as Freshness,
      suppressed: row.suppressed as boolean,
      platform: row.platform,
    });
  }

  return { currentProjectFound, currentPlatform, candidates };
}
