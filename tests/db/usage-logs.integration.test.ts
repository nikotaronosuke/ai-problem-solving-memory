/**
 * The usage_logs table and its access functions, against the real database.
 *
 * Two things are being checked. That the database refuses what it must — a
 * log naming another owner's Problem at either end, a blank source, reason or
 * result — regardless of which code writes it; and that the access functions
 * behave the way the layers above assume.
 *
 * The constraint checks go around the create path deliberately, with raw SQL.
 * A defence that only exists in TypeScript is one a migration, a script or a
 * future caller can walk past.
 *
 * Fixtures are created with freshly generated ids and removed afterwards, so
 * the suite never depends on — or disturbs — the developer's own owner row.
 *
 * Skipped when `DATABASE_URL` is not set.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readDatabaseUrl } from '../../src/config/env.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { createEnvironment } from '../../src/db/environments.js';
import { ProblemNotAvailableError } from '../../src/db/errors.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import { createProblem } from '../../src/db/problems.js';
import { createProject } from '../../src/db/projects.js';
import { createUsageLog, listUsageLogs } from '../../src/db/usage-logs.js';
import { USAGE_ACTIONS } from '../../src/domain/enums.js';
import { generateOwnerId, type OwnerContext, type OwnerId } from '../../src/domain/owner.js';
import { generateProblemId, type ProblemId } from '../../src/domain/problem.js';
import { generateUsageLogId } from '../../src/domain/usage-log.js';

const databaseUrl = readDatabaseUrl();

describe.skipIf(databaseUrl === undefined)('usage logs in the database', () => {
  let pool: DatabasePool;
  const ownersCreated: OwnerId[] = [];

  async function makeOwnerContext(): Promise<OwnerContext> {
    const ownerId = generateOwnerId();
    await insertOwnerIfAbsent(pool, ownerId);
    ownersCreated.push(ownerId);
    return { ownerId } as OwnerContext;
  }

  async function makeProblem(context: OwnerContext, projectName = 'fixture'): Promise<ProblemId> {
    const project = await createProject(pool, context, { projectName });
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
    memoryId: string;
    action?: string;
    sourceAi?: string;
    reason?: string;
    result?: string | null;
  }) {
    return pool.query(
      `insert into public.usage_logs
              (usage_log_id, owner_id, problem_id, source_ai, action, memory_id, reason, result)
            values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        generateUsageLogId(),
        values.ownerId,
        values.problemId,
        values.sourceAi ?? 'claude-code',
        values.action ?? 'REFERENCED',
        values.memoryId,
        values.reason ?? 'Fixture reason',
        values.result ?? null,
      ],
    );
  }

  beforeAll(() => {
    pool = createPool(resolveDatabaseConfig({ nodeEnv: 'test', connectionTimeoutMillis: 5_000 }));
  });

  afterAll(async () => {
    if (ownersCreated.length > 0) {
      // Children first: every foreign key restricts deleting the parent.
      for (const table of [
        'change_logs',
        'usage_logs',
        'problems',
        'environments',
        'projects',
        'owners',
      ]) {
        await pool.query(`delete from public.${table} where owner_id = any($1::uuid[])`, [
          ownersCreated,
        ]);
      }
    }
    await closePool(pool);
  });

  describe('shape', () => {
    it('holds only the columns a usage record needs', async () => {
      const result = await pool.query<{ column_name: string; is_nullable: string }>(
        `select column_name, is_nullable from information_schema.columns
          where table_schema = 'public' and table_name = 'usage_logs'`,
      );

      const columns = result.rows.map((row) => row.column_name).sort();
      expect(columns).toEqual([
        'action',
        'created_at',
        'memory_id',
        'owner_id',
        'problem_id',
        'reason',
        'result',
        'source_ai',
        'usage_log_id',
      ]);

      // Rows are added, never edited.
      expect(columns).not.toContain('updated_at');
      expect(columns).not.toContain('version');
      // No idempotency key was invented for this.
      expect(columns).not.toContain('client_event_id');
      // Not a polymorphic memory reference: a Case Memory is a Problem.
      expect(columns).not.toContain('memory_type');
      expect(columns).not.toContain('entity_type');
      // Not a global audit log. These belong to a layer above this service.
      expect(columns).not.toContain('tool_id');
      expect(columns).not.toContain('model_id');
      expect(columns).not.toContain('approval_id');

      const nullable = Object.fromEntries(
        result.rows.map((row) => [row.column_name, row.is_nullable]),
      );
      // Only the outcome may be unknown.
      expect(nullable['result']).toBe('YES');
      expect(
        Object.entries(nullable)
          .filter(([name]) => name !== 'result')
          .every(([, value]) => value === 'NO'),
      ).toBe(true);
    });

    it('has no trigger', async () => {
      const result = await pool.query<{ count: string }>(
        `select count(*)::text as count from pg_trigger
          where tgrelid = 'public.usage_logs'::regclass and not tgisinternal`,
      );

      expect(result.rows[0]?.count).toBe('0');
    });

    it('issues no id of its own', async () => {
      const result = await pool.query<{ column_default: string | null }>(
        `select column_default from information_schema.columns
          where table_schema = 'public' and table_name = 'usage_logs'
            and column_name = 'usage_log_id'`,
      );

      expect(result.rows[0]?.column_default).toBeNull();
    });

    it('indexes the list path and the memory side', async () => {
      const result = await pool.query<{ indexname: string }>(
        `select indexname from pg_indexes
          where schemaname = 'public' and tablename = 'usage_logs'`,
      );

      const names = result.rows.map((row) => row.indexname).sort();
      expect(names).toContain('usage_logs_owner_problem_created_idx');
      expect(names).toContain('usage_logs_owner_memory_created_idx');
    });

    it('restricts deleting either problem it names', async () => {
      const context = await makeOwnerContext();
      const current = await makeProblem(context);
      const memory = await makeProblem(context);
      await createUsageLog(pool, context, {
        problemId: current,
        sourceAi: 'claude-code',
        action: 'ADOPTED',
        memoryId: memory,
        reason: 'Took the same approach.',
      });

      // Both ends, since both are foreign keys.
      await expect(
        pool.query('delete from public.problems where problem_id = $1', [current]),
      ).rejects.toThrow(/violates foreign key constraint/);
      await expect(
        pool.query('delete from public.problems where problem_id = $1', [memory]),
      ).rejects.toThrow(/violates foreign key constraint/);
    });
  });

  describe('what the database refuses', () => {
    it.each([
      ['source_ai', 'sourceAi', 'usage_logs_source_ai_not_blank'],
      ['reason', 'reason', 'usage_logs_reason_not_blank'],
      ['result', 'result', 'usage_logs_result_not_blank'],
    ] as const)('refuses a blank %s', async (_label, field, constraint) => {
      const context = await makeOwnerContext();
      const current = await makeProblem(context);
      const memory = await makeProblem(context);

      // A tab, because one-argument btrim would let it through.
      await expect(
        rawInsert({
          ownerId: context.ownerId,
          problemId: current,
          memoryId: memory,
          [field]: '\t',
        }),
      ).rejects.toThrow(new RegExp(constraint));
    });

    it('accepts a null result, since the outcome may not be known yet', async () => {
      const context = await makeOwnerContext();
      const current = await makeProblem(context);
      const memory = await makeProblem(context);

      await expect(
        rawInsert({ ownerId: context.ownerId, problemId: current, memoryId: memory, result: null }),
      ).resolves.toBeDefined();
    });

    it('refuses an action outside the shared value set', async () => {
      const context = await makeOwnerContext();
      const current = await makeProblem(context);
      const memory = await makeProblem(context);

      // Unreachable through the create path — the type system rejects it — so
      // this probes the database's own defence directly.
      await expect(
        rawInsert({
          ownerId: context.ownerId,
          problemId: current,
          memoryId: memory,
          action: 'CONSIDERED',
        }),
      ).rejects.toThrow(/usage_action_allowed_values/);
    });

    it('refuses a current problem that is not this owner’s', async () => {
      const mine = await makeOwnerContext();
      const theirs = await makeOwnerContext();
      const theirProblem = await makeProblem(theirs);
      const myProblem = await makeProblem(mine);

      await expect(
        rawInsert({ ownerId: mine.ownerId, problemId: theirProblem, memoryId: myProblem }),
      ).rejects.toThrow(/usage_logs_owner_id_problem_id_fkey/);
    });

    it('refuses a memory that is not this owner’s', async () => {
      const mine = await makeOwnerContext();
      const theirs = await makeOwnerContext();
      const myProblem = await makeProblem(mine);
      const theirProblem = await makeProblem(theirs);

      await expect(
        rawInsert({ ownerId: mine.ownerId, problemId: myProblem, memoryId: theirProblem }),
      ).rejects.toThrow(/usage_logs_owner_id_memory_id_fkey/);
    });

    it.each([
      ['the current problem', 'problem'],
      ['the memory', 'memory'],
    ])('reports a missing %s the same way through the create path', async (_label, end) => {
      const context = await makeOwnerContext();
      const real = await makeProblem(context);
      const missing = generateProblemId();

      await expect(
        createUsageLog(pool, context, {
          problemId: end === 'problem' ? missing : real,
          sourceAi: 'claude-code',
          action: 'SEARCHED',
          memoryId: end === 'problem' ? real : missing,
          reason: 'Should not land',
        }),
      ).rejects.toThrow(ProblemNotAvailableError);
    });

    it('does not distinguish another owner’s memory from one that does not exist', async () => {
      const mine = await makeOwnerContext();
      const theirs = await makeOwnerContext();
      const myProblem = await makeProblem(mine);
      const theirProblem = await makeProblem(theirs);

      const crossOwner = createUsageLog(pool, mine, {
        problemId: myProblem,
        sourceAi: 'claude-code',
        action: 'REFERENCED',
        memoryId: theirProblem,
        reason: 'Should not land',
      });
      const missing = createUsageLog(pool, mine, {
        problemId: myProblem,
        sourceAi: 'claude-code',
        action: 'REFERENCED',
        memoryId: generateProblemId(),
        reason: 'Should not land',
      });

      await expect(crossOwner).rejects.toThrow(ProblemNotAvailableError);
      await expect(missing).rejects.toThrow(ProblemNotAvailableError);
    });
  });

  describe('recording and listing', () => {
    it.each(USAGE_ACTIONS)('records a %s entry', async (action) => {
      const context = await makeOwnerContext();
      const current = await makeProblem(context);
      const memory = await makeProblem(context);

      const log = await createUsageLog(pool, context, {
        problemId: current,
        sourceAi: '  claude-code  ',
        action,
        memoryId: memory,
        reason: '  Same auth boundary.  ',
      });

      expect(log).toMatchObject({
        ownerId: context.ownerId,
        problemId: current,
        memoryId: memory,
        action,
        sourceAi: 'claude-code',
        reason: 'Same auth boundary.',
        result: null,
      });
      expect(log.createdAt).toBeInstanceOf(Date);
    });

    it('stores a result when the outcome is already known', async () => {
      const context = await makeOwnerContext();
      const current = await makeProblem(context);
      const memory = await makeProblem(context);

      const log = await createUsageLog(pool, context, {
        problemId: current,
        sourceAi: 'claude-code',
        action: 'ADOPTED',
        memoryId: memory,
        reason: 'Same fix shape.',
        result: '  It worked.  ',
      });

      expect(log.result).toBe('It worked.');
    });

    it('records memory used from a different project', async () => {
      const context = await makeOwnerContext();
      const current = await makeProblem(context, 'admin-console');
      const memory = await makeProblem(context, 'checkout-web');

      const log = await createUsageLog(pool, context, {
        problemId: current,
        sourceAi: 'claude-code',
        action: 'REFERENCED',
        memoryId: memory,
        reason: 'Same session handling in another project.',
      });

      // Memory reaching across projects is the point of keeping it.
      expect(log).toMatchObject({ problemId: current, memoryId: memory });
    });

    it('allows a problem to be recorded as its own memory', async () => {
      const context = await makeOwnerContext();
      const problem = await makeProblem(context);

      const log = await createUsageLog(pool, context, {
        problemId: problem,
        sourceAi: 'codex',
        action: 'REFERENCED',
        memoryId: problem,
        reason: 'Picked this up from another assistant and read its history.',
      });

      // Continuing the same investigation under a different AI is a real
      // case, so there is no self-reference check.
      expect(log.problemId).toBe(problem);
      expect(log.memoryId).toBe(problem);
    });

    it('lists a problem’s usage oldest first', async () => {
      const context = await makeOwnerContext();
      const current = await makeProblem(context);
      const memory = await makeProblem(context);
      const reasons = ['first', 'second', 'third'];

      for (const reason of reasons) {
        await createUsageLog(pool, context, {
          problemId: current,
          sourceAi: 'claude-code',
          action: 'SEARCHED',
          memoryId: memory,
          reason,
        });
      }

      expect((await listUsageLogs(pool, context, current)).map((l) => l.reason)).toEqual(reasons);
    });

    it('orders deterministically when entries share a timestamp', async () => {
      const context = await makeOwnerContext();
      const current = await makeProblem(context);
      const memory = await makeProblem(context);
      const shared = '2026-01-01T00:00:00Z';
      const ids: string[] = [];

      for (let index = 0; index < 3; index += 1) {
        const usageLogId = generateUsageLogId();
        ids.push(usageLogId);
        await pool.query(
          `insert into public.usage_logs
                  (usage_log_id, owner_id, problem_id, source_ai, action, memory_id, reason,
                   created_at)
                values ($1, $2, $3, 'claude-code', 'SEARCHED', $4, $5, $6)`,
          [usageLogId, context.ownerId, current, memory, `tie-${usageLogId}`, shared],
        );
      }

      const first = (await listUsageLogs(pool, context, current)).map((l) => l.usageLogId);
      const second = (await listUsageLogs(pool, context, current)).map((l) => l.usageLogId);

      expect(first).toEqual([...ids].sort());
      expect(second).toEqual(first);
    });

    it('is scoped to the problem being worked on, not to the memory', async () => {
      const context = await makeOwnerContext();
      const current = await makeProblem(context);
      const memory = await makeProblem(context);
      await createUsageLog(pool, context, {
        problemId: current,
        sourceAi: 'claude-code',
        action: 'ADOPTED',
        memoryId: memory,
        reason: 'Took it.',
      });

      // "What did this investigation draw on?" is the question. "Where has
      // this memory been used?" is a different one, and no path asks it yet.
      expect(await listUsageLogs(pool, context, current)).toHaveLength(1);
      expect(await listUsageLogs(pool, context, memory)).toEqual([]);
    });

    it('returns an empty list for a problem with no usage', async () => {
      const context = await makeOwnerContext();

      expect(await listUsageLogs(pool, context, await makeProblem(context))).toEqual([]);
    });

    it('shows one owner nothing of another’s usage', async () => {
      const mine = await makeOwnerContext();
      const theirs = await makeOwnerContext();
      const theirCurrent = await makeProblem(theirs);
      const theirMemory = await makeProblem(theirs);
      await createUsageLog(pool, theirs, {
        problemId: theirCurrent,
        sourceAi: 'claude-code',
        action: 'ADOPTED',
        memoryId: theirMemory,
        reason: 'Theirs',
      });

      expect(await listUsageLogs(pool, mine, theirCurrent)).toEqual([]);
      expect(await listUsageLogs(pool, mine, generateProblemId())).toEqual([]);
    });

    it('does not touch either problem', async () => {
      const context = await makeOwnerContext();
      const current = await makeProblem(context);
      const memory = await makeProblem(context);
      const before = await pool.query<{ version: number; status: string; updated_at: Date }>(
        'select version, status, updated_at from public.problems where problem_id = any($1::uuid[]) order by problem_id',
        [[current, memory]],
      );

      await createUsageLog(pool, context, {
        problemId: current,
        sourceAi: 'claude-code',
        action: 'ADOPTED',
        memoryId: memory,
        reason: 'Took it.',
      });

      const after = await pool.query<{ version: number; status: string; updated_at: Date }>(
        'select version, status, updated_at from public.problems where problem_id = any($1::uuid[]) order by problem_id',
        [[current, memory]],
      );

      // Using a memory is not a claim about it.
      expect(after.rows).toEqual(before.rows);
    });
  });
});
