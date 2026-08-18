/**
 * Schema-wide integrity audit, against the real database.
 *
 * The entity suites each check their own table. This one checks the schema as
 * a whole: that the foreign key chain is complete, that every delete is
 * RESTRICT, that orphans cannot be created through any entry point, that
 * required columns are required and nullable ones are still nullable, and that
 * the indexes are the ones intended with no leftovers.
 *
 * Read as: if a later phase quietly weakens one of these, this file fails.
 *
 * Skipped when `DATABASE_URL` is not set.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readDatabaseUrl } from '../../src/config/env.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { createEnvironment } from '../../src/db/environments.js';
import { appendEvent } from '../../src/db/events.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import { createProblem } from '../../src/db/problems.js';
import { createProject } from '../../src/db/projects.js';
import { appendVerification } from '../../src/db/verifications.js';
import { generateClientEventId } from '../../src/domain/client-event-id.js';
import { generateEnvironmentId, type EnvironmentId } from '../../src/domain/environment.js';
import { generateOwnerId, type OwnerContext, type OwnerId } from '../../src/domain/owner.js';
import { generateProblemId, type ProblemId } from '../../src/domain/problem.js';
import { generateProjectId, type ProjectId } from '../../src/domain/project.js';
import { MEMORY_OWNER_ID_VAR, resolveOwnerContext } from '../../src/owner/context.js';

const databaseUrl = readDatabaseUrl();

/**
 * The Memory tables: what an owner records, scoped by `owner_id` throughout.
 */
const OWNED_TABLES = [
  'owners',
  'projects',
  'environments',
  'problems',
  'events',
  'verifications',
  'relations',
  'usage_logs',
  'change_logs',
  'retrieval_artifacts',
] as const;

/**
 * The identity tables, which are not Memory content.
 *
 * `clients` is owned and carries `owner_id` like everything else.
 * `client_credentials` deliberately does not: a credential belongs to a
 * client, and the client belongs to an owner. Copying the owner down a second
 * level would create two records of the same fact that can disagree, and the
 * copy is the one an attacker would want to change.
 */
const IDENTITY_TABLES = ['clients', 'client_credentials'] as const;

/** Every table, for inventory assertions. */
const ALL_TABLES = [...OWNED_TABLES, ...IDENTITY_TABLES] as const;

interface Chain {
  readonly context: OwnerContext;
  readonly projectId: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly problemId: ProblemId;
}

describe.skipIf(databaseUrl === undefined)('schema integrity', () => {
  let pool: DatabasePool;
  const ownersCreated: OwnerId[] = [];

  async function makeOwnerContext(): Promise<OwnerContext> {
    const ownerId = generateOwnerId();
    await insertOwnerIfAbsent(pool, ownerId);
    ownersCreated.push(ownerId);
    return resolveOwnerContext(pool, { [MEMORY_OWNER_ID_VAR]: ownerId });
  }

  /** A full owner → project → environment → problem chain. */
  async function makeChain(): Promise<Chain> {
    const context = await makeOwnerContext();
    const project = await createProject(pool, context, { projectName: 'integrity-project' });
    const environment = await createEnvironment(pool, context, {
      projectId: project.projectId,
      snapshot: {},
    });
    const problem = await createProblem(pool, context, {
      projectId: project.projectId,
      environmentId: environment.environmentId,
      title: 'Integrity problem',
      symptoms: 'Something is wrong.',
    });

    return {
      context,
      projectId: project.projectId,
      environmentId: environment.environmentId,
      problemId: problem.problemId,
    };
  }

  beforeAll(() => {
    pool = createPool(resolveDatabaseConfig({ nodeEnv: 'test', connectionTimeoutMillis: 5_000 }));
  });

  afterAll(async () => {
    if (ownersCreated.length > 0) {
      // Leaf to root — which is exactly the order the delete policy requires.
      for (const table of [...OWNED_TABLES].reverse()) {
        await pool.query(`delete from public.${table} where owner_id = any($1::uuid[])`, [
          ownersCreated,
        ]);
      }
    }
    await closePool(pool);
  });

  describe('foreign keys', () => {
    it('links every table to its parent, and nothing else', async () => {
      const result = await pool.query<{ child: string; definition: string }>(
        `select conrelid::regclass::text as child, pg_get_constraintdef(oid) as definition
           from pg_constraint
          where contype = 'f' and connamespace = 'public'::regnamespace
          order by conrelid::regclass::text`,
      );

      // Sorted here rather than relying on the query's order: it orders by
      // table only, so two keys on one table could come back either way.
      const links = result.rows.map((row) => `${row.child}: ${row.definition}`).sort();

      expect(links).toEqual([
        // A change log entry belongs to the problem it describes, and that
        // problem cannot be removed while its history exists.
        'change_logs: FOREIGN KEY (owner_id, problem_id) REFERENCES problems(owner_id, problem_id) ON DELETE RESTRICT',
        // A credential reaches its owner through its client, and only through
        // it. One path, so there is nothing to disagree with itself.
        'client_credentials: FOREIGN KEY (client_id) REFERENCES clients(client_id) ON DELETE RESTRICT',
        'clients: FOREIGN KEY (owner_id) REFERENCES owners(owner_id) ON DELETE RESTRICT',
        'environments: FOREIGN KEY (owner_id, project_id) REFERENCES projects(owner_id, project_id) ON DELETE RESTRICT',
        'events: FOREIGN KEY (owner_id, problem_id) REFERENCES problems(owner_id, problem_id) ON DELETE RESTRICT',
        'problems: FOREIGN KEY (owner_id, project_id, environment_id) REFERENCES environments(owner_id, project_id, environment_id) ON DELETE RESTRICT',
        'projects: FOREIGN KEY (owner_id) REFERENCES owners(owner_id) ON DELETE RESTRICT',
        // A relation has two parents, one per end, so neither end can point
        // at another owner's problem and neither problem can be removed while
        // the link exists.
        'relations: FOREIGN KEY (owner_id, from_id) REFERENCES problems(owner_id, problem_id) ON DELETE RESTRICT',
        'relations: FOREIGN KEY (owner_id, to_id) REFERENCES problems(owner_id, problem_id) ON DELETE RESTRICT',
        // A retrieval artifact belongs to the problem it describes. Composite
        // like the rest, so a derived row cannot name one owner and another
        // owner's problem; RESTRICT like the rest, so the delete path removes
        // it deliberately rather than the database discarding it as a side
        // effect of something above.
        'retrieval_artifacts: FOREIGN KEY (owner_id, problem_id) REFERENCES problems(owner_id, problem_id) ON DELETE RESTRICT',
        // A usage log names two problems too: the one being worked on and the
        // one used as memory. Neither may be another owner's, and neither can
        // be removed while the record of the use exists.
        'usage_logs: FOREIGN KEY (owner_id, memory_id) REFERENCES problems(owner_id, problem_id) ON DELETE RESTRICT',
        'usage_logs: FOREIGN KEY (owner_id, problem_id) REFERENCES problems(owner_id, problem_id) ON DELETE RESTRICT',
        'verifications: FOREIGN KEY (owner_id, problem_id) REFERENCES problems(owner_id, problem_id) ON DELETE RESTRICT',
      ]);
    });

    it('restricts every delete, so no parent quietly removes a subtree', async () => {
      const result = await pool.query<{ conname: string; confdeltype: string }>(
        `select conname, confdeltype::text as confdeltype
           from pg_constraint
          where contype = 'f' and connamespace = 'public'::regnamespace`,
      );

      // 'r' is RESTRICT. Anything else here would mean Memory could be
      // discarded as a side effect of deleting something above it.
      expect(result.rows.every((row) => row.confdeltype === 'r')).toBe(true);
      // Thirteen: relations and usage_logs bring one per end, change_logs one,
      // P3-04 adds the client and its credentials, and P4-01 the retrieval
      // artifact — the first reference that exists for a derived store.
      expect(result.rows).toHaveLength(13);
    });

    it('has exactly eight references into problems, all of which the delete path removes', async () => {
      const result = await pool.query<{ child: string; columns: string }>(
        `select
           con.conrelid::regclass::text as child,
           (select string_agg(a.attname, ',' order by k.ord)
              from unnest(con.conkey) with ordinality k(attnum, ord)
              join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum) as columns
         from pg_constraint con
         where con.contype = 'f'
           and con.connamespace = 'public'::regnamespace
           and con.confrelid = 'public.problems'::regclass
         order by 1, 2`,
      );

      const incoming = result.rows.map((row) => `${row.child}(${row.columns})`);

      // Pinned as a literal list, and the reason is P3-05 rather than tidiness.
      // Physical delete has to reach every one of these, and the failure mode
      // of forgetting one is silent from up here: the parent delete fails on
      // the foreign key, the transaction rolls back, and a user who asked for
      // a Problem to be gone is told something went wrong without being told
      // it is still there.
      //
      // So a new reference into `problems` fails this test, and whoever adds
      // it has to decide whether the delete path takes it too. A future
      // retrieval artifact or search cache is exactly that case: give it a
      // RESTRICT foreign key like everything else, and this test is the
      // reminder that P3-05 and the Phase 3 delete end-to-end have to grow
      // with it.
      // Eight, not seven: `relations` and `usage_logs` each contribute two, so
      // counting tables rather than keys undercounts exactly the references
      // that point in from a Problem that survives. The eighth is P4-01's
      // retrieval artifact — the first derived store, and the first reference
      // that exists for the search layer's benefit rather than the record's.
      expect(incoming).toEqual([
        'change_logs(owner_id,problem_id)',
        'events(owner_id,problem_id)',
        'relations(owner_id,from_id)',
        'relations(owner_id,to_id)',
        'retrieval_artifacts(owner_id,problem_id)',
        'usage_logs(owner_id,memory_id)',
        'usage_logs(owner_id,problem_id)',
        'verifications(owner_id,problem_id)',
      ]);
    });

    it('carries owner_id on every table, so owner scope never needs a join', async () => {
      const result = await pool.query<{ table_name: string }>(
        `select table_name from information_schema.columns
          where table_schema = 'public' and column_name = 'owner_id'
          order by table_name`,
      );

      // On `owners` it is the identity itself; on the Memory tables it is the
      // scope an owner-scoped read filters on directly; on `clients` it is
      // ownership of the connection. `client_credentials` is absent on
      // purpose — it reaches its owner through its client, and one path to a
      // fact cannot disagree with itself.
      expect(result.rows.map((row) => row.table_name).sort()).toEqual(
        [...OWNED_TABLES, 'clients'].sort(),
      );
    });
  });

  describe('orphan prevention', () => {
    it('refuses a project for an owner that does not exist', async () => {
      await expect(
        pool.query(
          'insert into public.projects (project_id, owner_id, project_name) values ($1, $2, $3)',
          [generateProjectId(), generateOwnerId(), 'orphan'],
        ),
      ).rejects.toThrow(/violates foreign key constraint/);
    });

    it('refuses an environment whose owner and project disagree', async () => {
      const chainA = await makeChain();
      const chainB = await makeChain();

      await expect(
        pool.query(
          `insert into public.environments (environment_id, owner_id, project_id, snapshot)
                values ($1, $2, $3, '{}'::jsonb)`,
          [generateEnvironmentId(), chainA.context.ownerId, chainB.projectId],
        ),
      ).rejects.toThrow(/violates foreign key constraint/);
    });

    it('refuses a problem whose owner, project and environment disagree', async () => {
      const chainA = await makeChain();
      const chainB = await makeChain();

      await expect(
        pool.query(
          `insert into public.problems
                  (problem_id, owner_id, project_id, environment_id, title, symptoms)
                values ($1, $2, $3, $4, $5, $6)`,
          [
            generateProblemId(),
            chainA.context.ownerId,
            chainA.projectId,
            chainB.environmentId,
            'title',
            'symptoms',
          ],
        ),
      ).rejects.toThrow(/violates foreign key constraint/);
    });

    it.each([
      ['events', 'event_type, summary', "'ATTEMPT', 'summary'"],
      ['verifications', 'verification_type, result, summary', "'TEST', true, 'summary'"],
    ])('refuses a %s row for a problem that does not exist', async (table, columns, values) => {
      const chain = await makeChain();
      const idColumn = table === 'events' ? 'event_id' : 'verification_id';

      await expect(
        pool.query(
          `insert into public.${table}
                  (${idColumn}, owner_id, problem_id, ${columns}, client_event_id)
                values ($1, $2, $3, ${values}, $4)`,
          [
            table === 'events' ? generateProblemId() : generateProblemId(),
            chain.context.ownerId,
            generateProblemId(),
            generateClientEventId(),
          ],
        ),
      ).rejects.toThrow(/violates foreign key constraint/);
    });

    it('refuses appending to another owner’s problem, from either append path', async () => {
      const chainA = await makeChain();
      const chainB = await makeChain();

      await expect(
        appendEvent(pool, chainA.context, {
          problemId: chainB.problemId,
          eventType: 'ATTEMPT',
          summary: 'Cross-owner',
          clientEventId: generateClientEventId(),
        }),
      ).rejects.toThrow(/No such problem/);

      await expect(
        appendVerification(pool, chainA.context, {
          problemId: chainB.problemId,
          verificationType: 'TEST',
          result: true,
          summary: 'Cross-owner',
          clientEventId: generateClientEventId(),
        }),
      ).rejects.toThrow(/No such problem/);
    });

    it('refuses deleting any parent that still has children, at every level', async () => {
      const chain = await makeChain();
      await appendEvent(pool, chain.context, {
        problemId: chain.problemId,
        eventType: 'ATTEMPT',
        summary: 'Holds the chain',
        clientEventId: generateClientEventId(),
      });

      const attempts: readonly (readonly [string, string, unknown])[] = [
        ['problems', 'problem_id', chain.problemId],
        ['environments', 'environment_id', chain.environmentId],
        ['projects', 'project_id', chain.projectId],
        ['owners', 'owner_id', chain.context.ownerId],
      ];

      for (const [table, column, value] of attempts) {
        await expect(
          pool.query(`delete from public.${table} where ${column} = $1`, [value]),
        ).rejects.toThrow(/violates foreign key constraint/);
      }
    });

    it('permits deletion in leaf-to-root order, which is what a hard delete must do', async () => {
      const chain = await makeChain();
      await appendEvent(pool, chain.context, {
        problemId: chain.problemId,
        eventType: 'ATTEMPT',
        summary: 'Removed first',
        clientEventId: generateClientEventId(),
      });
      await appendVerification(pool, chain.context, {
        problemId: chain.problemId,
        verificationType: 'TEST',
        result: true,
        summary: 'Removed first',
        clientEventId: generateClientEventId(),
      });

      // RESTRICT does not prevent removal — it prevents removal happening
      // implicitly. Done in order, from the leaves up, it succeeds.
      await pool.query('delete from public.events where problem_id = $1', [chain.problemId]);
      await pool.query('delete from public.verifications where problem_id = $1', [chain.problemId]);
      await pool.query('delete from public.problems where problem_id = $1', [chain.problemId]);
      await pool.query('delete from public.environments where environment_id = $1', [
        chain.environmentId,
      ]);
      await pool.query('delete from public.projects where project_id = $1', [chain.projectId]);

      await expect(
        pool.query('delete from public.owners where owner_id = $1', [chain.context.ownerId]),
      ).resolves.toBeDefined();
    });
  });

  describe('required and optional columns', () => {
    it.each([
      ['owners', ['created_at', 'owner_id']],
      ['projects', ['created_at', 'owner_id', 'project_id', 'project_name', 'updated_at']],
      ['environments', ['created_at', 'environment_id', 'owner_id', 'project_id', 'snapshot']],
      [
        'problems',
        [
          'confidence',
          'created_at',
          'environment_id',
          'freshness',
          'importance',
          'memory_read_enabled',
          'memory_write_enabled',
          'owner_id',
          'problem_id',
          'project_id',
          'status',
          'suppressed',
          'symptoms',
          'title',
          'updated_at',
          'version',
        ],
      ],
      [
        'events',
        [
          'client_event_id',
          'created_at',
          'event_id',
          'event_type',
          'owner_id',
          'problem_id',
          'summary',
        ],
      ],
      [
        'verifications',
        [
          'client_event_id',
          'created_at',
          'owner_id',
          'problem_id',
          'result',
          'summary',
          'verification_id',
          'verification_type',
        ],
      ],
    ])('requires exactly the intended columns on %s', async (table, required) => {
      const result = await pool.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'public' and table_name = $1 and is_nullable = 'NO'`,
        [table],
      );

      expect(result.rows.map((row) => row.column_name).sort()).toEqual(required);
    });

    it('keeps genuinely unknown values optional rather than tightening them', async () => {
      const result = await pool.query<{ table_name: string; column_name: string }>(
        `select table_name, column_name from information_schema.columns
          where table_schema = 'public' and is_nullable = 'YES'
            and table_name = any($1::text[])`,
        [[...OWNED_TABLES]],
      );

      const optional = result.rows.map((row) => `${row.table_name}.${row.column_name}`).sort();

      // A nullable column here is nullable because the value can truly be
      // unknown — not because nobody has got round to constraining it.
      expect(optional).toEqual([
        'events.evidence_ref',
        'events.reason',
        'events.result',
        'events.source_ai',
        'problems.fix_kind',
        'problems.problem_domain',
        'problems.source_ai',
        'problems.suspected_boundary',
        'projects.platform',
        'projects.repo',
        'projects.repo_subpath',
        // A memory that was merely found or read has no outcome yet, and
        // inventing one would be worse than leaving it open.
        'usage_logs.result',
        'verifications.evidence_ref',
        'verifications.verified_by',
      ]);
    });
  });

  describe('client event id uniqueness', () => {
    it('is scoped per owner within each write table, not shared between them', async () => {
      const result = await pool.query<{ conrelid: string; definition: string }>(
        `select conrelid::regclass::text as conrelid, pg_get_constraintdef(oid) as definition
           from pg_constraint
          where contype = 'u' and connamespace = 'public'::regnamespace
            and conrelid::regclass::text in ('events', 'verifications')
          order by conrelid::regclass::text`,
      );

      expect(result.rows).toEqual([
        { conrelid: 'events', definition: 'UNIQUE (owner_id, client_event_id)' },
        { conrelid: 'verifications', definition: 'UNIQUE (owner_id, client_event_id)' },
      ]);
    });

    it('lets one value be used once as an event and once as a verification', async () => {
      const chain = await makeChain();
      const clientEventId = generateClientEventId();

      await appendEvent(pool, chain.context, {
        problemId: chain.problemId,
        eventType: 'FIX',
        summary: 'Applied the fix',
        clientEventId,
      });

      await expect(
        appendVerification(pool, chain.context, {
          problemId: chain.problemId,
          verificationType: 'TEST',
          result: true,
          summary: 'Confirmed the fix',
          clientEventId,
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('indexes', () => {
    it('supports listing events by problem in order with a single index', async () => {
      const result = await pool.query<{ indexdef: string }>(
        `select indexdef from pg_indexes
          where schemaname = 'public' and indexname = 'events_owner_problem_created_at_event_id_idx'`,
      );

      expect(result.rows[0]?.indexdef).toContain('(owner_id, problem_id, created_at, event_id)');
    });

    it('supports listing verifications by problem in order with a single index', async () => {
      const result = await pool.query<{ indexdef: string }>(
        `select indexdef from pg_indexes
          where schemaname = 'public'
            and indexname = 'verifications_owner_problem_created_at_verification_id_idx'`,
      );

      expect(result.rows[0]?.indexdef).toContain(
        '(owner_id, problem_id, created_at, verification_id)',
      );
    });

    it('supports listing a project’s problems in order', async () => {
      const result = await pool.query<{ indexdef: string }>(
        `select indexdef from pg_indexes
          where schemaname = 'public'
            and indexname = 'problems_owner_project_created_at_problem_id_idx'`,
      );

      expect(result.rows[0]?.indexdef).toContain('(owner_id, project_id, created_at, problem_id)');
    });

    it('keeps the environment foreign key index, which serves a different path', async () => {
      const result = await pool.query<{ indexdef: string }>(
        `select indexdef from pg_indexes
          where schemaname = 'public'
            and indexname = 'problems_owner_id_project_id_environment_id_idx'`,
      );

      expect(result.rows[0]?.indexdef).toContain('(owner_id, project_id, environment_id)');
    });

    it('has no index whose columns are a left prefix of another on the same table', async () => {
      const result = await pool.query<{ tablename: string; indexname: string; cols: string }>(
        `select tablename, indexname,
                regexp_replace(indexdef, '^.*USING btree \\((.*)\\)$', '\\1') as cols
           from pg_indexes where schemaname = 'public'`,
      );

      const redundant: string[] = [];
      for (const candidate of result.rows) {
        const isCoveredByAnother = result.rows.some(
          (other) =>
            other.tablename === candidate.tablename &&
            other.indexname !== candidate.indexname &&
            other.cols.startsWith(`${candidate.cols}, `),
        );
        if (isCoveredByAnother) {
          redundant.push(`${candidate.tablename}.${candidate.indexname} (${candidate.cols})`);
        }
      }

      // A shorter index whose columns lead another one earns nothing and costs
      // a write on every insert.
      expect(redundant).toEqual([]);
    });

    it('no longer carries the short indexes the ordered ones replaced', async () => {
      const result = await pool.query<{ indexname: string }>(
        `select indexname from pg_indexes
          where schemaname = 'public' and indexname = any($1::text[])`,
        [
          [
            'events_owner_id_problem_id_idx',
            'verifications_owner_id_problem_id_idx',
            'projects_owner_id_idx',
            'environments_owner_id_project_id_idx',
          ],
        ],
      );

      expect(result.rows).toEqual([]);
    });
  });

  describe('schema scope', () => {
    it('holds exactly the tables the phases have added', async () => {
      const result = await pool.query<{ table_name: string }>(
        "select table_name from information_schema.tables where table_schema = 'public'",
      );

      expect(result.rows.map((row) => row.table_name).sort()).toEqual([...ALL_TABLES].sort());
    });

    it('keeps every value set as a domain, with no native enum', async () => {
      const result = await pool.query<{ typtype: string; count: string }>(
        `select t.typtype::text as typtype, count(*)::text as count
           from pg_type t join pg_namespace n on n.oid = t.typnamespace
          where n.nspname = 'public' and t.typtype in ('d', 'e')
          group by t.typtype`,
      );

      const byKind = Object.fromEntries(result.rows.map((row) => [row.typtype, row.count]));

      // Six from P1-04, plus `relation_type` and `usage_action`.
      expect(byKind['d']).toBe('8');
      expect(byKind['e']).toBeUndefined();
    });
  });
});
