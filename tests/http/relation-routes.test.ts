/**
 * The Relation request contract, driven through `inject()`.
 *
 * The application service is substituted, so what is under test is transport:
 * what it accepts, what it refuses before anything downstream sees it, and the
 * exact shape it returns.
 *
 * The refusals worth noting are `from_id` and `expected_version`. The first
 * because the source problem comes from the path and having two sources would
 * let them disagree; the second because a relation is not a write to either
 * Problem, so there is no version for it to guard.
 *
 * Ownership, self-links and both-direction listing need real data and live in
 * the integration suite.
 */

import { describe, expect, it } from 'vitest';

import {
  createUsageLogService,
  createChangeLogService,
  createMemoryControlService,
  createProblemCloseService,
  createEventService,
  createProblemService,
  createProblemStatusService,
  createProjectEnvironmentService,
  createVerificationService,
  InvalidApplicationInputError,
  RequestContextUnavailableError,
  ResourceNotFoundError,
  type AuthenticatedRequestContext,
  type CreateRelationCommand,
  type HealthService,
  type RelationRecord,
  type RelationService,
  type RequestContextService,
} from '../../src/app/index.js';
import { RELATION_TYPES } from '../../src/domain/enums.js';
import type { OwnerId } from '../../src/domain/owner.js';
import type { ProblemId } from '../../src/domain/problem.js';
import type { RelationId } from '../../src/domain/relation.js';
import { buildMemoryHttpApp } from '../../src/http/index.js';
import type { MemoryRepository } from '../../src/repository/index.js';

const OWNER_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const FROM_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const TO_ID = '9b2f1c4e-6d3a-4b8e-9f10-2c5d7e8a1b34';
const RELATION_ID = '4e8a1c72-3d95-4b06-8f21-6a5c0d7e9b48';
const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');

function relationRecord(overrides: Partial<RelationRecord> = {}): RelationRecord {
  return {
    relationId: RELATION_ID as RelationId,
    ownerId: OWNER_ID as OwnerId,
    fromId: FROM_ID as ProblemId,
    toId: TO_ID as ProblemId,
    relationType: 'SIMILAR_TO',
    reason: 'Same stale-session symptoms behind the CDN.',
    createdAt: CREATED_AT,
    ...overrides,
  };
}

/** Records what the transport layer passed on, so the mapping can be checked. */
interface ServiceCalls {
  createRelation?: { fromProblemId: string; command: CreateRelationCommand };
  listRelations?: string;
}

function serviceRecording(calls: ServiceCalls, record = relationRecord()): RelationService {
  return {
    createRelation: (_context, fromProblemId, command) => {
      calls.createRelation = { fromProblemId, command };
      return Promise.resolve(record);
    },
    listRelations: (_context, problemId) => {
      calls.listRelations = problemId;
      return Promise.resolve([record]);
    },
  };
}

function serviceFailing(error: Error): RelationService {
  return {
    createRelation: () => Promise.reject(error),
    listRelations: () => Promise.reject(error),
  };
}

const healthService: HealthService = { check: () => Promise.resolve({ status: 'ok' }) };

function buildApp(service: RelationService, authenticated = true) {
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
    relationService: service,
    usageLogService: createUsageLogService(),
    changeLogService: createChangeLogService(),
    memoryControlService: createMemoryControlService(),
    problemCloseService: createProblemCloseService(),
    logger: false,
  });
}

const URL = `/v1/problems/${FROM_ID}/relations`;

const VALID_CREATE = {
  to_id: TO_ID,
  relation_type: 'SIMILAR_TO',
  reason: 'Same stale-session symptoms behind the CDN.',
};

describe('POST /v1/problems/:problem_id/relations', () => {
  it('creates a relation and returns every field in snake_case', async () => {
    const app = buildApp(serviceRecording({}));

    const response = await app.inject({ method: 'POST', url: URL, payload: VALID_CREATE });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      relation_id: RELATION_ID,
      owner_id: OWNER_ID,
      from_id: FROM_ID,
      to_id: TO_ID,
      relation_type: 'SIMILAR_TO',
      reason: 'Same stale-session symptoms behind the CDN.',
      created_at: '2026-01-01T00:00:00.000Z',
    });

    await app.close();
  });

  it('carries no updated_at and no version', async () => {
    const app = buildApp(serviceRecording({}));

    const response = await app.inject({ method: 'POST', url: URL, payload: VALID_CREATE });

    // There is no update path, so there is nothing to record a change or to
    // guard one.
    expect(response.json()).not.toHaveProperty('updated_at');
    expect(response.json()).not.toHaveProperty('version');

    await app.close();
  });

  it('takes the source problem from the path', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    await app.inject({ method: 'POST', url: URL, payload: VALID_CREATE });

    expect(calls.createRelation).toEqual({
      fromProblemId: FROM_ID,
      command: {
        toId: TO_ID,
        relationType: 'SIMILAR_TO',
        reason: VALID_CREATE.reason,
      },
    });

    await app.close();
  });

  it.each(RELATION_TYPES)('accepts relation type %s', async (relationType) => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls, relationRecord({ relationType })));

    const response = await app.inject({
      method: 'POST',
      url: URL,
      payload: { ...VALID_CREATE, relation_type: relationType },
    });

    expect(response.statusCode).toBe(201);
    expect(calls.createRelation?.command.relationType).toBe(relationType);
    expect(response.json<{ relation_type: string }>().relation_type).toBe(relationType);

    await app.close();
  });

  it.each([
    ['no body at all', undefined],
    ['a missing target', { relation_type: 'SIMILAR_TO', reason: 'r' }],
    ['a missing relation type', { to_id: TO_ID, reason: 'r' }],
    ['a missing reason', { to_id: TO_ID, relation_type: 'SIMILAR_TO' }],
    ['a malformed target', { ...VALID_CREATE, to_id: 'not-a-uuid' }],
    ['an empty target', { ...VALID_CREATE, to_id: '' }],
    ['a null target', { ...VALID_CREATE, to_id: null }],
    ['an unknown relation type', { ...VALID_CREATE, relation_type: 'DUPLICATE_OF' }],
    ['a lowercase relation type', { ...VALID_CREATE, relation_type: 'similar_to' }],
    ['an event type in its place', { ...VALID_CREATE, relation_type: 'HYPOTHESIS' }],
    ['a null relation type', { ...VALID_CREATE, relation_type: null }],
    ['an empty reason', { ...VALID_CREATE, reason: '' }],
    ['a whitespace-only reason', { ...VALID_CREATE, reason: '   ' }],
    ['a tab-only reason', { ...VALID_CREATE, reason: '\t' }],
    ['a non-string reason', { ...VALID_CREATE, reason: 42 }],
    ['a null reason', { ...VALID_CREATE, reason: null }],
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
    expect(calls.createRelation).toBeUndefined();

    await app.close();
  });

  it.each([
    ['from_id', FROM_ID],
    ['relation_id', RELATION_ID],
    ['owner_id', OWNER_ID],
    ['created_at', '2026-01-01T00:00:00.000Z'],
    ['updated_at', '2026-01-01T00:00:00.000Z'],
    ['version', 1],
    ['expected_version', 1],
    ['project_id', FROM_ID],
    ['event_id', RELATION_ID],
    ['surprise', 'anything'],
  ])('refuses a body containing %s', async (field, value) => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'POST',
      url: URL,
      payload: { ...VALID_CREATE, [field]: value },
    });

    // `from_id` because the path already names it, and `expected_version`
    // because a relation is not a write to either Problem.
    expect(response.statusCode).toBe(400);
    expect(calls.createRelation).toBeUndefined();

    await app.close();
  });

  it('refuses a malformed problem id in the path', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/problems/not-a-uuid/relations',
      payload: VALID_CREATE,
    });

    expect(response.statusCode).toBe(400);
    expect(calls.createRelation).toBeUndefined();

    await app.close();
  });

  it('reports an unreachable problem as not found', async () => {
    const app = buildApp(serviceFailing(new ResourceNotFoundError()));

    const response = await app.inject({ method: 'POST', url: URL, payload: VALID_CREATE });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });

    await app.close();
  });

  it('reports a self relation as invalid input', async () => {
    const app = buildApp(
      serviceFailing(
        new InvalidApplicationInputError('A relation cannot join a problem to itself.'),
      ),
    );

    const response = await app.inject({
      method: 'POST',
      url: URL,
      payload: { ...VALID_CREATE, to_id: FROM_ID },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    // The envelope is the contract; the reason stays in the log.
    expect(response.body).not.toContain('join a problem to itself');

    await app.close();
  });

  it('requires an owner context', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls), false);

    const response = await app.inject({ method: 'POST', url: URL, payload: VALID_CREATE });

    expect(response.statusCode).toBe(401);
    expect(calls.createRelation).toBeUndefined();

    await app.close();
  });
});

describe('GET /v1/problems/:problem_id/relations', () => {
  it('lists under a relations key', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({ method: 'GET', url: URL });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      relations: [
        {
          relation_id: RELATION_ID,
          owner_id: OWNER_ID,
          from_id: FROM_ID,
          to_id: TO_ID,
          relation_type: 'SIMILAR_TO',
          reason: 'Same stale-session symptoms behind the CDN.',
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    expect(calls.listRelations).toBe(FROM_ID);

    await app.close();
  });

  it('reports a row as stored even when read from the target end', async () => {
    // The service returns a relation whose `from` is some other problem; the
    // route must not flip it to suit whose list this is.
    const app = buildApp(serviceRecording({}, relationRecord({ relationType: 'SUPERSEDES' })));

    const response = await app.inject({ method: 'GET', url: `/v1/problems/${TO_ID}/relations` });

    expect(
      response.json<{ relations: { from_id: string; to_id: string }[] }>().relations[0],
    ).toEqual(
      expect.objectContaining({ from_id: FROM_ID, to_id: TO_ID, relation_type: 'SUPERSEDES' }),
    );

    await app.close();
  });

  it('returns an empty list rather than an error', async () => {
    const app = buildApp({
      createRelation: () => Promise.resolve(relationRecord()),
      listRelations: () => Promise.resolve([]),
    });

    const response = await app.inject({ method: 'GET', url: URL });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ relations: [] });

    await app.close();
  });

  it('refuses a malformed problem id in the path', async () => {
    const calls: ServiceCalls = {};
    const app = buildApp(serviceRecording(calls));

    const response = await app.inject({ method: 'GET', url: '/v1/problems/nope/relations' });

    expect(response.statusCode).toBe(400);
    expect(calls.listRelations).toBeUndefined();

    await app.close();
  });

  it('requires an owner context', async () => {
    const app = buildApp(serviceRecording({}), false);

    const response = await app.inject({ method: 'GET', url: URL });

    expect(response.statusCode).toBe(401);

    await app.close();
  });
});

describe('relations are created and listed, and nothing else', () => {
  it.each(['PATCH', 'PUT', 'DELETE'])('%s on the collection is not served', async (method) => {
    const app = buildApp(serviceRecording({}));

    const response = await app.inject({
      method: method as 'DELETE' | 'PATCH' | 'PUT',
      url: URL,
      payload: {},
    });

    // How a mistaken link is corrected or withdrawn is not decided yet, and a
    // route would decide it by accident.
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });

    await app.close();
  });

  it.each(['GET', 'PATCH', 'PUT', 'DELETE'])(
    '%s on a single relation is not served',
    async (method) => {
      const app = buildApp(serviceRecording({}));

      const response = await app.inject({
        method: method as 'DELETE' | 'GET' | 'PATCH' | 'PUT',
        url: `/v1/relations/${RELATION_ID}`,
        payload: {},
      });

      expect(response.statusCode).toBe(404);

      await app.close();
    },
  );

  it.each(['/v1/relations', `/v1/problems/${FROM_ID}/relations/${RELATION_ID}`])(
    '%s is not served',
    async (url) => {
      const app = buildApp(serviceRecording({}));

      const response = await app.inject({ method: 'GET', url });

      expect(response.statusCode).toBe(404);

      await app.close();
    },
  );
});
