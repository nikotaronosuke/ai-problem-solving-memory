/**
 * The repository boundary, from the application down to the column.
 *
 * Two things are checked here that a unit test cannot. The column round-trips
 * a boundary through PostgreSQL unchanged, absent and null and a value all
 * meaning what they should on an update. And the database refuses a malformed
 * boundary *on its own* — the application validates too, but this column is
 * identity material and a constraint that only exists in TypeScript protects
 * nothing from a migration, a script, or a second writer.
 *
 * Skipped when `DATABASE_URL` is not set.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readDatabaseUrl } from '../../src/config/env.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import { createProject, getProject, listProjects, updateProject } from '../../src/db/projects.js';
import { generateOwnerId, type OwnerContext, type OwnerId } from '../../src/domain/owner.js';
import { generateProjectId, InvalidProjectFieldError } from '../../src/domain/project.js';
import { MEMORY_OWNER_ID_VAR, resolveOwnerContext } from '../../src/owner/context.js';

const databaseUrl = readDatabaseUrl();

describe.skipIf(databaseUrl === undefined)('a project’s repository boundary', () => {
  let pool: DatabasePool;
  let ownerId: OwnerId;
  let context: OwnerContext;

  beforeAll(async () => {
    pool = createPool(resolveDatabaseConfig({ nodeEnv: 'test', connectionTimeoutMillis: 5_000 }));
    ownerId = generateOwnerId();
    await insertOwnerIfAbsent(pool, ownerId);
    context = await resolveOwnerContext(pool, { [MEMORY_OWNER_ID_VAR]: ownerId });
  });

  afterAll(async () => {
    await pool.query('delete from public.projects where owner_id = $1', [ownerId]);
    await pool.query('delete from public.owners where owner_id = $1', [ownerId]);
    await closePool(pool);
  });

  describe('creating', () => {
    it('stores a boundary and reads it back unchanged', async () => {
      const created = await createProject(pool, context, {
        projectName: 'web',
        repo: 'github.com/acme/widget',
        repoSubpath: 'apps/web',
      });

      expect(created.repoSubpath).toBe('apps/web');
      const read = await getProject(pool, context, created.projectId);
      expect(read?.repoSubpath).toBe('apps/web');
    });

    it.each([
      ['absent', undefined],
      ['null', null],
    ])('stores no boundary when it is %s', async (_name, repoSubpath) => {
      const created = await createProject(pool, context, {
        projectName: 'whole',
        ...(repoSubpath === undefined ? {} : { repoSubpath }),
      });

      expect(created.repoSubpath).toBeNull();
    });

    it('refuses a boundary that is not repository-relative', async () => {
      await expect(
        createProject(pool, context, { projectName: 'bad', repoSubpath: '/apps/web' }),
      ).rejects.toBeInstanceOf(InvalidProjectFieldError);
    });

    it('lets two projects on one repository declare the same boundary', async () => {
      // A duplicate is a real situation the owner will want to merge, and it
      // has to be observable as an ambiguity rather than made impossible by
      // storage. Uniqueness here would contradict the feature.
      const shared = { repo: 'github.com/acme/duplicated', repoSubpath: 'apps/web' };

      await expect(
        Promise.all([
          createProject(pool, context, { projectName: 'first', ...shared }),
          createProject(pool, context, { projectName: 'second', ...shared }),
        ]),
      ).resolves.toHaveLength(2);
    });
  });

  describe('updating', () => {
    it('leaves the boundary alone when the patch does not mention it', async () => {
      const created = await createProject(pool, context, {
        projectName: 'untouched',
        repoSubpath: 'apps/web',
      });

      const updated = await updateProject(pool, context, created.projectId, {
        projectName: 'renamed',
      });

      expect(updated?.repoSubpath).toBe('apps/web');
    });

    it('clears the boundary back to the whole repository on an explicit null', async () => {
      const created = await createProject(pool, context, {
        projectName: 'widened',
        repoSubpath: 'apps/web',
      });

      const updated = await updateProject(pool, context, created.projectId, {
        repoSubpath: null,
      });

      expect(updated?.repoSubpath).toBeNull();
    });

    it('moves the boundary to a new one', async () => {
      const created = await createProject(pool, context, {
        projectName: 'moved',
        repoSubpath: 'apps/web',
      });

      const updated = await updateProject(pool, context, created.projectId, {
        repoSubpath: 'apps/web/client',
      });

      expect(updated?.repoSubpath).toBe('apps/web/client');
    });

    it('refuses a malformed boundary and changes nothing', async () => {
      const created = await createProject(pool, context, {
        projectName: 'unchanged',
        repoSubpath: 'apps/web',
      });

      await expect(
        updateProject(pool, context, created.projectId, { repoSubpath: 'apps/../web' }),
      ).rejects.toBeInstanceOf(InvalidProjectFieldError);

      const read = await getProject(pool, context, created.projectId);
      expect(read?.repoSubpath).toBe('apps/web');
    });

    it('accepts a boundary alongside the other fields', async () => {
      const created = await createProject(pool, context, { projectName: 'combined' });

      const updated = await updateProject(pool, context, created.projectId, {
        repo: 'github.com/acme/combined',
        repoSubpath: 'services/worker',
      });

      expect(updated?.repo).toBe('github.com/acme/combined');
      expect(updated?.repoSubpath).toBe('services/worker');
    });

    it('does not require a repository to carry a boundary', async () => {
      // A project whose repository is temporarily unknown may still record the
      // boundary somebody declared. The value is simply inert until a
      // repository is recorded — and coupling the two would make clearing a
      // repository quietly demand another field.
      const created = await createProject(pool, context, { projectName: 'repoless' });

      const updated = await updateProject(pool, context, created.projectId, {
        repoSubpath: 'apps/web',
      });

      expect(updated?.repo).toBeNull();
      expect(updated?.repoSubpath).toBe('apps/web');
    });
  });

  describe('the column itself', () => {
    it.each([
      ['empty', ''],
      ['a leading separator', '/apps/web'],
      ['a trailing separator', 'apps/web/'],
      ['an empty segment', 'apps//web'],
      ['a current-directory segment', 'apps/./web'],
      ['a parent segment', 'apps/../web'],
      ['a bare parent directory', '..'],
      ['a Windows separator', `apps${String.fromCharCode(92)}web`],
    ])('refuses %s written directly, without the application', async (_name, value) => {
      // The application would have caught this. The constraint is what catches
      // it when the application is not the writer.
      await expect(
        pool.query(
          `insert into public.projects (project_id, owner_id, project_name, repo_subpath)
                values ($1, $2, $3, $4)`,
          [generateProjectId(), ownerId, 'direct', value],
        ),
      ).rejects.toThrow();
    });

    it.each([
      ['a plain boundary', 'apps/web'],
      ['a deep boundary', 'services/payments/worker'],
      ['a boundary with spaces', 'a b/c d'],
      ['no boundary at all', null],
    ])('accepts %s written directly', async (_name, value) => {
      await expect(
        pool.query(
          `insert into public.projects (project_id, owner_id, project_name, repo_subpath)
                values ($1, $2, $3, $4)`,
          [generateProjectId(), ownerId, 'direct-ok', value],
        ),
      ).resolves.toBeDefined();
    });

    it('has no unique constraint on the repository or the boundary', async () => {
      const indexes = await pool.query<{ indexdef: string }>(
        `select indexdef from pg_indexes where schemaname = 'public' and tablename = 'projects'`,
      );

      for (const { indexdef } of indexes.rows) {
        const unique = indexdef.includes('UNIQUE');
        const touchesRepo = indexdef.includes('repo');
        expect(`${indexdef}:${unique && touchesRepo}`).toBe(`${indexdef}:false`);
      }
    });
  });

  describe('listing', () => {
    it('carries the boundary on every project it returns', async () => {
      const listed = await listProjects(pool, context);

      expect(listed.length).toBeGreaterThan(0);
      for (const project of listed) {
        expect(project).toHaveProperty('repoSubpath');
      }
      expect(listed.some((project) => project.repoSubpath !== null)).toBe(true);
    });
  });
});
