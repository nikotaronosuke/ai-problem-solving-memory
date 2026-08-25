/**
 * Deleting a Problem for real: real database, real credential, real HTTP.
 *
 * Nothing is substituted here. The request context comes from a credential the
 * way a client's would, the delete runs the transaction it runs in production,
 * and the assertions read the database directly rather than trusting a
 * response. A delete that is checked only through the API can pass while rows
 * survive in a table nothing reads yet — which is the exact failure this
 * operation exists to prevent.
 *
 * Two things make the fixtures unusual and both are deliberate.
 *
 * The aggregate is built through the real API, so the rows removed are rows
 * the server itself created and nothing in the shape is invented.
 *
 * The secret markers are not. Since P3-02 the boundary refuses or redacts a
 * credential on its way in, so a Problem containing one cannot be created
 * through the API any more — which is the point of that work and not something
 * to weaken here. But the data this delete exists for was written *before*
 * that boundary existed: a mis-saved credential sitting in a summary from last
 * month. So the markers are inserted with raw SQL, simulating history rather
 * than defeating the present. No production flag, no policy override, no
 * test-only seam in the server: the sanitizer runs at full strength in every
 * app this file builds, and the rows it never saw are the ones being purged.
 *
 * Skipped when `DATABASE_URL` is not set.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import {
  createChangeLogService,
  createEventService,
  createHealthService,
  createMemoryControlService,
  createProblemCloseService,
  createExportService,
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
import type { ProblemId } from '../../src/domain/problem.js';
import { resolveOwnerContextFor } from '../../src/owner/context.js';
import { createRetrievalArtifactRepository } from '../../src/repository/index.js';
import { createArtifactInspectionPolicy, withSanitization } from '../../src/sanitization/index.js';
import { buildMemoryHttpApp } from '../../src/http/index.js';
import { createUnusedSearchResolver } from '../support/search-resolver.js';

const databaseUrl = readDatabaseUrl();

/** Every table holding Memory content. Credential tables are a different boundary. */
const MEMORY_TABLES = [
  'projects',
  'environments',
  'problems',
  'events',
  'verifications',
  'relations',
  'usage_logs',
  'change_logs',
  // Derived rather than recorded, and swept exactly like the rest. Being
  // regenerable is a reason it is cheap to lose, not a reason to keep it.
  'retrieval_artifacts',
] as const;

interface Owner {
  readonly ownerId: OwnerId;
  readonly token: string;
}

interface Aggregate {
  readonly projectId: string;
  readonly environmentId: string;
  /** The Problem to be deleted. */
  readonly targetId: string;
  readonly targetVersion: number;
  /** A second Problem that survives and points at the target. */
  readonly neighbourId: string;
}

describe.skipIf(databaseUrl === undefined)('deleting a problem permanently', () => {
  let pool: DatabasePool;
  let app: FastifyInstance;
  const ownersCreated: OwnerId[] = [];

  function buildApp(): FastifyInstance {
    return buildMemoryHttpApp({
      retrievalSearchResolver: createUnusedSearchResolver(),
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

  async function makeOwner(): Promise<Owner> {
    const ownerId = generateOwnerId();
    await insertOwnerIfAbsent(pool, ownerId);
    ownersCreated.push(ownerId);

    const token = generateCredentialToken();
    await createCredentialRepository(pool).issueClientCredential({
      clientId: generateClientId(),
      ownerId,
      label: 'delete test client',
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

  /**
   * Builds a full aggregate through the API.
   *
   * Both directions of every reference are represented, because the ones that
   * point *in* from a surviving Problem are the ones an implementation forgets:
   * a relation from the neighbour to the target, and a usage log recording that
   * the neighbour drew on the target as memory.
   */
  async function seedAggregate(owner: Owner): Promise<Aggregate> {
    const project = await post(owner, '/v1/projects', { project_name: 'delete-path' });
    const projectId = project['project_id'] ?? '';

    const environment = await post(owner, `/v1/projects/${projectId}/environments`, {
      snapshot: { runtime: 'node 22' },
    });
    const environmentId = environment['environment_id'] ?? '';

    const makeProblem = async (title: string): Promise<string> => {
      const created = await post(owner, `/v1/projects/${projectId}/problems`, {
        environment_id: environmentId,
        title,
        symptoms: 'something went wrong',
      });
      return created['problem_id'] ?? '';
    };

    const targetId = await makeProblem('the problem being deleted');
    const neighbourId = await makeProblem('the problem that survives');

    await post(owner, `/v1/problems/${targetId}/events`, {
      event_type: 'HYPOTHESIS',
      summary: 'perhaps the cache',
      client_event_id: randomUUID(),
    });
    await post(owner, `/v1/problems/${targetId}/verifications`, {
      verification_type: 'TEST',
      result: true,
      summary: 'the suite agreed',
      client_event_id: randomUUID(),
    });

    // Outgoing, incoming, and a usage log at each end.
    await post(owner, `/v1/problems/${targetId}/relations`, {
      to_id: neighbourId,
      relation_type: 'RELATED_TO',
      reason: 'target points at neighbour',
    });
    await post(owner, `/v1/problems/${neighbourId}/relations`, {
      to_id: targetId,
      relation_type: 'SIMILAR_TO',
      reason: 'neighbour points at target',
    });
    await post(owner, `/v1/problems/${targetId}/usage-logs`, {
      source_ai: 'claude-code',
      action: 'REFERENCED',
      memory_id: targetId,
      reason: 'target used itself',
    });
    await post(owner, `/v1/problems/${neighbourId}/usage-logs`, {
      source_ai: 'claude-code',
      action: 'ADOPTED',
      memory_id: targetId,
      reason: 'neighbour used target as memory',
    });

    // A change, so the target has a change log too.
    const patched = await app.inject({
      method: 'PATCH',
      url: `/v1/problems/${targetId}`,
      headers: auth(owner),
      payload: { expected_version: 1, changed_by: 'claude-code', importance: true },
    });
    expect(patched.statusCode).toBe(200);
    const targetVersion = patched.json<{ version: number }>().version;

    return { projectId, environmentId, targetId, targetVersion, neighbourId };
  }

  /** How many rows of each kind the aggregate still has. */
  async function census(owner: Owner, problemId: string): Promise<Record<string, number>> {
    const one = async (sql: string): Promise<number> => {
      const result = await pool.query<{ n: string }>(sql, [owner.ownerId, problemId]);
      return Number(result.rows[0]?.n ?? '0');
    };

    return {
      problems: await one(
        `select count(*) n from public.problems where owner_id = $1 and problem_id = $2`,
      ),
      events: await one(
        `select count(*) n from public.events where owner_id = $1 and problem_id = $2`,
      ),
      verifications: await one(
        `select count(*) n from public.verifications where owner_id = $1 and problem_id = $2`,
      ),
      changeLogs: await one(
        `select count(*) n from public.change_logs where owner_id = $1 and problem_id = $2`,
      ),
      relationsFrom: await one(
        `select count(*) n from public.relations where owner_id = $1 and from_id = $2`,
      ),
      relationsTo: await one(
        `select count(*) n from public.relations where owner_id = $1 and to_id = $2`,
      ),
      usageLogsOwn: await one(
        `select count(*) n from public.usage_logs where owner_id = $1 and problem_id = $2`,
      ),
      usageLogsReference: await one(
        `select count(*) n from public.usage_logs where owner_id = $1 and memory_id = $2`,
      ),
      retrievalArtifacts: await one(
        `select count(*) n from public.retrieval_artifacts where owner_id = $1 and problem_id = $2`,
      ),
    };
  }

  const deleteProblem = (owner: Owner, problemId: string, expectedVersion: number | string) =>
    app.inject({
      method: 'DELETE',
      url: `/v1/problems/${problemId}?expected_version=${String(expectedVersion)}`,
      headers: auth(owner),
    });

  beforeAll(() => {
    pool = createPool(resolveDatabaseConfig({ nodeEnv: 'test', connectionTimeoutMillis: 5_000 }));
    app = buildApp();
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
        'retrieval_artifacts',
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

  describe('what a successful delete does', () => {
    it('answers 204 with nothing in the body', async () => {
      const owner = await makeOwner();
      const seeded = await seedAggregate(owner);

      const response = await deleteProblem(owner, seeded.targetId, seeded.targetVersion);

      expect(response.statusCode).toBe(204);
      // Not the deleted Problem, not a summary of it, not an id. A caller
      // removing a mis-saved credential should not be handed it back.
      expect(response.body).toBe('');
      expect(response.headers['content-type']).toBeUndefined();
    });

    it('removes every row of the aggregate, from both directions', async () => {
      const owner = await makeOwner();
      const seeded = await seedAggregate(owner);

      const before = await census(owner, seeded.targetId);
      // The fixture is worth asserting: a delete test against an empty
      // aggregate passes without deleting anything.
      expect(before).toEqual({
        problems: 1,
        events: 1,
        verifications: 1,
        changeLogs: 1,
        relationsFrom: 1,
        relationsTo: 1,
        usageLogsOwn: 1,
        // The target's own log names itself as the memory, and the
        // neighbour's names it too.
        usageLogsReference: 2,
        retrievalArtifacts: 0,
      });

      expect((await deleteProblem(owner, seeded.targetId, seeded.targetVersion)).statusCode).toBe(
        204,
      );

      expect(await census(owner, seeded.targetId)).toEqual({
        problems: 0,
        events: 0,
        verifications: 0,
        changeLogs: 0,
        relationsFrom: 0,
        relationsTo: 0,
        usageLogsOwn: 0,
        usageLogsReference: 0,
        // The derived store goes with everything else the Problem owned.
        retrievalArtifacts: 0,
      });
    });

    it('closes every route that could reach the Problem', async () => {
      const owner = await makeOwner();
      const seeded = await seedAggregate(owner);
      await deleteProblem(owner, seeded.targetId, seeded.targetVersion);

      const gone: readonly [
        'GET' | 'POST' | 'PATCH',
        string,
        Record<string, unknown> | undefined,
      ][] = [
        ['GET', `/v1/problems/${seeded.targetId}`, undefined],
        ['GET', `/v1/problems/${seeded.targetId}/events`, undefined],
        ['GET', `/v1/problems/${seeded.targetId}/verifications`, undefined],
        ['GET', `/v1/problems/${seeded.targetId}/relations`, undefined],
        ['GET', `/v1/problems/${seeded.targetId}/usage-logs`, undefined],
        ['GET', `/v1/problems/${seeded.targetId}/change-logs`, undefined],
        [
          'POST',
          `/v1/problems/${seeded.targetId}/events`,
          { event_type: 'FIX', summary: 'after the fact', client_event_id: randomUUID() },
        ],
        [
          'POST',
          `/v1/problems/${seeded.targetId}/verifications`,
          {
            verification_type: 'TEST',
            result: true,
            summary: 'after the fact',
            client_event_id: randomUUID(),
          },
        ],
        [
          'POST',
          `/v1/problems/${seeded.targetId}/relations`,
          { to_id: seeded.neighbourId, relation_type: 'RELATED_TO', reason: 'after the fact' },
        ],
        [
          'POST',
          `/v1/problems/${seeded.targetId}/usage-logs`,
          {
            source_ai: 'claude-code',
            action: 'REFERENCED',
            memory_id: seeded.neighbourId,
            reason: 'after the fact',
          },
        ],
        [
          'PATCH',
          `/v1/problems/${seeded.targetId}`,
          { expected_version: 2, changed_by: 'claude-code', importance: false },
        ],
        [
          'POST',
          `/v1/problems/${seeded.targetId}/status-transitions`,
          { expected_version: 2, changed_by: 'claude-code', target_status: 'PAUSED' },
        ],
        [
          'POST',
          `/v1/problems/${seeded.targetId}/reviews`,
          {
            expected_version: 2,
            changed_by: 'claude-code',
            target_status: 'CLOSED_UNRESOLVED',
            fix_kind: null,
          },
        ],
      ];

      for (const [method, url, payload] of gone) {
        const response = await app.inject({
          method,
          url,
          headers: auth(owner),
          ...(payload === undefined ? {} : { payload }),
        });

        // The same 404 a Problem that never existed gets, and the same one
        // another owner's gets. Nothing distinguishes deleted from absent.
        expect([method, url, response.statusCode]).toEqual([method, url, 404]);
        expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
      }
    });

    it('leaves it out of the project listing', async () => {
      const owner = await makeOwner();
      const seeded = await seedAggregate(owner);
      await deleteProblem(owner, seeded.targetId, seeded.targetVersion);

      const listed = await app.inject({
        method: 'GET',
        url: `/v1/projects/${seeded.projectId}/problems`,
        headers: auth(owner),
      });

      const ids = listed
        .json<{ problems: { problem_id: string }[] }>()
        .problems.map((problem) => problem.problem_id);
      expect(ids).not.toContain(seeded.targetId);
      expect(ids).toContain(seeded.neighbourId);
    });
  });

  describe('what a delete leaves alone', () => {
    it('keeps the project and the environment', async () => {
      const owner = await makeOwner();
      const seeded = await seedAggregate(owner);
      await deleteProblem(owner, seeded.targetId, seeded.targetVersion);

      // Not orphan cleanup that was forgotten. An Environment is a moment in
      // time other Problems may name, and a Project outlives the problems
      // found in it; removing either as a side effect of a delete would take
      // records nobody asked to lose.
      const project = await app.inject({
        method: 'GET',
        url: `/v1/projects/${seeded.projectId}`,
        headers: auth(owner),
      });
      const environment = await app.inject({
        method: 'GET',
        url: `/v1/environments/${seeded.environmentId}`,
        headers: auth(owner),
      });

      expect(project.statusCode).toBe(200);
      expect(environment.statusCode).toBe(200);
    });

    it('keeps the neighbouring Problem itself', async () => {
      const owner = await makeOwner();
      const seeded = await seedAggregate(owner);
      await deleteProblem(owner, seeded.targetId, seeded.targetVersion);

      const neighbour = await app.inject({
        method: 'GET',
        url: `/v1/problems/${seeded.neighbourId}`,
        headers: auth(owner),
      });

      expect(neighbour.statusCode).toBe(200);

      // But its account of the deleted Problem is gone, and that is the
      // intended trade: a request to remove something outranks another
      // record's description of it.
      const relations = await app.inject({
        method: 'GET',
        url: `/v1/problems/${seeded.neighbourId}/relations`,
        headers: auth(owner),
      });
      const usage = await app.inject({
        method: 'GET',
        url: `/v1/problems/${seeded.neighbourId}/usage-logs`,
        headers: auth(owner),
      });

      expect(relations.json<{ relations: unknown[] }>().relations).toEqual([]);
      expect(usage.json<{ usage_logs: unknown[] }>().usage_logs).toEqual([]);
    });

    it('touches no client or credential', async () => {
      const owner = await makeOwner();
      const seeded = await seedAggregate(owner);

      const before = await pool.query<{ n: string }>(
        `select count(*) n from public.client_credentials cc
           join public.clients c on c.client_id = cc.client_id
          where c.owner_id = $1 and cc.revoked_at is null`,
        [owner.ownerId],
      );

      await deleteProblem(owner, seeded.targetId, seeded.targetVersion);

      const after = await pool.query<{ n: string }>(
        `select count(*) n from public.client_credentials cc
           join public.clients c on c.client_id = cc.client_id
          where c.owner_id = $1 and cc.revoked_at is null`,
        [owner.ownerId],
      );

      expect(before.rows[0]?.n).toBe('1');
      expect(after.rows[0]?.n).toBe('1');
      // And the credential still works, which is the part a count cannot say.
      expect(
        (await app.inject({ method: 'GET', url: '/v1/me', headers: auth(owner) })).statusCode,
      ).toBe(200);
    });
  });

  describe('who may delete', () => {
    it('refuses another owner’s Problem, and changes nothing', async () => {
      const victim = await makeOwner();
      const attacker = await makeOwner();
      const seeded = await seedAggregate(victim);

      const response = await deleteProblem(attacker, seeded.targetId, seeded.targetVersion);

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
      // 404 rather than 403: an attacker learning that a Problem exists but is
      // not theirs is the existence oracle this contract exists to avoid.
      expect(await census(victim, seeded.targetId)).toEqual({
        problems: 1,
        events: 1,
        verifications: 1,
        changeLogs: 1,
        relationsFrom: 1,
        relationsTo: 1,
        usageLogsOwn: 1,
        usageLogsReference: 2,
        retrievalArtifacts: 0,
      });
    });

    it('refuses without a credential, and changes nothing', async () => {
      const owner = await makeOwner();
      const seeded = await seedAggregate(owner);

      const response = await app.inject({
        method: 'DELETE',
        url: `/v1/problems/${seeded.targetId}?expected_version=${String(seeded.targetVersion)}`,
      });

      expect(response.statusCode).toBe(401);
      expect((await census(owner, seeded.targetId)).problems).toBe(1);
    });

    it('refuses a revoked credential, and changes nothing', async () => {
      const owner = await makeOwner();
      const seeded = await seedAggregate(owner);

      const credentials = createCredentialRepository(pool);
      const rows = await pool.query<{ credential_id: string }>(
        `select cc.credential_id from public.client_credentials cc
           join public.clients c on c.client_id = cc.client_id
          where c.owner_id = $1`,
        [owner.ownerId],
      );
      const credentialId = rows.rows[0]?.credential_id ?? '';
      expect(
        await credentials.revoke(
          owner.ownerId,
          credentialId as unknown as Parameters<typeof credentials.revoke>[1],
        ),
      ).toBe(true);

      const response = await deleteProblem(owner, seeded.targetId, seeded.targetVersion);

      expect(response.statusCode).toBe(401);
      expect((await census(owner, seeded.targetId)).problems).toBe(1);
    });
  });

  describe('the version guard', () => {
    it('refuses a stale version and leaves the aggregate whole', async () => {
      const owner = await makeOwner();
      const seeded = await seedAggregate(owner);

      const response = await deleteProblem(owner, seeded.targetId, seeded.targetVersion - 1);

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'VERSION_CONFLICT' } });
      expect(await census(owner, seeded.targetId)).toEqual({
        problems: 1,
        events: 1,
        verifications: 1,
        changeLogs: 1,
        relationsFrom: 1,
        relationsTo: 1,
        usageLogsOwn: 1,
        usageLogsReference: 2,
        retrievalArtifacts: 0,
      });
    });

    it('refuses a version from the future the same way', async () => {
      const owner = await makeOwner();
      const seeded = await seedAggregate(owner);

      const response = await deleteProblem(owner, seeded.targetId, seeded.targetVersion + 5);

      expect(response.statusCode).toBe(409);
      expect((await census(owner, seeded.targetId)).problems).toBe(1);
    });

    it('answers 404 rather than 409 for another owner’s Problem at any version', async () => {
      const victim = await makeOwner();
      const attacker = await makeOwner();
      const seeded = await seedAggregate(victim);

      // Existence is settled before the version, so guessing a version cannot
      // be used to tell a real Problem from an imaginary one.
      for (const version of [1, seeded.targetVersion, 99]) {
        const response = await deleteProblem(attacker, seeded.targetId, version);
        expect(response.statusCode).toBe(404);
      }
    });

    it('requires the guard, and refuses one that is not a version', async () => {
      const owner = await makeOwner();
      const seeded = await seedAggregate(owner);

      const missing = await app.inject({
        method: 'DELETE',
        url: `/v1/problems/${seeded.targetId}`,
        headers: auth(owner),
      });
      expect(missing.statusCode).toBe(400);

      for (const bad of ['0', '-1', 'latest', '']) {
        const response = await deleteProblem(owner, seeded.targetId, bad);
        expect([bad, response.statusCode]).toEqual([bad, 400]);
      }

      // An unexpected parameter is refused rather than ignored, so a
      // misspelled guard is heard about before the row is gone.
      const extra = await app.inject({
        method: 'DELETE',
        url: `/v1/problems/${seeded.targetId}?expected_version=${String(seeded.targetVersion)}&force=true`,
        headers: auth(owner),
      });
      expect(extra.statusCode).toBe(400);

      expect((await census(owner, seeded.targetId)).problems).toBe(1);
    });
  });

  describe('deleting twice', () => {
    it('is 204 then 404, and the state after both is the same', async () => {
      const owner = await makeOwner();
      const seeded = await seedAggregate(owner);

      const first = await deleteProblem(owner, seeded.targetId, seeded.targetVersion);
      const second = await deleteProblem(owner, seeded.targetId, seeded.targetVersion);

      expect(first.statusCode).toBe(204);
      expect(second.statusCode).toBe(404);
      expect((await census(owner, seeded.targetId)).problems).toBe(0);
    });
  });

  describe('a credential mis-saved before the boundary existed', () => {
    /**
     * Writes a marker into every free-text surface the aggregate has.
     *
     * Raw SQL on purpose. These values would be refused or redacted by the
     * sanitization boundary today, which is what P3-02 and P3-03 are for; the
     * data this delete exists to remove predates that boundary. Simulating the
     * history is honest, weakening the present would not be.
     */
    async function seedHistoricalSecrets(owner: Owner, seeded: Aggregate, marker: string) {
      const scope = [owner.ownerId, seeded.targetId];

      await pool.query(
        `update public.problems
            set title = $3, symptoms = $4, problem_domain = $5, source_ai = $6
          where owner_id = $1 and problem_id = $2`,
        [
          ...scope,
          `deploy fails with API_KEY=${marker}`,
          `the log line read AWS_SECRET_ACCESS_KEY=${marker}`,
          `password=${marker}`,
          `agent token=${marker}`,
        ],
      );
      await pool.query(
        `update public.events
            set summary = $3, result = $4, reason = $5, evidence_ref = $6
          where owner_id = $1 and problem_id = $2`,
        [
          ...scope,
          `tried the key API_KEY=${marker}`,
          `authorization: Bearer ${marker}`,
          `rotated ${marker}`,
          `see paste containing ${marker}`,
        ],
      );
      await pool.query(
        `update public.verifications
            set summary = $3, evidence_ref = $4, verified_by = $5
          where owner_id = $1 and problem_id = $2`,
        [...scope, `checked with token=${marker}`, `run log with ${marker}`, `runner-${marker}`],
      );
      // Both ends: the relation the target owns and the one pointing at it.
      await pool.query(
        `update public.relations set reason = $3
          where owner_id = $1 and (from_id = $2 or to_id = $2)`,
        [...scope, `both mention client_secret=${marker}`],
      );
      // Both the target's own usage log and the surviving neighbour's
      // reference to it.
      await pool.query(
        `update public.usage_logs set reason = $3, result = $4
          where owner_id = $1 and (problem_id = $2 or memory_id = $2)`,
        [...scope, `reused password=${marker}`, `worked, with ${marker}`],
      );
      await pool.query(
        `update public.change_logs set changed_by = $3
          where owner_id = $1 and problem_id = $2`,
        [...scope, `tool-${marker}`],
      );
    }

    /** Everything in every Memory table for these owners, as text. */
    async function sweep(owners: OwnerId[]): Promise<string> {
      const dumps: string[] = [];
      for (const table of MEMORY_TABLES) {
        const rows = await pool.query(
          `select to_jsonb(t) as row from public.${table} t where owner_id = any($1::uuid[])`,
          [owners],
        );
        dumps.push(JSON.stringify(rows.rows));
      }
      return dumps.join('\n');
    }

    it('is gone from every Memory table after the delete', async () => {
      const owner = await makeOwner();
      const seeded = await seedAggregate(owner);
      const marker = `AKIA${randomUUID().replaceAll('-', '').toUpperCase().slice(0, 16)}`;

      await seedHistoricalSecrets(owner, seeded, marker);

      // The fixture has to be real before the delete, or the sweep afterwards
      // proves only that the marker was never there.
      expect(await sweep([owner.ownerId])).toContain(marker);

      expect((await deleteProblem(owner, seeded.targetId, seeded.targetVersion)).statusCode).toBe(
        204,
      );

      const after = await sweep([owner.ownerId]);
      expect(after).not.toContain(marker);
      // The surviving Problem is still there — the marker went with the rows
      // that referred to the deleted one, not by emptying the database.
      expect(after).toContain(seeded.neighbourId);
    });

    it('takes it out of the surviving Problem’s own records too', async () => {
      const owner = await makeOwner();
      const seeded = await seedAggregate(owner);
      const marker = `ghp_${randomUUID().replaceAll('-', '')}`;

      await seedHistoricalSecrets(owner, seeded, marker);
      await deleteProblem(owner, seeded.targetId, seeded.targetVersion);

      // Read back through the API rather than the database: what a client can
      // still retrieve is the question that matters to whoever asked for the
      // deletion.
      const relations = await app.inject({
        method: 'GET',
        url: `/v1/problems/${seeded.neighbourId}/relations`,
        headers: auth(owner),
      });
      const usage = await app.inject({
        method: 'GET',
        url: `/v1/problems/${seeded.neighbourId}/usage-logs`,
        headers: auth(owner),
      });

      expect(relations.body).not.toContain(marker);
      expect(usage.body).not.toContain(marker);
    });

    it('does not reach another owner’s copy of the same string', async () => {
      const owner = await makeOwner();
      const other = await makeOwner();
      const marker = `AKIA${randomUUID().replaceAll('-', '').toUpperCase().slice(0, 16)}`;

      const seeded = await seedAggregate(owner);
      const otherSeeded = await seedAggregate(other);
      await seedHistoricalSecrets(owner, seeded, marker);
      await seedHistoricalSecrets(other, otherSeeded, marker);

      await deleteProblem(owner, seeded.targetId, seeded.targetVersion);

      // This is a Problem delete, not a search-and-destroy for a string. The
      // other owner's rows are untouched, which is also what keeps the
      // operation from being usable across the owner boundary.
      expect(await sweep([owner.ownerId])).not.toContain(marker);
      expect(await sweep([other.ownerId])).toContain(marker);
    });
  });

  /**
   * The same claim, without a credential anywhere in it (P3-11).
   *
   * Everything above plants secret-shaped markers with raw SQL, because the
   * data a delete exists for was written before the sanitization boundary. That
   * makes those proofs depend on two things at once: the delete removing the
   * rows, and the detector recognising what is in them. If the detector's
   * patterns changed, a marker could stop being found for a reason that has
   * nothing to do with deletion.
   *
   * So this plants ordinary prose instead, through the ordinary API, and asks
   * only the question the delete is responsible for: is any of it still
   * reachable? Nothing here is redacted on the way in, which the fixture
   * asserts before deleting anything.
   *
   * The second marker is the point of the pair. Sweeping for one string and
   * finding nothing also happens when the delete removed far too much, so a
   * control string is planted in the parent Project and Environment — which
   * survive a Problem delete by design — and in the neighbouring Problem. The
   * test passes only if one marker is gone and the other is still there.
   */
  describe('after deleting an aggregate built entirely through the API', () => {
    interface CleanAggregate {
      readonly projectId: string;
      readonly environmentId: string;
      readonly targetId: string;
      readonly targetVersion: number;
      readonly neighbourId: string;
      /** Written only into the target and the rows that refer to it. */
      readonly doomed: string;
      /** Written only into things that must survive. */
      readonly kept: string;
    }

    /** Everything in every Memory table for one owner, as text. */
    async function sweepOwner(owner: Owner): Promise<string> {
      const dumps: string[] = [];
      for (const table of MEMORY_TABLES) {
        const rows = await pool.query(
          `select to_jsonb(t) as row from public.${table} t where owner_id = $1`,
          [owner.ownerId],
        );
        dumps.push(JSON.stringify(rows.rows));
      }
      return dumps.join('\n');
    }

    /**
     * Builds the aggregate with a marker in every caller-written field it has.
     *
     * The markers are plain words. Nothing here is secret-shaped, so the
     * sanitizer has no reason to touch it — and the fixture check below
     * confirms that rather than assuming it.
     */
    async function seedCleanAggregate(owner: Owner): Promise<CleanAggregate> {
      const doomed = `p311doomed${randomUUID().replaceAll('-', '')}`;
      const kept = `p311kept${randomUUID().replaceAll('-', '')}`;

      // The parent survives a Problem delete, so it carries the control marker.
      const project = await post(owner, '/v1/projects', {
        project_name: `project holding ${kept}`,
        repo: `notes about ${kept}`,
        platform: `platform ${kept}`,
      });
      const projectId = project['project_id'] ?? '';

      const environment = await post(owner, `/v1/projects/${projectId}/environments`, {
        snapshot: { runtime: 'node 22.12.0', note: `environment holding ${kept}` },
      });
      const environmentId = environment['environment_id'] ?? '';

      const target = await post(owner, `/v1/projects/${projectId}/problems`, {
        environment_id: environmentId,
        title: `the problem holding ${doomed}`,
        symptoms: `symptoms mentioning ${doomed}`,
        problem_domain: `domain ${doomed}`,
        suspected_boundary: `boundary ${doomed}`,
        source_ai: `assistant ${doomed}`,
      });
      const targetId = target['problem_id'] ?? '';

      const neighbour = await post(owner, `/v1/projects/${projectId}/problems`, {
        environment_id: environmentId,
        title: `the problem that survives, holding ${kept}`,
        symptoms: `symptoms mentioning ${kept}`,
      });
      const neighbourId = neighbour['problem_id'] ?? '';

      await post(owner, `/v1/problems/${targetId}/events`, {
        event_type: 'HYPOTHESIS',
        summary: `hypothesis about ${doomed}`,
        result: `result mentioning ${doomed}`,
        reason: `reason mentioning ${doomed}`,
        evidence_ref: `evidence ${doomed}`,
        source_ai: `assistant ${doomed}`,
        client_event_id: randomUUID(),
      });
      await post(owner, `/v1/problems/${targetId}/verifications`, {
        verification_type: 'TEST',
        result: true,
        summary: `verified something about ${doomed}`,
        evidence_ref: `run log ${doomed}`,
        verified_by: `runner ${doomed}`,
        client_event_id: randomUUID(),
      });

      // Both directions, so the incoming reference from a surviving Problem is
      // planted too — that is the one an implementation forgets.
      await post(owner, `/v1/problems/${targetId}/relations`, {
        to_id: neighbourId,
        relation_type: 'RELATED_TO',
        reason: `target points outward, ${doomed}`,
      });
      await post(owner, `/v1/problems/${neighbourId}/relations`, {
        to_id: targetId,
        relation_type: 'SIMILAR_TO',
        reason: `neighbour points inward, ${doomed}`,
      });
      await post(owner, `/v1/problems/${targetId}/usage-logs`, {
        source_ai: `assistant ${doomed}`,
        action: 'REFERENCED',
        memory_id: targetId,
        reason: `the target used itself, ${doomed}`,
        result: `result ${doomed}`,
      });
      await post(owner, `/v1/problems/${neighbourId}/usage-logs`, {
        source_ai: `assistant ${doomed}`,
        action: 'ADOPTED',
        memory_id: targetId,
        reason: `the neighbour drew on the target, ${doomed}`,
        result: `result ${doomed}`,
      });

      // A change, so a change log exists — its `changed_by` is caller-written.
      const patched = await app.inject({
        method: 'PATCH',
        url: `/v1/problems/${targetId}`,
        headers: auth(owner),
        payload: {
          expected_version: 1,
          changed_by: `author ${doomed}`,
          title: `retitled, still holding ${doomed}`,
        },
      });
      expect(patched.statusCode).toBe(200);

      // The derived store, written through the same boundary production uses.
      // The target's artifact carries the doomed marker and the survivor's the
      // control one, so the sweep below can tell a delete from a wipe here too.
      const context = await resolveOwnerContextFor(pool, owner.ownerId);
      const artifacts = withSanitization(
        createRetrievalArtifactRepository(pool, context),
        createArtifactInspectionPolicy(),
      );
      const artifact = (problemId: string, marker: string) => ({
        problemId: problemId as ProblemId,
        normalizedSummary: `a searchable rendering holding ${marker}`,
        keywords: [marker, 'deployment'],
        structuralFeatures: { boundary: 'configuration', note: marker },
        summaryGeneratorId: 'fixture-summary-generator',
        summaryGeneratorVersion: '1',
        semantic: {
          embedding: [0.5, 0.25, 0.125],
          embeddingModel: 'fixture-model',
          embeddingModelVersion: '1',
        },
        sourceFingerprint: `fingerprint-${marker}`,
        generatedAt: new Date('2026-08-15T10:00:00.000Z'),
      });
      await artifacts.upsertArtifact(artifact(targetId, doomed));
      await artifacts.upsertArtifact(artifact(neighbourId, kept));

      return {
        projectId,
        environmentId,
        targetId,
        targetVersion: patched.json<{ version: number }>().version,
        neighbourId,
        doomed,
        kept,
      };
    }

    it('leaves nothing of it in any Memory table, and everything else alone', async () => {
      const owner = await makeOwner();
      const seeded = await seedCleanAggregate(owner);

      // The fixture has to be real first. This also confirms the markers were
      // stored as written: had the sanitizer redacted them, the sweep
      // afterwards would prove nothing.
      const before = await sweepOwner(owner);
      expect(before).toContain(seeded.doomed);
      expect(before).toContain(seeded.kept);

      const populated = await census(owner, seeded.targetId);
      expect(populated).toEqual({
        problems: 1,
        events: 1,
        verifications: 1,
        changeLogs: 1,
        relationsFrom: 1,
        relationsTo: 1,
        usageLogsOwn: 1,
        usageLogsReference: 2,
        retrievalArtifacts: 1,
      });

      expect((await deleteProblem(owner, seeded.targetId, seeded.targetVersion)).statusCode).toBe(
        204,
      );

      const after = await sweepOwner(owner);

      // Nothing the deleted Problem carried, in any of the eight tables.
      expect(after).not.toContain(seeded.doomed);
      expect(after).not.toContain(seeded.targetId);

      // And this is why the pair exists: the Project, the Environment and the
      // neighbouring Problem are all still there, so the absence above is a
      // delete rather than an empty database.
      expect(after).toContain(seeded.kept);
      expect(after).toContain(seeded.neighbourId);
      expect(after).toContain(seeded.projectId);
      expect(after).toContain(seeded.environmentId);

      expect(await census(owner, seeded.targetId)).toEqual({
        problems: 0,
        events: 0,
        verifications: 0,
        changeLogs: 0,
        relationsFrom: 0,
        relationsTo: 0,
        usageLogsOwn: 0,
        usageLogsReference: 0,
        retrievalArtifacts: 0,
      });
    });

    it('leaves nothing of it in the export either', async () => {
      const owner = await makeOwner();
      const seeded = await seedCleanAggregate(owner);

      const before = await app.inject({
        method: 'GET',
        url: '/v1/export',
        headers: auth(owner),
      });
      expect(before.statusCode).toBe(200);
      expect(before.body).toContain(seeded.doomed);

      expect((await deleteProblem(owner, seeded.targetId, seeded.targetVersion)).statusCode).toBe(
        204,
      );

      const after = await app.inject({ method: 'GET', url: '/v1/export', headers: auth(owner) });
      expect(after.statusCode).toBe(200);

      // The artifact is the form the Memory takes when it leaves, so a
      // residual that survives only there is still a residual.
      expect(after.body).not.toContain(seeded.doomed);
      expect(after.body).not.toContain(seeded.targetId);

      // Still a real export of what remains.
      expect(after.body).toContain(seeded.kept);
      expect(after.body).toContain(seeded.neighbourId);
    });
  });
});
