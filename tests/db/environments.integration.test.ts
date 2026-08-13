/**
 * Environment storage, the owner boundary and owner/project consistency,
 * against the real database.
 *
 * Owners, projects and environments are created with freshly generated ids and
 * removed afterwards, so the suite never depends on — or disturbs — the
 * developer's own owner row.
 *
 * Skipped when `DATABASE_URL` is not set.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readDatabaseUrl } from '../../src/config/env.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import {
  ProjectNotAvailableError,
  createEnvironment,
  getEnvironment,
} from '../../src/db/environments.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { createProject } from '../../src/db/projects.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import { generateEnvironmentId } from '../../src/domain/environment.js';
import { generateOwnerId, type OwnerContext, type OwnerId } from '../../src/domain/owner.js';
import { generateProjectId, type ProjectId } from '../../src/domain/project.js';
import { MEMORY_OWNER_ID_VAR, resolveOwnerContext } from '../../src/owner/context.js';

const databaseUrl = readDatabaseUrl();

describe.skipIf(databaseUrl === undefined)('environments', () => {
  let pool: DatabasePool;
  const ownersCreated: OwnerId[] = [];

  async function makeOwnerContext(): Promise<OwnerContext> {
    const ownerId = generateOwnerId();
    await insertOwnerIfAbsent(pool, ownerId);
    ownersCreated.push(ownerId);
    return resolveOwnerContext(pool, { [MEMORY_OWNER_ID_VAR]: ownerId });
  }

  async function makeProject(context: OwnerContext): Promise<ProjectId> {
    const project = await createProject(pool, context, { projectName: 'fixture-project' });
    return project.projectId;
  }

  beforeAll(() => {
    pool = createPool(resolveDatabaseConfig({ nodeEnv: 'test', connectionTimeoutMillis: 5_000 }));
  });

  afterAll(async () => {
    if (ownersCreated.length > 0) {
      // Children first: both foreign keys restrict deleting the parent.
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
    it('leaves environment_id without a database default', async () => {
      const result = await pool.query<{ column_default: string | null; data_type: string }>(
        `select column_default, data_type
           from information_schema.columns
          where table_schema = 'public' and table_name = 'environments'
            and column_name = 'environment_id'`,
      );

      expect(result.rows[0]?.data_type).toBe('uuid');
      expect(result.rows[0]?.column_default).toBeNull();
    });

    it('has no updated_at, because a snapshot is a point in time', async () => {
      const result = await pool.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'environments'`,
      );

      expect(result.rows.map((row) => row.column_name).sort()).toEqual([
        'created_at',
        'environment_id',
        'owner_id',
        'project_id',
        'snapshot',
      ]);
    });

    it('checks owner and project together, and restricts deleting the project', async () => {
      const result = await pool.query<{ definition: string; confdeltype: string }>(
        `select pg_get_constraintdef(oid) as definition, confdeltype::text as confdeltype
           from pg_constraint
          where contype = 'f' and conrelid = 'public.environments'::regclass`,
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.definition).toContain('FOREIGN KEY (owner_id, project_id)');
      expect(result.rows[0]?.definition).toContain('REFERENCES projects(owner_id, project_id)');
      expect(result.rows[0]?.confdeltype).toBe('r');
    });

    it('leaves the shared value sets intact', async () => {
      // The full set of tables the phase should have is pinned once, in
      // `connection.integration.test.ts`, rather than restated per entity.
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
    it('records a snapshot owned by the context, not by anything the caller passed', async () => {
      const context = await makeOwnerContext();
      const projectId = await makeProject(context);

      const environment = await createEnvironment(pool, context, {
        projectId,
        snapshot: { os: 'macOS 15.2', runtime: 'node 22.12.0' },
      });

      expect(environment.ownerId).toBe(context.ownerId);
      expect(environment.projectId).toBe(projectId);

      const stored = await pool.query<{ owner_id: string }>(
        'select owner_id from public.environments where environment_id = $1',
        [environment.environmentId],
      );
      expect(stored.rows[0]?.owner_id).toBe(context.ownerId);
    });

    it('round-trips a nested snapshot unchanged', async () => {
      const context = await makeOwnerContext();
      const projectId = await makeProject(context);
      const snapshot = {
        os: 'iOS 18.2',
        device: 'iPhone 15 Pro',
        framework: 'react-native 0.76.5',
        versions: { node: '22.12.0', xcode: '16.2' },
        deployment: 'testflight',
        branch: 'release/1.4',
        commit: 'a1b2c3d4',
      };

      const created = await createEnvironment(pool, context, { projectId, snapshot });
      const reread = await getEnvironment(pool, context, created.environmentId);

      expect(reread?.snapshot).toEqual(snapshot);
    });

    it('accepts an empty snapshot, meaning conditions are not captured yet', async () => {
      const context = await makeOwnerContext();
      const projectId = await makeProject(context);

      const environment = await createEnvironment(pool, context, { projectId, snapshot: {} });

      expect(environment.snapshot).toEqual({});
    });

    it('refuses a non-object snapshot before reaching the database', async () => {
      const context = await makeOwnerContext();
      const projectId = await makeProject(context);

      await expect(createEnvironment(pool, context, { projectId, snapshot: [] })).rejects.toThrow(
        /array/,
      );
      await expect(
        createEnvironment(pool, context, { projectId, snapshot: 'macOS' }),
      ).rejects.toThrow(/string/);
    });

    it.each([
      ['an array', '[]'],
      ['a string', '"macOS"'],
      ['a number', '42'],
      ['JSON null', 'null'],
    ])('refuses %s as a snapshot at the database too', async (_label, json) => {
      const context = await makeOwnerContext();
      const projectId = await makeProject(context);

      await expect(
        pool.query(
          `insert into public.environments (environment_id, owner_id, project_id, snapshot)
                values ($1, $2, $3, $4::jsonb)`,
          [generateEnvironmentId(), context.ownerId, projectId, json],
        ),
      ).rejects.toThrow(/environments_snapshot_is_object/);
    });
  });

  describe('project availability', () => {
    it('refuses a project that does not exist', async () => {
      const context = await makeOwnerContext();

      await expect(
        createEnvironment(pool, context, { projectId: generateProjectId(), snapshot: {} }),
      ).rejects.toThrow(ProjectNotAvailableError);
    });

    it('refuses another owner’s project, indistinguishably from an unknown one', async () => {
      const contextA = await makeOwnerContext();
      const contextB = await makeOwnerContext();
      const projectB = await makeProject(contextB);

      const crossOwner = await createEnvironment(pool, contextA, {
        projectId: projectB,
        snapshot: {},
      }).catch((error: unknown) => error);

      const unknown = await createEnvironment(pool, contextA, {
        projectId: generateProjectId(),
        snapshot: {},
      }).catch((error: unknown) => error);

      // Same failure either way, so the outcome cannot confirm the id exists.
      expect(crossOwner).toBeInstanceOf(ProjectNotAvailableError);
      expect(unknown).toBeInstanceOf(ProjectNotAvailableError);
      expect((crossOwner as Error).message).toBe((unknown as Error).message);
    });

    it('refuses a mismatched owner and project pair at the database too', async () => {
      const contextA = await makeOwnerContext();
      const contextB = await makeOwnerContext();
      const projectB = await makeProject(contextB);

      await expect(
        pool.query(
          `insert into public.environments (environment_id, owner_id, project_id, snapshot)
                values ($1, $2, $3, '{}'::jsonb)`,
          [generateEnvironmentId(), contextA.ownerId, projectB],
        ),
      ).rejects.toThrow(/violates foreign key constraint/);
    });
  });

  describe('reading', () => {
    it('returns the context owner its own environment', async () => {
      const context = await makeOwnerContext();
      const projectId = await makeProject(context);
      const created = await createEnvironment(pool, context, {
        projectId,
        snapshot: { os: 'linux' },
      });

      const found = await getEnvironment(pool, context, created.environmentId);

      expect(found?.environmentId).toBe(created.environmentId);
      expect(found?.createdAt).toBeInstanceOf(Date);
    });

    it('reports an unknown environment as absent', async () => {
      const context = await makeOwnerContext();

      expect(await getEnvironment(pool, context, generateEnvironmentId())).toBeUndefined();
    });
  });

  describe('isolation between owners', () => {
    it('hides each owner’s environment from the other, in both directions', async () => {
      const contextA = await makeOwnerContext();
      const contextB = await makeOwnerContext();
      const environmentA = await createEnvironment(pool, contextA, {
        projectId: await makeProject(contextA),
        snapshot: { os: 'a' },
      });
      const environmentB = await createEnvironment(pool, contextB, {
        projectId: await makeProject(contextB),
        snapshot: { os: 'b' },
      });

      expect(
        (await getEnvironment(pool, contextA, environmentA.environmentId))?.environmentId,
      ).toBe(environmentA.environmentId);
      expect(
        (await getEnvironment(pool, contextB, environmentB.environmentId))?.environmentId,
      ).toBe(environmentB.environmentId);

      expect(await getEnvironment(pool, contextA, environmentB.environmentId)).toBeUndefined();
      expect(await getEnvironment(pool, contextB, environmentA.environmentId)).toBeUndefined();
    });

    it('answers the same way for another owner’s environment as for one that does not exist', async () => {
      const contextA = await makeOwnerContext();
      const contextB = await makeOwnerContext();
      const environmentB = await createEnvironment(pool, contextB, {
        projectId: await makeProject(contextB),
        snapshot: {},
      });

      const otherOwners = await getEnvironment(pool, contextA, environmentB.environmentId);
      const nonexistent = await getEnvironment(pool, contextA, generateEnvironmentId());

      expect(otherOwners).toBeUndefined();
      expect(nonexistent).toBeUndefined();
      expect(otherOwners).toEqual(nonexistent);

      // The row really is there — isolation is the read path, not absence.
      const raw = await pool.query(
        'select environment_id from public.environments where environment_id = $1',
        [environmentB.environmentId],
      );
      expect(raw.rows).toHaveLength(1);
    });
  });

  describe('deleting a project', () => {
    it('is restricted while the project still has an environment', async () => {
      const context = await makeOwnerContext();
      const projectId = await makeProject(context);
      await createEnvironment(pool, context, { projectId, snapshot: {} });

      await expect(
        pool.query('delete from public.projects where project_id = $1', [projectId]),
      ).rejects.toThrow(/violates foreign key constraint/);

      const stillThere = await pool.query<{ count: string }>(
        'select count(*)::text as count from public.projects where project_id = $1',
        [projectId],
      );
      expect(stillThere.rows[0]?.count).toBe('1');
    });

    it('is permitted once the environments are gone', async () => {
      const context = await makeOwnerContext();
      const projectId = await makeProject(context);
      const environment = await createEnvironment(pool, context, { projectId, snapshot: {} });

      await pool.query('delete from public.environments where environment_id = $1', [
        environment.environmentId,
      ]);

      await expect(
        pool.query('delete from public.projects where project_id = $1', [projectId]),
      ).resolves.toBeDefined();
    });
  });
});
