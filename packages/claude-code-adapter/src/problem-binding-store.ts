/**
 * Where a session's answer to "which Problem am I on" is kept between calls.
 *
 * A binding is a **hint and never an authority**. It records that somebody
 * already decided this conversation is about that Problem; it is re-read from
 * the Memory Server every time it is used, and the resolver discards it the
 * moment the server disagrees. Nothing here validates anything against a
 * server, and nothing here decides whether a binding *should* exist — this
 * module is the persistence and none of the policy.
 *
 * ## Why the key is a pair
 *
 * A session identifier alone is not a Project identity: the same conversation
 * can move between Projects and be resumed somewhere else entirely. So a
 * binding belongs to `(session, Project)`, and one file holds exactly one pair.
 * That is not a storage detail — a single slot per session would silently lose
 * Project A's binding the moment the session touched Project B, and the loss
 * would look exactly like never having had one.
 *
 * ## Why every failure is a value
 *
 * Reading a local hint can fail in four different ways and only one of them is
 * "there is no binding". A corrupt record, a permission error and a missing
 * file lead to the same *next step* — ask the server what exists — but they are
 * not the same fact, and collapsing them would make a broken store
 * indistinguishable from an empty one for as long as it stayed broken. None of
 * them is worth interrupting somebody's work over, which is why they are
 * returned rather than thrown.
 *
 * ## What this module is not
 *
 * It does not know the Memory API, a credential, a Problem's status, or what a
 * Problem is beyond an opaque identity. It does not know how a session
 * identifier is obtained, where its directory ought to live, or when a binding
 * should be written or removed — every one of those belongs to the composition
 * that has a host to ask.
 */

import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import type { ProblemBindingHint } from './problem-resolution.js';

/** The only record layout this version writes, and the only one it reads. */
const BINDING_FORMAT_VERSION = 1;

/** The keys a stored record carries. Exactly these, in this order. */
const BINDING_RECORD_FIELDS = ['format_version', 'session_id', 'project_id', 'problem_id'] as const;

/**
 * How many times a rename that lost a race is worth trying again.
 *
 * Replacing a file on Windows fails with `EPERM` while another process holds
 * the destination open — a scanner, a backup agent, an editor. It is transient
 * by nature, so a few closely spaced attempts clear it, and a binding is not
 * worth waiting on beyond that. These two numbers are implementation
 * constants: the right values follow from how this behaves in practice, and
 * nothing about the design depends on them.
 */
const RENAME_RETRY_ATTEMPTS = 4;
const RENAME_RETRY_DELAY_MS = 20;

/** What reading a binding found. */
export type ProblemBindingRead =
  | { readonly kind: 'VALID'; readonly binding: ProblemBindingHint }
  | { readonly kind: 'MISSING' }
  | { readonly kind: 'UNREADABLE' }
  | { readonly kind: 'IO_FAILURE' };

/** What writing a binding did. */
export type ProblemBindingWrite = { readonly kind: 'WRITTEN' } | { readonly kind: 'IO_FAILURE' };

/** What removing a binding did. */
export type ProblemBindingRemoval =
  { readonly kind: 'REMOVED' } | { readonly kind: 'MISSING' } | { readonly kind: 'IO_FAILURE' };

export interface ProblemBindingStore {
  /**
   * Reads the binding recorded for this session in this Project.
   *
   * The record carries the identities it was written under and they are
   * compared against the ones asked for, so a file that arrived by any route
   * other than this store writing it — copied, restored from a backup, or
   * landing on a hash collision — is unreadable rather than answered with.
   */
  readBinding(sessionId: string, projectId: string): Promise<ProblemBindingRead>;

  /**
   * Records that this session is on this Problem in this Project.
   *
   * Replaces whatever was there for the same pair, and touches no other pair.
   * A reader either sees the record that was there before or the one written
   * here, never a half of either.
   */
  writeBinding(
    sessionId: string,
    projectId: string,
    problemId: string,
  ): Promise<ProblemBindingWrite>;

  /**
   * Forgets the binding for this pair.
   *
   * When that is the right thing to do is not this module's question. It
   * depends on what the server said about the Problem, which is knowledge this
   * store deliberately does not have.
   */
  removeBinding(sessionId: string, projectId: string): Promise<ProblemBindingRemoval>;
}

/**
 * Raised when an argument could not describe anything.
 *
 * A programming mistake rather than a condition to handle, so it throws where
 * the filesystem outcomes are returned. It names the argument and never the
 * value: a rejected identity is still somebody's identity, and an error message
 * is the least controlled place a value can end up.
 */
export class ProblemBindingArgumentError extends Error {
  readonly argument: string;

  constructor(argument: string) {
    super(`${argument} is not usable.`);
    this.name = 'ProblemBindingArgumentError';
    this.argument = argument;
  }
}

function requireIdentity(value: string, argument: string): string {
  // Opaque on purpose. A session identifier's syntax is the host's to change,
  // and a Problem or Project id is the server's; a second copy of either rule
  // here would reject perfectly good identities the day one of them moved.
  // Non-empty is the only thing this module actually needs to be true.
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProblemBindingArgumentError(argument);
  }
  return value;
}

/**
 * The `code` a filesystem error carries, if it carries one.
 *
 * Read defensively rather than by casting to `ErrnoException`: what arrives in
 * a `catch` is genuinely unknown, and a mock, a wrapped error or a plain
 * `Error` all reach here. Anything without a usable code falls through to the
 * general failure path, which is the right answer for something this module
 * cannot identify.
 */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }
  // `'code' in error` has already narrowed it, so no assertion is needed here.
  const { code } = error;
  return typeof code === 'string' ? code : undefined;
}

/**
 * The filename for one pair.
 *
 * A hash rather than the identities themselves, for two reasons that both
 * matter. A session identifier is opaque — its length and its alphabet are the
 * host's to change — and a filename built out of one inherits every one of
 * those constraints, including limits this code cannot see. And a directory
 * listing is a place identities would otherwise sit in the clear.
 *
 * `JSON.stringify` of the pair is what gets hashed, so the two halves cannot
 * run together: `["ab","c"]` and `["a","bc"]` are different strings, where
 * concatenation would make them the same key.
 *
 * This is neither authorization nor secrecy — the identities are inside the
 * record and are checked on read, which is also what makes a collision
 * harmless rather than a wrong answer.
 */
function bindingFileName(sessionId: string, projectId: string): string {
  const key = createHash('sha256')
    .update(JSON.stringify([sessionId, projectId]))
    .digest('hex');
  return `${key}.json`;
}

interface BindingRecord {
  readonly format_version: number;
  readonly session_id: string;
  readonly project_id: string;
  readonly problem_id: string;
}

/**
 * Whether a parsed record is one this version wrote, for the pair asked about.
 *
 * Exact key set, known version, non-empty identities, and both identities
 * equal to the ones requested. A record that fails any of it is not repaired
 * or partially believed: the caller's next step is to ask the server, which is
 * the correct step for every one of these failures.
 */
function isBindingFor(
  value: unknown,
  sessionId: string,
  projectId: string,
): value is BindingRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;

  if (Object.keys(record).length !== BINDING_RECORD_FIELDS.length) {
    return false;
  }
  for (const field of BINDING_RECORD_FIELDS) {
    if (!(field in record)) {
      return false;
    }
  }

  return (
    record['format_version'] === BINDING_FORMAT_VERSION &&
    typeof record['problem_id'] === 'string' &&
    record['problem_id'].length > 0 &&
    record['session_id'] === sessionId &&
    record['project_id'] === projectId
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Moves a finished temporary file onto its destination.
 *
 * Only `EPERM` is retried, and only the rename — the content was written and
 * flushed before the first attempt, so a retry is the same complete bytes
 * arriving a moment later rather than the work being done again. Every other
 * failure is reported immediately, because retrying a missing directory or a
 * denied path is just the same answer arriving slower.
 */
async function renameWithRetry(temporaryPath: string, finalPath: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(temporaryPath, finalPath);
      return;
    } catch (error) {
      if (errorCode(error) !== 'EPERM' || attempt >= RENAME_RETRY_ATTEMPTS) {
        throw error;
      }
      await delay(RENAME_RETRY_DELAY_MS);
    }
  }
}

/**
 * Builds a store over one directory.
 *
 * The directory is an argument and must be absolute. A relative one would
 * resolve against whatever the working directory happened to be — which for a
 * tool running inside somebody's editor is their repository, and the first
 * thing that would happen is runtime state appearing in their checkout. Where
 * the directory ought to be is the composition's question, and this module
 * deliberately reads no environment variable to answer it.
 */
export function createProblemBindingStore(options: { directory: string }): ProblemBindingStore {
  const directory = options.directory;
  if (typeof directory !== 'string' || directory.trim().length === 0 || !isAbsolute(directory)) {
    throw new ProblemBindingArgumentError('directory');
  }

  function pathFor(sessionId: string, projectId: string): string {
    return join(
      directory,
      bindingFileName(
        requireIdentity(sessionId, 'session id'),
        requireIdentity(projectId, 'project id'),
      ),
    );
  }

  return {
    async readBinding(sessionId, projectId): Promise<ProblemBindingRead> {
      const file = pathFor(sessionId, projectId);

      let contents: string;
      try {
        contents = await readFile(file, 'utf8');
      } catch (error) {
        // The one code that means "no binding". Everything else is the
        // filesystem failing, which is a different fact from an owner who has
        // not started anything here.
        return errorCode(error) === 'ENOENT' ? { kind: 'MISSING' } : { kind: 'IO_FAILURE' };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(contents);
      } catch {
        return { kind: 'UNREADABLE' };
      }

      if (!isBindingFor(parsed, sessionId, projectId)) {
        // Left on disk. Deleting what cannot be read is how local state
        // disappears without anybody deciding it should: the next successful
        // write for this pair replaces it, and until then it costs one
        // enumeration and nothing else.
        return { kind: 'UNREADABLE' };
      }

      return { kind: 'VALID', binding: { projectId, problemId: parsed.problem_id } };
    },

    async writeBinding(sessionId, projectId, problemId): Promise<ProblemBindingWrite> {
      const file = pathFor(sessionId, projectId);
      const problem = requireIdentity(problemId, 'problem id');

      const record: BindingRecord = {
        format_version: BINDING_FORMAT_VERSION,
        session_id: sessionId,
        project_id: projectId,
        problem_id: problem,
      };

      // Beside the destination, so the rename stays within one filesystem, and
      // uniquely named, so two writers never share a scratch file. No identity
      // in the name: a temporary left behind by a crash would otherwise be a
      // copy of one in the clear.
      const temporaryPath = join(directory, `${randomUUID()}.tmp`);

      try {
        await mkdir(directory, { recursive: true });

        const handle = await open(temporaryPath, 'wx');
        try {
          await handle.writeFile(JSON.stringify(record), 'utf8');
          // Flushed before the rename, so the name never points at a file the
          // filesystem has not committed. Cheap for a record this size.
          await handle.sync();
        } finally {
          await handle.close();
        }

        await renameWithRetry(temporaryPath, file);
        return { kind: 'WRITTEN' };
      } catch {
        // Best effort. If this fails too, the leftover is an unreferenced
        // temporary that no reader will ever open — readers address one exact
        // filename and never list the directory.
        await unlink(temporaryPath).catch(() => undefined);
        return { kind: 'IO_FAILURE' };
      }
    },

    async removeBinding(sessionId, projectId): Promise<ProblemBindingRemoval> {
      const file = pathFor(sessionId, projectId);

      try {
        await unlink(file);
        return { kind: 'REMOVED' };
      } catch (error) {
        return errorCode(error) === 'ENOENT' ? { kind: 'MISSING' } : { kind: 'IO_FAILURE' };
      }
    },
  };
}
