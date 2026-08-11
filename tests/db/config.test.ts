import { describe, expect, it } from 'vitest';

import { MissingEnvError } from '../../src/config/env.js';
import {
  UnsafeDatabaseTargetError,
  isLocalHostname,
  resolveDatabaseConfig,
} from '../../src/db/config.js';

/** Stand-in credential. Used to assert it never reaches an error message. */
const FAKE_PASSWORD = 'not-a-real-password-9f3a';

const localUrl = `postgresql://postgres:${FAKE_PASSWORD}@127.0.0.1:54322/postgres`;
const remoteUrl = `postgresql://postgres:${FAKE_PASSWORD}@db.example.com:5432/postgres`;

describe('isLocalHostname', () => {
  it('recognises the developer machine', () => {
    expect(isLocalHostname('localhost')).toBe(true);
    expect(isLocalHostname('127.0.0.1')).toBe(true);
    expect(isLocalHostname('::1')).toBe(true);
    expect(isLocalHostname('LOCALHOST')).toBe(true);
  });

  it('treats anything else as remote', () => {
    expect(isLocalHostname('db.example.com')).toBe(false);
    expect(isLocalHostname('10.0.0.5')).toBe(false);
  });
});

describe('resolveDatabaseConfig', () => {
  it('builds a pool config from the environment', () => {
    const config = resolveDatabaseConfig({
      nodeEnv: 'development',
      source: { DATABASE_URL: localUrl },
    });

    expect(config.poolConfig.connectionString).toBe(localUrl);
    expect(config.host).toBe('127.0.0.1');
    expect(config.isLocal).toBe(true);
  });

  it('applies pool defaults and honours overrides', () => {
    const defaults = resolveDatabaseConfig({
      nodeEnv: 'development',
      source: { DATABASE_URL: localUrl },
    });

    expect(defaults.poolConfig.max).toBe(10);
    expect(defaults.poolConfig.idleTimeoutMillis).toBe(30_000);
    expect(defaults.poolConfig.connectionTimeoutMillis).toBe(10_000);

    const tuned = resolveDatabaseConfig({
      nodeEnv: 'development',
      source: { DATABASE_URL: localUrl },
      maxConnections: 3,
      connectionTimeoutMillis: 1_000,
    });

    expect(tuned.poolConfig.max).toBe(3);
    expect(tuned.poolConfig.connectionTimeoutMillis).toBe(1_000);
  });

  it('requires DATABASE_URL at the point a connection would be configured', () => {
    expect(() => resolveDatabaseConfig({ nodeEnv: 'development', source: {} })).toThrow(
      MissingEnvError,
    );
  });

  it('allows a remote target outside tests', () => {
    const config = resolveDatabaseConfig({
      nodeEnv: 'production',
      source: { DATABASE_URL: remoteUrl },
    });

    expect(config.host).toBe('db.example.com');
    expect(config.isLocal).toBe(false);
  });

  it('refuses a remote target while NODE_ENV is test', () => {
    expect(() =>
      resolveDatabaseConfig({ nodeEnv: 'test', source: { DATABASE_URL: remoteUrl } }),
    ).toThrow(UnsafeDatabaseTargetError);
  });

  it('permits a local target while NODE_ENV is test', () => {
    expect(() =>
      resolveDatabaseConfig({ nodeEnv: 'test', source: { DATABASE_URL: localUrl } }),
    ).not.toThrow();
  });

  it('keeps the credential out of the unsafe-target error', () => {
    try {
      resolveDatabaseConfig({ nodeEnv: 'test', source: { DATABASE_URL: remoteUrl } });
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(FAKE_PASSWORD);
      expect(message).not.toContain(remoteUrl);
      expect(message).toContain('db.example.com');
    }
  });
});
