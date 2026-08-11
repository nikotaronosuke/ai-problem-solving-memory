import { describe, expect, it } from 'vitest';

import { EnvValidationError, loadEnv } from '../../src/config/env.js';

describe('loadEnv', () => {
  it('applies defaults when nothing is set', () => {
    expect(loadEnv({})).toEqual({ nodeEnv: 'development', logLevel: 'info' });
  });

  it('reads supported values', () => {
    expect(loadEnv({ NODE_ENV: 'test', LOG_LEVEL: 'debug' })).toEqual({
      nodeEnv: 'test',
      logLevel: 'debug',
    });
  });

  it('normalises surrounding whitespace and casing', () => {
    expect(loadEnv({ NODE_ENV: ' Production ', LOG_LEVEL: 'WARN' })).toEqual({
      nodeEnv: 'production',
      logLevel: 'warn',
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
});
