/**
 * The generated contract, read back and pinned.
 *
 * These tests do not check that an OpenAPI document exists. They check that
 * the one the server produces still says what the server does — which is the
 * only thing a published contract is for.
 *
 * Everything here reads the generated document rather than the source
 * schemas. Asserting against the constants the routes import would prove the
 * constants equal themselves; the question worth answering is whether what
 * comes out the other end of generation still carries the strictness that was
 * put in. So the enum sets, the required fields, `minProperties` and the
 * closed-object rules are all spelled out literally, and a route schema
 * loosened by accident fails here.
 *
 * The inventory is exact in both directions: every operation that should
 * exist, and no operation that should not. A route that quietly stops being
 * documented — by being registered before the generator's hook, which is easy
 * to do and silent — fails the count.
 */

import { describe, expect, it } from 'vitest';

import {
  createChangeLogService,
  createEventService,
  createMemoryControlService,
  createProblemCloseService,
  createExportService,
  createProblemDeleteService,
  createProblemService,
  createProblemStatusService,
  createProjectEnvironmentService,
  createRelationService,
  createUsageLogService,
  createVerificationService,
  type AuthenticatedRequestContext,
  type HealthService,
  type RequestContextService,
} from '../../src/app/index.js';
import { SEMANTIC_CHANNEL_STATUSES } from '../../src/app/index.js';
import { PROJECT_RELATIONS } from '../../src/domain/retrieval-ranking.js';
import { REVALIDATION_CHECKS } from '../../src/domain/retrieval-revalidation.js';
import {
  MAX_SEARCH_TEXT_LENGTH,
  MAX_VECTOR_SEARCH_TEXT_LENGTH,
} from '../../src/domain/retrieval-search.js';
import { STRUCTURAL_RERANK_STATUSES } from '../../src/domain/retrieval-structural-rerank.js';
import {
  MAX_STRUCTURAL_FEATURE_ITEMS,
  STRUCTURAL_FEATURE_LISTS,
  STRUCTURAL_FEATURE_SCHEMA_VERSION,
} from '../../src/domain/retrieval-summary.js';
import { buildMemoryHttpApp } from '../../src/http/index.js';
import { ERROR_CODES } from '../../src/http/errors.js';
import { OPENAPI_PATH } from '../../src/http/openapi.js';
import type { MemoryRepository } from '../../src/repository/index.js';
import { createUnusedSearchResolver } from '../support/search-resolver.js';

const OWNER_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

const healthService: HealthService = {
  check: () => Promise.resolve({ status: 'ok', latencyMs: 0 }),
};
const requestContextService: RequestContextService = {
  authenticate: () =>
    Promise.resolve({
      repository: { ownerId: OWNER_ID } as unknown as MemoryRepository,
    } as AuthenticatedRequestContext),
};

function buildApp() {
  return buildMemoryHttpApp({
    retrievalSearchResolver: createUnusedSearchResolver(),
    healthService,
    requestContextService,
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
    exportService: createExportService(),
    logger: false,
  });
}

type JsonObject = Record<string, unknown>;

interface Operation extends JsonObject {
  operationId?: string;
  tags?: string[];
  summary?: string;
  requestBody?: {
    content: Record<string, { schema: JsonObject }>;
  };
  responses?: Record<string, { content?: Record<string, { schema: JsonObject }> }>;
}

interface Document extends JsonObject {
  openapi: string;
  info: { title: string; version: string; description?: string };
  paths: Record<string, Record<string, Operation>>;
  components?: { securitySchemes?: JsonObject };
  security?: unknown;
  tags?: { name: string }[];
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

/**
 * Generates the document once.
 *
 * `ready()` is what runs the queued plugins, so nothing exists before it.
 */
async function generate(): Promise<Document> {
  const app = buildApp();
  await app.ready();
  const document = app.swagger() as unknown as Document;
  await app.close();
  return document;
}

const documentPromise = generate();

function operations(document: Document): { method: string; path: string; operation: Operation }[] {
  return Object.entries(document.paths).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method]) => HTTP_METHODS.includes(method))
      .map(([method, operation]) => ({ method: method.toUpperCase(), path, operation })),
  );
}

function operationById(document: Document, operationId: string): Operation {
  const found = operations(document).find(
    (entry) => entry.operation.operationId === operationId,
  )?.operation;
  if (found === undefined) {
    throw new Error(`No operation named ${operationId}.`);
  }
  return found;
}

function requestSchema(document: Document, operationId: string): JsonObject {
  const schema = operationById(document, operationId).requestBody?.content['application/json']
    ?.schema;
  if (schema === undefined) {
    throw new Error(`${operationId} documents no request body.`);
  }
  return schema;
}

function responseSchema(document: Document, operationId: string, status: string): JsonObject {
  const schema = operationById(document, operationId).responses?.[status]?.content?.[
    'application/json'
  ]?.schema;
  if (schema === undefined) {
    throw new Error(`${operationId} documents no ${status} response.`);
  }
  return schema;
}

/** The properties of a documented object schema. */
function properties(schema: JsonObject): Record<string, JsonObject> {
  return (schema['properties'] ?? {}) as Record<string, JsonObject>;
}

/**
 * Asserts a nullable enum property.
 *
 * The order of a JSON Schema type union carries no meaning, and generation
 * does not preserve it — a request body keeps `['string', 'null']` while a
 * response comes back `['null', 'string']`. Sorting keeps the assertion about
 * what the schema says rather than how it was assembled.
 */
function expectNullableEnum(schema: JsonObject, name: string, values: unknown[]): void {
  const declared = property(schema, name);
  expect([...(declared['type'] as string[])].sort()).toEqual(['null', 'string']);
  expect(declared['enum']).toEqual(values);
}

function property(schema: JsonObject, name: string): JsonObject {
  const found = properties(schema)[name];
  if (found === undefined) {
    throw new Error(`No property named ${name}.`);
  }
  return found;
}

/**
 * Every operation, by name, method and path.
 *
 * Written out rather than derived, so that adding, moving or removing a route
 * has to be stated here too. A test that discovers the routes it is checking
 * agrees with whatever it finds.
 */
const EXPECTED_OPERATIONS: readonly (readonly [string, string, string])[] = [
  ['healthCheck', 'GET', '/health'],
  ['getCurrentOwner', 'GET', '/v1/me'],

  ['createProject', 'POST', '/v1/projects'],
  ['listProjects', 'GET', '/v1/projects'],
  ['getProject', 'GET', '/v1/projects/{project_id}'],
  ['updateProject', 'PATCH', '/v1/projects/{project_id}'],

  ['createEnvironment', 'POST', '/v1/projects/{project_id}/environments'],
  ['listEnvironments', 'GET', '/v1/projects/{project_id}/environments'],
  ['getEnvironment', 'GET', '/v1/environments/{environment_id}'],

  ['createProblem', 'POST', '/v1/projects/{project_id}/problems'],
  ['listProblems', 'GET', '/v1/projects/{project_id}/problems'],
  ['getProblem', 'GET', '/v1/problems/{problem_id}'],
  ['updateProblem', 'PATCH', '/v1/problems/{problem_id}'],
  ['deleteProblem', 'DELETE', '/v1/problems/{problem_id}'],

  ['appendEvent', 'POST', '/v1/problems/{problem_id}/events'],
  ['listEvents', 'GET', '/v1/problems/{problem_id}/events'],

  ['appendVerification', 'POST', '/v1/problems/{problem_id}/verifications'],
  ['listVerifications', 'GET', '/v1/problems/{problem_id}/verifications'],

  ['transitionProblemStatus', 'POST', '/v1/problems/{problem_id}/status-transitions'],

  ['createRelation', 'POST', '/v1/problems/{problem_id}/relations'],
  ['listRelations', 'GET', '/v1/problems/{problem_id}/relations'],

  ['createUsageLog', 'POST', '/v1/problems/{problem_id}/usage-logs'],
  ['listUsageLogs', 'GET', '/v1/problems/{problem_id}/usage-logs'],

  ['listChangeLogs', 'GET', '/v1/problems/{problem_id}/change-logs'],

  ['exportOwnerMemory', 'GET', '/v1/export'],

  ['updateMemoryControl', 'PATCH', '/v1/problems/{problem_id}/memory-control'],

  ['closeProblem', 'POST', '/v1/problems/{problem_id}/close'],

  ['searchProblemMemory', 'POST', '/v1/problems/{problem_id}/search'],
] as const;

describe('the document itself', () => {
  it('is OpenAPI 3.1.0', async () => {
    // 3.1 rather than 3.0 because the runtime schemas already use plain JSON
    // Schema — union types with null, enums containing null — and 3.0 would
    // require rewriting them into its own dialect.
    expect((await documentPromise).openapi).toBe('3.1.0');
  });

  it('names and versions itself', async () => {
    const { info } = await documentPromise;

    expect(info.title).toBe('AI Problem-Solving Memory API');
    expect(info.version).toMatch(/^\d+\.\d+\.\d+$/);
    // Moved by P3-06: the surface gained the export. The export's own
    // `schema_version` is a different number for a different question and does
    // not move with this one.
    expect(info.version).toBe('0.5.0');
  });

  it('says how a caller reaches it and what a 404 means', async () => {
    const description = (await documentPromise).info.description ?? '';

    // The things no single schema can show.
    expect(description).toContain('Authorization: Bearer');
    expect(description).toContain('exactly as one that does not exist');
    expect(description).toContain('expected_version');
    // The claim P3-02 had to make and P3-04 had to retire.
    expect(description).not.toContain('no client-supplied credential exists yet');
    // An owner id is still not a credential, and the document still says so.
    expect(description).toContain('not a credential');
  });

  it('declares the tags it uses, and no others', async () => {
    const document = await documentPromise;
    const declared = new Set((document.tags ?? []).map((tag) => tag.name));
    const used = new Set(operations(document).flatMap((entry) => entry.operation.tags ?? []));

    expect([...used].filter((tag) => !declared.has(tag))).toEqual([]);
    expect([...declared].filter((tag) => !used.has(tag))).toEqual([]);
  });
});

describe('the operation inventory', () => {
  it('is exactly the routes the server serves', async () => {
    const found = operations(await documentPromise)
      .map((entry) => `${entry.operation.operationId ?? '(unnamed)'} ${entry.method} ${entry.path}`)
      .sort();

    expect(found).toEqual(
      EXPECTED_OPERATIONS.map(([id, method, path]) => `${id} ${method} ${path}`).sort(),
    );
  });

  it('counts twenty-eight operations', async () => {
    expect(operations(await documentPromise)).toHaveLength(28);
  });

  it('gives every operation a unique name', async () => {
    const ids = operations(await documentPromise).map((entry) => entry.operation.operationId);

    // Names are what a generated client calls its methods, so a duplicate is
    // a collision in someone else's code.
    expect(ids.filter((id) => id === undefined)).toEqual([]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every operation a summary and a tag', async () => {
    for (const { operation, method, path } of operations(await documentPromise)) {
      expect(operation.summary, `${method} ${path}`).toBeTruthy();
      expect(operation.tags?.length, `${method} ${path}`).toBe(1);
    }
  });

  it.each([
    '/v1/problems/{problem_id}/reviews',
    '/v1/problems/{problem_id}/fix-kind',
    '/v1/problems/{problem_id}',
    '/v1/search',
    '/v1/memories',
    '/v1/owners',
    '/v2/problems',
  ])('does not document a route the server does not serve at %s', async (path) => {
    const document = await documentPromise;
    const documented = Object.keys(document.paths[path] ?? {}).filter((method) =>
      HTTP_METHODS.includes(method),
    );
    const served = EXPECTED_OPERATIONS.filter(([, , expected]) => expected === path).map(
      ([, method]) => method.toLowerCase(),
    );

    expect(documented.sort()).toEqual(served.sort());
  });
});

describe('the contract endpoint', () => {
  it('serves the same document the server generated', async () => {
    const app = buildApp();
    await app.ready();

    const direct = app.swagger();
    const response = await app.inject({ method: 'GET', url: OPENAPI_PATH });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    // One document, generated once from the routes — not a per-request
    // rendering that could drift from what `swagger()` reports.
    expect(response.json()).toEqual(JSON.parse(JSON.stringify(direct)));

    await app.close();
  });

  it('is the same on a second request', async () => {
    const app = buildApp();

    const first = await app.inject({ method: 'GET', url: OPENAPI_PATH });
    const second = await app.inject({ method: 'GET', url: OPENAPI_PATH });

    expect(first.json()).toEqual(second.json());

    await app.close();
  });

  it('needs no owner context', async () => {
    // A published contract is not anyone's memory, and a client that cannot
    // read it cannot learn how to establish an owner in the first place.
    const app = buildMemoryHttpApp({
      retrievalSearchResolver: createUnusedSearchResolver(),
      healthService,
      requestContextService: {
        authenticate: () => Promise.reject(new Error('no owner')),
      },
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
      exportService: createExportService(),
      logger: false,
    });

    expect((await app.inject({ method: 'GET', url: OPENAPI_PATH })).statusCode).toBe(200);

    await app.close();
  });

  it('does not document itself', async () => {
    const document = await documentPromise;

    expect(document.paths[OPENAPI_PATH]).toBeUndefined();
    expect(operations(document).map((entry) => entry.operation.operationId)).not.toContain(
      'getOpenApiDocument',
    );
  });

  it.each([`/v1${OPENAPI_PATH}`, '/openapi.yaml', '/swagger', '/documentation', '/docs'])(
    '%s is not served',
    async (url) => {
      const app = buildApp();

      // One machine-readable document at one path. A UI, a second format and
      // an owner-scoped copy are all things to add when something needs them.
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);

      await app.close();
    },
  );
});

describe('the authentication contract', () => {
  it('declares exactly one scheme, and it is the one the server implements', async () => {
    const document = await documentPromise;

    // P3-02 declared none, because none existed and a generated client would
    // have built a header nothing reads. P3-04 built one, and this is the same
    // rule pointing the other way: the document says what the server does.
    const schemes = document.components?.securitySchemes ?? {};
    expect(Object.keys(schemes)).toEqual(['memoryToken']);

    const { description, ...shape } = schemes['memoryToken'] as Record<string, unknown>;
    expect(shape).toEqual({ type: 'http', scheme: 'bearer', bearerFormat: 'MemoryToken' });
    // Prose, so its wording is not pinned — only that a generator has
    // something to show somebody holding a token.
    expect(typeof description).toBe('string');
  });

  it('requires that scheme by default', async () => {
    const document = await documentPromise;

    // A default rather than a per-route declaration, so a route added without
    // a thought about authentication is documented as requiring it.
    expect(document.security).toEqual([{ memoryToken: [] }]);
  });

  it('protects every owner-scoped operation', async () => {
    const document = await documentPromise;

    const unprotected = operations(document)
      .filter((entry) => entry.path.startsWith('/v1'))
      .filter((entry) => (entry.operation['security'] as unknown[] | undefined)?.length === 0)
      .map((entry) => `${entry.method} ${entry.path}`);

    expect(unprotected).toEqual([]);
  });

  it('exempts the health probe and nothing else', async () => {
    const document = await documentPromise;

    // A probe that needed a credential could not answer during the failure it
    // exists to report.
    expect(operationById(document, 'healthCheck')['security']).toEqual([]);

    const exempt = operations(document)
      .filter((entry) => (entry.operation['security'] as unknown[] | undefined)?.length === 0)
      .map((entry) => entry.operation.operationId);
    expect(exempt).toEqual(['healthCheck']);
  });

  it('leaves the contract document itself outside authentication', async () => {
    const document = await documentPromise;

    // Unauthenticated at runtime and absent from its own paths. A client that
    // cannot read the document cannot learn how to obtain a credential.
    expect(document.paths[OPENAPI_PATH]).toBeUndefined();
  });

  it('never presents an owner id as a credential', async () => {
    const document = await documentPromise;

    for (const { operation, method, path } of operations(document)) {
      const parameters = (operation['parameters'] ?? []) as { name: string; in: string }[];
      expect(
        parameters.filter((parameter) => parameter.in === 'header'),
        `${method} ${path}`,
      ).toEqual([]);
      expect(
        parameters.map((parameter) => parameter.name),
        `${method} ${path}`,
      ).not.toContain('owner_id');
    }

    // `owner_id` is readable on resources, because it is data. It is never
    // something a caller supplies.
    for (const operationId of ['createProject', 'createProblem', 'appendEvent', 'closeProblem']) {
      expect(Object.keys(properties(requestSchema(document, operationId)))).not.toContain(
        'owner_id',
      );
    }
  });
});

describe('the resource shapes', () => {
  it('documents a problem with its canonical value sets', async () => {
    const schema = responseSchema(await documentPromise, 'getProblem', '200');

    expect(property(schema, 'status')['enum']).toEqual([
      'INVESTIGATING',
      'FIX_CANDIDATE',
      'VERIFIED',
      'PAUSED',
      'CLOSED_UNRESOLVED',
    ]);
    expectNullableEnum(schema, 'fix_kind', ['ROOT_FIX', 'WORKAROUND', null]);
    expect(property(schema, 'confidence')['enum']).toEqual(['HIGH', 'MEDIUM', 'LOW', 'CONFLICTED']);
    expect(property(schema, 'freshness')['enum']).toEqual([
      'CURRENT',
      'STALE_UNKNOWN',
      'SUPERSEDED',
      'INVALID',
    ]);
    expect(property(schema, 'version')).toEqual({ type: 'integer', minimum: 1 });

    for (const flag of ['memory_read_enabled', 'memory_write_enabled', 'suppressed']) {
      expect(property(schema, flag)).toEqual({ type: 'boolean' });
    }

    expect(schema['additionalProperties']).toBe(false);
  });

  it.each([
    ['getProject', ['project_id', 'owner_id', 'project_name', 'repo', 'platform']],
    ['getEnvironment', ['environment_id', 'owner_id', 'project_id', 'snapshot']],
    ['createRelation', ['relation_id', 'owner_id', 'from_id', 'to_id', 'relation_type', 'reason']],
    [
      'createUsageLog',
      ['usage_log_id', 'owner_id', 'problem_id', 'source_ai', 'action', 'memory_id', 'reason'],
    ],
  ])('documents the %s resource', async (operationId, expected) => {
    const document = await documentPromise;
    const status = operationId.startsWith('create') ? '201' : '200';
    const schema = responseSchema(document, operationId, status);

    expect(Object.keys(properties(schema))).toEqual(expect.arrayContaining(expected));
    expect(schema['additionalProperties']).toBe(false);
  });

  it('documents an event with its identity and idempotency key', async () => {
    const schema = responseSchema(await documentPromise, 'appendEvent', '201');

    expect(property(schema, 'event_type')['enum']).toEqual([
      'HYPOTHESIS',
      'ATTEMPT',
      'DEAD_END',
      'DISCOVERY',
      'FIX',
      'USER_CORRECTION',
    ]);
    // Echoed back so a client that retried can see which write it holds.
    expect(property(schema, 'client_event_id')).toEqual({ type: 'string', format: 'uuid' });
    expect(schema['required']).toContain('client_event_id');
  });

  it('documents a verification result as a boolean and nothing else', async () => {
    const schema = responseSchema(await documentPromise, 'appendVerification', '201');

    // Not a string and not nullable. "Not checked yet" is the absence of a
    // Verification, and widening this would let that third meaning in.
    expect(property(schema, 'result')).toEqual({ type: 'boolean' });
    expect(property(schema, 'verification_type')['enum']).toEqual([
      'TEST',
      'REAL_DEVICE',
      'BUILD',
      'API_RESULT',
      'DB_RESULT',
      'USER_CONFIRMATION',
    ]);
  });

  it('documents a change log entry as a version pair with described changes', async () => {
    const schema = responseSchema(await documentPromise, 'listChangeLogs', '200');
    const entry = ((schema['properties'] as JsonObject)['change_logs'] as JsonObject)[
      'items'
    ] as JsonObject;

    expect(property(entry, 'from_version')).toEqual({ type: 'integer', minimum: 1 });
    expect(property(entry, 'to_version')).toEqual({ type: 'integer', minimum: 2 });
    expect(property(entry, 'changes')['type']).toBe('object');
  });

  it.each([
    ['listProjects', 'projects'],
    ['listEnvironments', 'environments'],
    ['listProblems', 'problems'],
    ['listEvents', 'events'],
    ['listVerifications', 'verifications'],
    ['listRelations', 'relations'],
    ['listUsageLogs', 'usage_logs'],
    ['listChangeLogs', 'change_logs'],
  ])('documents %s as an object wrapping %s', async (operationId, key) => {
    const schema = responseSchema(await documentPromise, operationId, '200');

    // A named object rather than a bare array, so pagination or a total can
    // be added later without changing the shape of the response.
    expect(schema['type']).toBe('object');
    expect(property(schema, key)['type']).toBe('array');
    expect(schema['required']).toEqual([key]);
    expect(schema['additionalProperties']).toBe(false);
  });
});

describe('the request contracts', () => {
  it('requires the version and the signature on a problem update, and refuses state', async () => {
    const schema = requestSchema(await documentPromise, 'updateProblem');

    expect(schema['required']).toEqual(['expected_version', 'changed_by']);
    // Three: the two tokens plus at least one actual change. A patch that
    // changes nothing would still move `updated_at`.
    expect(schema['minProperties']).toBe(3);
    expect(schema['additionalProperties']).toBe(false);

    const names = Object.keys(properties(schema));
    for (const refused of ['status', 'fix_kind', 'version', 'owner_id', 'project_id']) {
      expect(names).not.toContain(refused);
    }
  });

  it('requires an idempotency key on an event append', async () => {
    const schema = requestSchema(await documentPromise, 'appendEvent');

    expect(schema['required']).toEqual(expect.arrayContaining(['client_event_id']));
    expect(property(schema, 'client_event_id')).toEqual({ type: 'string', format: 'uuid' });
    expect(property(schema, 'event_type')['enum']).toEqual([
      'HYPOTHESIS',
      'ATTEMPT',
      'DEAD_END',
      'DISCOVERY',
      'FIX',
      'USER_CORRECTION',
    ]);
    expect(schema['additionalProperties']).toBe(false);
  });

  it('requires an idempotency key and a boolean result on a verification append', async () => {
    const schema = requestSchema(await documentPromise, 'appendVerification');

    expect(schema['required']).toEqual(
      expect.arrayContaining(['verification_type', 'result', 'summary', 'client_event_id']),
    );
    expect(property(schema, 'result')).toEqual({ type: 'boolean' });
  });

  it('names the six relation meanings and requires a reason', async () => {
    const schema = requestSchema(await documentPromise, 'createRelation');

    expect(property(schema, 'relation_type')['enum']).toEqual([
      'SIMILAR_TO',
      'RELATED_TO',
      'CAUSED_BY',
      'SUPERSEDES',
      'CONTRADICTS',
      'DERIVED_FROM',
    ]);
    // Without a reason the link is an assertion with nothing behind it.
    expect(schema['required']).toEqual(
      expect.arrayContaining(['to_id', 'relation_type', 'reason']),
    );
    expect(schema['additionalProperties']).toBe(false);
  });

  it('names the five usage actions, requires a reason, and allows an unknown outcome', async () => {
    const schema = requestSchema(await documentPromise, 'createUsageLog');

    expect(property(schema, 'action')['enum']).toEqual([
      'SEARCHED',
      'REFERENCED',
      'ADOPTED',
      'EXCLUDED',
      'CHANGED_STRATEGY',
    ]);
    expect(schema['required']).toEqual(
      expect.arrayContaining(['source_ai', 'action', 'memory_id', 'reason']),
    );
    // Null is the ordinary state for a memory merely found or read.
    expect(schema['required']).not.toContain('result');
    expect([...(property(schema, 'result')['type'] as string[])].sort()).toEqual([
      'null',
      'string',
    ]);
  });

  it('accepts only an affirmative invalidate, and refuses freshness and status', async () => {
    const schema = requestSchema(await documentPromise, 'updateMemoryControl');

    expect(schema['required']).toEqual(['expected_version', 'changed_by']);
    expect(schema['minProperties']).toBe(3);
    // There is no un-invalidate: it could not know which freshness to restore.
    expect(property(schema, 'invalidate')).toEqual({ type: 'boolean', enum: [true] });

    const names = Object.keys(properties(schema));
    for (const refused of ['freshness', 'status', 'fix_kind', 'version']) {
      expect(names).not.toContain(refused);
    }
  });

  it('limits a close to the three conclusions', async () => {
    const schema = requestSchema(await documentPromise, 'closeProblem');

    // The working statuses belong to the transition route.
    expect(property(schema, 'target_status')['enum']).toEqual([
      'VERIFIED',
      'PAUSED',
      'CLOSED_UNRESOLVED',
    ]);
    expectNullableEnum(schema, 'fix_kind', ['ROOT_FIX', 'WORKAROUND', null]);
    expect(schema['required']).toEqual(['expected_version', 'changed_by', 'target_status']);

    const names = Object.keys(properties(schema));
    // Each review summary is optional; the history may already say enough.
    for (const summary of [
      'final_cause_summary',
      'effective_direction',
      'dead_end_summary',
      'unresolved_points',
    ]) {
      expect(names).toContain(summary);
      expect(schema['required']).not.toContain(summary);
    }
    // The whole close is protected by `expected_version`, so no per-summary
    // idempotency key is asked for. The Events still carry one internally.
    expect(names).not.toContain('client_event_id');
    expect(schema['additionalProperties']).toBe(false);
  });

  it('names every status on a transition, unlike a close', async () => {
    const schema = requestSchema(await documentPromise, 'transitionProblemStatus');

    expect(property(schema, 'target_status')['enum']).toEqual([
      'INVESTIGATING',
      'FIX_CANDIDATE',
      'VERIFIED',
      'PAUSED',
      'CLOSED_UNRESOLVED',
    ]);
    expect(Object.keys(properties(schema))).not.toContain('fix_kind');
  });

  it.each([
    'createProject',
    'updateProject',
    'createEnvironment',
    'createProblem',
    'updateProblem',
    'appendEvent',
    'appendVerification',
    'transitionProblemStatus',
    'createRelation',
    'createUsageLog',
    'updateMemoryControl',
    'closeProblem',
    'searchProblemMemory',
  ])('%s refuses unknown fields', async (operationId) => {
    // An unexpected field is a mistake worth reporting, not something to drop
    // quietly. Documenting it keeps a generated client from sending one.
    expect(requestSchema(await documentPromise, operationId)['additionalProperties']).toBe(false);
  });
});

describe('the search contract', () => {
  it('accepts exactly four fields, all of them required', async () => {
    const schema = requestSchema(await documentPromise, 'searchProblemMemory');

    expect(Object.keys(properties(schema)).sort()).toEqual([
      'current_features',
      'lexical_text',
      'semantic_text',
      'source_ai',
    ]);
    // All four. There is no useful search with a missing half: without the
    // lexical text there is no first stage, without the semantic text there is
    // nothing to embed, and without the features there is nothing to compare.
    expect([...(schema['required'] as string[])].sort()).toEqual([
      'current_features',
      'lexical_text',
      'semantic_text',
      'source_ai',
    ]);
  });

  it.each([
    // Ownership is the credential's, and a request that could name an owner
    // would be a request that could name the wrong one.
    'owner_id',
    'client_id',
    // A search is cross-project; the current Project comes from the Problem.
    'project_id',
    'environment_id',
    // Stage bounds are the server's to tune, and a published knob is a
    // published promise.
    'hybrid_limit',
    'rerank_limit',
    'limit',
    // A query vector must come from the space the artifacts were embedded in,
    // so the server produces it and never accepts one.
    'embedding',
    'vector',
    // No vendor, no model, no cache control: those are the server's, and a
    // caller that could name one could name a different one than the corpus.
    'model',
    'provider',
    'cache_control',
    'session_id',
    // And nothing that would make the caller's judgement for it.
    'recommendation',
    'action',
  ])('refuses a %s field', async (field) => {
    const schema = requestSchema(await documentPromise, 'searchProblemMemory');

    expect(Object.keys(properties(schema))).not.toContain(field);
  });

  it('bounds both query texts, and the semantic one more loosely', async () => {
    const schema = requestSchema(await documentPromise, 'searchProblemMemory');

    // The two bounds come from the domain constants the pipeline enforces.
    expect(property(schema, 'lexical_text')['maxLength']).toBe(MAX_SEARCH_TEXT_LENGTH);
    expect(property(schema, 'semantic_text')['maxLength']).toBe(MAX_VECTOR_SEARCH_TEXT_LENGTH);
    expect(MAX_VECTOR_SEARCH_TEXT_LENGTH).toBeGreaterThan(MAX_SEARCH_TEXT_LENGTH);
  });

  it('pins the structural vocabulary a caller must describe itself in', async () => {
    const features = property(
      requestSchema(await documentPromise, 'searchProblemMemory'),
      'current_features',
    );

    // Exact version, not a minimum: a caller speaking a vocabulary this server
    // does not is refused rather than reinterpreted.
    expect(property(features, 'schema_version')['enum']).toEqual([
      STRUCTURAL_FEATURE_SCHEMA_VERSION,
    ]);
    expect(Object.keys(properties(features)).sort()).toEqual(
      ['schema_version', 'problem_domain', ...STRUCTURAL_FEATURE_LISTS].sort(),
    );
    expect(features['additionalProperties']).toBe(false);
    for (const list of STRUCTURAL_FEATURE_LISTS) {
      expect(property(features, list)['maxItems']).toBe(MAX_STRUCTURAL_FEATURE_ITEMS);
    }
  });

  it('documents three ways to answer, discriminated by kind', async () => {
    const schema = responseSchema(await documentPromise, 'searchProblemMemory', '200');
    const variants = schema['oneOf'] as JsonObject[];

    expect(variants.map((variant) => (property(variant, 'kind')['enum'] as string[])[0])).toEqual([
      'SEARCHED',
      // Both ordinary answers rather than faults: a setting being respected,
      // and a race the pipeline noticed.
      'MEMORY_READ_DISABLED',
      'CURRENT_SOURCE_CHANGED',
    ]);
    for (const variant of variants) {
      expect(variant['additionalProperties']).toBe(false);
    }
    // The two non-search outcomes carry the kind and nothing else. A field
    // suggesting what to do about them would be the server deciding.
    expect(Object.keys(properties(variants[1]!))).toEqual(['kind']);
    expect(Object.keys(properties(variants[2]!))).toEqual(['kind']);
  });

  it('reports each channel by name, including every way it can be unavailable', async () => {
    const searched = (
      responseSchema(await documentPromise, 'searchProblemMemory', '200')['oneOf'] as JsonObject[]
    )[0]!;

    expect(Object.keys(properties(searched)).sort()).toEqual([
      'candidates',
      'kind',
      'semantic_status',
      'structural_status',
    ]);
    // Named statuses rather than a boolean: "the semantic channel was skipped
    // because the query looked sensitive" and "there was no provider" are
    // different facts, and a caller reading a result needs to know which.
    expect(property(searched, 'semantic_status')['enum']).toEqual([...SEMANTIC_CHANNEL_STATUSES]);
    expect(property(searched, 'structural_status')['enum']).toEqual([
      ...STRUCTURAL_RERANK_STATUSES,
    ]);
    expect(SEMANTIC_CHANNEL_STATUSES).toContain('PROVIDER_UNAVAILABLE');
    expect(STRUCTURAL_RERANK_STATUSES).toContain('RERANKER_UNAVAILABLE');
  });

  it('gives a candidate the five kinds of material and no verdict', async () => {
    const searched = (
      responseSchema(await documentPromise, 'searchProblemMemory', '200')['oneOf'] as JsonObject[]
    )[0]!;
    const candidate = property(searched, 'candidates')['items'] as JsonObject;

    expect(Object.keys(properties(candidate)).sort()).toEqual([
      'conflict',
      'dead_end_warnings',
      'ranking',
      'revalidation',
      'successful_directions',
    ]);
    expect(candidate['additionalProperties']).toBe(false);
  });

  it('keeps the ranking provenance a caller needs to see the gaps', async () => {
    const searched = (
      responseSchema(await documentPromise, 'searchProblemMemory', '200')['oneOf'] as JsonObject[]
    )[0]!;
    const ranking = property(property(searched, 'candidates')['items'] as JsonObject, 'ranking');

    // Both placements travel. A gap between the hybrid rank and the ranking
    // rank is the visible trace of a candidate dropped between the stages, and
    // renumbering would hide it.
    expect(property(ranking, 'hybrid_rank')['type']).toBe('integer');
    expect(property(ranking, 'ranking_rank')['type']).toBe('integer');
    // Null on every degraded path, never a filled-in number.
    expect([...(property(ranking, 'structural_score')['type'] as string[])].sort()).toEqual([
      'null',
      'number',
    ]);
    expect(property(ranking, 'project_relation')['enum']).toEqual([...PROJECT_RELATIONS]);
  });

  it('always asks for all four revalidation checks', async () => {
    const searched = (
      responseSchema(await documentPromise, 'searchProblemMemory', '200')['oneOf'] as JsonObject[]
    )[0]!;
    const revalidation = property(
      property(searched, 'candidates')['items'] as JsonObject,
      'revalidation',
    );

    // A search result is a candidate rather than an answer, and this is how the
    // server says so — in the contract, not only in a document.
    expect((property(revalidation, 'required_checks')['items'] as JsonObject)['enum']).toEqual([
      ...REVALIDATION_CHECKS,
    ]);
  });

  it('documents no conflict status, and no version to re-read', async () => {
    const operation = operationById(await documentPromise, 'searchProblemMemory');

    // A search writes nothing to the Problem, so it takes no `expected_version`
    // and has no conflict to report. Documenting a 409 would send a client
    // looking for a version that has nothing to do with its search.
    expect(Object.keys(operation.responses ?? {}).sort()).toEqual([
      '200',
      '400',
      '401',
      '404',
      '500',
    ]);
    expect(
      JSON.stringify(requestSchema(await documentPromise, 'searchProblemMemory')),
    ).not.toContain('expected_version');
  });

  it.each([
    // No answer, no ranking of the answers, no instruction.
    'recommendation',
    'verdict',
    'winner',
    'answer',
    'should_retry',
    'resolution',
    'preferred',
    // Nor anything about how the result was produced.
    'cache_hit',
    'cache_miss',
    'provider',
    'model',
    'source_ai',
  ])('never returns a %s anywhere in a search result', async (field) => {
    const serialized = JSON.stringify(
      responseSchema(await documentPromise, 'searchProblemMemory', '200'),
    );

    // Searched over the whole nested response rather than its top level: the
    // material is five levels deep in places, and a verdict smuggled into a
    // contradiction is still a verdict.
    expect(serialized).not.toContain(field);
  });
});

describe('the error contract', () => {
  it('documents the six machine codes and no others', async () => {
    const schema = responseSchema(await documentPromise, 'getProblem', '404');
    const error = property(schema, 'error');

    expect(property(error, 'code')['enum']).toEqual([...ERROR_CODES]);
    // Six since P3-06. `EXPORT_BLOCKED` was added rather than borrowed: a
    // client reading `VERSION_CONFLICT` would go looking for a version to
    // re-read, and `INVALID_REQUEST` would send it to inspect a request that
    // was correct. The count is literal so a code cannot be added without
    // somebody deciding a caller genuinely needs to act differently.
    expect(ERROR_CODES).toHaveLength(6);
  });

  it('documents one envelope, identical everywhere it appears', async () => {
    const document = await documentPromise;
    const envelopes = new Set<string>();

    for (const { operation } of operations(document)) {
      for (const [status, response] of Object.entries(operation.responses ?? {})) {
        if (Number(status) < 400 || status === '503') {
          continue;
        }
        const schema = response.content?.['application/json']?.schema;
        expect(schema).toBeDefined();
        envelopes.add(JSON.stringify(schema));
      }
    }

    // A client branches on `error.code`, so a route documenting a different
    // failure shape would be a second contract.
    expect(envelopes.size).toBe(1);
  });

  it.each([
    // A Project has no version, so nothing about it can conflict.
    ['createProject', ['201', '400', '401', '404', '500']],
    ['updateProject', ['200', '400', '401', '404', '500']],
    ['getProblem', ['200', '400', '401', '404', '409', '500']],
    ['closeProblem', ['200', '400', '401', '404', '409', '500']],
    ['healthCheck', ['200', '503']],
  ])('documents the statuses %s actually returns', async (operationId, expected) => {
    const responses = operationById(await documentPromise, operationId).responses ?? {};

    expect(Object.keys(responses).sort()).toEqual([...expected].sort());
  });

  it('leaves the health check outside the error envelope', async () => {
    const document = await documentPromise;

    // Whether the process is serving is not part of the Memory API contract,
    // and a probe that explains itself describes the deployment.
    expect(Object.keys(properties(responseSchema(document, 'healthCheck', '503')))).toEqual([
      'status',
    ]);
  });
});
