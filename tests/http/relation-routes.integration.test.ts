/**
 * Relation endpoints over a real database.
 *
 * Two owners per run, driven entirely through HTTP. Three things matter here.
 *
 * That a link may cross projects — that is the point of it, and the reason
 * this memory is worth keeping at all: a problem solved in one project
 * informing an investigation in another.
 *
 * That it may not cross owners, and that refusing it reveals nothing. Both
 * ends are checked, and another owner's problem is indistinguishable from one
 * that does not exist.
 *
 * And that a link is a link. Relating a verified Problem to an unverified one
 * does not carry status, evidence or confidence across; the second still needs
 * its own successful Verification, and neither Problem's version moves.
 *
 * Fixtures are made and removed here. Nothing depends on the developer's owner
 * or on what a previous run left.
 *
 * Skipped when `DATABASE_URL` is not set.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import {
  createEventService,
  createHealthService,
  createProblemService,
  createProblemStatusService,
  createProjectEnvironmentService,
  createRelationService,
  createUsageLogService,
  createChangeLogService,
  createRequestContextService,
  createVerificationService,
} from '../../src/app/index.js';
import { readDatabaseUrl } from '../../src/config/env.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import { createTransactionRunner } from '../../src/db/transaction.js';
import { generateClientEventId } from '../../src/domain/client-event-id.js';
import { RELATION_TYPES } from '../../src/domain/enums.js';
import { generateOwnerId, type OwnerId } from '../../src/domain/owner.js';
import { generateProblemId } from '../../src/domain/problem.js';
import { buildMemoryHttpApp } from '../../src/http/index.js';
import { MEMORY_OWNER_ID_VAR } from '../../src/owner/context.js';

const databaseUrl = readDatabaseUrl();

interface Actor {
  readonly app: FastifyInstance;
  readonly ownerId: OwnerId;
}

describe.skipIf(databaseUrl === undefined)('Relation API', () => {
  let pool: DatabasePool;
  const ownersCreated: OwnerId[] = [];
  const appsCreated: FastifyInstance[] = [];

  async function makeActor(): Promise<Actor> {
    const ownerId = generateOwnerId();
    await insertOwnerIfAbsent(pool, ownerId);
    ownersCreated.push(ownerId);

    const app = buildMemoryHttpApp({
      healthService: createHealthService(pool),
      requestContextService: createRequestContextService(pool, createTransactionRunner(pool), {
        [MEMORY_OWNER_ID_VAR]: ownerId,
      }),
      projectEnvironmentService: createProjectEnvironmentService(),
      problemService: createProblemService(),
      problemStatusService: createProblemStatusService(),
      eventService: createEventService(),
      verificationService: createVerificationService(),
      relationService: createRelationService(),
      usageLogService: createUsageLogService(),
      changeLogService: createChangeLogService(),
      logger: false,
    });
    appsCreated.push(app);

    return { app, ownerId };
  }

  /** A problem, in a project of the given name so cross-project cases are clear. */
  async function makeProblem(actor: Actor, projectName = 'fixture-project'): Promise<string> {
    const project = await actor.app.inject({
      method: 'POST',
      url: '/v1/projects',
      payload: { project_name: projectName },
    });
    expect(project.statusCode).toBe(201);
    const projectId = project.json<{ project_id: string }>().project_id;

    const environment = await actor.app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/environments`,
      payload: { snapshot: { runtime: 'node 22.12.0' } },
    });
    expect(environment.statusCode).toBe(201);

    const problem = await actor.app.inject({
      method: 'POST',
      url: `/v1/projects/${projectId}/problems`,
      payload: {
        environment_id: environment.json<{ environment_id: string }>().environment_id,
        title: `Problem in ${projectName}`,
        symptoms: 'Fixture symptoms',
      },
    });
    expect(problem.statusCode).toBe(201);
    return problem.json<{ problem_id: string }>().problem_id;
  }

  function relate(actor: Actor, fromId: string, body: Record<string, unknown>) {
    return actor.app.inject({
      method: 'POST',
      url: `/v1/problems/${fromId}/relations`,
      payload: body,
    });
  }

  async function relateOk(actor: Actor, fromId: string, toId: string, relationType = 'SIMILAR_TO') {
    const response = await relate(actor, fromId, {
      to_id: toId,
      relation_type: relationType,
      reason: 'Fixture reason',
    });
    expect(response.statusCode).toBe(201);
    return response.json<Record<string, unknown>>();
  }

  async function listRelations(actor: Actor, problemId: string) {
    const response = await actor.app.inject({
      method: 'GET',
      url: `/v1/problems/${problemId}/relations`,
    });
    expect(response.statusCode).toBe(200);
    return response.json<{ relations: Record<string, unknown>[] }>().relations;
  }

  async function readProblem(actor: Actor, problemId: string) {
    const response = await actor.app.inject({ method: 'GET', url: `/v1/problems/${problemId}` });
    expect(response.statusCode).toBe(200);
    return response.json<Record<string, unknown>>();
  }

  async function countRelations(ownerId: OwnerId): Promise<number> {
    const result = await pool.query<{ count: string }>(
      'select count(*)::text as count from public.relations where owner_id = $1',
      [ownerId],
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  beforeAll(() => {
    pool = createPool(resolveDatabaseConfig({ nodeEnv: 'test', connectionTimeoutMillis: 5_000 }));
  });

  afterAll(async () => {
    for (const app of appsCreated) {
      await app.close();
    }
    if (ownersCreated.length > 0) {
      // Children first: every foreign key restricts deleting the parent.
      for (const table of [
        'change_logs',
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

  describe('linking two problems', () => {
    it('records the link with the ids and time the server decides', async () => {
      const actor = await makeActor();
      const from = await makeProblem(actor);
      const to = await makeProblem(actor);

      const relation = await relateOk(actor, from, to);

      expect(relation).toMatchObject({
        owner_id: actor.ownerId,
        from_id: from,
        to_id: to,
        relation_type: 'SIMILAR_TO',
        reason: 'Fixture reason',
      });
      expect(typeof relation['relation_id']).toBe('string');
      expect(relation).not.toHaveProperty('updated_at');
      expect(relation).not.toHaveProperty('version');
    });

    it('trims the reason', async () => {
      const actor = await makeActor();
      const from = await makeProblem(actor);
      const to = await makeProblem(actor);

      const response = await relate(actor, from, {
        to_id: to,
        relation_type: 'RELATED_TO',
        reason: '  Both fail only behind the CDN.  ',
      });

      expect(response.json<{ reason: string }>().reason).toBe('Both fail only behind the CDN.');
    });

    it.each(RELATION_TYPES)('records a %s link', async (relationType) => {
      const actor = await makeActor();
      const from = await makeProblem(actor);
      const to = await makeProblem(actor);

      const relation = await relateOk(actor, from, to, relationType);

      expect(relation).toMatchObject({ relation_type: relationType, from_id: from, to_id: to });
    });

    it('links problems in different projects', async () => {
      const actor = await makeActor();
      const inCheckout = await makeProblem(actor, 'checkout-web');
      const inAdmin = await makeProblem(actor, 'admin-console');

      const relation = await relateOk(actor, inCheckout, inAdmin);

      // The reason this memory is worth keeping: experience from one project
      // reaching an investigation in another.
      expect(relation).toMatchObject({ from_id: inCheckout, to_id: inAdmin });
      expect(await listRelations(actor, inCheckout)).toHaveLength(1);
      expect(await listRelations(actor, inAdmin)).toHaveLength(1);
    });
  });

  describe('reading a problem’s links', () => {
    it('finds the same link from either end, stored once', async () => {
      const actor = await makeActor();
      const from = await makeProblem(actor);
      const to = await makeProblem(actor);

      const relation = await relateOk(actor, from, to);

      const fromSide = await listRelations(actor, from);
      const toSide = await listRelations(actor, to);

      expect(fromSide).toEqual([relation]);
      expect(toSide).toEqual([relation]);
      // One row, not a mirrored pair.
      expect(await countRelations(actor.ownerId)).toBe(1);
    });

    it.each(['CAUSED_BY', 'SUPERSEDES', 'DERIVED_FROM'])(
      'keeps a %s link pointing the way it was recorded',
      async (relationType) => {
        const actor = await makeActor();
        const from = await makeProblem(actor);
        const to = await makeProblem(actor);

        await relateOk(actor, from, to, relationType);

        // Read from the target end, where a flip would be tempting and would
        // state the opposite of what was recorded.
        const [seen] = await listRelations(actor, to);
        expect(seen).toMatchObject({ from_id: from, to_id: to, relation_type: relationType });
      },
    );

    it('lists oldest first, and shows both ends together', async () => {
      const actor = await makeActor();
      const hub = await makeProblem(actor);
      const outgoing = await makeProblem(actor);
      const incoming = await makeProblem(actor);

      const first = await relateOk(actor, hub, outgoing, 'RELATED_TO');
      const second = await relateOk(actor, incoming, hub, 'CAUSED_BY');

      const listed = await listRelations(actor, hub);

      // A link recorded from the other side is still this problem's link.
      expect(listed.map((r) => r['relation_id'])).toEqual([
        first['relation_id'],
        second['relation_id'],
      ]);
      expect(listed[1]).toMatchObject({ from_id: incoming, to_id: hub });
    });

    it('returns an empty list for a problem with no links', async () => {
      const actor = await makeActor();

      expect(await listRelations(actor, await makeProblem(actor))).toEqual([]);
    });

    it('refuses to list the links of an unknown problem', async () => {
      const actor = await makeActor();

      const response = await actor.app.inject({
        method: 'GET',
        url: `/v1/problems/${generateProblemId()}/relations`,
      });

      // Not an empty list: that would say "it exists and has none".
      expect(response.statusCode).toBe(404);
    });
  });

  describe('what is refused', () => {
    it('refuses a link from a problem to itself', async () => {
      const actor = await makeActor();
      const problem = await makeProblem(actor);

      const response = await relate(actor, problem, {
        to_id: problem,
        relation_type: 'SIMILAR_TO',
        reason: 'Itself',
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
      expect(await countRelations(actor.ownerId)).toBe(0);
    });

    it('refuses an unknown source', async () => {
      const actor = await makeActor();
      const to = await makeProblem(actor);

      const response = await relate(actor, generateProblemId(), {
        to_id: to,
        relation_type: 'SIMILAR_TO',
        reason: 'Should not land',
      });

      expect(response.statusCode).toBe(404);
      expect(await countRelations(actor.ownerId)).toBe(0);
    });

    it('refuses an unknown target', async () => {
      const actor = await makeActor();
      const from = await makeProblem(actor);

      const response = await relate(actor, from, {
        to_id: generateProblemId(),
        relation_type: 'SIMILAR_TO',
        reason: 'Should not land',
      });

      expect(response.statusCode).toBe(404);
      expect(await countRelations(actor.ownerId)).toBe(0);
    });
  });

  describe('what one owner can reach of another', () => {
    it('refuses a link to another owner’s problem, revealing nothing about it', async () => {
      const mine = await makeActor();
      const theirs = await makeActor();
      const myProblem = await makeProblem(mine);
      const theirProblem = await makeProblem(theirs, 'their-secret-project');

      const response = await relate(mine, myProblem, {
        to_id: theirProblem,
        relation_type: 'SIMILAR_TO',
        reason: 'Should not land',
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
      // Nothing of theirs in the body: not the title, not the project name,
      // not the status.
      expect(response.body).not.toContain('their-secret-project');
      expect(response.body).not.toContain('Problem in');
      expect(response.body).not.toContain('INVESTIGATING');
      expect(await countRelations(mine.ownerId)).toBe(0);
      expect(await countRelations(theirs.ownerId)).toBe(0);
    });

    it('refuses another owner’s problem as the source', async () => {
      const mine = await makeActor();
      const theirs = await makeActor();
      const myProblem = await makeProblem(mine);
      const theirProblem = await makeProblem(theirs);

      const response = await relate(mine, theirProblem, {
        to_id: myProblem,
        relation_type: 'SIMILAR_TO',
        reason: 'Should not land',
      });

      expect(response.statusCode).toBe(404);
      expect(await countRelations(mine.ownerId)).toBe(0);
    });

    it('answers the same for another owner’s target as for one that does not exist', async () => {
      const mine = await makeActor();
      const theirs = await makeActor();
      const myProblem = await makeProblem(mine);
      const theirProblem = await makeProblem(theirs);

      const crossOwner = await relate(mine, myProblem, {
        to_id: theirProblem,
        relation_type: 'SIMILAR_TO',
        reason: 'r',
      });
      const unknown = await relate(mine, myProblem, {
        to_id: generateProblemId(),
        relation_type: 'SIMILAR_TO',
        reason: 'r',
      });

      // `request_id` differs per request, so the comparison is of the part
      // that carries meaning.
      expect(crossOwner.statusCode).toBe(unknown.statusCode);
      expect(crossOwner.json<{ error: unknown }>().error).toEqual(
        unknown.json<{ error: unknown }>().error,
      );
    });

    it('cannot read another owner’s links', async () => {
      const mine = await makeActor();
      const theirs = await makeActor();
      const theirFrom = await makeProblem(theirs);
      const theirTo = await makeProblem(theirs);
      await relateOk(theirs, theirFrom, theirTo);

      const response = await mine.app.inject({
        method: 'GET',
        url: `/v1/problems/${theirFrom}/relations`,
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    });

    it('does not show one owner’s links in another’s list', async () => {
      const mine = await makeActor();
      const theirs = await makeActor();
      const myFrom = await makeProblem(mine);
      const myTo = await makeProblem(mine);
      const theirFrom = await makeProblem(theirs);
      await relateOk(theirs, theirFrom, await makeProblem(theirs));
      const mineRelation = await relateOk(mine, myFrom, myTo);

      expect(await listRelations(mine, myFrom)).toEqual([mineRelation]);
      expect(await countRelations(mine.ownerId)).toBe(1);
      expect(await countRelations(theirs.ownerId)).toBe(1);
    });
  });

  describe('a link is a link, not an inheritance', () => {
    it('leaves both problems exactly as they were', async () => {
      const actor = await makeActor();
      const from = await makeProblem(actor);
      const to = await makeProblem(actor);
      const fromBefore = await readProblem(actor, from);
      const toBefore = await readProblem(actor, to);

      await relateOk(actor, from, to);

      // No version moved, no status changed, no `updated_at` advanced. A
      // relation is not a write to either Problem.
      expect(await readProblem(actor, from)).toEqual(fromBefore);
      expect(await readProblem(actor, to)).toEqual(toBefore);
    });

    it('links problems at different versions without touching either', async () => {
      const actor = await makeActor();
      const from = await makeProblem(actor);
      const to = await makeProblem(actor);

      // Move them to different versions first.
      for (const [problem, times] of [
        [from, 2],
        [to, 4],
      ] as const) {
        for (let index = 0; index < times; index += 1) {
          const current = await readProblem(actor, problem);
          const response = await actor.app.inject({
            method: 'PATCH',
            url: `/v1/problems/${problem}`,
            payload: {
              expected_version: current['version'],
              changed_by: 'claude-code',
              title: `edit ${index}`,
            },
          });
          expect(response.statusCode).toBe(200);
        }
      }

      const fromVersion = (await readProblem(actor, from))['version'];
      const toVersion = (await readProblem(actor, to))['version'];
      expect(fromVersion).toBe(3);
      expect(toVersion).toBe(5);

      await relateOk(actor, from, to);

      expect((await readProblem(actor, from))['version']).toBe(fromVersion);
      expect((await readProblem(actor, to))['version']).toBe(toVersion);
    });

    it('does not let a verified problem’s evidence verify the one it is linked to', async () => {
      const actor = await makeActor();
      const verified = await makeProblem(actor);
      const other = await makeProblem(actor);

      // Verify the first, properly.
      const toCandidate = await actor.app.inject({
        method: 'POST',
        url: `/v1/problems/${verified}/status-transitions`,
        payload: { target_status: 'FIX_CANDIDATE', expected_version: 1, changed_by: 'claude-code' },
      });
      expect(toCandidate.statusCode).toBe(200);
      const verification = await actor.app.inject({
        method: 'POST',
        url: `/v1/problems/${verified}/verifications`,
        payload: {
          verification_type: 'TEST',
          result: true,
          summary: 'Suite green',
          client_event_id: generateClientEventId(),
        },
      });
      expect(verification.statusCode).toBe(201);
      const toVerified = await actor.app.inject({
        method: 'POST',
        url: `/v1/problems/${verified}/status-transitions`,
        payload: { target_status: 'VERIFIED', expected_version: 2, changed_by: 'claude-code' },
      });
      expect(toVerified.statusCode).toBe(200);

      // Now link the two, as similarly as a caller could claim.
      await relateOk(actor, other, verified, 'SIMILAR_TO');

      const otherToCandidate = await actor.app.inject({
        method: 'POST',
        url: `/v1/problems/${other}/status-transitions`,
        payload: { target_status: 'FIX_CANDIDATE', expected_version: 1, changed_by: 'claude-code' },
      });
      expect(otherToCandidate.statusCode).toBe(200);

      const attempt = await actor.app.inject({
        method: 'POST',
        url: `/v1/problems/${other}/status-transitions`,
        payload: { target_status: 'VERIFIED', expected_version: 2, changed_by: 'claude-code' },
      });

      // Evidence is per problem. Being similar to something that was checked
      // is not the same as having been checked.
      expect(attempt.statusCode).toBe(400);
      expect((await readProblem(actor, other))['status']).toBe('FIX_CANDIDATE');
      expect((await readProblem(actor, verified))['status']).toBe('VERIFIED');
    });

    it('does not copy confidence, freshness or the flags across', async () => {
      const actor = await makeActor();
      const from = await makeProblem(actor);
      const to = await makeProblem(actor);

      const patched = await actor.app.inject({
        method: 'PATCH',
        url: `/v1/problems/${from}`,
        payload: {
          changed_by: 'claude-code',
          expected_version: 1,
          confidence: 'HIGH',
          freshness: 'SUPERSEDED',
          importance: true,
          suppressed: true,
        },
      });
      expect(patched.statusCode).toBe(200);

      await relateOk(actor, from, to);

      expect(await readProblem(actor, to)).toMatchObject({
        confidence: 'LOW',
        freshness: 'CURRENT',
        importance: false,
        suppressed: false,
      });
    });

    it('does not carry events or verifications across', async () => {
      const actor = await makeActor();
      const from = await makeProblem(actor);
      const to = await makeProblem(actor);

      await actor.app.inject({
        method: 'POST',
        url: `/v1/problems/${from}/events`,
        payload: {
          event_type: 'FIX',
          summary: 'Set SameSite=Lax on the session cookie.',
          client_event_id: generateClientEventId(),
        },
      });

      await relateOk(actor, from, to, 'DERIVED_FROM');

      const events = await actor.app.inject({ method: 'GET', url: `/v1/problems/${to}/events` });
      const verifications = await actor.app.inject({
        method: 'GET',
        url: `/v1/problems/${to}/verifications`,
      });

      expect(events.json<{ events: unknown[] }>().events).toEqual([]);
      expect(verifications.json<{ verifications: unknown[] }>().verifications).toEqual([]);
    });
  });
});
