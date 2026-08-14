/**
 * The status transition request contract, driven through `inject()`.
 *
 * The application service is substituted, so what is under test is transport:
 * what it accepts, what it refuses before anything downstream sees it, and
 * that it returns the whole Problem in the usual shape.
 *
 * The body is deliberately narrow. A transition names where the Problem should
 * end up and nothing else — not where it is now, not the version it expects,
 * not the fix kind — so each of those is a 400 from the schema rather than
 * something a service has to notice.
 *
 * Which moves are legal is the domain rule's, and is tested there. What is
 * checked here is that transport does not decide it.
 */

import { describe, expect, it } from 'vitest';

import {
  createEventService,
  createProblemService,
  createProjectEnvironmentService,
  createRelationService,
  createUsageLogService,
  createChangeLogService,
  createMemoryControlService,
  createProblemCloseService,
  createExportService,
  createProblemDeleteService,
  createVerificationService,
  InvalidApplicationInputError,
  RequestContextUnavailableError,
  ResourceNotFoundError,
  type AuthenticatedRequestContext,
  type HealthService,
  type ProblemRecord,
  type ProblemStatusService,
  type TransitionCommand,
  type RequestContextService,
} from '../../src/app/index.js';
import { PROBLEM_STATUSES } from '../../src/domain/enums.js';
import type { EnvironmentId } from '../../src/domain/environment.js';
import type { OwnerId } from '../../src/domain/owner.js';
import type { ProblemId } from '../../src/domain/problem.js';
import type { ProjectId } from '../../src/domain/project.js';
import { buildMemoryHttpApp } from '../../src/http/index.js';
import type { MemoryRepository } from '../../src/repository/index.js';

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
    status: 'FIX_CANDIDATE',
    fixKind: null,
    importance: false,
    confidence: 'LOW',
    freshness: 'CURRENT',
    memoryReadEnabled: true,
    memoryWriteEnabled: true,
    suppressed: false,
    version: 1,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
  };
}

interface ServiceCalls {
  transition?: { problemId: string; command: TransitionCommand };
}

function serviceRecording(calls: ServiceCalls): ProblemStatusService {
  return {
    transition: (_context, problemId, command) => {
      calls.transition = { problemId, command };
      return Promise.resolve(
        problemRecord({ status: command.targetStatus, version: command.expectedVersion + 1 }),
      );
    },
  };
}

function serviceFailing(error: Error): ProblemStatusService {
  return { transition: () => Promise.reject(error) };
}

const healthService: HealthService = { check: () => Promise.resolve({ status: 'ok' }) };

function buildApp(service: ProblemStatusService, authenticated = true) {
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
    problemStatusService: service,
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
}

const URL = `/v1/problems/${PROBLEM_ID}/status-transitions`;

describe('POST /v1/problems/:problem_id/status-transitions', () => {
  it('returns the whole updated problem, not just the status', async () => {
    const app = buildApp(serviceRecording({}));

    const response = await app.inject({
      method: 'POST',
      url: URL,
      payload: { target_status: 'VERIFIED', expected_version: 1, changed_by: 'claude-code' },
    });

    // 200, not 201: nothing was created, an existing problem moved.
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      problem_id: PROBLEM_ID,
      owner_id: OWNER_ID,
      project_id: PROJECT_ID,
      environment_id: ENVIRONMENT_ID,
      title: 'Sign-in fails after deploying',
      symptoms: 'Works locally, fails on preview.',
      problem_domain: null,
      suspected_boundary: null,
      source_ai: null,
      status: 'VERIFIED',
      fix_kind: null,
      importance: false,
      confidence: 'LOW',
      freshness: 'CURRENT',
      memory_read_enabled: true,
      memory_write_enabled: true,
      suppressed: false,
      // The write happened, so the version the caller must send next moved on.
      version: 2,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
    });

    await app.close();
  });

  it('takes the problem from the path', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    await app.inject({
      method: 'POST',
      url: URL,
      payload: { target_status: 'PAUSED', expected_version: 1, changed_by: 'claude-code' },
    });

    expect(calls.transition).toEqual({
      problemId: PROBLEM_ID,
      command: { targetStatus: 'PAUSED', expectedVersion: 1, changedBy: 'claude-code' },
    });

    await app.close();
  });

  it.each(PROBLEM_STATUSES)('passes %s through to the service', async (status) => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'POST',
      url: URL,
      payload: { target_status: status, expected_version: 1, changed_by: 'claude-code' },
    });

    // Transport does not decide which moves are legal; every canonical status
    // reaches the service, which asks the domain rule.
    expect(response.statusCode).toBe(200);
    expect(calls.transition?.command.targetStatus).toBe(status);

    await app.close();
  });

  it.each([
    ['no body at all', undefined],
    ['a missing target status', { expected_version: 1, changed_by: 'claude-code' }],
    [
      'an unknown status',
      { target_status: 'RESOLVED', expected_version: 1, changed_by: 'claude-code' },
    ],
    [
      'a retired status name',
      { target_status: 'OPEN', expected_version: 1, changed_by: 'claude-code' },
    ],
    [
      'a lowercase status',
      { target_status: 'verified', expected_version: 1, changed_by: 'claude-code' },
    ],
    ['a null status', { target_status: null, expected_version: 1, changed_by: 'claude-code' }],
    ['a non-string status', { target_status: 3, expected_version: 1, changed_by: 'claude-code' }],
    ['an empty status', { target_status: '', expected_version: 1, changed_by: 'claude-code' }],
    ['a missing expected version', { target_status: 'PAUSED', changed_by: 'claude-code' }],
    ['a missing changed_by', { target_status: 'PAUSED', expected_version: 1 }],
    ['an empty changed_by', { target_status: 'PAUSED', expected_version: 1, changed_by: '' }],
    [
      'a whitespace-only changed_by',
      { target_status: 'PAUSED', expected_version: 1, changed_by: '   ' },
    ],
    ['a non-string changed_by', { target_status: 'PAUSED', expected_version: 1, changed_by: 7 }],
    [
      'a string expected version',
      { target_status: 'PAUSED', expected_version: '1', changed_by: 'c' },
    ],
    [
      'a fractional expected version',
      { target_status: 'PAUSED', expected_version: 1.5, changed_by: 'c' },
    ],
    ['a zero expected version', { target_status: 'PAUSED', expected_version: 0, changed_by: 'c' }],
    [
      'a negative expected version',
      { target_status: 'PAUSED', expected_version: -1, changed_by: 'c' },
    ],
    [
      'a null expected version',
      { target_status: 'PAUSED', expected_version: null, changed_by: 'c' },
    ],
    [
      'a boolean expected version',
      { target_status: 'PAUSED', expected_version: true, changed_by: 'c' },
    ],
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
    expect(calls.transition).toBeUndefined();

    await app.close();
  });

  it.each([
    ['status', 'PAUSED'],
    ['current_status', 'INVESTIGATING'],
    ['problem_id', PROBLEM_ID],
    ['owner_id', OWNER_ID],
    ['version', 1],
    ['fix_kind', 'ROOT_FIX'],
    ['confidence', 'HIGH'],
    ['created_at', '2026-01-01T00:00:00.000Z'],
    ['surprise', 'anything'],
  ])('refuses a body containing %s', async (field, value) => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'POST',
      url: URL,
      payload: {
        target_status: 'PAUSED',
        expected_version: 1,
        changed_by: 'claude-code',
        [field]: value,
      },
    });

    // `expected_version` in particular: optimistic locking is P2-07's, and
    // accepting the field now would imply a guarantee nothing provides.
    expect(response.statusCode).toBe(400);
    expect(calls.transition).toBeUndefined();

    await app.close();
  });

  it('reports a refused transition as invalid input', async () => {
    const app = buildApp(
      serviceFailing(
        new InvalidApplicationInputError(
          'A problem can only be verified once a successful verification exists.',
        ),
      ),
    );

    const response = await app.inject({
      method: 'POST',
      url: URL,
      payload: { target_status: 'VERIFIED', expected_version: 1, changed_by: 'claude-code' },
    });

    // No new code and no 409. P2-07 introduces the vocabulary for conflicts;
    // borrowing part of it here would leave two tasks describing one thing.
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'INVALID_REQUEST', message: 'Request validation failed.' },
    });

    await app.close();
  });

  it('does not leak the domain’s reasoning to the client', async () => {
    const app = buildApp(
      serviceFailing(new InvalidApplicationInputError('A problem is already in that status.')),
    );

    const response = await app.inject({
      method: 'POST',
      url: URL,
      payload: { target_status: 'FIX_CANDIDATE', expected_version: 1, changed_by: 'claude-code' },
    });

    // The envelope is the contract; the specific reason stays in the log,
    // exactly as for every other application-level refusal.
    expect(response.body).not.toContain('already in that status');

    await app.close();
  });

  it('reports an unknown problem as not found', async () => {
    const app = buildApp(serviceFailing(new ResourceNotFoundError()));

    const response = await app.inject({
      method: 'POST',
      url: URL,
      payload: { target_status: 'PAUSED', expected_version: 1, changed_by: 'claude-code' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });

    await app.close();
  });

  it('refuses a malformed problem id in the path', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/problems/not-a-uuid/status-transitions',
      payload: { target_status: 'PAUSED', expected_version: 1, changed_by: 'claude-code' },
    });

    expect(response.statusCode).toBe(400);
    expect(calls.transition).toBeUndefined();

    await app.close();
  });

  it('requires an owner context', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls), false);

    const response = await app.inject({
      method: 'POST',
      url: URL,
      payload: { target_status: 'PAUSED', expected_version: 1, changed_by: 'claude-code' },
    });

    expect(response.statusCode).toBe(401);
    expect(calls.transition).toBeUndefined();

    await app.close();
  });
});

describe('status has exactly one write path', () => {
  it.each(['status', 'fix_kind', 'version', 'expected_version'])(
    'the problem PATCH still refuses %s',
    async (field) => {
      const app = buildApp(serviceRecording({}));

      const response = await app.inject({
        method: 'PATCH',
        url: `/v1/problems/${PROBLEM_ID}`,
        payload: { [field]: field === 'version' || field === 'expected_version' ? 2 : 'PAUSED' },
      });

      // Adding the transition route must not have widened the generic update.
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });

      await app.close();
    },
  );

  it.each(['GET', 'PATCH', 'PUT', 'DELETE'])(
    '%s on the transitions collection is not served',
    async (method) => {
      const app = buildApp(serviceRecording({}));

      const response = await app.inject({
        method: method as 'DELETE' | 'GET' | 'PATCH' | 'PUT',
        url: URL,
        payload: {},
      });

      // Only POST. A transition is an action, not a resource to read or edit.
      expect(response.statusCode).toBe(404);

      await app.close();
    },
  );

  it.each([
    `/v1/problems/${PROBLEM_ID}/status`,
    `/v1/problems/${PROBLEM_ID}/transitions`,
    '/v1/status-transitions',
  ])('%s is not served', async (url) => {
    const app = buildApp(serviceRecording({}));

    const response = await app.inject({
      method: 'POST',
      url,
      payload: { target_status: 'PAUSED', expected_version: 1, changed_by: 'claude-code' },
    });

    expect(response.statusCode).toBe(404);

    await app.close();
  });
});
