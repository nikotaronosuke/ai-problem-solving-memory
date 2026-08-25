/**
 * Database access for retrieval artifacts.
 *
 * Upsert and read, and nothing else. There is no list and no search: what a
 * search needs to ask is P4-03's and P4-05's to decide, and inventing a query
 * shape now would decide it early and badly. Removal is not here either — an
 * artifact goes when its Problem goes, in the delete path, where a reader can
 * see it happen alongside everything else that Problem owned.
 *
 * As elsewhere, every function takes an `OwnerContext` and the owner comes from
 * it rather than from caller input. The composite foreign key does the same
 * work here that it does for relations and usage logs: an artifact naming one
 * owner and another owner's Problem is not merely unwritten by the code, it is
 * unstorable.
 *
 * One row per Problem, replaced on regeneration. `on conflict` makes that
 * atomic, so a reader never sees the gap between an old artifact and a new one
 * — there is no moment when a Problem that had an artifact has none.
 *
 * Nothing in this module writes to `problems`, `events`, `verifications` or any
 * other Memory table. Generating an artifact must not be a way to change the
 * record it was generated from.
 */

import type { OwnerContext, OwnerId } from '../domain/owner.js';
import type { ProblemId } from '../domain/problem.js';
import {
  formatEmbedding,
  parseEmbedding,
  toRetrievalArtifactContent,
  type RetrievalArtifactRecord,
  type UpsertRetrievalArtifactInput,
} from '../domain/retrieval-artifact.js';
import { FOREIGN_KEY_VIOLATION, ProblemNotAvailableError, violatesConstraint } from './errors.js';
import type { DatabaseExecutor } from './executor.js';

const OWNER_PROBLEM_FK = 'retrieval_artifacts_owner_id_problem_id_fkey';

interface ArtifactRow {
  owner_id: string;
  problem_id: string;
  normalized_summary: string;
  keywords: string[];
  structural_features: Record<string, unknown>;
  summary_generator_id: string;
  summary_generator_version: string;
  /** `vector` has no driver type, so it arrives as its text form. */
  embedding: string | null;
  embedding_model: string | null;
  embedding_model_version: string | null;
  source_fingerprint: string;
  generated_at: Date;
}

function toRecord(row: ArtifactRow): RetrievalArtifactRecord {
  return {
    ownerId: row.owner_id as OwnerId,
    problemId: row.problem_id as ProblemId,
    normalizedSummary: row.normalized_summary,
    keywords: row.keywords,
    structuralFeatures: row.structural_features,
    summaryGeneratorId: row.summary_generator_id,
    summaryGeneratorVersion: row.summary_generator_version,
    // The schema's all-or-none constraint is what lets one null answer for
    // the three columns here: a row cannot hold half a rendering.
    semantic:
      row.embedding === null || row.embedding_model === null || row.embedding_model_version === null
        ? null
        : {
            embedding: parseEmbedding(row.embedding),
            embeddingModel: row.embedding_model,
            embeddingModelVersion: row.embedding_model_version,
          },
    sourceFingerprint: row.source_fingerprint,
    generatedAt: row.generated_at,
  };
}

/**
 * `embedding` is selected as text because `pg` has no reader for `vector`.
 * Everything else comes back in its own type.
 */
const ARTIFACT_COLUMNS = `owner_id, problem_id, normalized_summary, keywords,
  structural_features, summary_generator_id, summary_generator_version,
  embedding::text as embedding, embedding_model,
  embedding_model_version, source_fingerprint, generated_at`;

/**
 * Writes the Problem's current artifact, replacing whatever was there.
 *
 * Deliberately unconditional. It would be easy to keep the row with the later
 * `generated_at` and call that "the newer one", and it would be wrong: a
 * generation that read the source first and finished last carries a later
 * timestamp for an earlier state. Deciding whether a generated artifact still
 * describes the current Memory needs the source, which this layer does not
 * read — so that decision belongs to whatever does, and this stays a storage
 * primitive that does what it is told.
 */
export async function upsertRetrievalArtifact(
  executor: DatabaseExecutor,
  context: OwnerContext,
  input: UpsertRetrievalArtifactInput,
): Promise<RetrievalArtifactRecord> {
  const content = toRetrievalArtifactContent(input);

  let written;
  try {
    written = await executor.query<ArtifactRow>(
      `insert into public.retrieval_artifacts
              (owner_id, problem_id, normalized_summary, keywords, structural_features,
               summary_generator_id, summary_generator_version,
               embedding, embedding_model, embedding_model_version, source_fingerprint,
               generated_at)
            values ($1, $2, $3, $4, $5, $6, $7, $8::vector, $9, $10, $11, $12)
       on conflict (owner_id, problem_id) do update
               set normalized_summary = excluded.normalized_summary,
                   keywords = excluded.keywords,
                   structural_features = excluded.structural_features,
                   summary_generator_id = excluded.summary_generator_id,
                   summary_generator_version = excluded.summary_generator_version,
                   embedding = excluded.embedding,
                   embedding_model = excluded.embedding_model,
                   embedding_model_version = excluded.embedding_model_version,
                   source_fingerprint = excluded.source_fingerprint,
                   generated_at = excluded.generated_at
         returning ${ARTIFACT_COLUMNS}`,
      [
        context.ownerId,
        input.problemId,
        content.normalizedSummary,
        content.keywords,
        JSON.stringify(content.structuralFeatures),
        content.summaryGeneratorId,
        content.summaryGeneratorVersion,
        // Bound as a parameter and cast in the statement. The numbers never
        // become part of the SQL text. A deterministic artifact binds null
        // for all three, which the schema's constraint accepts as one state.
        content.semantic === null ? null : formatEmbedding(content.semantic.embedding),
        content.semantic === null ? null : content.semantic.embeddingModel,
        content.semantic === null ? null : content.semantic.embeddingModelVersion,
        content.sourceFingerprint,
        content.generatedAt,
      ],
    );
  } catch (error) {
    if (violatesConstraint(error, FOREIGN_KEY_VIOLATION, OWNER_PROBLEM_FK)) {
      // The (owner, problem) pair does not exist. Whether the Problem is
      // unknown or someone else's is not distinguished, as everywhere else.
      throw new ProblemNotAvailableError();
    }
    throw error;
  }

  const row = written.rows[0];
  if (row === undefined) {
    throw new Error('Retrieval artifact upsert returned no row.');
  }

  return toRecord(row);
}

/**
 * Reads a Problem's current artifact, if it has one.
 *
 * `undefined` for a Problem that has never been generated for, for one whose
 * artifact predates a regeneration that has not happened yet, and for another
 * owner's Problem. A Problem without an artifact is an ordinary state — every
 * Problem starts in it, and nothing generates artifacts yet.
 */
export async function findRetrievalArtifact(
  executor: DatabaseExecutor,
  context: OwnerContext,
  problemId: ProblemId,
): Promise<RetrievalArtifactRecord | undefined> {
  const result = await executor.query<ArtifactRow>(
    `select ${ARTIFACT_COLUMNS}
       from public.retrieval_artifacts
      where owner_id = $1 and problem_id = $2`,
    [context.ownerId, problemId],
  );

  const row = result.rows[0];
  return row === undefined ? undefined : toRecord(row);
}
