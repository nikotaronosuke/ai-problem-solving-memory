/**
 * Problem storage, initial values, the owner boundary and owner/project/
 * environment consistency, against the real database.
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
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import { EnvironmentNotAvailableError, createProblem, getProblem } from '../../src/db/problems.js';
import { createProject } from '../../src/db/projects.js';
import { generateEnvironmentId, type EnvironmentId } from '../../src/domain/environment.js';
import { generateOwnerId, type OwnerContext, type OwnerId } from '../../src/domain/owner.js';
import { generateProblemId } from '../../src/domain/problem.js';
import { type ProjectId } from '../../src/domain/project.js';
import { MEMORY_OWNER_ID_VAR, resolveOwnerContext } from '../../src/owner/context.js';

const databaseUrl = readDatabaseUrl();

interface Fixture {
  readonly context: OwnerContext;
  readonly projectId: ProjectId;
  readonly environmentId: EnvironmentId;
}

describe.skipIf(databaseUrl === undefined)('problems', () => {
  let pool: DatabasePool;
  const ownersCreated: OwnerId[] = [];

  async function makeOwnerContext(): Promise<OwnerContext> {
    const ownerId = generateOwnerId();
    await insertOwnerIfAbsent(pool, ownerId);
    ownersCreated.push(ownerId);
    return resolveOwnerContext(pool, { [MEMORY_OWNER_ID_VAR]: ownerId });
  }

  /** An owner with a project and an environment ready to record against. */
  async function makeFixture(): Promise<Fixture> {
    const context = await makeOwnerContext();
    const project = await createProject(pool, context, { projectName: 'fixture-project' });
    const environment = await createEnvironment(pool, context, {
      projectId: project.projectId,
      snapshot: { runtime: 'node 22.12.0' },
    });

    return { context, projectId: project.projectId, environmentId: environment.environmentId };
  }

  function minimalInput(fixture: Fixture) {
    return {
      projectId: fixture.projectId,
      environmentId: fixture.environmentId,
      title: 'Build fails on clean checkout',
      symptoms: 'The build succeeds locally but fails on CI with a missing module error.',
    };
  }

  beforeAll(() => {
    pool = createPool(resolveDatabaseConfig({ nodeEnv: 'test', connectionTimeoutMillis: 5_000 }));
  });

  afterAll(async () => {
    if (ownersCreated.length > 0) {
      // Children first: every foreign key restricts deleting the parent.
      await pool.query('delete from public.problems where owner_id = any($1::uuid[])', [
        ownersCreated,
      ]);
      await pool.query('delete from public.environments where owner_id = any($1::uuid[])', [
        ownersCreated,
      ]);
      await pool.query('delete from public.projects where owner_id = any($1::uuid[])', [
        ownersCreated,
      ]);
      await pool.query('delete from public.owners where owner_id = any($1::uuid[])', [
        ownersCreated,
      ]);
    }
    await closePool(pool);
  });

  describe('schema', () => {
    it('leaves problem_id without a database default', async () => {
      const result = await pool.query<{ column_default: string | null; data_type: string }>(
        `select column_default, data_type
           from information_schema.columns
          where table_schema = 'public' and table_name = 'problems'
            and column_name = 'problem_id'`,
      );

      expect(result.rows[0]?.data_type).toBe('uuid');
      expect(result.rows[0]?.column_default).toBeNull();
    });

    it('requires an environment, so there is no second way to say "unknown"', async () => {
      const result = await pool.query<{ is_nullable: string }>(
        `select is_nullable from information_schema.columns
          where table_schema = 'public' and table_name = 'problems'
            and column_name = 'environment_id'`,
      );

      expect(result.rows[0]?.is_nullable).toBe('NO');
    });

    it('uses the shared value sets for status, fix_kind, confidence and freshness', async () => {
      const result = await pool.query<{ column_name: string; domain_name: string | null }>(
        `select column_name, domain_name
           from information_schema.columns
          where table_schema = 'public' and table_name = 'problems'
            and domain_name is not null`,
      );

      const domains = Object.fromEntries(
        result.rows.map((row) => [row.column_name, row.domain_name]),
      );

      expect(domains).toEqual({
        status: 'problem_status',
        fix_kind: 'fix_kind',
        confidence: 'confidence',
        freshness: 'freshness',
      });
    });

    it('checks owner, project and environment as one triple, restricting the delete', async () => {
      const result = await pool.query<{ definition: string; confdeltype: string }>(
        `select pg_get_constraintdef(oid) as definition, confdeltype::text as confdeltype
           from pg_constraint
          where contype = 'f' and conrelid = 'public.problems'::regclass`,
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.definition).toContain(
        'FOREIGN KEY (owner_id, project_id, environment_id)',
      );
      expect(result.rows[0]?.definition).toContain(
        'REFERENCES environments(owner_id, project_id, environment_id)',
      );
      expect(result.rows[0]?.confdeltype).toBe('r');
    });

    it('carries both timestamps but no trigger to maintain them', async () => {
      const columns = await pool.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'problems'
            and column_name in ('created_at', 'updated_at')`,
      );
      const triggers = await pool.query<{ count: string }>(
        `select count(*)::text as count from pg_trigger
          where tgrelid = 'public.problems'::regclass and not tgisinternal`,
      );

      expect(columns.rows.map((row) => row.column_name).sort()).toEqual([
        'created_at',
        'updated_at',
      ]);
      // Phase 2's update path sets updated_at and version explicitly, so a
      // write that forgets to is a visible bug rather than a hidden fix.
      expect(triggers.rows[0]?.count).toBe('0');
    });

    it('leaves the shared value sets intact', async () => {
      const domains = await pool.query<{ count: string }>(
        `select count(*)::text as count
           from pg_type t join pg_namespace n on n.oid = t.typnamespace
          where t.typtype = 'd' and n.nspname = 'public'`,
      );

      // Seven since P2-08 added `relation_type`.
      expect(domains.rows[0]?.count).toBe('7');
    });
  });

  describe('creating', () => {
    it('records a problem owned by the context, not by anything the caller passed', async () => {
      const fixture = await makeFixture();

      const problem = await createProblem(pool, fixture.context, minimalInput(fixture));

      expect(problem.ownerId).toBe(fixture.context.ownerId);
      expect(problem.projectId).toBe(fixture.projectId);
      expect(problem.environmentId).toBe(fixture.environmentId);

      const stored = await pool.query<{ owner_id: string }>(
        'select owner_id from public.problems where problem_id = $1',
        [problem.problemId],
      );
      expect(stored.rows[0]?.owner_id).toBe(fixture.context.ownerId);
    });

    it('starts a new problem under investigation, unverified and untrusted', async () => {
      const fixture = await makeFixture();

      const problem = await createProblem(pool, fixture.context, minimalInput(fixture));

      expect(problem.status).toBe('INVESTIGATING');
      expect(problem.fixKind).toBeNull();
      expect(problem.confidence).toBe('LOW');
      expect(problem.freshness).toBe('CURRENT');
      expect(problem.importance).toBe(false);
      expect(problem.memoryReadEnabled).toBe(true);
      expect(problem.memoryWriteEnabled).toBe(true);
      expect(problem.suppressed).toBe(false);
      expect(problem.version).toBe(1);
      expect(problem.createdAt).toBeInstanceOf(Date);
      expect(problem.updatedAt).toBeInstanceOf(Date);
    });

    it('keeps optional fields absent when they are not yet known', async () => {
      const fixture = await makeFixture();

      const problem = await createProblem(pool, fixture.context, minimalInput(fixture));

      expect(problem.problemDomain).toBeNull();
      expect(problem.suspectedBoundary).toBeNull();
      expect(problem.sourceAi).toBeNull();
    });

    it('stores optional fields when they are known, trimming them', async () => {
      const fixture = await makeFixture();

      const problem = await createProblem(pool, fixture.context, {
        ...minimalInput(fixture),
        problemDomain: '  build  ',
        suspectedBoundary: '  bundler / native module boundary  ',
        sourceAi: '  claude-code  ',
      });

      expect(problem.problemDomain).toBe('build');
      expect(problem.suspectedBoundary).toBe('bundler / native module boundary');
      expect(problem.sourceAi).toBe('claude-code');
    });

    it('treats blank optional fields as absent', async () => {
      const fixture = await makeFixture();

      const problem = await createProblem(pool, fixture.context, {
        ...minimalInput(fixture),
        problemDomain: '   ',
        suspectedBoundary: '',
        sourceAi: '\t',
      });

      expect(problem.problemDomain).toBeNull();
      expect(problem.suspectedBoundary).toBeNull();
      expect(problem.sourceAi).toBeNull();
    });

    it('refuses a blank title or symptoms before reaching the database', async () => {
      const fixture = await makeFixture();

      await expect(
        createProblem(pool, fixture.context, { ...minimalInput(fixture), title: '   ' }),
      ).rejects.toThrow(/title/);
      await expect(
        createProblem(pool, fixture.context, { ...minimalInput(fixture), symptoms: '   ' }),
      ).rejects.toThrow(/symptoms/);
    });
  });

  describe('database constraints', () => {
    async function insertRaw(
      fixture: Fixture,
      columns: string,
      values: string,
      params: unknown[],
    ): Promise<unknown> {
      return pool.query(
        `insert into public.problems (problem_id, owner_id, project_id, environment_id, ${columns})
              values ($1, $2, $3, $4, ${values})`,
        [
          generateProblemId(),
          fixture.context.ownerId,
          fixture.projectId,
          fixture.environmentId,
          ...params,
        ],
      );
    }

    it('refuses a blank title', async () => {
      const fixture = await makeFixture();

      await expect(
        insertRaw(fixture, 'title, symptoms', '$5, $6', ['   ', 'something']),
      ).rejects.toThrow(/problems_title_not_blank/);
    });

    it('refuses blank symptoms', async () => {
      const fixture = await makeFixture();

      await expect(
        insertRaw(fixture, 'title, symptoms', '$5, $6', ['something', '   ']),
      ).rejects.toThrow(/problems_symptoms_not_blank/);
    });

    it('refuses a missing environment', async () => {
      const fixture = await makeFixture();

      await expect(
        pool.query(
          `insert into public.problems (problem_id, owner_id, project_id, environment_id, title, symptoms)
                values ($1, $2, $3, null, $4, $5)`,
          [generateProblemId(), fixture.context.ownerId, fixture.projectId, 'title', 'symptoms'],
        ),
      ).rejects.toThrow(/null value in column "environment_id"/);
    });

    it('refuses a version below one', async () => {
      const fixture = await makeFixture();

      await expect(
        insertRaw(fixture, 'title, symptoms, version', '$5, $6, $7', ['t', 's', 0]),
      ).rejects.toThrow(/problems_version_positive/);
    });

    it.each([
      ['status', 'RESOLVED', 'problem_status'],
      ['fix_kind', 'PATCH', 'fix_kind'],
      ['confidence', 'CERTAIN', 'confidence'],
      ['freshness', 'OLD', 'freshness'],
    ])('refuses an invalid %s', async (column, value, domain) => {
      const fixture = await makeFixture();

      await expect(
        insertRaw(fixture, `title, symptoms, ${column}`, '$5, $6, $7', ['t', 's', value]),
      ).rejects.toThrow(new RegExp(`${domain}_allowed_values`));
    });

    it.each([
      ['status', 'INVESTIGATING'],
      ['confidence', 'HIGH'],
      ['freshness', 'SUPERSEDED'],
      ['fix_kind', 'ROOT_FIX'],
    ])('accepts a valid %s', async (column, value) => {
      const fixture = await makeFixture();

      await expect(
        insertRaw(fixture, `title, symptoms, ${column}`, '$5, $6, $7', ['t', 's', value]),
      ).resolves.toBeDefined();
    });
  });

  describe('environment availability', () => {
    it('refuses an environment that does not exist', async () => {
      const fixture = await makeFixture();

      await expect(
        createProblem(pool, fixture.context, {
          ...minimalInput(fixture),
          environmentId: generateEnvironmentId(),
        }),
      ).rejects.toThrow(EnvironmentNotAvailableError);
    });

    it('refuses another owner’s environment, indistinguishably from an unknown one', async () => {
      const fixtureA = await makeFixture();
      const fixtureB = await makeFixture();

      const crossOwner = await createProblem(pool, fixtureA.context, {
        ...minimalInput(fixtureA),
        environmentId: fixtureB.environmentId,
      }).catch((error: unknown) => error);

      const unknown = await createProblem(pool, fixtureA.context, {
        ...minimalInput(fixtureA),
        environmentId: generateEnvironmentId(),
      }).catch((error: unknown) => error);

      expect(crossOwner).toBeInstanceOf(EnvironmentNotAvailableError);
      expect(unknown).toBeInstanceOf(EnvironmentNotAvailableError);
      expect((crossOwner as Error).message).toBe((unknown as Error).message);
    });

    it('refuses an environment belonging to a different project of the same owner', async () => {
      const fixture = await makeFixture();
      const otherProject = await createProject(pool, fixture.context, {
        projectName: 'other-project',
      });
      const otherEnvironment = await createEnvironment(pool, fixture.context, {
        projectId: otherProject.projectId,
        snapshot: {},
      });

      // The environment is the owner's, but not this project's.
      await expect(
        createProblem(pool, fixture.context, {
          ...minimalInput(fixture),
          environmentId: otherEnvironment.environmentId,
        }),
      ).rejects.toThrow(EnvironmentNotAvailableError);
    });

    it('refuses a mismatched owner, project and environment triple at the database too', async () => {
      const fixtureA = await makeFixture();
      const fixtureB = await makeFixture();

      await expect(
        pool.query(
          `insert into public.problems
                  (problem_id, owner_id, project_id, environment_id, title, symptoms)
                values ($1, $2, $3, $4, $5, $6)`,
          [
            generateProblemId(),
            fixtureA.context.ownerId,
            fixtureA.projectId,
            fixtureB.environmentId,
            'title',
            'symptoms',
          ],
        ),
      ).rejects.toThrow(/violates foreign key constraint/);
    });
  });

  describe('reading', () => {
    it('returns the context owner its own problem, with fields intact', async () => {
      const fixture = await makeFixture();
      const created = await createProblem(pool, fixture.context, minimalInput(fixture));

      const found = await getProblem(pool, fixture.context, created.problemId);

      expect(found?.problemId).toBe(created.problemId);
      expect(found?.title).toBe(created.title);
      expect(found?.symptoms).toBe(created.symptoms);
      expect(found?.projectId).toBe(fixture.projectId);
      expect(found?.environmentId).toBe(fixture.environmentId);
    });

    it('reports an unknown problem as absent', async () => {
      const fixture = await makeFixture();

      expect(await getProblem(pool, fixture.context, generateProblemId())).toBeUndefined();
    });
  });

  describe('isolation between owners', () => {
    it('hides each owner’s problem from the other, in both directions', async () => {
      const fixtureA = await makeFixture();
      const fixtureB = await makeFixture();
      const problemA = await createProblem(pool, fixtureA.context, minimalInput(fixtureA));
      const problemB = await createProblem(pool, fixtureB.context, minimalInput(fixtureB));

      expect((await getProblem(pool, fixtureA.context, problemA.problemId))?.problemId).toBe(
        problemA.problemId,
      );
      expect((await getProblem(pool, fixtureB.context, problemB.problemId))?.problemId).toBe(
        problemB.problemId,
      );

      expect(await getProblem(pool, fixtureA.context, problemB.problemId)).toBeUndefined();
      expect(await getProblem(pool, fixtureB.context, problemA.problemId)).toBeUndefined();
    });

    it('answers the same way for another owner’s problem as for one that does not exist', async () => {
      const fixtureA = await makeFixture();
      const fixtureB = await makeFixture();
      const problemB = await createProblem(pool, fixtureB.context, minimalInput(fixtureB));

      const otherOwners = await getProblem(pool, fixtureA.context, problemB.problemId);
      const nonexistent = await getProblem(pool, fixtureA.context, generateProblemId());

      expect(otherOwners).toBeUndefined();
      expect(nonexistent).toBeUndefined();
      expect(otherOwners).toEqual(nonexistent);

      // The row really is there — isolation is the read path, not absence.
      const raw = await pool.query('select problem_id from public.problems where problem_id = $1', [
        problemB.problemId,
      ]);
      expect(raw.rows).toHaveLength(1);
    });
  });

  describe('deleting an environment', () => {
    it('is restricted while a problem still references it', async () => {
      const fixture = await makeFixture();
      await createProblem(pool, fixture.context, minimalInput(fixture));

      await expect(
        pool.query('delete from public.environments where environment_id = $1', [
          fixture.environmentId,
        ]),
      ).rejects.toThrow(/violates foreign key constraint/);

      const stillThere = await pool.query<{ count: string }>(
        'select count(*)::text as count from public.environments where environment_id = $1',
        [fixture.environmentId],
      );
      expect(stillThere.rows[0]?.count).toBe('1');
    });

    it('is permitted once the problems are gone', async () => {
      const fixture = await makeFixture();
      const problem = await createProblem(pool, fixture.context, minimalInput(fixture));

      await pool.query('delete from public.problems where problem_id = $1', [problem.problemId]);

      await expect(
        pool.query('delete from public.environments where environment_id = $1', [
          fixture.environmentId,
        ]),
      ).resolves.toBeDefined();
    });
  });
});
