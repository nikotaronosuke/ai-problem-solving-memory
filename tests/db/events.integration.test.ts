/**
 * Event append and list, retry protection and the owner boundary, against the
 * real database.
 *
 * Fixtures are created with freshly generated ids and removed afterwards, so
 * the suite never depends on — or disturbs — the developer's own owner row.
 *
 * Skipped when `DATABASE_URL` is not set.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readDatabaseUrl } from '../../src/config/env.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { createEnvironment } from '../../src/db/environments.js';
import { ProblemNotAvailableError } from '../../src/db/errors.js';
import { appendEvent, listEvents } from '../../src/db/events.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import { createProblem } from '../../src/db/problems.js';
import { createProject } from '../../src/db/projects.js';
import { generateClientEventId } from '../../src/domain/client-event-id.js';
import { EVENT_TYPES } from '../../src/domain/enums.js';
import { generateEventId } from '../../src/domain/event.js';
import { generateOwnerId, type OwnerContext, type OwnerId } from '../../src/domain/owner.js';
import { generateProblemId, type ProblemId } from '../../src/domain/problem.js';
import { MEMORY_OWNER_ID_VAR, resolveOwnerContext } from '../../src/owner/context.js';

const databaseUrl = readDatabaseUrl();

interface Fixture {
  readonly context: OwnerContext;
  readonly problemId: ProblemId;
}

describe.skipIf(databaseUrl === undefined)('events', () => {
  let pool: DatabasePool;
  const ownersCreated: OwnerId[] = [];

  async function makeOwnerContext(): Promise<OwnerContext> {
    const ownerId = generateOwnerId();
    await insertOwnerIfAbsent(pool, ownerId);
    ownersCreated.push(ownerId);
    return resolveOwnerContext(pool, { [MEMORY_OWNER_ID_VAR]: ownerId });
  }

  /** An owner with a problem ready to append events to. */
  async function makeFixture(context?: OwnerContext): Promise<Fixture> {
    const owner = context ?? (await makeOwnerContext());
    const project = await createProject(pool, owner, { projectName: 'fixture-project' });
    const environment = await createEnvironment(pool, owner, {
      projectId: project.projectId,
      snapshot: {},
    });
    const problem = await createProblem(pool, owner, {
      projectId: project.projectId,
      environmentId: environment.environmentId,
      title: 'Fixture problem',
      symptoms: 'Something is wrong.',
    });

    return { context: owner, problemId: problem.problemId };
  }

  beforeAll(() => {
    pool = createPool(resolveDatabaseConfig({ nodeEnv: 'test', connectionTimeoutMillis: 5_000 }));
  });

  afterAll(async () => {
    if (ownersCreated.length > 0) {
      // Children first: every foreign key restricts deleting the parent.
      for (const table of ['events', 'problems', 'environments', 'projects', 'owners']) {
        await pool.query(`delete from public.${table} where owner_id = any($1::uuid[])`, [
          ownersCreated,
        ]);
      }
    }
    await closePool(pool);
  });

  describe('schema', () => {
    it('leaves event_id without a database default', async () => {
      const result = await pool.query<{ column_default: string | null; data_type: string }>(
        `select column_default, data_type
           from information_schema.columns
          where table_schema = 'public' and table_name = 'events'
            and column_name = 'event_id'`,
      );

      expect(result.rows[0]?.data_type).toBe('uuid');
      expect(result.rows[0]?.column_default).toBeNull();
    });

    it('requires a client_event_id, so every write can be retried safely', async () => {
      const result = await pool.query<{ data_type: string; is_nullable: string }>(
        `select data_type, is_nullable from information_schema.columns
          where table_schema = 'public' and table_name = 'events'
            and column_name = 'client_event_id'`,
      );

      expect(result.rows[0]?.data_type).toBe('uuid');
      expect(result.rows[0]?.is_nullable).toBe('NO');
    });

    it('scopes client_event_id uniqueness to the owner', async () => {
      const result = await pool.query<{ definition: string }>(
        `select pg_get_constraintdef(oid) as definition
           from pg_constraint
          where conrelid = 'public.events'::regclass and contype = 'u'`,
      );

      expect(result.rows.map((row) => row.definition)).toEqual([
        'UNIQUE (owner_id, client_event_id)',
      ]);
    });

    it('checks owner and problem together, and restricts deleting the problem', async () => {
      const result = await pool.query<{ definition: string; confdeltype: string }>(
        `select pg_get_constraintdef(oid) as definition, confdeltype::text as confdeltype
           from pg_constraint
          where contype = 'f' and conrelid = 'public.events'::regclass`,
      );

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.definition).toContain('FOREIGN KEY (owner_id, problem_id)');
      expect(result.rows[0]?.definition).toContain('REFERENCES problems(owner_id, problem_id)');
      expect(result.rows[0]?.confdeltype).toBe('r');
    });

    it('has no updated_at and no trigger, because events are append-only', async () => {
      const columns = await pool.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'events'`,
      );
      const triggers = await pool.query<{ count: string }>(
        `select count(*)::text as count from pg_trigger
          where tgrelid = 'public.events'::regclass and not tgisinternal`,
      );

      expect(columns.rows.map((row) => row.column_name)).not.toContain('updated_at');
      expect(triggers.rows[0]?.count).toBe('0');
    });

    it('leaves the shared value sets intact', async () => {
      const domains = await pool.query<{ count: string }>(
        `select count(*)::text as count
           from pg_type t join pg_namespace n on n.oid = t.typnamespace
          where t.typtype = 'd' and n.nspname = 'public'`,
      );

      // Seven since P2-08 added `relation_type`.
      expect(domains.rows[0]?.count).toBe('7');
    });
  });

  describe('appending', () => {
    it('records an event owned by the context, not by anything the caller passed', async () => {
      const fixture = await makeFixture();

      const event = await appendEvent(pool, fixture.context, {
        problemId: fixture.problemId,
        eventType: 'HYPOTHESIS',
        summary: 'Suspected the bundler cache',
        clientEventId: generateClientEventId(),
      });

      expect(event.ownerId).toBe(fixture.context.ownerId);
      expect(event.problemId).toBe(fixture.problemId);

      const stored = await pool.query<{ owner_id: string }>(
        'select owner_id from public.events where event_id = $1',
        [event.eventId],
      );
      expect(stored.rows[0]?.owner_id).toBe(fixture.context.ownerId);
    });

    it.each(EVENT_TYPES)('accepts a %s event', async (eventType) => {
      const fixture = await makeFixture();

      const event = await appendEvent(pool, fixture.context, {
        problemId: fixture.problemId,
        eventType,
        summary: `A ${eventType} happened`,
        clientEventId: generateClientEventId(),
      });

      expect(event.eventType).toBe(eventType);
    });

    it('refuses an event type outside the shared value set', async () => {
      const fixture = await makeFixture();

      await expect(
        pool.query(
          `insert into public.events
                  (event_id, owner_id, problem_id, event_type, summary, client_event_id)
                values ($1, $2, $3, $4, $5, $6)`,
          [
            generateEventId(),
            fixture.context.ownerId,
            fixture.problemId,
            'RETROSPECTIVE',
            'summary',
            generateClientEventId(),
          ],
        ),
      ).rejects.toThrow(/event_type_allowed_values/);
    });

    it('keeps optional fields absent when there is nothing to record', async () => {
      const fixture = await makeFixture();

      const event = await appendEvent(pool, fixture.context, {
        problemId: fixture.problemId,
        eventType: 'HYPOTHESIS',
        summary: 'No result yet',
        clientEventId: generateClientEventId(),
      });

      expect(event.result).toBeNull();
      expect(event.reason).toBeNull();
      expect(event.sourceAi).toBeNull();
      expect(event.evidenceRef).toBeNull();
    });

    it('stores optional fields when present, trimming them', async () => {
      const fixture = await makeFixture();

      const event = await appendEvent(pool, fixture.context, {
        problemId: fixture.problemId,
        eventType: 'DEAD_END',
        summary: 'Clearing the cache did not help',
        result: '  still fails  ',
        reason: '  the cache was not the cause  ',
        sourceAi: '  claude-code  ',
        evidenceRef: '  ci/run/1841#step-4  ',
        clientEventId: generateClientEventId(),
      });

      expect(event.result).toBe('still fails');
      expect(event.reason).toBe('the cache was not the cause');
      expect(event.sourceAi).toBe('claude-code');
      expect(event.evidenceRef).toBe('ci/run/1841#step-4');
    });

    it('treats blank optional fields as absent', async () => {
      const fixture = await makeFixture();

      const event = await appendEvent(pool, fixture.context, {
        problemId: fixture.problemId,
        eventType: 'ATTEMPT',
        summary: 'Tried something',
        result: '   ',
        reason: '',
        sourceAi: '\t',
        evidenceRef: '  ',
        clientEventId: generateClientEventId(),
      });

      expect(event.result).toBeNull();
      expect(event.reason).toBeNull();
      expect(event.sourceAi).toBeNull();
      expect(event.evidenceRef).toBeNull();
    });

    it.each([
      ['a repository path and commit', 'src/build/bundle.ts@a1b2c3d'],
      ['an issue reference', 'example/repo#412'],
      ['a test name', 'tests/build.test.ts > bundles native modules'],
      ['an official document', 'https://example.com/docs/bundler#caching'],
      ['a device check note', 'checked on iPhone 15 Pro, iOS 18.2, reproduced twice'],
    ])('round-trips %s as an evidence reference', async (_label, evidenceRef) => {
      const fixture = await makeFixture();

      const event = await appendEvent(pool, fixture.context, {
        problemId: fixture.problemId,
        eventType: 'DISCOVERY',
        summary: 'Found the cause',
        evidenceRef,
        clientEventId: generateClientEventId(),
      });

      expect(event.evidenceRef).toBe(evidenceRef);
    });

    it('refuses a blank summary before reaching the database', async () => {
      const fixture = await makeFixture();

      await expect(
        appendEvent(pool, fixture.context, {
          problemId: fixture.problemId,
          eventType: 'ATTEMPT',
          summary: '   ',
          clientEventId: generateClientEventId(),
        }),
      ).rejects.toThrow(/summary/);
    });

    it('refuses a blank summary at the database too', async () => {
      const fixture = await makeFixture();

      await expect(
        pool.query(
          `insert into public.events
                  (event_id, owner_id, problem_id, event_type, summary, client_event_id)
                values ($1, $2, $3, 'ATTEMPT', $4, $5)`,
          [
            generateEventId(),
            fixture.context.ownerId,
            fixture.problemId,
            '   ',
            generateClientEventId(),
          ],
        ),
      ).rejects.toThrow(/events_summary_not_blank/);
    });
  });

  describe('retry protection', () => {
    // P1-09 refused a duplicate; since P2-04 the same write sent again returns
    // what the first attempt produced. What has not changed is that only one
    // row can exist — the unique index is still what decides, and the tests
    // below check the row count as well as the answer.
    it('returns the original event when the same client event id is sent again', async () => {
      const fixture = await makeFixture();
      const clientEventId = generateClientEventId();

      const original = await appendEvent(pool, fixture.context, {
        problemId: fixture.problemId,
        eventType: 'ATTEMPT',
        summary: 'First attempt',
        clientEventId,
      });

      const retry = await appendEvent(pool, fixture.context, {
        problemId: fixture.problemId,
        eventType: 'ATTEMPT',
        summary: 'Same write, retried',
        clientEventId,
      });

      // The retry's payload is not applied: the first write is the write.
      expect(retry).toEqual(original);
      expect(retry.summary).toBe('First attempt');
      expect(await listEvents(pool, fixture.context, fixture.problemId)).toHaveLength(1);
    });

    it('still stores only one row, whatever the append path answers', async () => {
      const fixture = await makeFixture();
      const clientEventId = generateClientEventId();

      await appendEvent(pool, fixture.context, {
        problemId: fixture.problemId,
        eventType: 'ATTEMPT',
        summary: 'First attempt',
        clientEventId,
      });

      // Straight past the append path, to confirm the constraint itself is
      // intact rather than the behaviour merely being implemented above it.
      await expect(
        pool.query(
          `insert into public.events
                  (event_id, owner_id, problem_id, event_type, summary, client_event_id)
                values ($1, $2, $3, 'ATTEMPT', $4, $5)`,
          [
            generateEventId(),
            fixture.context.ownerId,
            fixture.problemId,
            'Second row for the same key',
            clientEventId,
          ],
        ),
      ).rejects.toThrow(/events_owner_id_client_event_id_key/);
    });

    it('returns the original even when retried against a different problem', async () => {
      const context = await makeOwnerContext();
      const first = await makeFixture(context);
      const second = await makeFixture(context);
      const clientEventId = generateClientEventId();

      const original = await appendEvent(pool, context, {
        problemId: first.problemId,
        eventType: 'ATTEMPT',
        summary: 'First attempt',
        clientEventId,
      });

      // The key is the owner's, not the problem's. Scoping uniqueness to the
      // problem would produce a second event here.
      const retry = await appendEvent(pool, context, {
        problemId: second.problemId,
        eventType: 'ATTEMPT',
        summary: 'Retried against the wrong problem',
        clientEventId,
      });

      expect(retry).toEqual(original);
      expect(retry.problemId).toBe(first.problemId);
      expect(await listEvents(pool, context, second.problemId)).toHaveLength(0);
    });

    it('lets a different owner use the same client event id', async () => {
      const fixtureA = await makeFixture();
      const fixtureB = await makeFixture();
      const clientEventId = generateClientEventId();

      await appendEvent(pool, fixtureA.context, {
        problemId: fixtureA.problemId,
        eventType: 'ATTEMPT',
        summary: 'Owner A write',
        clientEventId,
      });

      // Separate owners are separate namespaces.
      await expect(
        appendEvent(pool, fixtureB.context, {
          problemId: fixtureB.problemId,
          eventType: 'ATTEMPT',
          summary: 'Owner B write',
          clientEventId,
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('listing', () => {
    it('returns a problem’s events oldest first', async () => {
      const fixture = await makeFixture();
      const summaries = [
        'Suspected the bundler cache',
        'Cleared the cache and rebuilt',
        'Cache was not the cause',
        'Native module resolution differs on CI',
        'Pinned the resolver version',
      ];

      for (const [index, summary] of summaries.entries()) {
        await appendEvent(pool, fixture.context, {
          problemId: fixture.problemId,
          eventType: EVENT_TYPES[index] ?? 'ATTEMPT',
          summary,
          clientEventId: generateClientEventId(),
        });
      }

      const events = await listEvents(pool, fixture.context, fixture.problemId);

      expect(events.map((event) => event.summary)).toEqual(summaries);
    });

    it('orders deterministically when events share a timestamp', async () => {
      const fixture = await makeFixture();
      const sharedTimestamp = '2026-01-01T00:00:00Z';

      // Inserted directly so every row carries the identical created_at.
      const ids = [generateEventId(), generateEventId(), generateEventId()];
      for (const eventId of ids) {
        await pool.query(
          `insert into public.events
                  (event_id, owner_id, problem_id, event_type, summary, client_event_id, created_at)
                values ($1, $2, $3, 'ATTEMPT', $4, $5, $6)`,
          [
            eventId,
            fixture.context.ownerId,
            fixture.problemId,
            `event ${eventId}`,
            generateClientEventId(),
            sharedTimestamp,
          ],
        );
      }

      const first = await listEvents(pool, fixture.context, fixture.problemId);
      const second = await listEvents(pool, fixture.context, fixture.problemId);

      // event_id breaks the tie, so repeated reads agree.
      expect(first.map((event) => event.eventId)).toEqual([...ids].sort());
      expect(second.map((event) => event.eventId)).toEqual(first.map((event) => event.eventId));
    });

    it('returns nothing for an unknown problem', async () => {
      const fixture = await makeFixture();

      expect(await listEvents(pool, fixture.context, generateProblemId())).toEqual([]);
    });
  });

  describe('problem availability', () => {
    it('refuses a problem that does not exist', async () => {
      const fixture = await makeFixture();

      await expect(
        appendEvent(pool, fixture.context, {
          problemId: generateProblemId(),
          eventType: 'ATTEMPT',
          summary: 'Orphan',
          clientEventId: generateClientEventId(),
        }),
      ).rejects.toThrow(ProblemNotAvailableError);
    });

    it('refuses another owner’s problem, indistinguishably from an unknown one', async () => {
      const fixtureA = await makeFixture();
      const fixtureB = await makeFixture();

      const crossOwner = await appendEvent(pool, fixtureA.context, {
        problemId: fixtureB.problemId,
        eventType: 'ATTEMPT',
        summary: 'Cross-owner append',
        clientEventId: generateClientEventId(),
      }).catch((error: unknown) => error);

      const unknown = await appendEvent(pool, fixtureA.context, {
        problemId: generateProblemId(),
        eventType: 'ATTEMPT',
        summary: 'Unknown problem append',
        clientEventId: generateClientEventId(),
      }).catch((error: unknown) => error);

      expect(crossOwner).toBeInstanceOf(ProblemNotAvailableError);
      expect(unknown).toBeInstanceOf(ProblemNotAvailableError);
      expect((crossOwner as Error).message).toBe((unknown as Error).message);
    });

    it('refuses a mismatched owner and problem pair at the database too', async () => {
      const fixtureA = await makeFixture();
      const fixtureB = await makeFixture();

      await expect(
        pool.query(
          `insert into public.events
                  (event_id, owner_id, problem_id, event_type, summary, client_event_id)
                values ($1, $2, $3, 'ATTEMPT', $4, $5)`,
          [
            generateEventId(),
            fixtureA.context.ownerId,
            fixtureB.problemId,
            'summary',
            generateClientEventId(),
          ],
        ),
      ).rejects.toThrow(/violates foreign key constraint/);
    });
  });

  describe('isolation between owners', () => {
    it('hides each owner’s events from the other, in both directions', async () => {
      const fixtureA = await makeFixture();
      const fixtureB = await makeFixture();

      await appendEvent(pool, fixtureA.context, {
        problemId: fixtureA.problemId,
        eventType: 'ATTEMPT',
        summary: 'Owner A event',
        clientEventId: generateClientEventId(),
      });
      await appendEvent(pool, fixtureB.context, {
        problemId: fixtureB.problemId,
        eventType: 'ATTEMPT',
        summary: 'Owner B event',
        clientEventId: generateClientEventId(),
      });

      expect(await listEvents(pool, fixtureA.context, fixtureA.problemId)).toHaveLength(1);
      expect(await listEvents(pool, fixtureB.context, fixtureB.problemId)).toHaveLength(1);

      expect(await listEvents(pool, fixtureA.context, fixtureB.problemId)).toEqual([]);
      expect(await listEvents(pool, fixtureB.context, fixtureA.problemId)).toEqual([]);
    });

    it('answers the same way for another owner’s problem as for one that does not exist', async () => {
      const fixtureA = await makeFixture();
      const fixtureB = await makeFixture();
      await appendEvent(pool, fixtureB.context, {
        problemId: fixtureB.problemId,
        eventType: 'ATTEMPT',
        summary: 'Owner B event',
        clientEventId: generateClientEventId(),
      });

      const otherOwners = await listEvents(pool, fixtureA.context, fixtureB.problemId);
      const nonexistent = await listEvents(pool, fixtureA.context, generateProblemId());

      expect(otherOwners).toEqual(nonexistent);

      // The row really is there — isolation is the read path, not absence.
      const raw = await pool.query('select event_id from public.events where problem_id = $1', [
        fixtureB.problemId,
      ]);
      expect(raw.rows).toHaveLength(1);
    });
  });

  describe('deleting a problem', () => {
    it('is restricted while the problem still has events', async () => {
      const fixture = await makeFixture();
      await appendEvent(pool, fixture.context, {
        problemId: fixture.problemId,
        eventType: 'ATTEMPT',
        summary: 'Blocks deletion',
        clientEventId: generateClientEventId(),
      });

      await expect(
        pool.query('delete from public.problems where problem_id = $1', [fixture.problemId]),
      ).rejects.toThrow(/violates foreign key constraint/);

      const stillThere = await pool.query<{ count: string }>(
        'select count(*)::text as count from public.problems where problem_id = $1',
        [fixture.problemId],
      );
      expect(stillThere.rows[0]?.count).toBe('1');
    });

    it('is permitted once the events are gone', async () => {
      const fixture = await makeFixture();
      const event = await appendEvent(pool, fixture.context, {
        problemId: fixture.problemId,
        eventType: 'ATTEMPT',
        summary: 'Removed first',
        clientEventId: generateClientEventId(),
      });

      await pool.query('delete from public.events where event_id = $1', [event.eventId]);

      await expect(
        pool.query('delete from public.problems where problem_id = $1', [fixture.problemId]),
      ).resolves.toBeDefined();
    });
  });
});
