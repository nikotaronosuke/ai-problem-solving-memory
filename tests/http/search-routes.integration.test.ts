/**
 * The search endpoint end to end: HTTP in, real database out.
 *
 * The unit suite pins the wire contract against a substituted service. This
 * one removes the substitution. Everything below the route is the production
 * composition — `createRetrievalSearchRuntime` over a real pool, the real
 * owner resolution, the real nine readers and eight stage services, the real
 * usage-log writer — so what is under test is the composition itself:
 *
 * **That a server with no configured provider still answers.** Both provider
 * ports are optional, and the route must not depend on either. The lexical
 * channel answers, the semantic channel reports itself unavailable and the
 * structural stage reports its reranker unavailable. Not a 404, not a 503, not
 * an unregistered route — and no outbound request, which is asserted rather
 * than assumed.
 *
 * **That a server with one reaches it exactly as configured.** The provider
 * family is built by the real `createConfiguredRetrievalProviders` from a
 * synthetic key and a fake `fetch`, so the request shape is the production one
 * and the number of live calls is zero by construction.
 *
 * **That the owner boundary holds at the composition, not only at the reader.**
 * Owner scope comes from the authenticated context; a second owner's Memory
 * must be unreachable no matter how similar its content is.
 *
 * **That a search records what it surfaced, once.** N candidates, N usage
 * rows. The route writes nothing itself, and a second write here would double
 * every row invisibly.
 *
 * **That the provider is reached only when there is a search to run.** A
 * Problem that cannot be read, and an owner who turned automatic reading off,
 * are both answered before anything is embedded.
 *
 * Every credential fixture is synthetic. Skipped without `DATABASE_URL`.
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
  createUsageLogService,
  createVerificationService,
} from '../../src/app/index.js';
import { readDatabaseUrl } from '../../src/config/env.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import { generateOwnerId, type OwnerContext, type OwnerId } from '../../src/domain/owner.js';
import { generateProblemId, type ProblemId } from '../../src/domain/problem.js';
import type { ProjectId } from '../../src/domain/project.js';
import type { EmbeddingProvider } from '../../src/domain/retrieval-embedding.js';
import type { StructuralReranker } from '../../src/domain/retrieval-structural-rerank.js';
import {
  STRUCTURAL_FEATURE_SCHEMA_VERSION,
  type StructuralFeatures,
} from '../../src/domain/retrieval-summary.js';
import { buildMemoryHttpApp, createLoggerOptions } from '../../src/http/index.js';
import { resolveOwnerContextFor } from '../../src/owner/context.js';
import { createConfiguredRetrievalProviders } from '../../src/providers/index.js';
import type { FetchLike } from '../../src/providers/openai/index.js';
import {
  createMemoryRepository,
  createRetrievalArtifactRepository,
  type MemoryRepository,
  type RetrievalArtifactRepository,
} from '../../src/repository/index.js';
import { createRetrievalSearchRuntime } from '../../src/runtime/retrieval-search-runtime.js';
import {
  createArtifactInspectionPolicy,
  createSecretDetectionPolicy,
  withSanitization,
} from '../../src/sanitization/index.js';
import { createFixedRequestContextService } from '../support/request-context.js';

const databaseUrl = readDatabaseUrl();

/** Synthetic. Shaped like a key so the config gate accepts it; not one. */
const SYNTHETIC_API_KEY = 'sk-test-p502c-0000000000000000000000000000';

/** What the production embedding provider asks for and validates. */
const EMBEDDING_MODEL = 'text-embedding-3-large';
const EMBEDDING_DIMENSIONS = 1024;

/** The marker every seeded artifact is findable by. */
const MARKER = 'deployment';

/**
 * One vector, used for every artifact and returned for every query.
 *
 * Identical on both sides so the vector channel's distance is zero and the
 * candidates it returns are decided by what exists rather than by how close a
 * fixture happened to land.
 */
const VECTOR = [1, ...Array.from({ length: EMBEDDING_DIMENSIONS - 1 }, () => 0)];

const FEATURES: StructuralFeatures = {
  schema_version: STRUCTURAL_FEATURE_SCHEMA_VERSION,
  problem_domain: MARKER,
  symptom_patterns: ['works locally, fails once deployed'],
  suspected_boundaries: ['configuration read at build time'],
  occurrence_conditions: ['only in the deployed environment'],
  successful_directions: [],
  dead_end_directions: ['raising the timeout'],
  environment_facts: ['node 22.12.0'],
};

const SEARCH_BODY = {
  source_ai: 'fixture-assistant',
  lexical_text: MARKER,
  semantic_text: 'the app works locally but fails once deployed',
  current_features: FEATURES,
};

interface SearchResponse {
  kind: string;
  candidates?: {
    ranking: { problem_id: string; project_id: string; project_relation: string };
  }[];
  semantic_status?: string;
  structural_status?: string;
}

interface Actor {
  readonly ownerId: OwnerId;
  readonly context: OwnerContext;
  readonly memory: MemoryRepository;
  readonly artifacts: RetrievalArtifactRepository;
}

/** How one endpoint answers: a status and a body, or the good answer. */
type EndpointAnswer = { readonly status: number; readonly body: string } | undefined;

/**
 * A `fetch` that answers like the two endpoints the search path uses, and
 * counts.
 *
 * It never opens a socket, which is the point: the provider family under test
 * is the real one, built by the real composition boundary, so the request shape
 * is production's — and the number of calls that leave this process is zero.
 *
 * The rerank answer is derived from the request it is answering. The production
 * reranker invents opaque per-call keys and refuses an answer that omits one,
 * so a fixture with hard-coded keys would test the refusal rather than the
 * path.
 *
 * Either endpoint can be told to answer differently, which is how the failure
 * matrix below is driven: the classification under test happens inside the real
 * transport and the real adapters, so the only honest way to exercise it is to
 * make a real provider response say the wrong thing.
 */
function fakeOpenAi(
  failures: { readonly embeddings?: EndpointAnswer; readonly responses?: EndpointAnswer } = {},
): FetchLike & { paths: string[]; rerankInputs: unknown[] } {
  const paths: string[] = [];
  const rerankInputs: unknown[] = [];

  const fetch = ((input: unknown, init?: { body?: string }) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : String(input);
    paths.push(url);

    const scripted = url.endsWith('/embeddings') ? failures.embeddings : failures.responses;
    if (scripted !== undefined) {
      return Promise.resolve(
        new Response(scripted.body, {
          status: scripted.status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }

    if (url.endsWith('/embeddings')) {
      return Promise.resolve(
        new Response(JSON.stringify({ model: EMBEDDING_MODEL, data: [{ embedding: VECTOR }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }

    const request = JSON.parse(init?.body ?? '{}') as { input?: string };
    const document = JSON.parse(request.input ?? '{}') as { candidates?: { key: string }[] };
    rerankInputs.push(document);
    // Every key back exactly once. The production reranker refuses an answer
    // that omits one, so answering the request rather than a fixed script is
    // what makes this exercise the path instead of the refusal.
    const answer = {
      candidates: (document.candidates ?? []).map((candidate, index) => ({
        candidate: candidate.key,
        structural_score: Math.max(0.1, 1 - index / 10),
        matched_dimensions: ['symptom_patterns'],
      })),
    };
    return Promise.resolve(
      new Response(
        JSON.stringify({
          status: 'completed',
          output: [
            { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(answer) }] },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
  }) as FetchLike & { paths: string[]; rerankInputs: unknown[] };

  fetch.paths = paths;
  fetch.rerankInputs = rerankInputs;
  return fetch;
}

describe.skipIf(databaseUrl === undefined)(
  'POST /v1/problems/:problem_id/search over a database',
  () => {
    let pool: DatabasePool;
    const ownersCreated: OwnerId[] = [];
    const appsCreated: FastifyInstance[] = [];

    beforeAll(() => {
      pool = createPool(resolveDatabaseConfig({ nodeEnv: 'test' }));
    });

    afterAll(async () => {
      for (const app of appsCreated) {
        await app.close();
      }
      if (ownersCreated.length > 0) {
        // Leaf first. Nothing here depends on what a previous run left, and
        // nothing is left for the next one.
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
      };
    }

    /**
     * An app wired exactly as the composition root wires one, for one owner.
     *
     * `fetch` decides whether this deployment has a provider stack: passing one
     * builds the real family from the synthetic key, passing nothing leaves both
     * ports absent — which is the ordinary case for a server without the
     * credential, not a degraded one.
     */
    function makeApp(
      actor: Actor,
      fetch?: FetchLike,
      ports: {
        readonly embeddingProvider?: EmbeddingProvider;
        readonly structuralReranker?: StructuralReranker;
      } = {},
      /** Where the operational log goes, when a test needs to read it. */
      lines?: string[],
    ): FastifyInstance {
      const configured = createConfiguredRetrievalProviders(
        fetch === undefined ? {} : { OPENAI_API_KEY: SYNTHETIC_API_KEY },
        fetch,
      );

      const app = buildMemoryHttpApp({
        retrievalSearchResolver: createRetrievalSearchRuntime({
          pool,
          embeddingProvider:
            ports.embeddingProvider ??
            (configured.enabled ? configured.embeddingProvider : undefined),
          structuralReranker:
            ports.structuralReranker ??
            (configured.enabled ? configured.structuralReranker : undefined),
        }),
        healthService: createHealthService(pool),
        requestContextService: createFixedRequestContextService(pool, actor.ownerId),
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
        logger:
          lines === undefined
            ? false
            : {
                // The production options, so what is swept is what a server
                // would actually write.
                ...createLoggerOptions('trace'),
                stream: {
                  write(line: string) {
                    lines.push(line);
                  },
                },
              },
      });
      appsCreated.push(app);
      return app;
    }

    /** A Problem, findable unless told otherwise. */
    async function seed(
      actor: Actor,
      options: { readonly projectId?: ProjectId; readonly platform?: string } = {},
    ): Promise<{ problemId: ProblemId; projectId: ProjectId }> {
      const projectId =
        options.projectId ??
        (
          await actor.memory.createProject({
            projectName: `project ${randomUUID()}`,
            platform: options.platform ?? 'fixture-platform',
          })
        ).projectId;
      const environment = await actor.memory.createEnvironment({
        projectId,
        snapshot: { runtime: 'node 22.12.0' },
      });
      const problem = await actor.memory.createProblem({
        projectId,
        environmentId: environment.environmentId,
        title: 'a seeded title',
        symptoms: `seeded symptoms about ${MARKER}`,
      });

      await actor.artifacts.upsertArtifact({
        problemId: problem.problemId,
        normalizedSummary: `a summary about ${MARKER}`,
        keywords: [MARKER],
        structuralFeatures: { ...FEATURES },
        summaryGeneratorId: 'fixture-summary-generator',
        summaryGeneratorVersion: '1',
        embedding: VECTOR,
        embeddingModel: EMBEDDING_MODEL,
        embeddingModelVersion: EMBEDDING_MODEL,
        sourceFingerprint: `retrieval-source-v1:${randomUUID().replace(/-/g, '')}`,
        generatedAt: new Date('2026-08-17T09:00:00.000Z'),
      });

      return { problemId: problem.problemId, projectId };
    }

    /**
     * A Problem to search from and two findable neighbours in the same Project.
     *
     * Two rather than one because the rerank stage does not call its model for a
     * single candidate — there is no ordering to buy — so one neighbour would
     * report the structural stage as not needed and prove nothing about it.
     */
    async function seedSearchable(actor: Actor): Promise<{
      current: { problemId: ProblemId; projectId: ProjectId };
      first: { problemId: ProblemId; projectId: ProjectId };
      second: { problemId: ProblemId; projectId: ProjectId };
    }> {
      const current = await seed(actor);
      const first = await seed(actor, { projectId: current.projectId });
      const second = await seed(actor, { projectId: current.projectId });
      return { current, first, second };
    }

    async function search(app: FastifyInstance, problemId: string, body: object = SEARCH_BODY) {
      return await app.inject({
        method: 'POST',
        url: `/v1/problems/${problemId}/search`,
        payload: body,
      });
    }

    async function usageLogsOf(
      ownerId: OwnerId,
    ): Promise<{ problem_id: string; memory_id: string; action: string; source_ai: string }[]> {
      const rows = await pool.query<{
        problem_id: string;
        memory_id: string;
        action: string;
        source_ai: string;
      }>(
        `select problem_id, memory_id, action, source_ai
         from public.usage_logs
        where owner_id = $1
        order by created_at asc, usage_log_id asc`,
        [ownerId],
      );
      return rows.rows;
    }

    describe('with no provider configured', () => {
      it('answers from the lexical channel and names both unavailable channels', async () => {
        const actor = await makeActor();
        const { current, first, second } = await seedSearchable(actor);
        const app = makeApp(actor);

        const response = await search(app, current.problemId);

        expect(response.statusCode).toBe(200);
        const body = response.json<SearchResponse>();
        expect(body.kind).toBe('SEARCHED');
        // The route exists and works. A missing provider is a smaller answer to
        // the same question — never a 404, a 503, or an unregistered route.
        expect(body.semantic_status).toBe('PROVIDER_UNAVAILABLE');
        expect(body.structural_status).toBe('RERANKER_UNAVAILABLE');
        // And it still found things: the lexical half is untouched by any of it.
        const found = (body.candidates ?? []).map((candidate) => candidate.ranking.problem_id);
        expect(found).toContain(first.problemId);
        expect(found).toContain(second.problemId);
        // Never itself: the Problem being worked on is not a memory of itself.
        expect(found).not.toContain(current.problemId);
      });

      it('makes no outbound request at all', async () => {
        const actor = await makeActor();
        const { current } = await seedSearchable(actor);
        const app = makeApp(actor);

        const original = globalThis.fetch;
        let calls = 0;
        globalThis.fetch = () => {
          calls += 1;
          return Promise.reject(new Error('no outbound request may be made'));
        };
        try {
          const response = await search(app, current.problemId);
          expect(response.statusCode).toBe(200);
        } finally {
          globalThis.fetch = original;
        }

        // Not "no request to a provider" — no request. With no port configured
        // there is nothing constructed that could make one, and the platform
        // fetch is the thing that would show it if there were.
        expect(calls).toBe(0);
      });

      it('still gives every candidate the material to judge it', async () => {
        const actor = await makeActor();
        const { current } = await seedSearchable(actor);
        const app = makeApp(actor);

        const body = (await search(app, current.problemId)).json<{
          candidates: {
            ranking: { structural_score: number | null; hybrid_rank: number };
            revalidation: { required_checks: string[] };
            dead_end_warnings: unknown[];
            successful_directions: unknown[];
            conflict: { subject: unknown; contradictions: unknown[] };
          }[];
        }>();

        for (const candidate of body.candidates) {
          // No reranker ran, so there is no score — reported as absent, not as a
          // zero somebody could read as "structurally unlike".
          expect(candidate.ranking.structural_score).toBeNull();
          expect(candidate.ranking.hybrid_rank).toBeGreaterThanOrEqual(1);
          // The rest of the material does not depend on a provider at all.
          expect(candidate.revalidation.required_checks).toHaveLength(4);
          expect(Array.isArray(candidate.dead_end_warnings)).toBe(true);
          expect(candidate.conflict.subject).toBeDefined();
        }
      });
    });

    describe('with a provider configured', () => {
      it('uses both channels, reaching only the configured endpoints', async () => {
        const actor = await makeActor();
        const { current, first, second } = await seedSearchable(actor);
        const fetch = fakeOpenAi();
        const app = makeApp(actor, fetch);

        const response = await search(app, current.problemId);

        expect(response.statusCode).toBe(200);
        const body = response.json<SearchResponse>();
        expect(body.semantic_status).toBe('USED');
        expect(body.structural_status).toBe('USED');
        const found = (body.candidates ?? []).map((candidate) => candidate.ranking.problem_id);
        expect(found).toContain(first.problemId);
        expect(found).toContain(second.problemId);
        // One host, the published one, and nothing else — asserted on what the
        // real transport actually asked for.
        for (const path of fetch.paths) {
          expect(path.startsWith('https://api.openai.com/v1/')).toBe(true);
        }
        expect(fetch.paths.some((path) => path.endsWith('/embeddings'))).toBe(true);
        expect(fetch.paths.some((path) => path.endsWith('/responses'))).toBe(true);
      });

      it('scores what it reranked, without publishing anything about the provider', async () => {
        const actor = await makeActor();
        const { current } = await seedSearchable(actor);
        const app = makeApp(actor, fakeOpenAi());

        const response = await search(app, current.problemId);
        const raw = response.body;

        const body = response.json<{
          candidates: { ranking: { structural_score: number | null } }[];
        }>();
        expect(
          body.candidates.every((candidate) => candidate.ranking.structural_score !== null),
        ).toBe(true);
        // A caller learns that the structural channel was used. It does not learn
        // which model used it, or that anything was cached: neither is a fact
        // about the memory it asked for.
        expect(raw.includes(EMBEDDING_MODEL)).toBe(false);
        expect(raw.includes('openai')).toBe(false);
        expect(raw.includes('cache')).toBe(false);
      });

      it('reuses the expensive work across two searches, and across two callers', async () => {
        const actor = await makeActor();
        const { current } = await seedSearchable(actor);
        const fetch = fakeOpenAi();
        const app = makeApp(actor, fetch);

        await search(app, current.problemId);
        const afterFirst = fetch.paths.length;
        // Same question, different caller name. `source_ai` is attribution and
        // must not reach the cache key — if it did, every assistant would pay
        // for the same embedding and the same rerank separately.
        const second = await search(app, current.problemId, {
          ...SEARCH_BODY,
          source_ai: 'a-different-assistant',
        });

        expect(second.statusCode).toBe(200);
        expect(second.json<SearchResponse>().semantic_status).toBe('USED');
        expect(fetch.paths.length).toBe(afterFirst);
      });

      it('fails a search whose reranker answered unusably, rather than quietly halving it', async () => {
        const actor = await makeActor();
        const { current } = await seedSearchable(actor);
        // A port that answers, in a shape nobody can read. Vendor-neutral and
        // test-only: production contains no object whose purpose is to fail.
        const app = makeApp(actor, undefined, {
          structuralReranker: {
            rerank: () => Promise.resolve({ candidates: 'not a list' }),
          },
        });

        const response = await search(app, current.problemId);

        // Answering unusably is a fault, and a different one from not being
        // configured. Reporting it as `RERANKER_UNAVAILABLE` with a lexical-only
        // result would make a broken integration indistinguishable from a
        // deliberate deployment choice, for as long as it stayed broken.
        expect(response.statusCode).toBe(500);
        expect(response.json<{ error: { code: string } }>().error.code).toBe('INTERNAL_ERROR');
        // And the failure says nothing about what answered or how.
        expect(response.body.includes('candidates')).toBe(false);
      });

      it('fails a search whose embedding port answered unusably', async () => {
        const actor = await makeActor();
        const { current } = await seedSearchable(actor);
        const app = makeApp(actor, undefined, {
          embeddingProvider: {
            modelId: 'fixture-embedding-model',
            modelVersion: '1',
            dimensions: EMBEDDING_DIMENSIONS,
            // Right shape, wrong width. A vector of another dimension is not a
            // point in the space the artifacts were embedded in.
            embed: () => Promise.resolve([1, 0, 0]),
          },
        });

        const response = await search(app, current.problemId);

        expect(response.statusCode).toBe(500);
        expect(response.json<{ error: { code: string } }>().error.code).toBe('INTERNAL_ERROR');
      });
    });

    describe('when the provider fails', () => {
      /**
       * The formal-review finding, as a matrix.
       *
       * Every row goes through the real transport and the real adapter, because
       * the classification being tested lives there — a hand-built port throwing a
       * hand-built error would prove the stage services branch correctly and
       * nothing about whether production produces the right branch.
       *
       * The line is not "did it fail" but "can waiting fix it". A rate limit and a
       * server error can; a body this system cannot read, and a request the
       * provider refused, cannot — and reporting those two as a quiet channel is
       * exactly how a broken integration stays broken behind an answer that looks
       * complete.
       */
      it('fails the search when the embedding answer is unusable', async () => {
        const actor = await makeActor();
        const { current } = await seedSearchable(actor);
        const app = makeApp(
          actor,
          // HTTP 200, and a body that is not the document. This is the case that
          // used to come back as a lexical-only 200 with the semantic channel
          // reported unavailable.
          fakeOpenAi({ embeddings: { status: 200, body: JSON.stringify({ data: 'nonsense' }) } }),
        );

        const response = await search(app, current.problemId);

        expect(response.statusCode).toBe(500);
        expect(response.json<{ error: { code: string } }>().error.code).toBe('INTERNAL_ERROR');
        // Emphatically not a 200 carrying a channel status: a broken integration
        // must not be able to hide inside an ordinary answer.
        expect(response.body.includes('semantic_status')).toBe(false);
        expect(response.body.includes('PROVIDER_UNAVAILABLE')).toBe(false);
      });

      it('fails the search when the embedding is right-shaped but the wrong width', async () => {
        const actor = await makeActor();
        const { current } = await seedSearchable(actor);
        const app = makeApp(
          actor,
          fakeOpenAi({
            embeddings: {
              status: 200,
              body: JSON.stringify({ model: EMBEDDING_MODEL, data: [{ embedding: [1, 0, 0] }] }),
            },
          }),
        );

        // A vector of another width is not a point in the space the artifacts
        // were embedded in. The adapter knows that; the stage above must not
        // translate the knowledge into "the provider was quiet".
        expect((await search(app, current.problemId)).statusCode).toBe(500);
      });

      it('fails the search when the reranker answer is unusable', async () => {
        const actor = await makeActor();
        const { current } = await seedSearchable(actor);
        const app = makeApp(
          actor,
          fakeOpenAi({
            responses: { status: 200, body: JSON.stringify({ status: 'completed', output: {} }) },
          }),
        );

        const response = await search(app, current.problemId);

        expect(response.statusCode).toBe(500);
        expect(response.body.includes('RERANKER_UNAVAILABLE')).toBe(false);
      });

      it.each([[429], [500], [503]])(
        'degrades the semantic channel when the embedding endpoint answers %i',
        async (status) => {
          const actor = await makeActor();
          const { current, first } = await seedSearchable(actor);
          const app = makeApp(actor, fakeOpenAi({ embeddings: { status, body: '{}' } }));

          const response = await search(app, current.problemId);

          // Temporarily unable to answer. The lexical half is a real answer, and
          // the status says which half is missing.
          expect(response.statusCode).toBe(200);
          const body = response.json<SearchResponse>();
          expect(body.kind).toBe('SEARCHED');
          expect(body.semantic_status).toBe('PROVIDER_UNAVAILABLE');
          expect((body.candidates ?? []).map((c) => c.ranking.problem_id)).toContain(
            first.problemId,
          );
        },
      );

      it.each([[400], [401], [403], [404]])(
        'fails the search when the embedding endpoint refuses the request with %i',
        async (status) => {
          const actor = await makeActor();
          const { current } = await seedSearchable(actor);
          const app = makeApp(
            actor,
            fakeOpenAi({
              embeddings: {
                status,
                body: JSON.stringify({
                  error: { message: 'Incorrect API key provided: sk-live-x' },
                }),
              },
            }),
          );

          const response = await search(app, current.problemId);

          // A rejected credential is an operator's problem, not a quiet channel
          // and not the caller's fault — and never a 400, because the caller's
          // search had no part in it.
          expect(response.statusCode).toBe(500);
          expect(response.json<{ error: { code: string } }>().error.code).toBe('INTERNAL_ERROR');
        },
      );

      it.each([[429], [500]])(
        'degrades the structural stage when the rerank endpoint answers %i',
        async (status) => {
          const actor = await makeActor();
          const { current } = await seedSearchable(actor);
          const app = makeApp(actor, fakeOpenAi({ responses: { status, body: '{}' } }));

          const response = await search(app, current.problemId);

          expect(response.statusCode).toBe(200);
          const body = response.json<SearchResponse>();
          // The semantic half still ran: one endpoint failing does not take the
          // other with it.
          expect(body.semantic_status).toBe('USED');
          expect(body.structural_status).toBe('RERANKER_UNAVAILABLE');
        },
      );

      it.each([[400], [401], [404]])(
        'fails the search when the rerank endpoint refuses the request with %i',
        async (status) => {
          const actor = await makeActor();
          const { current } = await seedSearchable(actor);
          const app = makeApp(actor, fakeOpenAi({ responses: { status, body: '{}' } }));

          expect((await search(app, current.problemId)).statusCode).toBe(500);
        },
      );

      it('says nothing about the provider in the response or the log', async () => {
        const actor = await makeActor();
        const { current } = await seedSearchable(actor);
        const lines: string[] = [];
        const app = makeApp(
          actor,
          fakeOpenAi({
            embeddings: {
              status: 401,
              body: JSON.stringify({
                error: {
                  message: 'Incorrect API key provided: sk-live-leak-marker',
                  type: 'invalid_request_error',
                  code: 'invalid_api_key',
                },
              }),
            },
          }),
          {},
          lines,
        );

        const response = await search(app, current.problemId);
        expect(response.statusCode).toBe(500);

        // Everything an operator gets is the closed failure word and a request
        // id. The upstream body quoted a credential back at us; the request that
        // produced it carried somebody's Memory and the real key.
        const written = `${response.body} ${lines.join('\n')}`;
        for (const forbidden of [
          'sk-live-leak-marker',
          'Incorrect API key',
          'invalid_api_key',
          'invalid_request_error',
          'api.openai.com',
          'openai',
          'text-embedding',
          // The upstream status, in every shape it could be written. Not the
          // bare number: a millisecond timestamp and a UUID both contain digit
          // runs, and a sweep that fails on those is a sweep nobody can keep.
          '"status":401',
          '"statusCode":401',
          'status=401',
          SEARCH_BODY.lexical_text,
          SEARCH_BODY.semantic_text,
          'symptom_patterns',
        ]) {
          expect(`${forbidden} leaked:${written.includes(forbidden)}`).toBe(
            `${forbidden} leaked:false`,
          );
        }
        // And what the log does say is the closed pair the policy allows.
        expect(lines.some((line) => line.includes('UNHANDLED_REQUEST_FAILURE'))).toBe(true);
        expect(lines.some((line) => line.includes('"failure":"UNEXPECTED"'))).toBe(true);
      });
    });

    describe('what a search may reach', () => {
      it('searches every Project the owner has, and says how each relates', async () => {
        const actor = await makeActor();
        const current = await seed(actor);
        const sameProject = await seed(actor, { projectId: current.projectId });
        // A different Project on the same platform, and one on another.
        const sameTech = await seed(actor, { platform: 'fixture-platform' });
        const otherTech = await seed(actor, { platform: 'another-platform' });
        const app = makeApp(actor);

        const body = (await search(app, current.problemId)).json<SearchResponse>();

        const relations = new Map(
          (body.candidates ?? []).map((candidate) => [
            candidate.ranking.problem_id,
            candidate.ranking.project_relation,
          ]),
        );
        // Cross-project by default and without being asked: the whole point of
        // the memory is that a problem solved in one project is worth reading in
        // another.
        expect(relations.get(sameProject.problemId)).toBe('CURRENT_PROJECT');
        expect(relations.get(sameTech.problemId)).toBe('SAME_TECH_OTHER_PROJECT');
        expect(relations.get(otherTech.problemId)).toBe('OTHER_TECH');
      });

      it('cannot reach another owner’s Memory, however alike it is', async () => {
        const mine = await makeActor();
        const theirs = await makeActor();
        const current = await seed(mine);
        // Deliberately identical content: if isolation depended on the query
        // rather than on the owner, this is the fixture that would find it.
        const theirProblem = await seed(theirs);
        const app = makeApp(mine);

        const body = (await search(app, current.problemId)).json<SearchResponse>();

        const found = (body.candidates ?? []).map((candidate) => candidate.ranking.problem_id);
        expect(found).not.toContain(theirProblem.problemId);
        // And the reverse direction is a 404 rather than a refusal, because
        // "not yours" and "not there" are one answer.
        expect((await search(app, theirProblem.problemId)).statusCode).toBe(404);
      });
    });

    describe('what a search records', () => {
      it('records one row per candidate, and not one per stage', async () => {
        const actor = await makeActor();
        const { current, first, second } = await seedSearchable(actor);
        const app = makeApp(actor);

        const body = (await search(app, current.problemId)).json<SearchResponse>();
        const logs = await usageLogsOf(actor.ownerId);

        expect(body.candidates?.length).toBe(2);
        // Exactly N. The route writes nothing itself — the search service records
        // what it surfaced — and a second writer here would double every row
        // without changing a single response.
        expect(logs).toHaveLength(2);
        expect(logs.map((log) => log.memory_id).sort()).toEqual(
          [first.problemId, second.problemId].sort(),
        );
        // Recorded against the Problem being worked on, attributed to the caller
        // that asked.
        expect(new Set(logs.map((log) => log.problem_id))).toEqual(new Set([current.problemId]));
        expect(new Set(logs.map((log) => log.source_ai))).toEqual(new Set(['fixture-assistant']));
        expect(new Set(logs.map((log) => log.action))).toEqual(new Set(['SEARCHED']));
      });

      it('attributes each search to the caller that made it', async () => {
        const actor = await makeActor();
        const { current } = await seedSearchable(actor);
        const app = makeApp(actor);

        await search(app, current.problemId);
        await search(app, current.problemId, { ...SEARCH_BODY, source_ai: 'another-assistant' });
        const logs = await usageLogsOf(actor.ownerId);

        // Four rows, two callers. `source_ai` changes nothing about what is found
        // and everything about who is recorded as having read it.
        expect(logs).toHaveLength(4);
        expect(new Set(logs.map((log) => log.source_ai))).toEqual(
          new Set(['fixture-assistant', 'another-assistant']),
        );
      });

      it('records nothing when there was nothing to surface', async () => {
        const actor = await makeActor();
        // No neighbours at all: a Problem on its own.
        const current = await seed(actor);
        const app = makeApp(actor);

        const body = (await search(app, current.problemId)).json<SearchResponse>();

        expect(body.kind).toBe('SEARCHED');
        expect(body.candidates).toEqual([]);
        expect(await usageLogsOf(actor.ownerId)).toEqual([]);
      });
    });

    describe('what happens before a provider is reached', () => {
      it('answers a Problem it cannot read with a 404 and no outbound call', async () => {
        const actor = await makeActor();
        await seedSearchable(actor);
        const fetch = fakeOpenAi();
        const app = makeApp(actor, fetch);

        const response = await search(app, generateProblemId());

        expect(response.statusCode).toBe(404);
        // The Problem is read first for a reason: everything after it is
        // expensive, and a search for a Problem that is not there has nothing to
        // be about.
        expect(fetch.paths).toEqual([]);
      });

      it('respects an owner turning reading off before embedding anything', async () => {
        const actor = await makeActor();
        const { current } = await seedSearchable(actor);
        const fetch = fakeOpenAi();
        const app = makeApp(actor, fetch);
        // Turned off through the published surface, so the setting under test is
        // the one an owner can actually reach.
        const disabled = await app.inject({
          method: 'PATCH',
          url: `/v1/problems/${current.problemId}/memory-control`,
          payload: { expected_version: 1, changed_by: 'fixture', memory_read_enabled: false },
        });
        expect(disabled.statusCode).toBe(200);

        const response = await search(app, current.problemId);

        // A 200 carrying the setting, not an error: the server was asked not to
        // read, and it did not. And it did not pay a provider to find that out.
        expect(response.statusCode).toBe(200);
        expect(response.json<SearchResponse>()).toEqual({ kind: 'MEMORY_READ_DISABLED' });
        expect(fetch.paths).toEqual([]);
      });

      it('refuses a malformed request without resolving an owner or a provider', async () => {
        const actor = await makeActor();
        const { current } = await seedSearchable(actor);
        const fetch = fakeOpenAi();
        const app = makeApp(actor, fetch);

        const response = await search(app, current.problemId, {
          ...SEARCH_BODY,
          current_features: { schema_version: STRUCTURAL_FEATURE_SCHEMA_VERSION },
        });

        expect(response.statusCode).toBe(400);
        expect(fetch.paths).toEqual([]);
      });
    });
  },
);
