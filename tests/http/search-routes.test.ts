/**
 * The search request and response contract, driven through `inject()`.
 *
 * The resolver and the service behind it are substituted, so what is under test
 * is transport: which requests never reach the pipeline, what exactly is handed
 * to it when they do, how the four outcomes become responses, and whether the
 * candidate material survives the mapping without loss.
 *
 * The substitution is not a stand-in provider — production has none. It is a
 * recorder: it captures the request and the invocation and returns a prepared
 * outcome, which is how the "four fields in, four fields through" claim can be
 * asserted rather than described.
 *
 * Whether the pipeline itself degrades correctly with no provider configured,
 * and whether the usage log gets one row per candidate, needs real data and
 * lives in the integration suites.
 */

import { describe, expect, it } from 'vitest';

import {
  createChangeLogService,
  createEventService,
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
  InvalidRetrievalSearchError,
  RequestContextUnavailableError,
  type AuthenticatedRequestContext,
  type HealthService,
  type RequestContextService,
  type RetrievalMemoryCandidate,
  type RetrievalSearchInvocation,
  type RetrievalSearchOutcome,
  type RetrievalSearchRequest,
  type RetrievalSearchService,
  type RetrievalSearchServiceResolver,
  type RetrievalUsageLogFailureReporter,
} from '../../src/app/index.js';
import type { OwnerId } from '../../src/domain/owner.js';
import type { ProblemId } from '../../src/domain/problem.js';
import type { ProjectId } from '../../src/domain/project.js';
import { STRUCTURAL_FEATURE_SCHEMA_VERSION } from '../../src/domain/retrieval-summary.js';
import { buildMemoryHttpApp } from '../../src/http/index.js';
import type { MemoryRepository } from '../../src/repository/index.js';
import { createUnusedSearchResolver } from '../support/search-resolver.js';

const OWNER_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const PROBLEM_ID = '5d41402a-bc4b-4a76-b971-9d911017c592';
const OTHER_PROBLEM_ID = '2b8c5a10-9d3f-4e71-8a62-c4f0b1d7e935';
const PROJECT_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const OTHER_PROJECT_ID = '1f0d4c9b-2e5a-4837-9b61-a0c3d8e7f254';

/** A features block the route accepts: the exact eight fields. */
const FEATURES = {
  schema_version: STRUCTURAL_FEATURE_SCHEMA_VERSION,
  problem_domain: 'authentication',
  symptom_patterns: ['redirect loop after a successful credential check'],
  suspected_boundaries: ['session cookie written by one host, read by another'],
  occurrence_conditions: ['only on the preview deployment'],
  successful_directions: ['set the cookie on the apex domain'],
  dead_end_directions: ['raising the session timeout'],
  environment_facts: ['node 22.12.0'],
};

const BODY = {
  source_ai: 'claude-code',
  lexical_text: 'sign-in redirect loop after deploy',
  semantic_text: 'signing in on preview bounces back to the login page',
  current_features: FEATURES,
};

const URL = `/v1/problems/${PROBLEM_ID}/search`;

interface Recorded {
  request?: RetrievalSearchRequest;
  invocation?: RetrievalSearchInvocation;
  contexts: AuthenticatedRequestContext[];
  reporters: RetrievalUsageLogFailureReporter[];
}

function searched(candidates: RetrievalMemoryCandidate[] = []): RetrievalSearchOutcome {
  return {
    kind: 'SEARCHED',
    candidates,
    semanticStatus: 'USED',
    structuralStatus: 'USED',
    lexicalRelaxed: false,
  };
}

/**
 * A resolver that records and replays.
 *
 * `outcome` may be an error to reject with, which is how the error mapping is
 * exercised without a database.
 */
function recordingResolver(
  recorded: Recorded,
  outcome: RetrievalSearchOutcome | Error = searched(),
): RetrievalSearchServiceResolver {
  const service: RetrievalSearchService = {
    ownerId: OWNER_ID as OwnerId,
    search: (request, invocation) => {
      recorded.request = request;
      recorded.invocation = invocation;
      return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
    },
  };

  return {
    resolve: (context, failureReporter) => {
      recorded.contexts.push(context);
      recorded.reporters.push(failureReporter);
      return Promise.resolve(service);
    },
  };
}

function emptyRecorded(): Recorded {
  return { contexts: [], reporters: [] };
}

const healthService: HealthService = {
  check: () => Promise.resolve({ status: 'ok', latencyMs: 0 }),
};

function buildApp(resolver: RetrievalSearchServiceResolver, authenticated = true) {
  return buildMemoryHttpApp({
    retrievalSearchResolver: resolver,
    healthService,
    requestContextService: authenticated
      ? ({
          authenticate: () =>
            Promise.resolve({
              repository: { ownerId: OWNER_ID } as unknown as MemoryRepository,
            } as AuthenticatedRequestContext),
        } satisfies RequestContextService)
      : { authenticate: () => Promise.reject(new RequestContextUnavailableError('MISSING')) },
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
    logger: false,
  });
}

/**
 * A candidate with every field populated and every value distinguishable.
 *
 * Nothing is left at a default and no two strings repeat, so a mapper that
 * copies the wrong field, drops one, or reorders a list produces a body that
 * differs from the expected one somewhere findable.
 */
function fullCandidate(): RetrievalMemoryCandidate {
  return {
    ranking: {
      problemId: OTHER_PROBLEM_ID as ProblemId,
      projectId: OTHER_PROJECT_ID as ProjectId,
      confidence: 'HIGH',
      freshness: 'STALE_UNKNOWN',
      suppressed: false,
      projectRelation: 'SAME_TECH_OTHER_PROJECT',
      structuralScore: 0.75,
      // Deliberately not equal to the ranking rank: the gap is the point.
      hybridRank: 4,
      matchedDimensions: ['symptom_patterns', 'environment_facts'],
      rankingRank: 1,
    },
    revalidation: {
      historicalEnvironment: { runtime: 'node 22.12.0', framework: 'next 15.1.0' },
      evidence: [
        {
          verificationType: 'TEST',
          result: false,
          summary: 'could not reproduce on the second attempt',
          evidenceRef: null,
          createdAt: new Date('2026-02-01T10:00:00.000Z'),
        },
        {
          verificationType: 'API_RESULT',
          result: true,
          summary: 'documented as the intended cookie behaviour',
          evidenceRef: 'https://example.invalid/docs/cookies',
          createdAt: new Date('2026-02-02T11:30:00.000Z'),
        },
      ],
      requiredChecks: ['CURRENT_CODE', 'CURRENT_ENVIRONMENT', 'RELEVANT_VERSION', 'OFFICIAL_SPEC'],
    },
    deadEndWarnings: [
      {
        summary: 'raising the session timeout',
        result: 'the loop continued',
        reason: 'the cookie was never sent at all',
        evidenceRef: 'commit 9f1c2d4',
        createdAt: new Date('2026-02-03T09:15:00.000Z'),
      },
    ],
    successfulDirections: [
      'set the cookie domain to the apex',
      'stopped rewriting the host header',
    ],
    conflict: {
      subject: {
        symptoms: 'sign-in bounces back to the login page',
        problemDomain: 'authentication',
        suspectedBoundary: 'session cookie',
        status: 'VERIFIED',
        fixKind: 'ROOT_FIX',
      },
      contradictions: [
        {
          reason: 'the other memory concluded the apex domain was the cause of the loop',
          relationCreatedAt: new Date('2026-02-04T08:00:00.000Z'),
          other: {
            problemId: PROBLEM_ID as ProblemId,
            projectId: PROJECT_ID as ProjectId,
            symptoms: 'apex cookie rejected by the browser',
            problemDomain: 'browser storage',
            suspectedBoundary: null,
            status: 'CLOSED_UNRESOLVED',
            fixKind: null,
            confidence: 'LOW',
            freshness: 'SUPERSEDED',
            historicalEnvironment: { browser: 'safari 18.2' },
            evidence: [
              {
                verificationType: 'USER_CONFIRMATION',
                result: true,
                summary: 'observed in the browser console',
                evidenceRef: null,
                createdAt: new Date('2026-01-20T12:00:00.000Z'),
              },
            ],
          },
        },
      ],
    },
  };
}

describe('POST /v1/problems/:problem_id/search', () => {
  it('passes exactly the four fields through, and nothing else', async () => {
    const recorded = emptyRecorded();
    const app = buildApp(recordingResolver(recorded));

    const response = await app.inject({ method: 'POST', url: URL, payload: BODY });

    expect(response.statusCode).toBe(200);
    // The Problem comes from the path; the three query fields from the body.
    expect(recorded.request?.currentProblemId).toBe(PROBLEM_ID);
    expect(recorded.request?.lexicalText).toBe(BODY.lexical_text);
    expect(recorded.request?.semanticText).toBe(BODY.semantic_text);
    expect(recorded.request?.currentFeatures).toEqual(FEATURES);
    // A search is cross-project and the stage bounds are the server's. The
    // route does not pass them, so it cannot pass a wrong one.
    expect(recorded.request?.projectId).toBeUndefined();
    expect(recorded.request?.hybridLimit).toBeUndefined();
    expect(recorded.request?.rerankLimit).toBeUndefined();
    expect(Object.keys(recorded.request ?? {}).sort()).toEqual([
      'currentFeatures',
      'currentProblemId',
      'lexicalText',
      'semanticText',
    ]);

    await app.close();
  });

  it('sends source_ai only as the invocation attribution', async () => {
    const recorded = emptyRecorded();
    const app = buildApp(recordingResolver(recorded));

    await app.inject({ method: 'POST', url: URL, payload: BODY });

    expect(recorded.invocation).toEqual({ sourceAi: 'claude-code' });
    // It is attribution and nothing else. It reaches no query, no feature set
    // and no identifier — a caller renaming itself must not change what the
    // search finds, or the cache would fragment per client name.
    expect(JSON.stringify(recorded.request)).not.toContain('claude-code');

    await app.close();
  });

  it('resolves the service once per request, from the authenticated context', async () => {
    const recorded = emptyRecorded();
    const app = buildApp(recordingResolver(recorded));

    await app.inject({ method: 'POST', url: URL, payload: BODY });
    await app.inject({ method: 'POST', url: URL, payload: BODY });

    expect(recorded.contexts).toHaveLength(2);
    // The context the request authenticated, not one the body could name.
    expect(recorded.contexts[0]?.repository.ownerId).toBe(OWNER_ID);
    // A reporter per request too: it logs through that request's logger.
    expect(recorded.reporters).toHaveLength(2);

    await app.close();
  });

  it('refuses a request with no credential before resolving anything', async () => {
    const recorded = emptyRecorded();
    const app = buildApp(recordingResolver(recorded), false);

    const response = await app.inject({ method: 'POST', url: URL, payload: BODY });

    expect(response.statusCode).toBe(401);
    // Nothing was resolved, so no owner was looked up and no pipeline built.
    expect(recorded.contexts).toEqual([]);

    await app.close();
  });
});

describe('what the search route refuses', () => {
  it.each([
    ['source_ai', { ...BODY, source_ai: undefined }],
    ['lexical_text', { ...BODY, lexical_text: undefined }],
    ['semantic_text', { ...BODY, semantic_text: undefined }],
    ['current_features', { ...BODY, current_features: undefined }],
  ])('refuses a body missing %s', async (_field, payload) => {
    const recorded = emptyRecorded();
    const app = buildApp(recordingResolver(recorded));

    const response = await app.inject({ method: 'POST', url: URL, payload });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('INVALID_REQUEST');
    expect(recorded.request).toBeUndefined();

    await app.close();
  });

  it.each([
    ['owner_id', '3f2504e0-4f89-41d3-9a0c-0305e82c3399'],
    ['project_id', PROJECT_ID],
    ['limit', 5],
    ['hybrid_limit', 5],
    ['rerank_limit', 5],
    ['embedding', [0.1, 0.2]],
    ['model', 'some-model'],
    ['provider', 'some-provider'],
    ['recommendation', 'do the thing'],
  ])('refuses an unknown %s field rather than ignoring it', async (field, value) => {
    const recorded = emptyRecorded();
    const app = buildApp(recordingResolver(recorded));

    const response = await app.inject({
      method: 'POST',
      url: URL,
      payload: { ...BODY, [field]: value },
    });

    // Dropping it quietly would let a caller believe a limit or an owner it
    // sent was honoured.
    expect(response.statusCode).toBe(400);
    expect(recorded.request).toBeUndefined();

    await app.close();
  });

  it.each([
    ['a blank source_ai', { ...BODY, source_ai: '   ' }],
    ['a blank lexical_text', { ...BODY, lexical_text: '' }],
    ['a lexical_text past the bound', { ...BODY, lexical_text: 'x'.repeat(1001) }],
    ['a semantic_text past the bound', { ...BODY, semantic_text: 'y'.repeat(4001) }],
    [
      'an unknown feature schema version',
      { ...BODY, current_features: { ...FEATURES, schema_version: '2' } },
    ],
    [
      'an extra feature field',
      { ...BODY, current_features: { ...FEATURES, guessed_causes: ['dns'] } },
    ],
    [
      'a missing feature list',
      { ...BODY, current_features: { ...FEATURES, environment_facts: undefined } },
    ],
    ['a features block that is not an object', { ...BODY, current_features: 'authentication' }],
  ])('refuses %s', async (_case, payload) => {
    const recorded = emptyRecorded();
    const app = buildApp(recordingResolver(recorded));

    const response = await app.inject({ method: 'POST', url: URL, payload });

    expect(response.statusCode).toBe(400);
    expect(recorded.request).toBeUndefined();

    await app.close();
  });

  it('serves no search anywhere but under a Problem', async () => {
    const app = buildApp(recordingResolver(emptyRecorded()));

    // The routes a client might guess at. Each is a different claim about what
    // a search is scoped to, and none of them is this one.
    for (const url of [
      '/v1/search',
      '/v1/memories/search',
      `/v1/projects/${PROJECT_ID}/search`,
      `/v1/problems/${PROBLEM_ID}/searches`,
    ]) {
      expect((await app.inject({ method: 'POST', url, payload: BODY })).statusCode).toBe(404);
    }
    // And not by method: a search sends a body and must not be cacheable by a
    // proxy or land in a server log as a query string.
    expect((await app.inject({ method: 'GET', url: URL })).statusCode).toBe(404);

    await app.close();
  });
});

describe('how a search outcome becomes a response', () => {
  it('answers a search with no candidates as an ordinary result', async () => {
    const app = buildApp(recordingResolver(emptyRecorded(), searched()));

    const response = await app.inject({ method: 'POST', url: URL, payload: BODY });

    // Not a 404, not an empty-result error: nothing worth reading is a fact
    // about the memory, not a fault.
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      kind: 'SEARCHED',
      candidates: [],
      semantic_status: 'USED',
      structural_status: 'USED',
    });

    await app.close();
  });

  it('answers a Problem it cannot read with the same 404 as one that never existed', async () => {
    const app = buildApp(
      recordingResolver(emptyRecorded(), { kind: 'CURRENT_PROBLEM_NOT_AVAILABLE' }),
    );

    const response = await app.inject({ method: 'POST', url: URL, payload: BODY });

    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
    // Unknown, deleted and another owner's are one answer. Anything narrower
    // would confirm the existence of a Problem to somebody who cannot read it.
    expect(JSON.stringify(response.json())).not.toContain('deleted');

    await app.close();
  });

  it.each([['MEMORY_READ_DISABLED'], ['CURRENT_SOURCE_CHANGED']] as const)(
    'answers %s with a typed 200 carrying only the kind',
    async (kind) => {
      const app = buildApp(recordingResolver(emptyRecorded(), { kind }));

      const response = await app.inject({ method: 'POST', url: URL, payload: BODY });

      // An owner's setting being respected, and a race the pipeline noticed.
      // Neither is a failure, so neither is an error envelope — and no field
      // tells the caller what to do about it.
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ kind });

      await app.close();
    },
  );

  it('reports a channel that could not run, without failing the search', async () => {
    const app = buildApp(
      recordingResolver(emptyRecorded(), {
        kind: 'SEARCHED',
        candidates: [],
        semanticStatus: 'PROVIDER_UNAVAILABLE',
        structuralStatus: 'RERANKER_UNAVAILABLE',
        lexicalRelaxed: false,
      }),
    );

    const response = await app.inject({ method: 'POST', url: URL, payload: BODY });

    // 200, both statuses named. A server with no configured provider is a
    // smaller answer to the same question, not a broken endpoint.
    expect(response.statusCode).toBe(200);
    expect(response.json<{ semantic_status: string }>().semantic_status).toBe(
      'PROVIDER_UNAVAILABLE',
    );
    expect(response.json<{ structural_status: string }>().structural_status).toBe(
      'RERANKER_UNAVAILABLE',
    );

    await app.close();
  });

  it('maps a refused search to 400 without echoing the query back', async () => {
    const app = buildApp(
      recordingResolver(
        emptyRecorded(),
        new InvalidRetrievalSearchError('lexicalText', 'the query my-secret-token was unusable'),
      ),
    );

    const response = await app.inject({ method: 'POST', url: URL, payload: BODY });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('INVALID_REQUEST');
    // The message is this codebase's, but a rejected query can carry whatever
    // the caller sent — so nothing from the error's message travels.
    expect(JSON.stringify(response.json()).includes('my-secret-token')).toBe(false);

    await app.close();
  });

  it('does not turn a broken pipeline into a rejected request', async () => {
    const app = buildApp(
      recordingResolver(emptyRecorded(), new Error('the provider returned an unreadable answer')),
    );

    const response = await app.inject({ method: 'POST', url: URL, payload: BODY });

    // A malformed provider answer is an internal failure. Reporting it as a
    // 400 would tell the caller its request was wrong about something it was
    // not, and would let a broken provider look like a bad query forever.
    expect(response.statusCode).toBe(500);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(response.json())).not.toContain('provider');

    await app.close();
  });
});

describe('the candidate material on the wire', () => {
  it('carries every field of every kind of material, and nothing more', async () => {
    const app = buildApp(recordingResolver(emptyRecorded(), searched([fullCandidate()])));

    const response = await app.inject({ method: 'POST', url: URL, payload: BODY });

    expect(response.statusCode).toBe(200);
    // Whole-body equality, deliberately: a field silently dropped by the
    // response schema is invisible to a per-field assertion that only checks
    // the fields it thought to name.
    expect(response.json()).toEqual({
      kind: 'SEARCHED',
      semantic_status: 'USED',
      structural_status: 'USED',
      candidates: [
        {
          ranking: {
            problem_id: OTHER_PROBLEM_ID,
            project_id: OTHER_PROJECT_ID,
            confidence: 'HIGH',
            freshness: 'STALE_UNKNOWN',
            suppressed: false,
            project_relation: 'SAME_TECH_OTHER_PROJECT',
            structural_score: 0.75,
            hybrid_rank: 4,
            matched_dimensions: ['symptom_patterns', 'environment_facts'],
            ranking_rank: 1,
          },
          revalidation: {
            historical_environment: { runtime: 'node 22.12.0', framework: 'next 15.1.0' },
            evidence: [
              {
                verification_type: 'TEST',
                // A check that failed is evidence too. Keeping only the
                // passing ones would read as though everything tried worked.
                result: false,
                summary: 'could not reproduce on the second attempt',
                evidence_ref: null,
                created_at: '2026-02-01T10:00:00.000Z',
              },
              {
                verification_type: 'API_RESULT',
                result: true,
                summary: 'documented as the intended cookie behaviour',
                evidence_ref: 'https://example.invalid/docs/cookies',
                created_at: '2026-02-02T11:30:00.000Z',
              },
            ],
            required_checks: [
              'CURRENT_CODE',
              'CURRENT_ENVIRONMENT',
              'RELEVANT_VERSION',
              'OFFICIAL_SPEC',
            ],
          },
          dead_end_warnings: [
            {
              summary: 'raising the session timeout',
              result: 'the loop continued',
              reason: 'the cookie was never sent at all',
              evidence_ref: 'commit 9f1c2d4',
              created_at: '2026-02-03T09:15:00.000Z',
            },
          ],
          successful_directions: [
            'set the cookie domain to the apex',
            'stopped rewriting the host header',
          ],
          conflict: {
            subject: {
              symptoms: 'sign-in bounces back to the login page',
              problem_domain: 'authentication',
              suspected_boundary: 'session cookie',
              status: 'VERIFIED',
              fix_kind: 'ROOT_FIX',
            },
            contradictions: [
              {
                reason: 'the other memory concluded the apex domain was the cause of the loop',
                relation_created_at: '2026-02-04T08:00:00.000Z',
                other: {
                  problem_id: PROBLEM_ID,
                  project_id: PROJECT_ID,
                  symptoms: 'apex cookie rejected by the browser',
                  problem_domain: 'browser storage',
                  suspected_boundary: null,
                  status: 'CLOSED_UNRESOLVED',
                  fix_kind: null,
                  confidence: 'LOW',
                  freshness: 'SUPERSEDED',
                  historical_environment: { browser: 'safari 18.2' },
                  evidence: [
                    {
                      verification_type: 'USER_CONFIRMATION',
                      result: true,
                      summary: 'observed in the browser console',
                      evidence_ref: null,
                      created_at: '2026-01-20T12:00:00.000Z',
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    });

    await app.close();
  });

  it('keeps the order and the duplicates the pipeline produced', async () => {
    const first = fullCandidate();
    const middle = fullCandidate();
    const last = fullCandidate();
    // Ranks out of order and one repeated: a mapper that sorted, renumbered or
    // deduplicated would produce something tidier than what it was given.
    const app = buildApp(
      recordingResolver(
        emptyRecorded(),
        searched([
          { ...first, ranking: { ...first.ranking, rankingRank: 3, hybridRank: 9 } },
          { ...middle, ranking: { ...middle.ranking, rankingRank: 1, hybridRank: 2 } },
          { ...last, ranking: { ...last.ranking, rankingRank: 1, hybridRank: 2 } },
        ]),
      ),
    );

    const response = await app.inject({ method: 'POST', url: URL, payload: BODY });

    const body = response.json<{ candidates: { ranking: { ranking_rank: number } }[] }>();
    expect(body.candidates.map((candidate) => candidate.ranking.ranking_rank)).toEqual([3, 1, 1]);

    await app.close();
  });

  it('reports a missing structural score as absent rather than as zero', async () => {
    const candidate = fullCandidate();
    const app = buildApp(
      recordingResolver(
        emptyRecorded(),
        searched([{ ...candidate, ranking: { ...candidate.ranking, structuralScore: null } }]),
      ),
    );

    const response = await app.inject({ method: 'POST', url: URL, payload: BODY });

    // Null, not 0. A judgement nobody made must not arrive looking like the
    // lowest possible score.
    const body = response.json<{ candidates: { ranking: { structural_score: unknown } }[] }>();
    expect(body.candidates[0]?.ranking.structural_score).toBeNull();

    await app.close();
  });
});

describe('the search route as seen by the rest of the app', () => {
  it('leaves the health probe alone', async () => {
    const app = buildApp(createUnusedSearchResolver());

    const response = await app.inject({ method: 'GET', url: '/health' });

    // The resolver here rejects every call. `/health` must not be able to
    // reach it — it is a liveness probe, not a search.
    expect(response.statusCode).toBe(200);
    expect(response.json<{ status: string }>().status).toBe('ok');

    await app.close();
  });
});
