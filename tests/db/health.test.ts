import { describe, expect, it } from 'vitest';

import {
  checkDatabaseConnection,
  classifyDatabaseFailure,
  DATABASE_HEALTH_REASONS,
} from '../../src/db/health.js';
import type { DatabasePool } from '../../src/db/pool.js';

type ProbeResult = { rows: { ok: number }[] };

/** Minimal stand-in for a pool, so health can be tested without a database. */
function stubPool(query: () => Promise<ProbeResult>): DatabasePool {
  return { query } as unknown as DatabasePool;
}

/** An error shaped the way `pg` and Node shape theirs: a `code`, and a message. */
function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('checkDatabaseConnection', () => {
  it('reports a reachable database', async () => {
    const health = await checkDatabaseConnection(
      stubPool(() => Promise.resolve({ rows: [{ ok: 1 }] })),
    );

    expect(health.reachable).toBe(true);
    expect(health.reason).toBeUndefined();
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('reports failure instead of throwing, so Memory trouble cannot stop the caller', async () => {
    const health = await checkDatabaseConnection(
      stubPool(() => Promise.reject(coded('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:54322'))),
    );

    expect(health.reachable).toBe(false);
    expect(health.reason).toBe('CONNECTION_FAILED');
  });

  it('treats an unexpected probe result as unreachable', async () => {
    const health = await checkDatabaseConnection(stubPool(() => Promise.resolve({ rows: [] })));

    expect(health.reachable).toBe(false);
    expect(health.reason).toBe('UNEXPECTED_PROBE_RESULT');
  });

  it('keeps the driver’s words out of what it reports', async () => {
    // The three messages measured in P3-10, verbatim. Each names something
    // about the deployment: a port, a host, an account.
    const messages = [
      'connect ECONNREFUSED 127.0.0.1:54322',
      'getaddrinfo ENOTFOUND memory-db.internal.example',
      'password authentication failed for user "memory_service"',
    ];

    for (const message of messages) {
      const health = await checkDatabaseConnection(
        stubPool(() => Promise.reject(coded('ECONNREFUSED', message))),
      );

      // Whatever the health report holds, it is one of four identifiers and
      // nothing else — there is no field a message could be in.
      expect(Object.keys(health).sort()).toEqual(['latencyMs', 'reachable', 'reason']);
      expect(DATABASE_HEALTH_REASONS).toContain(health.reason);
      expect(JSON.stringify(health)).not.toContain('ECONNREFUSED 127');
      expect(JSON.stringify(health)).not.toContain('memory-db.internal.example');
      expect(JSON.stringify(health)).not.toContain('memory_service');
    }
  });
});

describe('classifyDatabaseFailure', () => {
  it.each([
    ['28P01', 'AUTHENTICATION_FAILED'],
    ['28000', 'AUTHENTICATION_FAILED'],
  ])('reads SQLSTATE %s as %s', (code, reason) => {
    expect(classifyDatabaseFailure(coded(code, 'password authentication failed'))).toBe(reason);
  });

  it.each([
    'ECONNREFUSED',
    'ECONNRESET',
    'ENOTFOUND',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'EAI_AGAIN',
  ])('reads %s as nothing having answered', (code) => {
    expect(classifyDatabaseFailure(coded(code, 'irrelevant'))).toBe('CONNECTION_FAILED');
  });

  it('refuses to guess from a message', () => {
    // `pg`'s own connection timeout arrives with no code at all. Reading its
    // wording is the one thing this classifier must not learn to do, because a
    // classifier that reads messages is one refactor from logging them.
    expect(classifyDatabaseFailure(new Error('timeout exceeded when trying to connect'))).toBe(
      'UNKNOWN',
    );
    expect(classifyDatabaseFailure(coded('42703', 'column "x" does not exist'))).toBe('UNKNOWN');
    expect(classifyDatabaseFailure('not an error at all')).toBe('UNKNOWN');
    expect(classifyDatabaseFailure(undefined)).toBe('UNKNOWN');
  });

  it('answers only from the closed set', () => {
    const candidates: unknown[] = [
      coded('28P01', 'x'),
      coded('ECONNREFUSED', 'x'),
      coded('42703', 'x'),
      new Error('x'),
      null,
      { code: 12 },
    ];

    for (const candidate of candidates) {
      expect(DATABASE_HEALTH_REASONS).toContain(classifyDatabaseFailure(candidate));
    }
  });
});
