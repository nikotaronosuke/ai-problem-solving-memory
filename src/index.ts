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
 *
 * Startup runs inside a boundary, which is a P3-10 decision rather than a
 * stylistic one. Configuration is read and the pool is opened *before* a
 * logger exists, so a failure there used to escape as an uncaught exception
 * and Node printed the message and the stack to stderr. Two of the errors that
 * can arrive there carry values worth keeping out of a terminal buffer: an
 * invalid environment variable is reported with the offending value, and an
 * unsafe database target is reported with the host. Neither passes through
 * Pino, so no serializer would have caught them.
 */

import { loadEnv } from './config/env.js';
import {
  createEventService,
  createHealthService,
  createProblemService,
  createProblemStatusService,
  createProjectEnvironmentService,
  createRelationService,
  createUsageLogService,
  createChangeLogService,
  createMemoryControlService,
  createProblemCloseService,
  createExportService,
  createProblemDeleteService,
  createRequestContextService,
  createVerificationService,
} from './app/index.js';
import { resolveDatabaseConfig } from './db/config.js';
import { createCredentialAuthenticator, createCredentialRepository } from './credentials/index.js';
import { closePool, createPool, type DatabasePool } from './db/pool.js';
import { createTransactionRunner } from './db/transaction.js';
import { buildMemoryHttpApp, createLoggerOptions } from './http/index.js';
import { createConfiguredRetrievalProviders } from './providers/index.js';
import { createRetrievalRuntime } from './runtime/retrieval-runtime.js';
import { createRetrievalSearchRuntime } from './runtime/retrieval-search-runtime.js';
import { buildStartupSummary, formatStartupSummary, STARTUP_FAILURE_MESSAGE } from './service.js';

/**
 * Closes what was opened, without reporting how it went.
 *
 * A cleanup failure during a startup failure is not a second thing to tell
 * somebody about, and the error it would report comes from the driver.
 */
async function closeQuietly(pool: DatabasePool): Promise<void> {
  try {
    await closePool(pool);
  } catch {
    // Deliberately empty. The process is already failing to start.
  }
}

async function main(): Promise<void> {
  const env = loadEnv();
  const pool = createPool(resolveDatabaseConfig({ nodeEnv: env.nodeEnv }));

  // The provider stack, if one is configured — and the maintenance runtime
  // either way. `enabled: false` is the ordinary answer for a server without
  // the provider credential: generation still runs, deterministically, so a
  // Problem is findable by the free lexical channel with nothing configured
  // and nothing outbound. Providers, when present, enhance that baseline.
  // The composition root learns whether a stack exists and never which
  // vendor it is.
  const configuredRetrieval = createConfiguredRetrievalProviders(process.env);
  const retrievalRuntime = createRetrievalRuntime({
    pool,
    ...(configuredRetrieval.enabled
      ? {
          providers: {
            summaryGenerator: configuredRetrieval.summaryGenerator,
            embeddingProvider: configuredRetrieval.embeddingProvider,
            generationProfile: configuredRetrieval.generationProfile,
          },
        }
      : {}),
  });
  const maintenance = retrievalRuntime.maintenance;

  // Search, unlike maintenance, exists either way. Its two provider ports are
  // optional all the way down: with no configured stack the lexical channel
  // answers, the semantic channel reports itself unavailable and the
  // structural stage reports its reranker unavailable — a smaller answer to the
  // same question, not a missing route. So this is built unconditionally, from
  // the same single `createConfiguredRetrievalProviders` call that maintenance
  // uses, and the ports are passed only when there is a stack to pass.
  //
  // Nothing vendor-shaped crosses this line: the runtime receives two ports and
  // a pool. It holds the one process-wide rerank cache, whose key includes the
  // owner, and builds the owner-scoped pipeline per request.
  const retrievalSearchResolver = createRetrievalSearchRuntime({
    pool,
    embeddingProvider: configuredRetrieval.enabled
      ? configuredRetrieval.embeddingProvider
      : undefined,
    structuralReranker: configuredRetrieval.enabled
      ? configuredRetrieval.structuralReranker
      : undefined,
  });

  const app = buildMemoryHttpApp({
    healthService: createHealthService(pool),
    requestContextService: createRequestContextService(
      pool,
      createTransactionRunner(pool),
      createCredentialAuthenticator(createCredentialRepository(pool)),
    ),
    projectEnvironmentService: createProjectEnvironmentService(),
    problemService: createProblemService(maintenance),
    problemStatusService: createProblemStatusService(maintenance),
    eventService: createEventService(maintenance),
    verificationService: createVerificationService(maintenance),
    relationService: createRelationService(),
    usageLogService: createUsageLogService(),
    changeLogService: createChangeLogService(),
    memoryControlService: createMemoryControlService(),
    problemCloseService: createProblemCloseService(maintenance),
    problemDeleteService: createProblemDeleteService(),
    exportService: createExportService(),
    retrievalSearchResolver,
    // Credentials must not survive into a log file, and the failure is silent
    // if they do. Built by the http module so the configuration a test
    // exercises is the configuration the server runs.
    logger: createLoggerOptions(env.logLevel),
  });

  let shuttingDown = false;

  async function shutdown(signal: NodeJS.Signals): Promise<void> {
    // Two Ctrl-C presses should not race two shutdowns against each other.
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;

    app.log.info({ event: 'SERVER_SHUTDOWN', signal }, 'shutting down');

    try {
      // Maintenance first, so nothing schedules new background work while
      // the door is closing; then stop accepting requests; then take the
      // database away. An in-flight generation is not waited for — its
      // failure leaves absence, which the next startup sweep repairs.
      retrievalRuntime.stop();
      await app.close();
      await closePool(pool);
    } catch {
      // The error is not logged. It comes from Fastify or from the driver,
      // and a shutdown that has already gone wrong is not worth a stack trace
      // in a file. That it went wrong, and the exit code, is the report.
      app.log.error(
        { event: 'SERVER_SHUTDOWN_FAILURE', failure: 'UNEXPECTED' },
        'error during shutdown',
      );
      process.exitCode = 1;
    }
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }

  // Static, and the only console output the server process makes: a service
  // name, a Node version, an environment name, a log level, the address it
  // is about to bind, and whether a retrieval generation stack is configured
  // — as one closed word, never a credential or a vendor. No connection
  // string, no owner id, nothing a caller sent — there are no callers yet.
  console.log(formatStartupSummary(buildStartupSummary(env, configuredRetrieval.enabled)));

  try {
    await app.listen({ host: env.host, port: env.port });
  } catch (error) {
    app.log.error({ event: 'SERVER_START_FAILURE', failure: 'UNEXPECTED' }, 'failed to start');
    await closeQuietly(pool);
    throw error;
  }

  // After the listener is up, deliberately: the startup sweep is the backfill
  // and the crash recovery, it runs in the background, and ordinary CRUD
  // availability never waits on a provider. Its failures stay inside the
  // runtime as closed diagnostics and cannot become a startup failure.
  retrievalRuntime.start();
}

try {
  await main();
} catch {
  // Everything the failure knows stops here. This is reached both for a
  // listen that failed — already reported through the logger above — and for
  // the configuration failures that happen before a logger exists, which is
  // the case this boundary was added for.
  console.error(STARTUP_FAILURE_MESSAGE);
  process.exitCode = 1;
}
