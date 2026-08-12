/**
 * Database access for owners.
 *
 * Two paths, deliberately separate:
 *
 * - The normal read path, `getOwnerForContext`, takes an established
 *   `OwnerContext` and can only ever return that owner. There is no
 *   application API that takes an arbitrary owner id and returns its row, so
 *   reading across the ownership boundary is not something callers can express.
 * - The bootstrap path, `insertOwnerIfAbsent`, exists to create a local
 *   development owner. It only ever inserts, never updates or deletes.
 *
 * `findOwnerRecord` sits between them: it takes a bare id because owner
 * resolution has to check existence before a context exists. It is not part of
 * the public database boundary (`src/db/index.ts`) for that reason.
 */

import type { OwnerContext, OwnerId } from '../domain/owner.js';
import type { DatabasePool } from './pool.js';

export interface OwnerRecord {
  readonly ownerId: OwnerId;
  readonly createdAt: Date;
}

interface OwnerRow {
  owner_id: string;
  created_at: Date;
}

function toRecord(row: OwnerRow): OwnerRecord {
  // The database column is `uuid`, so the value is already a normalised UUID.
  return { ownerId: row.owner_id as OwnerId, createdAt: row.created_at };
}

/**
 * Looks up an owner by id.
 *
 * Used by owner resolution, which by definition runs before a context exists.
 * Application code should use `getOwnerForContext` instead.
 */
export async function findOwnerRecord(
  pool: DatabasePool,
  ownerId: OwnerId,
): Promise<OwnerRecord | undefined> {
  const result = await pool.query<OwnerRow>(
    'select owner_id, created_at from public.owners where owner_id = $1',
    [ownerId],
  );

  const row = result.rows[0];
  return row === undefined ? undefined : toRecord(row);
}

/**
 * Reads the owner the context belongs to.
 *
 * The context supplies the id, so this cannot be pointed at another owner.
 */
export async function getOwnerForContext(
  pool: DatabasePool,
  context: OwnerContext,
): Promise<OwnerRecord | undefined> {
  return findOwnerRecord(pool, context.ownerId);
}

export interface OwnerInsertResult {
  readonly owner: OwnerRecord;
  /** False when the owner already existed and was left untouched. */
  readonly created: boolean;
}

/**
 * Creates an owner if it does not already exist.
 *
 * Idempotent: running it again with the same id leaves the existing row
 * exactly as it was, including `created_at`. It never touches other rows.
 */
export async function insertOwnerIfAbsent(
  pool: DatabasePool,
  ownerId: OwnerId,
): Promise<OwnerInsertResult> {
  const inserted = await pool.query<OwnerRow>(
    `insert into public.owners (owner_id)
          values ($1)
     on conflict (owner_id) do nothing
       returning owner_id, created_at`,
    [ownerId],
  );

  const insertedRow = inserted.rows[0];
  if (insertedRow !== undefined) {
    return { owner: toRecord(insertedRow), created: true };
  }

  const existing = await findOwnerRecord(pool, ownerId);
  if (existing === undefined) {
    // Only reachable if the row disappeared between the two statements.
    throw new Error('Owner could not be created or found.');
  }

  return { owner: existing, created: false };
}
