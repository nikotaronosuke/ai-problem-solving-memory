/**
 * What `search()` sends, what it accepts back, and what it refuses to say.
 *
 * Like the rest of this package's tests, everything drives the real
 * `createMemoryApiClient` through an injected transport: the point of the
 * injection is to see the request production would have sent, not to replace the
 * code that builds it.
 *
 * Two things this file leans on heavily.
 *
 * **A lossless witness.** One fixture carries every field of every kind of
 * candidate material, with distinguishable values, nulls where nulls are
 * allowed, a failed Verification beside a passing one, and a gap between the two
 * ranks. The client's return value is compared to it whole. A mapper that
 * renamed, dropped, reordered, de-duplicated, renumbered or date-parsed anything
 * fails there, and no per-field assertion can be forgotten into passing.
 *
 * **Absence assertions written as booleans.** Several tests assert the
 * credential, or a caller's query, is *not* somewhere. Those compare booleans
 * rather than strings, because a failing equality assertion prints both sides
 * and one of the sides would be the thing that must not be printed.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createMemoryApiClient,
  MemoryApiArgumentError,
  MemoryApiError,
  MemoryApiProtocolError,
  MemoryApiUnreachableError,
  MEMORY_API_REQUEST_TIMEOUT_MS,
  MEMORY_API_SEARCH_TIMEOUT_MS,
  MEMORY_SEARCH_MAX_LEXICAL_TEXT_LENGTH,
  MEMORY_SEARCH_MAX_SEMANTIC_TEXT_LENGTH,
  MEMORY_SEARCH_MAX_STRUCTURAL_FEATURE_ITEMS,
  MEMORY_SEARCH_MAX_STRUCTURAL_FEATURE_LENGTH,
  MEMORY_SEARCH_STRUCTURAL_FEATURE_SCHEMA_VERSION,
  type FetchLike,
  type MemorySearchRequest,
} from '../src/index.js';

/** A synthetic value in the shape of a credential. Not one. */
const CREDENTIAL = 'memory_test_0000000000000000000000000000';

const PROBLEM_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_PROBLEM_ID = '99999999-8888-4777-8666-555555555555';
const PROJECT_ID = '12345678-1234-4234-8234-123456789012';
const OTHER_PROJECT_ID = '87654321-4321-4321-8321-210987654321';

const FEATURES = {
  schema_version: MEMORY_SEARCH_STRUCTURAL_FEATURE_SCHEMA_VERSION,
  problem_domain: 'deployment',
  symptom_patterns: ['works locally, fails once deployed'],
  suspected_boundaries: ['configuration read at build time'],
  occurrence_conditions: ['only in the deployed environment'],
  successful_directions: [],
  dead_end_directions: ['raising the timeout'],
  environment_facts: ['node 22.12.0'],
} satisfies MemorySearchRequest['current_features'];

const REQUEST = {
  source_ai: 'some-assistant',
  lexical_text: 'deployment configuration',
  semantic_text: 'the app works locally but fails once deployed',
  current_features: FEATURES,
} satisfies MemorySearchRequest;

/**
 * One candidate with everything on it.
 *
 * No two strings repeat and nothing sits at a default, so a mistake in the
 * validator or a transformation on the way out shows up as a difference
 * somebody can find.
 */
const CANDIDATE = {
  ranking: {
    problem_id: OTHER_PROBLEM_ID,
    project_id: OTHER_PROJECT_ID,
    confidence: 'HIGH',
    freshness: 'STALE_UNKNOWN',
    suppressed: false,
    project_relation: 'SAME_TECH_OTHER_PROJECT',
    structural_score: 0.75,
    // Deliberately not equal to the ranking rank: the gap is the visible trace
    // of a candidate dropped between the stages.
    hybrid_rank: 4,
    matched_dimensions: ['symptom_patterns', 'environment_facts'],
    ranking_rank: 1,
  },
  revalidation: {
    historical_environment: { runtime: 'node 22.12.0', framework: 'next 15.1.0' },
    evidence: [
      {
        verification_type: 'TEST',
        result: false,
        summary: 'could not reproduce on the second attempt',
        evidence_ref: null,
        created_at: '2026-02-01T10:00:00.000Z',
      },
      {
        verification_type: 'API_RESULT',
        result: true,
        summary: 'documented as the intended behaviour',
        evidence_ref: 'https://example.invalid/docs',
        created_at: '2026-02-02T11:30:00.000Z',
      },
    ],
    required_checks: ['CURRENT_CODE', 'CURRENT_ENVIRONMENT', 'RELEVANT_VERSION', 'OFFICIAL_SPEC'],
  },
  dead_end_warnings: [
    {
      summary: 'raising the session timeout',
      result: 'the loop continued',
      reason: null,
      evidence_ref: 'commit 9f1c2d4',
      created_at: '2026-02-03T09:15:00.000Z',
    },
  ],
  successful_directions: ['set the cookie domain to the apex', 'stopped rewriting the host header'],
  conflict: {
    subject: {
      symptoms: 'sign-in bounces back to the login page',
      problem_domain: 'authentication',
      suspected_boundary: null,
      status: 'VERIFIED',
      fix_kind: 'ROOT_FIX',
    },
    contradictions: [
      {
        reason: 'the other memory concluded the apex domain was the cause',
        relation_created_at: '2026-02-04T08:00:00.000Z',
        other: {
          problem_id: PROBLEM_ID,
          project_id: PROJECT_ID,
          symptoms: 'apex cookie rejected by the browser',
          problem_domain: 'browser storage',
          suspected_boundary: 'cookie jar',
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
};

/**
 * A second candidate, placed ahead of the first and ranked behind it.
 *
 * Two rather than one, and deliberately out of rank order: a client that sorted
 * the list — by rank, the one field it would be tempting to sort by — would
 * produce a tidier answer than it was given, and a single-candidate fixture
 * cannot tell the difference.
 */
const SECOND_CANDIDATE = {
  ...CANDIDATE,
  ranking: { ...CANDIDATE.ranking, ranking_rank: 3, hybrid_rank: 9 },
};

const SEARCHED = {
  kind: 'SEARCHED',
  candidates: [SECOND_CANDIDATE, CANDIDATE],
  semantic_status: 'USED',
  structural_status: 'USED',
};

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/** The JSON body a recorded request carried. Every request here sends one. */
function bodyOf(call: Call | undefined): Record<string, unknown> {
  const body = call?.init?.body;
  if (typeof body !== 'string') {
    throw new Error('the recorded request carried no JSON body');
  }
  return JSON.parse(body) as Record<string, unknown>;
}

type FetchInput = Parameters<FetchLike>[0];

function urlOf(input: FetchInput): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function recordingFetch(answer: () => Promise<Response> | Response): {
  fetch: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({ url: urlOf(input), init });
    return answer();
  };
  return { fetch, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function errorEnvelope(code: string): unknown {
  return {
    error: { code, message: 'a fixed sentence the server chose' },
    request_id: 'req-0000000000000000',
  };
}

function client(overrides: { fetch?: FetchLike; timeoutMs?: number } = {}) {
  return createMemoryApiClient({ credential: CREDENTIAL, ...overrides });
}

/** A client whose transport answers with one body, plus the recorded calls. */
function answering(status: number, body: unknown) {
  const { fetch, calls } = recordingFetch(() => jsonResponse(status, body));
  return { calls, memory: client({ fetch }) };
}

describe('what a search sends', () => {
  it('posts to the Problem it is a search for', async () => {
    const { calls, memory } = answering(200, SEARCHED);

    await memory.search(PROBLEM_ID, REQUEST);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`http://127.0.0.1:3000/v1/problems/${PROBLEM_ID}/search`);
    expect(calls[0]?.init?.method).toBe('POST');
    // No query string at all: a search is made of somebody's own words about
    // their own problem, and a query string reaches every access log on the way.
    expect(calls[0]?.url.includes('?')).toBe(false);
  });

  it('declares what it sends and what it wants back', async () => {
    const { calls, memory } = answering(200, SEARCHED);

    await memory.search(PROBLEM_ID, REQUEST);

    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['accept']).toBe('application/json');
  });

  it('sends exactly the four fields, unchanged', async () => {
    const { calls, memory } = answering(200, SEARCHED);

    await memory.search(PROBLEM_ID, REQUEST);

    // Whole-body equality: a field added, renamed or camelCased fails here, and
    // so does a text this client decided to trim on the caller's behalf.
    expect(bodyOf(calls[0])).toEqual({
      source_ai: 'some-assistant',
      lexical_text: 'deployment configuration',
      semantic_text: 'the app works locally but fails once deployed',
      current_features: FEATURES,
    });
  });

  it('sends the caller’s bytes rather than a tidied version of them', async () => {
    const { calls, memory } = answering(200, SEARCHED);
    const padded = {
      ...REQUEST,
      lexical_text: '  deployment configuration  ',
      semantic_text: 'fails once deployed\n',
    };

    await memory.search(PROBLEM_ID, padded);

    // Whitespace is looked at to decide whether a text is blank, and never
    // removed: a caller reasoning about the search it made must be reasoning
    // about the search that was made.
    const body = bodyOf(calls[0]);
    expect(body['lexical_text']).toBe('  deployment configuration  ');
    expect(body['semantic_text']).toBe('fails once deployed\n');
  });

  it('puts the credential in one place and nowhere else', async () => {
    const { calls, memory } = answering(200, SEARCHED);

    await memory.search(PROBLEM_ID, REQUEST);

    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe(`Bearer ${CREDENTIAL}`);

    // The whole request minus that one header, swept. A boolean, so a failure
    // does not print the credential it found.
    const withoutAuthorization = JSON.stringify({
      url: calls[0]?.url ?? '',
      init: { ...calls[0]?.init, headers: { accept: headers['accept'] ?? '' } },
    });
    expect(withoutAuthorization.includes(CREDENTIAL)).toBe(false);
  });

  it('makes exactly one request', async () => {
    const { calls, memory } = answering(200, SEARCHED);

    await memory.search(PROBLEM_ID, REQUEST);

    expect(calls).toHaveLength(1);
  });
});

describe('what a search refuses to send', () => {
  /** Asserts a refusal that costs no request. */
  async function refusesWithoutAsking(
    problemId: string,
    request: unknown,
    argument: string,
  ): Promise<void> {
    const { fetch, calls } = recordingFetch(() => jsonResponse(200, SEARCHED));

    await expect(
      client({ fetch }).search(problemId, request as MemorySearchRequest),
    ).rejects.toBeInstanceOf(MemoryApiArgumentError);
    await expect(
      client({ fetch }).search(problemId, request as MemorySearchRequest),
    ).rejects.toMatchObject({ argument });
    // The point of validating here rather than letting the server do it: no
    // request is spent learning something already knowable.
    expect(calls).toHaveLength(0);
  }

  it.each([
    ['not an id at all', 'nonsense'],
    ['a path traversal', '../../etc/passwd'],
    ['an id with a slash', `${PROBLEM_ID}/extra`],
    ['empty', ''],
  ])('refuses %s as a Problem id', async (_case, problemId) => {
    await refusesWithoutAsking(problemId, REQUEST, 'problem id');
  });

  it.each([
    ['not an object', 'a string'],
    ['null', null],
    ['an array', []],
    ['missing source_ai', { ...REQUEST, source_ai: undefined }],
    ['a blank source_ai', { ...REQUEST, source_ai: '   ' }],
    ['a non-string source_ai', { ...REQUEST, source_ai: 7 }],
    ['missing lexical_text', { ...REQUEST, lexical_text: undefined }],
    ['a blank lexical_text', { ...REQUEST, lexical_text: '' }],
    [
      'a lexical_text past the bound',
      { ...REQUEST, lexical_text: 'x'.repeat(MEMORY_SEARCH_MAX_LEXICAL_TEXT_LENGTH + 1) },
    ],
    ['missing semantic_text', { ...REQUEST, semantic_text: undefined }],
    ['a blank semantic_text', { ...REQUEST, semantic_text: '\t\n' }],
    [
      'a semantic_text past the bound',
      { ...REQUEST, semantic_text: 'y'.repeat(MEMORY_SEARCH_MAX_SEMANTIC_TEXT_LENGTH + 1) },
    ],
    ['missing current_features', { ...REQUEST, current_features: undefined }],
  ])('refuses %s', async (_case, request) => {
    await refusesWithoutAsking(PROBLEM_ID, request, 'search request');
  });

  it.each([
    // Not a blacklist: the key set is exact, so every one of these is refused
    // by the same rule rather than by having been thought of.
    ['owner_id', '00000000-0000-4000-8000-000000000000'],
    ['client_id', '00000000-0000-4000-8000-000000000001'],
    ['project_id', PROJECT_ID],
    ['limit', 5],
    ['hybrid_limit', 5],
    ['rerank_limit', 5],
    ['embedding', [0.1, 0.2]],
    ['vector', [0.1, 0.2]],
    ['model', 'a-model'],
    ['provider', 'a-provider'],
    ['session_id', 'a-session'],
    ['recommendation', 'do the thing'],
  ])('refuses a request carrying %s', async (field, value) => {
    await refusesWithoutAsking(PROBLEM_ID, { ...REQUEST, [field]: value }, 'search request');
  });

  it.each([
    ['a version this client does not speak', { ...FEATURES, schema_version: '2' }],
    ['a missing list', { ...FEATURES, environment_facts: undefined }],
    ['an extra field', { ...FEATURES, guessed_causes: ['dns'] }],
    ['a list that is not a list', { ...FEATURES, symptom_patterns: 'redirect loop' }],
    ['a blank entry', { ...FEATURES, symptom_patterns: ['  '] }],
    ['a non-string entry', { ...FEATURES, symptom_patterns: [7] }],
    [
      'an entry past the length bound',
      {
        ...FEATURES,
        symptom_patterns: ['z'.repeat(MEMORY_SEARCH_MAX_STRUCTURAL_FEATURE_LENGTH + 1)],
      },
    ],
    [
      'more entries than the bound',
      {
        ...FEATURES,
        symptom_patterns: Array.from(
          { length: MEMORY_SEARCH_MAX_STRUCTURAL_FEATURE_ITEMS + 1 },
          (_, index) => `pattern ${String(index)}`,
        ),
      },
    ],
    ['a blank problem domain', { ...FEATURES, problem_domain: ' ' }],
    ['a non-string problem domain', { ...FEATURES, problem_domain: 7 }],
    ['features that are not an object', 'deployment'],
  ])('refuses current_features with %s', async (_case, current_features) => {
    await refusesWithoutAsking(PROBLEM_ID, { ...REQUEST, current_features }, 'search request');
  });

  it('says nothing about the request in what it raises', async () => {
    const planted = 'plantedsemanticmarker-Zx9Q';
    const plantedFeature = 'plantedfeaturemarker-Kf2W';
    const { fetch } = recordingFetch(() => jsonResponse(200, SEARCHED));

    const error = await client({ fetch })
      .search(PROBLEM_ID, {
        ...REQUEST,
        // Invalid because the version is wrong; the texts are valid and are the
        // thing that must not travel into an error.
        semantic_text: planted,
        current_features: { ...FEATURES, schema_version: '2', problem_domain: plantedFeature },
      })
      .catch((raised: unknown) => raised);

    const serialized = `${(error as Error).message} ${JSON.stringify(error)} ${String((error as Error).stack)}`;
    for (const secret of [planted, plantedFeature, CREDENTIAL]) {
      expect(`leaked:${serialized.includes(secret)}`).toBe('leaked:false');
    }
    // What it does say is the argument's name, which this package chose.
    expect((error as Error).message).toBe(
      'The Memory API client was given an unusable search request.',
    );
  });
});

describe('what a search returns', () => {
  it('returns a SEARCHED body exactly as it arrived', async () => {
    const { memory } = answering(200, SEARCHED);

    const outcome = await memory.search(PROBLEM_ID, REQUEST);

    // The lossless witness. Nothing renamed, nothing parsed into a `Date`,
    // nothing sorted, nothing de-duplicated, no rank renumbered, no null
    // dropped, no failed Verification filtered out.
    expect(outcome).toEqual(SEARCHED);
  });

  it('keeps the order the server produced, ranks and all', async () => {
    const { memory } = answering(200, SEARCHED);

    const outcome = (await memory.search(PROBLEM_ID, REQUEST)) as unknown as {
      candidates: { ranking: { ranking_rank: number; hybrid_rank: number } }[];
    };

    // Given rank 3 first and rank 1 second, and returned that way. The server
    // decided this order; a client that improved it would be answering a
    // question nobody asked, and the gap between the two ranks — 9 against 4 —
    // is the visible trace of candidates dropped between the stages.
    expect(outcome.candidates.map((entry) => entry.ranking.ranking_rank)).toEqual([3, 1]);
    expect(outcome.candidates.map((entry) => entry.ranking.hybrid_rank)).toEqual([9, 4]);
  });

  it('treats a search that found nothing as an ordinary answer', async () => {
    const empty = { ...SEARCHED, candidates: [] };
    const { memory } = answering(200, empty);

    expect(await memory.search(PROBLEM_ID, REQUEST)).toEqual(empty);
  });

  it.each([['USED'], ['SKIPPED_SENSITIVE_QUERY'], ['PROVIDER_UNAVAILABLE']])(
    'reads %s as a semantic channel status',
    async (semantic_status) => {
      const { memory } = answering(200, { ...SEARCHED, semantic_status });

      expect(await memory.search(PROBLEM_ID, REQUEST)).toMatchObject({ semantic_status });
    },
  );

  it.each([
    ['USED'],
    ['NOT_NEEDED'],
    ['SKIPPED_SENSITIVE_INPUT'],
    ['RERANKER_UNAVAILABLE'],
    ['STRUCTURAL_DATA_UNAVAILABLE'],
  ])('reads %s as a structural stage status', async (structural_status) => {
    const { memory } = answering(200, { ...SEARCHED, structural_status });

    expect(await memory.search(PROBLEM_ID, REQUEST)).toMatchObject({ structural_status });
  });

  it.each([['MEMORY_READ_DISABLED'], ['CURRENT_SOURCE_CHANGED']])(
    'returns %s as the typed answer it is',
    async (kind) => {
      const { memory } = answering(200, { kind });

      // Not an error. An owner's setting being respected, and a race the server
      // noticed, are both facts about the search rather than failures of it.
      expect(await memory.search(PROBLEM_ID, REQUEST)).toEqual({ kind });
    },
  );

  it('normalises a NOT_FOUND into the outcome it means for a search', async () => {
    const { memory } = answering(404, errorEnvelope('NOT_FOUND'));

    // For every other operation a 404 raises: a Problem you asked to read and
    // cannot is a failed read. For a search the Problem is the context, and
    // losing the context is something a caller routinely handles.
    expect(await memory.search(PROBLEM_ID, REQUEST)).toEqual({
      kind: 'CURRENT_PROBLEM_NOT_AVAILABLE',
    });
  });

  it('does not invent that outcome from a status alone', async () => {
    // A 404 whose envelope names a different code came from something that is
    // not saying "this Problem is not available", whatever its status line says.
    const { memory } = answering(404, errorEnvelope('INTERNAL_ERROR'));

    const error = await memory.search(PROBLEM_ID, REQUEST).catch((raised: unknown) => raised);
    expect(error).toBeInstanceOf(MemoryApiError);
    expect((error as MemoryApiError).code).toBe('INTERNAL_ERROR');
  });

  it.each([
    ['a body that is not JSON', 404, 'not json', 'BODY_NOT_JSON'],
    ['an envelope with no error', 404, { request_id: 'req-1' }, 'ERROR_ENVELOPE_MALFORMED'],
    [
      'an envelope with no request id',
      404,
      { error: { code: 'NOT_FOUND' } },
      'ERROR_ENVELOPE_MALFORMED',
    ],
    ['a code nobody has heard of', 404, errorEnvelope('PROBLEM_VANISHED'), 'ERROR_CODE_UNKNOWN'],
  ])('refuses to read %s as a missing Problem', async (_case, status, body, failure) => {
    const { fetch } = recordingFetch(() =>
      typeof body === 'string'
        ? new Response(body, { status, headers: { 'content-type': 'application/json' } })
        : jsonResponse(status, body),
    );

    const error = await client({ fetch })
      .search(PROBLEM_ID, REQUEST)
      .catch((raised: unknown) => raised);

    expect(error).toBeInstanceOf(MemoryApiProtocolError);
    expect((error as MemoryApiProtocolError).failure).toBe(failure);
  });

  it.each([
    [400, 'INVALID_REQUEST'],
    [401, 'UNAUTHENTICATED'],
    [409, 'VERSION_CONFLICT'],
    [500, 'INTERNAL_ERROR'],
  ])('raises a %i as the refusal it is', async (status, code) => {
    const { memory } = answering(status, errorEnvelope(code));

    const error = await memory.search(PROBLEM_ID, REQUEST).catch((raised: unknown) => raised);

    // A 500 in particular is left as it is. It may mean the server's provider
    // integration is broken, which is not a fact about this request, and
    // re-reading it as a channel status or an empty result would erase the one
    // signal that something needs fixing.
    expect(error).toBeInstanceOf(MemoryApiError);
    expect((error as MemoryApiError).status).toBe(status);
    expect((error as MemoryApiError).code).toBe(code);
  });
});

describe('a search answer this contract cannot read', () => {
  /** Every way a `200` can fail to be one of the three outcomes. */
  const MALFORMED: [string, unknown][] = [
    ['no kind at all', { candidates: [], semantic_status: 'USED', structural_status: 'USED' }],
    ['a kind nobody has heard of', { kind: 'PROBABLY_FINE' }],
    ['a typed outcome with a field beside it', { kind: 'MEMORY_READ_DISABLED', retry: true }],
    [
      'a SEARCHED missing its candidates',
      { kind: 'SEARCHED', semantic_status: 'USED', structural_status: 'USED' },
    ],
    ['a SEARCHED with an extra field', { ...SEARCHED, cache_hit: false }],
    ['an unknown semantic status', { ...SEARCHED, semantic_status: 'MAYBE' }],
    ['an unknown structural status', { ...SEARCHED, structural_status: 'MAYBE' }],
    ['candidates that are not a list', { ...SEARCHED, candidates: {} }],
  ];

  /** The same, one level down: every nested object is closed too. */
  function candidateWith(patch: (candidate: typeof CANDIDATE) => unknown): unknown {
    return { ...SEARCHED, candidates: [patch(structuredClone(CANDIDATE))] };
  }

  const MALFORMED_NESTED: [string, unknown][] = [
    [
      'a candidate missing a kind of material',
      candidateWith((candidate) => {
        const { conflict, ...rest } = candidate;
        void conflict;
        return rest;
      }),
    ],
    [
      'a candidate with a field nobody has heard of',
      candidateWith((candidate) => ({ ...candidate, verdict: 'strong' })),
    ],
    [
      'a ranking missing a field',
      candidateWith((candidate) => {
        const { hybrid_rank, ...ranking } = candidate.ranking;
        void hybrid_rank;
        return { ...candidate, ranking };
      }),
    ],
    [
      'an unknown confidence',
      candidateWith((candidate) => ({
        ...candidate,
        ranking: { ...candidate.ranking, confidence: 'VERY_HIGH' },
      })),
    ],
    [
      'an unknown freshness',
      candidateWith((candidate) => ({
        ...candidate,
        ranking: { ...candidate.ranking, freshness: 'FRESH' },
      })),
    ],
    [
      'an unknown project relation',
      candidateWith((candidate) => ({
        ...candidate,
        ranking: { ...candidate.ranking, project_relation: 'SOMEWHERE_ELSE' },
      })),
    ],
    [
      'a hybrid rank that is not a position',
      candidateWith((candidate) => ({
        ...candidate,
        ranking: { ...candidate.ranking, hybrid_rank: 0 },
      })),
    ],
    [
      'a ranking rank that is not whole',
      candidateWith((candidate) => ({
        ...candidate,
        ranking: { ...candidate.ranking, ranking_rank: 1.5 },
      })),
    ],
    [
      'a matched dimension nobody has heard of',
      candidateWith((candidate) => ({
        ...candidate,
        ranking: { ...candidate.ranking, matched_dimensions: ['vibes'] },
      })),
    ],
    [
      'a structural score that is neither a number nor null',
      candidateWith((candidate) => ({
        ...candidate,
        ranking: { ...candidate.ranking, structural_score: 'high' },
      })),
    ],
    [
      'only some of the required checks',
      candidateWith((candidate) => ({
        ...candidate,
        revalidation: { ...candidate.revalidation, required_checks: ['CURRENT_CODE'] },
      })),
    ],
    [
      'a required check listed twice',
      candidateWith((candidate) => ({
        ...candidate,
        revalidation: {
          ...candidate.revalidation,
          required_checks: ['CURRENT_CODE', 'CURRENT_CODE', 'RELEVANT_VERSION', 'OFFICIAL_SPEC'],
        },
      })),
    ],
    [
      'a required check nobody has heard of',
      candidateWith((candidate) => ({
        ...candidate,
        revalidation: {
          ...candidate.revalidation,
          required_checks: ['CURRENT_CODE', 'CURRENT_ENVIRONMENT', 'RELEVANT_VERSION', 'VIBES'],
        },
      })),
    ],
    [
      'an environment that is a list',
      candidateWith((candidate) => ({
        ...candidate,
        revalidation: { ...candidate.revalidation, historical_environment: [] },
      })),
    ],
    [
      'an environment that is null',
      candidateWith((candidate) => ({
        ...candidate,
        revalidation: { ...candidate.revalidation, historical_environment: null },
      })),
    ],
    [
      'a verification kind nobody has heard of',
      candidateWith((candidate) => ({
        ...candidate,
        revalidation: {
          ...candidate.revalidation,
          evidence: [{ ...candidate.revalidation.evidence[0], verification_type: 'VIBE_CHECK' }],
        },
      })),
    ],
    [
      'a verification result that is not a boolean',
      candidateWith((candidate) => ({
        ...candidate,
        revalidation: {
          ...candidate.revalidation,
          evidence: [{ ...candidate.revalidation.evidence[0], result: 'passed' }],
        },
      })),
    ],
    [
      'a dead end missing one of its nullable fields',
      candidateWith((candidate) => {
        const { reason, ...warning } = candidate.dead_end_warnings[0]!;
        void reason;
        return { ...candidate, dead_end_warnings: [warning] };
      }),
    ],
    [
      'a successful direction that is not a string',
      candidateWith((candidate) => ({ ...candidate, successful_directions: [{ text: 'x' }] })),
    ],
    [
      'a conflict with no subject',
      candidateWith((candidate) => ({
        ...candidate,
        conflict: { contradictions: candidate.conflict.contradictions },
      })),
    ],
    [
      'a contradiction with no other side',
      candidateWith((candidate) => ({
        ...candidate,
        conflict: {
          ...candidate.conflict,
          contradictions: [
            {
              reason: candidate.conflict.contradictions[0]!.reason,
              relation_created_at: candidate.conflict.contradictions[0]!.relation_created_at,
            },
          ],
        },
      })),
    ],
    [
      'a fix kind nobody has heard of',
      candidateWith((candidate) => ({
        ...candidate,
        conflict: {
          ...candidate.conflict,
          subject: { ...candidate.conflict.subject, fix_kind: 'PARTIAL' },
        },
      })),
    ],
    [
      'a Problem status nobody has heard of',
      candidateWith((candidate) => ({
        ...candidate,
        conflict: {
          ...candidate.conflict,
          subject: { ...candidate.conflict.subject, status: 'ALMOST_DONE' },
        },
      })),
    ],
  ];

  it.each([...MALFORMED, ...MALFORMED_NESTED])('refuses %s', async (_case, body) => {
    const { memory } = answering(200, body);

    const error = await memory.search(PROBLEM_ID, REQUEST).catch((raised: unknown) => raised);

    expect(error).toBeInstanceOf(MemoryApiProtocolError);
    expect((error as MemoryApiProtocolError).failure).toBe('SEARCH_RESPONSE_MALFORMED');
    expect((error as MemoryApiProtocolError).status).toBe(200);
  });

  it('keeps the body it could not read out of what it raises', async () => {
    const planted = 'plantedmemorymarker-Qq7Ck2V';
    const credentialLooking = 'sk-live-plantedkeymarker-000000000000';
    const { memory } = answering(200, {
      kind: 'SEARCHED',
      candidates: [{ ...CANDIDATE, verdict: planted }],
      semantic_status: 'USED',
      structural_status: credentialLooking,
    });

    const error = await memory.search(PROBLEM_ID, REQUEST).catch((raised: unknown) => raised);

    // On a success path a malformed body is Memory content; on any path it is
    // whatever answered. Neither belongs in an error that travels into a log.
    const serialized = `${(error as Error).message} ${JSON.stringify(error)} ${String((error as Error).stack)}`;
    for (const secret of [planted, credentialLooking]) {
      expect(`leaked:${serialized.includes(secret)}`).toBe('leaked:false');
    }
    expect((error as { cause?: unknown }).cause).toBeUndefined();
  });
});

describe('how long a search may take', () => {
  /** Watches the one call that makes a request finite. */
  function withTimeoutSpy(): { deadlines: number[]; restore: () => void } {
    const deadlines: number[] = [];
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      deadlines.push(ms);
      // A real signal, so nothing downstream behaves differently for the spy.
      return new AbortController().signal;
    });
    return { deadlines, restore: () => spy.mockRestore() };
  }

  it('gives an ordinary read the ordinary ceiling', async () => {
    const { deadlines, restore } = withTimeoutSpy();
    try {
      const { fetch } = recordingFetch(() => jsonResponse(404, errorEnvelope('NOT_FOUND')));
      await client({ fetch })
        .getProblem(PROBLEM_ID)
        .catch(() => undefined);
    } finally {
      restore();
    }

    expect(deadlines).toEqual([MEMORY_API_REQUEST_TIMEOUT_MS]);
  });

  it('gives a search its own longer ceiling', async () => {
    const { deadlines, restore } = withTimeoutSpy();
    try {
      const { fetch } = recordingFetch(() => jsonResponse(200, SEARCHED));
      await client({ fetch }).search(PROBLEM_ID, REQUEST);
    } finally {
      restore();
    }

    // A cold search runs two provider calls in series behind the server. The
    // ordinary ceiling would abandon searches the server was about to answer.
    expect(deadlines).toEqual([MEMORY_API_SEARCH_TIMEOUT_MS]);
    expect(MEMORY_API_SEARCH_TIMEOUT_MS).toBeGreaterThan(MEMORY_API_REQUEST_TIMEOUT_MS);
  });

  it('lets an explicit ceiling win for every operation', async () => {
    const { deadlines, restore } = withTimeoutSpy();
    try {
      const { fetch } = recordingFetch(() => jsonResponse(200, SEARCHED));
      const memory = createMemoryApiClient({ credential: CREDENTIAL, fetch, timeoutMs: 20 });
      await memory.search(PROBLEM_ID, REQUEST);
      await memory.getProblem(PROBLEM_ID).catch(() => undefined);
    } finally {
      restore();
    }

    // One knob, not one per method: a caller that wants a ceiling wants a
    // ceiling, and a second option would only be a precedence question.
    expect(deadlines).toEqual([20, 20]);
  });

  it('abandons a search that never answers', async () => {
    const fetch: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'TimeoutError'));
        });
      });

    const error = await createMemoryApiClient({ credential: CREDENTIAL, fetch, timeoutMs: 10 })
      .search(PROBLEM_ID, REQUEST)
      .catch((raised: unknown) => raised);

    expect(error).toBeInstanceOf(MemoryApiUnreachableError);
    expect((error as MemoryApiUnreachableError).reason).toBe('ABORTED');
  });
});

describe('a search is one request', () => {
  it.each([
    ['a success', () => jsonResponse(200, SEARCHED)],
    ['a missing Problem', () => jsonResponse(404, errorEnvelope('NOT_FOUND'))],
    ['a refusal', () => jsonResponse(400, errorEnvelope('INVALID_REQUEST'))],
    ['a server fault', () => jsonResponse(500, errorEnvelope('INTERNAL_ERROR'))],
    ['an answer this contract cannot read', () => jsonResponse(200, { kind: 'NOPE' })],
    ['a body that is not JSON', () => new Response('nope', { status: 200 })],
  ])('sends one request for %s', async (_case, answer) => {
    const { fetch, calls } = recordingFetch(answer);

    await client({ fetch })
      .search(PROBLEM_ID, REQUEST)
      .catch(() => undefined);

    // No retries, ever. A retry the caller did not ask for is a second search
    // recorded against the Memory, and a second provider call paid for.
    expect(calls).toHaveLength(1);
  });

  it('sends one request when the transport fails', async () => {
    const calls: unknown[] = [];
    const fetch: FetchLike = () => {
      calls.push(1);
      return Promise.reject(new Error('connect ECONNREFUSED'));
    };

    const error = await client({ fetch })
      .search(PROBLEM_ID, REQUEST)
      .catch((raised: unknown) => raised);

    expect(error).toBeInstanceOf(MemoryApiUnreachableError);
    expect((error as MemoryApiUnreachableError).reason).toBe('TRANSPORT');
    expect(calls).toHaveLength(1);
  });

  it('does not answer an unreachable Memory with an empty result', async () => {
    const fetch: FetchLike = () => Promise.reject(new Error('connect ECONNREFUSED'));

    // Raising rather than returning `SEARCHED` with no candidates. "The Memory
    // said nothing" and "the Memory had nothing" are different facts, and
    // deciding to carry on without memory belongs to an adapter, not here.
    await expect(client({ fetch }).search(PROBLEM_ID, REQUEST)).rejects.toBeInstanceOf(
      MemoryApiUnreachableError,
    );
  });
});
