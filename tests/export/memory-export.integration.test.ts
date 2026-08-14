/**
 * Exporting a Memory: real database, real credential, real HTTP.
 *
 * The claim an export makes is unusually strong — this file is everything you
 * recorded, and you can read it without this server — so most of what follows
 * checks the artifact against the database rather than against expectations
 * written here.
 *
 * Three properties are easy to get wrong and are checked directly.
 *
 * **Completeness.** The field inventory is taken from the PostgreSQL catalog,
 * not from a list in this file. A column added to a table and forgotten in the
 * export fails here, which is the only way that mistake gets caught: nothing
 * else reads an export daily, so a missing field would be discovered by
 * whoever restored a backup and found it incomplete.
 *
 * **Precision.** Two kinds of value cannot survive a JavaScript object, and
 * both are asserted against the database's own text rather than against a
 * parsed copy — a test that compares `JSON.parse(export)` with a `Date` from
 * the driver would agree with itself while both were wrong.
 *
 * **Closure.** Every identifier an artifact refers to has to be inside the
 * artifact. Otherwise "restorable into a clean environment" is not true, and
 * the way it fails is a relation pointing at a Problem that is not there.
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
import { MEMORY_EXPORT_SCHEMA_VERSION } from '../../src/domain/memory-export.js';
import { generateOwnerId, type OwnerId } from '../../src/domain/owner.js';
import { buildMemoryHttpApp, createLoggerOptions } from '../../src/http/index.js';

const databaseUrl = readDatabaseUrl();

/** The eight tables an export covers, and the order it lists them in. */
const COLLECTIONS = [
  ['projects', 'projects'],
  ['environments', 'environments'],
  ['problems', 'problems'],
  ['events', 'events'],
  ['verifications', 'verifications'],
  ['relations', 'relations'],
  ['usage_logs', 'usage_logs'],
  ['change_logs', 'change_logs'],
] as const;

interface Owner {
  readonly ownerId: OwnerId;
  readonly token: string;
  readonly credentialId: string;
}

interface Seeded {
  readonly projectId: string;
  readonly environmentId: string;
  readonly problemId: string;
  readonly neighbourId: string;
  readonly marker: string;
}

/** Only ever a parsed copy, and never what a response is built from. */
type Artifact = Record<string, unknown> & { readonly [k: string]: unknown };

describe.skipIf(databaseUrl === undefined)('exporting an owner’s memory', () => {
  let pool: DatabasePool;
  let app: FastifyInstance;
  const logLines: string[] = [];
  const ownersCreated: OwnerId[] = [];

  function buildApp(lines: string[]): FastifyInstance {
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
        // The production logging options, so a leak test means something.
        ...createLoggerOptions('trace'),
        stream: {
          write(line: string) {
            lines.push(line);
          },
        },
      },
    });
  }

  async function makeOwner(): Promise<Owner> {
    const ownerId = generateOwnerId();
    await insertOwnerIfAbsent(pool, ownerId);
    ownersCreated.push(ownerId);

    const credentialId = generateCredentialId();
    const token = generateCredentialToken();
    await createCredentialRepository(pool).issueClientCredential({
      clientId: generateClientId(),
      ownerId,
      label: 'export test client',
      credentialId,
      tokenLookup: token.lookup,
      tokenHash: hashCredentialSecret(token.secret),
    });

    return { ownerId, token: formatCredentialToken(token), credentialId };
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
   * Everything, once: eight tables with both directions of every reference.
   *
   * The snapshot carries values chosen to break a naive implementation — an
   * integer past what a JS number holds, a fraction, a nested object, a null,
   * a boolean — because those are what a round trip through `JSON.parse`
   * quietly rewrites.
   */
  async function seed(owner: Owner): Promise<Seeded> {
    const marker = `marker-${randomUUID()}`;

    const project = await post(owner, '/v1/projects', {
      project_name: `export ${marker}`,
      repo: 'git@example.com:owner/repo.git',
      platform: 'linux',
    });
    const projectId = project['project_id'] ?? '';

    const environment = await post(owner, `/v1/projects/${projectId}/environments`, {
      snapshot: {
        runtime: 'node 22.12.0',
        nested: { deep: { flag: true, absent: null } },
      },
    });
    const environmentId = environment['environment_id'] ?? '';

    // Written with raw SQL, because the number cannot arrive any other way:
    // an HTTP request body is parsed by `JSON.parse` before anything here sees
    // it, so 12345678901234567890 has already become ...67000 by the time the
    // server could store it. The database can hold it and this test is about
    // whether the export gives it back, so it is planted where the export
    // reads from.
    await pool.query(
      `update public.environments
          set snapshot = snapshot || $3::jsonb
        where owner_id = $1 and environment_id = $2`,
      [
        owner.ownerId,
        environmentId,
        '{"build":12345678901234567890,"fraction":0.1000000000000000055511151231257827}',
      ],
    );

    const makeProblem = async (title: string): Promise<string> => {
      const created = await post(owner, `/v1/projects/${projectId}/problems`, {
        environment_id: environmentId,
        title,
        symptoms: 'the symptoms as recorded',
        problem_domain: 'build',
        suspected_boundary: 'toolchain',
        source_ai: 'claude-code',
      });
      return created['problem_id'] ?? '';
    };

    const problemId = await makeProblem(`the problem ${marker}`);
    const neighbourId = await makeProblem('a second problem');

    await post(owner, `/v1/problems/${problemId}/events`, {
      event_type: 'HYPOTHESIS',
      summary: 'perhaps the cache',
      reason: 'the timing fits',
      source_ai: 'claude-code',
      evidence_ref: 'ci/run/1',
      client_event_id: randomUUID(),
    });
    await post(owner, `/v1/problems/${problemId}/verifications`, {
      verification_type: 'TEST',
      result: true,
      summary: 'the suite agreed',
      evidence_ref: 'ci/run/2',
      verified_by: 'claude-code',
      client_event_id: randomUUID(),
    });
    await post(owner, `/v1/problems/${problemId}/relations`, {
      to_id: neighbourId,
      relation_type: 'RELATED_TO',
      reason: 'the same subsystem',
    });
    await post(owner, `/v1/problems/${neighbourId}/relations`, {
      to_id: problemId,
      relation_type: 'SIMILAR_TO',
      reason: 'pointing back',
    });
    await post(owner, `/v1/problems/${neighbourId}/usage-logs`, {
      source_ai: 'claude-code',
      action: 'ADOPTED',
      memory_id: problemId,
      reason: 'reused the earlier finding',
      result: 'it worked',
    });

    // A change, so there is a change log with its version pair.
    const patched = await app.inject({
      method: 'PATCH',
      url: `/v1/problems/${problemId}`,
      headers: auth(owner),
      payload: { expected_version: 1, changed_by: 'claude-code', confidence: 'HIGH' },
    });
    expect(patched.statusCode).toBe(200);

    return { projectId, environmentId, problemId, neighbourId, marker };
  }

  /** The raw bytes the server sent. Never re-serialised. */
  async function exportRaw(owner: Owner): Promise<string> {
    const response = await app.inject({ method: 'GET', url: '/v1/export', headers: auth(owner) });
    expect(response.statusCode, response.body).toBe(200);
    return response.body;
  }

  const exportParsed = async (owner: Owner): Promise<Artifact> =>
    JSON.parse(await exportRaw(owner)) as Artifact;

  const rows = (artifact: Artifact, key: string): Record<string, unknown>[] =>
    artifact[key] as Record<string, unknown>[];

  beforeAll(() => {
    pool = createPool(resolveDatabaseConfig({ nodeEnv: 'test', connectionTimeoutMillis: 5_000 }));
    app = buildApp(logLines);
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

  describe('the envelope', () => {
    it('gives an owner with nothing recorded eight empty arrays', async () => {
      const owner = await makeOwner();

      const artifact = await exportParsed(owner);

      expect(artifact['schema_version']).toBe(MEMORY_EXPORT_SCHEMA_VERSION);
      expect(artifact['source_owner_id']).toBe(owner.ownerId);
      for (const [key] of COLLECTIONS) {
        // Present and empty, never absent and never null. A reader should not
        // have to tell "nothing recorded" from "this export does not cover
        // problems".
        expect([key, artifact[key]]).toEqual([key, []]);
      }
    });

    it('carries the format version, which is not the API contract version', async () => {
      const artifact = await exportParsed(await makeOwner());

      expect(artifact['schema_version']).toBe('1');

      // The two move for different reasons. P3-05 took the contract from 0.2.0
      // to 0.3.0 and changed nothing about what an export contains; telling
      // whoever holds an artifact that its format had changed would send them
      // to re-read the whole file for nothing.
      const document = await app.inject({ method: 'GET', url: '/openapi.json' });
      const contractVersion = document.json<{ info: { version: string } }>().info.version;
      expect(artifact['schema_version']).not.toBe(contractVersion);
    });

    it('names the source owner once, and on no record', async () => {
      const owner = await makeOwner();
      await seed(owner);

      const artifact = await exportParsed(owner);

      expect(artifact['source_owner_id']).toBe(owner.ownerId);
      for (const [key] of COLLECTIONS) {
        for (const record of rows(artifact, key)) {
          // Ownership is a property of the export, not of each row. Repeating
          // the same UUID on every record of a large file says nothing new,
          // and reads as though a record could belong to somebody else.
          expect([key, Object.keys(record)]).toEqual([
            key,
            expect.not.arrayContaining(['owner_id']),
          ]);
        }
      }
    });

    it('has exactly the keys the format defines', async () => {
      const artifact = await exportParsed(await makeOwner());

      expect(Object.keys(artifact)).toEqual([
        'schema_version',
        'exported_at',
        'source_owner_id',
        ...COLLECTIONS.map(([key]) => key),
      ]);
    });

    it('timestamps itself with the moment the snapshot was taken', async () => {
      const before = new Date();
      const artifact = await exportParsed(await makeOwner());
      const after = new Date();

      const exportedAt = new Date(String(artifact['exported_at']));
      expect(exportedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1_000);
      expect(exportedAt.getTime()).toBeLessThanOrEqual(after.getTime() + 1_000);
    });
  });

  describe('what it contains', () => {
    it('carries every column of every table, taken from the catalog', async () => {
      const owner = await makeOwner();
      await seed(owner);
      const artifact = await exportParsed(owner);

      for (const [key, table] of COLLECTIONS) {
        const columns = await pool.query<{ column_name: string }>(
          `select column_name from information_schema.columns
            where table_schema = 'public' and table_name = $1
            order by ordinal_position`,
          [table],
        );
        const expected = columns.rows
          .map((row) => row.column_name)
          .filter((name) => name !== 'owner_id')
          .sort();

        const records = rows(artifact, key);
        expect([key, records.length]).toEqual([key, expect.any(Number)]);
        expect(records.length).toBeGreaterThan(0);

        for (const record of records) {
          // Read from the catalog rather than listed here, so a column added
          // to a table and forgotten in the export fails this test. Nothing
          // else would catch it: an export is read when somebody restores a
          // backup, which is the worst moment to discover a missing field.
          expect([key, Object.keys(record).sort()]).toEqual([key, expected]);
        }
      }
    });

    it('preserves every identifier, including the idempotency keys', async () => {
      const owner = await makeOwner();
      const seeded = await seed(owner);
      const artifact = await exportParsed(owner);

      const ids = (key: string, field: string) => rows(artifact, key).map((r) => r[field]);

      expect(ids('projects', 'project_id')).toEqual([seeded.projectId]);
      expect(ids('environments', 'environment_id')).toEqual([seeded.environmentId]);
      expect(ids('problems', 'problem_id')).toContain(seeded.problemId);
      expect(ids('problems', 'problem_id')).toContain(seeded.neighbourId);

      // `client_event_id` is the key that makes a resend idempotent. An export
      // that dropped it would restore a Memory in which every retry becomes a
      // duplicate.
      for (const key of ['events', 'verifications']) {
        for (const record of rows(artifact, key)) {
          expect(typeof record['client_event_id']).toBe('string');
        }
      }

      // Both ends of both reference tables.
      const relations = rows(artifact, 'relations');
      expect(relations.map((r) => r['from_id']).sort()).toEqual(
        [seeded.problemId, seeded.neighbourId].sort(),
      );
      const usage = rows(artifact, 'usage_logs');
      expect(usage[0]?.['problem_id']).toBe(seeded.neighbourId);
      expect(usage[0]?.['memory_id']).toBe(seeded.problemId);
    });

    it('is closed under its own references', async () => {
      const owner = await makeOwner();
      await seed(owner);
      const artifact = await exportParsed(owner);

      const idsIn = (key: string, field: string) =>
        new Set(rows(artifact, key).map((record) => String(record[field])));
      const projects = idsIn('projects', 'project_id');
      const environments = idsIn('environments', 'environment_id');
      const problems = idsIn('problems', 'problem_id');

      const references: [string, string, ReadonlySet<string>][] = [
        ['environments', 'project_id', projects],
        ['problems', 'project_id', projects],
        ['problems', 'environment_id', environments],
        ['events', 'problem_id', problems],
        ['verifications', 'problem_id', problems],
        ['relations', 'from_id', problems],
        ['relations', 'to_id', problems],
        ['usage_logs', 'problem_id', problems],
        ['usage_logs', 'memory_id', problems],
        ['change_logs', 'problem_id', problems],
      ];

      for (const [key, field, universe] of references) {
        for (const record of rows(artifact, key)) {
          // This is what "restorable into a clean environment" means. A
          // reference pointing outside the file is a restore that fails on a
          // foreign key, or worse, one that succeeds against the wrong row.
          expect([key, field, universe.has(String(record[field]))]).toEqual([key, field, true]);
        }
      }
    });

    it('records the change log with its version pair and its changes', async () => {
      const owner = await makeOwner();
      const seeded = await seed(owner);
      const artifact = await exportParsed(owner);

      const changeLogs = rows(artifact, 'change_logs');
      expect(changeLogs).toHaveLength(1);
      expect(changeLogs[0]?.['problem_id']).toBe(seeded.problemId);
      expect(changeLogs[0]?.['from_version']).toBe(1);
      expect(changeLogs[0]?.['to_version']).toBe(2);
      // A controlled value, recorded exactly. Free text is described rather
      // than copied (P2-10), so an export cannot resurrect a title that was
      // later removed.
      expect(changeLogs[0]?.['changes']).toEqual({
        confidence: { kind: 'exact', before: 'LOW', after: 'HIGH' },
      });
    });
  });

  describe('precision the artifact must not lose', () => {
    it('keeps timestamps to the microsecond, as the database holds them', async () => {
      const owner = await makeOwner();
      const seeded = await seed(owner);
      const raw = await exportRaw(owner);

      // The oracle is the database's own text, not a Date. A `Date` keeps
      // milliseconds, so comparing against one would agree with a broken
      // export: both would say `...123Z` and both would be wrong.
      const stored = await pool.query<{ created_at: string; updated_at: string }>(
        `select to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
                to_char(updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at
           from public.problems where owner_id = $1 and problem_id = $2`,
        [owner.ownerId, seeded.problemId],
      );
      const row = stored.rows[0];
      expect(row).toBeDefined();

      expect(raw).toContain(`"created_at" : "${String(row?.created_at)}"`);
      expect(raw).toContain(`"updated_at" : "${String(row?.updated_at)}"`);

      // And the six digits are really there rather than three and a zero pad.
      expect(row?.created_at).toMatch(/\.\d{6}Z$/);
    });

    it('keeps a snapshot number larger than JavaScript can hold', async () => {
      const owner = await makeOwner();
      await seed(owner);
      const raw = await exportRaw(owner);

      const stored = await pool.query<{ snapshot: string }>(
        `select snapshot::text as snapshot from public.environments where owner_id = $1`,
        [owner.ownerId],
      );
      const snapshot = stored.rows[0]?.snapshot ?? '';

      // 12345678901234567890 becomes 12345678901234567000 the moment anything
      // parses it. The database kept it; so must the artifact.
      expect(snapshot).toContain('12345678901234567890');
      expect(raw).toContain('12345678901234567890');
      expect(raw).not.toContain('12345678901234567000');

      // The fraction, likewise: JSON.parse rounds it to 0.1.
      expect(raw).toContain('0.1000000000000000055511151231257827');
    });

    it('embeds a snapshot as JSON rather than as a string', async () => {
      const owner = await makeOwner();
      await seed(owner);
      const artifact = await exportParsed(owner);

      const snapshot = rows(artifact, 'environments')[0]?.['snapshot'];
      expect(typeof snapshot).toBe('object');
      // A restore reads this as data, not as text to parse again.
      expect((snapshot as Record<string, unknown>)['runtime']).toBe('node 22.12.0');
      expect(
        (snapshot as Record<string, Record<string, Record<string, unknown>>>)['nested']?.['deep']?.[
          'absent'
        ],
      ).toBeNull();
    });

    it('sends the database’s bytes, unmodified', async () => {
      const owner = await makeOwner();
      await seed(owner);

      const raw = await exportRaw(owner);
      const direct = await pool
        .query<{ artifact: string }>(`select (select artifact from (select 1) t) as artifact`)
        .catch(() => undefined);
      expect(direct).toBeUndefined();

      // Round-tripping the response through JS is exactly what must not
      // happen, so the test does it and asserts the result differs.
      const reserialised = JSON.stringify(JSON.parse(raw));
      expect(reserialised).not.toBe(raw);
      expect(reserialised).toContain('12345678901234567000');
      expect(raw).toContain('12345678901234567890');
    });
  });

  describe('ordering and determinism', () => {
    it('lists every collection oldest first, breaking ties by id', async () => {
      const owner = await makeOwner();
      await seed(owner);
      const artifact = await exportParsed(owner);

      for (const [key] of COLLECTIONS) {
        const records = rows(artifact, key);
        const sorted = [...records].sort((a, b) => {
          const byTime = String(a['created_at']).localeCompare(String(b['created_at']));
          if (byTime !== 0) {
            return byTime;
          }
          const idField = Object.keys(a).find((name) => name.endsWith('_id')) ?? '';
          return String(a[idField]).localeCompare(String(b[idField]));
        });
        expect([key, records]).toEqual([key, sorted]);
      }
    });

    it('produces the same artifact twice, apart from when it was taken', async () => {
      const owner = await makeOwner();
      await seed(owner);

      const first = await exportParsed(owner);
      const second = await exportParsed(owner);

      // `exported_at` moves by design, so it is compared for validity rather
      // than equality; everything else is compared exactly, including the
      // order within each collection.
      expect(String(second['exported_at'])).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/,
      );
      expect(second['schema_version']).toBe(first['schema_version']);
      expect(second['source_owner_id']).toBe(first['source_owner_id']);
      for (const [key] of COLLECTIONS) {
        expect([key, second[key]]).toEqual([key, first[key]]);
      }
    });
  });

  describe('what an export must never carry', () => {
    it('contains nothing about clients or credentials', async () => {
      const owner = await makeOwner();
      await seed(owner);

      const raw = await exportRaw(owner);

      // The token itself, its stored halves, and the identifiers of the
      // client that presented it. A credential is how this owner reaches
      // their memory, not part of it, and an artifact carrying one would move
      // access along with the data.
      expect(raw).not.toContain(owner.token);
      expect(raw).not.toContain(owner.credentialId);
      expect(raw).not.toContain('export test client');

      const stored = await pool.query<{ lookup: string; client_id: string }>(
        `select cc.token_lookup as lookup, cc.client_id from public.client_credentials cc
           join public.clients c on c.client_id = cc.client_id where c.owner_id = $1`,
        [owner.ownerId],
      );
      expect(stored.rows).toHaveLength(1);
      expect(raw).not.toContain(String(stored.rows[0]?.lookup));
      expect(raw).not.toContain(String(stored.rows[0]?.client_id));
    });

    it('contains nothing belonging to another owner', async () => {
      const mine = await makeOwner();
      const theirs = await makeOwner();
      const seededMine = await seed(mine);
      const seededTheirs = await seed(theirs);

      const raw = await exportRaw(mine);

      expect(raw).toContain(seededMine.marker);
      expect(raw).not.toContain(seededTheirs.marker);
      expect(raw).not.toContain(seededTheirs.problemId);
      expect(raw).not.toContain(theirs.ownerId);
    });

    it('refuses without a credential, and with a revoked one', async () => {
      const owner = await makeOwner();
      await seed(owner);

      expect((await app.inject({ method: 'GET', url: '/v1/export' })).statusCode).toBe(401);

      const credentials = createCredentialRepository(pool);
      await credentials.revoke(
        owner.ownerId,
        owner.credentialId as unknown as Parameters<typeof credentials.revoke>[1],
      );

      const refused = await app.inject({
        method: 'GET',
        url: '/v1/export',
        headers: auth(owner),
      });
      expect(refused.statusCode).toBe(401);
    });
  });

  describe('a credential mis-saved before the boundary existed', () => {
    /** Raw SQL: the write boundary would refuse this today, which is the point. */
    async function writeHistoricalSecret(owner: Owner, problemId: string, value: string) {
      await pool.query(
        `update public.problems set symptoms = $3 where owner_id = $1 and problem_id = $2`,
        [owner.ownerId, problemId, value],
      );
    }

    it('refuses the export rather than redacting it', async () => {
      const owner = await makeOwner();
      const seeded = await seed(owner);
      const secret = `AKIA${randomUUID().replaceAll('-', '').toUpperCase().slice(0, 16)}`;
      await writeHistoricalSecret(owner, seeded.problemId, `the log read PASSWORD=${secret}`);

      const before = logLines.length;
      const response = await app.inject({ method: 'GET', url: '/v1/export', headers: auth(owner) });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: 'EXPORT_BLOCKED' } });

      // Not redacted and sent: an artifact that differs from the database is
      // not a copy of it, and restoring one would replace real content with
      // markers.
      expect(response.body).not.toContain(secret);
      expect(response.body).not.toContain('[REDACTED]');
      expect(response.body).not.toContain(seeded.problemId);

      // And nothing about what was found reaches the log.
      const written = logLines.slice(before).join('\n');
      expect(written).not.toContain(secret);
      expect(written).not.toContain('PASSWORD=');
      expect(written).not.toContain(seeded.problemId);
    });

    it('changes nothing about the memory it refused to export', async () => {
      const owner = await makeOwner();
      const seeded = await seed(owner);
      const secret = `AKIA${randomUUID().replaceAll('-', '').toUpperCase().slice(0, 16)}`;
      const symptoms = `the log read PASSWORD=${secret}`;
      await writeHistoricalSecret(owner, seeded.problemId, symptoms);

      const snapshot = await pool.query(
        `select to_jsonb(p) as row from public.problems p where owner_id = $1 and problem_id = $2`,
        [owner.ownerId, seeded.problemId],
      );

      expect(
        (await app.inject({ method: 'GET', url: '/v1/export', headers: auth(owner) })).statusCode,
      ).toBe(409);

      const after = await pool.query(
        `select to_jsonb(p) as row from public.problems p where owner_id = $1 and problem_id = $2`,
        [owner.ownerId, seeded.problemId],
      );

      // Reading your own data must not edit it. No redaction written back, no
      // freshness moved, no flag set, no row removed.
      expect(after.rows).toEqual(snapshot.rows);
    });

    it('exports normally when the memory only looks suspicious', async () => {
      const owner = await makeOwner();
      const seeded = await seed(owner);
      // An ambiguous name with an ordinary word under it: suspected, not
      // confirmed. Withholding somebody's whole memory on a guess is a worse
      // failure than the guess occasionally being right.
      await writeHistoricalSecret(owner, seeded.problemId, 'the token was expired');

      const response = await app.inject({ method: 'GET', url: '/v1/export', headers: auth(owner) });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('the token was expired');
    });

    it('exports again once the offending memory is deleted', async () => {
      const owner = await makeOwner();
      const seeded = await seed(owner);
      const secret = `AKIA${randomUUID().replaceAll('-', '').toUpperCase().slice(0, 16)}`;
      await writeHistoricalSecret(owner, seeded.problemId, `PASSWORD=${secret}`);

      expect(
        (await app.inject({ method: 'GET', url: '/v1/export', headers: auth(owner) })).statusCode,
      ).toBe(409);

      // The route out is the one P3-05 built, which is why refusing is an
      // answer the owner can act on rather than a dead end.
      const version = await pool.query<{ version: number }>(
        `select version from public.problems where owner_id = $1 and problem_id = $2`,
        [owner.ownerId, seeded.problemId],
      );
      const deleted = await app.inject({
        method: 'DELETE',
        url: `/v1/problems/${seeded.problemId}?expected_version=${String(version.rows[0]?.version)}`,
        headers: auth(owner),
      });
      expect(deleted.statusCode).toBe(204);

      const response = await app.inject({ method: 'GET', url: '/v1/export', headers: auth(owner) });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain(secret);
    });
  });

  describe('nothing of the memory reaches the log', () => {
    it('logs that a request was served and none of what it carried', async () => {
      const owner = await makeOwner();
      const seeded = await seed(owner);

      const before = logLines.length;
      const raw = await exportRaw(owner);
      const written = logLines.slice(before).join('\n');

      expect(raw).toContain(seeded.marker);
      // The largest response in the system, and none of it in the log.
      expect(written).not.toContain(seeded.marker);
      expect(written).not.toContain('the symptoms as recorded');
      expect(written).not.toContain('12345678901234567890');
    });
  });

  describe('after a problem is deleted', () => {
    it('drops it and everything referring to it, keeping the project', async () => {
      const owner = await makeOwner();
      const seeded = await seed(owner);

      const before = await exportParsed(owner);
      expect(rows(before, 'problems').map((r) => r['problem_id'])).toContain(seeded.problemId);
      expect(rows(before, 'events')).toHaveLength(1);
      expect(rows(before, 'relations')).toHaveLength(2);
      expect(rows(before, 'usage_logs')).toHaveLength(1);

      const version = await pool.query<{ version: number }>(
        `select version from public.problems where owner_id = $1 and problem_id = $2`,
        [owner.ownerId, seeded.problemId],
      );
      const deleted = await app.inject({
        method: 'DELETE',
        url: `/v1/problems/${seeded.problemId}?expected_version=${String(version.rows[0]?.version)}`,
        headers: auth(owner),
      });
      expect(deleted.statusCode).toBe(204);

      const after = await exportParsed(owner);

      expect(rows(after, 'problems').map((r) => r['problem_id'])).toEqual([seeded.neighbourId]);
      expect(rows(after, 'events')).toEqual([]);
      expect(rows(after, 'verifications')).toEqual([]);
      expect(rows(after, 'change_logs')).toEqual([]);
      // Both directions, including the relation the surviving problem owned
      // and the usage log it wrote.
      expect(rows(after, 'relations')).toEqual([]);
      expect(rows(after, 'usage_logs')).toEqual([]);

      // The container survives, as P3-05 decided.
      expect(rows(after, 'projects').map((r) => r['project_id'])).toEqual([seeded.projectId]);
      expect(rows(after, 'environments').map((r) => r['environment_id'])).toEqual([
        seeded.environmentId,
      ]);
    });
  });
});
