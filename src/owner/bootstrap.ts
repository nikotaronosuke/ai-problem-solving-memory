/**
 * Executable entrypoint: create the local development owner.
 *
 * Run with `npm run owner:bootstrap`. Safe to run repeatedly — it creates the
 * owner named by `MEMORY_OWNER_ID` if it is absent and otherwise leaves it
 * alone. It never updates or removes an owner, and it creates no credential.
 *
 * This is a local development convenience, not an account system.
 */

import { loadEnv } from '../config/env.js';
import { resolveDatabaseConfig } from '../db/config.js';
import { insertOwnerIfAbsent } from '../db/owners.js';
import { closePool, createPool } from '../db/pool.js';
import { toOwnerId } from '../domain/owner.js';
import { MEMORY_OWNER_ID_VAR, readOwnerIdFromEnv } from './context.js';

const configured = readOwnerIdFromEnv();
if (configured === undefined) {
  console.error(
    `${MEMORY_OWNER_ID_VAR} is not set. Copy .env.example to .env and set it to a UUID.`,
  );
  process.exit(1);
}

const ownerId = toOwnerId(configured);
const env = loadEnv();
const pool = createPool(resolveDatabaseConfig({ nodeEnv: env.nodeEnv }));

try {
  const result = await insertOwnerIfAbsent(pool, ownerId);

  console.log(
    result.created
      ? `owner created | ${result.owner.ownerId}`
      : `owner already present | ${result.owner.ownerId}`,
  );
} finally {
  await closePool(pool);
}
