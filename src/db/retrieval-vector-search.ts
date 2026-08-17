/**
 * Finding retrieval artifacts by meaning: nearest stored vectors first.
 *
 * One statement, and the shape of its `where` clause is most of the design.
 *
 * **Only compatible vectors are compared, and compatibility is three tests.**
 * The store deliberately holds vectors from any model at any dimension side by
 * side — that is what lets a model change roll through without a migration —
 * which means most rows may be *meaningless* to compare against a given query:
 * a distance across different models is a number that signifies nothing, and a
 * distance across different dimensions is not even a number, it is an error
 * (measured). So the statement admits a row only when the model, the model
 * version and the measured dimensions all equal the query's. A row failing any
 * test is excluded by the filter, which matters twice over: it can neither
 * break the query nor occupy a place in the limit.
 *
 * The summary generator's identity is deliberately NOT in the filter. It has
 * nothing to do with vector-space compatibility — the space is the embedding
 * model's — and an artifact whose text came from an older summariser still has
 * a mathematically valid distance. Whether it should be *recommended* is a
 * ranking question, and ranking is not this statement's job.
 *
 * **The owner and the read control, in the statement** — the same two hard
 * filters the lexical search applies, for the same reasons: another owner's
 * artifact must never be scored, ordered or counted toward the limit, and a
 * Problem whose owner turned automatic reading off must not be fetched in
 * order to be discarded above. Everything else — suppression, staleness,
 * confidence — is a judgement about a Memory, returned and left to the layer
 * that ranks.
 *
 * **`<=>` is cosine distance, and it is a system decision.** Measured on
 * fixtures: cosine is the one metric of the three that separates direction
 * from magnitude — the same direction at a hundred times the length is
 * distance zero, where L2 calls it 99 and inner product rewards sheer size.
 * For "do these two texts mean the same thing", direction is the signal and
 * magnitude is noise. The metric is not a provider property, not a column and
 * not configuration: the same rows must answer the same query the same way on
 * every deployment, and a future model that genuinely wants another metric is
 * a deliberate revisit, not a config flip.
 *
 * **No distance threshold.** The N nearest come back however far they are —
 * an opposite-direction artifact can appear when nothing closer exists. A
 * candidate primitive that quietly dropped "too far" rows would be deciding
 * usefulness, which belongs to the stages that merge, rerank and rank; a
 * useless candidate list should look like one, not like an empty one.
 *
 * The order is total: distance, then problem id, so equal distances return
 * identically every time and a smaller limit is a prefix of a larger one's
 * answer. `generated_at` is not a tie-break — it is not evidence of anything.
 */

import type { OwnerContext } from '../domain/owner.js';
import type { ProblemId } from '../domain/problem.js';
import type { ProjectId } from '../domain/project.js';
import { formatEmbedding, type Embedding } from '../domain/retrieval-artifact.js';
import type { ResolvedVectorSearchQuery, VectorCandidate } from '../domain/retrieval-search.js';
import { RETRIEVAL_SOURCE_FINGERPRINT_CURRENT_PREFIX } from '../domain/retrieval-summary.js';
import type { DatabaseExecutor } from './executor.js';

/** What the reader passes down: a validated vector and the space it lives in. */
export interface VectorSearchParameters {
  readonly embedding: Embedding;
  readonly embeddingModel: string;
  readonly embeddingModelVersion: string;
  readonly dimensions: number;
}

interface VectorCandidateRow {
  problem_id: string;
  project_id: string;
  cosine_distance: number;
}

/**
 * The query vector crosses as text and is cast in the statement — `pg` has no
 * vector type — exactly as the artifact upsert sends stored vectors. The cast
 * is untyped `::vector` because a typmod cannot be a parameter (measured,
 * 42601) and an exact scan needs none: dimension agreement is enforced by the
 * `vector_dims` predicate, not by the cast.
 */
export const VECTOR_SEARCH_STATEMENT = `
  select ra.problem_id as problem_id,
         pr.project_id as project_id,
         ra.embedding <=> $2::vector as cosine_distance
    from public.retrieval_artifacts ra
    join public.problems pr
      on pr.owner_id = ra.owner_id
     and pr.problem_id = ra.problem_id
   where ra.owner_id = $1
     and pr.memory_read_enabled
     and starts_with(ra.source_fingerprint, $9)
     and ra.embedding_model = $3
     and ra.embedding_model_version = $4
     and vector_dims(ra.embedding) = $5
     and ($6::uuid is null or pr.project_id = $6::uuid)
     and ($7::uuid is null or ra.problem_id <> $7::uuid)
   order by cosine_distance asc, ra.problem_id asc
   limit $8`;

/**
 * The nearest compatible artifacts, closest first.
 *
 * An empty list is ordinary: no artifacts yet, none for this model, or none
 * this owner can see. A read and nothing else — no lock, no transaction, no
 * write, and never a regeneration of what it failed to find.
 */
export async function searchArtifactsByVector(
  executor: DatabaseExecutor,
  context: OwnerContext,
  parameters: VectorSearchParameters,
  query: ResolvedVectorSearchQuery,
): Promise<VectorCandidate[]> {
  const result = await executor.query<VectorCandidateRow>(VECTOR_SEARCH_STATEMENT, [
    context.ownerId,
    formatEmbedding(parameters.embedding),
    parameters.embeddingModel,
    parameters.embeddingModelVersion,
    parameters.dimensions,
    query.projectId,
    query.excludeProblemId,
    query.limit,
    // Source-schema gate, the same one every artifact-backed read applies.
    RETRIEVAL_SOURCE_FINGERPRINT_CURRENT_PREFIX,
  ]);

  return result.rows.map((row) => {
    if (typeof row.cosine_distance !== 'number' || !Number.isFinite(row.cosine_distance)) {
      // Cannot happen while the invariants hold — stored vectors and the query
      // are finite and non-zero, so cosine distance is defined — which is
      // exactly why it is checked: a row that breaks it means the store no
      // longer holds what the domain believes, and a quiet NaN would corrupt
      // every ordering built on top. Nothing of the row or the vector is
      // quoted.
      throw new Error('A vector search produced a distance that is not a finite number.');
    }
    return {
      problemId: row.problem_id as ProblemId,
      projectId: row.project_id as ProjectId,
      cosineDistance: row.cosine_distance,
    };
  });
}
