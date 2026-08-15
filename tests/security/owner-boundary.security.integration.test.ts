/**
 * The owner boundary, attacked across every operation that has one (P3-11).
 *
 * The resource suites each prove their own route refuses another owner. What
 * none of them can prove is that the *set* of routes is fully covered — a new
 * owner-scoped operation arrives with its own tests and nothing notices that
 * nobody attacked it. So this file starts from the generated contract rather
 * than from a list written here: every owner-scoped `operationId` the running
 * server publishes must appear in the classification below, and every entry in
 * the classification must still exist. An operation added without a decision
 * about its owner boundary fails here.
 *
 * The attacks themselves are deliberately not a 26-way sweep of the same
 * assertion. Operations that take another owner's identifier are attacked with
 * one; operations that take none — `listProjects`, `exportOwnerMemory`,
 * `getCurrentOwner` — cannot be attacked that way and are checked for the
 * thing that can actually go wrong with them, which is another owner's data
 * appearing in the answer.
 *
 * Real database, real credentials, real HTTP, the production composition. Two
 * owners are created here and only they are cleaned up.
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
import { buildMemoryHttpApp } from '../../src/http/index.js';

const databaseUrl = readDatabaseUrl();

/**
 * How each owner-scoped operation can be reached across the boundary.
 *
 * The key is what matters: this is the list the generated contract is compared
 * against. The value says which attack applies, because the answer to "is this
 * safe" is not the same question for an operation that takes another owner's
 * id as for one that takes none at all.
 */
const OWNER_SCOPED_OPERATIONS = {
  /** Reports which owner the credential speaks for. Takes no identifier. */
  getCurrentOwner: 'SELF',

  /** Acts on everything the owner has, without naming any of it. */
  listProjects: 'OWNER_WIDE',
  createProject: 'OWNER_WIDE',
  exportOwnerMemory: 'OWNER_WIDE',

  /** Names one resource and reads it. */
  getProject: 'RESOURCE_READ',
  getEnvironment: 'RESOURCE_READ',
  getProblem: 'RESOURCE_READ',

  /** Names one resource and changes it. */
  updateProject: 'RESOURCE_WRITE',
  updateProblem: 'RESOURCE_WRITE',
  updateMemoryControl: 'RESOURCE_WRITE',
  transitionProblemStatus: 'RESOURCE_WRITE',
  closeProblem: 'RESOURCE_WRITE',

  /** Names a parent and creates something under it. */
  createEnvironment: 'NESTED_CREATE',
  createProblem: 'NESTED_CREATE',
  appendEvent: 'NESTED_CREATE',
  appendVerification: 'NESTED_CREATE',

  /** Names a parent and lists what is under it. */
  listEnvironments: 'NESTED_LIST',
  listProblems: 'NESTED_LIST',
  listEvents: 'NESTED_LIST',
  listVerifications: 'NESTED_LIST',
  listRelations: 'NESTED_LIST',
  listUsageLogs: 'NESTED_LIST',
  listChangeLogs: 'NESTED_LIST',

  /** Names two resources, either of which could belong to somebody else. */
  createRelation: 'TWO_ENDED_WRITE',
  createUsageLog: 'TWO_ENDED_WRITE',

  /** Removes an aggregate. */
  deleteProblem: 'DELETE',
} as const;

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

interface Owner {
  readonly ownerId: OwnerId;
  readonly token: string;
}

interface Graph {
  readonly projectId: string;
  readonly environmentId: string;
  readonly problemId: string;
  readonly secondProblemId: string;
  readonly eventId: string;
  readonly verificationId: string;
}

describe.skipIf(databaseUrl === undefined)('the owner boundary', () => {
  let pool: DatabasePool;
  let app: FastifyInstance;
  const ownersCreated: OwnerId[] = [];

  let alice: Owner;
  let bob: Owner;
  let aliceGraph: Graph;
  let bobGraph: Graph;

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
      logger: false,
    });
  }

  /**
   * A new owner with a real credential.
   *
   * The token is returned so requests can carry it. It is never put into an
   * assertion message or compared as part of a whole object, so a failure
   * cannot print it.
   */
  async function makeOwner(label: string): Promise<Owner> {
    const ownerId = generateOwnerId();
    await insertOwnerIfAbsent(pool, ownerId);
    ownersCreated.push(ownerId);

    const token = generateCredentialToken();
    await createCredentialRepository(pool).issueClientCredential({
      clientId: generateClientId(),
      ownerId,
      label,
      credentialId: generateCredentialId(),
      tokenLookup: token.lookup,
      tokenHash: hashCredentialSecret(token.secret),
    });

    return { ownerId, token: formatCredentialToken(token) };
  }

  const auth = (owner: Owner) => ({ authorization: `Bearer ${owner.token}` });

  async function post(
    owner: Owner,
    url: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, string>> {
    const response = await app.inject({ method: 'POST', url, headers: auth(owner), payload });
    expect(response.statusCode, `${url} -> ${response.body}`).toBe(201);
    return response.json<Record<string, string>>();
  }

  /** Everything one owner can be given, so every attack has a real target. */
  async function seed(owner: Owner, tag: string): Promise<Graph> {
    const project = await post(owner, '/v1/projects', {
      project_name: `${tag} project`,
      repo: `git@example.com:${tag}/repo.git`,
      platform: 'linux',
    });
    const projectId = project['project_id'] ?? '';

    const environment = await post(owner, `/v1/projects/${projectId}/environments`, {
      snapshot: { runtime: 'node 22.12.0', tag },
    });
    const environmentId = environment['environment_id'] ?? '';

    const makeProblem = async (title: string): Promise<string> => {
      const created = await post(owner, `/v1/projects/${projectId}/problems`, {
        environment_id: environmentId,
        title,
        symptoms: `${tag} symptoms`,
      });
      return created['problem_id'] ?? '';
    };

    const problemId = await makeProblem(`${tag} problem`);
    const secondProblemId = await makeProblem(`${tag} second problem`);

    const event = await post(owner, `/v1/problems/${problemId}/events`, {
      event_type: 'HYPOTHESIS',
      summary: `${tag} hypothesis`,
      client_event_id: randomUUID(),
    });
    const verification = await post(owner, `/v1/problems/${problemId}/verifications`, {
      verification_type: 'TEST',
      result: true,
      summary: `${tag} verification`,
      client_event_id: randomUUID(),
    });

    await post(owner, `/v1/problems/${problemId}/relations`, {
      to_id: secondProblemId,
      relation_type: 'RELATED_TO',
      reason: `${tag} relation`,
    });
    await post(owner, `/v1/problems/${problemId}/usage-logs`, {
      source_ai: 'claude-code',
      action: 'REFERENCED',
      memory_id: secondProblemId,
      reason: `${tag} usage`,
    });

    // A change, so there is a change log to read across the boundary too.
    const patched = await app.inject({
      method: 'PATCH',
      url: `/v1/problems/${problemId}`,
      headers: auth(owner),
      payload: { expected_version: 1, changed_by: `${tag}-author`, importance: true },
    });
    expect(patched.statusCode).toBe(200);

    return {
      projectId,
      environmentId,
      problemId,
      secondProblemId,
      eventId: event['event_id'] ?? '',
      verificationId: verification['verification_id'] ?? '',
    };
  }

  /** Every row one owner has, as text. Used to prove an attack changed nothing. */
  async function fingerprint(owner: Owner): Promise<string> {
    const dumps: string[] = [];
    for (const table of MEMORY_TABLES) {
      const rows = await pool.query(
        `select to_jsonb(t) as row from public.${table} t
          where owner_id = $1 order by to_jsonb(t)::text`,
        [owner.ownerId],
      );
      dumps.push(`${table}:${JSON.stringify(rows.rows)}`);
    }
    return dumps.join('\n');
  }

  /** The response, with the one field that legitimately differs removed. */
  const shape = (response: { statusCode: number; body: string }): string =>
    `${response.statusCode} ${response.body.replace(/"request_id":"[^"]*"/, '')}`;

  beforeAll(async () => {
    pool = createPool(resolveDatabaseConfig({ nodeEnv: 'test', connectionTimeoutMillis: 5_000 }));
    app = buildApp();
    alice = await makeOwner('owner boundary alice');
    bob = await makeOwner('owner boundary bob');
    aliceGraph = await seed(alice, 'alice');
    bobGraph = await seed(bob, 'bob');
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

  describe('the operations that have an owner boundary', () => {
    it('are exactly the ones classified here', async () => {
      const document = JSON.parse(
        (await app.inject({ method: 'GET', url: '/openapi.json' })).body,
      ) as {
        paths: Record<string, Record<string, { operationId: string; security?: unknown[] }>>;
      };

      const published: string[] = [];
      const publicOperations: string[] = [];
      for (const operations of Object.values(document.paths)) {
        for (const operation of Object.values(operations)) {
          // The document requires a credential by default; an operation opts
          // out by declaring an empty security list. That is the definition of
          // owner-scoped, taken from the contract rather than from a habit of
          // naming.
          if (Array.isArray(operation.security) && operation.security.length === 0) {
            publicOperations.push(operation.operationId);
          } else {
            published.push(operation.operationId);
          }
        }
      }

      // Whether the process is serving is not owned by anyone.
      expect(publicOperations).toEqual(['healthCheck']);

      // The assertion that earns this file its place: a new owner-scoped
      // operation is unclassified until somebody decides how it can be
      // attacked, and until then this fails.
      expect(published.sort()).toEqual(Object.keys(OWNER_SCOPED_OPERATIONS).sort());
    });
  });

  describe('an operation that names another owner’s resource', () => {
    /**
     * Every attack Bob can make with Alice's identifiers, one per operation
     * that takes one.
     *
     * `operations` names what each row covers, so the table can be checked
     * against the classification rather than trusted to be complete.
     */
    function attacks(): {
      operations: string[];
      label: string;
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
      url: string;
      payload?: Record<string, unknown>;
    }[] {
      return [
        {
          operations: ['getProject'],
          label: 'read the project',
          method: 'GET',
          url: `/v1/projects/${aliceGraph.projectId}`,
        },
        {
          operations: ['updateProject'],
          label: 'rename the project',
          method: 'PATCH',
          url: `/v1/projects/${aliceGraph.projectId}`,
          payload: { project_name: 'taken over' },
        },
        {
          operations: ['createEnvironment'],
          label: 'add an environment to the project',
          method: 'POST',
          url: `/v1/projects/${aliceGraph.projectId}/environments`,
          payload: { snapshot: { intruder: true } },
        },
        {
          operations: ['listEnvironments'],
          label: 'list the project’s environments',
          method: 'GET',
          url: `/v1/projects/${aliceGraph.projectId}/environments`,
        },
        {
          operations: ['getEnvironment'],
          label: 'read the environment',
          method: 'GET',
          url: `/v1/environments/${aliceGraph.environmentId}`,
        },
        {
          operations: ['createProblem'],
          label: 'start a problem in the project',
          method: 'POST',
          url: `/v1/projects/${aliceGraph.projectId}/problems`,
          payload: {
            environment_id: aliceGraph.environmentId,
            title: 'intruder problem',
            symptoms: 'intruder symptoms',
          },
        },
        {
          operations: ['listProblems'],
          label: 'list the project’s problems',
          method: 'GET',
          url: `/v1/projects/${aliceGraph.projectId}/problems`,
        },
        {
          operations: ['getProblem'],
          label: 'read the problem',
          method: 'GET',
          url: `/v1/problems/${aliceGraph.problemId}`,
        },
        {
          operations: ['updateProblem'],
          label: 'patch the problem',
          method: 'PATCH',
          url: `/v1/problems/${aliceGraph.problemId}`,
          payload: { expected_version: 2, changed_by: 'intruder', title: 'taken over' },
        },
        {
          operations: ['updateMemoryControl'],
          label: 'turn the problem’s memory off',
          method: 'PATCH',
          url: `/v1/problems/${aliceGraph.problemId}/memory-control`,
          payload: { expected_version: 2, changed_by: 'intruder', memory_read_enabled: false },
        },
        {
          operations: ['transitionProblemStatus'],
          label: 'move the problem’s status',
          method: 'POST',
          url: `/v1/problems/${aliceGraph.problemId}/status-transitions`,
          payload: { target_status: 'FIX_CANDIDATE', expected_version: 2, changed_by: 'intruder' },
        },
        {
          operations: ['closeProblem'],
          label: 'conclude the problem',
          method: 'POST',
          url: `/v1/problems/${aliceGraph.problemId}/close`,
          payload: {
            target_status: 'CLOSED_UNRESOLVED',
            expected_version: 2,
            changed_by: 'intruder',
            unresolved_points: 'nothing',
          },
        },
        {
          operations: ['appendEvent'],
          label: 'append an event',
          method: 'POST',
          url: `/v1/problems/${aliceGraph.problemId}/events`,
          payload: {
            event_type: 'DISCOVERY',
            summary: 'intruder discovery',
            client_event_id: randomUUID(),
          },
        },
        {
          operations: ['listEvents'],
          label: 'list the events',
          method: 'GET',
          url: `/v1/problems/${aliceGraph.problemId}/events`,
        },
        {
          operations: ['appendVerification'],
          label: 'append a verification',
          method: 'POST',
          url: `/v1/problems/${aliceGraph.problemId}/verifications`,
          payload: {
            verification_type: 'TEST',
            result: true,
            summary: 'intruder verification',
            client_event_id: randomUUID(),
          },
        },
        {
          operations: ['listVerifications'],
          label: 'list the verifications',
          method: 'GET',
          url: `/v1/problems/${aliceGraph.problemId}/verifications`,
        },
        {
          operations: ['listRelations'],
          label: 'list the links',
          method: 'GET',
          url: `/v1/problems/${aliceGraph.problemId}/relations`,
        },
        {
          operations: ['listUsageLogs'],
          label: 'list how the memory was used',
          method: 'GET',
          url: `/v1/problems/${aliceGraph.problemId}/usage-logs`,
        },
        {
          operations: ['listChangeLogs'],
          label: 'list what changed',
          method: 'GET',
          url: `/v1/problems/${aliceGraph.problemId}/change-logs`,
        },
        {
          operations: ['createRelation'],
          label: 'link from own problem to theirs',
          method: 'POST',
          url: `/v1/problems/${bobGraph.problemId}/relations`,
          payload: {
            to_id: aliceGraph.problemId,
            relation_type: 'RELATED_TO',
            reason: 'reaching across',
          },
        },
        {
          operations: ['createRelation'],
          label: 'link from their problem to own',
          method: 'POST',
          url: `/v1/problems/${aliceGraph.problemId}/relations`,
          payload: {
            to_id: bobGraph.problemId,
            relation_type: 'RELATED_TO',
            reason: 'reaching across',
          },
        },
        {
          operations: ['createUsageLog'],
          label: 'record their problem as memory used',
          method: 'POST',
          url: `/v1/problems/${bobGraph.problemId}/usage-logs`,
          payload: {
            source_ai: 'intruder',
            action: 'ADOPTED',
            memory_id: aliceGraph.problemId,
            reason: 'reaching across',
          },
        },
        {
          operations: ['createUsageLog'],
          label: 'record usage against their problem',
          method: 'POST',
          url: `/v1/problems/${aliceGraph.problemId}/usage-logs`,
          payload: {
            source_ai: 'intruder',
            action: 'ADOPTED',
            memory_id: bobGraph.problemId,
            reason: 'reaching across',
          },
        },
        {
          operations: ['deleteProblem'],
          label: 'delete the problem',
          method: 'DELETE',
          url: `/v1/problems/${aliceGraph.problemId}?expected_version=2`,
        },
      ];
    }

    it('covers every operation that can be given one', () => {
      const targeted = new Set(attacks().flatMap((attack) => attack.operations));
      const shouldBeTargeted = Object.entries(OWNER_SCOPED_OPERATIONS)
        .filter(([, kind]) => kind !== 'SELF' && kind !== 'OWNER_WIDE')
        .map(([operation]) => operation)
        .sort();

      // `SELF` and `OWNER_WIDE` take no identifier and are covered below on
      // their own terms. Everything else has an attack in the table.
      expect([...targeted].sort()).toEqual(shouldBeTargeted);
    });

    it('refuses all of them, revealing nothing and changing nothing', async () => {
      const before = await fingerprint(alice);
      const refusals: string[] = [];

      for (const attack of attacks()) {
        const response = await app.inject({
          method: attack.method,
          url: attack.url,
          headers: auth(bob),
          ...(attack.payload === undefined ? {} : { payload: attack.payload }),
        });

        expect(response.statusCode, `${attack.label} -> ${response.body}`).toBe(404);
        expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
        refusals.push(shape(response));
      }

      // Every refusal is the same refusal. A caller cannot tell which of the
      // attacks touched something real.
      expect(new Set(refusals).size).toBe(1);

      // And nothing Alice has moved — not a row, not a version, not a flag.
      expect(await fingerprint(alice)).toBe(before);
    });
  });

  describe('an identifier that belongs to nobody', () => {
    it('is answered exactly as another owner’s is', async () => {
      const absent = randomUUID();

      const pairs: [string, string, string][] = [
        ['read a problem', `/v1/problems/${aliceGraph.problemId}`, `/v1/problems/${absent}`],
        [
          'list events',
          `/v1/problems/${aliceGraph.problemId}/events`,
          `/v1/problems/${absent}/events`,
        ],
        [
          'list change logs',
          `/v1/problems/${aliceGraph.problemId}/change-logs`,
          `/v1/problems/${absent}/change-logs`,
        ],
        ['read a project', `/v1/projects/${aliceGraph.projectId}`, `/v1/projects/${absent}`],
        [
          'read an environment',
          `/v1/environments/${aliceGraph.environmentId}`,
          `/v1/environments/${absent}`,
        ],
      ];

      for (const [label, theirs, nowhere] of pairs) {
        const owned = await app.inject({ method: 'GET', url: theirs, headers: auth(bob) });
        const missing = await app.inject({ method: 'GET', url: nowhere, headers: auth(bob) });
        expect(shape(owned), label).toBe(shape(missing));
      }
    });

    it('does not let a version guard answer what ownership refused', async () => {
      const absent = randomUUID();

      // A conflict would say "this exists, you guessed the version wrong",
      // which is the existence oracle every other decision here avoids. The
      // ownership check has to come first, at every version.
      for (const version of [1, 2, 999]) {
        const patchTheirs = await app.inject({
          method: 'PATCH',
          url: `/v1/problems/${aliceGraph.problemId}`,
          headers: auth(bob),
          payload: { expected_version: version, changed_by: 'intruder', title: 'x' },
        });
        const patchNowhere = await app.inject({
          method: 'PATCH',
          url: `/v1/problems/${absent}`,
          headers: auth(bob),
          payload: { expected_version: version, changed_by: 'intruder', title: 'x' },
        });

        expect(patchTheirs.statusCode, `version ${version}`).toBe(404);
        expect(shape(patchTheirs), `version ${version}`).toBe(shape(patchNowhere));

        const deleteTheirs = await app.inject({
          method: 'DELETE',
          url: `/v1/problems/${aliceGraph.problemId}?expected_version=${String(version)}`,
          headers: auth(bob),
        });
        expect(deleteTheirs.statusCode, `delete at version ${version}`).toBe(404);
      }
    });
  });

  describe('an idempotency key is not a way in', () => {
    it('cannot reach another owner’s problem, however the key was spent', async () => {
      const key = randomUUID();
      const absent = randomUUID();

      // Bob spends the key legitimately, on his own problem.
      const first = await app.inject({
        method: 'POST',
        url: `/v1/problems/${bobGraph.problemId}/events`,
        headers: auth(bob),
        payload: { event_type: 'DISCOVERY', summary: 'bob’s own', client_event_id: key },
      });
      expect(first.statusCode).toBe(201);

      // Replaying a *used* key is the interesting case: the storage layer's
      // conflict clause would skip the foreign key check, so if ownership were
      // settled by the database rather than before it, this would answer with
      // Bob's original event instead of refusing.
      const atAlice = await app.inject({
        method: 'POST',
        url: `/v1/problems/${aliceGraph.problemId}/events`,
        headers: auth(bob),
        payload: { event_type: 'DISCOVERY', summary: 'reaching across', client_event_id: key },
      });
      const atNowhere = await app.inject({
        method: 'POST',
        url: `/v1/problems/${absent}/events`,
        headers: auth(bob),
        payload: { event_type: 'DISCOVERY', summary: 'reaching across', client_event_id: key },
      });

      expect(atAlice.statusCode).toBe(404);
      // Identical, so the key cannot be used to ask whether an id is real.
      expect(shape(atAlice)).toBe(shape(atNowhere));
      expect(atAlice.body).not.toContain(aliceGraph.problemId);
      expect(atAlice.body).not.toContain('bob’s own');

      const rows = await pool.query<{ owner_id: string; problem_id: string }>(
        `select owner_id, problem_id from public.events where client_event_id = $1`,
        [key],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]?.owner_id).toBe(bob.ownerId);
      expect(rows.rows[0]?.problem_id).toBe(bobGraph.problemId);
    });

    it('is scoped per owner, so one key can be spent by both', async () => {
      const key = randomUUID();

      const byAlice = await app.inject({
        method: 'POST',
        url: `/v1/problems/${aliceGraph.problemId}/events`,
        headers: auth(alice),
        payload: { event_type: 'DISCOVERY', summary: 'alice writes', client_event_id: key },
      });
      const byBob = await app.inject({
        method: 'POST',
        url: `/v1/problems/${bobGraph.problemId}/events`,
        headers: auth(bob),
        payload: { event_type: 'DISCOVERY', summary: 'bob writes', client_event_id: key },
      });

      expect(byAlice.statusCode).toBe(201);
      expect(byBob.statusCode).toBe(201);
      // Neither is handed the other's row, which a global key space would do.
      expect(byBob.body).not.toContain('alice writes');

      const rows = await pool.query<{ owner_id: string }>(
        `select owner_id from public.events where client_event_id = $1`,
        [key],
      );
      expect(rows.rows).toHaveLength(2);
    });
  });

  describe('an operation that names nothing', () => {
    it('reports the owner the credential speaks for, and no other', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/me', headers: auth(bob) });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ owner_id: bob.ownerId });
      expect(response.body).not.toContain(alice.ownerId);
    });

    it('creates under the credential’s owner, whatever the request says', async () => {
      const created = await post(bob, '/v1/projects', { project_name: 'bob’s own project' });
      const projectId = created['project_id'] ?? '';

      const stored = await pool.query<{ owner_id: string }>(
        `select owner_id from public.projects where project_id = $1`,
        [projectId],
      );
      expect(stored.rows[0]?.owner_id).toBe(bob.ownerId);
    });

    it('lists only the credential’s own projects', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/projects', headers: auth(bob) });

      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain(aliceGraph.projectId);
      expect(response.body).not.toContain('alice project');
      expect(response.body).toContain(bobGraph.projectId);
    });

    it('exports one owner’s memory and nothing that grants access to it', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/export', headers: auth(bob) });

      expect(response.statusCode).toBe(200);
      const body = response.body;

      // Nothing of Alice's, by identifier or by text.
      for (const trace of [
        alice.ownerId,
        aliceGraph.projectId,
        aliceGraph.environmentId,
        aliceGraph.problemId,
        aliceGraph.secondProblemId,
        aliceGraph.eventId,
        aliceGraph.verificationId,
        'alice project',
        'alice symptoms',
        'alice hypothesis',
        'alice verification',
        'alice relation',
        'alice usage',
        'alice-author',
      ]) {
        expect(body, 'export carried something of the other owner’s').not.toContain(trace);
      }

      // And nothing from the credential boundary, for either owner.
      for (const forbidden of ['token_hash', 'token_lookup', 'client_id', 'credential_id']) {
        expect(body).not.toContain(forbidden);
      }

      const artifact = JSON.parse(body) as Record<string, unknown>;
      expect(artifact['source_owner_id']).toBe(bob.ownerId);
      // The artifact really is Bob's memory, so the absences above mean
      // something other than an empty document.
      expect(body).toContain(bobGraph.problemId);
      expect(body).toContain('bob hypothesis');
    });
  });

  describe('a link the owner is entitled to make', () => {
    it('still crosses projects, which is what the memory is for', async () => {
      const otherProject = await post(bob, '/v1/projects', { project_name: 'bob’s second area' });
      const otherProjectId = otherProject['project_id'] ?? '';
      const otherEnvironment = await post(bob, `/v1/projects/${otherProjectId}/environments`, {
        snapshot: { runtime: 'deno' },
      });
      const elsewhere = await post(bob, `/v1/projects/${otherProjectId}/problems`, {
        environment_id: otherEnvironment['environment_id'] ?? '',
        title: 'a problem in another project',
        symptoms: 'structurally similar',
      });

      // Refusing across owners must not have become refusing across projects:
      // a problem solved in one project informing another is the point.
      const linked = await app.inject({
        method: 'POST',
        url: `/v1/problems/${bobGraph.problemId}/relations`,
        headers: auth(bob),
        payload: {
          to_id: elsewhere['problem_id'] ?? '',
          relation_type: 'SIMILAR_TO',
          reason: 'same shape, different project',
        },
      });

      expect(linked.statusCode).toBe(201);
    });
  });
});
