/**
 * Where this runtime remembers the last question it asked about a Problem.
 *
 * One small file per Problem, holding a digest and nothing else. It exists so
 * that a trigger firing repeatedly does not ask the Memory the same thing over
 * and over — provider calls paid for twice, usage recorded twice, the same
 * answer arriving each time.
 *
 * ## Advisory, and only advisory
 *
 * This is not a second truth about a Problem. Losing it, corrupting it or
 * never writing it costs at most a repeated search; it can never make a Memory
 * go unread, and it can never make one look emptier than it is. So every
 * failure here resolves to "we do not know", which the composition reads as
 * "then ask" — the opposite of how authentication state is treated one
 * directory over.
 *
 * ## Why it is not `bindings/` or `call-context/`
 *
 * Those two hold different things with different lifetimes: a binding says
 * which Problem a session is on, and a call context is a single call's
 * identity, spent once. Mixing a cache in with either would put a file nobody
 * must trust beside files everything depends on, and the sweep that tidies one
 * would have to learn about the other.
 *
 * ## What a filename says, and what it does not
 *
 * The name is a digest of the Problem identifier rather than the identifier
 * itself, so a directory listing is not a list of what somebody is working on.
 * The contents hold no query, no feature text, no path and no Problem id: the
 * name is already the key, and a digest of the question is all that has to be
 * compared.
 */

import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type {
  RecallFingerprintRead,
  RecallFingerprintStore,
  RecallFingerprintWrite,
} from '@ai-problem-solving-memory/claude-code-adapter';

import { RECALL_FINGERPRINT_DIRECTORY } from './runtime-constants.js';

/** The only record layout this version writes, and the only one it reads. */
export const RECALL_FINGERPRINT_FORMAT_VERSION = 1;

/** The keys a record carries. Exactly these. */
export const RECALL_FINGERPRINT_FIELDS = ['format_version', 'fingerprint'] as const;

/**
 * A ceiling on how much of a record is read before it is judged malformed.
 *
 * These files are written here and are under a hundred bytes. Reading without
 * a bound would make anything that ends up in that directory this process's
 * problem.
 */
export const RECALL_FINGERPRINT_MAX_BYTES = 512;

/** What one record holds. A digest, and which layout wrote it. */
interface RecallFingerprintRecord {
  readonly format_version: typeof RECALL_FINGERPRINT_FORMAT_VERSION;
  readonly fingerprint: string;
}

/** Lowercase hex, of the length SHA-256 produces. Nothing else is one. */
const DIGEST = /^[0-9a-f]{64}$/u;

/**
 * The filename for a Problem's record.
 *
 * Domain-separated from every other hash this runtime keeps, so a value from
 * one concept can never be compared against — or mistaken for — a value from
 * another. Nothing in the name is reversible to a Problem.
 */
export function recallFingerprintFilename(problemId: string): string {
  const key = createHash('sha256').update(`recall-fingerprint/${problemId}`, 'utf8').digest('hex');
  return `recall-${key}.json`;
}

function isRecord(value: unknown): value is RecallFingerprintRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== RECALL_FINGERPRINT_FIELDS.length) {
    return false;
  }
  for (const field of RECALL_FINGERPRINT_FIELDS) {
    if (!(field in record)) {
      return false;
    }
  }
  return (
    record['format_version'] === RECALL_FINGERPRINT_FORMAT_VERSION &&
    typeof record['fingerprint'] === 'string' &&
    DIGEST.test(record['fingerprint'])
  );
}

/**
 * The store, over one directory under the host's persistent plugin data.
 *
 * Every method answers rather than throws. A caller deciding whether to repeat
 * a search does not want an exception from a cache in the middle of it.
 */
export function createRecallFingerprintStore(options: {
  readonly directory: string;
}): RecallFingerprintStore {
  const pathFor = (problemId: string): string =>
    join(options.directory, recallFingerprintFilename(problemId));

  return {
    async readFingerprint(problemId: string): Promise<RecallFingerprintRead> {
      const path = pathFor(problemId);
      try {
        // The size is checked before the bytes are taken. Measuring a string
        // after reading it is not a bound.
        const entry = await stat(path);
        if (!entry.isFile() || entry.size > RECALL_FINGERPRINT_MAX_BYTES) {
          return { kind: 'UNAVAILABLE' };
        }
        const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
        // A record this version cannot read is not a match and not an answer.
        // It resolves to unavailable, which means the search happens.
        return isRecord(parsed)
          ? { kind: 'FOUND', fingerprint: parsed.fingerprint }
          : { kind: 'UNAVAILABLE' };
      } catch (error) {
        return isMissing(error) ? { kind: 'MISSING' } : { kind: 'UNAVAILABLE' };
      }
    },

    async writeFingerprint(
      problemId: string,
      fingerprint: string,
    ): Promise<RecallFingerprintWrite> {
      if (!DIGEST.test(fingerprint)) {
        return { kind: 'NOT_PERSISTED' };
      }

      const path = pathFor(problemId);
      // Written beside, then moved into place. An interruption leaves the
      // temporary file behind rather than a half-written record that would
      // read as a valid match and suppress a search that never happened.
      const temporary = `${path}.${randomUUID()}.tmp`;
      const body = JSON.stringify({
        format_version: RECALL_FINGERPRINT_FORMAT_VERSION,
        fingerprint,
      } satisfies RecallFingerprintRecord);

      try {
        await mkdir(options.directory, { recursive: true });
        const handle = await open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(body, 'utf8');
        } finally {
          await handle.close();
        }
        await rename(temporary, path);
        return { kind: 'PERSISTED' };
      } catch {
        // A cache that could not be written is not a failed recall. The search
        // that just succeeded stays succeeded; at worst it happens again later.
        await unlink(temporary).catch(() => undefined);
        return { kind: 'NOT_PERSISTED' };
      }
    },
  };
}

/** Whether a filesystem error means the file simply is not there. */
function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

export { RECALL_FINGERPRINT_DIRECTORY };
