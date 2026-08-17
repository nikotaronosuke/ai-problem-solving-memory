/**
 * What the operational log is allowed to contain (P3-10).
 *
 * Two layers, because either one alone passes for the wrong reason.
 *
 * The first is an exact field inventory. Every line the server writes is
 * parsed and its keys compared against a literal list. A marker sweep alone
 * would keep passing if somebody logged the request body using a fixture this
 * file happens not to use; an inventory fails the moment a field appears at
 * all, whatever is in it.
 *
 * The second is an adversarial sweep: credentials, Memory prose, prompts,
 * paths and driver detail pushed through every entry point the server has,
 * asserted absent from the whole stream. An inventory alone would keep passing
 * if a *permitted* field started carrying something it should not — a route
 * template built from the raw URL, say.
 *
 * All of it runs against `createLoggerOptions`, the function `src/index.ts`
 * calls, with only the stream replaced. A leak test against a logger
 * configured differently from production proves nothing about production, and
 * a copy of a configuration stops being one silently.
 *
 * The level is `trace`, which is more verbose than any level the environment
 * can actually select — `LOG_LEVELS` stops at `debug`. A configuration that is
 * safe at `info` and leaks at `debug` is not safe.
 */

import { describe, expect, it } from 'vitest';

import {
  createVerificationService,
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
  ExportBlockedError,
  InvalidApplicationInputError,
  REQUEST_CONTEXT_FAILURES,
  RequestContextUnavailableError,
  SanitizationRejectedError,
  type AuthenticatedRequestContext,
  type ProjectRecord,
  type ProjectEnvironmentService,
  type RequestContextService,
  type RetrievalSearchService,
  type RetrievalSearchServiceResolver,
  type RetrievalUsageLogFailure,
} from '../../src/app/index.js';
import type { OwnerId } from '../../src/domain/owner.js';
import {
  STRUCTURAL_FEATURE_LISTS,
  STRUCTURAL_FEATURE_SCHEMA_VERSION,
} from '../../src/domain/retrieval-summary.js';
import { LOG_LEVELS } from '../../src/config/env.js';
import {
  buildMemoryHttpApp,
  createLoggerOptions,
  OPERATIONAL_FAILURES,
  OPERATIONAL_LOG_EVENTS,
  REDACTED_LOG_PATHS,
  UNMATCHED_ROUTE,
  type MemoryHttpAppDependencies,
} from '../../src/http/index.js';
import type { MemoryRepository } from '../../src/repository/index.js';
import { createUnusedSearchResolver } from '../support/search-resolver.js';

const OWNER_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const CLIENT_ID = 'c0ffee00-0000-4000-8000-000000000001';
const PROJECT_ID = '11111111-2222-4333-8444-555555555555';
const PROBLEM_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa';

/**
 * Things that must never appear, and a place each of them comes from.
 *
 * Distinct strings so that a hit names its own origin, and none of them a
 * substring of an identifier the log is allowed to carry.
 */
const FIXTURES = {
  apiKey: 'sk-live-p310-api-key-marker',
  bearer: 'mem_v1_p310lookupmarker_p310secretmarker',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwMzEwIn0.p310-jwt-signature-marker',
  cookie: 'session=p310-cookie-marker',
  password: 'P310-password-marker',
  awsSecret: 'AKIAP310AWSSECRETMARK',
  privateKey: '-----BEGIN RSA PRIVATE KEY-----p310-private-key-marker',
  databaseUrl: 'postgresql://memory:p310-db-password-marker@db.internal:5432/memorydb',
  email: 'p310-email-marker@example.invalid',
  memorySummary: 'p310-memory-summary-marker',
  memoryTitle: 'p310-memory-title-marker',
  prompt: 'raw-prompt-p310-marker',
  chainOfThought: 'chain-of-thought-p310-marker',
  conversation: 'conversation-p310-marker',
  filesystemPath: 'C:/Users/p310/private/p310-path-marker/queue.json',
  malformedJson: 'p310-malformed-json-marker',
  callerKey: 'p310_caller_key_marker',
  host: 'p310-host-marker.example.invalid',
  userAgent: 'p310-user-agent-marker',
  driverDetail: 'Failing row contains (p310-pg-detail-marker).',
  constraint: 'p310_constraint_marker',
} as const;

const ALL_FIXTURES = Object.values(FIXTURES);

/** Fields Pino puts on every line regardless of what was logged. */
const PINO_BASE = ['level', 'time', 'pid', 'hostname'] as const;

type Line = Record<string, unknown>;

function keysOf(line: Line): string[] {
  return Object.keys(line).sort();
}

function expectedKeys(...extra: string[]): string[] {
  return [...PINO_BASE, 'reqId', 'msg', ...extra].sort();
}

/** A repository stand-in. Nothing in these tests reaches storage. */
function repositoryFor(ownerId: string): MemoryRepository {
  return { ownerId } as unknown as MemoryRepository;
}

function contextFor(ownerId: string): AuthenticatedRequestContext {
  return {
    clientId: CLIENT_ID,
    repository: repositoryFor(ownerId),
    runInTransaction: (work) => work(repositoryFor(ownerId)),
  } as AuthenticatedRequestContext;
}

function contextServiceReturning(): RequestContextService {
  return { authenticate: () => Promise.resolve(contextFor(OWNER_ID)) };
}

function contextServiceRejecting(error: Error): RequestContextService {
  return { authenticate: () => Promise.reject(error) };
}

/**
 * A project service that stores nothing and echoes what it was given.
 *
 * The echo matters: it puts the caller's Memory text into the *response* as
 * well as the request, so one exchange tests both directions at once.
 */
function echoingProjectService(): ProjectEnvironmentService {
  return {
    ...createProjectEnvironmentService(),
    createProject: (_context, command) =>
      Promise.resolve({
        projectId: PROJECT_ID,
        ownerId: OWNER_ID,
        projectName: command.projectName,
        repo: command.repo ?? null,
        platform: command.platform ?? null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      } as ProjectRecord),
  };
}

/**
 * A resolver whose pipeline loses its usage record.
 *
 * The route hands the pipeline a reporter and never calls it itself, so this
 * calls it during `resolve` — which is exactly the contract: the pipeline may
 * report that a search it answered was not recorded. The search then succeeds,
 * because that is the case worth logging. A failure the caller already sees
 * needs no second channel.
 *
 * The failure carries a marker in a field the reporter is not allowed to pass
 * on, so the sweep below has something to catch if the closed report ever stops
 * being closed.
 */
function resolverLosingItsUsageRecord(): RetrievalSearchServiceResolver {
  return {
    resolve: (_context, failureReporter) => {
      const failure: RetrievalUsageLogFailure = {
        kind: 'SEARCH_USAGE_LOG_WRITE_FAILED',
        attemptedRows: 3,
      };
      failureReporter.report(failure);

      return Promise.resolve({
        ownerId: OWNER_ID as OwnerId,
        search: () =>
          Promise.resolve({
            kind: 'SEARCHED',
            candidates: [],
            semanticStatus: 'USED',
            structuralStatus: 'USED',
          } as const),
      } as RetrievalSearchService);
    },
  };
}

/** A search body the route accepts, so the handler actually runs. */
const SEARCH_PAYLOAD = {
  source_ai: 'claude-code',
  lexical_text: 'a query',
  semantic_text: 'a longer description of the same question',
  current_features: {
    schema_version: STRUCTURAL_FEATURE_SCHEMA_VERSION,
    problem_domain: null,
    ...Object.fromEntries(STRUCTURAL_FEATURE_LISTS.map((list) => [list, []])),
  },
};

interface Capture {
  app: ReturnType<typeof buildMemoryHttpApp>;
  /** Every physical line the logger wrote, in order. */
  raw: string[];
  lines: () => Line[];
  written: () => string;
}

function capture(overrides: Partial<MemoryHttpAppDependencies> = {}): Capture {
  const raw: string[] = [];

  const app = buildMemoryHttpApp({
    retrievalSearchResolver: createUnusedSearchResolver(),
    healthService: { check: () => Promise.resolve({ status: 'ok', latencyMs: 1 }) },
    requestContextService: contextServiceReturning(),
    projectEnvironmentService: echoingProjectService(),
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
    logger: {
      // The production options themselves, at the most verbose level there is.
      ...createLoggerOptions('trace'),
      stream: {
        write(line: string) {
          raw.push(line);
        },
      },
    },
    ...overrides,
  });

  return {
    app,
    raw,
    lines: () => raw.map((line) => JSON.parse(line) as Line),
    written: () => raw.join('\n'),
  };
}

describe('the configuration these tests run', () => {
  it('is the one the server runs', () => {
    const options = createLoggerOptions('info');

    // Serializers, not redaction, are what make this safe. Both are asserted
    // because a future edit could delete either.
    expect(typeof options.serializers.req).toBe('function');
    expect(typeof options.serializers.res).toBe('function');
    expect(typeof options.serializers.err).toBe('function');
    expect(options.redact.remove).toBe(true);
    expect([...options.redact.paths]).toEqual([...REDACTED_LOG_PATHS]);
    expect(options.level).toBe('info');
  });

  it('runs these tests above any level an operator can select', () => {
    // `trace` is not in `LOG_LEVELS`, which is the point: the sweep below runs
    // more verbosely than production can be configured to run.
    expect(LOG_LEVELS).not.toContain('trace');
    expect(LOG_LEVELS).toContain('debug');
  });

  it('takes no argument into the error serializer', () => {
    // Not a style preference. A serializer that received the error could be
    // edited into one that reports a field of it; this one has nothing to
    // report from, at the level of the signature.
    expect(createLoggerOptions('info').serializers.err.length).toBe(0);
  });
});

describe('what a served request looks like in the log', () => {
  it('writes exactly two lines, with exactly these fields', async () => {
    const captured = capture();
    await captured.app.ready();

    const response = await captured.app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);

    const [incoming, completed] = captured.lines();

    expect(captured.raw).toHaveLength(2);

    expect(keysOf(incoming!)).toEqual(expectedKeys('req'));
    expect(incoming!['msg']).toBe('incoming request');
    expect(incoming!['req']).toEqual({
      method: 'GET',
      route: '/health',
      operation: 'healthCheck',
    });

    expect(keysOf(completed!)).toEqual(expectedKeys('res', 'responseTime'));
    expect(completed!['msg']).toBe('request completed');
    expect(completed!['res']).toEqual({ statusCode: 200 });
    expect(typeof completed!['responseTime']).toBe('number');

    await captured.app.close();
  });

  it('names the route by its template, never by what was requested', async () => {
    const captured = capture({
      requestContextService: contextServiceRejecting(new RequestContextUnavailableError('MISSING')),
    });
    await captured.app.ready();

    await captured.app.inject({
      method: 'GET',
      url: `/v1/problems/${PROJECT_ID}/events`,
      headers: { authorization: `Bearer ${FIXTURES.bearer}` },
    });

    const [incoming] = captured.lines();
    expect(incoming!['req']).toEqual({
      method: 'GET',
      route: '/v1/problems/:problem_id/events',
      operation: 'listEvents',
    });
    // The template is written in this repository; the id in the URL is not.
    expect(captured.written()).not.toContain(PROJECT_ID);

    await captured.app.close();
  });
});

describe('a request that matched nothing', () => {
  it('leaves no part of the path or query anywhere in the stream', async () => {
    const captured = capture();
    await captured.app.ready();

    // Fastify writes its own line for an unmatched route when the default
    // not-found handler is in play, and that line quotes the path. This app
    // installs its own handler, so it does not — and the assertion is over the
    // whole stream rather than over the fields this file knows about, so it
    // would fail if any line reappeared for any reason.
    const first = await captured.app.inject({
      method: 'GET',
      url: `/not-found/API_KEY=${FIXTURES.apiKey}`,
    });
    const second = await captured.app.inject({
      method: 'GET',
      url: `/missing?access_token=${FIXTURES.jwt}`,
    });

    expect(first.statusCode).toBe(404);
    expect(second.statusCode).toBe(404);

    const written = captured.written();
    expect(written).not.toContain(FIXTURES.apiKey);
    expect(written).not.toContain(FIXTURES.jwt);
    expect(written).not.toContain('not-found');
    expect(written).not.toContain('missing');
    expect(written).not.toContain('access_token');
    expect(written).not.toContain('API_KEY');

    // And every line is still one of the two known shapes.
    for (const line of captured.lines()) {
      if (line['req'] !== undefined) {
        expect(line['req']).toEqual({ method: 'GET', route: UNMATCHED_ROUTE, operation: null });
      } else {
        expect(keysOf(line)).toEqual(expectedKeys('res', 'responseTime'));
      }
    }

    await captured.app.close();
  });
});

describe('nothing a caller sent reaches the log', () => {
  it('drops the Host, the User-Agent and every other header', async () => {
    const captured = capture();
    await captured.app.ready();

    await captured.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: {
        host: FIXTURES.host,
        'user-agent': FIXTURES.userAgent,
        authorization: `Bearer ${FIXTURES.bearer}`,
        cookie: FIXTURES.cookie,
        'x-api-key': FIXTURES.apiKey,
        'proxy-authorization': `Basic ${FIXTURES.password}`,
        'x-forwarded-for': `10.0.0.1, ${FIXTURES.email}`,
      },
    });

    const written = captured.written();
    for (const fixture of ALL_FIXTURES) {
      expect(written).not.toContain(fixture);
    }
    // Not the header names either, which is what would remain if a serializer
    // emitted headers and redaction removed only the values it knew about.
    expect(written).not.toContain('headers');
    expect(written).not.toContain('user-agent');

    await captured.app.close();
  });

  it('drops the remote address and port', async () => {
    // Over a real socket, not `inject()`. Fastify's default serializer reads
    // `remotePort` off the connection, so it is absent from an injected
    // request whatever the configuration says — a test that never opened a
    // port would pass without proving anything.
    const captured = capture();
    await captured.app.listen({ host: '127.0.0.1', port: 0 });

    const address = captured.app.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    await fetch(`http://127.0.0.1:${String(port)}/health`);
    // The completion line is written after the response is sent.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const requestLines = captured
      .lines()
      .filter((line) => line['reqId'] !== undefined)
      .map((line) => JSON.stringify(line));
    expect(requestLines).toHaveLength(2);

    const written = requestLines.join('\n');
    expect(written).not.toContain('remoteAddress');
    expect(written).not.toContain('remotePort');
    expect(written).not.toContain('127.0.0.1');
    expect(written).not.toContain(String(port));

    await captured.app.close();
  });

  it('says where it is listening, which is the one address it may name', async () => {
    // Fastify writes this line itself when a port is opened, and it is worth
    // being explicit rather than quietly filtering it out above. The address
    // in it is the one this process was configured to bind — the same host and
    // port the startup summary already prints, decided by whoever started the
    // server. No caller has been able to influence anything at this point:
    // nothing is listening yet.
    const captured = capture();
    await captured.app.listen({ host: '127.0.0.1', port: 0 });

    const listening = captured.lines().filter((line) => line['reqId'] === undefined);
    expect(listening).toHaveLength(1);
    expect(keysOf(listening[0]!)).toEqual([...PINO_BASE, 'msg'].sort());
    expect(listening[0]!['msg']).toMatch(/^Server listening at http:\/\/127\.0\.0\.1:\d+$/);

    await captured.app.close();
  });

  it('keeps a request body out, and the response built from it', async () => {
    const captured = capture();
    await captured.app.ready();

    const response = await captured.app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: { authorization: `Bearer ${FIXTURES.bearer}` },
      payload: {
        project_name: FIXTURES.memoryTitle,
        repo: FIXTURES.databaseUrl,
        platform: FIXTURES.prompt,
      },
    });

    // The exchange really happened, in both directions.
    expect(response.statusCode).toBe(201);
    expect(response.body).toContain(FIXTURES.memoryTitle);
    expect(response.body).toContain(FIXTURES.prompt);

    const written = captured.written();
    for (const fixture of ALL_FIXTURES) {
      expect(written).not.toContain(fixture);
    }

    await captured.app.close();
  });

  it('keeps a caller-invented field name out of a validation failure', async () => {
    const captured = capture();
    await captured.app.ready();

    const response = await captured.app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: { authorization: `Bearer ${FIXTURES.bearer}` },
      payload: { project_name: 'fine', [FIXTURES.callerKey]: FIXTURES.awsSecret },
    });

    expect(response.statusCode).toBe(400);
    expect(captured.written()).not.toContain(FIXTURES.callerKey);
    expect(captured.written()).not.toContain(FIXTURES.awsSecret);

    await captured.app.close();
  });

  it('keeps the bytes a JSON parser choked on out of the log', async () => {
    const captured = capture();
    await captured.app.ready();

    const response = await captured.app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: { authorization: `Bearer ${FIXTURES.bearer}`, 'content-type': 'application/json' },
      payload: `{"project_name": ${FIXTURES.malformedJson}}`,
    });

    expect(response.statusCode).toBe(400);
    expect(captured.written()).not.toContain(FIXTURES.malformedJson);

    await captured.app.close();
  });

  it('cannot be made to write a second line by a newline in a URL', async () => {
    const captured = capture();
    await captured.app.ready();

    await captured.app.inject({
      method: 'GET',
      url: '/nope/%0A%7B%22level%22%3A30%2C%22msg%22%3A%22forged%22%7D%0A',
    });

    expect(captured.raw).toHaveLength(2);
    expect(captured.lines().map((line) => line['msg'])).toEqual([
      'incoming request',
      'request completed',
    ]);

    await captured.app.close();
  });
});

describe('an error is not a log entry', () => {
  /** The shape a `pg` constraint violation actually has, as measured. */
  function pgViolation(): Error {
    return Object.assign(new Error(`duplicate key value violates unique constraint`), {
      name: 'error',
      code: '23505',
      severity: 'ERROR',
      // The offending row, which for this schema is Memory prose.
      detail: FIXTURES.driverDetail,
      schema: 'public',
      table: 'problems',
      column: 'symptoms',
      constraint: FIXTURES.constraint,
      internalQuery: `insert into problems (symptoms) values ('${FIXTURES.memorySummary}')`,
      where: FIXTURES.memorySummary,
      file: 'nbtinsert.c',
      line: '666',
      routine: '_bt_check_unique',
    });
  }

  it('records that a request failed, and nothing the failure knew', async () => {
    const thrown = Object.assign(new Error(`connection to ${FIXTURES.databaseUrl} failed`), {
      cause: new Error(`AWS_SECRET_ACCESS_KEY=${FIXTURES.awsSecret}`),
      payload: { summary: FIXTURES.memorySummary },
      path: FIXTURES.filesystemPath,
    });

    const captured = capture({ requestContextService: contextServiceRejecting(thrown) });
    await captured.app.ready();

    const response = await captured.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${FIXTURES.bearer}` },
    });

    expect(response.statusCode).toBe(500);

    const failure = captured.lines().find((line) => line['event'] === 'UNHANDLED_REQUEST_FAILURE');
    expect(failure).toBeDefined();
    expect(keysOf(failure!)).toEqual(expectedKeys('event', 'failure'));
    expect(failure!['failure']).toBe('UNEXPECTED');

    const written = captured.written();
    for (const fixture of ALL_FIXTURES) {
      expect(written).not.toContain(fixture);
    }
    // Pino's default serializer would have written all of these.
    expect(written).not.toContain('stack');
    expect(written).not.toContain('caused by');
    expect(written).not.toContain('at Object.');

    await captured.app.close();
  });

  it('records a driver failure without the row that caused it', async () => {
    const captured = capture({ requestContextService: contextServiceRejecting(pgViolation()) });
    await captured.app.ready();

    const response = await captured.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${FIXTURES.bearer}` },
    });

    expect(response.statusCode).toBe(500);

    const written = captured.written();
    expect(written).not.toContain(FIXTURES.driverDetail);
    expect(written).not.toContain(FIXTURES.memorySummary);
    expect(written).not.toContain(FIXTURES.constraint);
    expect(written).not.toContain('23505');
    expect(written).not.toContain('problems');
    expect(written).not.toContain('symptoms');
    expect(written).not.toContain('detail');

    await captured.app.close();
  });

  it('says nothing more about an application refusal than that it was one', async () => {
    const captured = capture({
      requestContextService: contextServiceRejecting(
        new InvalidApplicationInputError(`refused because of ${FIXTURES.memorySummary}`),
      ),
    });
    await captured.app.ready();

    const response = await captured.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${FIXTURES.bearer}` },
    });

    expect(response.statusCode).toBe(400);

    const rejected = captured
      .lines()
      .find((line) => line['event'] === 'REQUEST_APPLICATION_REJECTED');
    expect(keysOf(rejected!)).toEqual(expectedKeys('event', 'failure'));
    expect(rejected!['failure']).toBe('INVALID_APPLICATION_INPUT');
    // Every call site writes fixed text today. The constructor takes a string,
    // which is why the message is not logged rather than trusted.
    expect(captured.written()).not.toContain(FIXTURES.memorySummary);

    await captured.app.close();
  });
});

describe('the closed events', () => {
  it('are the ones this module declares, and each carries only its own fields', async () => {
    interface Injection {
      method: 'GET' | 'POST';
      url: string;
      headers?: Record<string, string>;
      payload?: string | Record<string, unknown>;
    }

    const cases: {
      event: string;
      fields: string[];
      overrides: Partial<MemoryHttpAppDependencies>;
      request: Injection;
    }[] = [
      {
        event: 'REQUEST_VALIDATION_FAILED',
        fields: ['event', 'validationContext', 'validationProblemCount'],
        overrides: {},
        request: {
          method: 'POST',
          url: '/v1/projects',
          headers: { authorization: 'Bearer x' },
          payload: { [FIXTURES.callerKey]: 1 },
        },
      },
      {
        event: 'REQUEST_PARSE_FAILED',
        fields: ['event', 'statusCode'],
        overrides: {},
        request: {
          method: 'POST',
          url: '/v1/projects',
          headers: { authorization: 'Bearer x', 'content-type': 'application/json' },
          payload: '{',
        },
      },
      {
        event: 'SANITIZATION_REJECTED',
        fields: ['event', 'locator', 'kind'],
        overrides: {
          requestContextService: contextServiceRejecting(
            new SanitizationRejectedError({
              path: [{ kind: 'operation', name: 'createProject' }],
              kind: 'value',
            }),
          ),
        },
        request: { method: 'GET', url: '/v1/me', headers: { authorization: 'Bearer x' } },
      },
      {
        event: 'AUTH_CONTEXT_UNAVAILABLE',
        fields: ['event', 'reason'],
        overrides: {
          requestContextService: contextServiceRejecting(
            new RequestContextUnavailableError('REVOKED'),
          ),
        },
        request: { method: 'GET', url: '/v1/me', headers: { authorization: 'Bearer x' } },
      },
      {
        event: 'EXPORT_BLOCKED',
        fields: ['event'],
        overrides: { requestContextService: contextServiceRejecting(new ExportBlockedError()) },
        request: { method: 'GET', url: '/v1/export', headers: { authorization: 'Bearer x' } },
      },
      {
        event: 'HEALTH_UNAVAILABLE',
        fields: ['event', 'healthReason', 'latencyMs'],
        overrides: {
          healthService: {
            check: () =>
              Promise.resolve({
                status: 'unavailable',
                latencyMs: 7,
                reason: 'AUTHENTICATION_FAILED',
              }),
          },
        },
        request: { method: 'GET', url: '/health' },
      },
      {
        event: 'UNHANDLED_REQUEST_FAILURE',
        fields: ['event', 'failure'],
        overrides: { requestContextService: contextServiceRejecting(new Error('anything')) },
        request: { method: 'GET', url: '/v1/me', headers: { authorization: 'Bearer x' } },
      },
      {
        event: 'SEARCH_USAGE_LOG_WRITE_FAILED',
        fields: ['event', 'kind', 'attemptedRows'],
        overrides: { retrievalSearchResolver: resolverLosingItsUsageRecord() },
        request: {
          method: 'POST',
          url: `/v1/problems/${PROBLEM_ID}/search`,
          headers: { authorization: 'Bearer x' },
          payload: SEARCH_PAYLOAD,
        },
      },
      {
        event: 'REQUEST_APPLICATION_REJECTED',
        fields: ['event', 'failure'],
        overrides: {
          requestContextService: contextServiceRejecting(
            new InvalidApplicationInputError('nothing changed'),
          ),
        },
        request: { method: 'GET', url: '/v1/me', headers: { authorization: 'Bearer x' } },
      },
    ];

    for (const testCase of cases) {
      const captured = capture(testCase.overrides);
      await captured.app.ready();
      await captured.app.inject(testCase.request);

      const line = captured.lines().find((candidate) => candidate['event'] === testCase.event);
      expect(line, `no line for ${testCase.event}`).toBeDefined();
      expect(keysOf(line!), testCase.event).toEqual(expectedKeys(...testCase.fields));

      await captured.app.close();
    }

    // Every request-scoped event has now been produced. The two that are not
    // — shutdown and start failure — belong to the composition root and are
    // covered where it is.
    const covered = new Set(cases.map((testCase) => testCase.event));
    expect([...OPERATIONAL_LOG_EVENTS].filter((event) => !covered.has(event))).toEqual([
      'SERVER_SHUTDOWN',
      'SERVER_SHUTDOWN_FAILURE',
      'SERVER_START_FAILURE',
    ]);
  });

  it('reports a failure as one of two words', () => {
    expect([...OPERATIONAL_FAILURES]).toEqual(['UNEXPECTED', 'INVALID_APPLICATION_INPUT']);
  });

  it('reports an authentication failure only as one of the closed reasons', async () => {
    for (const reason of REQUEST_CONTEXT_FAILURES) {
      const captured = capture({
        requestContextService: contextServiceRejecting(new RequestContextUnavailableError(reason)),
      });
      await captured.app.ready();
      await captured.app.inject({
        method: 'GET',
        url: '/v1/me',
        headers: { authorization: `Bearer ${FIXTURES.bearer}` },
      });

      const line = captured
        .lines()
        .find((candidate) => candidate['event'] === 'AUTH_CONTEXT_UNAVAILABLE');
      expect(line!['reason']).toBe(reason);
      // Nothing about the credential that was presented.
      expect(captured.written()).not.toContain(FIXTURES.bearer);
      expect(captured.written()).not.toContain('p310secretmarker');
      expect(captured.written()).not.toContain(OWNER_ID);
      expect(captured.written()).not.toContain(CLIENT_ID);

      await captured.app.close();
    }
  });
});

describe('the request id', () => {
  it('is the server’s, whatever header a caller sends', async () => {
    for (const header of ['request-id', 'x-request-id', 'x-correlation-id']) {
      const captured = capture();
      await captured.app.ready();

      await captured.app.inject({
        method: 'GET',
        url: '/health',
        headers: { [header]: `forged-${FIXTURES.apiKey}` },
      });

      for (const line of captured.lines()) {
        expect(line['reqId']).toBe('req-1');
      }
      expect(captured.written()).not.toContain('forged');
      expect(captured.written()).not.toContain(FIXTURES.apiKey);

      await captured.app.close();
    }
  });

  it('is the same value the failing response carries, so the two can be joined', async () => {
    const captured = capture({
      requestContextService: contextServiceRejecting(new RequestContextUnavailableError('INVALID')),
    });
    await captured.app.ready();

    const response = await captured.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${FIXTURES.bearer}` },
    });

    const { request_id: requestId } = response.json<{ request_id: string }>();
    // The whole of what P3-10 leaves an operator: this id, and the closed
    // metadata filed under it.
    expect(captured.lines().every((line) => line['reqId'] === requestId)).toBe(true);

    await captured.app.close();
  });
});
