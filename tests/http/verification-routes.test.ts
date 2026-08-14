/**
 * The Verification request contract, driven through `inject()`.
 *
 * The application service is substituted, so what is under test is the
 * transport layer's own job: which requests it accepts, which it refuses
 * before anything downstream sees them, and the exact shape of what comes
 * back.
 *
 * `result` is where the refusals matter most. It is a boolean and nothing
 * else, because true and false both mean a check was actually carried out —
 * "not checked yet" is the absence of a Verification. A string, a number or a
 * null would each smuggle that third meaning in, so each is a 400 rather than
 * something coerced on the way through.
 *
 * Idempotency behaviour itself needs a real database and lives in the
 * integration suite.
 */

import { describe, expect, it } from 'vitest';

import {
  createEventService,
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
  RequestContextUnavailableError,
  type AppendVerificationCommand,
  type AuthenticatedRequestContext,
  type HealthService,
  type RequestContextService,
  type VerificationRecord,
  type VerificationService,
} from '../../src/app/index.js';
import type { ClientEventId } from '../../src/domain/client-event-id.js';
import { VERIFICATION_TYPES } from '../../src/domain/enums.js';
import type { OwnerId } from '../../src/domain/owner.js';
import type { ProblemId } from '../../src/domain/problem.js';
import type { VerificationId } from '../../src/domain/verification.js';
import { buildMemoryHttpApp } from '../../src/http/index.js';
import type { MemoryRepository } from '../../src/repository/index.js';

const OWNER_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const PROBLEM_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const VERIFICATION_ID = '8e4d2a70-5f19-4c3b-a26d-71f0b8c94e35';
const EVENT_ID = '2d1b8f6a-9c4e-4d7b-8a35-1e6f0c9b2d47';
const CLIENT_EVENT_ID = '5a8c3e19-7b2d-4f60-9e18-3c7a4d5b6e02';
const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');

function verificationRecord(overrides: Partial<VerificationRecord> = {}): VerificationRecord {
  return {
    verificationId: VERIFICATION_ID as VerificationId,
    ownerId: OWNER_ID as OwnerId,
    problemId: PROBLEM_ID as ProblemId,
    verificationType: 'TEST',
    result: true,
    summary: 'Suite green after the fix.',
    evidenceRef: null,
    verifiedBy: null,
    clientEventId: CLIENT_EVENT_ID as ClientEventId,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

/** Records what the transport layer passed on, so the mapping can be checked. */
interface ServiceCalls {
  appendVerification?: { problemId: string; command: AppendVerificationCommand };
  listVerifications?: string;
}

function serviceRecording(
  calls: ServiceCalls,
  record: VerificationRecord = verificationRecord(),
): VerificationService {
  return {
    appendVerification: (_context, problemId, command) => {
      calls.appendVerification = { problemId, command };
      return Promise.resolve(record);
    },
    listVerifications: (_context, problemId) => {
      calls.listVerifications = problemId;
      return Promise.resolve([record]);
    },
  };
}

const healthService: HealthService = { check: () => Promise.resolve({ status: 'ok' }) };

function buildApp(service: VerificationService, authenticated = true) {
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
    verificationService: service,
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

const VALID_APPEND = {
  verification_type: 'TEST',
  result: true,
  summary: 'Suite green after the fix.',
  client_event_id: CLIENT_EVENT_ID,
};

describe('POST /v1/problems/:problem_id/verifications', () => {
  it('records a verification and returns every field in snake_case', async () => {
    const app = buildApp(serviceRecording({}));

    const response = await app.inject({
      method: 'POST',
      url: `/v1/problems/${PROBLEM_ID}/verifications`,
      payload: VALID_APPEND,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      verification_id: VERIFICATION_ID,
      owner_id: OWNER_ID,
      problem_id: PROBLEM_ID,
      verification_type: 'TEST',
      result: true,
      summary: 'Suite green after the fix.',
      evidence_ref: null,
      verified_by: null,
      client_event_id: CLIENT_EVENT_ID,
      created_at: '2026-01-01T00:00:00.000Z',
    });

    await app.close();
  });

  it('carries no updated_at and no event_id', async () => {
    const app = buildApp(serviceRecording({}));

    const response = await app.inject({
      method: 'POST',
      url: `/v1/problems/${PROBLEM_ID}/verifications`,
      payload: VALID_APPEND,
    });

    // Append-only, and attached to the Problem rather than to an Event.
    expect(response.json()).not.toHaveProperty('updated_at');
    expect(response.json()).not.toHaveProperty('event_id');

    await app.close();
  });

  it('takes the problem from the path', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    await app.inject({
      method: 'POST',
      url: `/v1/problems/${PROBLEM_ID}/verifications`,
      payload: VALID_APPEND,
    });

    expect(calls.appendVerification?.problemId).toBe(PROBLEM_ID);

    await app.close();
  });

  it('forwards optional fields only when they were sent', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    await app.inject({
      method: 'POST',
      url: `/v1/problems/${PROBLEM_ID}/verifications`,
      payload: { ...VALID_APPEND, evidence_ref: 'ci run 4821', verified_by: null },
    });

    expect(calls.appendVerification?.command).toEqual({
      verificationType: 'TEST',
      result: true,
      summary: VALID_APPEND.summary,
      clientEventId: CLIENT_EVENT_ID,
      evidenceRef: 'ci run 4821',
      verifiedBy: null,
    });

    await app.close();
  });

  it.each(VERIFICATION_TYPES)('accepts verification type %s', async (verificationType) => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'POST',
      url: `/v1/problems/${PROBLEM_ID}/verifications`,
      payload: { ...VALID_APPEND, verification_type: verificationType },
    });

    expect(response.statusCode).toBe(201);
    expect(calls.appendVerification?.command.verificationType).toBe(verificationType);

    await app.close();
  });

  it.each([true, false])('accepts result %s', async (result) => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls, verificationRecord({ result })));

    const response = await app.inject({
      method: 'POST',
      url: `/v1/problems/${PROBLEM_ID}/verifications`,
      payload: { ...VALID_APPEND, result },
    });

    expect(response.statusCode).toBe(201);
    // Both mean a check was carried out. False is evidence, not an absence.
    expect(calls.appendVerification?.command.result).toBe(result);
    expect(response.json<{ result: boolean }>().result).toBe(result);

    await app.close();
  });

  it.each([
    [
      'a missing result',
      { verification_type: 'TEST', summary: 's', client_event_id: CLIENT_EVENT_ID },
    ],
    ['a null result', { ...VALID_APPEND, result: null }],
    ['the string "true"', { ...VALID_APPEND, result: 'true' }],
    ['the string "false"', { ...VALID_APPEND, result: 'false' }],
    ['the number 1', { ...VALID_APPEND, result: 1 }],
    ['the number 0', { ...VALID_APPEND, result: 0 }],
  ])('refuses %s rather than coercing it', async (_label, payload) => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'POST',
      url: `/v1/problems/${PROBLEM_ID}/verifications`,
      payload,
    });

    // "not checked yet" must not be able to arrive dressed as a result.
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    expect(calls.appendVerification).toBeUndefined();

    await app.close();
  });

  it.each([
    ['no body at all', undefined],
    [
      'a missing verification type',
      { result: true, summary: 's', client_event_id: CLIENT_EVENT_ID },
    ],
    [
      'a missing summary',
      { verification_type: 'TEST', result: true, client_event_id: CLIENT_EVENT_ID },
    ],
    ['a missing client event id', { verification_type: 'TEST', result: true, summary: 's' }],
    ['an empty summary', { ...VALID_APPEND, summary: '' }],
    ['a whitespace-only summary', { ...VALID_APPEND, summary: '   ' }],
    ['a tab-only summary', { ...VALID_APPEND, summary: '\t' }],
    ['a non-string summary', { ...VALID_APPEND, summary: 42 }],
    ['an unknown verification type', { ...VALID_APPEND, verification_type: 'VIBES' }],
    ['a lowercase verification type', { ...VALID_APPEND, verification_type: 'test' }],
    ['an event type in its place', { ...VALID_APPEND, verification_type: 'HYPOTHESIS' }],
    ['a malformed client event id', { ...VALID_APPEND, client_event_id: 'not-a-uuid' }],
    ['an empty client event id', { ...VALID_APPEND, client_event_id: '' }],
    ['a non-string evidence ref', { ...VALID_APPEND, evidence_ref: [] }],
    ['a non-string verified by', { ...VALID_APPEND, verified_by: 7 }],
  ])('refuses %s', async (_label, payload) => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'POST',
      url: `/v1/problems/${PROBLEM_ID}/verifications`,
      payload: payload ?? '',
      headers: { 'content-type': 'application/json' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    expect(calls.appendVerification).toBeUndefined();

    await app.close();
  });

  it.each([
    ['problem_id', PROBLEM_ID],
    ['owner_id', OWNER_ID],
    ['verification_id', VERIFICATION_ID],
    ['event_id', EVENT_ID],
    ['created_at', '2026-01-01T00:00:00.000Z'],
    ['updated_at', '2026-01-01T00:00:00.000Z'],
    ['surprise', 'anything'],
  ])('refuses a body containing %s', async (field, value) => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'POST',
      url: `/v1/problems/${PROBLEM_ID}/verifications`,
      payload: { ...VALID_APPEND, [field]: value },
    });

    // `event_id` in particular: a Verification attaches to the Problem, and
    // accepting one would start turning it into a property of an Event.
    expect(response.statusCode).toBe(400);
    expect(calls.appendVerification).toBeUndefined();

    await app.close();
  });

  it('refuses a malformed problem id in the path', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/problems/not-a-uuid/verifications',
      payload: VALID_APPEND,
    });

    expect(response.statusCode).toBe(400);
    expect(calls.appendVerification).toBeUndefined();

    await app.close();
  });

  it('requires an owner context', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls), false);

    const response = await app.inject({
      method: 'POST',
      url: `/v1/problems/${PROBLEM_ID}/verifications`,
      payload: VALID_APPEND,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    expect(calls.appendVerification).toBeUndefined();

    await app.close();
  });
});

describe('GET /v1/problems/:problem_id/verifications', () => {
  it('lists under a verifications key', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'GET',
      url: `/v1/problems/${PROBLEM_ID}/verifications`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      verifications: [
        {
          verification_id: VERIFICATION_ID,
          owner_id: OWNER_ID,
          problem_id: PROBLEM_ID,
          verification_type: 'TEST',
          result: true,
          summary: 'Suite green after the fix.',
          evidence_ref: null,
          verified_by: null,
          client_event_id: CLIENT_EVENT_ID,
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    expect(calls.listVerifications).toBe(PROBLEM_ID);

    await app.close();
  });

  it('keeps a false result false on the way out', async () => {
    const app = buildApp(serviceRecording({}, verificationRecord({ result: false })));

    const response = await app.inject({
      method: 'GET',
      url: `/v1/problems/${PROBLEM_ID}/verifications`,
    });

    expect(response.json<{ verifications: { result: boolean }[] }>().verifications[0]?.result).toBe(
      false,
    );

    await app.close();
  });

  it('returns an empty list rather than an error', async () => {
    const app = buildApp({
      appendVerification: () => Promise.resolve(verificationRecord()),
      listVerifications: () => Promise.resolve([]),
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/problems/${PROBLEM_ID}/verifications`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ verifications: [] });

    await app.close();
  });

  it('refuses a malformed problem id in the path', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({ method: 'GET', url: '/v1/problems/nope/verifications' });

    expect(response.statusCode).toBe(400);
    expect(calls.listVerifications).toBeUndefined();

    await app.close();
  });

  it('requires an owner context', async () => {
    const app = buildApp(serviceRecording({}), false);

    const response = await app.inject({
      method: 'GET',
      url: `/v1/problems/${PROBLEM_ID}/verifications`,
    });

    expect(response.statusCode).toBe(401);

    await app.close();
  });
});

describe('verifications stay append-only', () => {
  it.each(['PATCH', 'PUT', 'DELETE'])('%s on the collection is not served', async (method) => {
    const app = buildApp(serviceRecording({}));

    const response = await app.inject({
      method: method as 'DELETE' | 'PATCH' | 'PUT',
      url: `/v1/problems/${PROBLEM_ID}/verifications`,
      payload: {},
    });

    // A later or corrected check is another Verification with its own key.
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });

    await app.close();
  });

  it.each(['GET', 'PATCH', 'PUT', 'DELETE'])(
    '%s on a single verification is not served',
    async (method) => {
      const app = buildApp(serviceRecording({}));

      const response = await app.inject({
        method: method as 'DELETE' | 'GET' | 'PATCH' | 'PUT',
        url: `/v1/verifications/${VERIFICATION_ID}`,
        payload: {},
      });

      expect(response.statusCode).toBe(404);

      await app.close();
    },
  );

  it.each([
    '/v1/verifications',
    `/v1/problems/${PROBLEM_ID}/verifications/${VERIFICATION_ID}`,
    // A Verification never hangs off an Event.
    `/v1/events/${EVENT_ID}/verifications`,
  ])('%s is not served', async (url) => {
    const app = buildApp(serviceRecording({}));

    const response = await app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(404);

    await app.close();
  });
});
