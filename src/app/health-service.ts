/**
 * Whether the service can do its job right now.
 *
 * Transport asks this; it does not ask the database. The distinction matters
 * because what a client is allowed to learn from a health check is a product
 * decision, not a driver detail — and since P3-10 the same is true of what an
 * operator is allowed to learn. The reason a probe failed reaches the log as
 * one of a closed set of identifiers; the driver's own words reach nothing.
 */

import { checkDatabaseConnection, type DatabaseHealthReason } from '../db/health.js';
import type { DatabasePool } from '../db/pool.js';

export type HealthStatus = 'ok' | 'unavailable';

export interface HealthReport {
  readonly status: HealthStatus;
  /**
   * Round-trip time of the probe, in milliseconds.
   *
   * Always known — a failed probe is still a probe that took a measurable
   * amount of time, and how long a failure took to arrive is often the first
   * useful thing about it. Server-produced, so it is safe to log.
   */
  readonly latencyMs: number;
  /**
   * Why the check failed, for the server's own log. Absent when it did not.
   *
   * This used to be a free-text `detail` taken from the driver's message. It
   * was measured carrying a database host, a port and an account name, so it
   * is now one of a closed set. Never returned to a client either way.
   */
  readonly reason?: DatabaseHealthReason;
}

export interface HealthService {
  check(): Promise<HealthReport>;
}

/** Reports healthy only when the database actually answers. */
export function createHealthService(pool: DatabasePool): HealthService {
  return {
    async check(): Promise<HealthReport> {
      const health = await checkDatabaseConnection(pool);

      if (health.reachable) {
        return { status: 'ok', latencyMs: health.latencyMs };
      }

      // `UNKNOWN` rather than a default that reads like a diagnosis: the probe
      // reports what it recognised, and this layer does not improve on it.
      return {
        status: 'unavailable',
        latencyMs: health.latencyMs,
        reason: health.reason ?? 'UNKNOWN',
      };
    },
  };
}
