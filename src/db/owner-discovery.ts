/**
 * Finding whose Memories the maintenance loop should look at.
 *
 * The one read in this codebase that crosses owners, and it is built to be
 * safe to cross with: it returns owner identifiers and nothing else. No
 * Problem ids, no titles, no content, no artifact material — a maintenance
 * sweep learns *who* might need work, then resolves each owner's context
 * through the same `resolveOwnerContextFor` gate as everything else and does
 * every actual read owner-scoped. A global reader that returned Memory
 * content would be a second, unguarded path to every owner's records, which
 * is exactly the thing the owner-context discipline exists to make
 * unwriteable.
 *
 * Only owners with at least one read-enabled Problem appear: reconciliation
 * refuses read-disabled Problems anyway, so an owner with none would be a
 * context resolution and a scan for a guaranteed-empty answer.
 *
 * Internal to the runtime, deliberately. Not on the repository, not on the
 * HTTP surface, not in the client — an architecture guard reads that this
 * stays true.
 */

import type { OwnerId } from '../domain/owner.js';
import type { DatabaseExecutor } from './executor.js';

export const OWNER_DISCOVERY_STATEMENT = `
  select distinct owner_id
    from public.problems
   where memory_read_enabled
   order by owner_id asc`;

/** Every owner who currently has at least one read-enabled Problem. */
export async function listOwnerIdsWithReadableProblems(
  executor: DatabaseExecutor,
): Promise<OwnerId[]> {
  const result = await executor.query<{ owner_id: string }>(OWNER_DISCOVERY_STATEMENT, []);
  return result.rows.map((row) => row.owner_id as OwnerId);
}
