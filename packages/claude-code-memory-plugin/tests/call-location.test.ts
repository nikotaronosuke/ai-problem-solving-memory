/**
 * Where a call is answered from, end to end through the runtime's own wiring.
 *
 * The defect this covers was not in any rule: every rule already took a
 * directory. It was that the directory came from a value read once, when the
 * server started, so a session that moved on kept being answered about the
 * place it had left. These drive the real compositions against two real
 * repositories and check the one thing the unit tests cannot: that detection
 * and Environment capture both follow the call, and follow it *together*.
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  MemoryApiClient,
  ProblemResource,
  ProjectResource,
} from '@ai-problem-solving-memory/api-client';
import {
  createProblemBindingStore,
  type ProblemBindingStore,
} from '@ai-problem-solving-memory/claude-code-adapter';

import { currentProblem } from '../src/current-problem.js';
import { startFreshProblem } from '../src/problem-actions.js';

const run = promisify(execFile);

const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const OWNER = '99999999-8888-4777-8666-555555555555';

let root: string;
let repoA: string;
let repoB: string;
let bindings: ProblemBindingStore;
let bindingDirectory: string;

/** A real repository, so the real detector has something real to read. */
async function makeRepo(name: string, remote: string, subdir?: string): Promise<string> {
  const dir = join(root, name);
  await mkdir(subdir === undefined ? dir : join(dir, subdir), { recursive: true });
  await writeFile(join(dir, 'README.md'), `# ${name}\n`, 'utf8');
  if (subdir !== undefined) {
    await writeFile(join(dir, subdir, 'README.md'), '# part\n', 'utf8');
  }
  const git = (args: string[]) => run('git', args, { cwd: dir });
  await git(['init', '-q', '-b', name === 'repo-a' ? 'main' : 'trunk']);
  await git(['config', 'user.email', 'nobody@example.invalid']);
  await git(['config', 'user.name', 'Disposable']);
  await git(['config', 'commit.gpgsign', 'false']);
  await git(['remote', 'add', 'origin', remote]);
  await git(['add', '-A']);
  await git(['commit', '-q', '-m', `first commit in ${name}`]);
  return dir;
}

async function headOf(dir: string): Promise<string> {
  return (await run('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'call-location-'));
  repoA = await makeRepo(
    'repo-a',
    'https://github.com/synthetic-c4-fixture/repo-a.git',
    'apps/web',
  );
  repoB = await makeRepo('repo-b', 'https://github.com/synthetic-c4-fixture/repo-b.git');
  bindingDirectory = await mkdtemp(join(tmpdir(), 'call-location-bindings-'));
  bindings = createProblemBindingStore({ directory: bindingDirectory });
}, 60_000);

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(bindingDirectory, { recursive: true, force: true });
});

function project(overrides: Partial<ProjectResource> = {}): ProjectResource {
  return {
    project_id: 'project-a',
    owner_id: OWNER,
    project_name: 'repo-a',
    repo: 'github.com/synthetic-c4-fixture/repo-a',
    platform: null,
    repo_subpath: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function problem(overrides: Partial<ProblemResource> = {}): ProblemResource {
  return {
    problem_id: 'problem-1',
    owner_id: OWNER,
    project_id: 'project-a',
    environment_id: 'environment-1',
    title: 'a title',
    symptoms: 'symptoms',
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

/** A Memory that records what it was told, so the wiring can be read back. */
function memory(projects: readonly ProjectResource[]): {
  client: MemoryApiClient;
  snapshots: Record<string, unknown>[];
} {
  const snapshots: Record<string, unknown>[] = [];
  const client = {
    listProjects: () => Promise.resolve(projects),
    listProblems: () => Promise.resolve([]),
    getProblem: () => Promise.reject(new Error('no Problem read expected')),
    createEnvironment: (_projectId: string, request: { snapshot: Record<string, unknown> }) => {
      snapshots.push(request.snapshot);
      return Promise.resolve({
        environment_id: 'environment-1',
        owner_id: OWNER,
        project_id: 'project-a',
        snapshot: request.snapshot,
        created_at: '2026-01-01T00:00:00.000Z',
      });
    },
    createProblem: () => Promise.resolve(problem()),
    createProject: () => Promise.reject(new Error('no Project registration expected')),
    transitionProblemStatus: () => Promise.reject(new Error('no transition expected')),
    search: () => Promise.reject(new Error('no search expected')),
  } as unknown as MemoryApiClient;
  return { client, snapshots };
}

describe('the Project a call resolves', () => {
  it('follows the directory the call was made from, not one from anywhere else', async () => {
    // Both Projects exist. Which one answers is decided by where this call
    // says it happened — the whole point of carrying it per call.
    const both = [
      project(),
      project({
        project_id: 'project-b',
        project_name: 'repo-b',
        repo: 'github.com/synthetic-c4-fixture/repo-b',
      }),
    ];

    const inA = await currentProblem({
      client: memory(both).client,
      bindingStore: bindings,
      sessionId: SESSION_ID,
      projectDir: repoA,
    });
    const inB = await currentProblem({
      client: memory(both).client,
      bindingStore: bindings,
      sessionId: SESSION_ID,
      projectDir: repoB,
    });

    expect(inA).toEqual({ kind: 'NO_PROBLEM', project_id: 'project-a' });
    expect(inB).toEqual({ kind: 'NO_PROBLEM', project_id: 'project-b' });
  });

  it('reads a subdirectory as part of its repository, not as another one', async () => {
    // A session that moved into `apps/web` is still in repo A. What the
    // subpath means afterwards is the owner's boundary question, and nothing
    // here decides it.
    const outcome = await currentProblem({
      client: memory([project()]).client,
      bindingStore: bindings,
      sessionId: SESSION_ID,
      projectDir: join(repoA, 'apps', 'web'),
    });

    expect(outcome).toEqual({ kind: 'NO_PROBLEM', project_id: 'project-a' });
  });
});

describe('the Environment a new Problem records', () => {
  it('describes the repository the call was made from', async () => {
    const { client, snapshots } = memory([
      project({
        project_id: 'project-b',
        project_name: 'repo-b',
        repo: 'github.com/synthetic-c4-fixture/repo-b',
      }),
    ]);

    const outcome = await startFreshProblem({
      client,
      bindingStore: bindings,
      sessionId: SESSION_ID,
      projectDir: repoB,
      projectId: 'project-b',
      title: 'the export finishes with no rows',
      symptoms: 'an empty file, only on the scheduled run',
    });

    expect(outcome.kind).toBe('STARTED');
    expect(snapshots).toHaveLength(1);
    // repo B is on `trunk` and repo A on `main`, so the branch alone says
    // which one was read.
    expect(snapshots[0]).toEqual({ branch: 'trunk', commit: await headOf(repoB) });
  });

  it('cannot describe one repository while the Project came from another', async () => {
    // The mixed-source failure this correction exists to make impossible: one
    // directory feeds detection and capture, so they cannot disagree.
    const { client, snapshots } = memory([project()]);

    await startFreshProblem({
      client,
      bindingStore: bindings,
      sessionId: SESSION_ID,
      projectDir: repoA,
      projectId: 'project-a',
      title: 'a title',
      symptoms: 'symptoms',
    });

    expect(snapshots[0]).toEqual({ branch: 'main', commit: await headOf(repoA) });
    expect(JSON.stringify(snapshots[0]).includes(await headOf(repoB))).toBe(false);
  });

  it('keeps the directory out of what it stores', async () => {
    const { client, snapshots } = memory([project()]);

    await startFreshProblem({
      client,
      bindingStore: bindings,
      sessionId: SESSION_ID,
      projectDir: join(repoA, 'apps', 'web'),
      projectId: 'project-a',
      title: 'a title',
      symptoms: 'symptoms',
    });

    const stored = JSON.stringify(snapshots[0]);
    expect(stored.includes(repoA)).toBe(false);
    expect(stored.includes('apps')).toBe(false);
  });
});
