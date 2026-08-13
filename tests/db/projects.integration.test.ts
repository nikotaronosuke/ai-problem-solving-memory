/**
 * Project storage and the owner boundary, against the real database.
 *
 * Owners and projects are created with freshly generated ids and removed
 * afterwards, so the suite never depends on — or disturbs — the developer's
 * own owner row.
 *
 * Skipped when `DATABASE_URL` is not set.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readDatabaseUrl } from '../../src/config/env.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { createProject, getProject } from '../../src/db/projects.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import { generateOwnerId, type OwnerContext, type OwnerId } from '../../src/domain/owner.js';
import { generateProjectId, type ProjectId } from '../../src/domain/project.js';
import { MEMORY_OWNER_ID_VAR, resolveOwnerContext } from '../../src/owner/context.js';

const databaseUrl = readDatabaseUrl();

describe.skipIf(databaseUrl === undefined)('projects', () => {
  let pool: DatabasePool;
  const ownersCreated: OwnerId[] = [];

  /** Creates an owner, registers it for cleanup, and resolves its context. */
  async function makeOwnerContext(): Promise<OwnerContext> {
    const ownerId = generateOwnerId();
    await insertOwnerIfAbsent(pool, ownerId);
    ownersCreated.push(ownerId);
    return resolveOwnerContext(pool, { [MEMORY_OWNER_ID_VAR]: ownerId });
  }

  beforeAll(() => {
    pool = createPool(resolveDatabaseConfig({ nodeEnv: 'test', connectionTimeoutMillis: 5_000 }));
  });

  afterAll(async () => {
    if (ownersCreated.length > 0) {
      // Projects first: the foreign key restricts owner deletion.
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
    it('leaves project_id without a database default, so the application issues it', async () => {
      const result = await pool.query<{ column_default: string | null; data_type: string }>(
        `select column_default, data_type
           from information_schema.columns
          where table_schema = 'public' and table_name = 'projects'
            and column_name = 'project_id'`,
      );

      expect(result.rows[0]?.data_type).toBe('uuid');
      expect(result.rows[0]?.column_default).toBeNull();
    });

    it('requires an owner and restricts deleting one that still has projects', async () => {
      const result = await pool.query<{ confdeltype: string }>(
        `select confdeltype::text as confdeltype
           from pg_constraint
          where contype = 'f' and conrelid = 'public.projects'::regclass`,
      );

      // 'r' is RESTRICT. Deleting an owner must not quietly take Memory with it.
      expect(result.rows.map((row) => row.confdeltype)).toEqual(['r']);
    });

    it('allows repo and platform to be absent but not the name', async () => {
      const result = await pool.query<{ column_name: string; is_nullable: string }>(
        `select column_name, is_nullable
           from information_schema.columns
          where table_schema = 'public' and table_name = 'projects'`,
      );

      const nullable = Object.fromEntries(
        result.rows.map((row) => [row.column_name, row.is_nullable]),
      );

      expect(nullable['repo']).toBe('YES');
      expect(nullable['platform']).toBe('YES');
      expect(nullable['project_name']).toBe('NO');
      expect(nullable['owner_id']).toBe('NO');
    });

    it('leaves the shared value sets intact', async () => {
      // The full set of tables the phase should have is pinned once, in
      // `connection.integration.test.ts`, rather than restated per entity.
      const domains = await pool.query<{ count: string }>(
        `select count(*)::text as count
           from pg_type t join pg_namespace n on n.oid = t.typnamespace
          where t.typtype = 'd' and n.nspname = 'public'`,
      );

      // Eight: six from P1-04, plus `relation_type` and `usage_action`.
      expect(domains.rows[0]?.count).toBe('8');
    });
  });

  describe('creating', () => {
    it('stores a project owned by the context, not by anything the caller passed', async () => {
      const context = await makeOwnerContext();

      const project = await createProject(pool, context, { projectName: 'memory-service' });

      expect(project.ownerId).toBe(context.ownerId);
      expect(project.projectName).toBe('memory-service');

      const stored = await pool.query<{ owner_id: string }>(
        'select owner_id from public.projects where project_id = $1',
        [project.projectId],
      );
      expect(stored.rows[0]?.owner_id).toBe(context.ownerId);
    });

    it('accepts a project with no repository and no known platform', async () => {
      const context = await makeOwnerContext();

      const project = await createProject(pool, context, { projectName: 'notes-only' });

      expect(project.repo).toBeNull();
      expect(project.platform).toBeNull();
    });

    it('stores repo and platform when given, in any shape', async () => {
      const context = await makeOwnerContext();

      const project = await createProject(pool, context, {
        projectName: 'mobile-app',
        repo: 'git@example.com:team/mobile-app.git',
        platform: 'ios',
      });

      const reread = await getProject(pool, context, project.projectId);

      expect(reread?.repo).toBe('git@example.com:team/mobile-app.git');
      expect(reread?.platform).toBe('ios');
    });

    it('treats a blank repo or platform as absent', async () => {
      const context = await makeOwnerContext();

      const project = await createProject(pool, context, {
        projectName: 'blank-fields',
        repo: '   ',
        platform: '',
      });

      expect(project.repo).toBeNull();
      expect(project.platform).toBeNull();
    });

    it('refuses a blank name before reaching the database', async () => {
      const context = await makeOwnerContext();

      await expect(createProject(pool, context, { projectName: '   ' })).rejects.toThrow(/blank/);
    });

    it('refuses a blank name at the database too', async () => {
      const context = await makeOwnerContext();

      await expect(
        pool.query(
          'insert into public.projects (project_id, owner_id, project_name) values ($1, $2, $3)',
          [generateProjectId(), context.ownerId, '   '],
        ),
      ).rejects.toThrow(/projects_project_name_not_blank/);
    });

    it('refuses a project for an owner that does not exist', async () => {
      const absentOwner = generateOwnerId();

      await expect(
        pool.query(
          'insert into public.projects (project_id, owner_id, project_name) values ($1, $2, $3)',
          [generateProjectId(), absentOwner, 'orphan'],
        ),
      ).rejects.toThrow(/violates foreign key constraint/);
    });
  });

  describe('reading', () => {
    it('returns the context owner its own project', async () => {
      const context = await makeOwnerContext();
      const created = await createProject(pool, context, { projectName: 'readable' });

      const found = await getProject(pool, context, created.projectId);

      expect(found?.projectId).toBe(created.projectId);
      expect(found?.projectName).toBe('readable');
      expect(found?.createdAt).toBeInstanceOf(Date);
      expect(found?.updatedAt).toBeInstanceOf(Date);
    });

    it('reports an unknown project as absent', async () => {
      const context = await makeOwnerContext();

      expect(await getProject(pool, context, generateProjectId())).toBeUndefined();
    });
  });

  describe('isolation between owners', () => {
    it('hides each owner’s project from the other, in both directions', async () => {
      const contextA = await makeOwnerContext();
      const contextB = await makeOwnerContext();

      const projectA = await createProject(pool, contextA, { projectName: 'a-project' });
      const projectB = await createProject(pool, contextB, { projectName: 'b-project' });

      expect((await getProject(pool, contextA, projectA.projectId))?.projectId).toBe(
        projectA.projectId,
      );
      expect((await getProject(pool, contextB, projectB.projectId))?.projectId).toBe(
        projectB.projectId,
      );

      expect(await getProject(pool, contextA, projectB.projectId)).toBeUndefined();
      expect(await getProject(pool, contextB, projectA.projectId)).toBeUndefined();
    });

    it('answers the same way for another owner’s project as for one that does not exist', async () => {
      const contextA = await makeOwnerContext();
      const contextB = await makeOwnerContext();
      const projectB = await createProject(pool, contextB, { projectName: 'b-only' });

      const otherOwners = await getProject(pool, contextA, projectB.projectId);
      const nonexistent = await getProject(pool, contextA, generateProjectId());

      // Both are simply absent, so the answer cannot confirm the id exists.
      expect(otherOwners).toBeUndefined();
      expect(nonexistent).toBeUndefined();
      expect(otherOwners).toEqual(nonexistent);

      // The row really is there — isolation is the read path, not absence.
      const raw = await pool.query<{ project_id: ProjectId }>(
        'select project_id from public.projects where project_id = $1',
        [projectB.projectId],
      );
      expect(raw.rows).toHaveLength(1);
    });
  });

  describe('deleting an owner', () => {
    it('is restricted while the owner still has a project', async () => {
      const context = await makeOwnerContext();
      await createProject(pool, context, { projectName: 'blocks-deletion' });

      await expect(
        pool.query('delete from public.owners where owner_id = $1', [context.ownerId]),
      ).rejects.toThrow(/violates foreign key constraint/);

      const stillThere = await pool.query<{ count: string }>(
        'select count(*)::text as count from public.owners where owner_id = $1',
        [context.ownerId],
      );
      expect(stillThere.rows[0]?.count).toBe('1');
    });

    it('is permitted once the owner has no projects', async () => {
      const ownerId = generateOwnerId();
      await insertOwnerIfAbsent(pool, ownerId);

      await expect(
        pool.query('delete from public.owners where owner_id = $1', [ownerId]),
      ).resolves.toBeDefined();
    });
  });
});
