/**
 * Executable entrypoint: verify the service can reach PostgreSQL.
 *
 * Run with `npm run db:check`. This file is a script, not library code — it is
 * the only module here that connects on execution, and nothing imports it.
 *
 * It prints the host and round-trip time. It never prints the connection
 * string, which holds credentials.
 */

import { loadEnv } from '../config/env.js';
import { resolveDatabaseConfig } from './config.js';
import { checkDatabaseConnection } from './health.js';
import { closePool, createPool } from './pool.js';

const env = loadEnv();
const config = resolveDatabaseConfig({ nodeEnv: env.nodeEnv });
const pool = createPool(config);

try {
  const health = await checkDatabaseConnection(pool);

  if (health.reachable) {
    console.log(`database reachable | host=${config.host} | ${health.latencyMs}ms`);
  } else {
    console.error(`database unreachable | host=${config.host} | ${health.error ?? 'unknown'}`);
    process.exitCode = 1;
  }
} finally {
  await closePool(pool);
}
