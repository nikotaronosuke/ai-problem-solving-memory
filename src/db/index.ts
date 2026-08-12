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
export {
  ENUM_DOMAIN_BINDINGS,
  ENUM_DOMAIN_SCHEMA,
  type EnumDomainBinding,
} from './enum-domains.js';

// `findOwnerRecord` is intentionally not re-exported. Application code reads
// its own owner through the context; only owner resolution looks up a bare id.
export {
  getOwnerForContext,
  insertOwnerIfAbsent,
  type OwnerInsertResult,
  type OwnerRecord,
} from './owners.js';
