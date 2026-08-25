/**
 * Finding the Problems whose artifact needs generating, in one read.
 *
 * This is the liveness half of the lifecycle. The correctness half — a stale
 * artifact cannot be searched, because the mutation that staled it deleted it
 * in the same atom — never depends on anything here running. What this read
 * restores is *presence*: after a crash took the in-process queue, after a
 * provider outage let attempts fail, after a deploy changed the configured
 * generation stack, this is how the system finds its way back to every
 * artifact existing and being current. Run at startup it is also the
 * backfill: a database full of Problems and empty of artifacts is simply a
 * database where every row answers `ARTIFACT_MISSING`.
 *
 * Three findings, in order of what they mean:
 *
 * - **`ARTIFACT_MISSING`** — no row. Never generated, invalidated by a
 *   canonical write, or a failed generation not yet retried. Deliberately one
 *   answer: distinguishing them would need persistent state whose only reader
 *   would be this comment.
 * - **`SOURCE_SCHEMA_INCOMPATIBLE`** — a row fingerprinted under another
 *   source schema. Hard: the readers' gate is already keeping it out of every
 *   channel, so regenerating it is what makes the Problem findable again.
 * - **`GENERATION_PROFILE_OUTDATED`** — a row from another generator,
 *   embedding model, version, dimension count, or structural feature schema.
 *   Soft: it still describes the current source and still serves the channels
 *   that can read it, and regeneration replaces it rather than anything
 *   deleting it first.
 *
 * What is *not* checked here: whether the fingerprint still matches the
 * current canonical source. That comparison would mean rebuilding and hashing
 * every Problem's source document on every sweep — and it is exactly the
 * comparison the atomic invalidation makes unnecessary, because a mutated
 * source no longer has an artifact row to be wrong about.
 *
 * Read-disabled Problems are excluded at the top: reconciliation's output is
 * a list of Problems whose source will be handed to a generator, and a
 * Problem whose owner said "do not read this automatically" must never be on
 * it. Deleted Problems cannot appear — the scan starts from `problems`, and
 * the delete path takes the artifact too.
 *
 * The scan is bounded and ordered. Oldest Problems first, so a backlog is
 * worked through in a stable order and no Problem starves behind newer ones;
 * a limit, so a large backlog is a series of small sweeps rather than one
 * unbounded one.
 */

import type { OwnerContext } from '../domain/owner.js';
import type { ProblemId } from '../domain/problem.js';
import {
  requireRetrievalGenerationProfile,
  type RetrievalGenerationProfile,
} from '../domain/retrieval-generation-profile.js';
import {
  RETRIEVAL_SOURCE_FINGERPRINT_CURRENT_PREFIX,
  STRUCTURAL_FEATURE_SCHEMA_VERSION,
} from '../domain/retrieval-summary.js';
import type { DatabaseExecutor } from './executor.js';

/** Why a Problem needs generation. A closed set, safe to count and to log. */
export const ARTIFACT_GENERATION_REASONS = [
  'ARTIFACT_MISSING',
  'SOURCE_SCHEMA_INCOMPATIBLE',
  'GENERATION_PROFILE_OUTDATED',
] as const;

export type ArtifactGenerationReason = (typeof ARTIFACT_GENERATION_REASONS)[number];

/** One Problem that needs its artifact generated, and why. */
export interface ArtifactGenerationFinding {
  readonly problemId: ProblemId;
  readonly reason: ArtifactGenerationReason;
}

/**
 * How many Problems one sweep considers at most.
 *
 * A working bound, not a recorded invariant: it exists so a sweep is always
 * short, and the number should move freely if measurement says otherwise.
 * Callers run further sweeps to drain a larger backlog.
 */
export const ARTIFACT_RECONCILIATION_SCAN_LIMIT = 200;

interface FindingRow {
  problem_id: string;
  reason: ArtifactGenerationReason;
}

/**
 * `is distinct from` throughout, though every compared column is `not null`
 * today: a comparison that silently became `null` would otherwise make a row
 * invisible to reconciliation, which is the one failure mode a recovery
 * mechanism must not have.
 *
 * The `case` decides the *reason* and mirrors the `where`; the `where` decides
 * *membership*. They repeat the same predicates because a `case` cannot be
 * referenced from a `where` — kept adjacent so a drift is visible in one
 * screen.
 */
export const ARTIFACT_RECONCILIATION_STATEMENT = `
  select pr.problem_id as problem_id,
         case
           when ra.problem_id is null then 'ARTIFACT_MISSING'
           when not starts_with(ra.source_fingerprint, $2) then 'SOURCE_SCHEMA_INCOMPATIBLE'
           else 'GENERATION_PROFILE_OUTDATED'
         end as reason
    from public.problems pr
    left join public.retrieval_artifacts ra
      on ra.owner_id = pr.owner_id
     and ra.problem_id = pr.problem_id
   where pr.owner_id = $1
     and pr.memory_read_enabled
     and (
          ra.problem_id is null
       or not starts_with(ra.source_fingerprint, $2)
       or ra.summary_generator_id is distinct from $3
       or ra.summary_generator_version is distinct from $4
       or ra.embedding_model is distinct from $5
       or ra.embedding_model_version is distinct from $6
       or vector_dims(ra.embedding) is distinct from $7
       or ra.structural_features->>'schema_version' is distinct from $8
     )
   order by pr.created_at asc, pr.problem_id asc
   limit $9`;

/**
 * The deterministic stack's membership, deliberately narrower.
 *
 * With no embedding side configured, staleness means: no artifact, an
 * incompatible source schema, an outdated structural schema, or a
 * deterministic artifact written by a superseded deterministic version.
 * An artifact another generator wrote — a provider's summary carrying a
 * semantic rendering — is *not* in the answer: it still describes the
 * current canonical source, and regenerating it here would replace an
 * enriched rendering with a poorer one for no correctness gain. The day a
 * provider is configured again, the semantic statement above finds every
 * deterministic row through its embedding expectations and upgrades it.
 */
export const ARTIFACT_RECONCILIATION_DETERMINISTIC_STATEMENT = `
  select pr.problem_id as problem_id,
         case
           when ra.problem_id is null then 'ARTIFACT_MISSING'
           when not starts_with(ra.source_fingerprint, $2) then 'SOURCE_SCHEMA_INCOMPATIBLE'
           else 'GENERATION_PROFILE_OUTDATED'
         end as reason
    from public.problems pr
    left join public.retrieval_artifacts ra
      on ra.owner_id = pr.owner_id
     and ra.problem_id = pr.problem_id
   where pr.owner_id = $1
     and pr.memory_read_enabled
     and (
          ra.problem_id is null
       or not starts_with(ra.source_fingerprint, $2)
       or ra.structural_features->>'schema_version' is distinct from $5
       or (
            ra.summary_generator_id = $3
        and ra.summary_generator_version is distinct from $4
          )
     )
   order by pr.created_at asc, pr.problem_id asc
   limit $6`;

/**
 * The Problems whose artifact the configured stack should generate, oldest
 * first, bounded.
 *
 * A Problem already carrying a current artifact from the configured stack is
 * not in the answer — which is the cost guard: a sweep over an up-to-date
 * database reads and does nothing, however often it runs.
 */
export async function findProblemsNeedingArtifactGeneration(
  executor: DatabaseExecutor,
  context: OwnerContext,
  profile: RetrievalGenerationProfile,
  limit: number = ARTIFACT_RECONCILIATION_SCAN_LIMIT,
): Promise<ArtifactGenerationFinding[]> {
  const expected = requireRetrievalGenerationProfile(profile);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error('A reconciliation scan limit must be a positive whole number.');
  }

  const result =
    expected.semantic === null
      ? await executor.query<FindingRow>(ARTIFACT_RECONCILIATION_DETERMINISTIC_STATEMENT, [
          context.ownerId,
          RETRIEVAL_SOURCE_FINGERPRINT_CURRENT_PREFIX,
          expected.summaryGeneratorId,
          expected.summaryGeneratorVersion,
          STRUCTURAL_FEATURE_SCHEMA_VERSION,
          limit,
        ])
      : await executor.query<FindingRow>(ARTIFACT_RECONCILIATION_STATEMENT, [
          context.ownerId,
          RETRIEVAL_SOURCE_FINGERPRINT_CURRENT_PREFIX,
          expected.summaryGeneratorId,
          expected.summaryGeneratorVersion,
          expected.semantic.embeddingModel,
          expected.semantic.embeddingModelVersion,
          expected.semantic.embeddingDimensions,
          STRUCTURAL_FEATURE_SCHEMA_VERSION,
          limit,
        ]);

  return result.rows.map((row) => ({
    problemId: row.problem_id as ProblemId,
    reason: row.reason,
  }));
}
