/**
 * The HTTP contract, driven through Fastify's `inject()`.
 *
 * No port is opened and no database is involved: the application services are
 * substituted, so what is under test is the transport contract itself — status
 * codes, the error envelope, versioning, and what a response is allowed to
 * reveal.
 *
 * The failure cases matter more than the happy ones here. A client must not be
 * able to tell an unset owner from an unknown one, and an internal error must
 * not carry a stack trace, a driver message or a connection string.
 */

import { describe, expect, it } from 'vitest';

import {
  createVerificationService,
  createEventService,
  createProblemService,
  createProblemStatusService,
  createProjectEnvironmentService,
  createRelationService,
  createUsageLogService,
  createChangeLogService,
  createMemoryControlService,
  createProblemCloseService,
  createProblemDeleteService,
  ProblemVersionConflictError,
  RequestContextUnavailableError,
  type AuthenticatedRequestContext,
  type HealthReport,
  type HealthService,
  type RequestContextService,
} from '../../src/app/index.js';
import { buildMemoryHttpApp } from '../../src/http/index.js';
import { ERROR_CODES, ERROR_STATUS } from '../../src/http/errors.js';
import type { MemoryRepository } from '../../src/repository/index.js';

const OWNER_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

function healthServiceReturning(report: HealthReport): HealthService {
  return { check: () => Promise.resolve(report) };
}

/** A repository stand-in. Only `ownerId` is reachable from HTTP in this phase. */
function repositoryFor(ownerId: string): MemoryRepository {
  return { ownerId } as unknown as MemoryRepository;
}

function contextServiceFor(ownerId: string): RequestContextService {
  return {
    authenticate: () =>
      Promise.resolve({ repository: repositoryFor(ownerId) } as AuthenticatedRequestContext),
  };
}

function contextServiceFailing(internalReason: string): RequestContextService {
  return {
    authenticate: () => Promise.reject(new RequestContextUnavailableError(internalReason)),
  };
}

function buildApp(overrides: Partial<Parameters<typeof buildMemoryHttpApp>[0]> = {}) {
  return buildMemoryHttpApp({
    healthService: healthServiceReturning({ status: 'ok' }),
    requestContextService: contextServiceFor(OWNER_ID),
    // Real service, stubbed repository: these tests are about the transport
    // contract, and the routes it serves are covered in their own suite.
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
    logger: false,
    ...overrides,
  });
}

describe('GET /health', () => {
  it('reports ok when the service can do its job', async () => {
    const app = buildApp();

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });

    await app.close();
  });

  it('needs no owner context', async () => {
    // The context service would throw if it were consulted.
    const app = buildApp({ requestContextService: contextServiceFailing('should not be called') });

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);

    await app.close();
  });

  it('reports unavailable without explaining why', async () => {
    const app = buildApp({
      healthService: healthServiceReturning({
        status: 'unavailable',
        detail: 'connect ECONNREFUSED 127.0.0.1:54322',
      }),
    });

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable' });
    // A probe that describes the deployment to the network is a probe that
    // helps someone map it.
    expect(response.body).not.toContain('ECONNREFUSED');
    expect(response.body).not.toContain('54322');

    await app.close();
  });
});

describe('GET /v1/me', () => {
  it('returns the established owner in snake_case', async () => {
    const app = buildApp();

    const response = await app.inject({ method: 'GET', url: '/v1/me' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ owner_id: OWNER_ID });

    await app.close();
  });

  it('takes the owner from the context, never from the request', async () => {
    const app = buildApp();

    // A caller naming an owner must not become that owner.
    const response = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: {
        authorization: '11111111-1111-4111-8111-111111111111',
        'x-owner-id': '11111111-1111-4111-8111-111111111111',
      },
    });

    expect(response.json()).toEqual({ owner_id: OWNER_ID });

    await app.close();
  });
});

describe('unauthenticated requests', () => {
  it.each([
    ['unset', 'MEMORY_OWNER_ID is not set. See .env.example.'],
    ['malformed', 'MEMORY_OWNER_ID is unusable. Not a usable owner id: it is not a UUID.'],
    ['unknown', 'no owner 3f2504e0-4f89-41d3-9a0c-0305e82c3301 exists.'],
  ])('answers identically when the owner is %s', async (_label, internalReason) => {
    const app = buildApp({ requestContextService: contextServiceFailing(internalReason) });

    const response = await app.inject({ method: 'GET', url: '/v1/me' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: {
        code: 'UNAUTHENTICATED',
        message: 'No owner context could be established for this request.',
      },
    });

    await app.close();
  });

  it('gives away nothing that separates the three failures', async () => {
    const reasons = [
      'MEMORY_OWNER_ID is not set. See .env.example.',
      'MEMORY_OWNER_ID is unusable. Not a usable owner id: it is not a UUID.',
      'no owner 3f2504e0-4f89-41d3-9a0c-0305e82c3301 exists.',
    ];

    const bodies: string[] = [];
    for (const reason of reasons) {
      const app = buildApp({ requestContextService: contextServiceFailing(reason) });
      const response = await app.inject({ method: 'GET', url: '/v1/me' });
      // request_id differs per request, so compare the part that carries meaning.
      bodies.push(JSON.stringify(response.json<{ error: unknown }>().error));
      await app.close();
    }

    // Otherwise the endpoint answers "does this owner exist?" for anyone.
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).not.toContain('MEMORY_OWNER_ID');
    expect(bodies[0]).not.toContain('3f2504e0');
  });
});

describe('error envelope', () => {
  it('offers exactly the codes a client can branch on', async () => {
    const app = buildApp();

    // Codes are added when a caller genuinely needs to act differently.
    // VERSION_CONFLICT earns its place: the response tells a client to
    // re-read and try again, which no other code says.
    expect([...ERROR_CODES].sort()).toEqual([
      'INTERNAL_ERROR',
      'INVALID_REQUEST',
      'NOT_FOUND',
      'UNAUTHENTICATED',
      'VERSION_CONFLICT',
    ]);
    expect(ERROR_STATUS.VERSION_CONFLICT).toBe(409);

    await app.close();
  });

  it('renders a version conflict without naming a version', async () => {
    const app = buildApp();
    app.get('/test-only/conflict', () => {
      throw new ProblemVersionConflictError();
    });
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/test-only/conflict' });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: 'VERSION_CONFLICT', message: 'Problem version conflict.' },
    });
    expect(typeof response.json<{ request_id: string }>().request_id).toBe('string');
    // No version number: telling a client the current one would hand out a
    // fact about a record rather than about its request. The internal error
    // text is not the contract either. (`request_id` has digits of its own,
    // so the check is on the error object.)
    expect(JSON.stringify(response.json<{ error: unknown }>().error)).not.toMatch(/\d/);
    expect(response.body).not.toContain('since it was read');
    expect(response.body).not.toMatch(/\bat\s+\w+\s+\(/);

    await app.close();
  });
  it('carries a request id on every failure', async () => {
    const app = buildApp();

    const response = await app.inject({ method: 'GET', url: '/nope' });
    const body = response.json<{ request_id: string }>();

    expect(typeof body.request_id).toBe('string');
    expect(body.request_id.length).toBeGreaterThan(0);

    await app.close();
  });

  it('answers an unknown route with NOT_FOUND in the shared shape', async () => {
    const app = buildApp();

    const response = await app.inject({ method: 'GET', url: '/does-not-exist' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { code: 'NOT_FOUND', message: 'Not found.' },
    });

    await app.close();
  });

  it('converts schema validation failures to INVALID_REQUEST', async () => {
    const app = buildApp();
    // A route registered only for this test: the production surface should not
    // grow an endpoint that exists to be sent bad input.
    app.post(
      '/test-only/validated',
      {
        schema: {
          body: {
            type: 'object',
            properties: { title: { type: 'string' } },
            required: ['title'],
            additionalProperties: false,
          },
        },
      },
      () => ({ ok: true }),
    );
    await app.ready();

    const missingRequired = await app.inject({
      method: 'POST',
      url: '/test-only/validated',
      payload: {},
    });
    const unexpectedField = await app.inject({
      method: 'POST',
      url: '/test-only/validated',
      payload: { title: 'ok', surprise: 1 },
    });

    for (const response of [missingRequired, unexpectedField]) {
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: 'INVALID_REQUEST', message: 'Request validation failed.' },
      });
    }

    // Fastify's own format names Ajv keywords and JSON pointers; that is a
    // library detail, not this API's contract.
    expect(missingRequired.body).not.toContain('required');
    expect(unexpectedField.body).not.toContain('additionalProperties');

    await app.close();
  });

  it('rejects a malformed JSON body as INVALID_REQUEST', async () => {
    const app = buildApp();
    app.post('/test-only/echo', () => ({ ok: true }));
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/test-only/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{ not json',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });

    await app.close();
  });

  it('reveals nothing when a handler throws', async () => {
    const app = buildApp();
    app.get('/test-only/boom', () => {
      throw new Error(
        'connection to postgresql://postgres:hunter2@127.0.0.1:54322/postgres failed',
      );
    });
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/test-only/boom' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error.' },
    });
    // The three things most likely to escape in a stack trace.
    expect(response.body).not.toContain('postgresql://');
    expect(response.body).not.toContain('hunter2');
    expect(response.body).not.toMatch(/\bat\s+\w+\s+\(/);

    await app.close();
  });
});

describe('API versioning', () => {
  it('serves the Memory API under /v1', async () => {
    const app = buildApp();

    expect((await app.inject({ method: 'GET', url: '/v1/me' })).statusCode).toBe(200);

    await app.close();
  });

  it.each(['/me', '/v2/me', '/v1/v1/me'])('does not serve %s', async (url) => {
    const app = buildApp();

    const response = await app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });

    await app.close();
  });

  it('keeps health outside the version prefix', async () => {
    const app = buildApp();

    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/health' })).statusCode).toBe(404);

    await app.close();
  });
});

describe('application boundary', () => {
  it('starts nothing on import — an app is built, not run', () => {
    const app = buildApp();

    // Building must not have listened. Fastify exposes the server before it
    // is bound, so an address is the evidence either way.
    expect(app.server.listening).toBe(false);
    expect(app.server.address()).toBeNull();
  });

  it('does not consult the owner context service unless a route needs it', async () => {
    let authenticateCalls = 0;
    const app = buildApp({
      requestContextService: {
        authenticate: () => {
          authenticateCalls += 1;
          return Promise.resolve({
            repository: repositoryFor(OWNER_ID),
          } as AuthenticatedRequestContext);
        },
      },
    });

    await app.inject({ method: 'GET', url: '/health' });
    expect(authenticateCalls).toBe(0);

    await app.inject({ method: 'GET', url: '/v1/me' });
    expect(authenticateCalls).toBe(1);

    await app.close();
  });
});
