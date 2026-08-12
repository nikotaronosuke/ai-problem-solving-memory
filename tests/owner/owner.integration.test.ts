/**
 * Owner boundary against the real database.
 *
 * Owners are created with freshly generated ids and removed afterwards, so the
 * suite never depends on — or disturbs — the developer's own owner row.
 *
 * Skipped when `DATABASE_URL` is not set.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readDatabaseUrl } from '../../src/config/env.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { getOwnerForContext, insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import { generateOwnerId, type OwnerId } from '../../src/domain/owner.js';
import { MEMORY_OWNER_ID_VAR, resolveOwnerContext } from '../../src/owner/context.js';

const databaseUrl = readDatabaseUrl();

describe.skipIf(databaseUrl === undefined)('owner boundary', () => {
  let pool: DatabasePool;
  const created: OwnerId[] = [];

  /** Creates an owner and registers it for cleanup. */
  async function makeOwner(): Promise<OwnerId> {
    const ownerId = generateOwnerId();
    await insertOwnerIfAbsent(pool, ownerId);
    created.push(ownerId);
    return ownerId;
  }

  beforeAll(() => {
    pool = createPool(resolveDatabaseConfig({ nodeEnv: 'test', connectionTimeoutMillis: 5_000 }));
  });

  afterAll(async () => {
    if (created.length > 0) {
      await pool.query('delete from public.owners where owner_id = any($1::uuid[])', [created]);
    }
    await closePool(pool);
  });

  describe('owners table', () => {
    it('stores owner_id as a uuid with no database-side default', async () => {
      const result = await pool.query<{
        column_name: string;
        data_type: string;
        column_default: string | null;
        is_nullable: string;
      }>(
        `select column_name, data_type, column_default, is_nullable
           from information_schema.columns
          where table_schema = 'public' and table_name = 'owners'
          order by ordinal_position`,
      );

      expect(result.rows).toEqual([
        {
          column_name: 'owner_id',
          data_type: 'uuid',
          // Ownership is supplied by the application, never invented on insert.
          column_default: null,
          is_nullable: 'NO',
        },
        {
          column_name: 'created_at',
          data_type: 'timestamp with time zone',
          column_default: 'now()',
          is_nullable: 'NO',
        },
      ]);
    });

    it('holds no provider, email or role column', async () => {
      const result = await pool.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'owners'`,
      );

      expect(result.rows.map((row) => row.column_name).sort()).toEqual(['created_at', 'owner_id']);
    });
  });

  describe('bootstrap', () => {
    it('creates an owner that was absent', async () => {
      const ownerId = generateOwnerId();
      created.push(ownerId);

      const result = await insertOwnerIfAbsent(pool, ownerId);

      expect(result.created).toBe(true);
      expect(result.owner.ownerId).toBe(ownerId);
    });

    it('is idempotent, leaving the existing row untouched', async () => {
      const ownerId = await makeOwner();
      const first = await insertOwnerIfAbsent(pool, ownerId);
      const second = await insertOwnerIfAbsent(pool, ownerId);

      expect(first.created).toBe(false);
      expect(second.created).toBe(false);
      expect(second.owner.createdAt.getTime()).toBe(first.owner.createdAt.getTime());

      const count = await pool.query<{ count: string }>(
        'select count(*)::text as count from public.owners where owner_id = $1',
        [ownerId],
      );
      expect(count.rows[0]?.count).toBe('1');
    });

    it('does not disturb other owners', async () => {
      const other = await makeOwner();
      const before = await pool.query<{ created_at: Date }>(
        'select created_at from public.owners where owner_id = $1',
        [other],
      );

      await insertOwnerIfAbsent(pool, await makeOwner());

      const after = await pool.query<{ created_at: Date }>(
        'select created_at from public.owners where owner_id = $1',
        [other],
      );

      expect(after.rows).toHaveLength(1);
      expect(after.rows[0]?.created_at.getTime()).toBe(before.rows[0]?.created_at.getTime());
    });
  });

  describe('resolving an owner context', () => {
    it('resolves an owner that exists', async () => {
      const ownerId = await makeOwner();

      const context = await resolveOwnerContext(pool, { [MEMORY_OWNER_ID_VAR]: ownerId });

      expect(context.ownerId).toBe(ownerId);
    });

    it('accepts a differently cased value for the same owner', async () => {
      const ownerId = await makeOwner();

      const context = await resolveOwnerContext(pool, {
        [MEMORY_OWNER_ID_VAR]: ownerId.toUpperCase(),
      });

      expect(context.ownerId).toBe(ownerId);
    });

    it('fails closed for a well-formed owner that does not exist', async () => {
      const absent = generateOwnerId();

      await expect(
        resolveOwnerContext(pool, { [MEMORY_OWNER_ID_VAR]: absent }),
      ).rejects.toMatchObject({ reason: 'UNKNOWN' });
    });
  });

  describe('isolation between owners', () => {
    it('returns each owner its own record and never the other', async () => {
      const ownerA = await makeOwner();
      const ownerB = await makeOwner();

      const contextA = await resolveOwnerContext(pool, { [MEMORY_OWNER_ID_VAR]: ownerA });
      const contextB = await resolveOwnerContext(pool, { [MEMORY_OWNER_ID_VAR]: ownerB });

      const seenByA = await getOwnerForContext(pool, contextA);
      const seenByB = await getOwnerForContext(pool, contextB);

      expect(seenByA?.ownerId).toBe(ownerA);
      expect(seenByA?.ownerId).not.toBe(ownerB);
      expect(seenByB?.ownerId).toBe(ownerB);
      expect(seenByB?.ownerId).not.toBe(ownerA);
    });

    it('reads only through the context, even though both rows exist', async () => {
      const ownerA = await makeOwner();
      const ownerB = await makeOwner();

      // Both rows are really there — isolation is the read path, not absence.
      const both = await pool.query<{ owner_id: string }>(
        'select owner_id from public.owners where owner_id = any($1::uuid[])',
        [[ownerA, ownerB]],
      );
      expect(both.rows).toHaveLength(2);

      const contextA = await resolveOwnerContext(pool, { [MEMORY_OWNER_ID_VAR]: ownerA });
      const seenByA = await getOwnerForContext(pool, contextA);

      // The context supplies the id, so there is no argument that could ask
      // for owner B through this path.
      expect(seenByA?.ownerId).toBe(ownerA);
    });
  });
});
