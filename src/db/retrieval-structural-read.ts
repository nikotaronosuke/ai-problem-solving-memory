/**
 * Reading the structural side of a handful of artifacts, in one statement.
 *
 * The hybrid stage hands on identities and positions and nothing else, which
 * is right — carrying artifact text through a stage that only orders things
 * would make that stage handle content it never looks at. So the reranking
 * stage fetches what it needs, and this is that fetch: up to twenty Problems,
 * one query.
 *
 * One statement rather than twenty reads, for the obvious reason and a less
 * obvious one. Twenty round trips is twenty round trips; but they would also
 * be twenty separate snapshots, so a Problem could be readable at the third
 * and gone by the seventeenth, and the set handed to a reranker would describe
 * a state that never existed.
 *
 * **Three columns, deliberately.** The owner and the read control are enforced
 * here rather than trusted from upstream — the hybrid stage checked them, and
 * between then and now a Problem can be deleted or have automatic reading
 * turned off, so what was true a moment ago is not a filter. Everything else
 * an artifact holds is left in the table: the summary, the keywords and the
 * embedding are not needed to compare structure, and a reranking stage that
 * pulled them would be handling text it has no use for and no business
 * sending anywhere.
 *
 * A Problem that has vanished, lost its artifact, been switched off or never
 * belonged to this owner simply does not come back — one answer for all four,
 * as everywhere else, so a caller cannot learn which.
 */

import type { OwnerContext } from '../domain/owner.js';
import type { ProblemId } from '../domain/problem.js';
import type { ProjectId } from '../domain/project.js';
import { RETRIEVAL_SOURCE_FINGERPRINT_CURRENT_PREFIX } from '../domain/retrieval-summary.js';
import type { DatabaseExecutor } from './executor.js';

/**
 * One candidate's structural side, exactly as stored.
 *
 * `structuralFeatures` is `unknown` on purpose. It is JSON that a past
 * generation wrote; the database vouches for it being an object and for
 * nothing else, so it is parsed by the domain before anything reads it.
 */
export interface StructuralArtifactRow {
  readonly problemId: ProblemId;
  readonly projectId: ProjectId;
  readonly structuralFeatures: unknown;
}

interface Row {
  problem_id: string;
  project_id: string;
  structural_features: unknown;
}

export const STRUCTURAL_ARTIFACT_STATEMENT = `
  select ra.problem_id as problem_id,
         pr.project_id as project_id,
         ra.structural_features as structural_features
    from public.retrieval_artifacts ra
    join public.problems pr
      on pr.owner_id = ra.owner_id
     and pr.problem_id = ra.problem_id
   where ra.owner_id = $1
     and pr.memory_read_enabled
     and starts_with(ra.source_fingerprint, $3)
     and ra.problem_id = any($2::uuid[])`;

/**
 * The structural side of whichever of these Problems this owner can still see.
 *
 * Returns no particular order and makes no promise of completeness: fewer rows
 * than identifiers is the ordinary outcome of a Problem changing underneath a
 * search. A read, and only a read.
 */
export async function readStructuralArtifacts(
  executor: DatabaseExecutor,
  context: OwnerContext,
  problemIds: readonly ProblemId[],
): Promise<StructuralArtifactRow[]> {
  if (problemIds.length === 0) {
    // Nothing to ask about. Sending an empty array would work and would still
    // be a round trip.
    return [];
  }

  const result = await executor.query<Row>(STRUCTURAL_ARTIFACT_STATEMENT, [
    context.ownerId,
    [...problemIds],
    // Source-schema gate. An incompatible artifact contributes no structural
    // material, which downstream reads as data unavailable — the degraded
    // path that already exists for a missing artifact.
    RETRIEVAL_SOURCE_FINGERPRINT_CURRENT_PREFIX,
  ]);

  return result.rows.map((row) => ({
    problemId: row.problem_id as ProblemId,
    projectId: row.project_id as ProjectId,
    structuralFeatures: row.structural_features,
  }));
}
