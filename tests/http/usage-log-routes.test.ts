/**
 * The UsageLog request contract, driven through `inject()`.
 *
 * The application service is substituted, so what is under test is transport:
 * what it accepts, what it refuses before anything downstream sees it, and the
 * exact shape it returns.
 *
 * `result` is where the refusals matter. Null means the outcome is not known
 * yet — the ordinary state for a memory that was merely found or read — while
 * a blank string would record that there was a result and that it was nothing.
 * Only the first is allowed.
 *
 * Ownership, cross-project usage and the absence of read side effects need
 * real data and live in the integration suite.
 */

import { describe, expect, it } from 'vitest';

import {
  createChangeLogService,
  createMemoryControlService,
  createProblemCloseService,
  createProblemDeleteService,
  createEventService,
  createProblemService,
  createProblemStatusService,
  createProjectEnvironmentService,
  createRelationService,
  createVerificationService,
  RequestContextUnavailableError,
  ResourceNotFoundError,
  type AuthenticatedRequestContext,
  type CreateUsageLogCommand,
  type HealthService,
  type RequestContextService,
  type UsageLogRecord,
  type UsageLogService,
} from '../../src/app/index.js';
import { USAGE_ACTIONS } from '../../src/domain/enums.js';
import type { OwnerId } from '../../src/domain/owner.js';
import type { ProblemId } from '../../src/domain/problem.js';
import type { UsageLogId } from '../../src/domain/usage-log.js';
import { buildMemoryHttpApp } from '../../src/http/index.js';
import type { MemoryRepository } from '../../src/repository/index.js';

const OWNER_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const PROBLEM_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const MEMORY_ID = '9b2f1c4e-6d3a-4b8e-9f10-2c5d7e8a1b34';
const USAGE_LOG_ID = '1a7f3c58-2e94-4d61-b08a-5c3d9e7f6b21';
const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');

function usageLogRecord(overrides: Partial<UsageLogRecord> = {}): UsageLogRecord {
  return {
    usageLogId: USAGE_LOG_ID as UsageLogId,
    ownerId: OWNER_ID as OwnerId,
    problemId: PROBLEM_ID as ProblemId,
    sourceAi: 'claude-code',
    action: 'REFERENCED',
    memoryId: MEMORY_ID as ProblemId,
    reason: 'Authentication boundary and symptoms were similar.',
    result: null,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

/** Records what the transport layer passed on, so the mapping can be checked. */
interface ServiceCalls {
  createUsageLog?: { problemId: string; command: CreateUsageLogCommand };
  listUsageLogs?: string;
}

function serviceRecording(calls: ServiceCalls, record = usageLogRecord()): UsageLogService {
  return {
    createUsageLog: (_context, problemId, command) => {
      calls.createUsageLog = { problemId, command };
      return Promise.resolve(record);
    },
    listUsageLogs: (_context, problemId) => {
      calls.listUsageLogs = problemId;
      return Promise.resolve([record]);
    },
  };
}

function serviceFailing(error: Error): UsageLogService {
  return {
    createUsageLog: () => Promise.reject(error),
    listUsageLogs: () => Promise.reject(error),
  };
}

const healthService: HealthService = { check: () => Promise.resolve({ status: 'ok' }) };

function buildApp(service: UsageLogService, authenticated = true) {
  return buildMemoryHttpApp({
    healthService,
    requestContextService: authenticated
      ? ({
          authenticate: () =>
            Promise.resolve({
              repository: { ownerId: OWNER_ID } as unknown as MemoryRepository,
            } as AuthenticatedRequestContext),
        } satisfies RequestContextService)
      : { authenticate: () => Promise.reject(new RequestContextUnavailableError('unset')) },
    projectEnvironmentService: createProjectEnvironmentService(),
    problemService: createProblemService(),
    problemStatusService: createProblemStatusService(),
    eventService: createEventService(),
    verificationService: createVerificationService(),
    relationService: createRelationService(),
    usageLogService: service,
    changeLogService: createChangeLogService(),
    memoryControlService: createMemoryControlService(),
    problemCloseService: createProblemCloseService(),
    problemDeleteService: createProblemDeleteService(),
    logger: false,
  });
}

const URL = `/v1/problems/${PROBLEM_ID}/usage-logs`;

const VALID_CREATE = {
  source_ai: 'claude-code',
  action: 'REFERENCED',
  memory_id: MEMORY_ID,
  reason: 'Authentication boundary and symptoms were similar.',
};

describe('POST /v1/problems/:problem_id/usage-logs', () => {
  it('records the use and returns every field in snake_case', async () => {
    const app = buildApp(serviceRecording({}));

    const response = await app.inject({ method: 'POST', url: URL, payload: VALID_CREATE });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      usage_log_id: USAGE_LOG_ID,
      owner_id: OWNER_ID,
      problem_id: PROBLEM_ID,
      source_ai: 'claude-code',
      action: 'REFERENCED',
      memory_id: MEMORY_ID,
      reason: 'Authentication boundary and symptoms were similar.',
      result: null,
      created_at: '2026-01-01T00:00:00.000Z',
    });

    await app.close();
  });

  it('carries no updated_at and no version', async () => {
    const app = buildApp(serviceRecording({}));

    const response = await app.inject({ method: 'POST', url: URL, payload: VALID_CREATE });

    // Rows are added, never edited.
    expect(response.json()).not.toHaveProperty('updated_at');
    expect(response.json()).not.toHaveProperty('version');

    await app.close();
  });

  it('takes the problem being worked on from the path', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    await app.inject({ method: 'POST', url: URL, payload: VALID_CREATE });

    expect(calls.createUsageLog).toEqual({
      problemId: PROBLEM_ID,
      command: {
        sourceAi: 'claude-code',
        action: 'REFERENCED',
        memoryId: MEMORY_ID,
        reason: VALID_CREATE.reason,
      },
    });

    await app.close();
  });

  it('forwards a result only when it was sent', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls, usageLogRecord({ result: 'It worked.' })));

    await app.inject({
      method: 'POST',
      url: URL,
      payload: { ...VALID_CREATE, action: 'ADOPTED', result: 'It worked.' },
    });

    expect(calls.createUsageLog?.command.result).toBe('It worked.');

    await app.close();
  });

  it('accepts an explicit null result', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'POST',
      url: URL,
      payload: { ...VALID_CREATE, result: null },
    });

    // A memory that was found or read has no outcome yet, and saying so is
    // better than inventing one.
    expect(response.statusCode).toBe(201);
    expect(calls.createUsageLog?.command.result).toBeNull();

    await app.close();
  });

  it.each(USAGE_ACTIONS)('accepts action %s on its own', async (action) => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls, usageLogRecord({ action })));

    const response = await app.inject({
      method: 'POST',
      url: URL,
      payload: { ...VALID_CREATE, action },
    });

    // No order is required between the actions: an adapter reporting only
    // ADOPTED is recording something true, not skipping a step.
    expect(response.statusCode).toBe(201);
    expect(calls.createUsageLog?.command.action).toBe(action);

    await app.close();
  });

  it.each([
    ['no body at all', undefined],
    ['a missing source', { action: 'SEARCHED', memory_id: MEMORY_ID, reason: 'r' }],
    ['a missing action', { source_ai: 'x', memory_id: MEMORY_ID, reason: 'r' }],
    ['a missing memory', { source_ai: 'x', action: 'SEARCHED', reason: 'r' }],
    ['a missing reason', { source_ai: 'x', action: 'SEARCHED', memory_id: MEMORY_ID }],
    ['an empty source', { ...VALID_CREATE, source_ai: '' }],
    ['a whitespace-only source', { ...VALID_CREATE, source_ai: '   ' }],
    ['a non-string source', { ...VALID_CREATE, source_ai: 42 }],
    ['an unknown action', { ...VALID_CREATE, action: 'CONSIDERED' }],
    ['a lowercase action', { ...VALID_CREATE, action: 'referenced' }],
    ['an event type in its place', { ...VALID_CREATE, action: 'HYPOTHESIS' }],
    ['a null action', { ...VALID_CREATE, action: null }],
    ['a malformed memory', { ...VALID_CREATE, memory_id: 'not-a-uuid' }],
    ['an empty memory', { ...VALID_CREATE, memory_id: '' }],
    ['a null memory', { ...VALID_CREATE, memory_id: null }],
    ['an empty reason', { ...VALID_CREATE, reason: '' }],
    ['a whitespace-only reason', { ...VALID_CREATE, reason: '   ' }],
    ['a tab-only reason', { ...VALID_CREATE, reason: '\t' }],
    ['an empty result', { ...VALID_CREATE, result: '' }],
    ['a whitespace-only result', { ...VALID_CREATE, result: '   ' }],
    ['a non-string result', { ...VALID_CREATE, result: 42 }],
  ])('refuses %s', async (_label, payload) => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'POST',
      url: URL,
      payload: payload ?? '',
      headers: { 'content-type': 'application/json' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    expect(calls.createUsageLog).toBeUndefined();

    await app.close();
  });

  it.each([
    ['usage_log_id', USAGE_LOG_ID],
    ['owner_id', OWNER_ID],
    ['problem_id', PROBLEM_ID],
    ['created_at', '2026-01-01T00:00:00.000Z'],
    ['updated_at', '2026-01-01T00:00:00.000Z'],
    ['version', 1],
    ['expected_version', 1],
    ['client_event_id', MEMORY_ID],
    ['project_id', PROBLEM_ID],
    ['tool_id', 'anything'],
    ['surprise', 'anything'],
  ])('refuses a body containing %s', async (field, value) => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'POST',
      url: URL,
      payload: { ...VALID_CREATE, [field]: value },
    });

    // `problem_id` because the path already names it; `expected_version`
    // because writing a usage log is not a write to either Problem; `tool_id`
    // because this is not a global audit log.
    expect(response.statusCode).toBe(400);
    expect(calls.createUsageLog).toBeUndefined();

    await app.close();
  });

  it('refuses a malformed problem id in the path', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/problems/not-a-uuid/usage-logs',
      payload: VALID_CREATE,
    });

    expect(response.statusCode).toBe(400);
    expect(calls.createUsageLog).toBeUndefined();

    await app.close();
  });

  it('reports an unreachable problem as not found', async () => {
    const app = buildApp(serviceFailing(new ResourceNotFoundError()));

    const response = await app.inject({ method: 'POST', url: URL, payload: VALID_CREATE });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });

    await app.close();
  });

  it('requires an owner context', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls), false);

    const response = await app.inject({ method: 'POST', url: URL, payload: VALID_CREATE });

    expect(response.statusCode).toBe(401);
    expect(calls.createUsageLog).toBeUndefined();

    await app.close();
  });
});

describe('GET /v1/problems/:problem_id/usage-logs', () => {
  it('lists under a usage_logs key', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({ method: 'GET', url: URL });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      usage_logs: [
        {
          usage_log_id: USAGE_LOG_ID,
          owner_id: OWNER_ID,
          problem_id: PROBLEM_ID,
          source_ai: 'claude-code',
          action: 'REFERENCED',
          memory_id: MEMORY_ID,
          reason: 'Authentication boundary and symptoms were similar.',
          result: null,
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    expect(calls.listUsageLogs).toBe(PROBLEM_ID);

    await app.close();
  });

  it('returns an empty list rather than an error', async () => {
    const app = buildApp({
      createUsageLog: () => Promise.resolve(usageLogRecord()),
      listUsageLogs: () => Promise.resolve([]),
    });

    const response = await app.inject({ method: 'GET', url: URL });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ usage_logs: [] });

    await app.close();
  });

  it('refuses a malformed problem id in the path', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({ method: 'GET', url: '/v1/problems/nope/usage-logs' });

    expect(response.statusCode).toBe(400);
    expect(calls.listUsageLogs).toBeUndefined();

    await app.close();
  });

  it('requires an owner context', async () => {
    const app = buildApp(serviceRecording({}), false);

    const response = await app.inject({ method: 'GET', url: URL });

    expect(response.statusCode).toBe(401);

    await app.close();
  });
});

describe('usage logs are created and listed, and nothing else', () => {
  it.each(['PATCH', 'PUT', 'DELETE'])('%s on the collection is not served', async (method) => {
    const app = buildApp(serviceRecording({}));

    const response = await app.inject({
      method: method as 'DELETE' | 'PATCH' | 'PUT',
      url: URL,
      payload: {},
    });

    // Retention and correction policy is not decided yet, and a route would
    // decide it by accident.
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });

    await app.close();
  });

  it.each(['GET', 'PATCH', 'PUT', 'DELETE'])(
    '%s on a single usage log is not served',
    async (method) => {
      const app = buildApp(serviceRecording({}));

      const response = await app.inject({
        method: method as 'DELETE' | 'GET' | 'PATCH' | 'PUT',
        url: `/v1/usage-logs/${USAGE_LOG_ID}`,
        payload: {},
      });

      expect(response.statusCode).toBe(404);

      await app.close();
    },
  );

  it.each([
    '/v1/usage-logs',
    `/v1/problems/${PROBLEM_ID}/usage-logs/${USAGE_LOG_ID}`,
    // Not a global audit log: nothing here answers "what did this tool do?".
    '/v1/audit-logs',
    '/v1/tool-usage',
  ])('%s is not served', async (url) => {
    const app = buildApp(serviceRecording({}));

    const response = await app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(404);

    await app.close();
  });
});
