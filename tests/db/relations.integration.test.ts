/**
 * The relations table and its access functions, against the real database.
 *
 * Two things are being checked. That the database itself refuses what it must
 * — a link across owners, a link to nothing, a link from a problem to itself,
 * a blank reason — regardless of which code writes it; and that the access
 * functions behave the way the layers above assume.
 *
 * The constraint checks go around the append path deliberately, with raw SQL.
 * A defence that only exists in TypeScript is a defence that a migration, a
 * script or a future caller can walk past.
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
import { createRelation, listRelations } from '../../src/db/relations.js';
import { RELATION_TYPES } from '../../src/domain/enums.js';
import { generateOwnerId, type OwnerContext, type OwnerId } from '../../src/domain/owner.js';
import { generateProblemId, type ProblemId } from '../../src/domain/problem.js';
import { generateRelationId } from '../../src/domain/relation.js';

const databaseUrl = readDatabaseUrl();

describe.skipIf(databaseUrl === undefined)('relations in the database', () => {
  let pool: DatabasePool;
  const ownersCreated: OwnerId[] = [];

  async function makeOwnerContext(): Promise<OwnerContext> {
    const ownerId = generateOwnerId();
    await insertOwnerIfAbsent(pool, ownerId);
    ownersCreated.push(ownerId);
    return { ownerId } as OwnerContext;
  }

  /** A problem to link, optionally in a project of its own. */
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

  /** Inserts straight into the table, past the append path. */
  function rawInsert(values: {
    ownerId: string;
    fromId: string;
    toId: string;
    relationType?: string;
    reason?: string;
  }) {
    return pool.query(
      `insert into public.relations
              (relation_id, owner_id, from_id, to_id, relation_type, reason)
            values ($1, $2, $3, $4, $5, $6)`,
      [
        generateRelationId(),
        values.ownerId,
        values.fromId,
        values.toId,
        values.relationType ?? 'SIMILAR_TO',
        values.reason ?? 'Fixture reason',
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
        'relations',
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
    it('holds only the columns a link needs', async () => {
      const result = await pool.query<{ column_name: string; is_nullable: string }>(
        `select column_name, is_nullable from information_schema.columns
          where table_schema = 'public' and table_name = 'relations'`,
      );

      const columns = result.rows.map((row) => row.column_name).sort();
      expect(columns).toEqual([
        'created_at',
        'from_id',
        'owner_id',
        'reason',
        'relation_id',
        'relation_type',
        'to_id',
      ]);

      // No update path, so nothing to record a change or to guard one.
      expect(columns).not.toContain('updated_at');
      expect(columns).not.toContain('version');
      // Not idempotent on a client key, and not a polymorphic graph.
      expect(columns).not.toContain('client_event_id');
      expect(columns).not.toContain('from_type');
      expect(columns).not.toContain('to_type');
      // A link is between problems; the project and environment are theirs.
      expect(columns).not.toContain('project_id');
      expect(columns).not.toContain('environment_id');

      expect(result.rows.every((row) => row.is_nullable === 'NO')).toBe(true);
    });

    it('has no trigger', async () => {
      const result = await pool.query<{ count: string }>(
        `select count(*)::text as count from information_schema.triggers
          where trigger_schema = 'public' and event_object_table = 'relations'`,
      );

      expect(result.rows[0]?.count).toBe('0');
    });

    it('issues no id of its own', async () => {
      const result = await pool.query<{ column_default: string | null }>(
        `select column_default from information_schema.columns
          where table_schema = 'public' and table_name = 'relations'
            and column_name = 'relation_id'`,
      );

      // The application supplies it, as for every other entity.
      expect(result.rows[0]?.column_default).toBeNull();
    });

    it('indexes both ends for the list query', async () => {
      const result = await pool.query<{ indexname: string }>(
        `select indexname from pg_indexes
          where schemaname = 'public' and tablename = 'relations'`,
      );

      const names = result.rows.map((row) => row.indexname).sort();
      // A problem's relations are read from either end, so neither side can
      // rely on the other's index.
      expect(names).toContain('relations_owner_from_created_idx');
      expect(names).toContain('relations_owner_to_created_idx');
    });

    it('restricts deleting a problem that is still linked', async () => {
      const context = await makeOwnerContext();
      const from = await makeProblem(context);
      const to = await makeProblem(context);
      await createRelation(pool, context, {
        fromId: from,
        toId: to,
        relationType: 'SIMILAR_TO',
        reason: 'Linked',
      });

      // Both ends, since both are foreign keys.
      await expect(
        pool.query('delete from public.problems where problem_id = $1', [from]),
      ).rejects.toThrow(/violates foreign key constraint/);
      await expect(
        pool.query('delete from public.problems where problem_id = $1', [to]),
      ).rejects.toThrow(/violates foreign key constraint/);
    });
  });

  describe('what the database refuses', () => {
    it('refuses a link from a problem to itself', async () => {
      const context = await makeOwnerContext();
      const problem = await makeProblem(context);

      // Straight past the append path: the rule holds for any writer.
      await expect(
        rawInsert({ ownerId: context.ownerId, fromId: problem, toId: problem }),
      ).rejects.toThrow(/relations_not_self/);
    });

    it.each([
      ['empty', ''],
      ['spaces', '   '],
      ['a tab', '\t'],
    ])('refuses a reason that is %s', async (_label, reason) => {
      const context = await makeOwnerContext();
      const from = await makeProblem(context);
      const to = await makeProblem(context);

      await expect(
        rawInsert({ ownerId: context.ownerId, fromId: from, toId: to, reason }),
      ).rejects.toThrow(/relations_reason_not_blank/);
    });

    it('refuses a relation type outside the shared value set', async () => {
      const context = await makeOwnerContext();
      const from = await makeProblem(context);
      const to = await makeProblem(context);

      // Unreachable through the append path — the type system rejects it — so
      // this probes the database's own defence directly.
      await expect(
        rawInsert({
          ownerId: context.ownerId,
          fromId: from,
          toId: to,
          relationType: 'DUPLICATE_OF',
        }),
      ).rejects.toThrow(/relation_type_allowed_values/);
    });

    it('refuses a source that is not this owner’s', async () => {
      const mine = await makeOwnerContext();
      const theirs = await makeOwnerContext();
      const theirProblem = await makeProblem(theirs);
      const myProblem = await makeProblem(mine);

      await expect(
        rawInsert({ ownerId: mine.ownerId, fromId: theirProblem, toId: myProblem }),
      ).rejects.toThrow(/relations_owner_id_from_id_fkey/);
    });

    it('refuses a target that is not this owner’s', async () => {
      const mine = await makeOwnerContext();
      const theirs = await makeOwnerContext();
      const myProblem = await makeProblem(mine);
      const theirProblem = await makeProblem(theirs);

      await expect(
        rawInsert({ ownerId: mine.ownerId, fromId: myProblem, toId: theirProblem }),
      ).rejects.toThrow(/relations_owner_id_to_id_fkey/);
    });

    it.each([
      ['source', 'from'],
      ['target', 'to'],
    ])('reports a missing %s the same way through the append path', async (_label, end) => {
      const context = await makeOwnerContext();
      const real = await makeProblem(context);
      const missing = generateProblemId();

      await expect(
        createRelation(pool, context, {
          fromId: end === 'from' ? missing : real,
          toId: end === 'from' ? real : missing,
          relationType: 'RELATED_TO',
          reason: 'Should not land',
        }),
      ).rejects.toThrow(ProblemNotAvailableError);
    });

    it('does not distinguish another owner’s problem from one that does not exist', async () => {
      const mine = await makeOwnerContext();
      const theirs = await makeOwnerContext();
      const myProblem = await makeProblem(mine);
      const theirProblem = await makeProblem(theirs);

      const crossOwner = createRelation(pool, mine, {
        fromId: myProblem,
        toId: theirProblem,
        relationType: 'SIMILAR_TO',
        reason: 'Should not land',
      });
      const missing = createRelation(pool, mine, {
        fromId: myProblem,
        toId: generateProblemId(),
        relationType: 'SIMILAR_TO',
        reason: 'Should not land',
      });

      // The same error either way, so the outcome cannot be used to learn
      // that someone else's problem id is real.
      await expect(crossOwner).rejects.toThrow(ProblemNotAvailableError);
      await expect(missing).rejects.toThrow(ProblemNotAvailableError);
    });
  });

  describe('creating and listing', () => {
    it.each(RELATION_TYPES)('stores a %s link', async (relationType) => {
      const context = await makeOwnerContext();
      const from = await makeProblem(context);
      const to = await makeProblem(context);

      const relation = await createRelation(pool, context, {
        fromId: from,
        toId: to,
        relationType,
        reason: '  Because of this.  ',
      });

      expect(relation).toMatchObject({
        ownerId: context.ownerId,
        fromId: from,
        toId: to,
        relationType,
        reason: 'Because of this.',
      });
      expect(relation.createdAt).toBeInstanceOf(Date);
    });

    it('links problems in different projects', async () => {
      const context = await makeOwnerContext();
      const from = await makeProblem(context, 'checkout-web');
      const to = await makeProblem(context, 'admin-console');

      const relation = await createRelation(pool, context, {
        fromId: from,
        toId: to,
        relationType: 'SIMILAR_TO',
        reason: 'Same session handling, different project.',
      });

      // The point of a relation: experience from one investigation reaching
      // another. Confining links to one project would rule that out.
      expect(relation.fromId).toBe(from);
      expect(relation.toId).toBe(to);
    });

    it('is found from both ends, stored once', async () => {
      const context = await makeOwnerContext();
      const from = await makeProblem(context);
      const to = await makeProblem(context);

      const relation = await createRelation(pool, context, {
        fromId: from,
        toId: to,
        relationType: 'SIMILAR_TO',
        reason: 'Same symptoms.',
      });

      const fromSide = await listRelations(pool, context, from);
      const toSide = await listRelations(pool, context, to);

      expect(fromSide).toEqual([relation]);
      expect(toSide).toEqual([relation]);
      // One row, not a mirrored pair. Two rows would have to be kept in step
      // by something, and nothing would keep them in step.
      const count = await pool.query<{ count: string }>(
        'select count(*)::text as count from public.relations where owner_id = $1',
        [context.ownerId],
      );
      expect(count.rows[0]?.count).toBe('1');
    });

    it('reports rows as stored, not reversed to suit the reader', async () => {
      const context = await makeOwnerContext();
      const from = await makeProblem(context);
      const to = await makeProblem(context);

      await createRelation(pool, context, {
        fromId: from,
        toId: to,
        relationType: 'SUPERSEDES',
        reason: 'The later conclusion replaced the earlier one.',
      });

      const [seenFromTarget] = await listRelations(pool, context, to);

      // Flipping it would say the target supersedes the source, which is the
      // opposite of what was recorded.
      expect(seenFromTarget).toMatchObject({ fromId: from, toId: to, relationType: 'SUPERSEDES' });
    });

    it('lists oldest first', async () => {
      const context = await makeOwnerContext();
      const hub = await makeProblem(context);
      const reasons = ['first', 'second', 'third'];

      for (const reason of reasons) {
        await createRelation(pool, context, {
          fromId: hub,
          toId: await makeProblem(context),
          relationType: 'RELATED_TO',
          reason,
        });
      }

      expect((await listRelations(pool, context, hub)).map((r) => r.reason)).toEqual(reasons);
    });

    it('orders deterministically when relations share a timestamp', async () => {
      const context = await makeOwnerContext();
      const hub = await makeProblem(context);
      const shared = '2026-01-01T00:00:00Z';
      const ids: string[] = [];

      for (let index = 0; index < 3; index += 1) {
        const relationId = generateRelationId();
        ids.push(relationId);
        await pool.query(
          `insert into public.relations
                  (relation_id, owner_id, from_id, to_id, relation_type, reason, created_at)
                values ($1, $2, $3, $4, 'RELATED_TO', $5, $6)`,
          [
            relationId,
            context.ownerId,
            hub,
            await makeProblem(context),
            `tie-${relationId}`,
            shared,
          ],
        );
      }

      const first = (await listRelations(pool, context, hub)).map((r) => r.relationId);
      const second = (await listRelations(pool, context, hub)).map((r) => r.relationId);

      expect(first).toEqual([...ids].sort());
      expect(second).toEqual(first);
    });

    it('returns an empty list for a problem with no links', async () => {
      const context = await makeOwnerContext();

      expect(await listRelations(pool, context, await makeProblem(context))).toEqual([]);
    });

    it('shows one owner nothing of another’s links', async () => {
      const mine = await makeOwnerContext();
      const theirs = await makeOwnerContext();
      const theirFrom = await makeProblem(theirs);
      const theirTo = await makeProblem(theirs);
      await createRelation(pool, theirs, {
        fromId: theirFrom,
        toId: theirTo,
        relationType: 'SIMILAR_TO',
        reason: 'Theirs',
      });

      // Reading with the other owner's context, by their problem id.
      expect(await listRelations(pool, mine, theirFrom)).toEqual([]);
      expect(await listRelations(pool, mine, generateProblemId())).toEqual([]);
    });
  });
});
