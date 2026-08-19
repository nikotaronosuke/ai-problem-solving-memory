/**
 * Turning what the deterministic layers decided into something a tool returns.
 *
 * The interesting assertions are about what does *not* happen: no candidate
 * chosen, no Project picked, no failure turned into an answer, and nothing of
 * a stored record travelling out. The rules themselves are tested where they
 * live; this is about the translation not quietly adding a judgement of its own.
 *
 * Git is supplied rather than run, through the seam the detector already has
 * for it, so these tests describe a repository instead of needing one.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

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

import { currentProblem } from '../src/current-problem.js';

const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const PROJECT_ID = '22222222-3333-4444-8555-666666666666';
const PROBLEM_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
const REPO = 'github.com/acme/widget';

/** Synthetic. Stands in for anything that must not reach a tool result. */
const PLANTED = 'a-value-nobody-should-see-in-a-tool-result';
/** Synthetic. Shaped like a token somebody typed into a remote once. */
const FAKE_TOKEN = 'ghp-fake-token-marker-Zx9Q7Ck2V';

let bindings: ProblemBindingStore;
let bindingDirectory: string;
let projectDir: string;

beforeEach(async () => {
  bindingDirectory = await mkdtemp(join(tmpdir(), 'lifecycle-bindings-'));
  projectDir = await mkdtemp(join(tmpdir(), 'project-root-'));
  bindings = createProblemBindingStore({ directory: bindingDirectory });
});

afterEach(async () => {
  await rm(bindingDirectory, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

/** A checkout of `REPO`, optionally with the session inside a subdirectory. */
function gitSaying(options: { remote?: string | null; toplevel?: string } = {}): GitRunner {
  const remote = options.remote === undefined ? REPO : options.remote;
  const answers: Record<string, string | undefined> = {
    'rev-parse --show-toplevel': options.toplevel ?? projectDir,
    remote: remote === null ? '' : 'origin',
    'remote get-url origin': remote ?? '',
  };
  return (args) => {
    const key = args.join(' ');
    const stdout = answers[key];
    return Promise.resolve(stdout === undefined ? { ok: false, stdout: '' } : { ok: true, stdout });
  };
}

/** Nothing here is a repository at all. */
const noGit: GitRunner = () => Promise.resolve({ ok: false, stdout: '' });

function project(overrides: Partial<ProjectResource> = {}): ProjectResource {
  return {
    project_id: PROJECT_ID,
    owner_id: '99999999-8888-4777-8666-555555555555',
    project_name: 'widget',
    repo: REPO + FAKE_TOKEN,
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
    environment_id: 'bbbbbbbb-1111-4222-8333-444444444444',
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
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

interface MemoryLog {
  readonly creates: number;
}

/** A Memory whose reads are fixed and whose writes are counted. */
function memory(answers: {
  projects?: readonly ProjectResource[] | Error;
  problems?: readonly ProblemResource[] | Error;
  getProblem?: ProblemResource | Error;
  projectsAfterCreate?: readonly ProjectResource[];
}): { client: MemoryApiClient; log: MemoryLog } {
  const log = { creates: 0 };
  let listed = 0;

  const answer = <T>(value: T | Error | undefined, absent: string): Promise<T> => {
    if (value === undefined) {
      return Promise.reject(new Error(absent));
    }
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  };

  const client = {
    listProjects: () => {
      listed += 1;
      if (listed > 1 && answers.projectsAfterCreate !== undefined) {
        return Promise.resolve(answers.projectsAfterCreate);
      }
      return answer(answers.projects, 'the test did not expect Projects to be listed');
    },
    listProblems: () => answer(answers.problems, 'the test did not expect Problems to be listed'),
    getProblem: () => answer(answers.getProblem, 'the test did not expect a Problem to be read'),
    createProject: (request: { project_name: string }) => {
      log.creates += 1;
      return Promise.resolve(project({ ...request, project_id: 'created', repo: REPO }));
    },
    createEnvironment: () => Promise.reject(new Error('no Environment expected')),
    createProblem: () => Promise.reject(new Error('no Problem create expected')),
    transitionProblemStatus: () => Promise.reject(new Error('no transition expected')),
    search: () => Promise.reject(new Error('no search expected')),
  } as unknown as MemoryApiClient;

  return { client, log };
}

function run(client: MemoryApiClient, runGit: GitRunner) {
  return currentProblem({
    client,
    bindingStore: bindings,
    sessionId: SESSION_ID,
    projectDir,
    runGit,
  });
}

describe('when the Project is still a question', () => {
  it('says there is no signal when the host named no project root', async () => {
    // The one case that is genuinely no signal. A directory that is merely not
    // a repository still has a name, which is a weak signal rather than none —
    // and it is answered below.
    const { client } = memory({ projects: [] });

    await expect(
      currentProblem({
        client,
        bindingStore: bindings,
        sessionId: SESSION_ID,
        projectDir: '',
        runGit: noGit,
      }),
    ).resolves.toEqual({ kind: 'NO_PROJECT_SIGNAL' });
  });

  it('asks before recording a directory that is not a repository', async () => {
    const { client, log } = memory({ projects: [] });

    await expect(run(client, noGit)).resolves.toMatchObject({
      kind: 'EXPLICIT_REGISTRATION_REQUIRED',
    });
    expect(log.creates).toBe(0);
  });

  it('asks which part of a repository this is, the first time', async () => {
    const { client, log } = memory({ projects: [] });

    await expect(
      run(client, gitSaying({ toplevel: join(projectDir, '..') })),
    ).resolves.toMatchObject({ kind: 'BOUNDARY_REQUIRED' });
    expect(log.creates).toBe(0);
  });

  it('asks before recording something with no repository', async () => {
    // A name is a label, not an identity, so this never registers on its own.
    const { client, log } = memory({ projects: [] });

    await expect(run(client, gitSaying({ remote: null }))).resolves.toMatchObject({
      kind: 'EXPLICIT_REGISTRATION_REQUIRED',
    });
    expect(log.creates).toBe(0);
  });

  it('offers Projects to choose between rather than choosing', async () => {
    const { client, log } = memory({
      projects: [
        project({ project_id: 'a', repo: REPO }),
        project({ project_id: 'b', repo: REPO }),
      ],
    });

    const outcome = await run(client, gitSaying());

    expect(outcome).toMatchObject({ kind: 'PROJECT_AMBIGUOUS' });
    expect((outcome as { candidates: readonly unknown[] }).candidates).toHaveLength(2);
    expect(log.creates).toBe(0);
  });

  it('never picks the only Project candidate', async () => {
    // One Project on this repository, covering a part of it that this session
    // is not in. That is a question with exactly one candidate, and answering
    // it would be the count deciding which Project somebody is working in.
    const { client, log } = memory({
      projects: [project({ project_id: 'web', repo: REPO, repo_subpath: 'apps/web' })],
    });

    const outcome = await run(client, gitSaying());

    expect(outcome).toMatchObject({
      kind: 'PROJECT_AMBIGUOUS',
      reason: 'NO_MATCHING_REPO_BOUNDARY',
    });
    expect((outcome as { candidates: readonly unknown[] }).candidates).toHaveLength(1);
    expect(log.creates).toBe(0);
  });

  it('never picks the only weakly-matching Project either', async () => {
    // One is still a choice somebody makes. A count deciding it would be the
    // same mistake as a resolver picking the only open Problem.
    const { client } = memory({
      projects: [project({ repo: null, project_name: 'widget' })],
    });

    const outcome = await run(client, gitSaying({ remote: null }));

    expect(outcome.kind).not.toBe('CURRENT_PROBLEM');
    expect(outcome.kind).not.toBe('NO_PROBLEM');
  });
});

describe('when the Project settles', () => {
  const resolved = () => ({ projects: [project({ repo: REPO })] });

  it('registers a repository nothing has recorded, and carries on', async () => {
    const { client, log } = memory({
      projects: [],
      projectsAfterCreate: [project({ project_id: 'created', repo: REPO })],
      problems: [],
    });

    await expect(run(client, gitSaying())).resolves.toEqual({
      kind: 'NO_PROBLEM',
      project_id: 'created',
    });
    // The write this tool can perform, and the reason it is not advertised as
    // read-only.
    expect(log.creates).toBe(1);
  });

  it('answers with nothing to continue when there is nothing', async () => {
    const { client } = memory({ ...resolved(), problems: [] });

    await expect(run(client, gitSaying())).resolves.toEqual({
      kind: 'NO_PROBLEM',
      project_id: PROJECT_ID,
    });
  });

  it('offers one candidate as a candidate', async () => {
    const { client } = memory({ ...resolved(), problems: [problem()] });

    const outcome = await run(client, gitSaying());

    expect(outcome).toMatchObject({ kind: 'PROBLEM_CANDIDATES', project_id: PROJECT_ID });
    expect((outcome as { candidates: readonly unknown[] }).candidates).toEqual([
      { problem_id: PROBLEM_ID, status: 'INVESTIGATING', title: problem().title },
    ]);
  });

  it('offers several', async () => {
    const { client } = memory({
      ...resolved(),
      problems: [problem(), problem({ problem_id: 'other', status: 'PAUSED' })],
    });

    const outcome = await run(client, gitSaying());

    expect((outcome as { candidates: readonly unknown[] }).candidates).toHaveLength(2);
  });

  it('answers with the bound Problem when the binding still holds', async () => {
    await bindings.writeBinding(SESSION_ID, PROJECT_ID, PROBLEM_ID);
    const { client } = memory({ ...resolved(), getProblem: problem() });

    await expect(run(client, gitSaying())).resolves.toEqual({
      kind: 'CURRENT_PROBLEM',
      project_id: PROJECT_ID,
      problem_id: PROBLEM_ID,
    });
  });

  it('falls back through the resolver when the binding no longer holds', async () => {
    // A paused Problem is resumable, which is not the same as being the one in
    // progress — so the hint is discarded and the Project is enumerated.
    await bindings.writeBinding(SESSION_ID, PROJECT_ID, PROBLEM_ID);
    const paused = problem({ status: 'PAUSED' });
    const { client } = memory({ ...resolved(), getProblem: paused, problems: [paused] });

    await expect(run(client, gitSaying())).resolves.toMatchObject({
      kind: 'PROBLEM_CANDIDATES',
    });
  });
});

describe('what a failure is never allowed to become', () => {
  it.each([
    ['a Memory that cannot be reached', new MemoryApiUnreachableError('TRANSPORT')],
    ['a Memory that refused', new MemoryApiError(500, 'INTERNAL_ERROR', 'req-0')],
  ])('propagates %s rather than answering', async (_name, failure: Error) => {
    const { client } = memory({ projects: failure });

    await expect(run(client, gitSaying())).rejects.toBe(failure);
  });

  it('propagates a failure reading Problems too', async () => {
    const unreachable = new MemoryApiUnreachableError('TRANSPORT');
    const { client } = memory({ projects: [project({ repo: REPO })], problems: unreachable });

    await expect(run(client, gitSaying())).rejects.toBe(unreachable);
  });
});

describe('what a result may carry', () => {
  it('carries no stored words and no path from this machine', async () => {
    const { client } = memory({ projects: [project({ repo: REPO })], problems: [problem()] });

    const printed = JSON.stringify(await run(client, gitSaying()));

    for (const secret of [PLANTED, FAKE_TOKEN, projectDir, bindingDirectory, SESSION_ID]) {
      expect(printed.includes(secret)).toBe(false);
    }
  });

  it('answers each shape with exactly its own keys', async () => {
    const cases: readonly (readonly [Promise<unknown>, readonly string[]])[] = [
      [
        currentProblem({
          client: memory({ projects: [] }).client,
          bindingStore: bindings,
          sessionId: SESSION_ID,
          projectDir: '',
          runGit: noGit,
        }),
        ['kind'],
      ],
      [
        run(memory({ projects: [project({ repo: REPO })], problems: [] }).client, gitSaying()),
        ['kind', 'project_id'],
      ],
      [
        run(
          memory({ projects: [project({ repo: REPO })], problems: [problem()] }).client,
          gitSaying(),
        ),
        ['candidates', 'kind', 'project_id'],
      ],
    ];

    for (const [pending, keys] of cases) {
      expect(Object.keys((await pending) as object).sort()).toEqual([...keys]);
    }
  });
});

describe('answering the Project question it asked', () => {
  const web = () => project({ project_id: 'web', repo: REPO, repo_subpath: 'apps/web' });

  it('selects an existing Project a caller chose, after checking it still holds', async () => {
    // Two Projects tie on this repository, so the question is real. The answer
    // is checked against what resolves now rather than against the list it was
    // offered from — a boundary declared in between could have settled it.
    const { client } = memory({
      projects: [
        project({ project_id: 'a', repo: REPO }),
        project({ project_id: 'b', repo: REPO }),
      ],
      problems: [],
    });

    await expect(
      currentProblem({
        client,
        bindingStore: bindings,
        sessionId: SESSION_ID,
        projectDir,
        runGit: gitSaying(),
        projectDecision: { kind: 'SELECT_EXISTING', project_id: 'a' },
      }),
    ).resolves.toEqual({ kind: 'NO_PROBLEM', project_id: 'a' });
  });

  it('reports a chosen Project that no longer resolves, and stops there', async () => {
    const { client, log } = memory({ projects: [project({ project_id: 'a', repo: REPO })] });

    await expect(
      currentProblem({
        client,
        bindingStore: bindings,
        sessionId: SESSION_ID,
        projectDir,
        runGit: gitSaying(),
        projectDecision: { kind: 'SELECT_EXISTING', project_id: 'gone' },
      }),
    ).resolves.toEqual({ kind: 'PROJECT_DECISION_STALE' });

    // Nothing about a Problem was read: the answer was about a Project this
    // session is not in, and acting anyway would file work under it.
    expect(log.creates).toBe(0);
  });

  it('registers the whole repository when that is the answer', async () => {
    const { client, log } = memory({
      projects: [],
      projectsAfterCreate: [project({ project_id: 'created', repo: REPO })],
      problems: [],
    });

    await expect(
      currentProblem({
        client,
        bindingStore: bindings,
        sessionId: SESSION_ID,
        projectDir,
        runGit: gitSaying({ toplevel: join(projectDir, '..') }),
        projectDecision: { kind: 'REPOSITORY_ROOT' },
      }),
    ).resolves.toEqual({ kind: 'NO_PROBLEM', project_id: 'created' });
    expect(log.creates).toBe(1);
  });

  it('registers the part of a repository the owner named', async () => {
    const { client, log } = memory({
      projects: [],
      projectsAfterCreate: [
        project({ project_id: 'created', repo: REPO, repo_subpath: basename(projectDir) }),
      ],
      problems: [],
    });

    await expect(
      currentProblem({
        client,
        bindingStore: bindings,
        sessionId: SESSION_ID,
        projectDir,
        runGit: gitSaying({ toplevel: join(projectDir, '..') }),
        projectDecision: { kind: 'REPOSITORY_BOUNDARY', repo_subpath: basename(projectDir) },
      }),
    ).resolves.toMatchObject({ kind: 'NO_PROBLEM' });
    expect(log.creates).toBe(1);
  });

  it('registers something with no repository when the owner means it', async () => {
    const { client, log } = memory({
      projects: [],
      projectsAfterCreate: [project({ project_id: 'created', repo: null })],
      problems: [],
    });

    await expect(
      currentProblem({
        client,
        bindingStore: bindings,
        sessionId: SESSION_ID,
        projectDir,
        runGit: gitSaying({ remote: null }),
        projectDecision: { kind: 'REGISTER_WITHOUT_REPOSITORY' },
      }),
    ).resolves.toMatchObject({ kind: 'NO_PROBLEM' });
    expect(log.creates).toBe(1);
  });

  it('registers a further part of a repository somebody already split', async () => {
    // The sibling case: one Project covers `apps/web`, this session is not in
    // it, and the answer says this location is its own Project.
    const { client, log } = memory({
      projects: [web()],
      projectsAfterCreate: [
        web(),
        project({
          project_id: 'created',
          repo: REPO,
          repo_subpath: basename(join(projectDir, '..')),
        }),
      ],
      problems: [],
    });

    await expect(
      currentProblem({
        client,
        bindingStore: bindings,
        sessionId: SESSION_ID,
        projectDir,
        runGit: gitSaying({ toplevel: join(projectDir, '..', '..') }),
        // An ancestor of where the session actually is, which is the only kind
        // of boundary that covers it.
        projectDecision: {
          kind: 'REPOSITORY_BOUNDARY',
          repo_subpath: basename(join(projectDir, '..')),
        },
      }),
    ).resolves.toMatchObject({ kind: 'NO_PROBLEM' });
    expect(log.creates).toBe(1);
  });

  it('reports a registration answer that cannot describe this session', async () => {
    // A boundary naming somewhere this session is not inside. That is an answer
    // that went out of date, not a broken program — and the path it named does
    // not come back out.
    const { client, log } = memory({ projects: [] });

    const outcome = await currentProblem({
      client,
      bindingStore: bindings,
      sessionId: SESSION_ID,
      projectDir,
      runGit: gitSaying({ toplevel: join(projectDir, '..') }),
      projectDecision: { kind: 'REPOSITORY_BOUNDARY', repo_subpath: 'somewhere/else-entirely' },
    });

    expect(outcome).toEqual({ kind: 'PROJECT_DECISION_STALE' });
    expect(JSON.stringify(outcome).includes('somewhere/else-entirely')).toBe(false);
    expect(log.creates).toBe(0);
  });

  it('still refuses to create against an ambiguity a choice does not answer', async () => {
    // Two Projects tied on this repository is a duplicate to merge, not a
    // question a registration answers — so the choice changes nothing and the
    // ambiguity is still what comes back.
    const { client, log } = memory({
      projects: [
        project({ project_id: 'a', repo: REPO }),
        project({ project_id: 'b', repo: REPO }),
      ],
    });

    await expect(
      currentProblem({
        client,
        bindingStore: bindings,
        sessionId: SESSION_ID,
        projectDir,
        runGit: gitSaying(),
        projectDecision: { kind: 'REPOSITORY_ROOT' },
      }),
    ).resolves.toMatchObject({ kind: 'PROJECT_AMBIGUOUS' });
    expect(log.creates).toBe(0);
  });

  it('answers a stale decision with a kind and nothing else', async () => {
    const { client } = memory({ projects: [project({ project_id: 'a', repo: REPO })] });

    const outcome = await currentProblem({
      client,
      bindingStore: bindings,
      sessionId: SESSION_ID,
      projectDir,
      runGit: gitSaying(),
      projectDecision: { kind: 'SELECT_EXISTING', project_id: 'gone' },
    });

    expect(Object.keys(outcome)).toEqual(['kind']);
  });
});
