/**
 * The close request contract, driven through `inject()`.
 *
 * The application service is substituted, so what is under test is transport:
 * what it accepts, what it refuses before anything downstream sees it, and the
 * exact shape it returns.
 *
 * The refusal worth noting is the working statuses. `INVESTIGATING` and
 * `FIX_CANDIDATE` are not conclusions, and accepting them here would leave two
 * surfaces doing the same move — the transition route already does it.
 *
 * Whether the matrix and the evidence gate hold, and what the summaries become,
 * needs real data and lives in the integration suite.
 */

import { describe, expect, it } from 'vitest';

import {
  createChangeLogService,
  createEventService,
  createMemoryControlService,
  createExportService,
  createProblemDeleteService,
  createProblemService,
  createProblemStatusService,
  createProjectEnvironmentService,
  createRelationService,
  createUsageLogService,
  createVerificationService,
  InvalidApplicationInputError,
  ProblemVersionConflictError,
  RequestContextUnavailableError,
  ResourceNotFoundError,
  type AuthenticatedRequestContext,
  type CloseProblemCommand,
  type HealthService,
  type ProblemCloseService,
  type ProblemRecord,
  type RequestContextService,
} from '../../src/app/index.js';
import { FIX_KINDS } from '../../src/domain/enums.js';
import type { EnvironmentId } from '../../src/domain/environment.js';
import type { OwnerId } from '../../src/domain/owner.js';
import { CONCLUSION_PROBLEM_STATUSES } from '../../src/domain/problem-status.js';
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
    version: 4,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
  };
}

interface ServiceCalls {
  closeProblem?: { problemId: string; command: CloseProblemCommand };
}

function serviceRecording(calls: ServiceCalls, record = problemRecord()): ProblemCloseService {
  return {
    closeProblem: (_context, problemId, command) => {
      calls.closeProblem = { problemId, command };
      return Promise.resolve(record);
    },
  };
}

function serviceFailing(error: Error): ProblemCloseService {
  return { closeProblem: () => Promise.reject(error) };
}

const healthService: HealthService = {
  check: () => Promise.resolve({ status: 'ok', latencyMs: 0 }),
};

function buildApp(service: ProblemCloseService, authenticated = true) {
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
    changeLogService: createChangeLogService(),
    memoryControlService: createMemoryControlService(),
    problemCloseService: service,
    problemDeleteService: createProblemDeleteService(),
    exportService: createExportService(),
    logger: false,
  });
}

const URL = `/v1/problems/${PROBLEM_ID}/close`;
const TOKENS = { expected_version: 4, changed_by: 'claude-code' };

describe('POST /v1/problems/:problem_id/close', () => {
  it('returns the whole problem, not a close-specific resource', async () => {
    const app = buildApp(
      serviceRecording({}, problemRecord({ status: 'VERIFIED', fixKind: 'ROOT_FIX', version: 5 })),
    );

    const response = await app.inject({
      method: 'POST',
      url: URL,
      payload: { ...TOKENS, target_status: 'VERIFIED', fix_kind: 'ROOT_FIX' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      problem_id: PROBLEM_ID,
      status: 'VERIFIED',
      fix_kind: 'ROOT_FIX',
      // One act, one version step.
      version: 5,
    });

    await app.close();
  });

  it('takes the problem from the path', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    await app.inject({
      method: 'POST',
      url: URL,
      payload: { ...TOKENS, target_status: 'PAUSED' },
    });

    expect(calls.closeProblem).toEqual({
      problemId: PROBLEM_ID,
      command: { expectedVersion: 4, changedBy: 'claude-code', targetStatus: 'PAUSED' },
    });

    await app.close();
  });

  it.each(CONCLUSION_PROBLEM_STATUSES)('accepts %s as a conclusion', async (targetStatus) => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls, problemRecord({ status: targetStatus })));

    const response = await app.inject({
      method: 'POST',
      url: URL,
      payload: { ...TOKENS, target_status: targetStatus },
    });

    expect(response.statusCode).toBe(200);
    expect(calls.closeProblem?.command.targetStatus).toBe(targetStatus);

    await app.close();
  });

  it.each(['INVESTIGATING', 'FIX_CANDIDATE'])(
    'refuses %s, which is not a conclusion',
    async (targetStatus) => {
      const calls: ServiceCalls = {};
      const app = buildApp(serviceRecording(calls));

      const response = await app.inject({
        method: 'POST',
        url: URL,
        payload: { ...TOKENS, target_status: targetStatus },
      });

      // Moving between working states is the transition route's job. Two
      // surfaces doing the same move is worse than one of them saying no.
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
      expect(calls.closeProblem).toBeUndefined();

      await app.close();
    },
  );

  it.each(FIX_KINDS)('forwards fix kind %s', async (fixKind) => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls, problemRecord({ fixKind })));

    const response = await app.inject({
      method: 'POST',
      url: URL,
      payload: { ...TOKENS, target_status: 'CLOSED_UNRESOLVED', fix_kind: fixKind },
    });

    expect(response.statusCode).toBe(200);
    expect(calls.closeProblem?.command.fixKind).toBe(fixKind);

    await app.close();
  });

  it('forwards an explicit null fix kind as a clear', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    await app.inject({
      method: 'POST',
      url: URL,
      payload: { ...TOKENS, target_status: 'PAUSED', fix_kind: null },
    });

    expect(calls.closeProblem?.command.fixKind).toBeNull();

    await app.close();
  });

  it('leaves fix kind out of the command when it was not sent', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    await app.inject({
      method: 'POST',
      url: URL,
      payload: { ...TOKENS, target_status: 'PAUSED' },
    });

    // Absent and null are different instructions: leave it, versus clear it.
    expect(calls.closeProblem?.command).not.toHaveProperty('fixKind');

    await app.close();
  });

  it('forwards the review summaries, trimmed by the schema’s pattern only', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    await app.inject({
      method: 'POST',
      url: URL,
      payload: {
        ...TOKENS,
        target_status: 'CLOSED_UNRESOLVED',
        final_cause_summary: 'The provider redirect never matched.',
        effective_direction: 'Align the registered redirect.',
        dead_end_summary: 'Changing the app route alone did nothing.',
        unresolved_points: 'Why preview differs from production is still open.',
      },
    });

    expect(calls.closeProblem?.command).toMatchObject({
      finalCauseSummary: 'The provider redirect never matched.',
      effectiveDirection: 'Align the registered redirect.',
      deadEndSummary: 'Changing the app route alone did nothing.',
      unresolvedPoints: 'Why preview differs from production is still open.',
    });

    await app.close();
  });

  it('accepts a close with no summaries at all', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'POST',
      url: URL,
      payload: { ...TOKENS, target_status: 'PAUSED' },
    });

    // The event history may already say everything worth saying; a forced
    // summary would be filler.
    expect(response.statusCode).toBe(200);
    expect(calls.closeProblem?.command).not.toHaveProperty('finalCauseSummary');

    await app.close();
  });

  it.each([
    ['no body at all', undefined],
    ['a missing target', { ...TOKENS }],
    ['a missing version', { changed_by: 'x', target_status: 'PAUSED' }],
    ['a missing signature', { expected_version: 4, target_status: 'PAUSED' }],
    ['an empty signature', { ...TOKENS, changed_by: '', target_status: 'PAUSED' }],
    ['a whitespace-only signature', { ...TOKENS, changed_by: '  ', target_status: 'PAUSED' }],
    ['a string version', { ...TOKENS, expected_version: '4', target_status: 'PAUSED' }],
    ['a zero version', { ...TOKENS, expected_version: 0, target_status: 'PAUSED' }],
    ['an unknown status', { ...TOKENS, target_status: 'RESOLVED' }],
    ['a lowercase status', { ...TOKENS, target_status: 'verified' }],
    ['a null status', { ...TOKENS, target_status: null }],
    ['an unknown fix kind', { ...TOKENS, target_status: 'PAUSED', fix_kind: 'PARTIAL' }],
    ['a lowercase fix kind', { ...TOKENS, target_status: 'PAUSED', fix_kind: 'root_fix' }],
    ['a numeric fix kind', { ...TOKENS, target_status: 'PAUSED', fix_kind: 1 }],
    ['an empty summary', { ...TOKENS, target_status: 'PAUSED', final_cause_summary: '' }],
    ['a blank summary', { ...TOKENS, target_status: 'PAUSED', effective_direction: '   ' }],
    ['a tab-only summary', { ...TOKENS, target_status: 'PAUSED', dead_end_summary: '\t' }],
    ['a null summary', { ...TOKENS, target_status: 'PAUSED', unresolved_points: null }],
    ['a non-string summary', { ...TOKENS, target_status: 'PAUSED', final_cause_summary: 42 }],
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
    expect(calls.closeProblem).toBeUndefined();

    await app.close();
  });

  it.each([
    ['status', 'VERIFIED'],
    ['version', 5],
    ['owner_id', OWNER_ID],
    ['problem_id', PROBLEM_ID],
    ['freshness', 'CURRENT'],
    ['confidence', 'HIGH'],
    ['importance', true],
    ['suppressed', true],
    ['memory_read_enabled', false],
    ['created_at', '2026-01-01T00:00:00.000Z'],
    ['updated_at', '2026-01-01T00:00:00.000Z'],
    ['client_event_id', PROBLEM_ID],
    ['result', true],
    ['surprise', 'anything'],
  ])('refuses a body containing %s', async (field, value) => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'POST',
      url: URL,
      payload: { ...TOKENS, target_status: 'PAUSED', [field]: value },
    });

    // A conclusion says how the work ended. It is not an opportunity to edit
    // the record, and it does not supply its own evidence.
    expect(response.statusCode).toBe(400);
    expect(calls.closeProblem).toBeUndefined();

    await app.close();
  });

  it('refuses a malformed problem id in the path', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/problems/not-a-uuid/close',
      payload: { ...TOKENS, target_status: 'PAUSED' },
    });

    expect(response.statusCode).toBe(400);
    expect(calls.closeProblem).toBeUndefined();

    await app.close();
  });

  it('reports an unreachable problem as not found', async () => {
    const app = buildApp(serviceFailing(new ResourceNotFoundError()));

    const response = await app.inject({
      method: 'POST',
      url: URL,
      payload: { ...TOKENS, target_status: 'PAUSED' },
    });

    expect(response.statusCode).toBe(404);

    await app.close();
  });

  it('reports a refused conclusion as invalid input', async () => {
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
      payload: { ...TOKENS, target_status: 'VERIFIED' },
    });

    expect(response.statusCode).toBe(400);
    // The envelope is the contract; the reason stays in the log.
    expect(response.body).not.toContain('successful verification');

    await app.close();
  });

  it('reports a stale version as a conflict', async () => {
    const app = buildApp(serviceFailing(new ProblemVersionConflictError()));

    const response = await app.inject({
      method: 'POST',
      url: URL,
      payload: { ...TOKENS, target_status: 'PAUSED' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: 'VERSION_CONFLICT' } });

    await app.close();
  });

  it('requires an owner context', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls), false);

    const response = await app.inject({
      method: 'POST',
      url: URL,
      payload: { ...TOKENS, target_status: 'PAUSED' },
    });

    expect(response.statusCode).toBe(401);
    expect(calls.closeProblem).toBeUndefined();

    await app.close();
  });
});

describe('closing is one route, and POST only', () => {
  it.each(['GET', 'PATCH', 'PUT', 'DELETE'])('%s is not served', async (method) => {
    const app = buildApp(serviceRecording({}));

    const response = await app.inject({
      method: method as 'DELETE' | 'GET' | 'PATCH' | 'PUT',
      url: URL,
      payload: { ...TOKENS, target_status: 'PAUSED' },
    });

    expect(response.statusCode).toBe(404);

    await app.close();
  });

  it.each([
    `/v1/problems/${PROBLEM_ID}/review`,
    `/v1/problems/${PROBLEM_ID}/reviews`,
    `/v1/problems/${PROBLEM_ID}/closures`,
    `/v1/problems/${PROBLEM_ID}/fix-kind`,
    '/v1/close',
  ])('%s is not served', async (url) => {
    const app = buildApp(serviceRecording({}));

    const response = await app.inject({
      method: 'POST',
      url,
      payload: { ...TOKENS, target_status: 'PAUSED' },
    });

    // Review is part of closing, not a surface of its own.
    expect(response.statusCode).toBe(404);

    await app.close();
  });
});

describe('the other write surfaces are unchanged', () => {
  it.each(['fix_kind', 'status'])('the ordinary problem update still refuses %s', async (field) => {
    const app = buildApp(serviceRecording({}));

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/problems/${PROBLEM_ID}`,
      payload: {
        expected_version: 4,
        changed_by: 'claude-code',
        [field]: field === 'fix_kind' ? 'ROOT_FIX' : 'VERIFIED',
      },
    });

    // Closing is the only way a fix kind is written in this phase.
    expect(response.statusCode).toBe(400);

    await app.close();
  });

  it('the memory control route still refuses fix_kind', async () => {
    const app = buildApp(serviceRecording({}));

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/problems/${PROBLEM_ID}/memory-control`,
      payload: { expected_version: 4, changed_by: 'claude-code', fix_kind: 'ROOT_FIX' },
    });

    expect(response.statusCode).toBe(400);

    await app.close();
  });

  it('the status transition route still refuses fix_kind', async () => {
    const app = buildApp(serviceRecording({}));

    const response = await app.inject({
      method: 'POST',
      url: `/v1/problems/${PROBLEM_ID}/status-transitions`,
      payload: {
        expected_version: 4,
        changed_by: 'claude-code',
        target_status: 'PAUSED',
        fix_kind: 'ROOT_FIX',
      },
    });

    expect(response.statusCode).toBe(400);

    await app.close();
  });
});
