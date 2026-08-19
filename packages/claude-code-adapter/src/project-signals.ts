/**
 * What this machine can say about the project a session is working in.
 *
 * ## What the project root is, and what it is not
 *
 * The root arrives as an argument: the current session location, which the
 * host composition supplies. Where that comes from is the composition's job
 * rather than this function's — this function is also what a test drives and
 * what a second assistant reuses, and a rule about one assistant's environment
 * variables has no business here.
 *
 * It is worth saying what *changed* about that, because an earlier version of
 * this comment named a specific host variable and described it as stable. It
 * was measured not to be: a session that moves to another directory mid-run
 * keeps the variable it started with, so a root read once at start-up
 * describes where the session began rather than where it is. The location now
 * travels with each call. The rules below are unaffected — they were never
 * about which variable carried the answer.
 *
 * Three things are deliberately not the project root:
 *
 * - **The shell's working directory.** It moves. A `cd packages/api` followed by
 *   a `cd /tmp` would otherwise change which Project a session belongs to, and
 *   the Problem being worked on would follow it.
 * - **Every directory the session can read.** `--add-dir` grants access; it says
 *   nothing about whether the directory is this Project, a library being read,
 *   or somebody else's repository opened for comparison. Nothing here promotes
 *   one to a Project.
 * - **The git repository root, when they differ.** The repository is evidence
 *   about identity; the project root is where the session is anchored. Both are
 *   read, and they are kept apart.
 *
 * ## The privacy boundary
 *
 * An absolute path on this machine carries a username, sometimes an employer's
 * or a client's name, and sometimes the name of something private. None of that
 * is Memory, and none of it is needed to decide which Project a session is in.
 *
 * So absolute paths exist inside this module and stop here. What comes out is
 * `ProjectSignals`, which carries a directory *name*, a repository-relative
 * subpath, and canonical remotes — and a canonical remote cannot carry a
 * credential, because the conversion that produces one drops the userinfo.
 *
 * ## Git is evidence, not a requirement
 *
 * A project without a repository is a project. Git being absent from the
 * machine, the root not being inside a repository, and a repository having no
 * usable remote are all ordinary outcomes with ordinary answers — not failures,
 * and not something to report as one.
 *
 * `branch` and `commit` are not read. They change many times a day and would
 * make a Project a moving target; they belong to an Environment snapshot, which
 * is where the specification puts them.
 */

import { execFile } from 'node:child_process';
import { basename, relative, sep } from 'node:path';

import { canonicaliseGitRemote } from './project-remote.js';

/** How long one git invocation may take before it is abandoned. */
const GIT_TIMEOUT_MS = 5_000;

/** How much of a git invocation's output is read. */
const GIT_MAX_OUTPUT_BYTES = 1_000_000;

/** The remote whose name means "the one this checkout came from", by convention. */
const ORIGIN = 'origin';

/** What one git invocation produced, or that it produced nothing. */
export interface GitCommandResult {
  /** Whether git ran and exited successfully. */
  readonly ok: boolean;
  /** Standard output, trimmed. Empty when the command did not succeed. */
  readonly stdout: string;
}

/**
 * How git is invoked, so a test can answer without a repository.
 *
 * Arguments are an array and never a string. There is no shell in this path at
 * any point: a project root is a value from the environment and a remote name
 * comes from git's own output, and neither is something to concatenate into a
 * command line.
 */
export type GitRunner = (
  args: readonly string[],
  options: { readonly cwd: string },
) => Promise<GitCommandResult>;

/**
 * Runs git, and reports failure as a result rather than as an exception.
 *
 * Every failure is the same result: git missing from the machine, the directory
 * not being a repository, a timeout, a non-zero exit. The caller's next step is
 * identical for all of them, and collapsing them here is what keeps this from
 * being a place where a diagnostic gets attached.
 *
 * **`stderr` is discarded.** git writes paths and remote URLs into it — "fatal:
 * repository 'https://user:token@host/...' does not exist" is a real message —
 * so nothing reads it, nothing logs it, and nothing attaches it to anything.
 */
export const runGitCommand: GitRunner = (args, options) =>
  new Promise((resolve) => {
    execFile(
      'git',
      [...args],
      {
        cwd: options.cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_OUTPUT_BYTES,
        windowsHide: true,
        // No shell, and no inherited environment surprises: git is invoked
        // directly with the arguments given.
        shell: false,
      },
      (error, stdout) => {
        resolve(error === null ? { ok: true, stdout: stdout.trim() } : { ok: false, stdout: '' });
      },
    );
  });

/**
 * Everything a resolver is allowed to know about where a session is working.
 *
 * Every field is safe to compare, safe to show somebody, and safe to keep. What
 * is absent is the point: there is no absolute path, no raw remote, no branch,
 * no commit and no username anywhere in this type.
 */
export interface ProjectSignals {
  /**
   * A name for the project, for display and for a suggestion — never identity.
   *
   * The repository directory's name when the root is inside one, otherwise the
   * root's own name. A single path segment, deliberately: a full path is what
   * carries a home directory in it.
   */
  readonly projectNameHint: string;

  /** Whether the root sits inside a git repository at all. */
  readonly insideGit: boolean;

  /**
   * The one remote worth treating as identity, canonical, or null.
   *
   * `origin` when it exists and is usable. Otherwise the single distinct
   * canonical remote, when there is exactly one. Otherwise null — because a
   * checkout with a fork and an upstream and no `origin` has no remote that
   * speaks for it, and picking one would be inventing the answer.
   */
  readonly primaryRemote: string | null;

  /**
   * The other distinct canonical remotes: supporting evidence, never identity.
   *
   * An upstream, a fork, a mirror, a company remote. Each is a real fact about
   * this checkout and none of them says which Project it is.
   */
  readonly secondaryRemotes: readonly string[];

  /**
   * Where the root sits inside its repository, or null when it is the root.
   *
   * Repository-relative and POSIX-separated, so it names a directory inside a
   * tree anybody with the repository can see — which is what makes it safe when
   * an absolute path is not. It is display and supporting evidence only: it is
   * not part of identity, because whether `apps/web` and `apps/mobile` are one
   * Project or two is the owner's decision and not a fact about a filesystem.
   */
  readonly monorepoSubpath: string | null;
}

/** What `detectProjectSignals` is given. */
export interface DetectProjectSignalsInput {
  /**
   * The session's project root.
   *
   * Absent, blank or unusable means there is no project signal at all, which is
   * a normal outcome — a session may be running somewhere that is not a project.
   */
  readonly projectDir?: string | undefined;

  /** How git is invoked. Production omits it. */
  readonly runGit?: GitRunner;
}

/** The names of a repository's remotes, in git's own order. */
async function readRemoteNames(runGit: GitRunner, cwd: string): Promise<string[]> {
  const listed = await runGit(['remote'], { cwd });
  if (!listed.ok || listed.stdout === '') {
    return [];
  }
  return listed.stdout
    .split('\n')
    .map((name) => name.trim())
    .filter((name) => name !== '');
}

/**
 * Reads one remote's URL and canonicalises it immediately.
 *
 * The raw value is bound to nothing that outlives this expression. That is the
 * whole reason this is a function: there is no variable holding a raw remote
 * anywhere a later edit could pick one up.
 */
async function readCanonicalRemote(
  runGit: GitRunner,
  cwd: string,
  name: string,
): Promise<string | undefined> {
  const url = await runGit(['remote', 'get-url', name], { cwd });
  if (!url.ok || url.stdout === '') {
    return undefined;
  }
  return canonicaliseGitRemote(url.stdout);
}

/**
 * Works out the repository-relative subpath, or null when there is none.
 *
 * Null rather than a value in three cases: the root *is* the repository root,
 * the relative path escapes the repository — which should not happen and is not
 * something to publish a guess about — and the path is absolute, which means
 * the two are on different drives and the relationship is not a subpath.
 */
function subpathWithin(repositoryRoot: string, projectDir: string): string | null {
  const relativePath = relative(repositoryRoot, projectDir);
  if (relativePath === '' || relativePath.startsWith('..') || relativePath.includes(':')) {
    return null;
  }
  return relativePath.split(sep).join('/');
}

/**
 * Reads what this machine can say about the project at `projectDir`.
 *
 * Returns `null` when there is no project root to read, which is how "no
 * project signal" travels: a normal answer rather than a thrown error, because
 * a session with no project root is a session somebody legitimately started
 * somewhere else.
 *
 * Reads only. Nothing here writes, fetches, or changes a repository.
 */
export async function detectProjectSignals(
  input: DetectProjectSignalsInput,
): Promise<ProjectSignals | null> {
  const projectDir = input.projectDir?.trim();
  if (projectDir === undefined || projectDir === '') {
    return null;
  }

  const runGit = input.runGit ?? runGitCommand;

  const toplevel = await runGit(['rev-parse', '--show-toplevel'], { cwd: projectDir });
  const insideGit = toplevel.ok && toplevel.stdout !== '';

  if (!insideGit) {
    // A project without a repository. The name is all this machine can say, and
    // the resolver treats a name as the weak evidence it is.
    return {
      projectNameHint: basename(projectDir),
      insideGit: false,
      primaryRemote: null,
      secondaryRemotes: [],
      monorepoSubpath: null,
    };
  }

  const repositoryRoot = toplevel.stdout;
  const names = await readRemoteNames(runGit, projectDir);

  // `origin` first, so it is first in the canonical order too. A worktree shares
  // its main checkout's configuration, so a session in either one sees the same
  // remotes and resolves to the same Project — which is the right answer: a
  // worktree is a second working copy of one repository, not a second project.
  const ordered = [...names].sort((left, right) => {
    if (left === ORIGIN) {
      return right === ORIGIN ? 0 : -1;
    }
    return right === ORIGIN ? 1 : 0;
  });

  // One read per remote, and the distinct set built as they arrive. De-duplication
  // is by canonical form rather than by name, which is how one repository
  // configured as both SSH and HTTPS becomes one identity instead of two.
  const canonicalByName = new Map<string, string>();
  const distinct: string[] = [];
  for (const name of ordered) {
    const canonical = await readCanonicalRemote(runGit, projectDir, name);
    if (canonical === undefined) {
      continue;
    }
    canonicalByName.set(name, canonical);
    if (!distinct.includes(canonical)) {
      distinct.push(canonical);
    }
  }

  const originCanonical = canonicalByName.get(ORIGIN);

  // Either `origin` speaks for the checkout, or exactly one remote does, or
  // nothing does. There is no third rule and no tie-break by name: a remote
  // called `upstream` is not more authoritative than one called `fork`, and
  // choosing between them would be this code deciding something it cannot know.
  const primaryRemote = originCanonical ?? (distinct.length === 1 ? (distinct[0] ?? null) : null);

  return {
    projectNameHint: basename(repositoryRoot),
    insideGit: true,
    primaryRemote,
    secondaryRemotes: distinct.filter((remote) => remote !== primaryRemote),
    monorepoSubpath: subpathWithin(repositoryRoot, projectDir),
  };
}
