import { describe, expect, it } from 'vitest';

import { loadEnv } from '../src/config/env.js';
import { SERVICE_NAME, buildStartupSummary, formatStartupSummary } from '../src/service.js';

describe('startup summary', () => {
  it('describes the service from the loaded environment', () => {
    const summary = buildStartupSummary(
      loadEnv({ NODE_ENV: 'test', LOG_LEVEL: 'error', HOST: '127.0.0.1', PORT: '4000' }),
      'v22.0.0',
    );

    expect(summary).toEqual({
      service: SERVICE_NAME,
      nodeEnv: 'test',
      logLevel: 'error',
      nodeVersion: 'v22.0.0',
      host: '127.0.0.1',
      port: 4000,
    });
  });

  it('formats a single-line startup message', () => {
    const summary = buildStartupSummary(loadEnv({}), 'v22.0.0');

    expect(formatStartupSummary(summary)).toBe(
      `${SERVICE_NAME} starting | node=v22.0.0 | env=development | log=info | ` +
        `host=127.0.0.1 | port=3000`,
    );
  });

  it('reports where it is bound but nothing about what it connects to', () => {
    const line = formatStartupSummary(
      buildStartupSummary(
        loadEnv({ DATABASE_URL: 'postgresql://u:hunter2@db.example.com:5432/x' }),
        'v22.0.0',
      ),
    );

    // Startup output is the first thing pasted into an issue.
    expect(line).not.toContain('hunter2');
    expect(line).not.toContain('postgresql://');
    expect(line).not.toContain('MEMORY_OWNER_ID');
  });

  it('runs on a Node.js version supported by the toolchain', () => {
    const major = Number.parseInt(process.version.replace(/^v/, ''), 10);

    expect(major).toBeGreaterThanOrEqual(22);
  });
});
