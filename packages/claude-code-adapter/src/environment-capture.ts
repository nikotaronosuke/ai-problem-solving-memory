/**
 * The conditions a Problem is being started under, as far as they can be read.
 *
 * Two facts: which branch, and which commit. They are here rather than in
 * Project identity for a reason already settled — a Project is the long-lived
 * unit of work and does not change when somebody checks out a different branch,
 * while an Environment is a point in time and that is exactly what it records.
 *
 * ## Why so little
 *
 * The specification asks for the conditions *relevant to the problem*, and says
 * plainly that a full package list is not it. Which framework or library
 * version mattered is a judgement about the problem being investigated, and a
 * caller who has made that judgement can add it; a module that swept up
 * everything readable would fill every Environment with noise and would be the
 * reason nobody reads them. So this collects what is deterministic and
 * universally applicable, and stops.
 *
 * What is deliberately not collected: the absolute path, the repository URL,
 * any raw remote, a username, the process environment, an operating system
 * string, dependency versions, git configuration. Some of those are private,
 * some are noise, and none of them has a use case yet. A later task with a real
 * one adds what it needs.
 *
 * ## Absent rather than unknown
 *
 * A fact that cannot be read is left out. There is no `branch: null` and no
 * `"unknown"`: a snapshot is a record of what was true, and a field saying "we
 * looked and could not tell" is a claim about this code rather than about the
 * environment. A detached checkout has a commit and no branch, and that is a
 * real state rather than a failure — it comes out as a snapshot with one field.
 * A directory that is not a repository comes out as `{}`.
 */

import { isAbsolute } from 'node:path';

import type { JsonObject } from '@ai-problem-solving-memory/api-client';

import { runGitCommand, type GitRunner } from './project-signals.js';

/** Reads which branch is checked out. Empty output means detached. */
const BRANCH_COMMAND = ['branch', '--show-current'] as const;

/** Reads the commit the work is on. */
const COMMIT_COMMAND = ['rev-parse', 'HEAD'] as const;

/**
 * Raised when the directory could not describe anywhere.
 *
 * A programming mistake rather than a condition to handle: a caller reaching
 * this has not resolved a project root, and capturing an environment for an
 * unknown directory would produce a snapshot about somewhere else. It names
 * the argument and never the value — a path carries a user name, and sometimes
 * an employer's.
 */
export class EnvironmentCaptureArgumentError extends Error {
  readonly argument: string;

  constructor(argument: string) {
    super(`${argument} is not usable.`);
    this.name = 'EnvironmentCaptureArgumentError';
    this.argument = argument;
  }
}

export interface CaptureEnvironmentInput {
  /**
   * The session's project root.
   *
   * Required and absolute. Unlike Project detection — where "there is no
   * project signal" is an ordinary outcome — capturing conditions is something
   * a caller does deliberately, having already resolved a Project, so a missing
   * root here is a mistake rather than a state.
   */
  readonly projectDir: string;

  /** How git is invoked. Production omits it. */
  readonly runGit?: GitRunner;
}

/**
 * What was readable about the working tree, as a snapshot the API will accept.
 *
 * The return type is the client's JSON object type rather than a shape of its
 * own: a snapshot is free-form by contract, and describing it with an interface
 * here would be inventing a schema the server does not have. What this module
 * puts in it is narrow; what the type permits is what the wire permits.
 */
export async function captureEnvironment(input: CaptureEnvironmentInput): Promise<JsonObject> {
  const projectDir = input.projectDir;
  if (typeof projectDir !== 'string' || projectDir.trim().length === 0 || !isAbsolute(projectDir)) {
    throw new EnvironmentCaptureArgumentError('project directory');
  }

  const runGit = input.runGit ?? runGitCommand;

  // Both are attempted regardless of how the other went. A detached checkout
  // has no branch and a perfectly good commit, and one unreadable fact is not
  // a reason to discard the other.
  const [branch, commit] = await Promise.all([
    runGit([...BRANCH_COMMAND], { cwd: projectDir }),
    runGit([...COMMIT_COMMAND], { cwd: projectDir }),
  ]);

  const snapshot: Record<string, string> = {};
  // Empty output is what git prints on a detached HEAD, so it is treated the
  // same as not being able to read one: the field is left out rather than
  // recorded as blank.
  if (branch.ok && branch.stdout.length > 0) {
    snapshot['branch'] = branch.stdout;
  }
  if (commit.ok && commit.stdout.length > 0) {
    snapshot['commit'] = commit.stdout;
  }

  // The path was needed to run git and stops here. It is the one value this
  // module holds that must not reach a record somebody keeps.
  return snapshot;
}
