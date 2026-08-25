/**
 * Lexical search over retrieval artifacts, against a real database.
 *
 * Most of what matters here cannot be tested any other way. Whether the stored
 * document keeps up with an artifact that was replaced, whether the index is
 * actually usable by the query that was written, whether a Problem whose owner
 * turned reading off disappears from results while its row stays — these are
 * properties of PostgreSQL and of a migration, not of TypeScript.
 *
 * Two boundaries get the most attention, because getting either wrong would be
 * quiet rather than loud.
 *
 * **What the document is made of.** Only the artifact's summary and keywords.
 * There are tests that put a unique marker in the Problem's own title and
 * symptoms, and another in the structural features, and search for it — both
 * must find nothing. If either ever hits, the searchable text has grown a
 * second definition and the translation P4-02 exists to perform is being routed
 * around.
 *
 * **What is filtered versus what is merely ranked.** The owner and the read
 * control remove candidates. Suppression, staleness and low confidence do not,
 * and there is a test that says so — making an invalid Memory unfindable would
 * quietly settle a question that belongs to the tasks that present results.
 *
 * Every artifact below is seeded through the real P4-01 repository, complete
 * with an embedding, because that is the only kind of artifact that exists.
 * Nothing here generates one: there is no production path that does yet.
 *
 * Skipped when `DATABASE_URL` is not set.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readDatabaseUrl } from '../../src/config/env.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import { generateOwnerId, type OwnerContext, type OwnerId } from '../../src/domain/owner.js';
import type { ProblemId } from '../../src/domain/problem.js';
import type { ProjectId } from '../../src/domain/project.js';
import { resolveOwnerContextFor } from '../../src/owner/context.js';
import {
  createMemoryRepository,
  createRetrievalArtifactRepository,
  createRetrievalSearchReader,
  type MemoryRepository,
  type RetrievalArtifactRepository,
  type RetrievalSearchReader,
} from '../../src/repository/index.js';
import {
  createArtifactInspectionPolicy,
  createSecretDetectionPolicy,
  withSanitization,
} from '../../src/sanitization/index.js';

const databaseUrl = readDatabaseUrl();

const INDEX_NAME = 'retrieval_artifacts_search_document_gin';

interface Actor {
  readonly ownerId: OwnerId;
  readonly context: OwnerContext;
  readonly memory: MemoryRepository;
  readonly artifacts: RetrievalArtifactRepository;
  readonly search: RetrievalSearchReader;
}

interface Seeded {
  readonly problemId: ProblemId;
  readonly projectId: ProjectId;
}

describe.skipIf(databaseUrl === undefined)('lexical search over retrieval artifacts', () => {
  let pool: DatabasePool;
  let actor: Actor;
  const ownersCreated: OwnerId[] = [];

  async function makeActor(): Promise<Actor> {
    const ownerId = generateOwnerId();
    await insertOwnerIfAbsent(pool, ownerId);
    ownersCreated.push(ownerId);

    const context = await resolveOwnerContextFor(pool, ownerId);
    return {
      ownerId,
      context,
      memory: withSanitization(
        createMemoryRepository(pool, context),
        createSecretDetectionPolicy(),
      ),
      artifacts: withSanitization(
        createRetrievalArtifactRepository(pool, context),
        createArtifactInspectionPolicy(),
      ),
      search: createRetrievalSearchReader(pool, context),
    };
  }

  /** A Problem with an artifact, both as described. */
  async function seed(
    owner: Actor,
    options: {
      readonly summary: string;
      readonly keywords: readonly string[];
      readonly title?: string;
      readonly symptoms?: string;
      readonly structuralFeatures?: Record<string, unknown>;
      readonly projectId?: ProjectId;
    },
  ): Promise<Seeded> {
    const projectId =
      options.projectId ??
      (await owner.memory.createProject({ projectName: `project ${randomUUID()}` })).projectId;
    const environment = await owner.memory.createEnvironment({
      projectId,
      snapshot: { runtime: 'node 22.12.0' },
    });
    const problem = await owner.memory.createProblem({
      projectId,
      environmentId: environment.environmentId,
      title: options.title ?? 'an ordinary title',
      symptoms: options.symptoms ?? 'ordinary symptoms',
    });

    await owner.artifacts.upsertArtifact({
      problemId: problem.problemId,
      normalizedSummary: options.summary,
      keywords: [...options.keywords],
      structuralFeatures: options.structuralFeatures ?? { boundary: 'configuration' },
      summaryGeneratorId: 'fixture-summary-generator',
      summaryGeneratorVersion: '1',
      // Complete, because a partial artifact is not a state this system has.
      semantic: {
        embedding: [0.5, 0.25, 0.125],
        embeddingModel: 'fixture-model',
        embeddingModelVersion: '1',
      },
      sourceFingerprint: `retrieval-source-v1:${randomUUID().replace(/-/g, '')}`,
      generatedAt: new Date('2026-08-16T10:00:00.000Z'),
    });

    return { problemId: problem.problemId, projectId };
  }

  const found = async (owner: Actor, text: string, extra = {}): Promise<ProblemId[]> =>
    (await owner.search.searchFullText({ text, ...extra })).map((candidate) => candidate.problemId);

  beforeAll(async () => {
    pool = createPool(resolveDatabaseConfig({ nodeEnv: 'test', connectionTimeoutMillis: 5_000 }));
    actor = await makeActor();
  });

  afterAll(async () => {
    if (ownersCreated.length > 0) {
      for (const table of [
        'retrieval_artifacts',
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

  describe('the search support in the schema', () => {
    it('derives the document in the database, with no trigger to keep in step', async () => {
      const column = await pool.query<{ is_generated: string; generation_expression: string }>(
        `select is_generated, generation_expression
           from information_schema.columns
          where table_schema = 'public'
            and table_name = 'retrieval_artifacts'
            and column_name = 'search_document'`,
      );

      expect(column.rows[0]?.is_generated).toBe('ALWAYS');
      expect(column.rows[0]?.generation_expression).toContain('retrieval_fts_document');

      const triggers = await pool.query<{ count: string }>(
        `select count(*)::text as count from information_schema.triggers
          where trigger_schema = 'public'`,
      );
      // A generated column is recomputed by the database on every write, so
      // there is nothing to synchronise and nothing that can drift.
      expect(Number(triggers.rows[0]?.count)).toBe(0);
    });

    it('declares the helper immutable truthfully', async () => {
      const fn = await pool.query<{ volatility: string; parallel: string; definition: string }>(
        `select p.provolatile as volatility, p.proparallel as parallel,
                pg_get_functiondef(p.oid) as definition
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'retrieval_fts_document'`,
      );

      expect(fn.rows[0]?.volatility).toBe('i');
      expect(fn.rows[0]?.parallel).toBe('s');

      const definition = fn.rows[0]?.definition ?? '';
      // Comments removed before the check: the body explains at length why
      // `array_to_string` is not used, and prose saying so must not read as
      // the thing it describes.
      const body = definition.replace(/--.*$/gm, '');

      // The declaration has to be true rather than convenient. `array_to_string`
      // is STABLE, so a helper that called it and claimed IMMUTABLE would be a
      // promise this code cannot keep — the array is walked instead.
      expect(body.includes('array_to_string'), 'the helper calls a STABLE function').toBe(false);
      expect(body).toContain('pg_catalog.simple');
    });

    it('has a GIN index on the document, under the operator class `@@` needs', async () => {
      const index = await pool.query<{
        method: string;
        column_name: string;
        operator_class: string;
      }>(
        `select am.amname as method, a.attname as column_name, opc.opcname as operator_class
           from pg_index x
           join pg_class i on i.oid = x.indexrelid
           join pg_class t on t.oid = x.indrelid
           join pg_am am on am.oid = i.relam
           join pg_attribute a on a.attrelid = t.oid and a.attnum = x.indkey[0]
           join pg_opclass opc on opc.oid = x.indclass[0]
          where t.relname = 'retrieval_artifacts' and i.relname = $1`,
        [INDEX_NAME],
      );

      // The operator class is the part worth naming. A GIN index on the right
      // column with the wrong one would exist, would look correct in
      // `pg_indexes`, and could not answer a `@@` query.
      expect(index.rows[0]).toEqual({
        method: 'gin',
        column_name: 'search_document',
        operator_class: 'tsvector_ops',
      });
    });

    it('can actually serve the match the search performs', async () => {
      // Asserted on the predicate alone rather than on the whole search, and
      // that is deliberate. Whether the planner *chooses* this index for the
      // full query depends on how many artifacts an owner has: with few rows it
      // will read the primary key and filter, which is correct and fast, and
      // asserting otherwise would be asserting a cost estimate. What must hold
      // regardless of table size is that the index is capable of answering the
      // operator the search uses — if it is not, the search still works and
      // silently degrades to a scan as the corpus grows.
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query('set local enable_seqscan = off');
        const plan = await client.query<{ 'QUERY PLAN': string }>(
          `explain (format text) select ra.problem_id from public.retrieval_artifacts ra
            where ra.search_document @@ websearch_to_tsquery('pg_catalog.simple', $1::text)`,
          ['oauth redirect'],
        );

        const text = plan.rows.map((row) => row['QUERY PLAN']).join('\n');
        expect(text).toContain(INDEX_NAME);
        // No cost, no timing and no row estimate is asserted — only which
        // access path was available.
        expect(text).toContain('Bitmap Index Scan');
      } finally {
        await client.query('rollback');
        client.release();
      }
    });

    it('is the index the search’s own statement is written against', async () => {
      const { FULL_TEXT_SEARCH_STATEMENT } =
        await import('../../src/db/retrieval-full-text-search.js');

      // The failure this catches is silent rather than loud: a statement that
      // recomputed the document inline instead of naming the generated column
      // would return identical results and stop being able to use the index at
      // all. Measured during the investigation at 218 ms against 0.1 ms on
      // twenty thousand rows.
      expect(FULL_TEXT_SEARCH_STATEMENT).toContain('ra.search_document @@');
      expect(FULL_TEXT_SEARCH_STATEMENT).toContain('ts_rank_cd(ra.search_document');
      expect(
        FULL_TEXT_SEARCH_STATEMENT.includes('retrieval_fts_document'),
        'the search rebuilds the document instead of reading the stored one',
      ).toBe(false);
    });
  });

  describe('what the document is made of', () => {
    it('matches a word that appears only in the summary', async () => {
      const seeded = await seed(actor, {
        summary: 'a redirect loops forever behind a proxy',
        keywords: ['unrelated'],
      });

      expect(await found(actor, 'proxy')).toContain(seeded.problemId);
    });

    it('matches a word that appears only in a keyword', async () => {
      const seeded = await seed(actor, {
        summary: 'a summary with nothing notable in it',
        keywords: ['idempotency'],
      });

      expect(await found(actor, 'idempotency')).toContain(seeded.problemId);
    });

    it('ranks a keyword match above the same word buried in a summary', async () => {
      const marker = 'kanbanmarker';
      const inKeyword = await seed(actor, {
        summary: 'a summary about something else entirely with no notable term',
        keywords: [marker],
      });
      const inSummary = await seed(actor, {
        summary: `a summary that mentions ${marker} once in passing among other words`,
        keywords: ['unrelated'],
      });

      const candidates = await actor.search.searchFullText({ text: marker });
      const scoreOf = (problemId: ProblemId): number =>
        candidates.find((candidate) => candidate.problemId === problemId)?.lexicalScore ?? -1;

      expect(candidates.map((candidate) => candidate.problemId)).toEqual(
        expect.arrayContaining([inKeyword.problemId, inSummary.problemId]),
      );
      // The weighting contract: a keyword was chosen deliberately by whatever
      // generated the artifact, and outranks the same word appearing by chance
      // in prose. Compared rather than asserted exactly — these are floats.
      expect(scoreOf(inKeyword.problemId)).toBeGreaterThan(scoreOf(inSummary.problemId));
    });

    it('does not search the Problem’s own title or symptoms', async () => {
      const marker = 'zymurgymarker';
      await seed(actor, {
        title: `a title containing ${marker}`,
        symptoms: `symptoms containing ${marker}`,
        summary: 'a summary that does not contain the marker',
        keywords: ['unrelated'],
      });

      // The artifact is the searchable representation. Indexing the Problem's
      // own text as well would put two definitions of "the searchable text" in
      // the system and route around the translation P4-02 performs.
      expect(await found(actor, marker)).toEqual([]);
    });

    it('does not search the structural features', async () => {
      const marker = 'quixoticmarker';
      await seed(actor, {
        summary: 'a summary that does not contain the marker',
        keywords: ['unrelated'],
        structuralFeatures: { boundary: `a structural label containing ${marker}` },
      });

      // Structural comparison is a later task's, and it compares meaning
      // rather than words. Feeding these labels to a lexical index would make
      // them look like they were already being used.
      expect(await found(actor, marker)).toEqual([]);
    });

    it('keeps technical spellings intact', async () => {
      const seeded = await seed(actor, {
        summary:
          'a Fastify route on Node.js v5.1.2 using @fastify/swagger with client_event_id and foo-bar',
        keywords: ['OAuth', 'PostgreSQL'],
      });

      // The reason the configuration is `simple`. Under `english` — which is
      // this server's default — `Fastify` would be stemmed to `fastifi`.
      for (const term of [
        'Fastify',
        'PostgreSQL',
        'Node.js',
        'OAuth',
        'client_event_id',
        '@fastify/swagger',
        'v5.1.2',
        'foo-bar',
      ]) {
        expect(await found(actor, term), `'${term}' did not match`).toContain(seeded.problemId);
      }
    });

    it('finds a Japanese memory through its keywords', async () => {
      const seeded = await seed(actor, {
        summary: 'デプロイ後だけ認証に失敗する',
        keywords: ['認証', 'デプロイ', '失敗'],
      });

      // PostgreSQL's built-in text search does not segment Japanese, so the
      // summary is one long lexeme and a word inside it is not searchable on
      // its own. Keywords arrive already separated, which recovers the case
      // that matters. Asserted as what does work rather than as what does not,
      // so a future improvement is not a failing test.
      for (const term of ['認証', 'デプロイ', '失敗']) {
        expect(await found(actor, term), `'${term}' did not match`).toContain(seeded.problemId);
      }
    });
  });

  describe('the stored document and the artifact it describes', () => {
    it('follows the artifact when it is regenerated', async () => {
      const seeded = await seed(actor, {
        summary: 'the alphaword appears here',
        keywords: ['alphakeyword'],
      });

      expect(await found(actor, 'alphaword')).toContain(seeded.problemId);
      expect(await found(actor, 'alphakeyword')).toContain(seeded.problemId);

      await actor.artifacts.upsertArtifact({
        problemId: seeded.problemId,
        normalizedSummary: 'the betaword appears here now',
        keywords: ['betakeyword'],
        structuralFeatures: { boundary: 'configuration' },
        summaryGeneratorId: 'fixture-summary-generator',
        summaryGeneratorVersion: '1',
        semantic: {
          embedding: [0.1, 0.2],
          embeddingModel: 'fixture-model',
          embeddingModelVersion: '2',
        },
        sourceFingerprint: `retrieval-source-v1:${randomUUID().replace(/-/g, '')}`,
        generatedAt: new Date('2026-08-16T11:00:00.000Z'),
      });

      // No trigger did this, and no application code recomputed anything: the
      // column is generated, so a replaced artifact is a replaced document.
      expect(await found(actor, 'alphaword')).not.toContain(seeded.problemId);
      expect(await found(actor, 'alphakeyword')).not.toContain(seeded.problemId);
      expect(await found(actor, 'betaword')).toContain(seeded.problemId);
      expect(await found(actor, 'betakeyword')).toContain(seeded.problemId);
    });

    it('does not find a Problem that has no artifact', async () => {
      const project = await actor.memory.createProject({ projectName: 'no artifact' });
      const environment = await actor.memory.createEnvironment({
        projectId: project.projectId,
        snapshot: { runtime: 'node 22.12.0' },
      });
      const problem = await actor.memory.createProblem({
        projectId: project.projectId,
        environmentId: environment.environmentId,
        title: 'a problem about lepidoptera',
        symptoms: 'lepidoptera everywhere',
      });

      // An ordinary state, and today the usual one. Nothing here generates an
      // artifact to satisfy a search — that would turn a read into a write, at
      // the moment somebody is waiting.
      expect(await found(actor, 'lepidoptera')).not.toContain(problem.problemId);
      expect(await found(actor, 'lepidoptera')).toEqual([]);
    });
  });

  describe('who and what is excluded', () => {
    it('never returns another owner’s artifact', async () => {
      const other = await makeActor();
      const marker = 'sharedsearchmarker';
      const mine = await seed(actor, { summary: `mine mentions ${marker}`, keywords: [marker] });
      const theirs = await seed(other, {
        summary: `theirs mentions ${marker}`,
        keywords: [marker],
      });

      expect(await found(actor, marker)).toEqual([mine.problemId]);
      expect(await found(other, marker)).toEqual([theirs.problemId]);
    });

    it('excludes a Problem whose owner turned automatic reading off, without deleting it', async () => {
      const marker = 'readcontrolmarker';
      const seeded = await seed(actor, {
        summary: `a summary mentioning ${marker}`,
        keywords: [marker],
      });
      expect(await found(actor, marker)).toContain(seeded.problemId);

      const problem = await actor.memory.getProblem(seeded.problemId);
      await actor.memory.updateProblem(seeded.problemId, problem?.version ?? 0, {
        memoryReadEnabled: false,
      });

      expect(await found(actor, marker)).not.toContain(seeded.problemId);

      // The row is still there. Turning off automatic reading is not a delete,
      // and the two must not become the same thing — generation already
      // refuses a read-disabled Problem, but a flag flipped *after* the
      // artifact was written leaves the artifact behind.
      const stillStored = await pool.query<{ count: string }>(
        `select count(*)::text as count from public.retrieval_artifacts
          where owner_id = $1 and problem_id = $2`,
        [actor.ownerId, seeded.problemId],
      );
      expect(Number(stillStored.rows[0]?.count)).toBe(1);
      expect(await actor.artifacts.getArtifact(seeded.problemId)).toBeDefined();
    });

    it('still returns a suppressed, invalid, low-confidence Memory', async () => {
      const marker = 'judgementmarker';
      const seeded = await seed(actor, {
        summary: `a summary mentioning ${marker}`,
        keywords: [marker],
      });

      const problem = await actor.memory.getProblem(seeded.problemId);
      await actor.memory.updateProblem(seeded.problemId, problem?.version ?? 0, {
        suppressed: true,
        freshness: 'INVALID',
        confidence: 'LOW',
        importance: false,
      });

      // Being findable and being recommended are different things. Suppression
      // lowers priority, an invalid Memory can still be worth showing as a
      // warning, and confidence is somebody's judgement — all of which belong
      // to whatever presents results. Filtering here would settle those
      // questions quietly and make them impossible to answer properly later.
      expect(await found(actor, marker)).toContain(seeded.problemId);
    });

    it('cannot return an artifact built from a source that has since moved', async () => {
      const marker = 'stalenessmarker';
      const seeded = await seed(actor, {
        summary: `a summary mentioning ${marker}`,
        keywords: [marker],
      });
      expect(await found(actor, marker)).toContain(seeded.problemId);

      await actor.memory.appendEvent({
        problemId: seeded.problemId,
        eventType: 'DEAD_END',
        summary: 'something happened after the artifact was written',
        clientEventId: randomUUID() as never,
      });

      // The append removed the artifact in its own statement, so there is no
      // stale rendering left for this search to find. Nothing here recomputes
      // a fingerprint — that would mean reading every candidate's whole
      // source during a search — and nothing needs to: a rendering of a
      // source that no longer exists is not degraded or demoted, it is
      // absent, and the Problem returns to the results when regeneration
      // writes a current one.
      expect(await found(actor, marker)).not.toContain(seeded.problemId);
    });

    it('never sees an artifact fingerprinted under another source schema', async () => {
      const marker = 'schemagatemarker';
      const seeded = await seed(actor, {
        summary: `a summary mentioning ${marker}`,
        keywords: [marker],
      });
      expect(await found(actor, marker)).toContain(seeded.problemId);

      // A lower-layer write plants what a future deployment would leave
      // behind: a row whose fingerprint names a schema this code no longer
      // writes. The reader's gate — not anything about this row's content —
      // is what keeps it out of the results until regeneration replaces it.
      await pool.query(
        `update public.retrieval_artifacts
            set source_fingerprint = 'retrieval-source-v0:legacy'
          where owner_id = $1 and problem_id = $2`,
        [actor.ownerId, seeded.problemId],
      );

      expect(await found(actor, marker)).not.toContain(seeded.problemId);
    });
  });

  describe('narrowing a search', () => {
    it('searches every Project by default and one when asked', async () => {
      const marker = 'projectfiltermarker';
      const first = await seed(actor, { summary: `first ${marker}`, keywords: [marker] });
      const second = await seed(actor, { summary: `second ${marker}`, keywords: [marker] });

      expect((await found(actor, marker)).sort()).toEqual(
        [first.problemId, second.problemId].sort(),
      );
      expect(await found(actor, marker, { projectId: first.projectId })).toEqual([first.problemId]);
    });

    it('finds nothing for another owner’s Project, and says nothing about it', async () => {
      const other = await makeActor();
      const marker = 'crossprojectmarker';
      await seed(actor, { summary: `mine ${marker}`, keywords: [marker] });
      const theirs = await seed(other, { summary: `theirs ${marker}`, keywords: [marker] });

      // An empty result, not an error and not a different error from an
      // identifier that does not exist at all. A caller cannot learn whether
      // somebody else's Project is real.
      expect(await found(actor, marker, { projectId: theirs.projectId })).toEqual([]);
      expect(await found(actor, marker, { projectId: randomUUID() as ProjectId })).toEqual([]);
    });

    it('leaves out the Problem being worked on, when asked', async () => {
      const marker = 'selfexclusionmarker';
      const current = await seed(actor, { summary: `current ${marker}`, keywords: [marker] });
      const other = await seed(actor, { summary: `other ${marker}`, keywords: [marker] });

      expect((await found(actor, marker)).sort()).toEqual(
        [current.problemId, other.problemId].sort(),
      );
      expect(await found(actor, marker, { excludeProblemId: current.problemId })).toEqual([
        other.problemId,
      ]);
    });
  });

  describe('the shape of an answer', () => {
    it('carries the Problem, its Project and a lexical score, and no owner', async () => {
      const marker = 'shapemarker';
      const seeded = await seed(actor, { summary: `a summary ${marker}`, keywords: [marker] });

      const candidates = await actor.search.searchFullText({ text: marker });
      const candidate = candidates.find((entry) => entry.problemId === seeded.problemId);

      expect(candidate).toBeDefined();
      expect(candidate?.projectId).toBe(seeded.projectId);
      expect(candidate?.lexicalScore).toBeGreaterThan(0);
      // Every candidate belongs to the owner this reader was built for, so
      // returning the owner would be repeating something already settled.
      expect(Object.keys(candidate ?? {}).sort()).toEqual([
        'lexicalScore',
        'problemId',
        'projectId',
      ]);
    });

    it('orders equal matches the same way every time, and truncates in that order', async () => {
      const marker = 'tiebreakmarker';
      const seeded: ProblemId[] = [];
      for (let index = 0; index < 5; index += 1) {
        // Identical text, so every score is the same and only the tie-break
        // decides. Without one, a smaller limit could return a different
        // subset each run — which would also make the results uncacheable.
        seeded.push(
          (await seed(actor, { summary: `identical ${marker} summary`, keywords: [marker] }))
            .problemId,
        );
      }

      const all = await found(actor, marker);
      const relevant = all.filter((problemId) => seeded.includes(problemId));
      expect(relevant).toEqual([...relevant].sort());
      expect(await found(actor, marker)).toEqual(all);

      const limited = await found(actor, marker, { limit: 3 });
      expect(limited).toEqual(all.slice(0, 3));
    });

    it('never returns more than the limit', async () => {
      const marker = 'limitmarker';
      for (let index = 0; index < 4; index += 1) {
        await seed(actor, { summary: `a summary ${marker} ${String(index)}`, keywords: [marker] });
      }

      expect(await found(actor, marker, { limit: 2 })).toHaveLength(2);
      expect((await found(actor, marker, { limit: 50 })).length).toBeGreaterThanOrEqual(4);
    });

    it('returns nothing when a term is absent, rather than dropping it', async () => {
      const marker = 'conjunctionmarker';
      const seeded = await seed(actor, { summary: `a summary ${marker}`, keywords: [marker] });

      expect(await found(actor, marker)).toContain(seeded.problemId);
      // Ordinary terms are joined with AND by the web-search grammar. Handing
      // a whole paragraph to this therefore finds nothing unless every word
      // appears — a real limitation, and one that belongs to whatever composes
      // queries rather than being hidden here by dropping terms.
      expect(await found(actor, `${marker} kubernetes`)).toEqual([]);
    });

    it('accepts awkward query text without a database error', async () => {
      const marker = 'punctuationmarker';
      await seed(actor, { summary: `a summary ${marker}`, keywords: [marker] });

      // `to_tsquery` raises a syntax error on ordinary prose; the web-search
      // grammar does not, which is why it is the one used.
      for (const text of [
        `${marker} OR nothingatall`,
        `"${marker}"`,
        `${marker} -kubernetes`,
        '!!! ??? ***',
        'a & b | c',
        'x=AWS_SECRET_ACCESS_KEY',
      ]) {
        await expect(actor.search.searchFullText({ text })).resolves.toBeInstanceOf(Array);
      }
    });
  });
});
