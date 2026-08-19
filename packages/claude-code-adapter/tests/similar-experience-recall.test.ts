/**
 * Looking things up: when it may happen, what is asked, and what escapes.
 *
 * Almost every assertion here is about *not* searching. A lookup that attaches
 * itself to the wrong Problem, or brings a Project into existence, or asks the
 * same question twice, costs somebody real money and puts real records in a
 * Memory nobody chose — so the refusals are the load-bearing part, and the one
 * happy path mostly proves the request was built by the runtime rather than by
 * whoever called.
 */

import { describe, expect, it } from 'vitest';

import {
  MemoryApiError,
  MemoryApiUnreachableError,
  MEMORY_SEARCH_STRUCTURAL_FEATURE_SCHEMA_VERSION,
  type MemoryApiClient,
  type MemorySearchOutcome,
  type MemorySearchRequest,
  type ProblemResource,
  type ProjectResource,
} from '@ai-problem-solving-memory/api-client';

import {
  recallSimilarExperience,
  type RecallFingerprintRead,
  type RecallFingerprintStore,
  type RecallQuery,
} from '../src/similar-experience-recall.js';
import { CLAUDE_CODE_SOURCE_AI } from '../src/source-ai.js';
import type { GitRunner } from '../src/project-signals.js';
import type { ProblemBindingWriter } from '../src/problem-lifecycle.js';

const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const PROJECT_ID = '22222222-3333-4444-8555-666666666666';
const PROBLEM_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
const REPO = 'github.com/acme/widget';
const PROJECT_DIR = '/work/widget';

/** Synthetic. Stands in for anything that must not reach a search request. */
const PLANTED = 'a-value-nobody-should-see-in-a-request';

const git: GitRunner = (args) => {
  const answers: Record<string, string> = {
    'rev-parse --show-toplevel': '/work/widget',
    remote: 'origin',
    'remote get-url origin': REPO,
  };
  const stdout = answers[args.join(' ')];
  return Promise.resolve(stdout === undefined ? { ok: false, stdout: '' } : { ok: true, stdout });
};

function project(overrides: Partial<ProjectResource> = {}): ProjectResource {
  return {
    project_id: PROJECT_ID,
    owner_id: '99999999-8888-4777-8666-555555555555',
    project_name: 'widget',
    repo: REPO,
    platform: null,
    repo_subpath: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function problem(overrides: Partial<ProblemResource> = {}): ProblemResource {
  return {
    problem_id: PROBLEM_ID,
    owner_id: '99999999-8888-4777-8666-555555555555',
    project_id: PROJECT_ID,
    environment_id: 'cccccccc-1111-4222-8333-444444444444',
    title: 'the nightly export finishes with no rows',
    symptoms: PLANTED,
    problem_domain: null,
    suspected_boundary: null,
    source_ai: CLAUDE_CODE_SOURCE_AI,
    status: 'INVESTIGATING',
    fix_kind: null,
    importance: false,
    confidence: 'LOW',
    freshness: 'CURRENT',
    memory_read_enabled: true,
    memory_write_enabled: true,
    suppressed: false,
    version: 4,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

const query: RecallQuery = {
  lexicalText: 'export empty scheduled',
  semanticText: 'the scheduled export reports success and writes an empty file',
  features: {
    problemDomain: 'batch export',
    symptomPatterns: ['empty output file', 'success reported'],
    suspectedBoundaries: ['scheduler'],
    occurrenceConditions: ['only on the scheduled run'],
    successfulDirections: ['checked the writer'],
    deadEndDirections: ['blamed the filesystem'],
    environmentFacts: ['runs under the nightly job'],
  },
};

interface Recorded {
  readonly searches: { problemId: string; request: MemorySearchRequest }[];
  readonly written: string[];
  reads: number;
}

/** A Memory and a local store that both record what they were asked. */
function world(options: {
  projects?: readonly ProjectResource[];
  problems?: readonly ProblemResource[];
  /** Answered in order, so a Problem can be read once and then be gone. */
  getProblem?: readonly (ProblemResource | Error)[];
  search?: MemorySearchOutcome | Error;
  binding?: { projectId: string; problemId: string } | undefined;
  fingerprint?: RecallFingerprintRead;
  writeFails?: boolean;
}): {
  client: MemoryApiClient;
  bindingStore: ProblemBindingWriter;
  fingerprintStore: RecallFingerprintStore;
  recorded: Recorded;
} {
  const recorded: Recorded = { searches: [], written: [], reads: 0 };

  const client = {
    listProjects: () => Promise.resolve(options.projects ?? [project()]),
    listProblems: () => Promise.resolve(options.problems ?? []),
    getProblem: () => {
      const answers = options.getProblem ?? [problem()];
      const answer = answers[Math.min(recorded.reads++, answers.length - 1)];
      return answer instanceof Error
        ? Promise.reject(answer)
        : Promise.resolve(answer as ProblemResource);
    },
    search: (problemId: string, request: MemorySearchRequest) => {
      recorded.searches.push({ problemId, request });
      const answer = options.search ?? {
        kind: 'SEARCHED' as const,
        candidates: [],
        semantic_status: 'USED' as const,
        structural_status: 'USED' as const,
      };
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
    createProject: () => Promise.reject(new Error('a lookup must never register a Project')),
    createProblem: () => Promise.reject(new Error('a lookup must never create a Problem')),
    createEnvironment: () =>
      Promise.reject(new Error('a lookup must never capture an Environment')),
    transitionProblemStatus: () => Promise.reject(new Error('a lookup must never move a Problem')),
  } as unknown as MemoryApiClient;

  const bindingStore: ProblemBindingWriter = {
    readBinding: () =>
      Promise.resolve(
        options.binding === undefined
          ? ({ kind: 'MISSING' } as const)
          : ({ kind: 'VALID', binding: options.binding } as const),
      ),
    writeBinding: () => Promise.reject(new Error('a lookup must never write a binding')),
  };

  const fingerprintStore: RecallFingerprintStore = {
    readFingerprint: () => Promise.resolve(options.fingerprint ?? { kind: 'MISSING' }),
    writeFingerprint: (_problemId, fingerprint) => {
      recorded.written.push(fingerprint);
      return Promise.resolve(
        options.writeFails === true ? { kind: 'NOT_PERSISTED' } : { kind: 'PERSISTED' },
      );
    },
  };

  return { client, bindingStore, fingerprintStore, recorded };
}

const recall = (
  built: ReturnType<typeof world>,
  overrides: { query?: RecallQuery } = {},
): ReturnType<typeof recallSimilarExperience> =>
  recallSimilarExperience({
    client: built.client,
    bindingStore: built.bindingStore,
    fingerprintStore: built.fingerprintStore,
    sessionId: SESSION_ID,
    projectDir: PROJECT_DIR,
    query: overrides.query ?? query,
    runGit: git,
  });

describe('when a lookup may happen at all', () => {
  it('searches once when a bound Problem is the work in progress', async () => {
    const built = world({ binding: { projectId: PROJECT_ID, problemId: PROBLEM_ID } });

    const outcome = await recall(built);

    expect(outcome).toEqual({
      kind: 'RECALLED',
      candidateCount: 0,
      semanticStatus: 'USED',
      structuralStatus: 'USED',
    });
    expect(built.recorded.searches).toHaveLength(1);
    expect(built.recorded.searches[0]?.problemId).toBe(PROBLEM_ID);
  });

  it('refuses when the repository is not a Project anybody registered', async () => {
    // The whole point: `current_problem` may settle this by registering. A
    // lookup may not, because nobody asked for a durable record to appear.
    const built = world({ projects: [] });

    await expect(recall(built)).resolves.toEqual({ kind: 'NO_CURRENT_PROBLEM' });
    expect(built.recorded.searches).toEqual([]);
  });

  it('refuses when two Projects claim this repository', async () => {
    const built = world({
      projects: [project({ project_id: 'a' }), project({ project_id: 'b' })],
    });

    await expect(recall(built)).resolves.toEqual({ kind: 'NO_CURRENT_PROBLEM' });
    expect(built.recorded.searches).toEqual([]);
  });

  it('refuses when the server says there is nothing to continue', async () => {
    const built = world({ problems: [] });

    await expect(recall(built)).resolves.toEqual({ kind: 'NO_CURRENT_PROBLEM' });
    expect(built.recorded.searches).toEqual([]);
  });

  it('refuses when there are candidates, including exactly one', async () => {
    // One candidate is still a candidate. Choosing it here would attach this
    // search — and the usage recorded against it — to a Problem nobody picked.
    const built = world({ problems: [problem()] });

    await expect(recall(built)).resolves.toEqual({ kind: 'NO_CURRENT_PROBLEM' });
    expect(built.recorded.searches).toEqual([]);
  });

  it('refuses when the bound Problem is paused', async () => {
    const built = world({
      binding: { projectId: PROJECT_ID, problemId: PROBLEM_ID },
      getProblem: [problem({ status: 'PAUSED' })],
      problems: [problem({ status: 'PAUSED' })],
    });

    await expect(recall(built)).resolves.toEqual({ kind: 'NO_CURRENT_PROBLEM' });
    expect(built.recorded.searches).toEqual([]);
  });

  it('refuses when the fresh read puts the Problem in another Project', async () => {
    const built = world({
      binding: { projectId: PROJECT_ID, problemId: PROBLEM_ID },
      getProblem: [problem({ project_id: 'somewhere-else' })],
    });

    await expect(recall(built)).resolves.toEqual({ kind: 'NO_CURRENT_PROBLEM' });
    expect(built.recorded.searches).toEqual([]);
  });

  it('refuses when the Problem is paused between resolving it and reading it', async () => {
    // The two reads are the point. Resolution establishes which Problem this
    // session is on; the read after it establishes what that Problem is *now*,
    // because a recall attaches to a Problem's current version and somebody may
    // have paused it in between. Answering the first read and the second one
    // differently is the only way to reach the second check at all — with one
    // answer for both, resolution turns the Problem away and nothing downstream
    // is exercised.
    const built = world({
      binding: { projectId: PROJECT_ID, problemId: PROBLEM_ID },
      getProblem: [problem(), problem({ status: 'PAUSED' })],
    });

    await expect(recall(built)).resolves.toEqual({ kind: 'NO_CURRENT_PROBLEM' });
    expect(built.recorded.searches).toEqual([]);
  });

  it('refuses when the Problem moves to another Project between the two reads', async () => {
    // Not a stale read but a contradiction: the binding named a Problem in one
    // Project and the server now places it in another. Searching anyway would
    // aim this Project's question at somebody else's Problem.
    const built = world({
      binding: { projectId: PROJECT_ID, problemId: PROBLEM_ID },
      getProblem: [problem(), problem({ project_id: 'somewhere-else' })],
    });

    await expect(recall(built)).resolves.toEqual({ kind: 'NO_CURRENT_PROBLEM' });
    expect(built.recorded.searches).toEqual([]);
  });

  it('says the Problem is gone only when the server says so', async () => {
    const built = world({
      binding: { projectId: PROJECT_ID, problemId: PROBLEM_ID },
      getProblem: [problem(), new MemoryApiError(404, 'NOT_FOUND', 'request-1')],
    });

    await expect(recall(built)).resolves.toEqual({ kind: 'CURRENT_PROBLEM_NOT_AVAILABLE' });
    expect(built.recorded.searches).toEqual([]);
  });

  it('lets an unreachable Memory stay unreachable', async () => {
    // "The Memory could not be asked" must never become "you have no Problem".
    const built = world({
      binding: { projectId: PROJECT_ID, problemId: PROBLEM_ID },
      getProblem: [problem(), new MemoryApiUnreachableError('TRANSPORT')],
    });

    await expect(recall(built)).rejects.toBeInstanceOf(MemoryApiUnreachableError);
  });
});

describe('the request that goes out', () => {
  it('is stamped by the runtime, not by the caller', async () => {
    const built = world({ binding: { projectId: PROJECT_ID, problemId: PROBLEM_ID } });

    await recall(built);
    const request = built.recorded.searches[0]?.request;

    expect(request?.source_ai).toBe(CLAUDE_CODE_SOURCE_AI);
    expect(request?.current_features.schema_version).toBe(
      MEMORY_SEARCH_STRUCTURAL_FEATURE_SCHEMA_VERSION,
    );
  });

  it('carries the model’s words through unchanged', async () => {
    const built = world({ binding: { projectId: PROJECT_ID, problemId: PROBLEM_ID } });

    await recall(built);
    const request = built.recorded.searches[0]?.request;

    expect(request?.lexical_text).toBe(query.lexicalText);
    expect(request?.semantic_text).toBe(query.semanticText);
    expect(request?.current_features.problem_domain).toBe('batch export');
    expect(request?.current_features.symptom_patterns).toEqual(query.features.symptomPatterns);
    expect(request?.current_features.dead_end_directions).toEqual(query.features.deadEndDirections);
    expect(request?.current_features.environment_facts).toEqual(query.features.environmentFacts);
  });

  it('carries no identity and nothing read off the Problem', async () => {
    const built = world({ binding: { projectId: PROJECT_ID, problemId: PROBLEM_ID } });

    await recall(built);
    const printed = JSON.stringify(built.recorded.searches[0]?.request);

    // The Problem is named by the call, not by the body; and nothing is
    // harvested out of the stored record into the query.
    for (const forbidden of [PROJECT_ID, PROBLEM_ID, SESSION_ID, PROJECT_DIR, PLANTED]) {
      expect(`the request carries ${forbidden}:${printed.includes(forbidden)}`).toBe(
        `the request carries ${forbidden}:false`,
      );
    }
  });

  it('is sent exactly once, whatever comes back', async () => {
    for (const answer of [
      { kind: 'CURRENT_SOURCE_CHANGED' } as const,
      { kind: 'CURRENT_PROBLEM_NOT_AVAILABLE' } as const,
      { kind: 'MEMORY_READ_DISABLED' } as const,
    ]) {
      const built = world({
        binding: { projectId: PROJECT_ID, problemId: PROBLEM_ID },
        search: answer,
      });
      await recall(built);
      expect(`${answer.kind} searched:${built.recorded.searches.length}`).toBe(
        `${answer.kind} searched:1`,
      );
    }
  });

  it('does not try again when the search itself fails', async () => {
    const built = world({
      binding: { projectId: PROJECT_ID, problemId: PROBLEM_ID },
      search: new MemoryApiUnreachableError('TRANSPORT'),
    });

    await expect(recall(built)).rejects.toBeInstanceOf(MemoryApiUnreachableError);
    expect(built.recorded.searches).toHaveLength(1);
  });
});

describe('what comes back', () => {
  it('counts candidates without letting any of them out', async () => {
    const candidate = {
      ranking: { problem_id: 'other-problem', project_id: 'other-project', score: 0.9 },
      revalidation: { environment_changed: true },
      dead_end_warnings: [{ text: PLANTED }],
      successful_directions: [PLANTED],
      conflict: { kind: 'NONE' },
    };
    const built = world({
      binding: { projectId: PROJECT_ID, problemId: PROBLEM_ID },
      search: {
        kind: 'SEARCHED',
        candidates: [candidate, candidate] as never,
        semantic_status: 'USED',
        structural_status: 'USED',
      },
    });

    const outcome = await recall(built);

    expect(outcome).toEqual({
      kind: 'RECALLED',
      candidateCount: 2,
      semanticStatus: 'USED',
      structuralStatus: 'USED',
    });
    // What was found is somebody else's to present. Nothing about a candidate
    // travels out of here.
    const printed = JSON.stringify(outcome);
    for (const forbidden of ['other-problem', 'other-project', PLANTED, 'ranking', 'conflict']) {
      expect(`the outcome carries ${forbidden}:${printed.includes(forbidden)}`).toBe(
        `the outcome carries ${forbidden}:false`,
      );
    }
  });

  it('reports a degraded stage without judging it', async () => {
    const built = world({
      binding: { projectId: PROJECT_ID, problemId: PROBLEM_ID },
      search: {
        kind: 'SEARCHED',
        candidates: [],
        semantic_status: 'PROVIDER_UNAVAILABLE',
        structural_status: 'RERANKER_UNAVAILABLE',
      },
    });

    await expect(recall(built)).resolves.toEqual({
      kind: 'RECALLED',
      candidateCount: 0,
      semanticStatus: 'PROVIDER_UNAVAILABLE',
      structuralStatus: 'RERANKER_UNAVAILABLE',
    });
  });

  it.each([
    ['MEMORY_READ_DISABLED'],
    ['CURRENT_SOURCE_CHANGED'],
    ['CURRENT_PROBLEM_NOT_AVAILABLE'],
  ] as const)('passes %s through as an ordinary answer', async (kind) => {
    const built = world({
      binding: { projectId: PROJECT_ID, problemId: PROBLEM_ID },
      search: { kind },
    });

    await expect(recall(built)).resolves.toEqual({ kind });
  });
});
