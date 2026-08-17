/**
 * The HTTP surface over a real database.
 *
 * The contract tests substitute the application services; this one wires the
 * real ones, so what is verified is that owner resolution, the repository and
 * the transport actually fit together — not just that each works alone.
 *
 * The fixture creates its own owner every run and removes only that. It never
 * reads the developer's `MEMORY_OWNER_ID`: the owner is supplied as an
 * explicit environment source, which is also what a future credential resolver
 * will replace.
 *
 * Skipped when `DATABASE_URL` is not set.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
} from '../../src/app/index.js';
import { createFixedRequestContextService } from '../support/request-context.js';
import {
  createCredentialAuthenticator,
  createCredentialRepository,
} from '../../src/credentials/index.js';
import { formatCredentialToken, generateCredentialToken } from '../../src/domain/credential.js';
import { readDatabaseUrl } from '../../src/config/env.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import { createTransactionRunner } from '../../src/db/transaction.js';
import { generateOwnerId, type OwnerId } from '../../src/domain/owner.js';
import { buildMemoryHttpApp } from '../../src/http/index.js';
import { createUnusedSearchResolver } from '../support/search-resolver.js';

const databaseUrl = readDatabaseUrl();

describe.skipIf(databaseUrl === undefined)('HTTP over a real database', () => {
  let pool: DatabasePool;
  const ownersCreated: OwnerId[] = [];

  /** Builds the app with the real services, acting as a freshly made owner. */
  async function buildAppForNewOwner() {
    const ownerId = generateOwnerId();
    await insertOwnerIfAbsent(pool, ownerId);
    ownersCreated.push(ownerId);

    const app = buildMemoryHttpApp({
      retrievalSearchResolver: createUnusedSearchResolver(),
      healthService: createHealthService(pool),
      requestContextService: createFixedRequestContextService(pool, ownerId),
      projectEnvironmentService: createProjectEnvironmentService(),
      problemService: createProblemService(),
      problemStatusService: createProblemStatusService(),
      eventService: createEventService(),
      verificationService: createVerificationService(),
      relationService: createRelationService(),
      usageLogService: createUsageLogService(),
      changeLogService: createChangeLogService(),
      memoryControlService: createMemoryControlService(),
      problemCloseService: createProblemCloseService(),
      problemDeleteService: createProblemDeleteService(),
      exportService: createExportService(),
      logger: false,
    });

    return { app, ownerId };
  }

  beforeAll(() => {
    pool = createPool(resolveDatabaseConfig({ nodeEnv: 'test', connectionTimeoutMillis: 5_000 }));
  });

  afterAll(async () => {
    if (ownersCreated.length > 0) {
      await pool.query('delete from public.owners where owner_id = any($1::uuid[])', [
        ownersCreated,
      ]);
    }
    await closePool(pool);
  });

  it('reports healthy against a reachable database', async () => {
    const { app } = await buildAppForNewOwner();

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });

    await app.close();
  });

  it('resolves the owner end to end and returns it', async () => {
    const { app, ownerId } = await buildAppForNewOwner();

    const response = await app.inject({ method: 'GET', url: '/v1/me' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ owner_id: ownerId });

    await app.close();
  });

  it('gives each owner its own scope', async () => {
    const first = await buildAppForNewOwner();
    const second = await buildAppForNewOwner();

    const firstResponse = await first.app.inject({ method: 'GET', url: '/v1/me' });
    const secondResponse = await second.app.inject({ method: 'GET', url: '/v1/me' });

    expect(firstResponse.json()).toEqual({ owner_id: first.ownerId });
    expect(secondResponse.json()).toEqual({ owner_id: second.ownerId });
    expect(first.ownerId).not.toBe(second.ownerId);

    await first.app.close();
    await second.app.close();
  });

  it.each([
    ['absent', undefined],
    ['not a bearer scheme', 'Basic dXNlcjpwYXNz'],
    ['a bearer with no token', 'Bearer'],
    ['a token of the wrong shape', 'Bearer not-a-memory-token'],
    // Well-formed, and selecting nothing: resolution reaches the database and
    // finds no row.
    ['well-formed but unissued', `Bearer ${formatCredentialToken(generateCredentialToken())}`],
  ])('refuses identically when the credential is %s', async (_label, authorization) => {
    const app = buildMemoryHttpApp({
      retrievalSearchResolver: createUnusedSearchResolver(),
      healthService: createHealthService(pool),
      requestContextService: createRequestContextService(
        pool,
        createTransactionRunner(pool),
        createCredentialAuthenticator(createCredentialRepository(pool)),
      ),
      projectEnvironmentService: createProjectEnvironmentService(),
      problemService: createProblemService(),
      problemStatusService: createProblemStatusService(),
      eventService: createEventService(),
      verificationService: createVerificationService(),
      relationService: createRelationService(),
      usageLogService: createUsageLogService(),
      changeLogService: createChangeLogService(),
      memoryControlService: createMemoryControlService(),
      problemCloseService: createProblemCloseService(),
      problemDeleteService: createProblemDeleteService(),
      exportService: createExportService(),
      logger: false,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/me',
      ...(authorization === undefined ? {} : { headers: { authorization } }),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    // Nothing about why. Telling a caller that a credential exists but was
    // revoked, or that a lookup matched but a secret did not, answers
    // questions about credentials they do not hold.
    expect(response.body).not.toContain('MEMORY_OWNER_ID');
    expect(response.body).not.toContain('mem_');

    await app.close();
  });

  it('leaves health working when no credential is presented', async () => {
    const app = buildMemoryHttpApp({
      retrievalSearchResolver: createUnusedSearchResolver(),
      healthService: createHealthService(pool),
      requestContextService: createRequestContextService(
        pool,
        createTransactionRunner(pool),
        createCredentialAuthenticator(createCredentialRepository(pool)),
      ),
      projectEnvironmentService: createProjectEnvironmentService(),
      problemService: createProblemService(),
      problemStatusService: createProblemStatusService(),
      eventService: createEventService(),
      verificationService: createVerificationService(),
      relationService: createRelationService(),
      usageLogService: createUsageLogService(),
      changeLogService: createChangeLogService(),
      memoryControlService: createMemoryControlService(),
      problemCloseService: createProblemCloseService(),
      problemDeleteService: createProblemDeleteService(),
      exportService: createExportService(),
      logger: false,
    });

    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/me' })).statusCode).toBe(401);

    await app.close();
  });

  it('shuts down in the order the composition root uses, and survives a repeat', async () => {
    // The signal handler itself cannot be exercised on every platform, so what
    // is checked here is the sequence it performs: stop serving, then release
    // the database — and tolerate being asked twice, since two Ctrl-C presses
    // should not race two shutdowns against each other.
    const ownerId = generateOwnerId();
    await insertOwnerIfAbsent(pool, ownerId);
    ownersCreated.push(ownerId);

    const ownPool = createPool(
      resolveDatabaseConfig({ nodeEnv: 'test', connectionTimeoutMillis: 5_000 }),
    );
    const app = buildMemoryHttpApp({
      retrievalSearchResolver: createUnusedSearchResolver(),
      healthService: createHealthService(ownPool),
      requestContextService: createFixedRequestContextService(ownPool, ownerId),
      projectEnvironmentService: createProjectEnvironmentService(),
      problemService: createProblemService(),
      problemStatusService: createProblemStatusService(),
      eventService: createEventService(),
      verificationService: createVerificationService(),
      relationService: createRelationService(),
      usageLogService: createUsageLogService(),
      changeLogService: createChangeLogService(),
      memoryControlService: createMemoryControlService(),
      problemCloseService: createProblemCloseService(),
      problemDeleteService: createProblemDeleteService(),
      exportService: createExportService(),
      logger: false,
    });

    expect((await app.inject({ method: 'GET', url: '/v1/me' })).statusCode).toBe(200);

    await app.close();
    await closePool(ownPool);
    expect(ownPool.ended).toBe(true);

    await expect(app.close()).resolves.toBeUndefined();
    await expect(closePool(ownPool)).resolves.toBeUndefined();
  });

  it('never exposes the connection string, whatever the outcome', async () => {
    const { app } = await buildAppForNewOwner();

    const responses = await Promise.all([
      app.inject({ method: 'GET', url: '/health' }),
      app.inject({ method: 'GET', url: '/v1/me' }),
      app.inject({ method: 'GET', url: '/nope' }),
    ]);

    for (const response of responses) {
      expect(response.body).not.toContain('postgres');
      expect(response.body).not.toContain('54322');
    }

    await app.close();
  });
});
