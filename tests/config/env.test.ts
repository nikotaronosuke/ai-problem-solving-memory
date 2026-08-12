import { describe, expect, it } from 'vitest';

import {
  EnvValidationError,
  InvalidConnectionStringError,
  MissingEnvError,
  loadEnv,
  readDatabaseUrl,
  requireDatabaseUrl,
} from '../../src/config/env.js';

/** Stand-in credential. Used to assert it never reaches an error message. */
const FAKE_PASSWORD = 'not-a-real-password-9f3a';

describe('loadEnv', () => {
  it('applies defaults when nothing is set', () => {
    expect(loadEnv({})).toEqual({
      nodeEnv: 'development',
      logLevel: 'info',
      // Loopback, so an unconfigured server is not reachable from the network.
      host: '127.0.0.1',
      port: 3000,
    });
  });

  it('reads supported values', () => {
    expect(
      loadEnv({ NODE_ENV: 'test', LOG_LEVEL: 'debug', HOST: '0.0.0.0', PORT: '8080' }),
    ).toEqual({
      nodeEnv: 'test',
      logLevel: 'debug',
      host: '0.0.0.0',
      port: 8080,
    });
  });

  it('normalises surrounding whitespace and casing', () => {
    expect(
      loadEnv({ NODE_ENV: ' Production ', LOG_LEVEL: 'WARN', HOST: ' ::1 ', PORT: ' 443 ' }),
    ).toEqual({
      nodeEnv: 'production',
      logLevel: 'warn',
      host: '::1',
      port: 443,
    });
  });

  it('treats an empty or blank value as unset', () => {
    expect(loadEnv({ NODE_ENV: '' }).nodeEnv).toBe('development');
    expect(loadEnv({ NODE_ENV: '   ' }).nodeEnv).toBe('development');
  });

  it('rejects an unsupported value instead of coercing it', () => {
    expect(() => loadEnv({ NODE_ENV: 'staging' })).toThrow(EnvValidationError);
    expect(() => loadEnv({ LOG_LEVEL: 'verbose' })).toThrow(/Allowed values/);
  });

  it('defaults the port but refuses a blank host', () => {
    expect(loadEnv({ PORT: '' }).port).toBe(3000);
    expect(loadEnv({ PORT: '   ' }).port).toBe(3000);
    // A blank HOST is far more likely to be a broken deployment script than a
    // request for loopback, so it fails rather than guessing.
    expect(() => loadEnv({ HOST: '' })).toThrow(EnvValidationError);
    expect(() => loadEnv({ HOST: '   ' })).toThrow(EnvValidationError);
  });

  it.each([
    ['zero', '0'],
    ['above the maximum', '65536'],
    ['negative', '-1'],
    ['fractional', '3000.5'],
    ['hexadecimal', '0x0bb8'],
    ['exponent notation', '3e3'],
    ['not a number', 'http'],
    ['a port with a suffix', '3000a'],
  ])('rejects a port that is %s', (_label, value) => {
    // Number() would happily accept several of these, which is exactly why
    // the check is a digit pattern rather than a numeric coercion.
    expect(() => loadEnv({ PORT: value })).toThrow(EnvValidationError);
  });

  it('accepts the edges of the valid port range', () => {
    expect(loadEnv({ PORT: '1' }).port).toBe(1);
    expect(loadEnv({ PORT: '65535' }).port).toBe(65_535);
  });

  it('does not require DATABASE_URL', () => {
    expect(() => loadEnv({})).not.toThrow();
    expect(loadEnv({})).not.toHaveProperty('databaseUrl');
  });
});

describe('readDatabaseUrl', () => {
  it('returns undefined when unset or blank, rather than throwing', () => {
    expect(readDatabaseUrl({})).toBeUndefined();
    expect(readDatabaseUrl({ DATABASE_URL: '' })).toBeUndefined();
    expect(readDatabaseUrl({ DATABASE_URL: '  ' })).toBeUndefined();
  });

  it('returns the trimmed value when set', () => {
    expect(readDatabaseUrl({ DATABASE_URL: ' postgresql://u:p@localhost:5432/db ' })).toBe(
      'postgresql://u:p@localhost:5432/db',
    );
  });
});

describe('requireDatabaseUrl', () => {
  it('accepts both PostgreSQL schemes', () => {
    const postgres = `postgres://user:${FAKE_PASSWORD}@localhost:5432/db`;
    const postgresql = `postgresql://user:${FAKE_PASSWORD}@localhost:5432/db`;

    expect(requireDatabaseUrl({ DATABASE_URL: postgres })).toBe(postgres);
    expect(requireDatabaseUrl({ DATABASE_URL: postgresql })).toBe(postgresql);
  });

  it('reports a missing variable without guessing a default', () => {
    expect(() => requireDatabaseUrl({})).toThrow(MissingEnvError);
    expect(() => requireDatabaseUrl({})).toThrow(/DATABASE_URL is not set/);
  });

  it('rejects a non-PostgreSQL scheme', () => {
    expect(() => requireDatabaseUrl({ DATABASE_URL: 'mysql://localhost:3306/db' })).toThrow(
      InvalidConnectionStringError,
    );
  });

  it('rejects a value that is not a URL', () => {
    expect(() => requireDatabaseUrl({ DATABASE_URL: 'localhost:5432' })).toThrow(
      InvalidConnectionStringError,
    );
  });

  it('rejects a URL with no host', () => {
    expect(() => requireDatabaseUrl({ DATABASE_URL: 'postgresql:///db' })).toThrow(/no host/);
  });

  it('keeps the credential out of the error it raises', () => {
    const malformed = `postgresql//user:${FAKE_PASSWORD}@localhost:5432/db`;

    try {
      requireDatabaseUrl({ DATABASE_URL: malformed });
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(FAKE_PASSWORD);
      expect(message).not.toContain(malformed);
    }
  });
});
