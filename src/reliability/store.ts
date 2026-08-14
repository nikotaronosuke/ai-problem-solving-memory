/**
 * Where a queued write survives a crash.
 *
 * The filesystem, and the choice is a process of elimination rather than a
 * preference.
 *
 * Not PostgreSQL. The whole point of this queue is to hold writes that could
 * not be stored, and the most ordinary reason for that is the database being
 * unreachable. A queue in the same database fails at exactly the moment it is
 * needed.
 *
 * Not memory. An assistant's session ends, a process restarts, a laptop
 * sleeps. A queue emptied by any of those loses the Events it was holding, and
 * "we kept your work safe until you restarted" is not keeping it safe.
 *
 * Not SQLite. It would do the job and it brings a native module, a build step
 * and a second storage engine into a project with three runtime dependencies.
 * What is needed here is a handful of small records that must survive a
 * crash — `node:fs` does that.
 *
 * **One file per item.** An append-only log would need the whole file
 * rewritten to update one attempt count, and a single corrupt byte in the
 * middle would put every record after it out of reach. Separate files make a
 * success an `unlink`, an attempt update an atomic replace of one small file,
 * and a damaged record the loss of exactly that record.
 *
 * **Written by rename.** Content goes to a temporary file in the same
 * directory and is then renamed over the destination. `rename` within a
 * directory is atomic, so a reader sees the old file or the new one and never
 * a half-written one — which matters because the process holding this queue is
 * one that has already demonstrated it can be interrupted.
 *
 * The limit of that guarantee is worth stating rather than implying: the data
 * is `fsync`ed before the rename, so a crash cannot leave a renamed file whose
 * contents never reached the disk. The directory entry itself is not synced,
 * so a power loss in the instant after the rename can still lose the whole
 * file. Closing that window costs a directory sync on every write and buys
 * protection against a case where the machine died — which is not the failure
 * this queue exists for.
 *
 * **Names are ours.** A file is named from a UUID this module generated. No
 * part of a path comes from a caller, an owner, a Problem or a payload, so
 * there is nothing to traverse with and nothing to collide on.
 */

import { constants } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { parseQueueItem, serialiseQueueItem, type QueueItem } from './item.js';

/** Bounds on how much a queue may hold. Every one is the caller's to set. */
export interface QueueLimits {
  /** How many items may exist at once, live or terminal. */
  readonly maxItems: number;
  /** The largest a single serialised item may be, in bytes. */
  readonly maxItemBytes: number;
  /** The most the queue may occupy in total, in bytes. */
  readonly maxTotalBytes: number;
}

/** What a read of the directory found. */
export interface StoredItems {
  readonly items: readonly QueueItem[];
  /**
   * How many files could not be read.
   *
   * A count and nothing else. What was in them is not reported, not logged and
   * not returned: an unreadable file is a file this process may not have
   * written, and its contents are exactly what must not be echoed anywhere.
   */
  readonly corruptCount: number;
}

/** Raised when an item would take the queue past a limit it was given. */
export class QueueCapacityError extends Error {
  readonly limit: 'maxItems' | 'maxItemBytes' | 'maxTotalBytes';

  constructor(limit: 'maxItems' | 'maxItemBytes' | 'maxTotalBytes') {
    // The name of the limit and nothing about the item. Which write was
    // refused is the caller's to know; it already has it.
    super(`The retry queue is at its ${limit} limit.`);
    this.name = 'QueueCapacityError';
    this.limit = limit;
  }
}

const ITEM_SUFFIX = '.json';
const TEMP_SUFFIX = '.tmp';

/** Everything that survives a restart, on one directory. */
export interface QueueStore {
  /** Reads every item, skipping anything unreadable. */
  read(): Promise<StoredItems>;
  /** Writes an item, replacing any file for the same id. */
  write(item: QueueItem, limits: QueueLimits, isNew: boolean): Promise<void>;
  /** Removes an item. Absent is success: the point was for it to be gone. */
  remove(queueItemId: string): Promise<void>;
}

export function createQueueStore(directory: string): QueueStore {
  const pathFor = (queueItemId: string): string => join(directory, `${queueItemId}${ITEM_SUFFIX}`);

  async function ensureDirectory(): Promise<void> {
    // Owner-only. A queue holds what somebody wrote about their own work, and
    // on a shared machine the default would make it readable by everyone.
    // Windows ignores the mode, which is why the test for this is
    // platform-aware rather than skipped.
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }

  async function listFiles(): Promise<string[]> {
    try {
      const entries = await readdir(directory);
      return entries.filter((name) => name.endsWith(ITEM_SUFFIX));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Nothing has been queued yet. Not a failure.
        return [];
      }
      throw error;
    }
  }

  return {
    async read(): Promise<StoredItems> {
      const files = await listFiles();
      const items: QueueItem[] = [];
      let corruptCount = 0;

      for (const name of files.sort()) {
        let text: string;
        try {
          text = await readFile(join(directory, name), 'utf8');
        } catch {
          // Vanished between the listing and the read, or unreadable. Either
          // way it is not an item, and it is not this call's business to fix.
          corruptCount += 1;
          continue;
        }

        const item = parseQueueItem(text);
        if (item === null) {
          // Left exactly where it is. Deleting what cannot be parsed would
          // throw away the only copy of something somebody wanted kept, on the
          // strength of this build not recognising it.
          corruptCount += 1;
          continue;
        }
        items.push(item);
      }

      // Oldest first, with the id breaking ties — the same ordering rule the
      // rest of this codebase uses, so a drain is deterministic.
      const ordered = [...items].sort((left, right) =>
        left.enqueuedAt === right.enqueuedAt
          ? left.queueItemId.localeCompare(right.queueItemId)
          : left.enqueuedAt.localeCompare(right.enqueuedAt),
      );

      return { items: ordered, corruptCount };
    },

    async write(item: QueueItem, limits: QueueLimits, isNew: boolean): Promise<void> {
      const serialised = serialiseQueueItem(item);
      const bytes = Buffer.byteLength(serialised, 'utf8');

      if (bytes > limits.maxItemBytes) {
        throw new QueueCapacityError('maxItemBytes');
      }

      await ensureDirectory();

      if (isNew) {
        // Checked only for a new item. An update is an item that is already
        // here, and refusing to record its attempt count because the queue is
        // full would leave it retrying forever at the same speed.
        const files = await listFiles();
        if (files.length >= limits.maxItems) {
          throw new QueueCapacityError('maxItems');
        }

        let total = 0;
        for (const name of files) {
          try {
            total += (await stat(join(directory, name))).size;
          } catch {
            // Counted as nothing. A file that cannot be measured is not a
            // reason to refuse a write.
          }
        }
        if (total + bytes > limits.maxTotalBytes) {
          throw new QueueCapacityError('maxTotalBytes');
        }
      }

      const destination = pathFor(item.queueItemId);
      const temporary = `${destination}${TEMP_SUFFIX}`;

      // Owner-only, and opened rather than written in one call so the contents
      // can be flushed before anything is renamed into place.
      const handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC,
        0o600,
      );
      try {
        await handle.writeFile(serialised, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }

      // Atomic within the directory: a reader sees the previous file or this
      // one. See the note at the top for what this does and does not promise.
      await rename(temporary, destination);
    },

    async remove(queueItemId: string): Promise<void> {
      try {
        await unlink(pathFor(queueItemId));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return;
        }
        throw error;
      }
    },
  };
}
