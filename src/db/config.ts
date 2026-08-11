/**
 * Turns environment values into a validated database configuration.
 *
 * Kept separate from pool creation so that configuration can be inspected and
 * tested without opening a connection.
 */

import type { PoolConfig } from 'pg';

import { requireDatabaseUrl, type EnvSource, type NodeEnv } from '../config/env.js';

/** Hostnames treated as a developer's own machine. */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Raised when the configured target is not allowed for the current
 * environment — the guard against a test run reaching a real database.
 */
export class UnsafeDatabaseTargetError extends Error {
  readonly host: string;

  constructor(host: string) {
    super(
      `Refusing to connect to non-local database host ${JSON.stringify(host)} while ` +
        `NODE_ENV=test. Tests must run against a local database.`,
    );
    this.name = 'UnsafeDatabaseTargetError';
    this.host = host;
  }
}

export interface DatabaseConfigInput {
  readonly nodeEnv: NodeEnv;
  /** Defaults to `process.env`. */
  readonly source?: EnvSource;
  /** Maximum pooled connections. Defaults to 10. */
  readonly maxConnections?: number;
  /** Milliseconds an idle client is kept before being released. Defaults to 30s. */
  readonly idleTimeoutMillis?: number;
  /** Milliseconds to wait for a connection before failing. Defaults to 10s. */
  readonly connectionTimeoutMillis?: number;
}

export interface DatabaseConfig {
  /** Passed to `pg`. Holds credentials — never log or serialise this object. */
  readonly poolConfig: PoolConfig;
  /** Host being targeted. Safe to log; carries no credentials. */
  readonly host: string;
  /** Whether the target is the developer's own machine. */
  readonly isLocal: boolean;
}

export function isLocalHostname(hostname: string): boolean {
  return LOCAL_HOSTNAMES.has(hostname.toLowerCase());
}

/**
 * Builds the pool configuration from the environment.
 *
 * Throws if `DATABASE_URL` is missing or malformed, and — when `NODE_ENV` is
 * `test` — if it points anywhere other than the local machine.
 */
export function resolveDatabaseConfig(input: DatabaseConfigInput): DatabaseConfig {
  const connectionString = requireDatabaseUrl(input.source);
  const host = new URL(connectionString).hostname;
  const isLocal = isLocalHostname(host);

  if (input.nodeEnv === 'test' && !isLocal) {
    throw new UnsafeDatabaseTargetError(host);
  }

  return {
    poolConfig: {
      connectionString,
      max: input.maxConnections ?? 10,
      idleTimeoutMillis: input.idleTimeoutMillis ?? 30_000,
      connectionTimeoutMillis: input.connectionTimeoutMillis ?? 10_000,
    },
    host,
    isLocal,
  };
}
