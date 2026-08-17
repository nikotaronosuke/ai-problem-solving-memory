/**
 * The memory control request contract, driven through `inject()`.
 *
 * The application service is substituted, so what is under test is transport:
 * what it accepts, what it refuses before anything downstream sees it, and the
 * exact shape it returns.
 *
 * Two refusals carry the weight. `invalidate: false` is rejected rather than
 * treated as "make it current again", because nothing here could know which
 * kind of freshness to restore. And `freshness` itself is rejected, so that
 * invalidating and editing freshness in general stay distinguishable — the
 * ordinary Problem update is where the second belongs.
 *
 * Whether the controls stay independent of one another needs real data and
 * lives in the integration suite.
 */

import { describe, expect, it } from 'vitest';

import {
  createProblemCloseService,
  createExportService,
  createProblemDeleteService,
  createChangeLogService,
  createEventService,
  createProblemService,
  createProblemStatusService,
  createProjectEnvironmentService,
  createRelationService,
  createUsageLogService,
  createVerificationService,
  ProblemVersionConflictError,
  RequestContextUnavailableError,
  ResourceNotFoundError,
  type AuthenticatedRequestContext,
  type HealthService,
  type MemoryControlCommand,
  type MemoryControlService,
  type ProblemRecord,
  type RequestContextService,
} from '../../src/app/index.js';
import type { EnvironmentId } from '../../src/domain/environment.js';
import type { OwnerId } from '../../src/domain/owner.js';
import type { ProblemId } from '../../src/domain/problem.js';
import type { ProjectId } from '../../src/domain/project.js';
import { buildMemoryHttpApp } from '../../src/http/index.js';
import type { MemoryRepository } from '../../src/repository/index.js';
import { createUnusedSearchResolver } from '../support/search-resolver.js';

const OWNER_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const PROJECT_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const ENVIRONMENT_ID = '9b2f1c4e-6d3a-4b8e-9f10-2c5d7e8a1b34';
const PROBLEM_ID = '5d41402a-bc4b-4a76-b971-9d911017c592';

function problemRecord(overrides: Partial<ProblemRecord> = {}): ProblemRecord {
  return {
    problemId: PROBLEM_ID as ProblemId,
    ownerId: OWNER_ID as OwnerId,
    projectId: PROJECT_ID as ProjectId,
    environmentId: ENVIRONMENT_ID as EnvironmentId,
    title: 'Sign-in fails after deploying',
    symptoms: 'Works locally, fails on preview.',
    problemDomain: null,
    suspectedBoundary: null,
    sourceAi: null,
    status: 'INVESTIGATING',
    fixKind: null,
    importance: false,
    confidence: 'LOW',
    freshness: 'CURRENT',
    memoryReadEnabled: true,
    memoryWriteEnabled: true,
    suppressed: false,
    version: 5,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
  };
}

interface ServiceCalls {
  updateControls?: { problemId: string; command: MemoryControlCommand };
}

function serviceRecording(calls: ServiceCalls, record = problemRecord()): MemoryControlService {
  return {
    updateControls: (_context, problemId, command) => {
      calls.updateControls = { problemId, command };
      return Promise.resolve(record);
    },
  };
}

function serviceFailing(error: Error): MemoryControlService {
  return { updateControls: () => Promise.reject(error) };
}

const healthService: HealthService = {
  check: () => Promise.resolve({ status: 'ok', latencyMs: 0 }),
};

function buildApp(service: MemoryControlService, authenticated = true) {
  return buildMemoryHttpApp({
    retrievalSearchResolver: createUnusedSearchResolver(),
    healthService,
    requestContextService: authenticated
      ? ({
          authenticate: () =>
            Promise.resolve({
              repository: { ownerId: OWNER_ID } as unknown as MemoryRepository,
            } as AuthenticatedRequestContext),
        } satisfies RequestContextService)
      : { authenticate: () => Promise.reject(new RequestContextUnavailableError('MISSING')) },
    projectEnvironmentService: createProjectEnvironmentService(),
    problemService: createProblemService(),
    problemStatusService: createProblemStatusService(),
    eventService: createEventService(),
    verificationService: createVerificationService(),
    relationService: createRelationService(),
    usageLogService: createUsageLogService(),
    changeLogService: createChangeLogService(),
    memoryControlService: service,
    problemCloseService: createProblemCloseService(),
    problemDeleteService: createProblemDeleteService(),
    exportService: createExportService(),
    logger: false,
  });
}

const URL = `/v1/problems/${PROBLEM_ID}/memory-control`;
const TOKENS = { expected_version: 5, changed_by: 'claude-code' };

describe('PATCH /v1/problems/:problem_id/memory-control', () => {
  it('returns the whole problem, not a control-only resource', async () => {
    const app = buildApp(
      serviceRecording({}, problemRecord({ memoryReadEnabled: false, version: 6 })),
    );

    const response = await app.inject({
      method: 'PATCH',
      url: URL,
      payload: { ...TOKENS, memory_read_enabled: false },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      problem_id: PROBLEM_ID,
      memory_read_enabled: false,
      memory_write_enabled: true,
      suppressed: false,
      freshness: 'CURRENT',
      version: 6,
    });

    await app.close();
  });

  it('takes the problem from the path', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    await app.inject({ method: 'PATCH', url: URL, payload: { ...TOKENS, suppressed: true } });

    expect(calls.updateControls).toEqual({
      problemId: PROBLEM_ID,
      command: { expectedVersion: 5, changedBy: 'claude-code', suppressed: true },
    });

    await app.close();
  });

  it.each([
    ['memory_read_enabled', 'memoryReadEnabled'],
    ['memory_write_enabled', 'memoryWriteEnabled'],
    ['suppressed', 'suppressed'],
  ] as const)('forwards %s on its own, either way', async (wire, internal) => {
    for (const value of [true, false]) {
      const calls: ServiceCalls = {};
      const app = buildApp(serviceRecording(calls));

      const response = await app.inject({
        method: 'PATCH',
        url: URL,
        payload: { ...TOKENS, [wire]: value },
      });

      expect(response.statusCode).toBe(200);
      expect(calls.updateControls?.command).toEqual({
        expectedVersion: 5,
        changedBy: 'claude-code',
        [internal]: value,
      });

      await app.close();
    }
  });

  it('forwards several controls as one command', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    await app.inject({
      method: 'PATCH',
      url: URL,
      payload: {
        ...TOKENS,
        memory_read_enabled: false,
        memory_write_enabled: false,
        suppressed: true,
        invalidate: true,
      },
    });

    // One request, one command: the service turns it into one mutation.
    expect(calls.updateControls?.command).toEqual({
      expectedVersion: 5,
      changedBy: 'claude-code',
      memoryReadEnabled: false,
      memoryWriteEnabled: false,
      suppressed: true,
      invalidate: true,
    });

    await app.close();
  });

  it('accepts invalidate: true', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls, problemRecord({ freshness: 'INVALID' })));

    const response = await app.inject({
      method: 'PATCH',
      url: URL,
      payload: { ...TOKENS, invalidate: true },
    });

    expect(response.statusCode).toBe(200);
    expect(calls.updateControls?.command.invalidate).toBe(true);
    expect(response.json<{ freshness: string }>().freshness).toBe('INVALID');

    await app.close();
  });

  it('refuses invalidate: false rather than guessing what to restore', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'PATCH',
      url: URL,
      payload: { ...TOKENS, invalidate: false },
    });

    // A Problem that became INVALID may have been CURRENT before it, or
    // STALE_UNKNOWN, or SUPERSEDED. Saying it holds again means saying which.
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    expect(calls.updateControls).toBeUndefined();

    await app.close();
  });

  it('refuses freshness, so invalidating stays distinct from editing it', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    for (const freshness of ['CURRENT', 'STALE_UNKNOWN', 'SUPERSEDED', 'INVALID']) {
      const response = await app.inject({
        method: 'PATCH',
        url: URL,
        payload: { ...TOKENS, freshness },
      });

      expect(response.statusCode).toBe(400);
    }
    expect(calls.updateControls).toBeUndefined();

    await app.close();
  });

  it.each([
    ['no body at all', undefined],
    ['only the tokens', TOKENS],
    ['only the version', { expected_version: 5 }],
    ['only the signature', { changed_by: 'claude-code' }],
    ['a missing version', { changed_by: 'claude-code', suppressed: true }],
    ['a missing signature', { expected_version: 5, suppressed: true }],
    ['an empty signature', { ...TOKENS, changed_by: '', suppressed: true }],
    ['a whitespace-only signature', { ...TOKENS, changed_by: '   ', suppressed: true }],
    ['a non-string signature', { ...TOKENS, changed_by: 7, suppressed: true }],
    ['a string version', { ...TOKENS, expected_version: '5', suppressed: true }],
    ['a fractional version', { ...TOKENS, expected_version: 5.5, suppressed: true }],
    ['a zero version', { ...TOKENS, expected_version: 0, suppressed: true }],
    ['a string control', { ...TOKENS, suppressed: 'true' }],
    ['a numeric control', { ...TOKENS, memory_read_enabled: 0 }],
    ['a null control', { ...TOKENS, memory_write_enabled: null }],
  ])('refuses %s', async (_label, payload) => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'PATCH',
      url: URL,
      payload: payload ?? '',
      headers: { 'content-type': 'application/json' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    expect(calls.updateControls).toBeUndefined();

    await app.close();
  });

  it.each([
    ['status', 'PAUSED'],
    ['fix_kind', 'ROOT_FIX'],
    ['version', 6],
    ['confidence', 'HIGH'],
    ['importance', true],
    ['title', 'renamed'],
    ['owner_id', OWNER_ID],
    ['problem_id', PROBLEM_ID],
    ['created_at', '2026-01-01T00:00:00.000Z'],
    ['updated_at', '2026-01-01T00:00:00.000Z'],
    ['surprise', 'anything'],
  ])('refuses a body containing %s', async (field, value) => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'PATCH',
      url: URL,
      payload: { ...TOKENS, suppressed: true, [field]: value },
    });

    // This surface is for the controls. Content and lifecycle belong to the
    // ordinary update and the transition route.
    expect(response.statusCode).toBe(400);
    expect(calls.updateControls).toBeUndefined();

    await app.close();
  });

  it('refuses a malformed problem id in the path', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'PATCH',
      url: '/v1/problems/not-a-uuid/memory-control',
      payload: { ...TOKENS, suppressed: true },
    });

    expect(response.statusCode).toBe(400);
    expect(calls.updateControls).toBeUndefined();

    await app.close();
  });

  it('reports an unreachable problem as not found', async () => {
    const app = buildApp(serviceFailing(new ResourceNotFoundError()));

    const response = await app.inject({
      method: 'PATCH',
      url: URL,
      payload: { ...TOKENS, suppressed: true },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });

    await app.close();
  });

  it('reports a stale version as a conflict', async () => {
    const app = buildApp(serviceFailing(new ProblemVersionConflictError()));

    const response = await app.inject({
      method: 'PATCH',
      url: URL,
      payload: { ...TOKENS, suppressed: true },
    });

    // The same 409 as any other Problem write: one lock, one vocabulary.
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: 'VERSION_CONFLICT', message: 'Problem version conflict.' },
    });

    await app.close();
  });

  it('requires an owner context', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls), false);

    const response = await app.inject({
      method: 'PATCH',
      url: URL,
      payload: { ...TOKENS, suppressed: true },
    });

    expect(response.statusCode).toBe(401);
    expect(calls.updateControls).toBeUndefined();

    await app.close();
  });
});

describe('the control surface is one route, and PATCH only', () => {
  it.each(['GET', 'POST', 'PUT', 'DELETE'])('%s is not served', async (method) => {
    const app = buildApp(serviceRecording({}));

    const response = await app.inject({
      method: method as 'DELETE' | 'GET' | 'POST' | 'PUT',
      url: URL,
      payload: { ...TOKENS, suppressed: true },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });

    await app.close();
  });

  it.each([
    `/v1/problems/${PROBLEM_ID}/memory-controls`,
    `/v1/problems/${PROBLEM_ID}/modify`,
    `/v1/problems/${PROBLEM_ID}/invalidate`,
    `/v1/problems/${PROBLEM_ID}/suppress`,
    '/v1/memory-control',
  ])('%s is not served', async (url) => {
    const app = buildApp(serviceRecording({}));

    const response = await app.inject({
      method: 'PATCH',
      url,
      payload: { ...TOKENS, suppressed: true },
    });

    // No duplicate surfaces: basic modification is the ordinary Problem
    // update, and the controls are this one route.
    expect(response.statusCode).toBe(404);

    await app.close();
  });
});
