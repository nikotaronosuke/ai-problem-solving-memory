/**
 * The client and the route, joined — with nothing in between agreeing to be
 * wrong together.
 *
 * The client's own suite drives it against fixtures, and the route's suite
 * drives the route against fixtures. Both pass if both fixtures share the same
 * mistake, which is exactly the failure a mirrored contract is prone to. So this
 * file removes the fixtures from the middle: a real `MemoryApiClient`, whose
 * `fetch` is a bridge into a real `buildMemoryHttpApp`, calling the real search
 * route and its real response schema.
 *
 * No socket and no database. `app.inject()` is the transport, and the search
 * service is substituted — the pipeline's own behaviour is proved against a real
 * database elsewhere, and what is under test here is the wire between two
 * independent descriptions of one contract.
 */

import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import {
  createMemoryApiClient,
  MemoryApiError,
  type FetchLike,
  type MemorySearchRequest,
} from '@ai-problem-solving-memory/api-client';

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
  type AuthenticatedRequestContext,
  type HealthService,
  type RequestContextService,
  type RetrievalMemoryCandidate,
  type RetrievalSearchOutcome,
  type RetrievalSearchService,
  type RetrievalSearchServiceResolver,
} from '../../src/app/index.js';
import type { OwnerId } from '../../src/domain/owner.js';
import type { ProblemId } from '../../src/domain/problem.js';
import type { ProjectId } from '../../src/domain/project.js';
import { STRUCTURAL_FEATURE_SCHEMA_VERSION } from '../../src/domain/retrieval-summary.js';
import { buildMemoryHttpApp } from '../../src/http/index.js';
import type { MemoryRepository } from '../../src/repository/index.js';

/** Synthetic. The context service below accepts anything. */
const CREDENTIAL = 'memory_test_0000000000000000000000000000';

const OWNER_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const PROBLEM_ID = '5d41402a-bc4b-4a76-b971-9d911017c592';
const CANDIDATE_PROBLEM_ID = '2b8c5a10-9d3f-4e71-8a62-c4f0b1d7e935';
const PROJECT_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const CANDIDATE_PROJECT_ID = '1f0d4c9b-2e5a-4837-9b61-a0c3d8e7f254';

const REQUEST: MemorySearchRequest = {
  source_ai: 'some-assistant',
  lexical_text: 'deployment configuration',
  semantic_text: 'the app works locally but fails once deployed',
  current_features: {
    schema_version: STRUCTURAL_FEATURE_SCHEMA_VERSION,
    problem_domain: 'deployment',
    symptom_patterns: ['works locally, fails once deployed'],
    suspected_boundaries: ['configuration read at build time'],
    occurrence_conditions: ['only in the deployed environment'],
    successful_directions: [],
    dead_end_directions: ['raising the timeout'],
    environment_facts: ['node 22.12.0'],
  },
};

/** A candidate with every field populated, on the server's side of the wire. */
function candidate(): RetrievalMemoryCandidate {
  return {
    ranking: {
      problemId: CANDIDATE_PROBLEM_ID as ProblemId,
      projectId: CANDIDATE_PROJECT_ID as ProjectId,
      confidence: 'MEDIUM',
      freshness: 'CURRENT',
      suppressed: false,
      projectRelation: 'OTHER_TECH',
      structuralScore: 0.5,
      hybridRank: 3,
      matchedDimensions: ['occurrence_conditions'],
      rankingRank: 1,
    },
    revalidation: {
      historicalEnvironment: { runtime: 'node 22.12.0' },
      evidence: [
        {
          verificationType: 'BUILD',
          result: false,
          summary: 'the build reproduced it once and not again',
          evidenceRef: null,
          createdAt: new Date('2026-03-01T08:00:00.000Z'),
        },
      ],
      requiredChecks: ['CURRENT_CODE', 'CURRENT_ENVIRONMENT', 'RELEVANT_VERSION', 'OFFICIAL_SPEC'],
    },
    deadEndWarnings: [
      {
        summary: 'pinning the runtime',
        result: null,
        reason: 'the value was read at build time, not at run time',
        evidenceRef: null,
        createdAt: new Date('2026-03-02T09:30:00.000Z'),
      },
    ],
    successfulDirections: ['read the configuration at run time'],
    conflict: {
      subject: {
        symptoms: 'the callback fails only once deployed',
        problemDomain: 'deployment',
        suspectedBoundary: null,
        status: 'FIX_CANDIDATE',
        fixKind: null,
      },
      contradictions: [
        {
          reason: 'the other memory concluded the runtime was at fault',
          relationCreatedAt: new Date('2026-03-03T10:00:00.000Z'),
          other: {
            problemId: PROBLEM_ID as ProblemId,
            projectId: PROJECT_ID as ProjectId,
            symptoms: 'the runtime differed between build and run',
            problemDomain: null,
            suspectedBoundary: 'container image',
            status: 'PAUSED',
            fixKind: 'WORKAROUND',
            confidence: 'CONFLICTED',
            freshness: 'INVALID',
            historicalEnvironment: { image: 'node:22-alpine' },
            evidence: [],
          },
        },
      ],
    },
  };
}

const healthService: HealthService = {
  check: () => Promise.resolve({ status: 'ok', latencyMs: 0 }),
};

/** A resolver that answers with one prepared outcome, or raises. */
function resolverAnswering(
  outcome: RetrievalSearchOutcome | Error,
): RetrievalSearchServiceResolver {
  const service: RetrievalSearchService = {
    ownerId: OWNER_ID as OwnerId,
    search: () => (outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome)),
  };
  return { resolve: () => Promise.resolve(service) };
}

function buildApp(resolver: RetrievalSearchServiceResolver): FastifyInstance {
  return buildMemoryHttpApp({
    retrievalSearchResolver: resolver,
    healthService,
    requestContextService: {
      authenticate: () =>
        Promise.resolve({
          repository: { ownerId: OWNER_ID } as unknown as MemoryRepository,
        } as AuthenticatedRequestContext),
    } satisfies RequestContextService,
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
 * A `fetch` that delivers to a Fastify instance instead of a socket.
 *
 * The client builds the URL, the method, the headers and the body exactly as it
 * would for a real server; this only carries them. Anything the client got wrong
 * about the wire fails inside the route's own validation, which is the point.
 */
function bridgeTo(app: FastifyInstance): FetchLike {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const injected = await app.inject({
      method: (init?.method ?? 'GET') as 'GET' | 'POST',
      url: new URL(url).pathname,
      headers: init?.headers as Record<string, string>,
      ...(typeof init?.body === 'string' ? { payload: init.body } : {}),
    });

    return new Response(injected.body, {
      status: injected.statusCode,
      headers: { 'content-type': injected.headers['content-type'] as string },
    });
  };
}

async function searchThrough(
  outcome: RetrievalSearchOutcome | Error,
  request: MemorySearchRequest = REQUEST,
) {
  const app = buildApp(resolverAnswering(outcome));
  await app.ready();
  const memory = createMemoryApiClient({ credential: CREDENTIAL, fetch: bridgeTo(app) });
  try {
    return await memory.search(PROBLEM_ID, request);
  } finally {
    await app.close();
  }
}

describe('the client against the real search route', () => {
  it('carries a whole candidate across the wire without losing a field', async () => {
    const outcome = await searchThrough({
      kind: 'SEARCHED',
      candidates: [candidate()],
      semanticStatus: 'USED',
      structuralStatus: 'USED',
    });

    // Written out on the client's side of the wire, so this asserts agreement
    // between two independent descriptions of the contract: the server's
    // response schema and mapper, and the client's validator and types. A field
    // the mapper renamed, the schema dropped, or the validator rejected fails
    // here — and neither side's fixtures are in the middle to agree with it.
    expect(outcome).toEqual({
      kind: 'SEARCHED',
      semantic_status: 'USED',
      structural_status: 'USED',
      candidates: [
        {
          ranking: {
            problem_id: CANDIDATE_PROBLEM_ID,
            project_id: CANDIDATE_PROJECT_ID,
            confidence: 'MEDIUM',
            freshness: 'CURRENT',
            suppressed: false,
            project_relation: 'OTHER_TECH',
            structural_score: 0.5,
            hybrid_rank: 3,
            matched_dimensions: ['occurrence_conditions'],
            ranking_rank: 1,
          },
          revalidation: {
            historical_environment: { runtime: 'node 22.12.0' },
            evidence: [
              {
                verification_type: 'BUILD',
                result: false,
                summary: 'the build reproduced it once and not again',
                evidence_ref: null,
                created_at: '2026-03-01T08:00:00.000Z',
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
              summary: 'pinning the runtime',
              result: null,
              reason: 'the value was read at build time, not at run time',
              evidence_ref: null,
              created_at: '2026-03-02T09:30:00.000Z',
            },
          ],
          successful_directions: ['read the configuration at run time'],
          conflict: {
            subject: {
              symptoms: 'the callback fails only once deployed',
              problem_domain: 'deployment',
              suspected_boundary: null,
              status: 'FIX_CANDIDATE',
              fix_kind: null,
            },
            contradictions: [
              {
                reason: 'the other memory concluded the runtime was at fault',
                relation_created_at: '2026-03-03T10:00:00.000Z',
                other: {
                  problem_id: PROBLEM_ID,
                  project_id: PROJECT_ID,
                  symptoms: 'the runtime differed between build and run',
                  problem_domain: null,
                  suspected_boundary: 'container image',
                  status: 'PAUSED',
                  fix_kind: 'WORKAROUND',
                  confidence: 'CONFLICTED',
                  freshness: 'INVALID',
                  historical_environment: { image: 'node:22-alpine' },
                  evidence: [],
                },
              },
            ],
          },
        },
      ],
    });
  });

  it('reads a search that found nothing', async () => {
    const outcome = await searchThrough({
      kind: 'SEARCHED',
      candidates: [],
      semanticStatus: 'PROVIDER_UNAVAILABLE',
      structuralStatus: 'RERANKER_UNAVAILABLE',
    });

    // Every channel unavailable and no candidates is still an ordinary answer,
    // and both statuses survive the wire under the names both sides mirror.
    expect(outcome).toEqual({
      kind: 'SEARCHED',
      candidates: [],
      semantic_status: 'PROVIDER_UNAVAILABLE',
      structural_status: 'RERANKER_UNAVAILABLE',
    });
  });

  it.each([['MEMORY_READ_DISABLED'], ['CURRENT_SOURCE_CHANGED']] as const)(
    'reads %s as the typed answer both sides call it',
    async (kind) => {
      expect(await searchThrough({ kind })).toEqual({ kind });
    },
  );

  it('turns the route’s 404 into the outcome a search means by it', async () => {
    const outcome = await searchThrough({ kind: 'CURRENT_PROBLEM_NOT_AVAILABLE' });

    // The server answers a Problem it cannot read with the same 404 as one that
    // never existed; the client names that state for a search. Both halves of
    // that sentence are exercised here rather than assumed.
    expect(outcome).toEqual({ kind: 'CURRENT_PROBLEM_NOT_AVAILABLE' });
  });

  it('raises a server fault as a refusal, without reinterpreting it', async () => {
    const app = buildApp(resolverAnswering(new Error('the provider answered unusably')));
    await app.ready();
    const memory = createMemoryApiClient({ credential: CREDENTIAL, fetch: bridgeTo(app) });

    const error = await memory.search(PROBLEM_ID, REQUEST).catch((raised: unknown) => raised);
    await app.close();

    // A 500 may mean the server's provider integration is broken. It is not an
    // empty result, not a channel status, and not the caller's request being
    // wrong — so it arrives as what it is.
    expect(error).toBeInstanceOf(MemoryApiError);
    expect((error as MemoryApiError).status).toBe(500);
    expect((error as MemoryApiError).code).toBe('INTERNAL_ERROR');
    expect((error as MemoryApiError).requestId).toBeTruthy();
  });

  it('sends a request the route accepts without the route filling anything in', async () => {
    // The strongest form of the agreement: the client's own idea of a valid
    // request passes the route's schema, which is what the OpenAPI document is
    // generated from. If the client sent a fifth field, or the wrong feature
    // vocabulary, the route would answer 400 and this would fail rather than
    // silently succeed with a body the server had ignored.
    const outcome = await searchThrough({
      kind: 'SEARCHED',
      candidates: [],
      semanticStatus: 'USED',
      structuralStatus: 'NOT_NEEDED',
    });

    expect(outcome).toMatchObject({ kind: 'SEARCHED' });
  });
});
