/**
 * What gets recorded about a working tree, and what never does.
 *
 * Two facts go in. The tests that matter are about the third thing this module
 * touches and must never keep: the project directory. It has to be there to run
 * git in, and a snapshot is stored permanently, so "the path was used and
 * dropped" is checked by serialising the result and looking rather than by
 * trusting the code to have left it out.
 *
 * The other theme is absence. A fact that could not be read is left out, not
 * recorded as null or as "unknown" — a snapshot says what was true, and a field
 * describing this module's failure to look would be a claim about the wrong
 * subject.
 */

import { describe, expect, it } from 'vitest';

import {
  captureEnvironment,
  EnvironmentCaptureArgumentError,
  type GitCommandResult,
  type GitRunner,
} from '../src/index.js';

const PROJECT_DIR = '/tmp/some-checkout';
const COMMIT = '0f1e2d3c4b5a69788796a5b4c3d2e1f009182736';

interface Invocation {
  readonly args: readonly string[];
  readonly cwd: string;
}

/** A git that answers from a table, and records exactly what it was asked. */
function gitAnswering(answers: Record<string, GitCommandResult>): {
  runGit: GitRunner;
  calls: Invocation[];
} {
  const calls: Invocation[] = [];
  const runGit: GitRunner = (args, options) => {
    calls.push({ args, cwd: options.cwd });
    const key = args.join(' ');
    return Promise.resolve(answers[key] ?? { ok: false, stdout: '' });
  };
  return { runGit, calls };
}

const ON_A_BRANCH: Record<string, GitCommandResult> = {
  'branch --show-current': { ok: true, stdout: 'feature/cache-invalidation' },
  'rev-parse HEAD': { ok: true, stdout: COMMIT },
};

describe('what it reads', () => {
  it('records the branch and the commit', async () => {
    const { runGit } = gitAnswering(ON_A_BRANCH);

    await expect(captureEnvironment({ projectDir: PROJECT_DIR, runGit })).resolves.toEqual({
      branch: 'feature/cache-invalidation',
      commit: COMMIT,
    });
  });

  it('asks git exactly two things, with the arguments as an array', async () => {
    const { runGit, calls } = gitAnswering(ON_A_BRANCH);

    await captureEnvironment({ projectDir: PROJECT_DIR, runGit });

    expect(calls.map((call) => call.args)).toEqual([
      ['branch', '--show-current'],
      ['rev-parse', 'HEAD'],
    ]);
  });

  it('runs git in the directory it was given', async () => {
    const { runGit, calls } = gitAnswering(ON_A_BRANCH);

    await captureEnvironment({ projectDir: PROJECT_DIR, runGit });

    for (const call of calls) {
      expect(call.cwd).toBe(PROJECT_DIR);
    }
  });

  it('reads nothing else — no remote, no config, no log', async () => {
    const { runGit, calls } = gitAnswering(ON_A_BRANCH);

    await captureEnvironment({ projectDir: PROJECT_DIR, runGit });

    // A remote can carry a credential and a config can carry a name. Neither is
    // needed to say which branch and commit this is.
    const asked = calls.map((call) => call.args.join(' ')).join('|');
    for (const forbidden of ['remote', 'config', 'log', 'get-url', 'user.email']) {
      expect(`${forbidden}:${asked.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });
});

describe('what it leaves out', () => {
  it('omits the branch on a detached checkout, and keeps the commit', async () => {
    // Git prints nothing for the branch when HEAD is detached. That is a real
    // state of the tree rather than a failure to read one.
    const { runGit } = gitAnswering({
      'branch --show-current': { ok: true, stdout: '' },
      'rev-parse HEAD': { ok: true, stdout: COMMIT },
    });

    await expect(captureEnvironment({ projectDir: PROJECT_DIR, runGit })).resolves.toEqual({
      commit: COMMIT,
    });
  });

  it('keeps the commit when the branch could not be read', async () => {
    const { runGit } = gitAnswering({
      'branch --show-current': { ok: false, stdout: '' },
      'rev-parse HEAD': { ok: true, stdout: COMMIT },
    });

    await expect(captureEnvironment({ projectDir: PROJECT_DIR, runGit })).resolves.toEqual({
      commit: COMMIT,
    });
  });

  it('keeps the branch when the commit could not be read', async () => {
    const { runGit } = gitAnswering({
      'branch --show-current': { ok: true, stdout: 'main' },
      'rev-parse HEAD': { ok: false, stdout: '' },
    });

    await expect(captureEnvironment({ projectDir: PROJECT_DIR, runGit })).resolves.toEqual({
      branch: 'main',
    });
  });

  it('records nothing at all outside a repository', async () => {
    const { runGit } = gitAnswering({});

    await expect(captureEnvironment({ projectDir: PROJECT_DIR, runGit })).resolves.toEqual({});
  });

  it('never writes null or a placeholder for a fact it could not read', async () => {
    const { runGit } = gitAnswering({});

    const snapshot = await captureEnvironment({ projectDir: PROJECT_DIR, runGit });
    const serialised = JSON.stringify(snapshot);

    expect(Object.keys(snapshot)).toEqual([]);
    for (const placeholder of ['null', 'unknown', 'UNKNOWN', 'none', 'detached']) {
      expect(`${placeholder}:${serialised.includes(placeholder)}`).toBe(`${placeholder}:false`);
    }
  });

  it('carries exactly the two keys it knows about and no others', async () => {
    const { runGit } = gitAnswering(ON_A_BRANCH);

    const snapshot = await captureEnvironment({ projectDir: PROJECT_DIR, runGit });

    expect(Object.keys(snapshot).sort()).toEqual(['branch', 'commit']);
  });
});

describe('the directory it is given', () => {
  it.each(['', '   ', 'relative/path', './here', '../there'])(
    'refuses %s before running git',
    async (projectDir) => {
      const { runGit, calls } = gitAnswering(ON_A_BRANCH);

      await expect(captureEnvironment({ projectDir, runGit })).rejects.toBeInstanceOf(
        EnvironmentCaptureArgumentError,
      );
      expect(calls).toEqual([]);
    },
  );

  it('names the argument and never the path it refused', async () => {
    const planted = 'relative/a-path-nobody-should-log';

    const raised = await captureEnvironment({ projectDir: planted }).catch(
      (error: unknown) => error,
    );

    expect((raised as EnvironmentCaptureArgumentError).argument).toBe('project directory');
    expect((raised as Error).message.includes(planted)).toBe(false);
    expect(JSON.stringify(raised).includes(planted)).toBe(false);
  });

  it('never puts the directory into the snapshot it returns', async () => {
    // The path is needed to run git in and is stored permanently if it escapes.
    // It carries a user name, sometimes an employer's, and none of it is a
    // condition the problem occurred under.
    const secretish = '/home/someone-private/clients/acme/checkout';
    const { runGit } = gitAnswering(ON_A_BRANCH);

    const snapshot = await captureEnvironment({ projectDir: secretish, runGit });

    const serialised = JSON.stringify(snapshot);
    expect(serialised.includes(secretish)).toBe(false);
    expect(serialised.includes('someone-private')).toBe(false);
    expect(serialised.includes('acme')).toBe(false);
  });
});
