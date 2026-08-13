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

/**
 * Lists a project's problems, oldest first.
 *
 * `problem_id` breaks ties so repeated reads agree when rows share a
 * timestamp. The `(owner_id, project_id, created_at, problem_id)` index from
 * P1-11 covers this filter and sort together.
 *
 * An empty list means this owner has no problems under that project id. It
 * does not distinguish a project with none from one that is not the owner's;
 * the application layer checks the project first so the two stay separate.
 */
export async function listProblems(
  executor: DatabaseExecutor,
  context: OwnerContext,
  projectId: ProjectId,
): Promise<ProblemRecord[]> {
  const result = await executor.query<ProblemRow>(
    `select ${PROBLEM_COLUMNS}
       from public.problems
      where owner_id = $1 and project_id = $2
      order by created_at asc, problem_id asc`,
    [context.ownerId, projectId],
  );

  return result.rows.map(toRecord);
}

/**
 * What a caller may change about a problem.
 *
 * Absent leaves a column alone; an explicit null clears a nullable one. The
 * two must stay distinguishable, which is why this is not a partial record.
 *
 * Deliberately absent: `status`, `fix_kind` and `version`. Status transitions
 * are P2-06 and must not be reachable through a generic update — `VERIFIED`
 * requires a successful Verification, and a field assignment would sidestep
 * that. `version` is P2-07's, and `fix_kind` belongs with close/review in
 * P2-12. Identity, ownership and timestamps are never a caller's to set.
 */
export interface UpdateProblemInput {
  readonly title?: string;
  readonly symptoms?: string;
  readonly problemDomain?: string | null;
  readonly suspectedBoundary?: string | null;
  readonly sourceAi?: string | null;
  readonly importance?: boolean;
  readonly confidence?: Confidence;
  readonly freshness?: Freshness;
  readonly memoryReadEnabled?: boolean;
  readonly memoryWriteEnabled?: boolean;
  readonly suppressed?: boolean;
}

/** Raised when an update would change nothing. */
export class EmptyProblemUpdateError extends Error {
  constructor() {
    super('A problem update must change at least one field.');
    this.name = 'EmptyProblemUpdateError';
  }
}

/**
 * Updates one of the context owner's problems.
 *
 * Only the fields present are written. Each is independent: setting one never
 * adjusts another. Marking a problem important does not raise its confidence,
 * and suppressing it does not disable reads — importance, confidence,
 * freshness and the three flags are separate axes, and quietly coupling them
 * would record a judgement nobody made.
 *
 * `updated_at` is set explicitly. `version` is deliberately left alone: P2-07
 * makes it an optimistic lock, and incrementing it now would imply a
 * concurrency guarantee that does not yet exist.
 *
 * Returns undefined when the problem is unknown or another owner's, matching
 * `getProblem`. Never inserts, so a mistyped id cannot create a record.
 */
export async function updateProblem(
  executor: DatabaseExecutor,
  context: OwnerContext,
  problemId: ProblemId,
  input: UpdateProblemInput,
): Promise<ProblemRecord | undefined> {
  const assignments: string[] = [];
  // Column names are written here and nowhere else. Only values are
  // parameterised; no caller input ever becomes a SQL identifier.
  const values: unknown[] = [context.ownerId, problemId];

  function assign(column: string, value: unknown): void {
    values.push(value);
    assignments.push(`${column} = $${values.length}`);
  }

  if (input.title !== undefined) {
    assign('title', toProblemTitle(input.title));
  }
  if (input.symptoms !== undefined) {
    assign('symptoms', toProblemSymptoms(input.symptoms));
  }
  if (input.problemDomain !== undefined) {
    assign('problem_domain', normaliseOptionalText(input.problemDomain));
  }
  if (input.suspectedBoundary !== undefined) {
    assign('suspected_boundary', normaliseOptionalText(input.suspectedBoundary));
  }
  if (input.sourceAi !== undefined) {
    assign('source_ai', normaliseOptionalText(input.sourceAi));
  }
  if (input.importance !== undefined) {
    assign('importance', input.importance);
  }
  if (input.confidence !== undefined) {
    assign('confidence', input.confidence);
  }
  if (input.freshness !== undefined) {
    assign('freshness', input.freshness);
  }
  if (input.memoryReadEnabled !== undefined) {
    assign('memory_read_enabled', input.memoryReadEnabled);
  }
  if (input.memoryWriteEnabled !== undefined) {
    assign('memory_write_enabled', input.memoryWriteEnabled);
  }
  if (input.suppressed !== undefined) {
    assign('suppressed', input.suppressed);
  }

  if (assignments.length === 0) {
    throw new EmptyProblemUpdateError();
  }

  const result = await executor.query<ProblemRow>(
    `update public.problems
        set ${assignments.join(', ')}, updated_at = now()
      where owner_id = $1 and problem_id = $2
     returning ${PROBLEM_COLUMNS}`,
    values,
  );

  const row = result.rows[0];
  return row === undefined ? undefined : toRecord(row);
}

/**
 * Moves one of the context owner's problems to a status.
 *
 * Separate from `updateProblem` on purpose, and `UpdateProblemInput` has no
 * `status` field, so there is exactly one way status can change. A generic
 * field assignment would step straight past the transition rules — including
 * that `VERIFIED` needs a successful Verification — and this is the seam that
 * makes stepping past them impossible rather than merely discouraged.
 *
 * Whether the move is allowed is decided above this, by the domain rule. This
 * writes what it was told to write.
 *
 * Only `status` and `updated_at` change. `version` is untouched, following
 * `updateProblem`: P2-07 owns what an increment means, and moving it here
 * would imply a concurrency guarantee that does not exist yet. `fix_kind`,
 * `confidence`, `freshness`, `importance`, the memory flags and the
 * identifiers are all left alone — a Problem being verified says nothing
 * about how confident anyone is in it, or whether the fix addressed the cause.
 *
 * There is no compare-and-swap here. Two callers transitioning the same
 * Problem at once can both read the same current status and both write; the
 * last one wins. Detecting that is optimistic locking, which is P2-07's.
 *
 * Returns undefined when the problem is unknown or another owner's, matching
 * `getProblem`. Never inserts.
 */
export async function updateProblemStatus(
  executor: DatabaseExecutor,
  context: OwnerContext,
  problemId: ProblemId,
  status: ProblemStatus,
): Promise<ProblemRecord | undefined> {
  const result = await executor.query<ProblemRow>(
    `update public.problems
        set status = $3, updated_at = now()
      where owner_id = $1 and problem_id = $2
     returning ${PROBLEM_COLUMNS}`,
    [context.ownerId, problemId, status],
  );

  const row = result.rows[0];
  return row === undefined ? undefined : toRecord(row);
}
