/**
 * What the detector reads, and what it refuses to hand on.
 *
 * Two layers, and both are needed.
 *
 * Most cases inject `runGit`, which is faster, runs on any machine and — more
 * importantly — is the only way to script a repository whose remote carries a
 * credential without writing one to disk. What that layer cannot prove is that
 * the arguments would work against real git.
 *
 * So a second layer builds real repositories in a temporary directory and runs
 * the real `git`: no remote, one remote, several remotes, a nested launch
 * directory and a worktree. Those are skipped when git is not installed, because
 * git being absent is a supported situation rather than a broken test.
 *
 * The absolute-path assertions are the ones to keep honest. They serialise the
 * whole result and check that the temporary directory's own path — which
 * contains this machine's user name — is not anywhere in it.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, describe, expect, it } from 'vitest';

import { detectProjectSignals, type GitRunner } from '../src/index.js';

const run = promisify(execFile);

/** Synthetic. Never written to a real repository. */
const FAKE_TOKEN = 'ghp-fake-token-marker-Zx9Q7Ck2V';

const ROOT = '/home/someone/work/widget';

/**
 * A git that answers from a script rather than from a repository.
 *
 * Keyed by the joined arguments, which is exactly what production passes, so a
 * changed argument list fails here rather than silently matching nothing.
 */
function scriptedGit(script: Record<string, string | null>): GitRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const runner = ((args, options) => {
    void options;
    calls.push([...args]);
    const answer = script[args.join(' ')];
    return Promise.resolve(
      answer === undefined || answer === null
        ? { ok: false, stdout: '' }
        : { ok: true, stdout: answer },
    );
  }) as GitRunner & { calls: string[][] };
  runner.calls = calls;
  return runner;
}

/** A repository at `ROOT` with these remotes, as git would report them. */
function repositoryWith(remotes: Record<string, string>, toplevel = ROOT) {
  const script: Record<string, string | null> = {
    'rev-parse --show-toplevel': toplevel,
    remote: Object.keys(remotes).join('\n'),
  };
  for (const [name, url] of Object.entries(remotes)) {
    script[`remote get-url ${name}`] = url;
  }
  return scriptedGit(script);
}

describe('when there is no project root', () => {
  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['whitespace', '   '],
  ])('reports no signal at all for a root that is %s', async (_case, projectDir) => {
    const runGit = scriptedGit({});

    // Null rather than an error: a session may legitimately be running somewhere
    // that is not a project, and that is an answer.
    expect(await detectProjectSignals({ projectDir, runGit })).toBeNull();
    expect(runGit.calls).toEqual([]);
  });
});

describe('a project that is not in a repository', () => {
  it('reports the name and nothing else', async () => {
    const runGit = scriptedGit({ 'rev-parse --show-toplevel': null });

    const signals = await detectProjectSignals({ projectDir: ROOT, runGit });

    // Git being absent from the machine and the root not being a repository are
    // the same answer here, deliberately: the caller's next step is the same.
    expect(signals).toEqual({
      projectNameHint: 'widget',
      insideGit: false,
      primaryRemote: null,
      secondaryRemotes: [],
      monorepoSubpath: null,
    });
  });

  it('does not go looking for remotes it cannot have', async () => {
    const runGit = scriptedGit({ 'rev-parse --show-toplevel': null });

    await detectProjectSignals({ projectDir: ROOT, runGit });

    expect(runGit.calls).toEqual([['rev-parse', '--show-toplevel']]);
  });
});

describe('a repository with no remote', () => {
  it('is inside git and has no identity', async () => {
    const runGit = repositoryWith({});

    const signals = await detectProjectSignals({ projectDir: ROOT, runGit });

    expect(signals?.insideGit).toBe(true);
    expect(signals?.primaryRemote).toBeNull();
    expect(signals?.secondaryRemotes).toEqual([]);
  });
});

describe('which remote speaks for a checkout', () => {
  it('uses origin when there is one', async () => {
    const runGit = repositoryWith({
      upstream: 'https://github.com/upstream/base.git',
      origin: 'git@github.com:acme/widget.git',
    });

    const signals = await detectProjectSignals({ projectDir: ROOT, runGit });

    expect(signals?.primaryRemote).toBe('github.com/acme/widget');
    expect(signals?.secondaryRemotes).toEqual(['github.com/upstream/base']);
  });

  it('uses the only remote when there is exactly one and no origin', async () => {
    const runGit = repositoryWith({ company: 'https://git.example.com/team/widget.git' });

    const signals = await detectProjectSignals({ projectDir: ROOT, runGit });

    expect(signals?.primaryRemote).toBe('git.example.com/team/widget');
    expect(signals?.secondaryRemotes).toEqual([]);
  });

  it('treats one repository written two ways as one remote', async () => {
    const runGit = repositoryWith({
      ssh: 'git@github.com:acme/widget.git',
      https: 'https://github.com/acme/widget.git',
    });

    const signals = await detectProjectSignals({ projectDir: ROOT, runGit });

    // Two remote names, one repository, and therefore a primary — the rule is
    // about distinct repositories rather than about how many names exist.
    expect(signals?.primaryRemote).toBe('github.com/acme/widget');
    expect(signals?.secondaryRemotes).toEqual([]);
  });

  it('names no primary when several repositories compete and none is origin', async () => {
    const runGit = repositoryWith({
      fork: 'git@github.com:me/widget.git',
      upstream: 'https://github.com/acme/widget.git',
    });

    const signals = await detectProjectSignals({ projectDir: ROOT, runGit });

    // `upstream` is not more authoritative than `fork`. A remote's name is a
    // convention, and choosing between them here would be inventing an answer
    // that decides where somebody's Memory is filed.
    expect(signals?.primaryRemote).toBeNull();
    expect(signals?.secondaryRemotes).toEqual(['github.com/me/widget', 'github.com/acme/widget']);
  });

  it('falls back to the single usable remote when origin identifies nothing', async () => {
    const runGit = repositoryWith({
      origin: '/srv/git/widget.git',
      company: 'https://git.example.com/team/widget.git',
    });

    const signals = await detectProjectSignals({ projectDir: ROOT, runGit });

    // A local-path origin is a real configuration and identifies no repository
    // anybody else can name.
    expect(signals?.primaryRemote).toBe('git.example.com/team/widget');
  });

  it('names no remote when every remote identifies nothing', async () => {
    const runGit = repositoryWith({
      origin: '/srv/git/widget.git',
      backup: './mirror',
    });

    const signals = await detectProjectSignals({ projectDir: ROOT, runGit });

    // A repository whose only remotes are local paths is inside git and has no
    // identity anybody else could name — the same position as no remote at all.
    expect(signals?.insideGit).toBe(true);
    expect(signals?.primaryRemote).toBeNull();
    expect(signals?.secondaryRemotes).toEqual([]);
  });

  it('keeps a credential out of what it reports', async () => {
    const runGit = repositoryWith({
      origin: `https://x-access-token:${FAKE_TOKEN}@github.com/acme/widget.git`,
    });

    const signals = await detectProjectSignals({ projectDir: ROOT, runGit });

    // The raw URL is bound to nothing that outlives the read. Boolean, so a
    // failure does not print the token it found.
    expect(`leaked:${JSON.stringify(signals).includes(FAKE_TOKEN)}`).toBe('leaked:false');
    expect(signals?.primaryRemote).toBe('github.com/acme/widget');
  });
});

describe('where the session sits inside its repository', () => {
  it('reports no subpath when the root is the repository root', async () => {
    const runGit = repositoryWith({ origin: 'git@github.com:acme/widget.git' });

    const signals = await detectProjectSignals({ projectDir: ROOT, runGit });

    expect(signals?.monorepoSubpath).toBeNull();
  });

  it('reports a repository-relative subpath for a nested launch directory', async () => {
    const runGit = repositoryWith({ origin: 'git@github.com:acme/monorepo.git' }, ROOT);

    const signals = await detectProjectSignals({ projectDir: `${ROOT}/apps/web`, runGit });

    // Repository-relative and POSIX-separated: a directory inside a tree anybody
    // with the repository can see, which is what makes it safe to show.
    expect(signals?.monorepoSubpath).toBe('apps/web');
    // The repository's name, not the launch directory's: the launch directory is
    // where the session started, and the repository is what has an identity.
    expect(signals?.projectNameHint).toBe('widget');
  });
});

describe('what never leaves the detector', () => {
  it('reports no absolute path anywhere', async () => {
    const runGit = repositoryWith({ origin: 'git@github.com:acme/widget.git' }, ROOT);

    const signals = await detectProjectSignals({ projectDir: `${ROOT}/apps/web`, runGit });

    const serialised = JSON.stringify(signals);
    for (const fragment of [ROOT, '/home/someone', 'someone', '/home']) {
      expect(`${fragment} leaked:${serialised.includes(fragment)}`).toBe(
        `${fragment} leaked:false`,
      );
    }
  });

  it('reports exactly the five safe fields', async () => {
    const runGit = repositoryWith({ origin: 'git@github.com:acme/widget.git' });

    const signals = await detectProjectSignals({ projectDir: ROOT, runGit });

    // Exact, so a field added here has to be a deliberate edit to this list —
    // which is where somebody will be thinking about whether it is safe.
    expect(Object.keys(signals ?? {}).sort()).toEqual([
      'insideGit',
      'monorepoSubpath',
      'primaryRemote',
      'projectNameHint',
      'secondaryRemotes',
    ]);
  });

  it('never asks git for a branch or a commit', async () => {
    const runGit = repositoryWith({ origin: 'git@github.com:acme/widget.git' });

    await detectProjectSignals({ projectDir: ROOT, runGit });

    // Both change many times a day. A Project that followed them would be a
    // moving target, and the specification puts them in an Environment snapshot.
    const asked = runGit.calls.map((args) => args.join(' ')).join(' | ');
    for (const forbidden of ['branch', 'HEAD', 'rev-list', 'log', 'symbolic-ref', 'status']) {
      expect(`asked for ${forbidden}:${asked.includes(forbidden)}`).toBe(
        `asked for ${forbidden}:false`,
      );
    }
  });
});

describe('against a real git', () => {
  const created: string[] = [];
  let gitAvailable: boolean | undefined;

  afterAll(async () => {
    for (const directory of created) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  async function hasGit(): Promise<boolean> {
    if (gitAvailable === undefined) {
      gitAvailable = await run('git', ['--version']).then(
        () => true,
        () => false,
      );
    }
    return gitAvailable;
  }

  /** A throwaway directory. Removed afterwards, whatever the test did. */
  async function scratch(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'p503-'));
    created.push(directory);
    return directory;
  }

  /** A real repository, with real remotes, and no network access anywhere. */
  async function repository(remotes: Record<string, string> = {}): Promise<string> {
    const directory = await scratch();
    await run('git', ['-C', directory, 'init', '-q']);
    await run('git', ['-C', directory, 'config', 'user.email', 'fixture@example.invalid']);
    await run('git', ['-C', directory, 'config', 'user.name', 'fixture']);
    for (const [name, url] of Object.entries(remotes)) {
      await run('git', ['-C', directory, 'remote', 'add', name, url]);
    }
    return directory;
  }

  it('reads a repository with no remote', async () => {
    if (!(await hasGit())) {
      return;
    }
    const directory = await repository();

    const signals = await detectProjectSignals({ projectDir: directory });

    expect(signals?.insideGit).toBe(true);
    expect(signals?.primaryRemote).toBeNull();
  });

  it('reads a directory that is not a repository', async () => {
    if (!(await hasGit())) {
      return;
    }
    const directory = await scratch();

    const signals = await detectProjectSignals({ projectDir: directory });

    // A normal outcome, not a failure: git ran, exited non-zero, and that is an
    // answer about this directory.
    expect(signals?.insideGit).toBe(false);
    expect(signals?.primaryRemote).toBeNull();
  });

  it('reads one remote', async () => {
    if (!(await hasGit())) {
      return;
    }
    const directory = await repository({ origin: 'https://github.com/acme/widget.git' });

    expect((await detectProjectSignals({ projectDir: directory }))?.primaryRemote).toBe(
      'github.com/acme/widget',
    );
  });

  it('reads several remotes and prefers origin', async () => {
    if (!(await hasGit())) {
      return;
    }
    const directory = await repository({
      upstream: 'https://github.com/acme/base.git',
      origin: 'git@github.com:me/widget.git',
      mirror: 'ssh://git@git.example.com/backup/widget.git',
    });

    const signals = await detectProjectSignals({ projectDir: directory });

    expect(signals?.primaryRemote).toBe('github.com/me/widget');
    expect([...(signals?.secondaryRemotes ?? [])].sort()).toEqual([
      'git.example.com/backup/widget',
      'github.com/acme/base',
    ]);
  });

  it('reads a nested launch directory and keeps the path out of the result', async () => {
    if (!(await hasGit())) {
      return;
    }
    const directory = await repository({ origin: 'https://github.com/acme/monorepo.git' });
    const nested = join(directory, 'apps', 'web');
    await mkdir(nested, { recursive: true });

    const signals = await detectProjectSignals({ projectDir: nested });

    expect(signals?.monorepoSubpath).toBe('apps/web');
    expect(signals?.primaryRemote).toBe('github.com/acme/monorepo');
    // The temporary directory's path contains this machine's user name.
    expect(`path leaked:${JSON.stringify(signals).includes(directory)}`).toBe('path leaked:false');
  });

  it('reads a worktree as the same repository as its main checkout', async () => {
    if (!(await hasGit())) {
      return;
    }
    const main = await repository({ origin: 'https://github.com/acme/widget.git' });
    await writeFile(join(main, 'file.txt'), 'contents\n');
    await run('git', ['-C', main, 'add', 'file.txt']);
    await run('git', ['-C', main, 'commit', '-qm', 'fixture']);
    const worktree = join(await scratch(), 'checkout-b');
    await run('git', ['-C', main, 'worktree', 'add', '-q', worktree, '-b', 'branch-b']);

    const fromMain = await detectProjectSignals({ projectDir: main });
    const fromWorktree = await detectProjectSignals({ projectDir: worktree });

    // A worktree shares its main checkout's configuration, so it sees the same
    // remotes and resolves to the same Project — which is the right answer: a
    // worktree is a second working copy of one repository, not a second project.
    expect(fromWorktree?.primaryRemote).toBe(fromMain?.primaryRemote);
    expect(fromWorktree?.insideGit).toBe(true);
    expect(fromWorktree?.monorepoSubpath).toBeNull();

    await run('git', ['-C', main, 'worktree', 'remove', '--force', worktree]);
  });
});
