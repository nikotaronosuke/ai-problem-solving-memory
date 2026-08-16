/**
 * Application-facing storage boundary.
 *
 * Service and API code from Phase 2 imports from here, not from `src/db/`.
 * The dependency direction is domain ← service ← repository ← db ← PostgreSQL,
 * and nothing in `src/domain/` depends on either storage layer.
 *
 * The record and input types are re-exported rather than redefined. Copying
 * them into repository-specific shapes would leave two definitions of the same
 * thing to keep in step, and they would not stay in step.
 *
 * `pg.Pool`, `pg.PoolClient`, raw SQL and Supabase-specific types are not part
 * of this surface. A caller needs `DatabaseExecutor` and nothing more.
 */

export { createMemoryRepository, type MemoryRepository } from './memory-repository.js';

export type { DatabaseExecutor } from '../db/executor.js';

export type { CreateProjectInput, ProjectRecord, UpdateProjectInput } from '../db/projects.js';
export { EmptyProjectUpdateError } from '../db/projects.js';
export type { CreateEnvironmentInput, EnvironmentRecord } from '../db/environments.js';
export type { CreateProblemInput, ProblemRecord, UpdateProblemInput } from '../db/problems.js';
export { EmptyProblemUpdateError } from '../db/problems.js';
export type { AppendEventInput, EventRecord } from '../db/events.js';
export type { AppendVerificationInput, VerificationRecord } from '../db/verifications.js';
export type { CreateRelationInput, RelationRecord } from '../db/relations.js';
export type { CreateUsageLogInput, UsageLogRecord } from '../db/usage-logs.js';
export type { ChangeLogRecord, CreateChangeLogInput } from '../db/change-logs.js';
export type { DeleteProblemOutcome } from '../db/problem-deletion.js';
export { MEMORY_EXPORT_COLLECTIONS } from '../db/memory-export.js';
export {
  MEMORY_EXPORT_SCHEMA_VERSION,
  type MemoryExportArtifact,
} from '../domain/memory-export.js';

// The failures a caller has to handle. Mapping stays in the database layer;
// these are re-exported so the caller need not reach past this boundary.
export { ProblemNotAvailableError } from '../db/errors.js';
export { ProjectNotAvailableError } from '../db/environments.js';
export { EnvironmentNotAvailableError } from '../db/problems.js';
export {
  createRetrievalArtifactRepository,
  type RetrievalArtifactRepository,
} from './retrieval-artifact-repository.js';
export type {
  Embedding,
  RetrievalArtifactContent,
  RetrievalArtifactRecord,
  UpsertRetrievalArtifactInput,
} from '../domain/retrieval-artifact.js';

// A reader, not a repository: one operation, and it reads. What a summary is
// generated from is a different question from what a Problem is, so it is
// asked through its own boundary rather than added to the Memory repository.
export {
  createRetrievalSummarySourceReader,
  type RetrievalSummarySourceReader,
} from './retrieval-summary-source-reader.js';
export type { RetrievalSummarySource } from '../db/retrieval-summary-source.js';

// The row lock the artifact generation gate takes. A storage operation like
// everything else on this surface: the application layer names what it needs
// held still, and how that is expressed to PostgreSQL stays down here.
export { lockProblemForArtifactWrite } from '../db/problem-lock.js';

// Lexical candidate search. Its own reader rather than a method on the artifact
// repository: finding Problems worth looking at is a different question from
// storing one Problem's artifact, and the search side is where a vector query
// and a reranking stage will arrive.
export {
  createRetrievalSearchReader,
  type RetrievalSearchReader,
} from './retrieval-search-reader.js';

// The structural side of candidate artifacts, for reranking. Reads three
// columns of up to twenty artifacts in one statement: the summary, keywords
// and embedding are not needed to compare structure.
export {
  createRetrievalStructuralReader,
  type RetrievalStructuralReader,
} from './retrieval-structural-reader.js';
export type { StructuralArtifactRow } from '../db/retrieval-structural-read.js';

// The controls a ranking reads: trust, currency, suppression and the current
// Project's technology label, from one snapshot. Its own reader rather than a
// wider structural one — the columns, the joins and the question are all
// different, and every one of these fields can change between two reads.
export {
  createRetrievalRankingReader,
  type RetrievalRankingReader,
} from './retrieval-ranking-reader.js';
export type { RankingMetadataRow, RankingMetadataSnapshot } from '../db/retrieval-ranking-read.js';

// What a Memory was recorded under: the Environment it occurred in and every
// check performed on it. Its own reader — the joins, the columns and the
// question are different from ranking's, and one statement keeps the answer a
// description of a state the database really held.
export {
  createRetrievalRevalidationReader,
  type RetrievalRevalidationReader,
} from './retrieval-revalidation-reader.js';
export type {
  RevalidationEvidenceRow,
  RevalidationRow,
} from '../db/retrieval-revalidation-read.js';

// The directions a Memory already knows do not lead. Its own reader: only
// `DEAD_END` Events, and the distinction between "none recorded" and "no
// longer visible" is what the query is shaped around.
export {
  createRetrievalDeadEndReader,
  type RetrievalDeadEndReader,
} from './retrieval-dead-end-reader.js';

// The directions a Memory's record currently supports. Its own reader: the
// question joins an artifact to a status and a check in one statement, and
// reads no Event at all.
export {
  createRetrievalSuccessfulDirectionReader,
  type RetrievalSuccessfulDirectionReader,
} from './retrieval-successful-direction-reader.js';

// What another Memory says against this one, and enough of that Memory to
// compare the two. Its own reader: only `CONTRADICTS` Relations, both ends
// re-checked for owner and read control, and one statement — the material is
// meant to be compared, and two halves read at two moments would let a reader
// see a difference that never existed at any single instant.
export {
  createRetrievalConflictReader,
  type RetrievalConflictReader,
} from './retrieval-conflict-reader.js';
export type { ConflictRow } from '../db/retrieval-conflict-read.js';

// Semantic candidate search. Handed a validated embedding by the service
// above it — the embedding parameter is a storage-boundary input, not an
// application surface; what an application caller can supply is text.
export {
  createRetrievalVectorSearchReader,
  type RetrievalVectorSearchReader,
} from './retrieval-vector-search-reader.js';
export type { VectorSearchParameters } from '../db/retrieval-vector-search.js';
export {
  DEFAULT_SEARCH_LIMIT,
  InvalidFullTextSearchError,
  MAX_SEARCH_LIMIT,
  MAX_SEARCH_TEXT_LENGTH,
  MAX_VECTOR_SEARCH_TEXT_LENGTH,
  RETRIEVAL_TEXT_SEARCH_CONFIG,
  resolveVectorSearchQuery,
  type FullTextCandidate,
  type FullTextSearchQuery,
  type ResolvedVectorSearchQuery,
  type VectorCandidate,
  type VectorSearchQuery,
} from '../domain/retrieval-search.js';
