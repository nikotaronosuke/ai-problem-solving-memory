/**
 * Phase 4, end to end.
 *
 * One investigation is carried from the moment it is written down in Project A
 * to the moment it comes back as a candidate while somebody works on a
 * different technology in Project B — in order, on one state, with nothing in
 * the middle seeded ready-made.
 *
 * What this proves is not that any stage works. Each has its own suite, with a
 * depth this file deliberately does not repeat, and the evaluation corpus in
 * `retrieval-evaluation.integration.test.ts` already showed each scenario
 * discriminates. What this proves is that the stages **connect**: the Problem
 * the HTTP API creates is the Problem the summary generator reads; the summary
 * it writes is the text the embedding is computed from; the artifact that lands
 * is the row both retrieval channels find; the candidate the reranker scores is
 * the candidate the ranking orders; and the Memory finally offered carries the
 * conditions, the warnings, the directions and the disagreement that were
 * recorded about it, a Project and a technology away.
 *
 * That continuity is the one thing a per-stage test cannot check, and it is
 * Phase 4's definition of done.
 *
 * **The canonical history is written over a real socket**, through the same
 * HTTP application the server composes in production. **The artifacts are
 * generated through the production generation service** — never upserted
 * directly, because the step from a Memory to its search rendering is exactly
 * what this file exists to prove. The only substitutions are the three ports
 * Phase 4 deliberately left open: a summary generator, an embedding provider
 * and a structural reranker. Each is deterministic, each reads only what
 * production hands it, and none of them ever sees a Problem identifier.
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
  createRetrievalArtifactGenerationService,
  createRetrievalConflictService,
  createRetrievalDeadEndService,
  createRetrievalHybridSearchService,
  createRetrievalRankingService,
  createRetrievalRevalidationService,
  createRetrievalSearchCache,
  createRetrievalSearchService,
  createRetrievalStructuralRerankService,
  createRetrievalSuccessfulDirectionService,
  createRetrievalSummaryService,
  createRetrievalUsageLogWriter,
  createRetrievalVectorSearchService,
  createUsageLogService,
  createVerificationService,
  REVALIDATION_CHECKS,
  type RetrievalSearchOutcome,
  type RetrievalSummaryGenerator,
  type RetrievalSummaryGeneratorInput,
  type RetrievalUsageLogFailure,
  type RetrievalUsageLogFailureReporter,
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
import { generateClientId, type ClientId } from '../../src/domain/client.js';
import {
  formatCredentialToken,
  generateCredentialId,
  generateCredentialToken,
  hashCredentialSecret,
} from '../../src/domain/credential.js';
import { generateOwnerId, type OwnerContext, type OwnerId } from '../../src/domain/owner.js';
import type { ProblemId } from '../../src/domain/problem.js';
import { toEmbedding } from '../../src/domain/retrieval-artifact.js';
import type { EmbeddingProvider } from '../../src/domain/retrieval-embedding.js';
import { resolveVectorSearchQuery } from '../../src/domain/retrieval-search.js';
import type { StructuralFeatures } from '../../src/domain/retrieval-summary.js';
import { buildMemoryHttpApp, createLoggerOptions } from '../../src/http/index.js';
import { resolveOwnerContextFor } from '../../src/owner/context.js';
import {
  createMemoryRepository,
  createRetrievalArtifactRepository,
  createRetrievalConflictReader,
  createRetrievalDeadEndReader,
  createRetrievalRankingReader,
  createRetrievalRevalidationReader,
  createRetrievalSearchReader,
  createRetrievalStructuralReader,
  createRetrievalSuccessfulDirectionReader,
  createRetrievalSummarySourceReader,
  createRetrievalVectorSearchReader,
} from '../../src/repository/index.js';
import {
  createArtifactInspectionPolicy,
  createSecretDetectionPolicy,
  withSanitization,
} from '../../src/sanitization/index.js';
import {
  createFixtureStructuralOracle,
  SEMANTIC_CLASSES,
} from '../retrieval/fixtures/retrieval-evaluation-corpus.js';
import { createUnusedSearchResolver } from '../support/search-resolver.js';

const databaseUrl = readDatabaseUrl();

/** Children before parents: every foreign key in the schema is RESTRICT. */
const MEMORY_TABLES = [
  'retrieval_artifacts',
  'change_logs',
  'usage_logs',
  'relations',
  'verifications',
  'events',
  'problems',
  'environments',
  'projects',
] as const;

const MODEL = { id: 'phase4-e2e-embedding-model', version: '1', dimensions: 3 } as const;

/**
 * The wording somebody used when they recorded the fix.
 *
 * Deliberately different from what the generator later says worked. A `FIX`
 * Event records that a fix was *tried*; nothing links it to the Verification
 * that later passed, so it never travels as a successful direction. Keeping the
 * two texts distinct is how this file proves that.
 */
const FIX_EVENT_WORDING = 'moved the configuration lookup out of the packaging step';

/**
 * What the generator concludes, having read the whole history.
 *
 * These phrases are the evaluation corpus's own vocabulary, so the structural
 * oracle recognises them as the same concepts Project B describes in different
 * words. That is the point being carried: two technologies, two vocabularies,
 * one structure.
 */
const DERIVED_DIRECTION =
  'resolve the value when the request arrives rather than when the image is assembled';
const DERIVED_DEAD_END = 'giving the packaging step more time';
const DERIVED_SYMPTOM = 'works locally but blank once deployed';
const DERIVED_BOUNDARY = 'settings frozen before the runtime starts';
const DERIVED_CONDITION = 'only after promotion to a hosted tier';

/** What somebody recorded as a dead end, in their own words. */
const DEAD_END_WORDING = 'raised the packaging timeout and rebuilt three times';

/** Why the two Memories were recorded as contradicting each other. */
const CONFLICT_REASON =
  'one concluded the value was captured too early, the other that the proxy rewrote it in flight';

describe.skipIf(databaseUrl === undefined)('Phase 4, end to end', { sequential: true }, () => {
  let pool: DatabasePool;
  let app: FastifyInstance | undefined;
  let baseUrl = '';
  const ownersCreated: OwnerId[] = [];

  let ownerId: OwnerId;
  let ownerContext: OwnerContext;
  let clientId: ClientId;
  let token = '';

  // ---- the cast -----------------------------------------------------------

  /** Project A: where the problem was solved. */
  let projectAId = '';
  let problemAId = '';

  /** The Memory recorded as contradicting A, and a second searchable Memory. */
  let problemCId = '';

  /** Project B: a different technology, where the trouble happens again. */
  let projectBId = '';
  let problemBId = '';

  /** What the canonical record looked like before any artifact existed. */
  let canonicalBefore = '';
  /** And again once Project B exists, which is the baseline the search must not move. */
  let canonicalBeforeSearch = '';

  /** The one search this file's claims are read from. */
  let outcome: RetrievalSearchOutcome | undefined;

  const environmentA = {
    runtime: 'node 20.11.0',
    framework: 'react 18.2.0',
    deployment: 'container image',
  };
  const environmentB = {
    runtime: 'python 3.11.6',
    framework: 'django 4.2.0',
    deployment: 'platform buildpack',
  };
  const environmentC = {
    runtime: 'node 18.19.0',
    framework: 'react 17.0.2',
    deployment: 'edge worker',
  };

  // ---- the three ports Phase 4 left open ---------------------------------

  /**
   * A summary generator that reads the canonical document and nothing else.
   *
   * Every claim it makes is derived from what it finds there — including the
   * one claim the production gate will refuse if the record does not support
   * it. It never sees an identifier, so it cannot recognise which Problem it is
   * summarising, and the two Memories it is asked about get different answers
   * only because their histories differ.
   */
  function summaryGenerator(): RetrievalSummaryGenerator & { calls: number; seen: string[] } {
    const state = {
      generatorId: 'phase4-e2e-summary-generator',
      generatorVersion: '1',
      calls: 0,
      seen: [] as string[],
      generate(input: RetrievalSummaryGeneratorInput): Promise<unknown> {
        state.calls += 1;
        state.seen.push(input.source);
        const document = JSON.parse(input.source) as {
          problem: { symptoms: string; problem_domain: string | null };
          environment: Record<string, unknown>;
          events: { event_type: string; summary: string }[];
          verifications: { result: boolean }[];
        };
        const framework = document.environment['framework'];

        // The one claim with a rule behind it. A successful direction is stated
        // only when the history shows a check that actually passed — and the
        // production gate refuses the whole draft if it claims one the record
        // does not support.
        const confirmed = document.verifications.some((check) => check.result);
        const features: StructuralFeatures = {
          schema_version: '1',
          problem_domain: document.problem.problem_domain,
          symptom_patterns: [DERIVED_SYMPTOM],
          suspected_boundaries: [DERIVED_BOUNDARY],
          occurrence_conditions: [DERIVED_CONDITION],
          successful_directions: confirmed ? [DERIVED_DIRECTION] : [],
          dead_end_directions: document.events.some((event) => event.event_type === 'DEAD_END')
            ? [DERIVED_DEAD_END]
            : [],
          environment_facts: [typeof framework === 'string' ? framework : 'unknown'],
        };

        return Promise.resolve({
          normalizedSummary: `a setting fixed too early leaves the shipped build wrong: ${document.problem.symptoms}`,
          keywords: ['configuration', 'shipped', 'wrong'],
          structuralFeatures: features,
        });
      },
    };
    return state;
  }

  /** An embedding provider that sees the generated summary and nothing else. */
  function embeddingProvider(): EmbeddingProvider & { calls: number; seen: string[] } {
    const state = {
      modelId: MODEL.id,
      modelVersion: MODEL.version,
      dimensions: MODEL.dimensions,
      calls: 0,
      seen: [] as string[],
      embed(input: { readonly text: string }): Promise<readonly number[]> {
        state.calls += 1;
        state.seen.push(input.text);
        // Everything in this story is about a value decided at the wrong
        // moment, so everything lands on one subject.
        return Promise.resolve([...SEMANTIC_CLASSES.CONFIGURATION_LIFECYCLE]);
      },
    };
    return state;
  }

  const oracle = createFixtureStructuralOracle();
  const generator = summaryGenerator();
  const embedding = embeddingProvider();

  function silentReporter(): RetrievalUsageLogFailureReporter & {
    failures: RetrievalUsageLogFailure[];
  } {
    const failures: RetrievalUsageLogFailure[] = [];
    return {
      failures,
      report: (failure) => {
        failures.push(failure);
      },
    };
  }

  // ---- machinery ----------------------------------------------------------

  function build(): FastifyInstance {
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
      logger: { ...createLoggerOptions('silent'), stream: { write() {} } },
    });
  }

  async function request(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    payload?: unknown,
  ): Promise<{ status: number; body: string }> {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    return { status: response.status, body: await response.text() };
  }

  async function post(path: string, payload: unknown): Promise<Record<string, unknown>> {
    const response = await request('POST', path, payload);
    expect(response.status, `${path} -> ${response.body}`).toBe(201);
    return JSON.parse(response.body) as Record<string, unknown>;
  }

  const versionOf = async (problemId: string): Promise<number> => {
    const response = await request('GET', `/v1/problems/${problemId}`);
    return Number((JSON.parse(response.body) as { version: number }).version);
  };

  /**
   * Everything a person recorded, as one string.
   *
   * The derived artifact is left out because it is not a person's record, and
   * the usage log is left out because a search legitimately writes one — that
   * is asserted on its own terms further down. What remains is exactly the
   * material that must not move when a search runs.
   */
  async function canonicalSweep(): Promise<string> {
    const dumps: string[] = [];
    for (const table of MEMORY_TABLES.filter(
      (name) => name !== 'retrieval_artifacts' && name !== 'usage_logs',
    )) {
      const rows = await pool.query(
        `select to_jsonb(t) as row from public.${table} t
          where owner_id = $1
          order by to_jsonb(t)::text`,
        [ownerId],
      );
      dumps.push(`${table}:${JSON.stringify(rows.rows)}`);
    }
    return dumps.join('\n');
  }

  /** The production generation path, composed exactly as production does. */
  function generationService() {
    return createRetrievalArtifactGenerationService(
      createRetrievalSummaryService(
        createRetrievalSummarySourceReader(pool, ownerContext),
        generator,
      ),
      embedding,
      createTransactionRunner(pool),
      ownerContext,
    );
  }

  /** The whole retrieval path, composed exactly as production does. */
  function searchService() {
    const memory = withSanitization(
      createMemoryRepository(pool, ownerContext),
      createSecretDetectionPolicy(),
    );
    const artifacts = withSanitization(
      createRetrievalArtifactRepository(pool, ownerContext),
      createArtifactInspectionPolicy(),
    );
    const runner = createTransactionRunner(pool);
    return createRetrievalSearchService(
      createRetrievalSummarySourceReader(pool, ownerContext),
      createRetrievalHybridSearchService(
        createRetrievalSearchReader(pool, ownerContext),
        createRetrievalVectorSearchService(
          embedding,
          createRetrievalVectorSearchReader(pool, ownerContext),
        ),
      ),
      createRetrievalStructuralRerankService(
        createRetrievalStructuralReader(pool, ownerContext),
        oracle,
      ),
      createRetrievalRankingService(createRetrievalRankingReader(pool, ownerContext)),
      createRetrievalRevalidationService(createRetrievalRevalidationReader(pool, ownerContext)),
      createRetrievalDeadEndService(createRetrievalDeadEndReader(pool, ownerContext)),
      createRetrievalSuccessfulDirectionService(
        createRetrievalSuccessfulDirectionReader(pool, ownerContext),
      ),
      createRetrievalConflictService(createRetrievalConflictReader(pool, ownerContext)),
      createRetrievalSearchCache(),
      createRetrievalUsageLogWriter({
        clientId,
        repository: memory,
        retrievalArtifacts: artifacts,
        runInTransaction: (work) =>
          runner.run((transactional) =>
            work(
              withSanitization(
                createMemoryRepository(transactional, ownerContext),
                createSecretDetectionPolicy(),
              ),
            ),
          ),
      }),
      silentReporter(),
    );
  }

  /** The Memory the search offered for Project A, if it offered one. */
  const offeredA = () => {
    if (outcome === undefined || outcome.kind !== 'SEARCHED') {
      throw new Error('The search has not run.');
    }
    return outcome.candidates.find(
      (candidate) => String(candidate.ranking.problemId) === problemAId,
    );
  };

  beforeAll(async () => {
    pool = createPool(resolveDatabaseConfig({ nodeEnv: 'test', connectionTimeoutMillis: 5_000 }));

    ownerId = generateOwnerId();
    await insertOwnerIfAbsent(pool, ownerId);
    ownersCreated.push(ownerId);
    ownerContext = await resolveOwnerContextFor(pool, ownerId);

    clientId = generateClientId();
    const credential = generateCredentialToken();
    await createCredentialRepository(pool).issueClientCredential({
      clientId,
      ownerId,
      label: 'phase 4 e2e client',
      credentialId: generateCredentialId(),
      tokenLookup: credential.lookup,
      tokenHash: hashCredentialSecret(credential.secret),
    });
    token = formatCredentialToken(credential);

    app = build();
    baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  }, 60_000);

  afterAll(async () => {
    if (app !== undefined) {
      await app.close();
    }
    if (ownersCreated.length > 0) {
      for (const table of MEMORY_TABLES) {
        await pool.query(`delete from public.${table} where owner_id = any($1::uuid[])`, [
          ownersCreated,
        ]);
      }
      await pool.query(
        `delete from public.client_credentials where client_id in
           (select client_id from public.clients where owner_id = any($1::uuid[]))`,
        [ownersCreated],
      );
      await pool.query(`delete from public.clients where owner_id = any($1::uuid[])`, [
        ownersCreated,
      ]);
      await pool.query(`delete from public.owners where owner_id = any($1::uuid[])`, [
        ownersCreated,
      ]);
    }
    await closePool(pool);
  });

  // ---- the investigation is written down, over HTTP -----------------------

  it('1. records the Project A investigation through the ordinary API', async () => {
    const project = await post('/v1/projects', {
      project_name: `phase4-a-${randomUUID()}`,
      platform: 'react',
    });
    projectAId = String(project['project_id']);

    const environment = await post(`/v1/projects/${projectAId}/environments`, {
      snapshot: environmentA,
    });
    const problem = await post(`/v1/projects/${projectAId}/problems`, {
      environment_id: String(environment['environment_id']),
      title: 'the shipped build renders a blank checkout page',
      symptoms: 'correct locally, blank once shipped to the hosted tier',
      problem_domain: 'deployment',
      suspected_boundary: 'a value decided before the process starts',
    });
    problemAId = String(problem['problem_id']);

    expect(problemAId).not.toBe('');
  });

  it('2. records the whole history: hypothesis, attempt, dead end, discovery, fix', async () => {
    const events = [
      { event_type: 'HYPOTHESIS', summary: 'the hosted tier may be serving a stale bundle' },
      { event_type: 'ATTEMPT', summary: 'invalidated the edge cache and shipped again' },
      {
        event_type: 'DEAD_END',
        summary: DEAD_END_WORDING,
        result: 'the page was still blank after every rebuild',
        reason: 'the packaging step was never the slow part',
      },
      { event_type: 'DISCOVERY', summary: 'the setting is read once while the image is assembled' },
      { event_type: 'FIX', summary: FIX_EVENT_WORDING },
    ];

    for (const event of events) {
      await post(`/v1/problems/${problemAId}/events`, {
        ...event,
        client_event_id: randomUUID(),
      });
    }

    const listed = await request('GET', `/v1/problems/${problemAId}/events`);
    expect(listed.status).toBe(200);
    const body = JSON.parse(listed.body) as { events: { event_type: string }[] };
    expect(body.events.map((event) => event.event_type)).toEqual([
      'HYPOTHESIS',
      'ATTEMPT',
      'DEAD_END',
      'DISCOVERY',
      'FIX',
    ]);
  });

  it('3. records a check that actually passed, and concludes the Problem', async () => {
    await post(`/v1/problems/${problemAId}/verifications`, {
      verification_type: 'BUILD',
      result: true,
      summary: 'the shipped build renders the checkout page on the hosted tier',
      client_event_id: randomUUID(),
    });

    // A Problem reaches `VERIFIED` through `FIX_CANDIDATE`; nothing jumps
    // straight there from an active investigation.
    const proposed = await request('POST', `/v1/problems/${problemAId}/status-transitions`, {
      target_status: 'FIX_CANDIDATE',
      expected_version: await versionOf(problemAId),
      changed_by: 'phase4-e2e-assistant',
    });
    expect(proposed.status, proposed.body).toBe(200);

    const closed = await request('POST', `/v1/problems/${problemAId}/close`, {
      expected_version: await versionOf(problemAId),
      changed_by: 'phase4-e2e-assistant',
      target_status: 'VERIFIED',
      fix_kind: 'ROOT_FIX',
    });
    expect(closed.status, closed.body).toBe(200);

    const problem = await request('GET', `/v1/problems/${problemAId}`);
    const body = JSON.parse(problem.body) as { status: string; fix_kind: string };
    expect(body.status).toBe('VERIFIED');
    expect(body.fix_kind).toBe('ROOT_FIX');
  });

  it('4. records a second Memory, and that the two contradict each other', async () => {
    const environment = await post(`/v1/projects/${projectAId}/environments`, {
      snapshot: environmentC,
    });
    const problem = await post(`/v1/projects/${projectAId}/problems`, {
      environment_id: String(environment['environment_id']),
      title: 'the checkout page is blank for returning visitors only',
      symptoms: 'blank only for visitors who had loaded the page earlier that day',
      problem_domain: 'deployment',
      suspected_boundary: 'a proxy rewrote the response in flight',
    });
    problemCId = String(problem['problem_id']);

    // A check that did not confirm anything. It leaves this Memory outside the
    // evidence gate, which is what makes the two answers below differ.
    await post(`/v1/problems/${problemCId}/verifications`, {
      verification_type: 'REAL_DEVICE',
      result: false,
      summary: 'the value was still correct when it left the origin',
      client_event_id: randomUUID(),
    });

    await post(`/v1/problems/${problemAId}/relations`, {
      to_id: problemCId,
      relation_type: 'CONTRADICTS',
      reason: CONFLICT_REASON,
    });

    canonicalBefore = await canonicalSweep();
    expect(canonicalBefore.includes(CONFLICT_REASON)).toBe(true);
  });

  // ---- the Memory becomes searchable, through production ------------------

  it('5. generates both search artifacts through the production path', async () => {
    const before = { generator: generator.calls, embedding: embedding.calls };

    for (const problemId of [problemAId, problemCId]) {
      const result = await generationService().generateArtifact(problemId as ProblemId);
      expect(result.kind, JSON.stringify(result)).toBe('STORED');
    }

    // The generator read, and the provider embedded, once per Memory. Nothing
    // in this file writes an artifact any other way — the step from a Memory to
    // its search rendering is what is being proved.
    expect(generator.calls).toBe(before.generator + 2);
    expect(embedding.calls).toBe(before.embedding + 2);
  });

  it('6. hands the generator the canonical history and no identifier', () => {
    const source = generator.seen.at(-2) ?? '';
    const document = JSON.parse(source) as Record<string, unknown>;

    expect(Object.keys(document).sort()).toEqual([
      'environment',
      'events',
      'problem',
      'schema_version',
      'verifications',
    ]);
    expect(source).toContain(DEAD_END_WORDING);
    expect(source).toContain(FIX_EVENT_WORDING);
    expect(source).toContain('react 18.2.0');
    expect(source.includes(problemAId), 'the generator was given the Problem id').toBe(false);
    expect(source.includes(projectAId), 'the generator was given the Project id').toBe(false);
    expect(source.includes(ownerId), 'the generator was given the owner id').toBe(false);

    // The embedding was computed from the summary that was stored, not from the
    // canonical document.
    expect(embedding.seen.at(-1)).toContain('a setting fixed too early');
  });

  it('7. applied the evidence gate while generating, from the record alone', async () => {
    const artifacts = await pool.query<{ problem_id: string; structural_features: unknown }>(
      `select problem_id, structural_features from public.retrieval_artifacts
        where owner_id = $1`,
      [ownerId],
    );
    const byProblem = new Map(
      artifacts.rows.map((row) => [
        row.problem_id,
        row.structural_features as { successful_directions: string[] },
      ]),
    );

    // One Memory is verified by a check that passed and the other is not, and
    // only the first is allowed to name a direction that worked. Neither
    // generator call knew which Problem it was reading.
    expect(byProblem.get(problemAId)?.successful_directions).toEqual([DERIVED_DIRECTION]);
    expect(byProblem.get(problemCId)?.successful_directions).toEqual([]);
  });

  it('8. leaves the canonical Memory exactly as it was', async () => {
    expect(await canonicalSweep()).toBe(canonicalBefore);

    const artifacts = await pool.query<{ n: string }>(
      'select count(*) as n from public.retrieval_artifacts where owner_id = $1',
      [ownerId],
    );
    // Two derived rows exist beside a canonical record that did not move.
    expect(Number(artifacts.rows[0]?.n)).toBe(2);
  });

  // ---- a different Project, a different technology ------------------------

  it('9. records an unrelated Project B investigation', async () => {
    const project = await post('/v1/projects', {
      project_name: `phase4-b-${randomUUID()}`,
      platform: 'django',
    });
    projectBId = String(project['project_id']);

    const environment = await post(`/v1/projects/${projectBId}/environments`, {
      snapshot: environmentB,
    });
    const problem = await post(`/v1/projects/${projectBId}/problems`, {
      environment_id: String(environment['environment_id']),
      title: 'the administrative dashboard shows empty panels after promotion',
      symptoms: 'fine on a developer machine, empty panels once promoted',
      problem_domain: 'release',
      suspected_boundary: 'configuration captured during build',
    });
    problemBId = String(problem['problem_id']);

    expect(projectBId).not.toBe(projectAId);

    // A fresh baseline: Project B is itself a canonical write, so the claim
    // below is about what the *search* moves, not about what recording a new
    // Problem moves.
    canonicalBeforeSearch = await canonicalSweep();
  });

  it('10. finds the Project A Memory from the other Project', async () => {
    const before = { embedding: embedding.calls, oracle: oracle.calls };
    outcome = await searchService().search(
      {
        currentProblemId: problemBId as ProblemId,
        // Three words, all of them in the stored keywords. The text
        // configuration is `simple` — no stemming and no stop words — so every
        // token of a query has to match something.
        lexicalText: 'shipped configuration wrong',
        semanticText: 'a value decided too early leaves the deployed build wrong',
        // Project B's own understanding, in Project B's vocabulary. Not one
        // phrase is shared with what the generator wrote about Project A.
        currentFeatures: {
          schema_version: '1',
          problem_domain: 'release',
          symptom_patterns: ['fine on a developer machine, empty panels once promoted'],
          suspected_boundaries: ['configuration captured during build'],
          occurrence_conditions: ['only in the deployed environment'],
          successful_directions: ['read the setting at request time instead of at build time'],
          dead_end_directions: ['raising the build timeout'],
          environment_facts: ['django 4.2.0'],
        },
      },
      { sourceAi: 'phase4-e2e-assistant' },
    );

    expect(outcome.kind, JSON.stringify(outcome)).toBe('SEARCHED');
    if (outcome.kind !== 'SEARCHED') {
      return;
    }

    expect(embedding.calls).toBe(before.embedding + 1);
    expect(oracle.calls).toBe(before.oracle + 1);
    expect(outcome.semanticStatus).toBe('USED');
    expect(outcome.candidates.length).toBeGreaterThanOrEqual(1);
    expect(outcome.candidates.length).toBeLessThanOrEqual(5);
    expect(offeredA()).toBeDefined();
    expect(offeredA()?.ranking.projectRelation).toBe('OTHER_TECH');
  });

  it('11. reached it by keyword and by meaning, and judged it on structure', async () => {
    // Both channels are asked of the same stored artifacts, read-only, so the
    // two halves of the hybrid step are observable without the search response
    // having to carry raw ranks it has no other reason to expose.
    const lexical = await createRetrievalSearchReader(pool, ownerContext).searchFullText({
      text: 'shipped configuration wrong',
      limit: 20,
    });
    const semantic = await createRetrievalVectorSearchReader(pool, ownerContext).searchByVector(
      {
        embedding: toEmbedding([...SEMANTIC_CLASSES.CONFIGURATION_LIFECYCLE]),
        embeddingModel: MODEL.id,
        embeddingModelVersion: MODEL.version,
        dimensions: MODEL.dimensions,
      },
      resolveVectorSearchQuery({ text: 'the vector decides this one', limit: 20 }),
    );

    expect(lexical.map((candidate) => String(candidate.problemId))).toContain(problemAId);
    expect(semantic.map((candidate) => String(candidate.problemId))).toContain(problemAId);

    // And the structural judgement was made on the profile the generator wrote,
    // in words Project B never used.
    const seen = oracle.seen.at(-1);
    const judged = seen?.candidates.find((entry) => String(entry.problemId) === problemAId);
    expect(judged?.features.successful_directions).toEqual([DERIVED_DIRECTION]);
    expect(judged?.features.dead_end_directions).toEqual([DERIVED_DEAD_END]);
    expect(seen?.current.suspected_boundaries).toEqual(['configuration captured during build']);
    expect(judged?.features.suspected_boundaries).toEqual([DERIVED_BOUNDARY]);

    expect(offeredA()?.ranking.structuralScore).not.toBeNull();
    expect(offeredA()?.ranking.matchedDimensions.length).toBeGreaterThan(2);
  });

  // ---- what the answer carries -------------------------------------------

  it('12. offers the direction the record supports, in the generator’s words', () => {
    expect(offeredA()?.successfulDirections).toEqual([DERIVED_DIRECTION]);

    // And never the FIX Event's own wording. A recorded fix is not a verified
    // one: nothing links that Event to the check that passed, so it does not
    // travel as something that worked.
    expect(JSON.stringify(offeredA()).includes(FIX_EVENT_WORDING)).toBe(false);
  });

  it('13. warns with the dead end exactly as somebody wrote it', () => {
    const warnings = offeredA()?.deadEndWarnings ?? [];

    expect(warnings.map((warning) => warning.summary)).toEqual([DEAD_END_WORDING]);
    expect(warnings[0]?.reason).toBe('the packaging step was never the slow part');
    // The artifact's paraphrase of the same dead end is comparison material and
    // stays out of the warning. The two sources are different on purpose.
    expect(JSON.stringify(warnings).includes(DERIVED_DEAD_END)).toBe(false);
    for (const prohibition of ['retryBlocked', 'forbidden', 'hardBlock']) {
      expect(JSON.stringify(offeredA()).includes(prohibition)).toBe(false);
    }
  });

  it('14. says what was recorded as contradicting it, and picks no winner', () => {
    const contradiction = offeredA()?.conflict.contradictions[0];

    expect(contradiction?.reason).toBe(CONFLICT_REASON);
    expect(String(contradiction?.other.problemId)).toBe(problemCId);
    expect(contradiction?.other.historicalEnvironment).toEqual(environmentC);
    expect(contradiction?.other.evidence.map((entry) => entry.result)).toEqual([false]);
    expect(offeredA()?.conflict.subject.symptoms).toBe(
      'correct locally, blank once shipped to the hosted tier',
    );
    for (const verdict of ['winner', 'preferred', 'resolved']) {
      expect(JSON.stringify(offeredA()?.conflict).includes(verdict)).toBe(false);
    }
  });

  it('15. says what it was true of, and what to re-establish', () => {
    const revalidation = offeredA()?.revalidation;

    expect(revalidation?.historicalEnvironment).toEqual(environmentA);
    expect(revalidation?.evidence.map((entry) => entry.result)).toEqual([true]);
    expect(revalidation?.requiredChecks).toEqual([...REVALIDATION_CHECKS]);

    // The conditions on the two sides differ, and the server says so by handing
    // the historical ones over — not by deciding which is current. Actually
    // re-checking the running code, environment, version and specification is
    // the adapter's work, and nothing here pretends to have done it.
    expect(environmentA.framework).not.toBe(environmentB.framework);
    expect(JSON.stringify(offeredA()).includes('django 4.2.0')).toBe(false);
  });

  it('16. offers nothing as successful for the Memory that was never confirmed', () => {
    if (outcome === undefined || outcome.kind !== 'SEARCHED') {
      throw new Error('The search has not run.');
    }
    const offeredC = outcome.candidates.find(
      (candidate) => String(candidate.ranking.problemId) === problemCId,
    );

    // It came back — it is a perfectly good candidate — and it carries no
    // direction, because its only check failed. Two Memories, one gate, two
    // answers, in one search.
    expect(offeredC).toBeDefined();
    expect(offeredC?.successfulDirections).toEqual([]);
  });

  it('17. records that it offered the Memory, and nothing about what it said', async () => {
    const logs = await pool.query<{ memory_id: string; action: string; reason: string }>(
      `select memory_id, action, reason from public.usage_logs
        where owner_id = $1 and problem_id = $2`,
      [ownerId, problemBId],
    );

    expect(logs.rows.map((row) => row.memory_id)).toContain(problemAId);
    expect(logs.rows.every((row) => row.action === 'SEARCHED')).toBe(true);
    for (const row of logs.rows) {
      expect(row.reason.includes(DERIVED_DIRECTION)).toBe(false);
      expect(row.reason.includes(DEAD_END_WORDING)).toBe(false);
      expect(row.reason.includes(CONFLICT_REASON)).toBe(false);
    }
  });

  it('18. never offers the Problem being worked on', () => {
    if (outcome === undefined || outcome.kind !== 'SEARCHED') {
      throw new Error('The search has not run.');
    }
    expect(
      outcome.candidates.some((candidate) => String(candidate.ranking.problemId) === problemBId),
    ).toBe(false);
  });

  it('19. leaves the canonical Memory untouched by the whole search', async () => {
    // Generation ran, retrieval ran, a usage log was written — and everything a
    // person recorded is exactly as they left it.
    expect(await canonicalSweep()).toBe(canonicalBeforeSearch);
  });
});
