/**
 * Database reachability check.
 *
 * Separate from pool creation: creating a pool is a configuration concern,
 * while checking reachability is an observation about the running system.
 *
 * What a failed probe reports is a reason this codebase chose, never the
 * driver's own words. That changed in P3-10 after the previous form was
 * measured: `error.message` carried `connect ECONNREFUSED 127.0.0.1:54322`,
 * `getaddrinfo ENOTFOUND <database host>` and
 * `password authentication failed for user "postgres"` — a host, a port and an
 * account name, on their way to an operational log. The old comment here said
 * the message describes the failure "without echoing the connection string",
 * which was true and beside the point: everything in a connection string
 * except the password was being echoed anyway.
 */

import type { DatabasePool } from './pool.js';

/**
 * Why a probe failed, for the server's own record.
 *
 * A closed set. Four answers is what an operator can act on — the database is
 * not answering, it is answering and refusing this account, it answered
 * something impossible, or this codebase does not recognise what happened.
 */
export const DATABASE_HEALTH_REASONS = [
  /** Nothing answered: refused, unreachable, unresolvable, or timed out. */
  'CONNECTION_FAILED',
  /** Something answered and would not accept the credentials. */
  'AUTHENTICATION_FAILED',
  /** The probe ran and returned something it should not have. */
  'UNEXPECTED_PROBE_RESULT',
  /** Recognised as a failure and as nothing more specific. */
  'UNKNOWN',
] as const;

export type DatabaseHealthReason = (typeof DATABASE_HEALTH_REASONS)[number];

export interface DatabaseHealth {
  readonly reachable: boolean;
  /** Round-trip time of the probe query, in milliseconds. */
  readonly latencyMs: number;
  /**
   * Why the probe failed. Absent when it did not.
   *
   * One of a closed set, so that whatever reads this — a log line, a CLI, a
   * future status page — cannot pass a driver's prose along by accident.
   */
  readonly reason?: DatabaseHealthReason;
}

/**
 * PostgreSQL `SQLSTATE` class 28 — invalid authorization specification.
 *
 * The class, not the individual codes: `28000` and `28P01` are the two that
 * exist today and both mean the same thing to an operator.
 */
const AUTHENTICATION_SQLSTATE_CLASS = '28';

/**
 * Node's names for "nothing answered".
 *
 * Codes rather than message text. Parsing a message would make this depend on
 * wording that belongs to libuv and to whichever locale it was built for, and
 * a classifier that reads messages is one refactor away from logging them.
 */
const CONNECTION_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'EPIPE',
  'EAI_AGAIN',
  'EADDRNOTAVAIL',
  'ERR_SOCKET_CONNECTION_TIMEOUT',
]);

/**
 * Reads an error's `code` without trusting that it has one.
 *
 * `pg` and Node both put a string there; anything else thrown might not.
 */
function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Which of the four answers a thrown probe failure is.
 *
 * Deliberately falls to `UNKNOWN` rather than guessing. `pg`'s own connection
 * timeout, for one, arrives as a plain `Error` with no code at all — calling
 * that `CONNECTION_FAILED` on the strength of its wording would be exactly the
 * message parsing this is here to avoid.
 */
export function classifyDatabaseFailure(error: unknown): DatabaseHealthReason {
  const code = codeOf(error);
  if (code === undefined) {
    return 'UNKNOWN';
  }

  if (code.startsWith(AUTHENTICATION_SQLSTATE_CLASS) && code.length === 5) {
    return 'AUTHENTICATION_FAILED';
  }

  return CONNECTION_ERROR_CODES.has(code) ? 'CONNECTION_FAILED' : 'UNKNOWN';
}

/**
 * Runs a trivial query to confirm the database answers.
 *
 * Never throws: an unreachable database is a reportable state, not an
 * exception, because Memory failure must not stop the caller's real work.
 */
export async function checkDatabaseConnection(pool: DatabasePool): Promise<DatabaseHealth> {
  const startedAt = performance.now();

  try {
    const result = await pool.query<{ ok: number }>('select 1 as ok');
    const latencyMs = Math.round(performance.now() - startedAt);

    if (result.rows[0]?.ok !== 1) {
      return { reachable: false, latencyMs, reason: 'UNEXPECTED_PROBE_RESULT' };
    }

    return { reachable: true, latencyMs };
  } catch (error) {
    return {
      reachable: false,
      latencyMs: Math.round(performance.now() - startedAt),
      reason: classifyDatabaseFailure(error),
    };
  }
}
