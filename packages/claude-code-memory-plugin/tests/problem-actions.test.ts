/**
 * The three operations that act once somebody knows which Problem they mean.
 *
 * Every one of them is asked to carry out a decision made against something a
 * caller saw in an earlier turn, so almost every assertion here is about
 * *refusing* to carry it out — and about how little happens when it refuses. A
 * Project that has moved must stop the call before a Problem is read, before an
 * Environment is captured and before the binding store is touched, because each
 * of those would be acting under a Project nobody chose.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MemoryApiError,
  MemoryApiUnreachableError,
  type MemoryApiClient,
  type ProblemResource,
  type ProjectResource,
} from '@ai-problem-solving-memory/api-client';
import {
  createProblemBindingStore,
  type GitRunner,
  type ProblemBindingStore,
} from '@ai-problem-solving-memory/claude-code-adapter';

import {
  continueChosenProblem,
  resumePausedProblem,
  startFreshProblem,
} from '../src/problem-actions.js';

const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const PROJECT_ID = '22222222-3333-4444-8555-666666666666';
const OTHER_PROJECT_ID = '77777777-6666-4555-8444-333333333333';
const PROBLEM_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
const OTHER_PROBLEM_ID = 'bbbbbbbb-1111-4222-8333-444444444444';
const REPO = 'github.com/acme/widget';

/** Synthetic. Stands in for anything that must not reach a result. */
const PLANTED = 'a-value-nobody-should-see-in-a-tool-result';

let bindings: ProblemBindingStore;
let bindingDirectory: string;
let projectDir: string;

beforeEach(async () => {
  bindingDirectory = await mkdtemp(join(tmpdir(), 'actions-bindings-'));
  projectDir = await mkdtemp(join(tmpdir(), 'actions-root-'));
  bindings = createProblemBindingStore({ directory: bindingDirectory });
});

afterEach(async () => {
  await rm(bindingDirectory, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

/** A checkout of `REPO`, which is what makes a Project resolvable. */
const git: GitRunner = (args) => {
  const answers: Record<string, string> = {
    'rev-parse --show-toplevel': '/repo',
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
    title: 'the build fails only on the second run',
    symptoms: PLANTED,
    problem_domain: null,
    suspected_boundary: null,
    source_ai: 'claude-code',
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

interface Log {
  readonly order: string[];
  readonly transitions: unknown[];
}

/** A Memory that records what was asked of it, so silence can be asserted. */
function memory(answers: {
  projects?: readonly ProjectResource[] | Error;
  problems?: readonly ProblemResource[] | Error;
  getProblem?: ProblemResource | Error;
  transition?: ProblemResource | Error;
  createdProblem?: ProblemResource | Error;
}): { client: MemoryApiClient; log: Log } {
  const log: Log = { order: [], transitions: [] };

  const answer = <T>(value: T | Error | undefined, absent: string): Promise<T> => {
    if (value === undefined) {
      return Promise.reject(new Error(absent));
    }
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  };

  const client = {
    listProjects: () => {
      log.order.push('listProjects');
      return answer(answers.projects, 'no Projects expected');
    },
    listProblems: () => {
      log.order.push('listProblems');
      return answer(answers.problems, 'no Problems expected');
    },
    getProblem: () => {
      log.order.push('getProblem');
      return answer(answers.getProblem, 'no Problem read expected');
    },
    transitionProblemStatus: (_id: string, request: unknown) => {
      log.order.push('transitionProblemStatus');
      log.transitions.push(request);
      return answer(answers.transition, 'no transition expected');
    },
    createEnvironment: () => {
      log.order.push('createEnvironment');
      return Promise.resolve({
        environment_id: 'cccccccc-1111-4222-8333-444444444444',
        owner_id: '99999999-8888-4777-8666-555555555555',
        project_id: PROJECT_ID,
        snapshot: {},
        created_at: '2026-01-01T00:00:00.000Z',
      });
    },
    createProblem: () => {
      log.order.push('createProblem');
      return answer(answers.createdProblem ?? problem(), 'no Problem create expected');
    },
    createProject: () => {
      log.order.push('createProject');
      return Promise.reject(new Error('a mutation tool must never register a Project'));
    },
    search: () => Promise.reject(new Error('no search expected')),
  } as unknown as MemoryApiClient;

  return { client, log };
}

const base = (client: MemoryApiClient) => ({
  client,
  bindingStore: bindings,
  sessionId: SESSION_ID,
  projectDir,
  projectId: PROJECT_ID,
  runGit: git,
});

/** A Project the session is not in, so any supplied identity is stale. */
const elsewhere = () => memory({ projects: [project({ project_id: OTHER_PROJECT_ID })] });

describe('carrying on with a chosen Problem', () => {
  it('continues one that is still being worked on', async () => {
    const { client } = memory({ projects: [project()], getProblem: problem() });

    await expect(
      continueChosenProblem({ ...base(client), problemId: PROBLEM_ID }),
    ).resolves.toEqual({
      kind: 'CONTINUED',
      projectId: PROJECT_ID,
      problemId: PROBLEM_ID,
      continuity: 'PERSISTED',
    });
  });

  it('is still a continuation when the local note could not be written', async () => {
    const { client } = memory({ projects: [project()], getProblem: problem() });
    const failing = {
      readBinding: bindings.readBinding.bind(bindings),
      writeBinding: () => Promise.resolve({ kind: 'IO_FAILURE' as const }),
      removeBinding: bindings.removeBinding.bind(bindings),
    };

    await expect(
      continueChosenProblem({
        ...base(client),
        bindingStore: failing,
        problemId: PROBLEM_ID,
      }),
    ).resolves.toMatchObject({ kind: 'CONTINUED', continuity: 'NOT_PERSISTED' });
  });

  it('refuses when the Project the caller named is not this session’s', async () => {
    const { client, log } = elsewhere();

    await expect(
      continueChosenProblem({ ...base(client), problemId: PROBLEM_ID }),
    ).resolves.toEqual({ kind: 'PROJECT_SELECTION_STALE' });

    // The whole point: nothing about a Problem was read, and nothing local was
    // touched. A decision made about another Project is not carried out here.
    expect(log.order).toEqual(['listProjects']);
  });

  it.each([
    ['paused', 'PAUSED' as const],
    ['verified', 'VERIFIED' as const],
    ['closed', 'CLOSED_UNRESOLVED' as const],
  ])('refuses a %s Problem without rebinding anything', async (_name, status) => {
    const { client } = memory({
      projects: [project()],
      getProblem: problem({ status }),
      problems: [],
    });

    await expect(
      continueChosenProblem({ ...base(client), problemId: PROBLEM_ID }),
    ).resolves.toEqual({ kind: 'PROBLEM_SELECTION_STALE' });
  });

  it('refuses a Problem that belongs somewhere else', async () => {
    const { client } = memory({
      projects: [project()],
      getProblem: problem({ project_id: OTHER_PROJECT_ID }),
      problems: [],
    });

    await expect(
      continueChosenProblem({ ...base(client), problemId: PROBLEM_ID }),
    ).resolves.toEqual({ kind: 'PROBLEM_SELECTION_STALE' });
  });

  it('says only that the decision no longer holds', async () => {
    // No fresh resolution rides along. A caller that wants to know what is true
    // now has an operation for asking, and a refusal is not it.
    const { client } = memory({
      projects: [project()],
      getProblem: problem({ status: 'PAUSED' }),
      problems: [problem({ status: 'PAUSED' })],
    });

    const outcome = await continueChosenProblem({ ...base(client), problemId: PROBLEM_ID });

    expect(Object.keys(outcome)).toEqual(['kind']);
    expect(JSON.stringify(outcome).includes(PLANTED)).toBe(false);
  });
});

describe('resuming a paused Problem', () => {
  const paused = () => problem({ status: 'PAUSED', version: 7 });

  it.each(['INVESTIGATING', 'FIX_CANDIDATE'] as const)('moves it to %s', async (target) => {
    const { client } = memory({
      projects: [project()],
      getProblem: paused(),
      transition: problem({ status: target, version: 8 }),
    });

    await expect(
      resumePausedProblem({ ...base(client), problemId: PROBLEM_ID, targetStatus: target }),
    ).resolves.toEqual({
      kind: 'RESUMED',
      projectId: PROJECT_ID,
      problemId: PROBLEM_ID,
      status: target,
      continuity: 'PERSISTED',
    });
  });

  it('sends the version it read and its own provenance, never a caller’s', async () => {
    const { client, log } = memory({
      projects: [project()],
      getProblem: paused(),
      transition: problem({ status: 'INVESTIGATING', version: 8 }),
    });

    await resumePausedProblem({
      ...base(client),
      problemId: PROBLEM_ID,
      targetStatus: 'INVESTIGATING',
    });

    expect(log.transitions).toEqual([
      { target_status: 'INVESTIGATING', expected_version: 7, changed_by: 'claude-code' },
    ]);
  });

  it('refuses a stale Project without reading or moving a Problem', async () => {
    const { client, log } = elsewhere();

    await expect(
      resumePausedProblem({
        ...base(client),
        problemId: PROBLEM_ID,
        targetStatus: 'INVESTIGATING',
      }),
    ).resolves.toEqual({ kind: 'PROJECT_SELECTION_STALE' });
    expect(log.order).toEqual(['listProjects']);
  });

  it('refuses one that is no longer paused', async () => {
    const { client, log } = memory({
      projects: [project()],
      getProblem: problem({ status: 'INVESTIGATING' }),
      problems: [],
    });

    await expect(
      resumePausedProblem({
        ...base(client),
        problemId: PROBLEM_ID,
        targetStatus: 'INVESTIGATING',
      }),
    ).resolves.toEqual({ kind: 'PROBLEM_SELECTION_STALE' });
    expect(log.order.includes('transitionProblemStatus')).toBe(false);
  });

  it('propagates a version conflict rather than trying again', async () => {
    const conflict = new MemoryApiError(409, 'VERSION_CONFLICT', 'req-0');
    const { client, log } = memory({
      projects: [project()],
      getProblem: paused(),
      transition: conflict,
    });

    await expect(
      resumePausedProblem({
        ...base(client),
        problemId: PROBLEM_ID,
        targetStatus: 'INVESTIGATING',
      }),
    ).rejects.toBe(conflict);
    expect(log.transitions).toHaveLength(1);
  });

  it('propagates an unanswered transition rather than calling it stale', async () => {
    // Nobody knows whether it committed. Reporting a stale selection would
    // state that it did not.
    const unreachable = new MemoryApiUnreachableError('TRANSPORT');
    const { client } = memory({
      projects: [project()],
      getProblem: paused(),
      transition: unreachable,
    });

    await expect(
      resumePausedProblem({
        ...base(client),
        problemId: PROBLEM_ID,
        targetStatus: 'INVESTIGATING',
      }),
    ).rejects.toBe(unreachable);
  });
});

describe('starting a new Problem', () => {
  it('starts one when nothing is open', async () => {
    const { client } = memory({ projects: [project()], problems: [] });

    await expect(
      startFreshProblem({
        ...base(client),
        title: 'a new one',
        symptoms: 'what was seen',
      }),
    ).resolves.toEqual({
      kind: 'STARTED',
      projectId: PROJECT_ID,
      problemId: PROBLEM_ID,
      status: 'INVESTIGATING',
      continuity: 'PERSISTED',
    });
  });

  it('refuses a stale Project before capturing anything', async () => {
    const { client, log } = elsewhere();

    await expect(
      startFreshProblem({ ...base(client), title: 'a new one', symptoms: 'what was seen' }),
    ).resolves.toEqual({ kind: 'PROJECT_SELECTION_STALE' });

    // No candidates read, no Environment recorded, no Problem created. The
    // Environment matters most: it is a permanent record of conditions, and
    // capturing one for a Project nobody chose would be a fact about the wrong
    // place.
    expect(log.order).toEqual(['listProjects']);
  });

  it('asks the caller to reconsider when work is open and none was considered', async () => {
    const { client, log } = memory({ projects: [project()], problems: [problem()] });

    await expect(
      startFreshProblem({ ...base(client), title: 'a new one', symptoms: 'what was seen' }),
    ).resolves.toMatchObject({ kind: 'RECONSIDER', reason: 'CANDIDATES_PRESENT' });
    expect(log.order.includes('createProblem')).toBe(false);
  });

  it('asks again when the set considered has changed', async () => {
    const { client } = memory({
      projects: [project()],
      problems: [problem(), problem({ problem_id: OTHER_PROBLEM_ID })],
    });

    await expect(
      startFreshProblem({
        ...base(client),
        title: 'a new one',
        symptoms: 'what was seen',
        expectedCandidateProblemIds: [PROBLEM_ID],
      }),
    ).resolves.toMatchObject({ kind: 'RECONSIDER', reason: 'CANDIDATES_CHANGED' });
  });

  it('starts when the caller considered exactly what is open', async () => {
    const { client } = memory({
      projects: [project()],
      problems: [problem(), problem({ problem_id: OTHER_PROBLEM_ID })],
      createdProblem: problem({ problem_id: 'created' }),
    });

    await expect(
      startFreshProblem({
        ...base(client),
        title: 'a new one',
        symptoms: 'what was seen',
        // Order is not part of the claim; identity is.
        expectedCandidateProblemIds: [OTHER_PROBLEM_ID, PROBLEM_ID],
      }),
    ).resolves.toMatchObject({ kind: 'STARTED', problemId: 'created' });
  });

  it('never fills the considered set in on the caller’s behalf', async () => {
    // "The caller considered these" and "the program observed these" are
    // different facts, and the guard is only worth anything as the first.
    const { client } = memory({ projects: [project()], problems: [problem()] });

    const outcome = await startFreshProblem({
      ...base(client),
      title: 'a new one',
      symptoms: 'what was seen',
    });

    expect(outcome.kind).toBe('RECONSIDER');
  });

  it('offers candidates as identities and nothing more', async () => {
    const { client } = memory({ projects: [project()], problems: [problem()] });

    const outcome = await startFreshProblem({
      ...base(client),
      title: 'a new one',
      symptoms: 'what was seen',
    });

    expect(JSON.stringify(outcome).includes(PLANTED)).toBe(false);
  });
});
