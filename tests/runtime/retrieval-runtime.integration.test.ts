/**
 * The production maintenance path, end to end: a canonical HTTP write, the
 * doorbell, an owner-scoped generation through the real OpenAI adapters, and
 * a stored artifact — with the network faked and nothing else.
 *
 * This is the composition `src/index.ts` performs, assembled here piece by
 * piece so a test can see into it: real PostgreSQL, real credential
 * authentication, real write services ringing a real runtime, the production
 * provider adapters behind a scripted fetch. What is being proven is that
 * the pieces impl-1 and impl-2a certified separately actually meet — and
 * that the meeting respects every boundary they were certified with.
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
import { generateOwnerId, type OwnerContext, type OwnerId } from '../../src/domain/owner.js';
import { buildMemoryHttpApp, createLoggerOptions } from '../../src/http/index.js';
import { resolveOwnerContextFor } from '../../src/owner/context.js';
import { createConfiguredRetrievalProviders } from '../../src/providers/index.js';
import { OPENAI_EMBEDDING_DIMENSIONS, type FetchLike } from '../../src/providers/openai/index.js';
import {
  createRetrievalArtifactRepository,
  type RetrievalArtifactRepository,
} from '../../src/repository/index.js';
import { listOwnerIdsWithReadableProblems } from '../../src/db/owner-discovery.js';
import {
  createRetrievalRuntime,
  type RetrievalRuntime,
} from '../../src/runtime/retrieval-runtime.js';
import { createArtifactInspectionPolicy, withSanitization } from '../../src/sanitization/index.js';
import { createUnusedSearchResolver } from '../support/search-resolver.js';

const databaseUrl = process.env['DATABASE_URL'];
const API_KEY = 'sk-test-000000000000000000000000000000000000';

/** A summary document the domain accepts, marked so tests can find it. */
function summaryDocument(marker: string) {
  return {
    normalizedSummary: `a rendering mentioning ${marker}`,
    keywords: [marker],
    structuralFeatures: {
      schema_version: '1',
      problem_domain: null,
      symptom_patterns: [`symptoms of ${marker}`],
      suspected_boundaries: [],
      occurrence_conditions: [],
      successful_directions: [],
      dead_end_directions: [],
      environment_facts: [],
    },
  };
}

const VECTOR = Array.from({ length: OPENAI_EMBEDDING_DIMENSIONS }, (_, index) => 1 / (index + 2));

/**
 * A scripted OpenAI. Answers the two maintenance endpoints, records every
 * request, and can be told to fail.
 */
function fakeOpenAi() {
  const state = {
    failing: false,
    summaryBodies: [] as string[],
    embeddingBodies: [] as string[],
  };

  const fetch: FetchLike = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === 'string' ? init.body : '';
    if (state.failing) {
      return Promise.resolve(new Response('{"error":{}}', { status: 500 }));
    }
    if (url.endsWith('/responses')) {
      state.summaryBodies.push(body);
      const request = JSON.parse(body) as { input: string };
      // The marker rides inside the canonical source (the Problem title);
      // echoing it back makes each artifact traceable to its request.
      const marker = /marker-[a-z0-9]+/.exec(request.input)?.[0] ?? 'unmarked';
      return Promise.resolve(
        new Response(
          JSON.stringify({
            status: 'completed',
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: JSON.stringify(summaryDocument(marker)) }],
              },
            ],
          }),
          { status: 200 },
        ),
      );
    }
    if (url.endsWith('/embeddings')) {
      state.embeddingBodies.push(body);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            object: 'list',
            data: [{ object: 'embedding', index: 0, embedding: VECTOR }],
            model: 'text-embedding-3-large',
            usage: { prompt_tokens: 1, total_tokens: 1 },
          }),
          { status: 200 },
        ),
      );
    }
    return Promise.resolve(new Response('{"error":{}}', { status: 404 }));
  };

  return { fetch, state };
}

interface Actor {
  readonly ownerId: OwnerId;
  readonly context: OwnerContext;
  readonly token: string;
  readonly artifacts: RetrievalArtifactRepository;
}

describe.skipIf(databaseUrl === undefined)('the production retrieval runtime', () => {
  let pool: DatabasePool;
  let app: FastifyInstance;
  let runtime: RetrievalRuntime;
  let openai: ReturnType<typeof fakeOpenAi>;
  const ownersCreated: OwnerId[] = [];

  async function makeActor(): Promise<Actor> {
    const ownerId = generateOwnerId();
    await insertOwnerIfAbsent(pool, ownerId);
    ownersCreated.push(ownerId);
    const context = await resolveOwnerContextFor(pool, ownerId);

    const credential = generateCredentialToken();
    await createCredentialRepository(pool).issueClientCredential({
      clientId: generateClientId(),
      ownerId,
      label: 'runtime integration client',
      credentialId: generateCredentialId(),
      tokenLookup: credential.lookup,
      tokenHash: hashCredentialSecret(credential.secret),
    });

    return {
      ownerId,
      context,
      token: formatCredentialToken(credential),
      artifacts: withSanitization(
        createRetrievalArtifactRepository(pool, context),
        createArtifactInspectionPolicy(),
      ),
    };
  }

  beforeAll(async () => {
    pool = createPool(resolveDatabaseConfig({ nodeEnv: 'test', connectionTimeoutMillis: 5_000 }));
    openai = fakeOpenAi();

    // The exact composition src/index.ts performs, with the fetch injected.
    const configured = createConfiguredRetrievalProviders(
      { OPENAI_API_KEY: API_KEY },
      openai.fetch,
    );
    expect(configured.enabled).toBe(true);
    if (!configured.enabled) {
      throw new Error('unreachable');
    }
    runtime = createRetrievalRuntime({
      pool,
      providers: {
        summaryGenerator: configured.summaryGenerator,
        embeddingProvider: configured.embeddingProvider,
        generationProfile: configured.generationProfile,
      },
      // Scoped to this file's owners: the database is shared with every
      // other suite in the run, and an unscoped sweep would write artifacts
      // into their fixtures mid-flight. Production keeps the default —
      // discover everyone — and the db primitive has its own test below.
      discoverOwners: () => Promise.resolve([...ownersCreated]),
    });
    const maintenance = runtime.maintenance;

    app = buildMemoryHttpApp({
      retrievalSearchResolver: createUnusedSearchResolver(),
      healthService: createHealthService(pool),
      requestContextService: createRequestContextService(
        pool,
        createTransactionRunner(pool),
        createCredentialAuthenticator(createCredentialRepository(pool)),
      ),
      projectEnvironmentService: createProjectEnvironmentService(),
      problemService: createProblemService(maintenance),
      problemStatusService: createProblemStatusService(maintenance),
      eventService: createEventService(maintenance),
      verificationService: createVerificationService(maintenance),
      relationService: createRelationService(),
      usageLogService: createUsageLogService(),
      changeLogService: createChangeLogService(),
      memoryControlService: createMemoryControlService(),
      problemCloseService: createProblemCloseService(maintenance),
      problemDeleteService: createProblemDeleteService(),
      exportService: createExportService(),
      logger: { ...createLoggerOptions('silent'), stream: { write() {} } },
    });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    runtime.stop();
    await app.close();
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
      ]) {
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

  async function post(actor: Actor, path: string, body: unknown): Promise<Record<string, unknown>> {
    const response = await app.inject({
      method: 'POST',
      url: path,
      headers: { authorization: `Bearer ${actor.token}` },
      payload: body as never,
    });
    expect(response.statusCode).toBeLessThan(300);
    return JSON.parse(response.body) as Record<string, unknown>;
  }

  /** A Problem created over real HTTP, carrying a findable marker. */
  async function makeProblem(actor: Actor, marker: string): Promise<string> {
    const project = await post(actor, '/v1/projects', {
      project_name: `runtime-${randomUUID()}`,
    });
    const environment = await post(
      actor,
      `/v1/projects/${String(project['project_id'])}/environments`,
      {
        snapshot: { runtime: 'node 22.12.0' },
      },
    );
    const problem = await post(actor, `/v1/projects/${String(project['project_id'])}/problems`, {
      environment_id: environment['environment_id'],
      title: `a problem about ${marker}`,
      symptoms: `symptoms of ${marker}`,
    });
    return String(problem['problem_id']);
  }

  it('turns a canonical HTTP write into a stored artifact through the doorbell', async () => {
    const actor = await makeActor();
    const marker = `marker-${randomUUID().slice(0, 8)}`;
    const before = openai.state.summaryBodies.length;

    const problemId = await makeProblem(actor, marker);
    await runtime.settled();

    const artifact = await actor.artifacts.getArtifact(problemId as never);
    expect(artifact).toBeDefined();
    expect(artifact?.normalizedSummary).toBe(`a rendering mentioning ${marker}`);
    expect(artifact?.summaryGeneratorId).toBe('openai-responses:gpt-5.6-terra');
    expect(artifact?.semantic?.embeddingModel).toBe('text-embedding-3-large');
    expect(artifact?.sourceFingerprint.startsWith('retrieval-source-v1:')).toBe(true);

    // The provider saw the canonical source — and only the canonical source:
    // no owner, no problem id, no credential in any request body.
    const sent = openai.state.summaryBodies.slice(before).join('');
    expect(sent.includes(marker)).toBe(true);
    expect(sent.includes(actor.ownerId)).toBe(false);
    expect(sent.includes(problemId)).toBe(false);
    expect(sent.includes(API_KEY)).toBe(false);
  });

  it('keeps a canonical write successful when the provider is down, and recovers by sweep', async () => {
    const actor = await makeActor();
    const marker = `marker-${randomUUID().slice(0, 8)}`;

    openai.state.failing = true;
    // The write succeeds — and the provider failure costs the enhancement,
    // never the artifact: the deterministic rendering stands in immediately,
    // under its own honest identity and with no vector.
    const problemId = await makeProblem(actor, marker);
    await runtime.settled();
    const during = await actor.artifacts.getArtifact(problemId as never);
    expect(during?.summaryGeneratorId).toBe('deterministic');
    expect(during?.semantic).toBeNull();
    expect(during?.normalizedSummary).toContain(marker);

    // The provider recovers; the periodic sweep is the upgrade policy — the
    // deterministic row fails the semantic profile's embedding expectations
    // and is regenerated richer.
    openai.state.failing = false;
    await runtime.sweep();
    await runtime.settled();

    const artifact = await actor.artifacts.getArtifact(problemId as never);
    expect(artifact).toBeDefined();
    expect(artifact?.normalizedSummary).toBe(`a rendering mentioning ${marker}`);
    expect(artifact?.semantic).not.toBeNull();
  });

  it('backfills existing Problems for every owner, without a manual step', async () => {
    const actorA = await makeActor();
    const actorB = await makeActor();
    const markerA = `marker-${randomUUID().slice(0, 8)}`;
    const markerB = `marker-${randomUUID().slice(0, 8)}`;

    // Two owners' Problems land while the provider is down: the store is
    // full of Problems and empty of their artifacts — the impl-2 cold start.
    openai.state.failing = true;
    const problemA = await makeProblem(actorA, markerA);
    const problemB = await makeProblem(actorB, markerB);
    await runtime.settled();
    openai.state.failing = false;

    // One sweep — what start() fires at startup — finds both owners and
    // renders both, each through its own owner-scoped stack.
    await runtime.sweep();
    await runtime.settled();

    const artifactA = await actorA.artifacts.getArtifact(problemA as never);
    const artifactB = await actorB.artifacts.getArtifact(problemB as never);
    expect(artifactA?.normalizedSummary).toBe(`a rendering mentioning ${markerA}`);
    expect(artifactB?.normalizedSummary).toBe(`a rendering mentioning ${markerB}`);

    // Cross-owner isolation, measured at the wire: A's renderings never
    // carry B's marker and vice versa.
    const everything = openai.state.summaryBodies.join('');
    expect(everything.includes(actorA.ownerId)).toBe(false);
    expect(everything.includes(actorB.ownerId)).toBe(false);
    expect(artifactA?.normalizedSummary.includes(markerB)).toBe(false);
    expect(artifactB?.normalizedSummary.includes(markerA)).toBe(false);
  });

  it('does nothing at all when everything is current', async () => {
    const actor = await makeActor();
    const marker = `marker-${randomUUID().slice(0, 8)}`;
    const problemId = await makeProblem(actor, marker);
    await runtime.settled();
    expect(await actor.artifacts.getArtifact(problemId as never)).toBeDefined();

    // The cost guard, in the production composition: a sweep over an
    // up-to-date store makes zero provider calls, however often it runs.
    const summaryCalls = openai.state.summaryBodies.length;
    const embeddingCalls = openai.state.embeddingBodies.length;
    await runtime.sweep();
    await runtime.settled();
    await runtime.sweep();
    await runtime.settled();

    expect(openai.state.summaryBodies.length).toBe(summaryCalls);
    expect(openai.state.embeddingBodies.length).toBe(embeddingCalls);
  });

  it('refreshes an artifact from an outdated generation stack, replacement not deletion', async () => {
    const actor = await makeActor();
    const marker = `marker-${randomUUID().slice(0, 8)}`;
    const problemId = await makeProblem(actor, marker);
    await runtime.settled();

    // Age the artifact: another generator's work, still current-source.
    await pool.query(
      `update public.retrieval_artifacts
          set summary_generator_id = 'a-previous-generator'
        where owner_id = $1 and problem_id = $2`,
      [actor.ownerId, problemId],
    );
    // Soft-outdated stays readable until regeneration replaces it.
    expect(await actor.artifacts.getArtifact(problemId as never)).toBeDefined();

    await runtime.sweep();
    await runtime.settled();

    const refreshed = await actor.artifacts.getArtifact(problemId as never);
    expect(refreshed?.summaryGeneratorId).toBe('openai-responses:gpt-5.6-terra');
  });

  it('regenerates an artifact from an incompatible source schema', async () => {
    const actor = await makeActor();
    const marker = `marker-${randomUUID().slice(0, 8)}`;
    const problemId = await makeProblem(actor, marker);
    await runtime.settled();

    await pool.query(
      `update public.retrieval_artifacts
          set source_fingerprint = 'retrieval-source-v0:legacy'
        where owner_id = $1 and problem_id = $2`,
      [actor.ownerId, problemId],
    );

    await runtime.sweep();
    await runtime.settled();

    const regenerated = await actor.artifacts.getArtifact(problemId as never);
    expect(regenerated?.sourceFingerprint.startsWith('retrieval-source-v1:')).toBe(true);
  });

  it('never sends a read-disabled Problem to the provider', async () => {
    const actor = await makeActor();
    const marker = `marker-${randomUUID().slice(0, 8)}`;

    openai.state.failing = true;
    const problemId = await makeProblem(actor, marker);
    await runtime.settled();
    openai.state.failing = false;

    // Reading is turned off before any rendering existed.
    const stored = await pool.query<{ version: number }>(
      `select version from public.problems where owner_id = $1 and problem_id = $2`,
      [actor.ownerId, problemId],
    );
    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/problems/${problemId}`,
      headers: { authorization: `Bearer ${actor.token}` },
      payload: {
        expected_version: stored.rows[0]?.version,
        changed_by: 'runtime-test',
        memory_read_enabled: false,
      },
    });
    expect(patch.statusCode).toBeLessThan(300);

    const before = openai.state.summaryBodies.length;
    await runtime.sweep();
    await runtime.settled();

    // The provider never saw it, and nothing regenerated it: the
    // deterministic stand-in from before the toggle is exactly as it was —
    // never upgraded — and every artifact-backed search statement excludes a
    // read-disabled Problem's row at the query itself.
    expect(openai.state.summaryBodies.length).toBe(before);
    const artifact = await actor.artifacts.getArtifact(problemId as never);
    expect(artifact?.summaryGeneratorId).toBe('deterministic');
    expect(artifact?.semantic).toBeNull();
  });

  it('leaves a failed write without a doorbell and without a provider call', async () => {
    const actor = await makeActor();
    const marker = `marker-${randomUUID().slice(0, 8)}`;
    const problemId = await makeProblem(actor, marker);
    await runtime.settled();
    const before = openai.state.summaryBodies.length;

    // A version-conflicted transition writes nothing.
    const refused = await app.inject({
      method: 'POST',
      url: `/v1/problems/${problemId}/status`,
      headers: { authorization: `Bearer ${actor.token}` },
      payload: { target_status: 'FIX_CANDIDATE', expected_version: 999, changed_by: 'x' },
    });
    expect(refused.statusCode).toBeGreaterThanOrEqual(400);

    await runtime.settled();
    expect(openai.state.summaryBodies.length).toBe(before);
  });

  it('discovers owners by identifier only, and only while they have readable Problems', async () => {
    const actor = await makeActor();
    const marker = `marker-${randomUUID().slice(0, 8)}`;
    const problemId = await makeProblem(actor, marker);
    await runtime.settled();

    // Membership rather than an exact set: the database is shared, and the
    // primitive's answer legitimately includes every suite's owners.
    const discovered = await listOwnerIdsWithReadableProblems(pool);
    expect(discovered).toContain(actor.ownerId);
    // Identifiers only — the row shape is the whole payload.
    expect(discovered.every((entry) => typeof entry === 'string')).toBe(true);

    const stored = await pool.query<{ version: number }>(
      `select version from public.problems where owner_id = $1 and problem_id = $2`,
      [actor.ownerId, problemId],
    );
    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/problems/${problemId}`,
      headers: { authorization: `Bearer ${actor.token}` },
      payload: {
        expected_version: stored.rows[0]?.version,
        changed_by: 'runtime-test',
        memory_read_enabled: false,
      },
    });
    expect(patch.statusCode).toBeLessThan(300);

    // The only readable Problem is now read-disabled, so the owner drops out.
    expect(await listOwnerIdsWithReadableProblems(pool)).not.toContain(actor.ownerId);
  });

  it('keeps /health answering from the database, whatever the provider does', async () => {
    openai.state.failing = true;
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    openai.state.failing = false;
  });
});
