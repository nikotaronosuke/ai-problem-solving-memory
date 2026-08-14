/**
 * The ChangeLog request contract, driven through `inject()`.
 *
 * Reading only, so most of what this checks is what is *not* served. Entries
 * are written by the services that mutate a Problem, in the same transaction
 * as the change — a history a caller can author is not a history, and one it
 * can edit afterwards is worth less than none.
 *
 * Whether an entry is written, and what it may contain, needs real data and
 * lives in the integration suite.
 */

import { describe, expect, it } from 'vitest';

import {
  createMemoryControlService,
  createProblemCloseService,
  createExportService,
  createProblemDeleteService,
  createEventService,
  createProblemService,
  createProblemStatusService,
  createProjectEnvironmentService,
  createRelationService,
  createUsageLogService,
  createVerificationService,
  RequestContextUnavailableError,
  ResourceNotFoundError,
  type AuthenticatedRequestContext,
  type ChangeLogRecord,
  type ChangeLogService,
  type HealthService,
  type RequestContextService,
} from '../../src/app/index.js';
import type { ChangeLogId } from '../../src/domain/change-log.js';
import type { OwnerId } from '../../src/domain/owner.js';
import type { ProblemId } from '../../src/domain/problem.js';
import { buildMemoryHttpApp } from '../../src/http/index.js';
import type { MemoryRepository } from '../../src/repository/index.js';

const OWNER_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const PROBLEM_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const CHANGE_LOG_ID = '6b0d4f92-8c15-4a37-9e28-3d7f1c5a8b60';
const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');

function changeLogRecord(overrides: Partial<ChangeLogRecord> = {}): ChangeLogRecord {
  return {
    changeLogId: CHANGE_LOG_ID as ChangeLogId,
    ownerId: OWNER_ID as OwnerId,
    problemId: PROBLEM_ID as ProblemId,
    changedBy: 'claude-code',
    fromVersion: 1,
    toVersion: 2,
    changes: { confidence: { kind: 'exact', before: 'LOW', after: 'HIGH' } },
    createdAt: CREATED_AT,
    ...overrides,
  };
}

interface ServiceCalls {
  listChangeLogs?: string;
}

function serviceRecording(calls: ServiceCalls, record = changeLogRecord()): ChangeLogService {
  return {
    listChangeLogs: (_context, problemId) => {
      calls.listChangeLogs = problemId;
      return Promise.resolve([record]);
    },
  };
}

const healthService: HealthService = {
  check: () => Promise.resolve({ status: 'ok', latencyMs: 0 }),
};

function buildApp(service: ChangeLogService, authenticated = true) {
  return buildMemoryHttpApp({
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
    changeLogService: service,
    memoryControlService: createMemoryControlService(),
    problemCloseService: createProblemCloseService(),
    problemDeleteService: createProblemDeleteService(),
    exportService: createExportService(),
    logger: false,
  });
}

const URL = `/v1/problems/${PROBLEM_ID}/change-logs`;

describe('GET /v1/problems/:problem_id/change-logs', () => {
  it('lists under a change_logs key, in snake_case', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({ method: 'GET', url: URL });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      change_logs: [
        {
          change_log_id: CHANGE_LOG_ID,
          owner_id: OWNER_ID,
          problem_id: PROBLEM_ID,
          changed_by: 'claude-code',
          from_version: 1,
          to_version: 2,
          changes: { confidence: { kind: 'exact', before: 'LOW', after: 'HIGH' } },
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    expect(calls.listChangeLogs).toBe(PROBLEM_ID);

    await app.close();
  });

  it('passes a redacted text entry through unchanged', async () => {
    const app = buildApp(
      serviceRecording(
        {},
        changeLogRecord({
          changes: {
            title: {
              kind: 'text_redacted',
              before_present: true,
              after_present: true,
              changed: true,
            },
          },
        }),
      ),
    );

    const response = await app.inject({ method: 'GET', url: URL });

    // The shape is decided where the rule lives; reshaping it here would put
    // that rule in two places.
    expect(
      response.json<{ change_logs: { changes: unknown }[] }>().change_logs[0]?.changes,
    ).toEqual({
      title: {
        kind: 'text_redacted',
        before_present: true,
        after_present: true,
        changed: true,
      },
    });

    await app.close();
  });

  it('carries no updated_at and no version', async () => {
    const app = buildApp(serviceRecording({}));

    const response = await app.inject({ method: 'GET', url: URL });

    const [entry] = response.json<{ change_logs: Record<string, unknown>[] }>().change_logs;
    expect(entry).not.toHaveProperty('updated_at');
    expect(entry).not.toHaveProperty('version');

    await app.close();
  });

  it('returns an empty list rather than an error', async () => {
    const app = buildApp({ listChangeLogs: () => Promise.resolve([]) });

    const response = await app.inject({ method: 'GET', url: URL });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ change_logs: [] });

    await app.close();
  });

  it('reports an unreachable problem as not found', async () => {
    const app = buildApp({ listChangeLogs: () => Promise.reject(new ResourceNotFoundError()) });

    const response = await app.inject({ method: 'GET', url: URL });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });

    await app.close();
  });

  it('refuses a malformed problem id in the path', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({ method: 'GET', url: '/v1/problems/nope/change-logs' });

    expect(response.statusCode).toBe(400);
    expect(calls.listChangeLogs).toBeUndefined();

    await app.close();
  });

  it('requires an owner context', async () => {
    const app = buildApp(serviceRecording({}), false);

    const response = await app.inject({ method: 'GET', url: URL });

    expect(response.statusCode).toBe(401);

    await app.close();
  });
});

describe('history cannot be written or edited through the API', () => {
  it.each(['POST', 'PATCH', 'PUT', 'DELETE'])(
    '%s on the collection is not served',
    async (method) => {
      const app = buildApp(serviceRecording({}));

      const response = await app.inject({
        method: method as 'DELETE' | 'PATCH' | 'POST' | 'PUT',
        url: URL,
        payload: {
          changed_by: 'forger',
          from_version: 1,
          to_version: 2,
          changes: { confidence: { kind: 'exact', before: 'LOW', after: 'HIGH' } },
        },
      });

      // A history a caller can author is not a history, and one it can edit
      // afterwards is worth less than none.
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });

      await app.close();
    },
  );

  it.each(['GET', 'POST', 'PATCH', 'PUT', 'DELETE'])(
    '%s on a single entry is not served',
    async (method) => {
      const app = buildApp(serviceRecording({}));

      const response = await app.inject({
        method: method as 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT',
        url: `/v1/change-logs/${CHANGE_LOG_ID}`,
        payload: {},
      });

      expect(response.statusCode).toBe(404);

      await app.close();
    },
  );

  it.each([
    '/v1/change-logs',
    `/v1/problems/${PROBLEM_ID}/change-logs/${CHANGE_LOG_ID}`,
    // Not a global audit log.
    '/v1/audit-logs',
  ])('%s is not served', async (url) => {
    const app = buildApp(serviceRecording({}));

    const response = await app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(404);

    await app.close();
  });
});
