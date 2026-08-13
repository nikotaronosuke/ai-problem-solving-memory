/**
 * Verification append and list, independence from Events, retry protection and
 * the owner boundary, against the real database.
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
import { appendEvent } from '../../src/db/events.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import { createProblem, getProblem } from '../../src/db/problems.js';
import { createProject } from '../../src/db/projects.js';
import { appendVerification, listVerifications } from '../../src/db/verifications.js';
import { generateClientEventId } from '../../src/domain/client-event-id.js';
import { VERIFICATION_TYPES } from '../../src/domain/enums.js';
import { generateOwnerId, type OwnerContext, type OwnerId } from '../../src/domain/owner.js';
import { generateProblemId, type ProblemId } from '../../src/domain/problem.js';
import { generateVerificationId } from '../../src/domain/verification.js';
import { MEMORY_OWNER_ID_VAR, resolveOwnerContext } from '../../src/owner/context.js';

const databaseUrl = readDatabaseUrl();

interface Fixture {
  readonly context: OwnerContext;
  readonly problemId: ProblemId;
}

describe.skipIf(databaseUrl === undefined)('verifications', () => {
  let pool: DatabasePool;
  const ownersCreated: OwnerId[] = [];

  async function makeOwnerContext(): Promise<OwnerContext> {
    const ownerId = generateOwnerId();
    await insertOwnerIfAbsent(pool, ownerId);
    ownersCreated.push(ownerId);
    return resolveOwnerContext(pool, { [MEMORY_OWNER_ID_VAR]: ownerId });
  }

  /** An owner with a problem ready to record verifications against. */
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
      for (const table of [
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

  describe('schema', () => {
    it('leaves verification_id without a database default', async () => {
      const result = await pool.query<{ column_default: string | null; data_type: string }>(
        `select column_default, data_type
           from information_schema.columns
          where table_schema = 'public' and table_name = 'verifications'
            and column_name = 'verification_id'`,
      );

      expect(result.rows[0]?.data_type).toBe('uuid');
      expect(result.rows[0]?.column_default).toBeNull();
    });

    it('requires a result, so evidence always states an outcome', async () => {
      const result = await pool.query<{ data_type: string; is_nullable: string }>(
        `select data_type, is_nullable from information_schema.columns
          where table_schema = 'public' and table_name = 'verifications'
            and column_name = 'result'`,
      );

      expect(result.rows[0]?.data_type).toBe('boolean');
      expect(result.rows[0]?.is_nullable).toBe('NO');
    });

    it('allows an unknown verifier and evidence reference to be absent', async () => {
      const result = await pool.query<{ column_name: string; is_nullable: string }>(
        `select column_name, is_nullable from information_schema.columns
          where table_schema = 'public' and table_name = 'verifications'`,
      );

      const nullable = Object.fromEntries(
        result.rows.map((row) => [row.column_name, row.is_nullable]),
      );

      expect(nullable['verified_by']).toBe('YES');
      expect(nullable['evidence_ref']).toBe('YES');
      expect(nullable['summary']).toBe('NO');
      expect(nullable['client_event_id']).toBe('NO');
    });

    it('keeps its client_event_id namespace to itself', async () => {
      const result = await pool.query<{ definition: string }>(
        `select pg_get_constraintdef(oid) as definition
           from pg_constraint
          where conrelid = 'public.verifications'::regclass and contype = 'u'`,
      );

      expect(result.rows.map((row) => row.definition)).toEqual([
        'UNIQUE (owner_id, client_event_id)',
      ]);
    });

    it('reuses the existing problems key rather than adding another', async () => {
      const fk = await pool.query<{ definition: string; confdeltype: string }>(
        `select pg_get_constraintdef(oid) as definition, confdeltype::text as confdeltype
           from pg_constraint
          where contype = 'f' and conrelid = 'public.verifications'::regclass`,
      );
      const problemKeys = await pool.query<{ conname: string }>(
        `select conname from pg_constraint
          where conrelid = 'public.problems'::regclass and contype = 'u'`,
      );

      expect(fk.rows[0]?.definition).toContain('FOREIGN KEY (owner_id, problem_id)');
      expect(fk.rows[0]?.definition).toContain('REFERENCES problems(owner_id, problem_id)');
      expect(fk.rows[0]?.confdeltype).toBe('r');
      // P1-09 already added this one; P1-10 adds no second key.
      expect(problemKeys.rows.map((row) => row.conname)).toEqual([
        'problems_owner_id_problem_id_key',
      ]);
    });

    it('has no updated_at and no trigger, because verifications are append-only', async () => {
      const columns = await pool.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'verifications'`,
      );
      const triggers = await pool.query<{ count: string }>(
        `select count(*)::text as count from pg_trigger
          where tgrelid = 'public.verifications'::regclass and not tgisinternal`,
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

      expect(domains.rows[0]?.count).toBe('6');
    });
  });

  describe('appending', () => {
    it('records a verification owned by the context, not by anything the caller passed', async () => {
      const fixture = await makeFixture();

      const verification = await appendVerification(pool, fixture.context, {
        problemId: fixture.problemId,
        verificationType: 'TEST',
        result: true,
        summary: 'Full suite green on CI',
        clientEventId: generateClientEventId(),
      });

      expect(verification.ownerId).toBe(fixture.context.ownerId);
      expect(verification.problemId).toBe(fixture.problemId);

      const stored = await pool.query<{ owner_id: string }>(
        'select owner_id from public.verifications where verification_id = $1',
        [verification.verificationId],
      );
      expect(stored.rows[0]?.owner_id).toBe(fixture.context.ownerId);
    });

    it('records a confirmed check', async () => {
      const fixture = await makeFixture();

      const verification = await appendVerification(pool, fixture.context, {
        problemId: fixture.problemId,
        verificationType: 'BUILD',
        result: true,
        summary: 'Release build succeeded from a clean checkout',
        clientEventId: generateClientEventId(),
      });

      expect(verification.result).toBe(true);
    });

    it('records a check that was carried out but did not confirm', async () => {
      const fixture = await makeFixture();

      const verification = await appendVerification(pool, fixture.context, {
        problemId: fixture.problemId,
        verificationType: 'REAL_DEVICE',
        result: false,
        summary: 'Still reproduces on the device after the fix',
        clientEventId: generateClientEventId(),
      });

      // A failed check is evidence too, and is kept rather than discarded.
      expect(verification.result).toBe(false);
    });

    it.each(VERIFICATION_TYPES)('accepts a %s verification', async (verificationType) => {
      const fixture = await makeFixture();

      const verification = await appendVerification(pool, fixture.context, {
        problemId: fixture.problemId,
        verificationType,
        result: true,
        summary: `Checked via ${verificationType}`,
        clientEventId: generateClientEventId(),
      });

      expect(verification.verificationType).toBe(verificationType);
    });

    it('refuses a verification type outside the shared value set', async () => {
      const fixture = await makeFixture();

      await expect(
        pool.query(
          `insert into public.verifications
                  (verification_id, owner_id, problem_id, verification_type, result, summary,
                   client_event_id)
                values ($1, $2, $3, $4, true, $5, $6)`,
          [
            generateVerificationId(),
            fixture.context.ownerId,
            fixture.problemId,
            'CODE_REVIEW',
            'summary',
            generateClientEventId(),
          ],
        ),
      ).rejects.toThrow(/verification_type_allowed_values/);
    });

    it('leaves an unknown verifier absent rather than inventing one', async () => {
      const fixture = await makeFixture();

      const verification = await appendVerification(pool, fixture.context, {
        problemId: fixture.problemId,
        verificationType: 'USER_CONFIRMATION',
        result: true,
        summary: 'Confirmed working',
        clientEventId: generateClientEventId(),
      });

      expect(verification.verifiedBy).toBeNull();
      expect(verification.evidenceRef).toBeNull();
    });

    it('stores the verifier and evidence reference when known, trimming them', async () => {
      const fixture = await makeFixture();

      const verification = await appendVerification(pool, fixture.context, {
        problemId: fixture.problemId,
        verificationType: 'TEST',
        result: true,
        summary: 'Suite green',
        verifiedBy: '  vitest  ',
        evidenceRef: '  tests/build.test.ts > bundles native modules  ',
        clientEventId: generateClientEventId(),
      });

      expect(verification.verifiedBy).toBe('vitest');
      expect(verification.evidenceRef).toBe('tests/build.test.ts > bundles native modules');
    });

    it('treats blank optional fields as absent', async () => {
      const fixture = await makeFixture();

      const verification = await appendVerification(pool, fixture.context, {
        problemId: fixture.problemId,
        verificationType: 'API_RESULT',
        result: true,
        summary: 'Endpoint returns 200',
        verifiedBy: '   ',
        evidenceRef: '',
        clientEventId: generateClientEventId(),
      });

      expect(verification.verifiedBy).toBeNull();
      expect(verification.evidenceRef).toBeNull();
    });

    it.each([
      ['a CI run', 'ci/run/1841'],
      ['a commit', 'src/build/bundle.ts@a1b2c3d'],
      ['a database check', 'select count(*) from orders where status is null -> 0 rows'],
      ['a device note', 'iPhone 15 Pro, iOS 18.2, three cold starts, no repro'],
    ])('round-trips %s as an evidence reference', async (_label, evidenceRef) => {
      const fixture = await makeFixture();

      const verification = await appendVerification(pool, fixture.context, {
        problemId: fixture.problemId,
        verificationType: 'DB_RESULT',
        result: true,
        summary: 'Checked',
        evidenceRef,
        clientEventId: generateClientEventId(),
      });

      expect(verification.evidenceRef).toBe(evidenceRef);
    });

    it('refuses a blank summary before reaching the database', async () => {
      const fixture = await makeFixture();

      await expect(
        appendVerification(pool, fixture.context, {
          problemId: fixture.problemId,
          verificationType: 'TEST',
          result: true,
          summary: '   ',
          clientEventId: generateClientEventId(),
        }),
      ).rejects.toThrow(/summary/);
    });

    it('refuses a blank summary at the database too', async () => {
      const fixture = await makeFixture();

      await expect(
        pool.query(
          `insert into public.verifications
                  (verification_id, owner_id, problem_id, verification_type, result, summary,
                   client_event_id)
                values ($1, $2, $3, 'TEST', true, $4, $5)`,
          [
            generateVerificationId(),
            fixture.context.ownerId,
            fixture.problemId,
            '   ',
            generateClientEventId(),
          ],
        ),
      ).rejects.toThrow(/verifications_summary_not_blank/);
    });

    it('refuses a missing result', async () => {
      const fixture = await makeFixture();

      await expect(
        pool.query(
          `insert into public.verifications
                  (verification_id, owner_id, problem_id, verification_type, result, summary,
                   client_event_id)
                values ($1, $2, $3, 'TEST', null, $4, $5)`,
          [
            generateVerificationId(),
            fixture.context.ownerId,
            fixture.problemId,
            'summary',
            generateClientEventId(),
          ],
        ),
      ).rejects.toThrow(/null value in column "result"/);
    });
  });

  describe('independence from events', () => {
    it('stands on its own with no event ever recorded', async () => {
      const fixture = await makeFixture();

      const verification = await appendVerification(pool, fixture.context, {
        problemId: fixture.problemId,
        verificationType: 'TEST',
        result: true,
        summary: 'Suite green on a clean checkout',
        verifiedBy: 'vitest',
        evidenceRef: 'ci/run/1841',
        clientEventId: generateClientEventId(),
      });

      const events = await pool.query('select event_id from public.events where problem_id = $1', [
        fixture.problemId,
      ]);
      const listed = await listVerifications(pool, fixture.context, fixture.problemId);

      // No Event exists, and the Verification still carries its full meaning:
      // what was checked, how, by what, with what outcome and evidence.
      expect(events.rows).toHaveLength(0);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        verificationId: verification.verificationId,
        verificationType: 'TEST',
        result: true,
        summary: 'Suite green on a clean checkout',
        verifiedBy: 'vitest',
        evidenceRef: 'ci/run/1841',
      });
    });

    it('does not reference an event in any column', async () => {
      const columns = await pool.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'verifications'`,
      );

      expect(columns.rows.map((row) => row.column_name)).not.toContain('event_id');
    });

    it('lets the same client event id exist once as an event and once as a verification', async () => {
      const fixture = await makeFixture();
      const clientEventId = generateClientEventId();

      const event = await appendEvent(pool, fixture.context, {
        problemId: fixture.problemId,
        eventType: 'FIX',
        summary: 'Pinned the resolver version',
        clientEventId,
      });
      const verification = await appendVerification(pool, fixture.context, {
        problemId: fixture.problemId,
        verificationType: 'TEST',
        result: true,
        summary: 'Suite green after the fix',
        clientEventId,
      });

      // Separate kinds of write, so separate namespaces.
      expect(event.clientEventId).toBe(clientEventId);
      expect(verification.clientEventId).toBe(clientEventId);
    });

    it('does not move the problem to VERIFIED', async () => {
      const fixture = await makeFixture();

      await appendVerification(pool, fixture.context, {
        problemId: fixture.problemId,
        verificationType: 'TEST',
        result: true,
        summary: 'Suite green',
        clientEventId: generateClientEventId(),
      });

      const problem = await getProblem(pool, fixture.context, fixture.problemId);

      // Recording evidence is not the same as deciding the problem is solved.
      // That transition is P2-06's, made after checking the evidence exists.
      expect(problem?.status).toBe('INVESTIGATING');
    });
  });

  describe('retry protection', () => {
    // P1-10 refused a duplicate; since P2-05 the same write sent again returns
    // what the first attempt produced, as Events have since P2-04. What has
    // not changed is that only one row can exist — the unique index is still
    // what decides, and the tests below check that directly.
    it('returns the original when the same client event id is sent again', async () => {
      const fixture = await makeFixture();
      const clientEventId = generateClientEventId();

      const original = await appendVerification(pool, fixture.context, {
        problemId: fixture.problemId,
        verificationType: 'TEST',
        result: true,
        summary: 'First send',
        clientEventId,
      });

      const retry = await appendVerification(pool, fixture.context, {
        problemId: fixture.problemId,
        verificationType: 'TEST',
        result: true,
        summary: 'Same write, retried',
        clientEventId,
      });

      expect(retry).toEqual(original);
      expect(retry.summary).toBe('First send');
      expect(await listVerifications(pool, fixture.context, fixture.problemId)).toHaveLength(1);
    });

    it('keeps the recorded result when the retry claims a different one', async () => {
      const fixture = await makeFixture();
      const clientEventId = generateClientEventId();

      const original = await appendVerification(pool, fixture.context, {
        problemId: fixture.problemId,
        verificationType: 'TEST',
        result: false,
        summary: 'The suite still fails',
        clientEventId,
      });

      const retry = await appendVerification(pool, fixture.context, {
        problemId: fixture.problemId,
        verificationType: 'USER_CONFIRMATION',
        result: true,
        summary: 'Actually it works',
        clientEventId,
      });

      // A Verification is evidence of a check that was carried out. A retry is
      // the same write arriving again, not a second check, so it cannot turn a
      // recorded failure into a success.
      expect(retry).toEqual(original);
      expect(retry.result).toBe(false);
      expect(retry.verificationType).toBe('TEST');
    });

    it('still stores only one row, whatever the append path answers', async () => {
      const fixture = await makeFixture();
      const clientEventId = generateClientEventId();

      await appendVerification(pool, fixture.context, {
        problemId: fixture.problemId,
        verificationType: 'TEST',
        result: true,
        summary: 'First send',
        clientEventId,
      });

      // Straight past the append path, to confirm the constraint itself is
      // intact rather than the behaviour merely being implemented above it.
      await expect(
        pool.query(
          `insert into public.verifications
                  (verification_id, owner_id, problem_id, verification_type, result, summary,
                   client_event_id)
                values ($1, $2, $3, 'TEST', true, $4, $5)`,
          [
            generateVerificationId(),
            fixture.context.ownerId,
            fixture.problemId,
            'Second row for the same key',
            clientEventId,
          ],
        ),
      ).rejects.toThrow(/verifications_owner_id_client_event_id_key/);
    });

    it('returns the original even when retried against a different problem', async () => {
      const context = await makeOwnerContext();
      const first = await makeFixture(context);
      const second = await makeFixture(context);
      const clientEventId = generateClientEventId();

      const original = await appendVerification(pool, context, {
        problemId: first.problemId,
        verificationType: 'TEST',
        result: true,
        summary: 'First send',
        clientEventId,
      });

      const retry = await appendVerification(pool, context, {
        problemId: second.problemId,
        verificationType: 'TEST',
        result: false,
        summary: 'Retried against the wrong problem',
        clientEventId,
      });

      expect(retry).toEqual(original);
      expect(retry.problemId).toBe(first.problemId);
      expect(retry.result).toBe(true);
      expect(await listVerifications(pool, context, second.problemId)).toHaveLength(0);
    });

    it('lets a different owner use the same client event id', async () => {
      const fixtureA = await makeFixture();
      const fixtureB = await makeFixture();
      const clientEventId = generateClientEventId();

      await appendVerification(pool, fixtureA.context, {
        problemId: fixtureA.problemId,
        verificationType: 'TEST',
        result: true,
        summary: 'Owner A verification',
        clientEventId,
      });

      await expect(
        appendVerification(pool, fixtureB.context, {
          problemId: fixtureB.problemId,
          verificationType: 'TEST',
          result: true,
          summary: 'Owner B verification',
          clientEventId,
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('listing', () => {
    it('returns a problem’s verifications oldest first', async () => {
      const fixture = await makeFixture();
      const summaries = ['First check failed', 'Second check failed', 'Third check passed'];

      for (const [index, summary] of summaries.entries()) {
        await appendVerification(pool, fixture.context, {
          problemId: fixture.problemId,
          verificationType: 'TEST',
          result: index === summaries.length - 1,
          summary,
          clientEventId: generateClientEventId(),
        });
      }

      const verifications = await listVerifications(pool, fixture.context, fixture.problemId);

      expect(verifications.map((verification) => verification.summary)).toEqual(summaries);
      expect(verifications.map((verification) => verification.result)).toEqual([
        false,
        false,
        true,
      ]);
    });

    it('orders deterministically when verifications share a timestamp', async () => {
      const fixture = await makeFixture();
      const sharedTimestamp = '2026-01-01T00:00:00Z';
      const ids = [generateVerificationId(), generateVerificationId(), generateVerificationId()];

      for (const verificationId of ids) {
        await pool.query(
          `insert into public.verifications
                  (verification_id, owner_id, problem_id, verification_type, result, summary,
                   client_event_id, created_at)
                values ($1, $2, $3, 'TEST', true, $4, $5, $6)`,
          [
            verificationId,
            fixture.context.ownerId,
            fixture.problemId,
            `verification ${verificationId}`,
            generateClientEventId(),
            sharedTimestamp,
          ],
        );
      }

      const first = await listVerifications(pool, fixture.context, fixture.problemId);
      const second = await listVerifications(pool, fixture.context, fixture.problemId);

      expect(first.map((verification) => verification.verificationId)).toEqual([...ids].sort());
      expect(second.map((verification) => verification.verificationId)).toEqual(
        first.map((verification) => verification.verificationId),
      );
    });

    it('returns nothing for an unknown problem', async () => {
      const fixture = await makeFixture();

      expect(await listVerifications(pool, fixture.context, generateProblemId())).toEqual([]);
    });
  });

  describe('problem availability', () => {
    it('refuses a problem that does not exist', async () => {
      const fixture = await makeFixture();

      await expect(
        appendVerification(pool, fixture.context, {
          problemId: generateProblemId(),
          verificationType: 'TEST',
          result: true,
          summary: 'Orphan',
          clientEventId: generateClientEventId(),
        }),
      ).rejects.toThrow(ProblemNotAvailableError);
    });

    it('refuses another owner’s problem, indistinguishably from an unknown one', async () => {
      const fixtureA = await makeFixture();
      const fixtureB = await makeFixture();

      const crossOwner = await appendVerification(pool, fixtureA.context, {
        problemId: fixtureB.problemId,
        verificationType: 'TEST',
        result: true,
        summary: 'Cross-owner append',
        clientEventId: generateClientEventId(),
      }).catch((error: unknown) => error);

      const unknown = await appendVerification(pool, fixtureA.context, {
        problemId: generateProblemId(),
        verificationType: 'TEST',
        result: true,
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
          `insert into public.verifications
                  (verification_id, owner_id, problem_id, verification_type, result, summary,
                   client_event_id)
                values ($1, $2, $3, 'TEST', true, $4, $5)`,
          [
            generateVerificationId(),
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
    it('hides each owner’s verifications from the other, in both directions', async () => {
      const fixtureA = await makeFixture();
      const fixtureB = await makeFixture();

      await appendVerification(pool, fixtureA.context, {
        problemId: fixtureA.problemId,
        verificationType: 'TEST',
        result: true,
        summary: 'Owner A verification',
        clientEventId: generateClientEventId(),
      });
      await appendVerification(pool, fixtureB.context, {
        problemId: fixtureB.problemId,
        verificationType: 'TEST',
        result: true,
        summary: 'Owner B verification',
        clientEventId: generateClientEventId(),
      });

      expect(await listVerifications(pool, fixtureA.context, fixtureA.problemId)).toHaveLength(1);
      expect(await listVerifications(pool, fixtureB.context, fixtureB.problemId)).toHaveLength(1);

      expect(await listVerifications(pool, fixtureA.context, fixtureB.problemId)).toEqual([]);
      expect(await listVerifications(pool, fixtureB.context, fixtureA.problemId)).toEqual([]);
    });

    it('answers the same way for another owner’s problem as for one that does not exist', async () => {
      const fixtureA = await makeFixture();
      const fixtureB = await makeFixture();
      await appendVerification(pool, fixtureB.context, {
        problemId: fixtureB.problemId,
        verificationType: 'TEST',
        result: true,
        summary: 'Owner B verification',
        clientEventId: generateClientEventId(),
      });

      const otherOwners = await listVerifications(pool, fixtureA.context, fixtureB.problemId);
      const nonexistent = await listVerifications(pool, fixtureA.context, generateProblemId());

      expect(otherOwners).toEqual(nonexistent);

      // The row really is there — isolation is the read path, not absence.
      const raw = await pool.query(
        'select verification_id from public.verifications where problem_id = $1',
        [fixtureB.problemId],
      );
      expect(raw.rows).toHaveLength(1);
    });
  });

  describe('deleting a problem', () => {
    it('is restricted while the problem still has verifications', async () => {
      const fixture = await makeFixture();
      await appendVerification(pool, fixture.context, {
        problemId: fixture.problemId,
        verificationType: 'TEST',
        result: true,
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

    it('is permitted once the verifications are gone', async () => {
      const fixture = await makeFixture();
      const verification = await appendVerification(pool, fixture.context, {
        problemId: fixture.problemId,
        verificationType: 'TEST',
        result: true,
        summary: 'Removed first',
        clientEventId: generateClientEventId(),
      });

      await pool.query('delete from public.verifications where verification_id = $1', [
        verification.verificationId,
      ]);

      await expect(
        pool.query('delete from public.problems where problem_id = $1', [fixture.problemId]),
      ).resolves.toBeDefined();
    });
  });
});
