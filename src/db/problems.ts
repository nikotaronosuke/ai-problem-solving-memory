/**
 * Database access for problems.
 *
 * As with projects and environments, every function takes an `OwnerContext`.
 * The owner comes from the context rather than caller input, and reads are
 * scoped by `owner_id` alongside `problem_id`.
 *
 * Creation supplies only what the caller genuinely knows. Status, confidence,
 * freshness, the flags and `version` come from database defaults, so a new
 * Problem cannot be created already claiming to be verified or trusted.
 *
 * There is no update path here. Status transitions, the VERIFIED rule and
 * optimistic locking are Phase 2.
 *
 * This is the minimum P1-08 needs. The general repository layer is P1-12.
 */

import type { EnvironmentId } from '../domain/environment.js';
import type { Confidence, FixKind, Freshness, ProblemStatus } from '../domain/enums.js';
import type { OwnerContext, OwnerId } from '../domain/owner.js';
import {
  generateProblemId,
  toProblemSymptoms,
  toProblemTitle,
  type ProblemId,
} from '../domain/problem.js';
import type { ProjectId } from '../domain/project.js';
import { normaliseOptionalText } from '../domain/text.js';
import type { DatabaseExecutor } from './executor.js';

const OWNER_PROJECT_ENVIRONMENT_FK = 'problems_owner_project_environment_fkey';

export interface ProblemRecord {
  readonly problemId: ProblemId;
  readonly ownerId: OwnerId;
  readonly projectId: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly title: string;
  readonly symptoms: string;
  readonly problemDomain: string | null;
  readonly suspectedBoundary: string | null;
  readonly sourceAi: string | null;
  readonly status: ProblemStatus;
  readonly fixKind: FixKind | null;
  readonly importance: boolean;
  readonly confidence: Confidence;
  readonly freshness: Freshness;
  readonly memoryReadEnabled: boolean;
  readonly memoryWriteEnabled: boolean;
  readonly suppressed: boolean;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * What a caller supplies to record a problem.
 *
 * There is no owner field, and no status, confidence, freshness, flag or
 * version field. Those are not things a caller asserts at creation time.
 */
export interface CreateProblemInput {
  readonly projectId: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly title: string;
  readonly symptoms: string;
  readonly problemDomain?: string | null;
  readonly suspectedBoundary?: string | null;
  readonly sourceAi?: string | null;
}

/**
 * Raised when the target environment is not one of the context owner's, or
 * does not belong to the named project.
 *
 * Deliberately the same error whether the environment is unknown, belongs to
 * someone else, or sits under a different project.
 */
export class EnvironmentNotAvailableError extends Error {
  constructor() {
    super('No such environment for this owner and project.');
    this.name = 'EnvironmentNotAvailableError';
  }
}

interface ProblemRow {
  problem_id: string;
  owner_id: string;
  project_id: string;
  environment_id: string;
  title: string;
  symptoms: string;
  problem_domain: string | null;
  suspected_boundary: string | null;
  source_ai: string | null;
  status: ProblemStatus;
  fix_kind: FixKind | null;
  importance: boolean;
  confidence: Confidence;
  freshness: Freshness;
  memory_read_enabled: boolean;
  memory_write_enabled: boolean;
  suppressed: boolean;
  version: number;
  created_at: Date;
  updated_at: Date;
}

function toRecord(row: ProblemRow): ProblemRecord {
  // The id columns are `uuid`, so the values are already normalised UUIDs.
  return {
    problemId: row.problem_id as ProblemId,
    ownerId: row.owner_id as OwnerId,
    projectId: row.project_id as ProjectId,
    environmentId: row.environment_id as EnvironmentId,
    title: row.title,
    symptoms: row.symptoms,
    problemDomain: row.problem_domain,
    suspectedBoundary: row.suspected_boundary,
    sourceAi: row.source_ai,
    status: row.status,
    fixKind: row.fix_kind,
    importance: row.importance,
    confidence: row.confidence,
    freshness: row.freshness,
    memoryReadEnabled: row.memory_read_enabled,
    memoryWriteEnabled: row.memory_write_enabled,
    suppressed: row.suppressed,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Whether an error is PostgreSQL rejecting a specific foreign key. */
function isForeignKeyViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === '23503' && candidate.constraint === constraint;
}

const PROBLEM_COLUMNS = `problem_id, owner_id, project_id, environment_id, title, symptoms,
  problem_domain, suspected_boundary, source_ai, status, fix_kind, importance, confidence,
  freshness, memory_read_enabled, memory_write_enabled, suppressed, version,
  created_at, updated_at`;

/**
 * Records a problem against one of the context owner's environments.
 *
 * The remaining columns take their database defaults: status
 * `INVESTIGATING`, confidence `LOW`, freshness `CURRENT`, reads and writes
 * enabled, not suppressed, not important, version 1.
 */
export async function createProblem(
  executor: DatabaseExecutor,
  context: OwnerContext,
  input: CreateProblemInput,
): Promise<ProblemRecord> {
  const title = toProblemTitle(input.title);
  const symptoms = toProblemSymptoms(input.symptoms);
  const problemDomain = normaliseOptionalText(input.problemDomain);
  const suspectedBoundary = normaliseOptionalText(input.suspectedBoundary);
  const sourceAi = normaliseOptionalText(input.sourceAi);
  const problemId = generateProblemId();

  let result;
  try {
    result = await executor.query<ProblemRow>(
      `insert into public.problems
              (problem_id, owner_id, project_id, environment_id, title, symptoms,
               problem_domain, suspected_boundary, source_ai)
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         returning ${PROBLEM_COLUMNS}`,
      [
        problemId,
        context.ownerId,
        input.projectId,
        input.environmentId,
        title,
        symptoms,
        problemDomain,
        suspectedBoundary,
        sourceAi,
      ],
    );
  } catch (error) {
    if (isForeignKeyViolation(error, OWNER_PROJECT_ENVIRONMENT_FK)) {
      // The (owner, project, environment) triple does not exist. Whether the
      // environment is unknown, someone else's, or under another project is
      // not distinguished, by design.
      throw new EnvironmentNotAvailableError();
    }
    throw error;
  }

  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('Problem insert returned no row.');
  }

  return toRecord(row);
}

/**
 * Reads one of the context owner's problems.
 *
 * Returns undefined when it does not exist or belongs to someone else — the
 * two are indistinguishable to the caller by design.
 */
export async function getProblem(
  executor: DatabaseExecutor,
  context: OwnerContext,
  problemId: ProblemId,
): Promise<ProblemRecord | undefined> {
  const result = await executor.query<ProblemRow>(
    `select ${PROBLEM_COLUMNS}
       from public.problems
      where owner_id = $1 and problem_id = $2`,
    [context.ownerId, problemId],
  );

  const row = result.rows[0];
  return row === undefined ? undefined : toRecord(row);
}
