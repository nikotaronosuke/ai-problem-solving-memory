/**
 * Secrets, against the real server and the real database.
 *
 * P3-01 already proved every write goes through the boundary, so this does not
 * repeat that. What it proves is the thing P3-02 is actually for: a
 * representative credential sent to a representative surface is not sitting in
 * a table afterwards.
 *
 * The database is queried directly for that, not the API. A 400 says the server
 * refused; only a scan of the tables says nothing was written, and those are
 * different claims. Every marker used here is searched for across every column
 * of every table at the end, which catches a write through a path this suite
 * never thought to send one down.
 *
 * The rest is abuse: a credential in an object key, under a caller key the
 * detector deliberately keeps, inside nested arrays, pasted as a `.env`, and
 * buried in prose. Those are the shapes a boundary passes when it was written
 * against tidy fixtures.
 *
 * Skipped when `DATABASE_URL` is not set.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import {
  createChangeLogService,
  createEventService,
  createHealthService,
  createMemoryControlService,
  createProblemCloseService,
  createProblemService,
  createProblemStatusService,
  createProjectEnvironmentService,
  createRelationService,
  createRequestContextService,
  createUsageLogService,
  createVerificationService,
} from '../../src/app/index.js';
import { readDatabaseUrl } from '../../src/config/env.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import { createTransactionRunner } from '../../src/db/transaction.js';
import { generateClientEventId } from '../../src/domain/client-event-id.js';
import { generateOwnerId, type OwnerId } from '../../src/domain/owner.js';
import { buildMemoryHttpApp } from '../../src/http/index.js';
import { MEMORY_OWNER_ID_VAR } from '../../src/owner/context.js';

const databaseUrl = readDatabaseUrl();

/**
 * Invented credentials, each with a marker unique to this file.
 *
 * None is real. Each is shaped like the thing it stands for, so the detector
 * sees what it would see in production, and each carries a distinctive tail so
 * a database scan can say exactly which one leaked.
 */
const SECRET = {
  apiKeyAssignment: 'API_KEY=fake-Aa1Qv7X-0123456789abcdef',
  bearer: 'Authorization: Bearer fake-Bb2Lm2P-0123456789abcdef',
  jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJDYzNUcjhLIn0.fakeCc3Tr8K-signature',
  privateKey: '-----BEGIN PRIVATE KEY-----\nfakeDd4Nw5J0123456789\n-----END PRIVATE KEY-----',
  cookie: 'Cookie: sid=fake-Ee5Bz3Q-0123456789; theme=dark',
  clientSecret: 'client_secret=fake-Ff6Hd6R-0123456789abcdef',
  password: 'PASSWORD=fake-Gg7Cf9M-0123456789',
  fieldValue: 'fake-Hh8Yk4W-0123456789abcdef',
  keyText: 'Bearer fake-Ii9Pu2N-0123456789abcdef',
  envPaste: [
    'NODE_ENV=production',
    'PORT=3000',
    'ACCESS_TOKEN=fake-Jj0Sx8V-0123456789abcdef',
    'LOG_LEVEL=info',
  ].join('\n'),
  inProse:
    'We fixed it by setting refresh_token=fake-Kk1Jq5T-0123456789abcdef in the deploy environment.',
} as const;

/**
 * Real credentials that read like ordinary words.
 *
 * These are the ones an earlier version stored, because it asked whether the
 * value looked random before believing an explicit credential name. Weak
 * passwords are still passwords, and they are the ones most worth catching.
 */
const WEAK = {
  password: 'letmein-Ll2Kx9',
  apiKey: 'opensesame-Mm3Ny8',
  passphrase: 'correct horse battery Nn4Oz7',
} as const;

/** Every marker, for the final sweep of the database. */
const MARKERS = [
  'Aa1Qv7X',
  'Bb2Lm2P',
  'Cc3Tr8K',
  'Dd4Nw5J',
  'Ee5Bz3Q',
  'Ff6Hd6R',
  'Gg7Cf9M',
  'Hh8Yk4W',
  'Ii9Pu2N',
  'Jj0Sx8V',
  'Kk1Jq5T',
  'Ll2Kx9',
  'Mm3Ny8',
  'Nn4Oz7',
] as const;

/** Text with no credential in it, used where a request must succeed. */
const CLEAN = 'the registered redirect did not match the deployed callback';

describe.skipIf(databaseUrl === undefined)('secrets do not reach storage', () => {
  let pool: DatabasePool;
  let app: FastifyInstance;
  const ownersCreated: OwnerId[] = [];
  const appsCreated: FastifyInstance[] = [];
  const logLines: string[] = [];

  let projectId: string;
  let environmentId: string;
  let problemId: string;
  let otherProblemId: string;

  /** The real server, composed as `src/index.ts` composes it. */
  async function buildApp(lines: string[]): Promise<{ app: FastifyInstance; ownerId: OwnerId }> {
    const owner = generateOwnerId();
    await insertOwnerIfAbsent(pool, owner);
    ownersCreated.push(owner);

    const built = buildMemoryHttpApp({
      healthService: createHealthService(pool),
      // No policy argument: the default is what a production server runs, and
      // running the default here is what makes this a test of the server
      // rather than of a policy this file chose.
      requestContextService: createRequestContextService(pool, createTransactionRunner(pool), {
        [MEMORY_OWNER_ID_VAR]: owner,
      }),
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
      logger: {
        level: 'trace',
        stream: {
          write(line: string) {
            lines.push(line);
          },
        },
      },
    });
    appsCreated.push(built);
    return { app: built, ownerId: owner };
  }

  beforeAll(async () => {
    pool = createPool(resolveDatabaseConfig({ nodeEnv: 'test', connectionTimeoutMillis: 5_000 }));
    ({ app } = await buildApp(logLines));

    const project = (
      await app.inject({
        method: 'POST',
        url: '/v1/projects',
        payload: { project_name: 'secret-boundary-fixture' },
      })
    ).json<{ project_id: string }>();
    projectId = project.project_id;

    const environment = (
      await app.inject({
        method: 'POST',
        url: `/v1/projects/${projectId}/environments`,
        payload: { snapshot: { runtime: 'node 22.12.0' } },
      })
    ).json<{ environment_id: string }>();
    environmentId = environment.environment_id;

    const problem = (
      await app.inject({
        method: 'POST',
        url: `/v1/projects/${projectId}/problems`,
        payload: {
          environment_id: environmentId,
          title: 'Sign-in fails after deploying',
          symptoms: CLEAN,
        },
      })
    ).json<{ problem_id: string }>();
    problemId = problem.problem_id;

    const other = (
      await app.inject({
        method: 'POST',
        url: `/v1/projects/${projectId}/problems`,
        payload: { environment_id: environmentId, title: 'a second problem', symptoms: CLEAN },
      })
    ).json<{ problem_id: string }>();
    otherProblemId = other.problem_id;
  });

  afterAll(async () => {
    for (const instance of appsCreated) {
      await instance.close();
    }
    if (ownersCreated.length > 0) {
      for (const table of [
        'change_logs',
        'usage_logs',
        'relations',
        'verifications',
        'events',
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

  /** Every text-ish column of every table, as one searchable blob. */
  async function everythingStored(): Promise<string> {
    const tables = [
      'projects',
      'environments',
      'problems',
      'events',
      'verifications',
      'relations',
      'usage_logs',
      'change_logs',
    ];
    const dumps: string[] = [];
    for (const table of tables) {
      const rows = await pool.query(
        `select to_jsonb(t) as row from public.${table} t where owner_id = any($1::uuid[])`,
        [ownersCreated],
      );
      dumps.push(JSON.stringify(rows.rows));
    }
    return dumps.join('\n');
  }

  describe('representative surfaces refuse a representative credential', () => {
    it.each([
      [
        'a project name',
        'POST',
        () => '/v1/projects',
        () => ({ project_name: SECRET.apiKeyAssignment }),
      ],
      [
        'a problem title',
        'POST',
        () => `/v1/projects/${projectId}/problems`,
        () => ({ environment_id: environmentId, title: SECRET.bearer, symptoms: CLEAN }),
      ],
      [
        'problem symptoms',
        'POST',
        () => `/v1/projects/${projectId}/problems`,
        () => ({ environment_id: environmentId, title: 'a problem', symptoms: SECRET.jwt }),
      ],
      [
        'an event summary',
        'POST',
        () => `/v1/problems/${problemId}/events`,
        () => ({
          event_type: 'DISCOVERY',
          summary: SECRET.privateKey,
          client_event_id: generateClientEventId(),
        }),
      ],
      [
        'an event evidence reference',
        'POST',
        () => `/v1/problems/${problemId}/events`,
        () => ({
          event_type: 'FIX',
          summary: CLEAN,
          evidence_ref: SECRET.cookie,
          client_event_id: generateClientEventId(),
        }),
      ],
      [
        'a verification summary',
        'POST',
        () => `/v1/problems/${problemId}/verifications`,
        () => ({
          verification_type: 'TEST',
          result: true,
          summary: SECRET.clientSecret,
          client_event_id: generateClientEventId(),
        }),
      ],
      [
        'a relation reason',
        'POST',
        () => `/v1/problems/${problemId}/relations`,
        () => ({
          to_id: otherProblemId,
          relation_type: 'SIMILAR_TO',
          reason: SECRET.password,
        }),
      ],
      [
        'a usage log reason',
        'POST',
        () => `/v1/problems/${problemId}/usage-logs`,
        () => ({
          source_ai: 'phase3-e2e',
          action: 'ADOPTED',
          memory_id: otherProblemId,
          reason: SECRET.envPaste,
        }),
      ],
      [
        'a usage log result',
        'POST',
        () => `/v1/problems/${problemId}/usage-logs`,
        () => ({
          source_ai: 'phase3-e2e',
          action: 'ADOPTED',
          memory_id: otherProblemId,
          reason: CLEAN,
          result: SECRET.inProse,
        }),
      ],
      [
        'an environment snapshot value',
        'POST',
        () => `/v1/projects/${projectId}/environments`,
        () => ({ snapshot: { auth: { client_secret: SECRET.fieldValue } } }),
      ],
      [
        'an environment snapshot key',
        'POST',
        () => `/v1/projects/${projectId}/environments`,
        () => ({ snapshot: { [SECRET.keyText]: 'an ordinary looking value' } }),
      ],
    ])('refuses %s', async (_label, method, url, payload) => {
      const response = await app.inject({
        method: method as 'POST',
        url: url(),
        payload: payload() as object,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('INVALID_REQUEST');
    });

    it('refuses a credential in a problem update, and in `changed_by`', async () => {
      const patched = await app.inject({
        method: 'PATCH',
        url: `/v1/problems/${problemId}`,
        payload: {
          expected_version: 1,
          changed_by: 'phase3-e2e',
          symptoms: SECRET.apiKeyAssignment,
        },
      });
      expect(patched.statusCode).toBe(400);

      // `changed_by` is caller text that reaches the change log, so it is a
      // storage surface like any other.
      const attributed = await app.inject({
        method: 'PATCH',
        url: `/v1/problems/${problemId}`,
        payload: { expected_version: 1, changed_by: SECRET.bearer, importance: true },
      });
      expect(attributed.statusCode).toBe(400);
    });

    it('refuses a credential in a close review, leaving the problem untouched', async () => {
      const before = (await app.inject({ method: 'GET', url: `/v1/problems/${problemId}` })).json<
        Record<string, unknown>
      >();

      const refused = await app.inject({
        method: 'POST',
        url: `/v1/problems/${problemId}/close`,
        payload: {
          expected_version: before['version'],
          changed_by: 'phase3-e2e',
          target_status: 'PAUSED',
          // Becomes an Event inside the same transaction as the conclusion and
          // the history entry.
          final_cause_summary: SECRET.jwt,
        },
      });

      expect(refused.statusCode).toBe(400);

      // The transaction guarantee P3-01 established, now with a real refusal
      // driving it: status, review events and history all or nothing.
      const after = (await app.inject({ method: 'GET', url: `/v1/problems/${problemId}` })).json<
        Record<string, unknown>
      >();
      expect(after).toEqual(before);

      const events = (
        await app.inject({ method: 'GET', url: `/v1/problems/${problemId}/events` })
      ).json<{ events: unknown[] }>().events;
      expect(events).toEqual([]);
    });
  });

  describe('the shapes a tidy fixture would miss', () => {
    it.each([
      ['a credential nested in arrays', { snapshot: { keys: [['a'], [SECRET.apiKeyAssignment]] } }],
      [
        'a credential under a key the detector keeps',
        // `customer@example.com` is not a secret and is kept, correctly. The
        // credential beneath it still has to be found.
        { snapshot: { 'customer@example.com': { api_key: SECRET.fieldValue } } },
      ],
      ['a `.env` pasted whole', { snapshot: { notes: SECRET.envPaste } }],
      ['a credential surrounded by ordinary prose', { snapshot: { notes: SECRET.inProse } }],
      [
        'a credential as a key deep in the structure',
        { snapshot: { deployment: { env: { [SECRET.keyText]: 'value' } } } },
      ],
      [
        'a credential-named field several levels down',
        { snapshot: { a: { b: { c: { access_token: SECRET.fieldValue } } } } },
      ],
    ])('refuses %s', async (_label, payload) => {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/projects/${projectId}/environments`,
        payload,
      });

      expect(response.statusCode).toBe(400);
    });

    it.each([
      [
        'a weak password in an event summary',
        () => `/v1/problems/${problemId}/events`,
        () => ({
          event_type: 'DISCOVERY',
          summary: `the environment had PASSWORD=${WEAK.password} set`,
          client_event_id: generateClientEventId(),
        }),
      ],
      [
        'a word-shaped api key under a strong field name',
        () => `/v1/projects/${projectId}/environments`,
        () => ({ snapshot: { auth: { api_key: WEAK.apiKey } } }),
      ],
      [
        'a passphrase with spaces in it',
        () => `/v1/projects/${projectId}/environments`,
        () => ({ snapshot: { password: WEAK.passphrase } }),
      ],
    ])('refuses %s, which reads like ordinary words', async (_label, url, payload) => {
      // The second review's finding: an earlier version required a digit or
      // punctuation before believing an explicit credential name, so the
      // weakest real passwords were the ones it stored.
      const response = await app.inject({ method: 'POST', url: url(), payload: payload() });

      expect(response.statusCode).toBe(400);
    });

    it('still accepts a snapshot with no credential in it', async () => {
      // The other half of the requirement. A detector that refused everything
      // would pass every test above and be useless.
      const response = await app.inject({
        method: 'POST',
        url: `/v1/projects/${projectId}/environments`,
        payload: {
          snapshot: {
            runtime: 'node 22.12.0',
            commit: 'a9c298878e015b0b64a7d040e42229f53069b0e9',
            deployment: 'preview',
            docs: 'https://example.com/docs/oauth/redirect-uris',
            contact: 'customer@example.com',
            public_key: '-----BEGIN PUBLIC KEY-----\nMIIBIjANBg\n-----END PUBLIC KEY-----',
            api_key: '[REDACTED]',
          },
        },
      });

      expect(response.statusCode).toBe(201);
    });

    it('still accepts ordinary prose that talks about credentials', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/problems/${problemId}/events`,
        payload: {
          event_type: 'DISCOVERY',
          summary:
            'The access token had expired and the client secret is held by the platform team, so the cookie was never set.',
          evidence_ref: 'provider console, OAuth application settings',
          client_event_id: generateClientEventId(),
        },
      });

      expect(response.statusCode).toBe(201);
    });
  });

  describe('nothing leaked', () => {
    it('left no marker anywhere in the database', async () => {
      const stored = await everythingStored();

      // The claim that matters, and the one a 400 does not make: every table,
      // every column, every row this suite's owners can reach.
      for (const marker of MARKERS) {
        expect(stored, `marker ${marker} reached storage`).not.toContain(marker);
      }
    });

    it('left no marker in any response body', async () => {
      // Re-read the whole record through the API too, in case a refusal
      // returned the offending value in its own error.
      const bodies: string[] = [];
      for (const url of [
        `/v1/problems/${problemId}`,
        `/v1/problems/${problemId}/events`,
        `/v1/problems/${problemId}/verifications`,
        `/v1/problems/${problemId}/relations`,
        `/v1/problems/${problemId}/usage-logs`,
        `/v1/problems/${problemId}/change-logs`,
        `/v1/projects/${projectId}/environments`,
        '/v1/projects',
      ]) {
        bodies.push((await app.inject({ method: 'GET', url })).body);
      }

      const everything = bodies.join('\n');
      for (const marker of MARKERS) {
        expect(everything).not.toContain(marker);
      }
    });

    it('left no marker in the operational log', () => {
      const logged = logLines.join('\n');

      // Refusals were logged — a silent one would be worse.
      expect(logged).toContain('sanitization boundary');

      for (const marker of MARKERS) {
        expect(logged, `marker ${marker} reached the log`).not.toContain(marker);
      }
    });

    it('left no caller-written key in the operational log', () => {
      const logged = logLines.join('\n');

      // A key the detector kept, above a credential it refused. P3-01's
      // locator guarantee, now exercised by a real detector.
      expect(logged).not.toContain('customer@example.com');
      expect(logged).not.toContain('client_secret');
      expect(logged).not.toContain('access_token');
      expect(logged).not.toContain('api_key');
      // What it says instead.
      expect(logged).toContain('<key>');
    });

    it('left no detection detail in the log', () => {
      const logged = logLines.join('\n');

      // The category is not published. P3-02 has no need to say which rule
      // fired, and a category in a log line is one field away from a value.
      for (const category of [
        'PRIVATE_KEY',
        'CREDENTIAL_ASSIGNMENT',
        'CREDENTIAL_FIELD',
        'AUTHORIZATION',
        'confirmed',
        'suspected',
      ]) {
        expect(logged).not.toContain(category);
      }
    });
  });

  describe('the record still works', () => {
    it('carries an ordinary investigation through to a conclusion', async () => {
      // A detector that broke the product would be a failed detector. This is
      // the Phase 2 flow, unchanged, with secret detection switched on.
      const problem = (
        await app.inject({
          method: 'POST',
          url: `/v1/projects/${projectId}/problems`,
          payload: {
            environment_id: environmentId,
            title: 'Sign-in fails after deploying',
            symptoms: CLEAN,
            source_ai: 'phase3-e2e',
          },
        })
      ).json<{ problem_id: string }>();

      for (const [eventType, summary] of [
        ['HYPOTHESIS', 'the deployed callback may differ from the registered redirect'],
        ['ATTEMPT', 'compared the deployed callback against the provider configuration'],
        ['DEAD_END', 'changing the application route alone did not help'],
        ['DISCOVERY', 'the registered redirect still named the previous host'],
        ['FIX', 'updated the registered redirect to the deployed callback'],
      ] as const) {
        const appended = await app.inject({
          method: 'POST',
          url: `/v1/problems/${problem.problem_id}/events`,
          payload: {
            event_type: eventType,
            summary,
            evidence_ref: 'provider console, OAuth application settings',
            client_event_id: generateClientEventId(),
          },
        });
        expect(appended.statusCode, `${eventType} was refused`).toBe(201);
      }

      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/v1/problems/${problem.problem_id}/status-transitions`,
            payload: {
              target_status: 'FIX_CANDIDATE',
              expected_version: 1,
              changed_by: 'phase3-e2e',
            },
          })
        ).statusCode,
      ).toBe(200);

      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/v1/problems/${problem.problem_id}/verifications`,
            payload: {
              verification_type: 'TEST',
              result: true,
              summary: 'signed in on the deployed environment',
              client_event_id: generateClientEventId(),
            },
          })
        ).statusCode,
      ).toBe(201);

      const closed = await app.inject({
        method: 'POST',
        url: `/v1/problems/${problem.problem_id}/close`,
        payload: {
          expected_version: 2,
          changed_by: 'phase3-e2e',
          target_status: 'VERIFIED',
          fix_kind: 'ROOT_FIX',
          final_cause_summary: 'the registered redirect was never updated after the host changed',
        },
      });

      expect(closed.statusCode).toBe(200);
      expect(closed.json<{ status: string }>().status).toBe('VERIFIED');
    });

    it('keeps every Phase 2 refusal working as it did', async () => {
      // Owner isolation, locking and idempotency are unrelated to secrets and
      // must not have moved.
      const stale = await app.inject({
        method: 'PATCH',
        url: `/v1/problems/${problemId}`,
        payload: { expected_version: 999, changed_by: 'phase3-e2e', importance: true },
      });
      expect(stale.statusCode).toBe(409);

      const unknown = await app.inject({
        method: 'GET',
        url: '/v1/problems/5d41402a-bc4b-4a76-b971-9d911017c592',
      });
      expect(unknown.statusCode).toBe(404);

      const key = generateClientEventId();
      const first = await app.inject({
        method: 'POST',
        url: `/v1/problems/${problemId}/events`,
        payload: { event_type: 'HYPOTHESIS', summary: 'first', client_event_id: key },
      });
      const retry = await app.inject({
        method: 'POST',
        url: `/v1/problems/${problemId}/events`,
        payload: { event_type: 'ATTEMPT', summary: 'second', client_event_id: key },
      });
      expect(retry.statusCode).toBe(201);
      expect(retry.json()).toEqual(first.json());
    });
  });
});
