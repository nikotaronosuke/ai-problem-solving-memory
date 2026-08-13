/**
 * Database access for usage logs.
 *
 * Create and list only. Rows are added, never edited, so there is no
 * `updated_at` and no version — and how long usage history is kept is a
 * question this phase does not answer.
 *
 * As elsewhere, every function takes an `OwnerContext`, the owner comes from
 * the context rather than caller input, and reads are scoped by `owner_id`.
 * `source_ai` is a description of who used the memory and never affects that:
 * a caller writing another AI's name there reaches nothing new.
 *
 * Nothing here is idempotent on a client-supplied key. Whether a resent usage
 * log needs one is a question for whenever adapter retry behaviour is
 * designed; copying `client_event_id` across from the append paths would
 * answer it by reflex.
 */

import type { UsageAction } from '../domain/enums.js';
import type { OwnerContext, OwnerId } from '../domain/owner.js';
import type { ProblemId } from '../domain/problem.js';
import {
  generateUsageLogId,
  toUsageReason,
  toUsageResult,
  toUsageSourceAi,
  type UsageLogId,
} from '../domain/usage-log.js';
import { FOREIGN_KEY_VIOLATION, ProblemNotAvailableError, violatesConstraint } from './errors.js';
import type { DatabaseExecutor } from './executor.js';

const OWNER_PROBLEM_FK = 'usage_logs_owner_id_problem_id_fkey';
const OWNER_MEMORY_FK = 'usage_logs_owner_id_memory_id_fkey';

export interface UsageLogRecord {
  readonly usageLogId: UsageLogId;
  readonly ownerId: OwnerId;
  /** The problem being worked on when the memory was used. */
  readonly problemId: ProblemId;
  readonly sourceAi: string;
  readonly action: UsageAction;
  /** The past problem used as memory. May equal `problemId`. */
  readonly memoryId: ProblemId;
  readonly reason: string;
  readonly result: string | null;
  readonly createdAt: Date;
}

/**
 * What a caller supplies to record a use of memory.
 *
 * There is no owner field and no log id: both are the server's. `result` is
 * optional because a memory that was merely found or read has no outcome yet.
 */
export interface CreateUsageLogInput {
  readonly problemId: ProblemId;
  readonly sourceAi: string;
  readonly action: UsageAction;
  readonly memoryId: ProblemId;
  readonly reason: string;
  readonly result?: string | null;
}

interface UsageLogRow {
  usage_log_id: string;
  owner_id: string;
  problem_id: string;
  source_ai: string;
  action: UsageAction;
  memory_id: string;
  reason: string;
  result: string | null;
  created_at: Date;
}

function toRecord(row: UsageLogRow): UsageLogRecord {
  // The id columns are `uuid`, so the values are already normalised UUIDs.
  return {
    usageLogId: row.usage_log_id as UsageLogId,
    ownerId: row.owner_id as OwnerId,
    problemId: row.problem_id as ProblemId,
    sourceAi: row.source_ai,
    action: row.action,
    memoryId: row.memory_id as ProblemId,
    reason: row.reason,
    result: row.result,
    createdAt: row.created_at,
  };
}

const USAGE_LOG_COLUMNS = `usage_log_id, owner_id, problem_id, source_ai, action, memory_id,
  reason, result, created_at`;

/**
 * Records that one of the context owner's problems was used as memory while
 * working on another.
 *
 * Both the problem and the memory are checked as an (owner, problem) pair by
 * the foreign keys, so neither can reach another owner's Problem. Either
 * failing raises the same `ProblemNotAvailableError`, whether the Problem does
 * not exist or is someone else's — telling the two apart would answer "is this
 * id real?" for anyone who tried.
 *
 * The two may belong to different projects, and may be the same Problem. The
 * first is the point of memory at all; the second is what continuing an
 * investigation under a different AI looks like.
 *
 * Writing this changes neither Problem. No status, no version, no
 * `updated_at`: using a memory is not a claim about it.
 */
export async function createUsageLog(
  executor: DatabaseExecutor,
  context: OwnerContext,
  input: CreateUsageLogInput,
): Promise<UsageLogRecord> {
  const sourceAi = toUsageSourceAi(input.sourceAi);
  const reason = toUsageReason(input.reason);
  const result = toUsageResult(input.result);
  const usageLogId = generateUsageLogId();

  let inserted;
  try {
    inserted = await executor.query<UsageLogRow>(
      `insert into public.usage_logs
              (usage_log_id, owner_id, problem_id, source_ai, action, memory_id, reason, result)
            values ($1, $2, $3, $4, $5, $6, $7, $8)
         returning ${USAGE_LOG_COLUMNS}`,
      [
        usageLogId,
        context.ownerId,
        input.problemId,
        sourceAi,
        input.action,
        input.memoryId,
        reason,
        result,
      ],
    );
  } catch (error) {
    if (
      violatesConstraint(error, FOREIGN_KEY_VIOLATION, OWNER_PROBLEM_FK) ||
      violatesConstraint(error, FOREIGN_KEY_VIOLATION, OWNER_MEMORY_FK)
    ) {
      // One of the two is not this owner's. Which one is not distinguished,
      // by design.
      throw new ProblemNotAvailableError();
    }
    throw error;
  }

  const row = inserted.rows[0];
  if (row === undefined) {
    throw new Error('Usage log insert returned no row.');
  }

  return toRecord(row);
}

/**
 * Lists what memory was used while working on one of the context owner's
 * problems, oldest first.
 *
 * Scoped to the problem being worked on, not to the memory. "What did this
 * investigation draw on?" is the question the list answers; "where has this
 * memory been used?" is a different one, and no endpoint asks it yet.
 *
 * `usage_log_id` breaks ties so that two entries recorded in the same instant
 * still come back in a stable order rather than an arbitrary one.
 *
 * A problem that does not exist and one belonging to someone else both yield
 * an empty list, so the result cannot confirm an id exists.
 */
export async function listUsageLogs(
  executor: DatabaseExecutor,
  context: OwnerContext,
  problemId: ProblemId,
): Promise<UsageLogRecord[]> {
  const result = await executor.query<UsageLogRow>(
    `select ${USAGE_LOG_COLUMNS}
       from public.usage_logs
      where owner_id = $1 and problem_id = $2
      order by created_at asc, usage_log_id asc`,
    [context.ownerId, problemId],
  );

  return result.rows.map(toRecord);
}
