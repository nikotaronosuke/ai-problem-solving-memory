/** The current-Problem write compositions: authority, provenance and one-shot writes. */

import { describe, expect, it } from 'vitest';

import {
  MemoryApiError,
  type AppendEventRequest,
  type AppendVerificationRequest,
  type CloseProblemRequest,
  type EventResource,
  type MemoryApiClient,
  type ProblemResource,
  type ProjectResource,
  type TransitionProblemStatusRequest,
  type VerificationResource,
} from '@ai-problem-solving-memory/api-client';

import {
  addEventToCurrentProblem,
  addVerificationToCurrentProblem,
  closeCurrentProblem,
  markCurrentProblemFixCandidate,
} from '../src/problem-recording.js';
import type { ProblemBindingWriter } from '../src/problem-lifecycle.js';
import type { GitRunner } from '../src/project-signals.js';
import { CLAUDE_CODE_SOURCE_AI } from '../src/source-ai.js';

const SESSION_ID = 'session-for-recording';
const PROJECT_ID = '22222222-3333-4444-8555-666666666666';
const PROBLEM_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
const OTHER_PROBLEM_ID = 'bbbbbbbb-1111-4222-8333-444444444444';
const EVENT_ID = 'cccccccc-1111-4222-8333-444444444444';
const VERIFICATION_ID = 'dddddddd-1111-4222-8333-444444444444';
const CLIENT_EVENT_ID = 'eeeeeeee-1111-4222-8333-444444444444';
const REPO = 'github.com/acme/widget';
const PROJECT_DIR = '/work/widget';

const git: GitRunner = (args) => {
  const answers: Record<string, string> = {
    'rev-parse --show-toplevel': PROJECT_DIR,
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
    environment_id: 'ffffffff-1111-4222-8333-444444444444',
    title: 'the export is empty',
    symptoms: 'the scheduled run writes no rows',
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

function event(overrides: Partial<EventResource> = {}): EventResource {
  return {
    event_id: EVENT_ID,
    owner_id: '99999999-8888-4777-8666-555555555555',
    problem_id: PROBLEM_ID,
    event_type: 'DEAD_END',
    summary: 'the cache hypothesis did not reproduce',
    result: null,
    reason: null,
    source_ai: CLAUDE_CODE_SOURCE_AI,
    evidence_ref: null,
    client_event_id: CLIENT_EVENT_ID,
    created_at: '2026-01-03T00:00:00.000Z',
    ...overrides,
  };
}

function verification(overrides: Partial<VerificationResource> = {}): VerificationResource {
  return {
    verification_id: VERIFICATION_ID,
    owner_id: '99999999-8888-4777-8666-555555555555',
    problem_id: PROBLEM_ID,
    verification_type: 'TEST',
    result: true,
    summary: 'the regression suite passed',
    evidence_ref: null,
    verified_by: CLAUDE_CODE_SOURCE_AI,
    client_event_id: CLIENT_EVENT_ID,
    created_at: '2026-01-03T00:00:00.000Z',
    ...overrides,
  };
}

interface Calls {
  gets: string[];
  events: { problemId: string; request: AppendEventRequest }[];
  verifications: { problemId: string; request: AppendVerificationRequest }[];
  transitions: { problemId: string; request: TransitionProblemStatusRequest }[];
  closes: { problemId: string; request: CloseProblemRequest }[];
}

function world(
  options: {
    projects?: readonly ProjectResource[];
    problems?: readonly ProblemResource[];
    gets?: readonly (ProblemResource | Error)[];
    binding?: { projectId: string; problemId: string };
    event?: EventResource | Error;
    verification?: VerificationResource | Error;
    transition?: ProblemResource | Error;
    close?: ProblemResource | Error;
  } = {},
): { client: MemoryApiClient; bindingStore: ProblemBindingWriter; calls: Calls } {
  const calls: Calls = { gets: [], events: [], verifications: [], transitions: [], closes: [] };
  let getIndex = 0;
  const answer = <T>(value: T | Error): Promise<T> =>
    value instanceof Error ? Promise.reject(value) : Promise.resolve(value);

  const client = {
    listProjects: () => Promise.resolve(options.projects ?? [project()]),
    listProblems: () => Promise.resolve(options.problems ?? []),
    getProblem: (problemId: string) => {
      calls.gets.push(problemId);
      const values = options.gets ?? [problem(), problem()];
      const value = values[Math.min(getIndex++, values.length - 1)];
      return answer(value ?? new Error('missing get fixture'));
    },
    appendEvent: (problemId: string, request: AppendEventRequest) => {
      calls.events.push({ problemId, request });
      return answer(options.event ?? event());
    },
    appendVerification: (problemId: string, request: AppendVerificationRequest) => {
      calls.verifications.push({ problemId, request });
      return answer(options.verification ?? verification());
    },
    transitionProblemStatus: (problemId: string, request: TransitionProblemStatusRequest) => {
      calls.transitions.push({ problemId, request });
      return answer(
        options.transition ??
          problem({ status: request.target_status, version: request.expected_version + 1 }),
      );
    },
    closeProblem: (problemId: string, request: CloseProblemRequest) => {
      calls.closes.push({ problemId, request });
      return answer(
        options.close ??
          problem({ status: request.target_status, version: request.expected_version + 1 }),
      );
    },
  } as unknown as MemoryApiClient;

  const bindingStore: ProblemBindingWriter = {
    readBinding: () =>
      Promise.resolve(
        options.binding === undefined
          ? {
              kind: 'VALID' as const,
              binding: { projectId: PROJECT_ID, problemId: PROBLEM_ID },
            }
          : { kind: 'VALID' as const, binding: options.binding },
      ),
    writeBinding: () => Promise.reject(new Error('recording must not write a binding')),
  };

  return { client, bindingStore, calls };
}

const context = (built: ReturnType<typeof world>) => ({
  client: built.client,
  bindingStore: built.bindingStore,
  sessionId: SESSION_ID,
  projectDir: PROJECT_DIR,
  runGit: git,
});

describe('current-Problem evidence recording', () => {
  it('revalidates twice and appends one Event with runtime provenance and the exact key', async () => {
    const built = world();

    await expect(
      addEventToCurrentProblem({
        ...context(built),
        eventType: 'DEAD_END',
        summary: 'the cache hypothesis did not reproduce',
        clientEventId: CLIENT_EVENT_ID,
        result: null,
        reason: 'the failure remains with a cold cache',
        evidenceRef: 'commit:abc1234',
      }),
    ).resolves.toEqual({
      kind: 'EVENT_RECORDED',
      problemId: PROBLEM_ID,
      eventId: EVENT_ID,
      clientEventId: CLIENT_EVENT_ID,
      onCurrentProblem: true,
    });

    expect(built.calls.gets).toEqual([PROBLEM_ID, PROBLEM_ID]);
    expect(built.calls.events).toEqual([
      {
        problemId: PROBLEM_ID,
        request: {
          event_type: 'DEAD_END',
          summary: 'the cache hypothesis did not reproduce',
          client_event_id: CLIENT_EVENT_ID,
          source_ai: CLAUDE_CODE_SOURCE_AI,
          result: null,
          reason: 'the failure remains with a cold cache',
          evidence_ref: 'commit:abc1234',
        },
      },
    ]);
  });

  it('reports an owner-wide idempotency-key replay from another Problem without lying', async () => {
    const built = world({ event: event({ problem_id: OTHER_PROBLEM_ID }) });

    const outcome = await addEventToCurrentProblem({
      ...context(built),
      eventType: 'DEAD_END',
      summary: 'a retry',
      clientEventId: CLIENT_EVENT_ID,
    });

    expect(outcome).toMatchObject({
      kind: 'EVENT_RECORDED',
      problemId: OTHER_PROBLEM_ID,
      onCurrentProblem: false,
    });
    expect(built.calls.events).toHaveLength(1);
  });

  it('appends one Verification and fixes verified_by at the runtime boundary', async () => {
    const built = world();

    await expect(
      addVerificationToCurrentProblem({
        ...context(built),
        verificationType: 'TEST',
        result: false,
        summary: 'the regression still fails',
        clientEventId: CLIENT_EVENT_ID,
      }),
    ).resolves.toMatchObject({
      kind: 'VERIFICATION_RECORDED',
      problemId: PROBLEM_ID,
      onCurrentProblem: true,
    });
    expect(built.calls.verifications).toEqual([
      {
        problemId: PROBLEM_ID,
        request: {
          verification_type: 'TEST',
          result: false,
          summary: 'the regression still fails',
          client_event_id: CLIENT_EVENT_ID,
          verified_by: CLAUDE_CODE_SOURCE_AI,
        },
      },
    ]);
  });

  it('reports an owner-wide Verification key replay from another Problem without lying', async () => {
    const built = world({ verification: verification({ problem_id: OTHER_PROBLEM_ID }) });

    const outcome = await addVerificationToCurrentProblem({
      ...context(built),
      verificationType: 'TEST',
      result: true,
      summary: 'a retry',
      clientEventId: CLIENT_EVENT_ID,
    });

    expect(outcome).toMatchObject({
      kind: 'VERIFICATION_RECORDED',
      problemId: OTHER_PROBLEM_ID,
      onCurrentProblem: false,
    });
    expect(built.calls.verifications).toHaveLength(1);
  });
});

describe('current-Problem close', () => {
  it('uses the final read version once and fixes changed_by at the runtime boundary', async () => {
    const built = world({ gets: [problem({ version: 4 }), problem({ version: 9 })] });

    await expect(
      closeCurrentProblem({
        ...context(built),
        targetStatus: 'CLOSED_UNRESOLVED',
        fixKind: null,
        deadEndSummary: 'the external dependency cannot be changed',
      }),
    ).resolves.toEqual({
      kind: 'PROBLEM_CLOSED',
      problemId: PROBLEM_ID,
      status: 'CLOSED_UNRESOLVED',
      version: 10,
    });
    expect(built.calls.closes).toEqual([
      {
        problemId: PROBLEM_ID,
        request: {
          expected_version: 9,
          changed_by: CLAUDE_CODE_SOURCE_AI,
          target_status: 'CLOSED_UNRESOLVED',
          fix_kind: null,
          dead_end_summary: 'the external dependency cannot be changed',
        },
      },
    ]);
  });

  it('does not retry a close conflict', async () => {
    const built = world({ close: new MemoryApiError(409, 'VERSION_CONFLICT', 'request') });

    await expect(
      closeCurrentProblem({ ...context(built), targetStatus: 'PAUSED' }),
    ).rejects.toBeInstanceOf(MemoryApiError);
    expect(built.calls.closes).toHaveLength(1);
  });
});

describe('current-Problem fix candidate', () => {
  it('uses the final read version once and fixes target and actor at the runtime boundary', async () => {
    const built = world({ gets: [problem({ version: 4 }), problem({ version: 9 })] });

    await expect(markCurrentProblemFixCandidate(context(built))).resolves.toEqual({
      kind: 'FIX_CANDIDATE_MARKED',
      problemId: PROBLEM_ID,
      status: 'FIX_CANDIDATE',
      version: 10,
    });
    expect(built.calls.transitions).toEqual([
      {
        problemId: PROBLEM_ID,
        request: {
          expected_version: 9,
          changed_by: CLAUDE_CODE_SOURCE_AI,
          target_status: 'FIX_CANDIDATE',
        },
      },
    ]);
  });

  it('does not retry a transition conflict', async () => {
    const built = world({
      transition: new MemoryApiError(409, 'VERSION_CONFLICT', 'request'),
    });

    await expect(markCurrentProblemFixCandidate(context(built))).rejects.toBeInstanceOf(
      MemoryApiError,
    );
    expect(built.calls.transitions).toHaveLength(1);
  });
});

describe('write refusals', () => {
  it('does not select even one candidate when no binding exists', async () => {
    const built = world({
      problems: [problem()],
      binding: { projectId: PROJECT_ID, problemId: OTHER_PROBLEM_ID },
      gets: [new MemoryApiError(404, 'NOT_FOUND', 'request')],
    });

    await expect(
      addEventToCurrentProblem({
        ...context(built),
        eventType: 'ATTEMPT',
        summary: 'a try',
        clientEventId: CLIENT_EVENT_ID,
      }),
    ).resolves.toEqual({ kind: 'NO_CURRENT_PROBLEM' });
    expect(built.calls.events).toEqual([]);
  });

  it('refuses when the final read says the bound Problem is no longer working', async () => {
    const built = world({ gets: [problem(), problem({ status: 'PAUSED' })] });

    await expect(
      addVerificationToCurrentProblem({
        ...context(built),
        verificationType: 'BUILD',
        result: true,
        summary: 'the build passed',
        clientEventId: CLIENT_EVENT_ID,
      }),
    ).resolves.toEqual({ kind: 'NO_CURRENT_PROBLEM' });
    expect(built.calls.verifications).toEqual([]);
  });

  it('distinguishes a Problem disappearing on the final read from an outage', async () => {
    const built = world({
      gets: [problem(), new MemoryApiError(404, 'NOT_FOUND', 'request')],
    });

    await expect(
      closeCurrentProblem({ ...context(built), targetStatus: 'PAUSED' }),
    ).resolves.toEqual({ kind: 'CURRENT_PROBLEM_NOT_AVAILABLE' });
    expect(built.calls.closes).toEqual([]);
  });
});
