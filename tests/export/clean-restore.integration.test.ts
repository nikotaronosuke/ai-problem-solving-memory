/**
 * Proving an export can be read back.
 *
 * The completion condition for this task is that the *format* is restorable
 * into a clean environment, not that an importer exists — importing is
 * explicitly outside the MVP. So there is no importer here either, and that is
 * deliberate rather than a shortcut: a TypeScript restore helper written to
 * make a test pass would become the de-facto specification for the real one,
 * and it would be a specification nobody reviewed.
 *
 * What this does instead is hand the artifact back to PostgreSQL and let SQL
 * unpack it. That keeps the proof honest in a way a JavaScript importer could
 * not: no value in the document is ever parsed by JavaScript on its way into
 * the second database. A restore that went through `JSON.parse` would round
 * the microseconds off every timestamp and the precision off any large number
 * in a snapshot, and then the comparison at the end would be comparing two
 * equally damaged copies and finding them equal.
 *
 * The owner is remapped, and that is the point of `source_owner_id`. An owner
 * id is issued by this server and means nothing anywhere else; the credential
 * decides whose memory a request reaches, so a restore decides its own owner.
 * Every other identifier is carried across unchanged, because the relations,
 * usage logs and change logs refer to them.
 *
 * The final assertion is the strongest available: export the restored owner and
 * compare the two artifacts. If anything at all was lost, added or reshaped,
 * two documents built by the same statement from the same shape will differ.
 *
 * Skipped when `DATABASE_URL` is not set.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readDatabaseUrl } from '../../src/config/env.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { createEnvironment } from '../../src/db/environments.js';
import { appendEvent } from '../../src/db/events.js';
import { exportOwnerMemory } from '../../src/db/memory-export.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import { createProblem } from '../../src/db/problems.js';
import { createProject } from '../../src/db/projects.js';
import { createRelation } from '../../src/db/relations.js';
import { createUsageLog } from '../../src/db/usage-logs.js';
import { appendVerification } from '../../src/db/verifications.js';
import { generateClientEventId } from '../../src/domain/client-event-id.js';
import { generateOwnerId, type OwnerContext, type OwnerId } from '../../src/domain/owner.js';
import { MEMORY_OWNER_ID_VAR, resolveOwnerContext } from '../../src/owner/context.js';

const databaseUrl = readDatabaseUrl();

/**
 * The restore, in dependency order, entirely in SQL.
 *
 * Each statement reads its rows out of the artifact with
 * `jsonb_array_elements` and writes them with the types the columns declare.
 * `$1` is the owner the restore belongs to — the one place a value is replaced
 * — and `$2` is the whole document, handed to PostgreSQL as text so that it,
 * not JavaScript, does the parsing.
 */
const RESTORE_STATEMENTS: readonly string[] = [
  `insert into public.projects (project_id, owner_id, project_name, repo, platform, created_at, updated_at)
   select (e->>'project_id')::uuid, $1, e->>'project_name', e->>'repo', e->>'platform',
          (e->>'created_at')::timestamptz, (e->>'updated_at')::timestamptz
     from jsonb_array_elements($2::jsonb->'projects') e`,

  `insert into public.environments (environment_id, owner_id, project_id, snapshot, created_at)
   select (e->>'environment_id')::uuid, $1, (e->>'project_id')::uuid, e->'snapshot',
          (e->>'created_at')::timestamptz
     from jsonb_array_elements($2::jsonb->'environments') e`,

  `insert into public.problems (problem_id, owner_id, project_id, environment_id, title, symptoms,
                                problem_domain, suspected_boundary, source_ai, status, fix_kind,
                                importance, confidence, freshness, memory_read_enabled,
                                memory_write_enabled, suppressed, version, created_at, updated_at)
   select (e->>'problem_id')::uuid, $1, (e->>'project_id')::uuid, (e->>'environment_id')::uuid,
          e->>'title', e->>'symptoms', e->>'problem_domain', e->>'suspected_boundary',
          e->>'source_ai', e->>'status', e->>'fix_kind', (e->>'importance')::boolean,
          e->>'confidence', e->>'freshness', (e->>'memory_read_enabled')::boolean,
          (e->>'memory_write_enabled')::boolean, (e->>'suppressed')::boolean,
          (e->>'version')::integer, (e->>'created_at')::timestamptz, (e->>'updated_at')::timestamptz
     from jsonb_array_elements($2::jsonb->'problems') e`,

  `insert into public.events (event_id, owner_id, problem_id, event_type, summary, result, reason,
                              source_ai, evidence_ref, client_event_id, created_at)
   select (e->>'event_id')::uuid, $1, (e->>'problem_id')::uuid, e->>'event_type', e->>'summary',
          e->>'result', e->>'reason', e->>'source_ai', e->>'evidence_ref',
          (e->>'client_event_id')::uuid, (e->>'created_at')::timestamptz
     from jsonb_array_elements($2::jsonb->'events') e`,

  `insert into public.verifications (verification_id, owner_id, problem_id, verification_type,
                                     result, summary, evidence_ref, verified_by, client_event_id,
                                     created_at)
   select (e->>'verification_id')::uuid, $1, (e->>'problem_id')::uuid, e->>'verification_type',
          (e->>'result')::boolean, e->>'summary', e->>'evidence_ref', e->>'verified_by',
          (e->>'client_event_id')::uuid, (e->>'created_at')::timestamptz
     from jsonb_array_elements($2::jsonb->'verifications') e`,

  `insert into public.relations (relation_id, owner_id, from_id, to_id, relation_type, reason, created_at)
   select (e->>'relation_id')::uuid, $1, (e->>'from_id')::uuid, (e->>'to_id')::uuid,
          e->>'relation_type', e->>'reason', (e->>'created_at')::timestamptz
     from jsonb_array_elements($2::jsonb->'relations') e`,

  `insert into public.usage_logs (usage_log_id, owner_id, problem_id, source_ai, action, memory_id,
                                  reason, result, created_at)
   select (e->>'usage_log_id')::uuid, $1, (e->>'problem_id')::uuid, e->>'source_ai', e->>'action',
          (e->>'memory_id')::uuid, e->>'reason', e->>'result', (e->>'created_at')::timestamptz
     from jsonb_array_elements($2::jsonb->'usage_logs') e`,

  `insert into public.change_logs (change_log_id, owner_id, problem_id, changed_by, from_version,
                                   to_version, changes, created_at)
   select (e->>'change_log_id')::uuid, $1, (e->>'problem_id')::uuid, e->>'changed_by',
          (e->>'from_version')::integer, (e->>'to_version')::integer, e->'changes',
          (e->>'created_at')::timestamptz
     from jsonb_array_elements($2::jsonb->'change_logs') e`,
];

describe.skipIf(databaseUrl === undefined)('restoring an export into a clean owner', () => {
  let pool: DatabasePool;
  const ownersCreated: OwnerId[] = [];

  async function makeOwnerContext(): Promise<OwnerContext> {
    const ownerId = generateOwnerId();
    await insertOwnerIfAbsent(pool, ownerId);
    ownersCreated.push(ownerId);
    return resolveOwnerContext(pool, { [MEMORY_OWNER_ID_VAR]: ownerId });
  }

  /**
   * A Memory with something of every kind in it.
   *
   * Built through the database layer rather than HTTP, so the values that
   * cannot survive an HTTP request body can be included: a request is parsed
   * by `JSON.parse` before the server sees it, which rounds a large number
   * before anything here could store it.
   */
  async function seed(context: OwnerContext): Promise<void> {
    const project = await createProject(pool, context, {
      projectName: 'restore proof',
      repo: 'git@example.com:owner/repo.git',
      platform: null,
    });
    const environment = await createEnvironment(pool, context, {
      projectId: project.projectId,
      snapshot: { runtime: 'node 22.12.0', nested: { flag: true, absent: null } },
    });

    // The values a JavaScript round trip would damage, planted where the
    // export reads from.
    await pool.query(
      `update public.environments set snapshot = snapshot || $3::jsonb
        where owner_id = $1 and environment_id = $2`,
      [
        context.ownerId,
        environment.environmentId,
        '{"build":12345678901234567890,"fraction":0.1000000000000000055511151231257827}',
      ],
    );

    const first = await createProblem(pool, context, {
      projectId: project.projectId,
      environmentId: environment.environmentId,
      title: 'the first problem',
      symptoms: 'symptoms as written',
      problemDomain: 'build',
      suspectedBoundary: null,
      sourceAi: 'claude-code',
    });
    const second = await createProblem(pool, context, {
      projectId: project.projectId,
      environmentId: environment.environmentId,
      title: 'the second problem',
      symptoms: 'other symptoms',
    });

    await appendEvent(pool, context, {
      problemId: first.problemId,
      eventType: 'DISCOVERY',
      summary: 'found the cause',
      result: null,
      reason: 'the timing fits',
      sourceAi: 'claude-code',
      evidenceRef: 'ci/run/1',
      clientEventId: generateClientEventId(),
    });
    await appendVerification(pool, context, {
      problemId: first.problemId,
      verificationType: 'TEST',
      result: true,
      summary: 'the suite agreed',
      evidenceRef: null,
      verifiedBy: 'claude-code',
      clientEventId: generateClientEventId(),
    });
    await createRelation(pool, context, {
      fromId: second.problemId,
      toId: first.problemId,
      relationType: 'SIMILAR_TO',
      reason: 'the same subsystem',
    });
    await createUsageLog(pool, context, {
      problemId: second.problemId,
      memoryId: first.problemId,
      sourceAi: 'claude-code',
      action: 'ADOPTED',
      reason: 'reused the earlier finding',
      result: 'it worked',
    });

    // A change log, written directly so this file does not need the service.
    await pool.query(
      `insert into public.change_logs
         (change_log_id, owner_id, problem_id, changed_by, from_version, to_version, changes)
       values ($1, $2, $3, 'claude-code', 1, 2, $4::jsonb)`,
      [
        randomUUID(),
        context.ownerId,
        first.problemId,
        JSON.stringify({ confidence: { kind: 'exact', before: 'LOW', after: 'HIGH' } }),
      ],
    );
  }

  /**
   * Empties an owner's memory, leaves first.
   *
   * What makes the target environment clean. The identifiers in an artifact
   * are the originals — deliberately, so the relations still resolve — so
   * restoring beside the rows they came from collides on the primary key. In
   * a real restore the destination is a different database and the question
   * does not arise; here the source is removed first, which also proves the
   * artifact stands on its own with nothing left behind to lean on.
   */
  async function wipe(owner: OwnerId): Promise<void> {
    for (const table of [
      'change_logs',
      'usage_logs',
      'relations',
      'verifications',
      'events',
      'problems',
      'environments',
      'projects',
    ]) {
      await pool.query(`delete from public.${table} where owner_id = $1`, [owner]);
    }
  }

  /** Applies the artifact to another owner, entirely in SQL. */
  async function restoreInto(target: OwnerId, artifact: string): Promise<void> {
    for (const statement of RESTORE_STATEMENTS) {
      await pool.query(statement, [target, artifact]);
    }
  }

  beforeAll(() => {
    pool = createPool(resolveDatabaseConfig({ nodeEnv: 'test', connectionTimeoutMillis: 5_000 }));
  });

  afterAll(async () => {
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

  it('reproduces the memory exactly, under a different owner', async () => {
    const source = await makeOwnerContext();
    await seed(source);
    const artifact = await exportOwnerMemory(pool, source);

    const target = await makeOwnerContext();
    await wipe(source.ownerId);
    await restoreInto(target.ownerId, artifact.json);

    const restored = await exportOwnerMemory(pool, target);

    const original = JSON.parse(artifact.json) as Record<string, unknown>;
    const copy = JSON.parse(restored.json) as Record<string, unknown>;

    // Only two things may differ, and both are about the act of exporting
    // rather than about the memory.
    expect(copy['source_owner_id']).toBe(target.ownerId);
    expect(copy['source_owner_id']).not.toBe(original['source_owner_id']);
    expect(copy['exported_at']).not.toBe(original['exported_at']);

    expect(copy['schema_version']).toBe(original['schema_version']);
    for (const key of [
      'projects',
      'environments',
      'problems',
      'events',
      'verifications',
      'relations',
      'usage_logs',
      'change_logs',
    ]) {
      // Every record, every field, in the same order. A record that came back
      // reshaped, reordered or short of a field fails here.
      expect([key, copy[key]]).toEqual([key, original[key]]);
    }
  });

  it('carries the microseconds and the oversized number through the restore', async () => {
    const source = await makeOwnerContext();
    await seed(source);
    const artifact = await exportOwnerMemory(pool, source);

    const beforeWipe = await pool.query<{ stamp: string }>(
      `select to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as stamp
         from public.problems where owner_id = $1 order by created_at asc, problem_id asc`,
      [source.ownerId],
    );
    const sourceSnapshot = (
      await pool.query<{ snapshot: string }>(
        `select snapshot::text as snapshot from public.environments where owner_id = $1`,
        [source.ownerId],
      )
    ).rows[0]?.snapshot;

    const target = await makeOwnerContext();
    await wipe(source.ownerId);
    await restoreInto(target.ownerId, artifact.json);

    // Compared as the database's own text on both sides, never as JS values.
    // `JSON.parse` would round both copies identically and the comparison
    // would pass while both were wrong.
    const timestamps = async (owner: OwnerId) =>
      (
        await pool.query<{ stamp: string }>(
          `select to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as stamp
             from public.problems where owner_id = $1 order by created_at asc, problem_id asc`,
          [owner],
        )
      ).rows.map((row) => row.stamp);

    const before = beforeWipe.rows.map((row) => row.stamp);
    const after = await timestamps(target.ownerId);

    expect(after).toEqual(before);
    // Six digits, and not six digits of which three are a zero pad.
    expect(before.every((stamp) => /\.\d{6}Z$/.test(stamp))).toBe(true);
    expect(before.some((stamp) => !/\.\d{3}000Z$/.test(stamp))).toBe(true);

    const snapshotText = async (owner: OwnerId) =>
      (
        await pool.query<{ snapshot: string }>(
          `select snapshot::text as snapshot from public.environments where owner_id = $1`,
          [owner],
        )
      ).rows[0]?.snapshot;

    expect(await snapshotText(target.ownerId)).toBe(sourceSnapshot);
    expect(await snapshotText(target.ownerId)).toContain('12345678901234567890');
    expect(await snapshotText(target.ownerId)).toContain('0.1000000000000000055511151231257827');
  });

  it('keeps every identifier, so the relationships still resolve', async () => {
    const source = await makeOwnerContext();
    await seed(source);
    const artifact = await exportOwnerMemory(pool, source);

    const originalKeys = await pool.query<{ client_event_id: string }>(
      `select client_event_id from public.events where owner_id = $1`,
      [source.ownerId],
    );

    const target = await makeOwnerContext();
    await wipe(source.ownerId);
    await restoreInto(target.ownerId, artifact.json);

    // The restore inserted rows whose foreign keys are composite `(owner_id,
    // …)`. That they went in at all is the proof: with a remapped identifier
    // anywhere, the relation and the usage log would have failed to insert.
    const counts = await pool.query<{ table_name: string; n: string }>(
      `select 'relations' as table_name, count(*)::text as n from public.relations where owner_id = $1
       union all select 'usage_logs', count(*)::text from public.usage_logs where owner_id = $1
       union all select 'change_logs', count(*)::text from public.change_logs where owner_id = $1
       union all select 'events', count(*)::text from public.events where owner_id = $1
       union all select 'verifications', count(*)::text from public.verifications where owner_id = $1`,
      [target.ownerId],
    );

    expect(Object.fromEntries(counts.rows.map((row) => [row.table_name, Number(row.n)]))).toEqual({
      relations: 1,
      usage_logs: 1,
      change_logs: 1,
      events: 1,
      verifications: 1,
    });

    // And the idempotency keys survived, so a restored Memory still refuses a
    // resent Event rather than duplicating it.
    const keys = await pool.query<{ client_event_id: string }>(
      `select client_event_id from public.events where owner_id = $1`,
      [target.ownerId],
    );
    expect(keys.rows).toEqual(originalKeys.rows);
  });

  it('refuses to restore on top of the rows it came from', async () => {
    const source = await makeOwnerContext();
    await seed(source);
    const artifact = await exportOwnerMemory(pool, source);

    const target = await makeOwnerContext();

    // The identifiers are the originals, so restoring into a database that
    // still holds them collides on the primary key. That is the right
    // behaviour and worth pinning: a restore that silently made second copies
    // under fresh ids would turn one Memory into two that drift apart, and
    // nothing would say which was real.
    await expect(restoreInto(target.ownerId, artifact.json)).rejects.toThrow();

    // And the failed attempt left nothing behind for the target.
    const rows = await pool.query<{ n: string }>(
      `select count(*)::text as n from public.projects where owner_id = $1`,
      [target.ownerId],
    );
    expect(rows.rows[0]?.n).toBe('0');
  });
});
