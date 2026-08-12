/**
 * Whether the service can do its job right now.
 *
 * Transport asks this; it does not ask the database. The distinction matters
 * because what a client is allowed to learn from a health check is a product
 * decision, not a driver detail — the reason a probe failed stays here, in the
 * log, and never reaches the response.
 */

import { checkDatabaseConnection } from '../db/health.js';
import type { DatabasePool } from '../db/pool.js';

export type HealthStatus = 'ok' | 'unavailable';

export interface HealthReport {
  readonly status: HealthStatus;
  /**
   * Why the check failed, for the server's own log.
   *
   * Never returned to a client: a probe failure can carry a host name or a
   * driver message, and neither is a client's business.
   */
  readonly detail?: string;
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
        return { status: 'ok' };
      }

      return { status: 'unavailable', detail: health.error ?? 'database unreachable' };
    },
  };
}
