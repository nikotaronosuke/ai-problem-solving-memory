/**
 * Database access for change logs.
 *
 * Create and list only, and the create is not something a caller reaches: it
 * is called by the services that mutate a Problem, inside the same
 * transaction as the mutation. A history a caller could write directly would
 * not be a history.
 *
 * As elsewhere, every function takes an `OwnerContext`, the owner comes from
 * the context rather than caller input, and reads are scoped by `owner_id`.
 *
 * There is no update and no delete: an entry is a statement about a moment,
 * and editing it would defeat the point of having it.
 */

import {
  generateChangeLogId,
  toChangedBy,
  type ChangeLogId,
  type ProblemChanges,
} from '../domain/change-log.js';
import type { OwnerContext, OwnerId } from '../domain/owner.js';
import type { ProblemId } from '../domain/problem.js';
import { FOREIGN_KEY_VIOLATION, ProblemNotAvailableError, violatesConstraint } from './errors.js';
import type { DatabaseExecutor } from './executor.js';

const OWNER_PROBLEM_FK = 'change_logs_owner_id_problem_id_fkey';

export interface ChangeLogRecord {
  readonly changeLogId: ChangeLogId;
  readonly ownerId: OwnerId;
  readonly problemId: ProblemId;
  readonly changedBy: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly changes: ProblemChanges;
  readonly createdAt: Date;
}

/**
 * What a service supplies to record a change.
 *
 * There is no owner field and no log id: both are the server's. The versions
 * bracket the mutation, and `changes` describes what moved — with free text
 * described rather than copied, per `src/domain/change-log.ts`.
 */
export interface CreateChangeLogInput {
  readonly problemId: ProblemId;
  readonly changedBy: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly changes: ProblemChanges;
}

interface ChangeLogRow {
  change_log_id: string;
  owner_id: string;
  problem_id: string;
  changed_by: string;
  from_version: number;
  to_version: number;
  changes: ProblemChanges;
  created_at: Date;
}

function toRecord(row: ChangeLogRow): ChangeLogRecord {
  // The id columns are `uuid`, so the values are already normalised UUIDs.
  // `changes` is `jsonb`, which the driver has already parsed.
  return {
    changeLogId: row.change_log_id as ChangeLogId,
    ownerId: row.owner_id as OwnerId,
    problemId: row.problem_id as ProblemId,
    changedBy: row.changed_by,
    fromVersion: row.from_version,
    toVersion: row.to_version,
    changes: row.changes,
    createdAt: row.created_at,
  };
}

const CHANGE_LOG_COLUMNS = `change_log_id, owner_id, problem_id, changed_by, from_version,
  to_version, changes, created_at`;

/**
 * Records that one of the context owner's problems changed.
 *
 * Meant to be called with an executor that is already inside a transaction,
 * alongside the write it describes. Called on its own it would still work and
 * still be owner-scoped, but it would be recording something that might not
 * have happened.
 *
 * The unique constraint on `(owner_id, problem_id, to_version)` is what stops
 * two entries claiming the same version. It should be unreachable — the
 * compare-and-swap on the Problem means only one writer produces a given
 * version — so a violation here is left to surface rather than being caught
 * and smoothed over.
 */
export async function createChangeLog(
  executor: DatabaseExecutor,
  context: OwnerContext,
  input: CreateChangeLogInput,
): Promise<ChangeLogRecord> {
  const changedBy = toChangedBy(input.changedBy);
  const changeLogId = generateChangeLogId();

  let inserted;
  try {
    inserted = await executor.query<ChangeLogRow>(
      `insert into public.change_logs
              (change_log_id, owner_id, problem_id, changed_by, from_version, to_version, changes)
            values ($1, $2, $3, $4, $5, $6, $7::jsonb)
         returning ${CHANGE_LOG_COLUMNS}`,
      [
        changeLogId,
        context.ownerId,
        input.problemId,
        changedBy,
        input.fromVersion,
        input.toVersion,
        JSON.stringify(input.changes),
      ],
    );
  } catch (error) {
    if (violatesConstraint(error, FOREIGN_KEY_VIOLATION, OWNER_PROBLEM_FK)) {
      // The problem is not this owner's. Unreachable from the mutation paths,
      // which establish that first, so this is the backstop.
      throw new ProblemNotAvailableError();
    }
    throw error;
  }

  const row = inserted.rows[0];
  if (row === undefined) {
    throw new Error('Change log insert returned no row.');
  }

  return toRecord(row);
}

/**
 * Lists how one of the context owner's problems has changed, oldest first.
 *
 * `change_log_id` breaks ties so that repeated reads agree even when two
 * entries share a timestamp. In practice the version pair already orders them,
 * but the list is ordered by time like every other list here rather than
 * inventing a second convention.
 *
 * A problem that does not exist and one belonging to someone else both yield
 * an empty list, so the result cannot confirm an id exists.
 */
export async function listChangeLogs(
  executor: DatabaseExecutor,
  context: OwnerContext,
  problemId: ProblemId,
): Promise<ChangeLogRecord[]> {
  const result = await executor.query<ChangeLogRow>(
    `select ${CHANGE_LOG_COLUMNS}
       from public.change_logs
      where owner_id = $1 and problem_id = $2
      order by created_at asc, change_log_id asc`,
    [context.ownerId, problemId],
  );

  return result.rows.map(toRecord);
}
