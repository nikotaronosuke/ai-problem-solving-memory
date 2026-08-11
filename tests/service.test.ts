import { describe, expect, it } from 'vitest';

import { loadEnv } from '../src/config/env.js';
import { SERVICE_NAME, buildStartupSummary, formatStartupSummary } from '../src/service.js';

describe('startup summary', () => {
  it('describes the service from the loaded environment', () => {
    const summary = buildStartupSummary(
      loadEnv({ NODE_ENV: 'test', LOG_LEVEL: 'error' }),
      'v22.0.0',
    );

    expect(summary).toEqual({
      service: SERVICE_NAME,
      nodeEnv: 'test',
      logLevel: 'error',
      nodeVersion: 'v22.0.0',
    });
  });

  it('formats a single-line startup message', () => {
    const summary = buildStartupSummary(loadEnv({}), 'v22.0.0');

    expect(formatStartupSummary(summary)).toBe(
      `${SERVICE_NAME} starting | node=v22.0.0 | env=development | log=info`,
    );
  });

  it('runs on a Node.js version supported by the toolchain', () => {
    const major = Number.parseInt(process.version.replace(/^v/, ''), 10);

    expect(major).toBeGreaterThanOrEqual(22);
  });
});
