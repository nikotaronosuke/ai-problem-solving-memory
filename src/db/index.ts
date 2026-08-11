/**
 * Database access boundary.
 *
 * Importing this module opens no connection.
 *
 * The repository layer that Phase 2 builds on top belongs behind this boundary
 * (P1-12), so that PostgreSQL and Supabase specifics do not spread through the
 * rest of the service.
 */

export {
  isLocalHostname,
  resolveDatabaseConfig,
  UnsafeDatabaseTargetError,
  type DatabaseConfig,
  type DatabaseConfigInput,
} from './config.js';
export { closePool, createPool, type DatabasePool } from './pool.js';
export { checkDatabaseConnection, type DatabaseHealth } from './health.js';
