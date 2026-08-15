/**
 * What a malformed request may and may not do (P3-11).
 *
 * "It returns 400" is the weakest thing worth saying about a rejected request.
 * The claims that matter are what it did *not* do: no row written, no row
 * partly written, no version moved, no fragment of what was sent echoed into
 * the response, and nothing of it in the operational log. Each of those has a
 * different failure mode and each is asserted here.
 *
 * The matrix is organised by schema class rather than by route. Every route's
 * schema is already pinned literally by the OpenAPI contract tests, so walking
 * all 27 operations with a bad payload would restate that breadth without
 * adding a claim. What is not covered anywhere else is the *class* of
 * malformation — a wrong primitive, a null where none is allowed, a caller
 * inventing a property name — against the behaviour above.
 *
 * The logger is the production one. `createLoggerOptions` is called and only
 * its stream is replaced, because a leak test against a logger configured
 * differently from production proves nothing about production.
 *
 * Not in this matrix: an unknown query parameter. `GET /v1/projects?filter=x`
 * answers 200 and ignores it, which is asymmetric with the way an unknown body
 * property is refused. That is a contract question rather than a security one —
 * nothing reaches storage or the log — and P3-11 does not change it.
 *
 * Skipped when `DATABASE_URL` is not set.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import {
  createChangeLogService,
  createEventService,
  createExportService,
  createHealthService,
  createMemoryControlService,
  createProblemCloseService,
  createProblemDeleteService,
  createProblemService,
  createProblemStatusService,
  createProjectEnvironmentService,
  createRelationService,
  createRequestContextService,
  createUsageLogService,
  createVerificationService,
} from '../../src/app/index.js';
import { readDatabaseUrl } from '../../src/config/env.js';
import {
  createCredentialAuthenticator,
  createCredentialRepository,
} from '../../src/credentials/index.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import { createTransactionRunner } from '../../src/db/transaction.js';
import { generateClientId } from '../../src/domain/client.js';
import {
  formatCredentialToken,
  generateCredentialId,
  generateCredentialToken,
  hashCredentialSecret,
} from '../../src/domain/credential.js';
import { generateOwnerId, type OwnerId } from '../../src/domain/owner.js';
import { buildMemoryHttpApp, createLoggerOptions } from '../../src/http/index.js';

const databaseUrl = readDatabaseUrl();

/**
 * The one string every attack carries.
 *
 * Deliberately not secret-shaped: this file is about malformed structure, and
 * a marker the sanitizer would redact on its own would let a passing result
 * mean the wrong thing.
 */
const MARKER = 'p311malformedmarker';

const MEMORY_TABLES = [
  'projects',
  'environments',
  'problems',
  'events',
  'verifications',
  'relations',
  'usage_logs',
  'change_logs',
] as const;

/**
 * The schema classes a request can be malformed in.
 *
 * One representative attack each, on whichever route expresses that class most
 * directly. Listed as a literal so that a class removed from the matrix is a
 * visible edit rather than a test quietly covering less.
 */
const MALFORMED_CLASSES = [
  'MALFORMED_JSON_BYTES',
  'MISSING_REQUIRED',
  'CALLER_CREATED_PROPERTY',
  'WRONG_PRIMITIVE_TYPE',
  'NULL_WHERE_FORBIDDEN',
  'INVALID_ENUM',
  'INVALID_UUID_IN_PATH',
  'INVALID_UUID_IN_BODY',
  'STRING_WHERE_INTEGER',
  'BLANK_VIOLATING_PATTERN',
  'EMPTY_OBJECT_MIN_PROPERTIES',
  'BOOLEAN_LITERAL_ENUM',
  'BELOW_MINIMUM',
  'ARRAY_WHERE_OBJECT',
  'INVALID_QUERY_PARAMETER',
] as const;

type MalformedClass = (typeof MALFORMED_CLASSES)[number];

interface Attack {
  readonly malformation: MalformedClass;
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly url: string;
  readonly payload?: string | Record<string, unknown>;
  /** Sent as a raw string that is not valid JSON. */
  readonly raw?: true;
  /** 404 for a route that matches nothing; everything else is refused as 400. */
  readonly status: 400 | 404;
}

describe.skipIf(databaseUrl === undefined)('a request the server will not accept', () => {
  let pool: DatabasePool;
  let app: FastifyInstance;
  const logLines: string[] = [];
  const ownersCreated: OwnerId[] = [];

  let ownerId: OwnerId;
  let token: string;
  let projectId: string;
  let problemId: string;

  function buildApp(): FastifyInstance {
    return buildMemoryHttpApp({
      healthService: createHealthService(pool),
      requestContextService: createRequestContextService(
        pool,
        createTransactionRunner(pool),
        createCredentialAuthenticator(createCredentialRepository(pool)),
      ),
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
      logger: {
        // The production options, not a copy of them, at the most verbose
        // level there is.
        ...createLoggerOptions('trace'),
        stream: {
          write(line: string) {
            logLines.push(line);
          },
        },
      },
    });
  }

  const auth = () => ({ authorization: `Bearer ${token}` });

  /**
   * Every row this owner has, plus the state a partial write would disturb.
   *
   * Compared as one string before and after the whole matrix: a row added, a
   * field changed or a version moved all show up, whichever attack caused it.
   */
  async function fingerprint(): Promise<string> {
    const dumps: string[] = [];
    for (const table of MEMORY_TABLES) {
      const rows = await pool.query(
        `select to_jsonb(t) as row from public.${table} t
          where owner_id = $1 order by to_jsonb(t)::text`,
        [ownerId],
      );
      dumps.push(`${table}:${JSON.stringify(rows.rows)}`);
    }
    return dumps.join('\n');
  }

  function attacks(): Attack[] {
    return [
      {
        malformation: 'MALFORMED_JSON_BYTES',
        method: 'POST',
        url: '/v1/projects',
        payload: `{"project_name": ${MARKER}}`,
        raw: true,
        status: 400,
      },
      {
        malformation: 'MISSING_REQUIRED',
        method: 'POST',
        url: '/v1/projects',
        payload: {},
        status: 400,
      },
      {
        malformation: 'CALLER_CREATED_PROPERTY',
        method: 'POST',
        url: '/v1/projects',
        payload: { project_name: 'fine', [`${MARKER}_field`]: 'x' },
        status: 400,
      },
      {
        malformation: 'WRONG_PRIMITIVE_TYPE',
        method: 'POST',
        url: '/v1/projects',
        payload: { project_name: 12345 },
        status: 400,
      },
      {
        malformation: 'NULL_WHERE_FORBIDDEN',
        method: 'POST',
        url: '/v1/projects',
        payload: { project_name: null },
        status: 400,
      },
      {
        malformation: 'INVALID_ENUM',
        method: 'POST',
        url: `/v1/problems/PROBLEM/events`,
        payload: { event_type: MARKER, summary: 'x', client_event_id: randomUUID() },
        status: 400,
      },
      {
        malformation: 'INVALID_UUID_IN_PATH',
        method: 'GET',
        url: `/v1/problems/not-a-uuid-${MARKER}`,
        status: 400,
      },
      {
        malformation: 'INVALID_UUID_IN_BODY',
        method: 'POST',
        url: `/v1/problems/PROBLEM/events`,
        payload: { event_type: 'DISCOVERY', summary: 'x', client_event_id: `${MARKER}-not-a-uuid` },
        status: 400,
      },
      {
        malformation: 'STRING_WHERE_INTEGER',
        method: 'PATCH',
        url: `/v1/problems/PROBLEM`,
        payload: { expected_version: MARKER, changed_by: 'x', title: 'y' },
        status: 400,
      },
      {
        malformation: 'BLANK_VIOLATING_PATTERN',
        method: 'POST',
        url: `/v1/projects/PROJECT/problems`,
        payload: { environment_id: randomUUID(), title: '   ', symptoms: 'x' },
        status: 400,
      },
      {
        malformation: 'EMPTY_OBJECT_MIN_PROPERTIES',
        method: 'PATCH',
        url: `/v1/projects/PROJECT`,
        payload: {},
        status: 400,
      },
      {
        malformation: 'BOOLEAN_LITERAL_ENUM',
        method: 'PATCH',
        url: `/v1/problems/PROBLEM/memory-control`,
        // `invalidate` is a one-value enum: `true` and nothing else, so that
        // "un-invalidate" is not expressible.
        payload: { expected_version: 1, changed_by: 'x', invalidate: false },
        status: 400,
      },
      {
        malformation: 'BELOW_MINIMUM',
        method: 'PATCH',
        url: `/v1/problems/PROBLEM`,
        payload: { expected_version: 0, changed_by: 'x', title: 'y' },
        status: 400,
      },
      {
        malformation: 'ARRAY_WHERE_OBJECT',
        method: 'POST',
        url: `/v1/projects/PROJECT/environments`,
        payload: { snapshot: [1, 2, 3] },
        status: 400,
      },
      {
        malformation: 'INVALID_QUERY_PARAMETER',
        method: 'DELETE',
        // The delete guard is a query parameter rather than a body, and it is
        // the only one in the contract — a different validation surface from
        // everything above.
        url: `/v1/problems/PROBLEM?expected_version=${MARKER}`,
        status: 400,
      },
    ];
  }

  /** Fills the placeholders with the owner's real identifiers. */
  const resolve = (url: string): string =>
    url.replace('PROBLEM', problemId).replace('PROJECT', projectId);

  beforeAll(async () => {
    pool = createPool(resolveDatabaseConfig({ nodeEnv: 'test', connectionTimeoutMillis: 5_000 }));
    app = buildApp();

    ownerId = generateOwnerId();
    await insertOwnerIfAbsent(pool, ownerId);
    ownersCreated.push(ownerId);
    const issued = generateCredentialToken();
    await createCredentialRepository(pool).issueClientCredential({
      clientId: generateClientId(),
      ownerId,
      label: 'malformed input client',
      credentialId: generateCredentialId(),
      tokenLookup: issued.lookup,
      tokenHash: hashCredentialSecret(issued.secret),
    });
    token = formatCredentialToken(issued);

    const project = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: auth(),
      payload: { project_name: 'malformed input target' },
    });
    projectId = project.json<{ project_id: string }>().project_id;

    const environment = await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/environments`,
      headers: auth(),
      payload: { snapshot: { runtime: 'node 22.12.0' } },
    });

    const problem = await app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/problems`,
      headers: auth(),
      payload: {
        environment_id: environment.json<{ environment_id: string }>().environment_id,
        title: 'a problem to aim at',
        symptoms: 'behaving oddly',
      },
    });
    problemId = problem.json<{ problem_id: string }>().problem_id;
  });

  afterAll(async () => {
    await app.close();
    if (ownersCreated.length > 0) {
      await pool.query(
        `delete from public.client_credentials
          where client_id in (select client_id from public.clients where owner_id = any($1::uuid[]))`,
        [ownersCreated],
      );
      for (const table of [
        'change_logs',
        'usage_logs',
        'relations',
        'verifications',
        'events',
        'clients',
        'problems',
        'environments',
        'projects',
        'owners',
      ]) {
        await pool.query(`delete from public.${table} where owner_id = any($1::uuid[])`, [
          ownersCreated,
        ]);
      }
    }
    await closePool(pool);
  });

  it('covers every malformation this matrix claims to cover', () => {
    const covered = attacks().map((attack) => attack.malformation);

    // One representative per class, and every class present. A class dropped
    // from the table is a visible failure rather than quieter coverage.
    expect([...covered].sort()).toEqual([...MALFORMED_CLASSES].sort());
    expect(new Set(covered).size).toBe(covered.length);
  });

  it('refuses each of them without changing anything or repeating it back', async () => {
    const before = await fingerprint();
    logLines.length = 0;

    for (const attack of attacks()) {
      const headers: Record<string, string> = { ...auth() };
      if (attack.raw === true) {
        headers['content-type'] = 'application/json';
      }

      const response = await app.inject({
        method: attack.method,
        url: resolve(attack.url),
        headers,
        ...(attack.payload === undefined ? {} : { payload: attack.payload }),
      });

      const where = `${attack.malformation} -> ${response.statusCode} ${response.body}`;

      // Controlled refusal, never a crash.
      expect(response.statusCode, where).toBe(attack.status);

      // The shared envelope, and only it. A route answering malformed input in
      // its own shape would be a second contract for clients to learn.
      const body = response.json<{ error?: { code?: string; message?: string } }>();
      expect(Object.keys(body).sort(), where).toEqual(['error', 'request_id']);
      expect(Object.keys(body.error ?? {}).sort(), where).toEqual(['code', 'message']);
      expect(body.error?.code, where).toBe(attack.status === 404 ? 'NOT_FOUND' : 'INVALID_REQUEST');

      // Nothing of what was sent comes back, and nothing of how it was judged.
      expect(response.body, where).not.toContain(MARKER);
      for (const internal of ['instancePath', 'schemaPath', 'additionalProperty', 'keyword']) {
        expect(response.body, where).not.toContain(internal);
      }
      expect(response.body, where).not.toContain('at Object');
    }

    // Not one row written, not one field moved, not one version advanced —
    // across the whole matrix, including the attacks aimed at existing rows.
    expect(await fingerprint()).toBe(before);
  });

  it('writes none of it to the operational log', async () => {
    // Driven by the same matrix, so a class added above is swept here too.
    logLines.length = 0;
    for (const attack of attacks()) {
      const headers: Record<string, string> = { ...auth() };
      if (attack.raw === true) {
        headers['content-type'] = 'application/json';
      }
      await app.inject({
        method: attack.method,
        url: resolve(attack.url),
        headers,
        ...(attack.payload === undefined ? {} : { payload: attack.payload }),
      });
    }

    const written = logLines.join('\n');
    expect(logLines.length).toBeGreaterThan(0);

    // The marker rode in on a body, a path, a query parameter and a property
    // name across the matrix. None of those reach a log line.
    expect(written).not.toContain(MARKER);
    expect(written).not.toContain('not-a-uuid');
    expect(written).not.toContain(token);

    // And no field that could carry one appeared, whatever it held.
    for (const forbidden of ['"url"', '"host"', '"headers"', '"err"', '"stack"', '"payload"']) {
      expect(written).not.toContain(forbidden);
    }
  });

  it('names a bad identifier by its route, never by what was sent', async () => {
    // P3-10 proved this for a path that matched no route at all. This is the
    // other half: a path that matched a route and failed its schema, which is
    // a different branch of the error handler.
    logLines.length = 0;

    const response = await app.inject({
      method: 'GET',
      url: `/v1/problems/not-a-uuid-${MARKER}`,
      headers: auth(),
    });

    expect(response.statusCode).toBe(400);

    const written = logLines.join('\n');
    expect(written).toContain('/v1/problems/:problem_id');
    expect(written).toContain('getProblem');
    expect(written).not.toContain(MARKER);
    expect(written).not.toContain('not-a-uuid');
  });

  it('leaves a well-formed request working, so the refusals mean something', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/problems/${problemId}/events`,
      headers: auth(),
      payload: {
        event_type: 'DISCOVERY',
        summary: 'the ordinary path still works',
        client_event_id: randomUUID(),
      },
    });

    expect(response.statusCode).toBe(201);
  });
});
