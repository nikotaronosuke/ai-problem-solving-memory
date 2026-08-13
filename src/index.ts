/**
 * Executable entrypoint: run the Memory Server.
 *
 * This is the composition root and the only place that does any of it —
 * reading configuration, opening a pool, wiring services, listening, and
 * shutting down when asked. Everything below is constructed and injected, so
 * importing any of it in a test starts nothing.
 *
 * Signal handlers are registered here rather than inside the app factory for
 * the same reason: a test that builds an app should not end up owning the
 * process's shutdown behaviour.
 */

import { loadEnv } from './config/env.js';
import {
  createEventService,
  createHealthService,
  createProblemService,
  createProjectEnvironmentService,
  createRequestContextService,
} from './app/index.js';
import { resolveDatabaseConfig } from './db/config.js';
import { closePool, createPool } from './db/pool.js';
import { buildMemoryHttpApp, REDACTED_LOG_PATHS } from './http/index.js';
import { buildStartupSummary, formatStartupSummary } from './service.js';

const env = loadEnv();
const pool = createPool(resolveDatabaseConfig({ nodeEnv: env.nodeEnv }));

const app = buildMemoryHttpApp({
  healthService: createHealthService(pool),
  requestContextService: createRequestContextService(pool),
  projectEnvironmentService: createProjectEnvironmentService(),
  problemService: createProblemService(),
  eventService: createEventService(),
  logger: {
    level: env.logLevel,
    // Credentials must not survive into a log file, and the failure is silent
    // if they do.
    redact: { paths: [...REDACTED_LOG_PATHS], remove: true },
  },
});

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  // Two Ctrl-C presses should not race two shutdowns against each other.
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  app.log.info({ signal }, 'shutting down');

  try {
    // Stop accepting requests before taking the database away from the ones
    // already in flight.
    await app.close();
    await closePool(pool);
  } catch (error) {
    app.log.error({ err: error }, 'error during shutdown');
    process.exitCode = 1;
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

console.log(formatStartupSummary(buildStartupSummary(env)));

try {
  await app.listen({ host: env.host, port: env.port });
} catch (error) {
  app.log.error({ err: error }, 'failed to start');
  await closePool(pool);
  process.exitCode = 1;
}
