/**
 * The Event request contract, driven through `inject()`.
 *
 * The application service is substituted, so what is under test is the
 * transport layer's own job: which requests it accepts, which it refuses
 * before anything downstream sees them, and the exact shape of what comes
 * back.
 *
 * The refusals matter most here. `problem_id` comes from the path and the
 * owner, event id and timestamp are the server's, so a body naming any of them
 * should be a 400 from the schema rather than something the database has to
 * notice later. Idempotency behaviour itself needs a real database and lives
 * in the integration suite.
 */

import { describe, expect, it } from 'vitest';

import {
  createVerificationService,
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
  type AppendEventCommand,
  type AuthenticatedRequestContext,
  type EventRecord,
  type EventService,
  type HealthService,
  type RequestContextService,
} from '../../src/app/index.js';
import type { ClientEventId } from '../../src/domain/client-event-id.js';
import { EVENT_TYPES } from '../../src/domain/enums.js';
import type { EventId } from '../../src/domain/event.js';
import type { OwnerId } from '../../src/domain/owner.js';
import type { ProblemId } from '../../src/domain/problem.js';
import { buildMemoryHttpApp } from '../../src/http/index.js';
import type { MemoryRepository } from '../../src/repository/index.js';
import { createUnusedSearchResolver } from '../support/search-resolver.js';

const OWNER_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const PROBLEM_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const EVENT_ID = '2d1b8f6a-9c4e-4d7b-8a35-1e6f0c9b2d47';
const CLIENT_EVENT_ID = '5a8c3e19-7b2d-4f60-9e18-3c7a4d5b6e02';
const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');

function eventRecord(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    eventId: EVENT_ID as EventId,
    ownerId: OWNER_ID as OwnerId,
    problemId: PROBLEM_ID as ProblemId,
    eventType: 'HYPOTHESIS',
    summary: 'The session cookie may not survive the redirect.',
    result: null,
    reason: null,
    sourceAi: null,
    evidenceRef: null,
    clientEventId: CLIENT_EVENT_ID as ClientEventId,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

/** Records what the transport layer passed on, so the mapping can be checked. */
interface ServiceCalls {
  appendEvent?: { problemId: string; command: AppendEventCommand };
  listEvents?: string;
}

function serviceRecording(calls: ServiceCalls): EventService {
  return {
    appendEvent: (_context, problemId, command) => {
      calls.appendEvent = { problemId, command };
      return Promise.resolve(eventRecord());
    },
    listEvents: (_context, problemId) => {
      calls.listEvents = problemId;
      return Promise.resolve([eventRecord()]);
    },
  };
}

const healthService: HealthService = {
  check: () => Promise.resolve({ status: 'ok', latencyMs: 0 }),
};

function buildApp(service: EventService, authenticated = true) {
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
    eventService: service,
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

const VALID_APPEND = {
  event_type: 'HYPOTHESIS',
  summary: 'The session cookie may not survive the redirect.',
  client_event_id: CLIENT_EVENT_ID,
};

describe('POST /v1/problems/:problem_id/events', () => {
  it('appends an event and returns every field in snake_case', async () => {
    const app = buildApp(serviceRecording({}));

    const response = await app.inject({
      method: 'POST',
      url: `/v1/problems/${PROBLEM_ID}/events`,
      payload: VALID_APPEND,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      event_id: EVENT_ID,
      owner_id: OWNER_ID,
      problem_id: PROBLEM_ID,
      event_type: 'HYPOTHESIS',
      summary: 'The session cookie may not survive the redirect.',
      result: null,
      reason: null,
      source_ai: null,
      evidence_ref: null,
      client_event_id: CLIENT_EVENT_ID,
      created_at: '2026-01-01T00:00:00.000Z',
    });

    await app.close();
  });

  it('carries no updated_at, because an event is never updated', async () => {
    const app = buildApp(serviceRecording({}));

    const response = await app.inject({
      method: 'POST',
      url: `/v1/problems/${PROBLEM_ID}/events`,
      payload: VALID_APPEND,
    });

    expect(response.json()).not.toHaveProperty('updated_at');

    await app.close();
  });

  it('takes the problem from the path', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    await app.inject({
      method: 'POST',
      url: `/v1/problems/${PROBLEM_ID}/events`,
      payload: VALID_APPEND,
    });

    expect(calls.appendEvent?.problemId).toBe(PROBLEM_ID);

    await app.close();
  });

  it('forwards optional fields only when they were sent', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    await app.inject({
      method: 'POST',
      url: `/v1/problems/${PROBLEM_ID}/events`,
      payload: {
        ...VALID_APPEND,
        event_type: 'ATTEMPT',
        result: 'still failing',
        reason: null,
      },
    });

    // `source_ai` and `evidence_ref` are absent rather than null: "not sent"
    // and "explicitly cleared" are different instructions.
    expect(calls.appendEvent?.command).toEqual({
      eventType: 'ATTEMPT',
      summary: VALID_APPEND.summary,
      clientEventId: CLIENT_EVENT_ID,
      result: 'still failing',
      reason: null,
    });

    await app.close();
  });

  it.each(EVENT_TYPES)('accepts event type %s', async (eventType) => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'POST',
      url: `/v1/problems/${PROBLEM_ID}/events`,
      payload: { ...VALID_APPEND, event_type: eventType },
    });

    expect(response.statusCode).toBe(201);
    expect(calls.appendEvent?.command.eventType).toBe(eventType);

    await app.close();
  });

  it.each([
    ['no body at all', undefined],
    ['a missing event type', { summary: 's', client_event_id: CLIENT_EVENT_ID }],
    ['a missing summary', { event_type: 'FIX', client_event_id: CLIENT_EVENT_ID }],
    ['a missing client event id', { event_type: 'FIX', summary: 's' }],
    ['an empty summary', { ...VALID_APPEND, summary: '' }],
    ['a whitespace-only summary', { ...VALID_APPEND, summary: '   ' }],
    ['a tab-only summary', { ...VALID_APPEND, summary: '\t' }],
    ['a non-string summary', { ...VALID_APPEND, summary: 42 }],
    ['an unknown event type', { ...VALID_APPEND, event_type: 'GUESS' }],
    ['a lowercase event type', { ...VALID_APPEND, event_type: 'hypothesis' }],
    ['a null event type', { ...VALID_APPEND, event_type: null }],
    ['a malformed client event id', { ...VALID_APPEND, client_event_id: 'not-a-uuid' }],
    ['an empty client event id', { ...VALID_APPEND, client_event_id: '' }],
    ['a null client event id', { ...VALID_APPEND, client_event_id: null }],
    ['a non-string result', { ...VALID_APPEND, result: 42 }],
    ['a non-string evidence ref', { ...VALID_APPEND, evidence_ref: [] }],
  ])('refuses %s', async (_label, payload) => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'POST',
      url: `/v1/problems/${PROBLEM_ID}/events`,
      payload: payload ?? '',
      headers: { 'content-type': 'application/json' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    expect(calls.appendEvent).toBeUndefined();

    await app.close();
  });

  it.each(['problem_id', 'owner_id', 'event_id', 'created_at', 'updated_at', 'surprise'])(
    'refuses a body containing %s',
    async (field) => {
      const calls: ServiceCalls = {};
      const app = buildApp(serviceRecording(calls));

      const response = await app.inject({
        method: 'POST',
        url: `/v1/problems/${PROBLEM_ID}/events`,
        payload: { ...VALID_APPEND, [field]: PROBLEM_ID },
      });

      // Refused outright rather than dropped. A caller that believes it named
      // the problem, the owner or the time should be told it cannot.
      expect(response.statusCode).toBe(400);
      expect(calls.appendEvent).toBeUndefined();

      await app.close();
    },
  );

  it('refuses a malformed problem id in the path', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/problems/not-a-uuid/events',
      payload: VALID_APPEND,
    });

    expect(response.statusCode).toBe(400);
    expect(calls.appendEvent).toBeUndefined();

    await app.close();
  });

  it('requires an owner context', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls), false);

    const response = await app.inject({
      method: 'POST',
      url: `/v1/problems/${PROBLEM_ID}/events`,
      payload: VALID_APPEND,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    expect(calls.appendEvent).toBeUndefined();

    await app.close();
  });
});

describe('GET /v1/problems/:problem_id/events', () => {
  it('lists under an events key', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'GET',
      url: `/v1/problems/${PROBLEM_ID}/events`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      events: [
        {
          event_id: EVENT_ID,
          owner_id: OWNER_ID,
          problem_id: PROBLEM_ID,
          event_type: 'HYPOTHESIS',
          summary: 'The session cookie may not survive the redirect.',
          result: null,
          reason: null,
          source_ai: null,
          evidence_ref: null,
          client_event_id: CLIENT_EVENT_ID,
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    expect(calls.listEvents).toBe(PROBLEM_ID);

    await app.close();
  });

  it('returns an empty list rather than an error', async () => {
    const app = buildApp({
      appendEvent: () => Promise.resolve(eventRecord()),
      listEvents: () => Promise.resolve([]),
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/problems/${PROBLEM_ID}/events`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ events: [] });

    await app.close();
  });

  it('refuses a malformed problem id in the path', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({ method: 'GET', url: '/v1/problems/nope/events' });

    expect(response.statusCode).toBe(400);
    expect(calls.listEvents).toBeUndefined();

    await app.close();
  });

  it('requires an owner context', async () => {
    const app = buildApp(serviceRecording({}), false);

    const response = await app.inject({
      method: 'GET',
      url: `/v1/problems/${PROBLEM_ID}/events`,
    });

    expect(response.statusCode).toBe(401);

    await app.close();
  });
});

describe('events stay append-only', () => {
  it.each(['PATCH', 'PUT', 'DELETE'])('%s on the collection is not served', async (method) => {
    const app = buildApp(serviceRecording({}));

    const response = await app.inject({
      method: method as 'DELETE' | 'PATCH' | 'PUT',
      url: `/v1/problems/${PROBLEM_ID}/events`,
      payload: {},
    });

    // A later correction is a USER_CORRECTION event, not an edit.
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });

    await app.close();
  });

  it.each(['GET', 'PATCH', 'PUT', 'DELETE'])(
    '%s on a single event is not served',
    async (method) => {
      const app = buildApp(serviceRecording({}));

      const response = await app.inject({
        method: method as 'DELETE' | 'GET' | 'PATCH' | 'PUT',
        url: `/v1/events/${EVENT_ID}`,
        payload: {},
      });

      expect(response.statusCode).toBe(404);

      await app.close();
    },
  );

  it.each([`/v1/events`, `/v1/problems/${PROBLEM_ID}/events/${EVENT_ID}`])(
    '%s is not served',
    async (url) => {
      const app = buildApp(serviceRecording({}));

      const response = await app.inject({ method: 'GET', url });

      expect(response.statusCode).toBe(404);

      await app.close();
    },
  );
});
