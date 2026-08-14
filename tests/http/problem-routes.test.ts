/**
 * The Problem request contract, driven through `inject()`.
 *
 * The application service is substituted, so this is about what transport
 * accepts and refuses, and the exact shape it returns.
 *
 * The write boundary is the substance here. A caller may describe a problem
 * and adjust how it is judged and surfaced. It may not assert what state the
 * problem is in: `status` is P2-06's, `version` is P2-07's, `fix_kind` is
 * P2-12's, and all three are readable but not writable.
 */

import { describe, expect, it } from 'vitest';

import {
  createProblemStatusService,
  createVerificationService,
  createEventService,
  createProjectEnvironmentService,
  createRelationService,
  createUsageLogService,
  createChangeLogService,
  createMemoryControlService,
  createProblemCloseService,
  createExportService,
  createProblemDeleteService,
  RequestContextUnavailableError,
  type AuthenticatedRequestContext,
  type CreateProblemCommand,
  type HealthService,
  type ProblemRecord,
  type ProblemService,
  type RequestContextService,
  type UpdateProblemCommand,
} from '../../src/app/index.js';
import { CONFIDENCES, FRESHNESSES } from '../../src/domain/enums.js';
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
    status: 'INVESTIGATING',
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
  createProblem?: { projectId: string; command: CreateProblemCommand };
  updateProblem?: { problemId: string; command: UpdateProblemCommand };
  getProblem?: string;
  listProblems?: string;
}

function serviceRecording(calls: ServiceCalls): ProblemService {
  return {
    createProblem: (_context, projectId, command) => {
      calls.createProblem = { projectId, command };
      return Promise.resolve(problemRecord());
    },
    getProblem: (_context, problemId) => {
      calls.getProblem = problemId;
      return Promise.resolve(problemRecord());
    },
    listProblems: (_context, projectId) => {
      calls.listProblems = projectId;
      return Promise.resolve([problemRecord()]);
    },
    updateProblem: (_context, problemId, command) => {
      calls.updateProblem = { problemId, command };
      return Promise.resolve(problemRecord());
    },
  };
}

const healthService: HealthService = {
  check: () => Promise.resolve({ status: 'ok', latencyMs: 0 }),
};

function buildApp(service: ProblemService, authenticated = true) {
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
    problemService: service,
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
}

const VALID_CREATE = {
  environment_id: ENVIRONMENT_ID,
  title: 'Sign-in fails after deploying',
  symptoms: 'Works locally, fails on preview.',
};

describe('POST /v1/projects/:project_id/problems', () => {
  it('creates a problem and returns every field in snake_case', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'POST',
      url: `/v1/projects/${PROJECT_ID}/problems`,
      payload: VALID_CREATE,
    });

    expect(response.statusCode).toBe(201);
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
      // A new problem is under investigation, unverified and untrusted.
      status: 'INVESTIGATING',
      fix_kind: null,
      importance: false,
      confidence: 'LOW',
      freshness: 'CURRENT',
      memory_read_enabled: true,
      memory_write_enabled: true,
      suppressed: false,
      version: 1,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
    });
    expect(calls.createProblem?.projectId).toBe(PROJECT_ID);

    await app.close();
  });

  it('forwards optional text only when it was sent', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    await app.inject({
      method: 'POST',
      url: `/v1/projects/${PROJECT_ID}/problems`,
      payload: { ...VALID_CREATE, problem_domain: 'auth', source_ai: null },
    });

    expect(calls.createProblem?.command).toEqual({
      environmentId: ENVIRONMENT_ID,
      title: VALID_CREATE.title,
      symptoms: VALID_CREATE.symptoms,
      problemDomain: 'auth',
      sourceAi: null,
    });

    await app.close();
  });

  it.each([
    ['a missing environment_id', { title: 't', symptoms: 's' }],
    ['a missing title', { environment_id: ENVIRONMENT_ID, symptoms: 's' }],
    ['a missing symptoms', { environment_id: ENVIRONMENT_ID, title: 't' }],
    ['a malformed environment_id', { ...VALID_CREATE, environment_id: 'not-a-uuid' }],
    ['a whitespace-only title', { ...VALID_CREATE, title: '   ' }],
    ['a whitespace-only symptoms', { ...VALID_CREATE, symptoms: '\t' }],
    ['an empty title', { ...VALID_CREATE, title: '' }],
  ])('refuses %s', async (_label, payload) => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'POST',
      url: `/v1/projects/${PROJECT_ID}/problems`,
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    expect(calls.createProblem).toBeUndefined();

    await app.close();
  });

  it.each([
    'owner_id',
    'problem_id',
    'project_id',
    'status',
    'fix_kind',
    'importance',
    'confidence',
    'freshness',
    'memory_read_enabled',
    'memory_write_enabled',
    'suppressed',
    'version',
    'created_at',
    'updated_at',
    'surprise',
  ])('refuses a create body that sets %s', async (field) => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'POST',
      url: `/v1/projects/${PROJECT_ID}/problems`,
      payload: { ...VALID_CREATE, [field]: 'anything' },
    });

    // The initial state is the database's to decide. A caller cannot file a
    // problem that already claims to be verified or trusted.
    expect(response.statusCode).toBe(400);
    expect(calls.createProblem).toBeUndefined();

    await app.close();
  });

  it('refuses a malformed project id in the path', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/projects/not-a-uuid/problems',
      payload: VALID_CREATE,
    });

    expect(response.statusCode).toBe(400);
    expect(calls.createProblem).toBeUndefined();

    await app.close();
  });

  it('requires an owner context', async () => {
    const app = buildApp(serviceRecording({}), false);

    const response = await app.inject({
      method: 'POST',
      url: `/v1/projects/${PROJECT_ID}/problems`,
      payload: VALID_CREATE,
    });

    expect(response.statusCode).toBe(401);

    await app.close();
  });
});

describe('GET /v1/problems/:problem_id', () => {
  it('returns the problem', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({ method: 'GET', url: `/v1/problems/${PROBLEM_ID}` });

    expect(response.statusCode).toBe(200);
    expect(calls.getProblem).toBe(PROBLEM_ID);

    await app.close();
  });

  it.each(['not-a-uuid', '12345'])('refuses a malformed id (%s)', async (badId) => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({ method: 'GET', url: `/v1/problems/${badId}` });

    expect(response.statusCode).toBe(400);
    expect(calls.getProblem).toBeUndefined();

    await app.close();
  });
});

describe('GET /v1/projects/:project_id/problems', () => {
  it('lists under a problems key', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'GET',
      url: `/v1/projects/${PROJECT_ID}/problems`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ problems: unknown[] }>().problems).toHaveLength(1);
    expect(calls.listProblems).toBe(PROJECT_ID);

    await app.close();
  });

  it('returns an empty list rather than an error', async () => {
    const app = buildApp({ ...serviceRecording({}), listProblems: () => Promise.resolve([]) });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/projects/${PROJECT_ID}/problems`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ problems: [] });

    await app.close();
  });
});

describe('PATCH /v1/problems/:problem_id', () => {
  it.each([
    ['the title', { title: 'renamed' }, { title: 'renamed' }],
    ['the symptoms', { symptoms: 'new detail' }, { symptoms: 'new detail' }],
    ['the domain', { problem_domain: 'build' }, { problemDomain: 'build' }],
    ['the domain cleared', { problem_domain: null }, { problemDomain: null }],
    ['the suspected boundary', { suspected_boundary: 'bundler' }, { suspectedBoundary: 'bundler' }],
    ['the boundary cleared', { suspected_boundary: null }, { suspectedBoundary: null }],
    ['the source', { source_ai: 'claude-code' }, { sourceAi: 'claude-code' }],
    ['the source cleared', { source_ai: null }, { sourceAi: null }],
    ['a blank domain', { problem_domain: '   ' }, { problemDomain: '   ' }],
    ['importance on', { importance: true }, { importance: true }],
    ['importance off', { importance: false }, { importance: false }],
    ['reads disabled', { memory_read_enabled: false }, { memoryReadEnabled: false }],
    ['writes disabled', { memory_write_enabled: false }, { memoryWriteEnabled: false }],
    ['suppression on', { suppressed: true }, { suppressed: true }],
    [
      'several fields at once',
      { title: 't', importance: true, confidence: 'HIGH', suppressed: true },
      { title: 't', importance: true, confidence: 'HIGH', suppressed: true },
    ],
  ])('forwards %s and nothing else', async (_label, payload, expected) => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/problems/${PROBLEM_ID}`,
      payload: { ...payload, expected_version: 4, changed_by: 'claude-code' },
    });

    expect(response.statusCode).toBe(200);
    // Omitted fields are absent, not undefined, so the service can tell
    // "leave alone" from "clear". The token travels alongside them.
    expect(calls.updateProblem?.command).toEqual({
      ...expected,
      expectedVersion: 4,
      changedBy: 'claude-code',
    });
    expect(calls.updateProblem?.problemId).toBe(PROBLEM_ID);

    await app.close();
  });

  it.each(CONFIDENCES)('accepts confidence %s', async (confidence) => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/problems/${PROBLEM_ID}`,
      payload: { confidence, expected_version: 4, changed_by: 'claude-code' },
    });

    expect(response.statusCode).toBe(200);
    expect(calls.updateProblem?.command).toEqual({
      confidence,
      expectedVersion: 4,
      changedBy: 'claude-code',
    });

    await app.close();
  });

  it.each(FRESHNESSES)('accepts freshness %s', async (freshness) => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/problems/${PROBLEM_ID}`,
      payload: { freshness, expected_version: 4, changed_by: 'claude-code' },
    });

    expect(response.statusCode).toBe(200);
    expect(calls.updateProblem?.command).toEqual({
      freshness,
      expectedVersion: 4,
      changedBy: 'claude-code',
    });

    await app.close();
  });

  it.each([
    ['an empty body', {}],
    // `expected_version` and `changed_by` are a concurrency token and a
    // signature, not fields being changed, so a body carrying only them
    // changes nothing.
    ['only the expected version', { expected_version: 4 }],
    ['only the token and the signature', { expected_version: 4, changed_by: 'claude-code' }],
    ['a missing expected version', { title: 'renamed', changed_by: 'claude-code' }],
    ['a missing changed_by', { title: 'renamed', expected_version: 4 }],
    ['an empty changed_by', { title: 'renamed', expected_version: 4, changed_by: '' }],
    ['a whitespace-only changed_by', { title: 'x', expected_version: 4, changed_by: '   ' }],
    ['a non-string changed_by', { title: 'x', expected_version: 4, changed_by: 42 }],
  ])('refuses a patch with %s', async (_label, payload) => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/problems/${PROBLEM_ID}`,
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(calls.updateProblem).toBeUndefined();

    await app.close();
  });

  it.each([
    ['a string expected version', { expected_version: '4' }],
    ['a fractional expected version', { expected_version: 4.5 }],
    ['a zero expected version', { expected_version: 0 }],
    ['a negative expected version', { expected_version: -1 }],
    ['a null expected version', { expected_version: null }],
    ['a boolean expected version', { expected_version: true }],
  ])('refuses %s', async (_label, payload) => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/problems/${PROBLEM_ID}`,
      payload: { ...payload, changed_by: 'claude-code', title: 'renamed' },
    });

    // A concurrency token that can be misread is not one, so nothing is
    // coerced on the way through.
    expect(response.statusCode).toBe(400);
    expect(calls.updateProblem).toBeUndefined();

    await app.close();
  });

  it.each([
    ['status', { status: 'VERIFIED' }],
    ['status even to a valid non-verified value', { status: 'PAUSED' }],
    ['fix_kind', { fix_kind: 'ROOT_FIX' }],
    ['version', { version: 2 }],
    ['owner_id', { owner_id: OWNER_ID }],
    ['problem_id', { problem_id: PROBLEM_ID }],
    ['project_id', { project_id: PROJECT_ID }],
    ['environment_id', { environment_id: ENVIRONMENT_ID }],
    ['created_at', { created_at: '2020-01-01T00:00:00.000Z' }],
    ['updated_at', { updated_at: '2020-01-01T00:00:00.000Z' }],
    ['an unknown field', { surprise: true }],
  ])('refuses a patch that sets %s', async (_label, payload) => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/problems/${PROBLEM_ID}`,
      // A valid token and a real change, so the refusal is attributable to
      // the field under test rather than to a malformed request.
      payload: { ...payload, expected_version: 4, changed_by: 'claude-code', title: 'renamed' },
    });

    // Status in particular: VERIFIED requires a successful Verification, and
    // a generic field assignment would step around that rule entirely.
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    expect(calls.updateProblem).toBeUndefined();

    await app.close();
  });

  it.each([
    ['an invalid confidence', { confidence: 'CERTAIN' }],
    ['an invalid freshness', { freshness: 'OLD' }],
    ['a lowercase confidence', { confidence: 'high' }],
    ['a non-boolean importance', { importance: 'yes' }],
    ['a non-boolean suppressed', { suppressed: 1 }],
    ['a non-boolean read flag', { memory_read_enabled: 'true' }],
    ['a whitespace-only title', { title: '   ' }],
    ['a whitespace-only symptoms', { symptoms: '\n' }],
  ])('refuses %s', async (_label, payload) => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/problems/${PROBLEM_ID}`,
      payload: { ...payload, expected_version: 4, changed_by: 'claude-code' },
    });

    expect(response.statusCode).toBe(400);
    expect(calls.updateProblem).toBeUndefined();

    await app.close();
  });

  it('refuses a malformed problem id', async () => {
    const app = buildApp(serviceRecording({}));

    const response = await app.inject({
      method: 'PATCH',
      url: '/v1/problems/not-a-uuid',
      payload: { title: 'x', expected_version: 4, changed_by: 'claude-code' },
    });

    expect(response.statusCode).toBe(400);

    await app.close();
  });
});

describe('routes that do not exist', () => {
  it.each([
    // DELETE left this list in P3-05, which is the one method here that ever
    // will: a Problem can now be removed, and its route lives in its own file
    // because the operation is destructive and shares nothing with the rest.
    ['PUT', `/v1/problems/${PROBLEM_ID}`],
    ['POST', `/v1/problems`],
  ])('%s %s is not served', async (method, url) => {
    const app = buildApp(serviceRecording({}));

    const response = await app.inject({
      method: method as 'DELETE' | 'PUT' | 'POST',
      url,
      payload: {},
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });

    await app.close();
  });

  it.each([
    // Events and Verifications both hang off a problem now; what a problem
    // still does not have is a collection of its own or another version.
    '/problems',
    `/v1/problems`,
    `/v2/problems/${PROBLEM_ID}`,
  ])('%s is not served', async (url) => {
    const app = buildApp(serviceRecording({}));

    const response = await app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(404);

    await app.close();
  });
});
