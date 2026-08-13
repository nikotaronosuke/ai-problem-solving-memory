/**
 * The change_logs table and its access functions, against the real database.
 *
 * The constraints are the substance. An entry that could claim a version out
 * of sequence, or two entries claiming the same version, would make the
 * history unreadable as a chain — and the unique constraint is what turns the
 * compare-and-swap on `problems.version` into a statement the schema itself
 * makes.
 *
 * Checks go around the create path deliberately, with raw SQL. A defence that
 * only exists in TypeScript is one a migration or a future caller can walk
 * past.
 *
 * Skipped when `DATABASE_URL` is not set.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readDatabaseUrl } from '../../src/config/env.js';
import { createChangeLog, listChangeLogs } from '../../src/db/change-logs.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { createEnvironment } from '../../src/db/environments.js';
import { ProblemNotAvailableError } from '../../src/db/errors.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import { createProblem } from '../../src/db/problems.js';
import { createProject } from '../../src/db/projects.js';
import { exactChange, generateChangeLogId } from '../../src/domain/change-log.js';
import { generateOwnerId, type OwnerContext, type OwnerId } from '../../src/domain/owner.js';
import { generateProblemId, type ProblemId } from '../../src/domain/problem.js';

const databaseUrl = readDatabaseUrl();

describe.skipIf(databaseUrl === undefined)('change logs in the database', () => {
  let pool: DatabasePool;
  const ownersCreated: OwnerId[] = [];

  async function makeOwnerContext(): Promise<OwnerContext> {
    const ownerId = generateOwnerId();
    await insertOwnerIfAbsent(pool, ownerId);
    ownersCreated.push(ownerId);
    return { ownerId } as OwnerContext;
  }

  async function makeProblem(context: OwnerContext): Promise<ProblemId> {
    const project = await createProject(pool, context, { projectName: 'fixture' });
    const environment = await createEnvironment(pool, context, {
      projectId: project.projectId,
      snapshot: {},
    });
    const problem = await createProblem(pool, context, {
      projectId: project.projectId,
      environmentId: environment.environmentId,
      title: 'Fixture problem',
      symptoms: 'Fixture symptoms',
    });
    return problem.problemId;
  }

  /** Inserts straight into the table, past the create path. */
  function rawInsert(values: {
    ownerId: string;
    problemId: string;
    changedBy?: string;
    fromVersion?: number;
    toVersion?: number;
    changes?: string;
  }) {
    return pool.query(
      `insert into public.change_logs
              (change_log_id, owner_id, problem_id, changed_by, from_version, to_version, changes)
            values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        generateChangeLogId(),
        values.ownerId,
        values.problemId,
        values.changedBy ?? 'claude-code',
        values.fromVersion ?? 1,
        values.toVersion ?? 2,
        values.changes ?? '{"confidence":{"kind":"exact","before":"LOW","after":"HIGH"}}',
      ],
    );
  }

  beforeAll(() => {
    pool = createPool(resolveDatabaseConfig({ nodeEnv: 'test', connectionTimeoutMillis: 5_000 }));
  });

  afterAll(async () => {
    if (ownersCreated.length > 0) {
      // Children first: every foreign key restricts deleting the parent.
      for (const table of ['change_logs', 'problems', 'environments', 'projects', 'owners']) {
        await pool.query(`delete from public.${table} where owner_id = any($1::uuid[])`, [
          ownersCreated,
        ]);
      }
    }
    await closePool(pool);
  });

  describe('shape', () => {
    it('holds only the columns a history entry needs', async () => {
      const result = await pool.query<{ column_name: string; is_nullable: string }>(
        `select column_name, is_nullable from information_schema.columns
          where table_schema = 'public' and table_name = 'change_logs'`,
      );

      const columns = result.rows.map((row) => row.column_name).sort();
      expect(columns).toEqual([
        'change_log_id',
        'changed_by',
        'changes',
        'created_at',
        'from_version',
        'owner_id',
        'problem_id',
        'to_version',
      ]);

      // An entry is a statement about a moment; there is no path that edits
      // one, so nothing records a change to it or guards one.
      expect(columns).not.toContain('updated_at');
      expect(columns).not.toContain('version');
      expect(columns).not.toContain('client_event_id');
      // Not a global audit log.
      expect(columns).not.toContain('tool_id');
      expect(columns).not.toContain('model_id');

      expect(result.rows.every((row) => row.is_nullable === 'NO')).toBe(true);
    });

    it('has no trigger', async () => {
      const result = await pool.query<{ count: string }>(
        `select count(*)::text as count from pg_trigger
          where tgrelid = 'public.change_logs'::regclass and not tgisinternal`,
      );

      // The rule about what may be written here is a product decision, and a
      // trigger would have neither the context to apply it nor anywhere to
      // say why.
      expect(result.rows[0]?.count).toBe('0');
    });

    it('issues no id of its own', async () => {
      const result = await pool.query<{ column_default: string | null }>(
        `select column_default from information_schema.columns
          where table_schema = 'public' and table_name = 'change_logs'
            and column_name = 'change_log_id'`,
      );

      expect(result.rows[0]?.column_default).toBeNull();
    });

    it('indexes the list path', async () => {
      const result = await pool.query<{ indexname: string }>(
        `select indexname from pg_indexes
          where schemaname = 'public' and tablename = 'change_logs'`,
      );

      expect(result.rows.map((row) => row.indexname)).toContain(
        'change_logs_owner_problem_created_idx',
      );
    });

    it('restricts deleting a problem that has history', async () => {
      const context = await makeOwnerContext();
      const problem = await makeProblem(context);
      await createChangeLog(pool, context, {
        problemId: problem,
        changedBy: 'claude-code',
        fromVersion: 1,
        toVersion: 2,
        changes: { confidence: exactChange('LOW', 'HIGH') },
      });

      await expect(
        pool.query('delete from public.problems where problem_id = $1', [problem]),
      ).rejects.toThrow(/violates foreign key constraint/);
    });
  });

  describe('what the database refuses', () => {
    it('refuses a blank changed_by', async () => {
      const context = await makeOwnerContext();
      const problem = await makeProblem(context);

      // A tab, because one-argument btrim would let it through.
      await expect(
        rawInsert({ ownerId: context.ownerId, problemId: problem, changedBy: '\t' }),
      ).rejects.toThrow(/change_logs_changed_by_not_blank/);
    });

    it('refuses a version below one', async () => {
      const context = await makeOwnerContext();
      const problem = await makeProblem(context);

      await expect(
        rawInsert({ ownerId: context.ownerId, problemId: problem, fromVersion: 0, toVersion: 1 }),
      ).rejects.toThrow(/change_logs_from_version_positive/);
    });

    it.each([
      ['a skipped version', 1, 3],
      ['a version going backwards', 3, 2],
      ['a version standing still', 2, 2],
    ])('refuses %s', async (_label, fromVersion, toVersion) => {
      const context = await makeOwnerContext();
      const problem = await makeProblem(context);

      // A successful mutation moves the version by exactly one, so anything
      // else describes something that could not have happened.
      await expect(
        rawInsert({ ownerId: context.ownerId, problemId: problem, fromVersion, toVersion }),
      ).rejects.toThrow(/change_logs_version_advances/);
    });

    it.each([
      ['an array', '[]'],
      ['a string', '"changed"'],
      ['a number', '3'],
      ['null', 'null'],
    ])('refuses changes that are %s', async (_label, changes) => {
      const context = await makeOwnerContext();
      const problem = await makeProblem(context);

      await expect(
        rawInsert({ ownerId: context.ownerId, problemId: problem, changes }),
      ).rejects.toThrow(/change_logs_changes_is_object|not-null/);
    });

    it('refuses an empty changes object', async () => {
      const context = await makeOwnerContext();
      const problem = await makeProblem(context);

      // Recording that something happened without recording what.
      await expect(
        rawInsert({ ownerId: context.ownerId, problemId: problem, changes: '{}' }),
      ).rejects.toThrow(/change_logs_changes_not_empty/);
    });

    it('refuses a second entry claiming the same version', async () => {
      const context = await makeOwnerContext();
      const problem = await makeProblem(context);
      await rawInsert({
        ownerId: context.ownerId,
        problemId: problem,
        fromVersion: 1,
        toVersion: 2,
      });

      // Unreachable through the mutation paths — the compare-and-swap means
      // only one writer produces a given version — so this states that in the
      // schema rather than trusting it.
      await expect(
        rawInsert({ ownerId: context.ownerId, problemId: problem, fromVersion: 1, toVersion: 2 }),
      ).rejects.toThrow(/change_logs_owner_problem_to_version_key/);
    });

    it('refuses a problem that is not this owner’s', async () => {
      const mine = await makeOwnerContext();
      const theirs = await makeOwnerContext();
      const theirProblem = await makeProblem(theirs);

      await expect(rawInsert({ ownerId: mine.ownerId, problemId: theirProblem })).rejects.toThrow(
        /change_logs_owner_id_problem_id_fkey/,
      );
    });

    it('reports an unreachable problem the same way through the create path', async () => {
      const context = await makeOwnerContext();

      await expect(
        createChangeLog(pool, context, {
          problemId: generateProblemId(),
          changedBy: 'claude-code',
          fromVersion: 1,
          toVersion: 2,
          changes: { confidence: exactChange('LOW', 'HIGH') },
        }),
      ).rejects.toThrow(ProblemNotAvailableError);
    });
  });

  describe('recording and listing', () => {
    it('stores the entry, trimming who made it', async () => {
      const context = await makeOwnerContext();
      const problem = await makeProblem(context);

      const entry = await createChangeLog(pool, context, {
        problemId: problem,
        changedBy: '  claude-code  ',
        fromVersion: 1,
        toVersion: 2,
        changes: { confidence: exactChange('LOW', 'HIGH') },
      });

      expect(entry).toMatchObject({
        ownerId: context.ownerId,
        problemId: problem,
        changedBy: 'claude-code',
        fromVersion: 1,
        toVersion: 2,
        changes: { confidence: { kind: 'exact', before: 'LOW', after: 'HIGH' } },
      });
      expect(entry.createdAt).toBeInstanceOf(Date);
    });

    it('reads the changes object back as it was written', async () => {
      const context = await makeOwnerContext();
      const problem = await makeProblem(context);
      const changes = {
        status: exactChange('INVESTIGATING', 'FIX_CANDIDATE'),
        title: { kind: 'text_redacted', before_present: true, after_present: true, changed: true },
      } as const;

      await createChangeLog(pool, context, {
        problemId: problem,
        changedBy: 'claude-code',
        fromVersion: 1,
        toVersion: 2,
        changes,
      });

      expect((await listChangeLogs(pool, context, problem))[0]?.changes).toEqual(changes);
    });

    it('lists a problem’s history oldest first', async () => {
      const context = await makeOwnerContext();
      const problem = await makeProblem(context);

      for (let version = 1; version <= 3; version += 1) {
        await createChangeLog(pool, context, {
          problemId: problem,
          changedBy: `writer-${version}`,
          fromVersion: version,
          toVersion: version + 1,
          changes: { confidence: exactChange('LOW', 'HIGH') },
        });
      }

      expect((await listChangeLogs(pool, context, problem)).map((e) => e.toVersion)).toEqual([
        2, 3, 4,
      ]);
    });

    it('orders deterministically when entries share a timestamp', async () => {
      const context = await makeOwnerContext();
      const problem = await makeProblem(context);
      const shared = '2026-01-01T00:00:00Z';
      const ids: string[] = [];

      for (let version = 1; version <= 3; version += 1) {
        const changeLogId = generateChangeLogId();
        ids.push(changeLogId);
        await pool.query(
          `insert into public.change_logs
                  (change_log_id, owner_id, problem_id, changed_by, from_version, to_version,
                   changes, created_at)
                values ($1, $2, $3, 'claude-code', $4, $5, '{"importance":{"kind":"exact","before":false,"after":true}}'::jsonb, $6)`,
          [changeLogId, context.ownerId, problem, version, version + 1, shared],
        );
      }

      const first = (await listChangeLogs(pool, context, problem)).map((e) => e.changeLogId);
      const second = (await listChangeLogs(pool, context, problem)).map((e) => e.changeLogId);

      expect(first).toEqual([...ids].sort());
      expect(second).toEqual(first);
    });

    it('returns an empty list for a problem with no history', async () => {
      const context = await makeOwnerContext();

      expect(await listChangeLogs(pool, context, await makeProblem(context))).toEqual([]);
    });

    it('shows one owner nothing of another’s history', async () => {
      const mine = await makeOwnerContext();
      const theirs = await makeOwnerContext();
      const theirProblem = await makeProblem(theirs);
      await createChangeLog(pool, theirs, {
        problemId: theirProblem,
        changedBy: 'claude-code',
        fromVersion: 1,
        toVersion: 2,
        changes: { confidence: exactChange('LOW', 'HIGH') },
      });

      expect(await listChangeLogs(pool, mine, theirProblem)).toEqual([]);
      expect(await listChangeLogs(pool, mine, generateProblemId())).toEqual([]);
    });
  });
});
