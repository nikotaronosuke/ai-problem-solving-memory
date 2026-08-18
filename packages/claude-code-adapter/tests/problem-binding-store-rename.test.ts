/**
 * The one retry in this store, and the three things it must not become.
 *
 * Replacing a file on Windows fails with `EPERM` while another process holds
 * the destination open. It is transient and it is real — the design
 * investigation measured it — so the rename is attempted a few more times.
 *
 * That is a narrow allowance and it is easy to widen by accident, so all three
 * edges are pinned here: only `EPERM` is retried, the budget is finite, and a
 * retry re-attempts the *move* rather than redoing the write. Everything else
 * fails on the first answer, because retrying a denied path or a missing
 * directory is the same answer arriving later.
 *
 * `rename` is mocked and the rest of the filesystem is real, so the temporary
 * file this leaves behind is a real file and the cleanup assertion is a real
 * observation rather than a spy.
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const renameMock = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, rename: renameMock };
});

const { createProblemBindingStore } = await import('../src/index.js');

const SESSION = '2a2a675a-a932-43c1-92db-04bed693927f';
const PROJECT = '11111111-2222-4333-8444-555555555555';
const PROBLEM = 'aaaaaaaa-1111-4222-8333-444444444444';

/** An error shaped the way the filesystem raises one. */
function fsError(code: string): NodeJS.ErrnoException {
  const error = new Error('a fixed sentence') as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'binding-rename-'));
  renameMock.mockReset();
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('a rename that lost a race', () => {
  it('succeeds when a later attempt goes through', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    renameMock
      .mockRejectedValueOnce(fsError('EPERM'))
      .mockImplementation((from: string, to: string) => actual.rename(from, to));

    const store = createProblemBindingStore({ directory });

    await expect(store.writeBinding(SESSION, PROJECT, PROBLEM)).resolves.toEqual({
      kind: 'WRITTEN',
    });
    expect(renameMock).toHaveBeenCalledTimes(2);
    await expect(store.readBinding(SESSION, PROJECT)).resolves.toEqual({
      kind: 'VALID',
      binding: { projectId: PROJECT, problemId: PROBLEM },
    });
  });

  it('re-attempts the move rather than redoing the write', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const sources: string[] = [];
    renameMock.mockImplementation((from: string, to: string) => {
      sources.push(from);
      return sources.length < 3 ? Promise.reject(fsError('EPERM')) : actual.rename(from, to);
    });

    const store = createProblemBindingStore({ directory });
    await expect(store.writeBinding(SESSION, PROJECT, PROBLEM)).resolves.toEqual({
      kind: 'WRITTEN',
    });

    // The same finished temporary each time. A retry that rebuilt the file
    // would be doing the work again for a failure that was never about the
    // content.
    expect(new Set(sources).size).toBe(1);
  });

  it('gives up after a finite number of attempts', async () => {
    renameMock.mockRejectedValue(fsError('EPERM'));

    const store = createProblemBindingStore({ directory });

    await expect(store.writeBinding(SESSION, PROJECT, PROBLEM)).resolves.toEqual({
      kind: 'IO_FAILURE',
    });
    // Bounded, and small. The exact number is an implementation constant; that
    // there is one is not.
    expect(renameMock.mock.calls.length).toBeGreaterThan(1);
    expect(renameMock.mock.calls.length).toBeLessThanOrEqual(8);
  });

  it('reports a failure rather than claiming to have written', async () => {
    renameMock.mockRejectedValue(fsError('EPERM'));

    const store = createProblemBindingStore({ directory });
    await store.writeBinding(SESSION, PROJECT, PROBLEM);

    await expect(store.readBinding(SESSION, PROJECT)).resolves.toEqual({ kind: 'MISSING' });
  });
});

describe('a rename that failed for any other reason', () => {
  it.each(['EACCES', 'ENOSPC', 'EXDEV', 'ENOENT', 'EBUSY'])('does not retry %s', async (code) => {
    renameMock.mockRejectedValue(fsError(code));

    const store = createProblemBindingStore({ directory });

    await expect(store.writeBinding(SESSION, PROJECT, PROBLEM)).resolves.toEqual({
      kind: 'IO_FAILURE',
    });
    expect(renameMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry an error carrying no code at all', async () => {
    renameMock.mockRejectedValue(new Error('a fixed sentence'));

    const store = createProblemBindingStore({ directory });

    await expect(store.writeBinding(SESSION, PROJECT, PROBLEM)).resolves.toEqual({
      kind: 'IO_FAILURE',
    });
    expect(renameMock).toHaveBeenCalledTimes(1);
  });
});

describe('what is left on disk when the move never happens', () => {
  it('clears the temporary it created', async () => {
    renameMock.mockRejectedValue(fsError('EPERM'));

    const store = createProblemBindingStore({ directory });
    await store.writeBinding(SESSION, PROJECT, PROBLEM);

    // Best effort, and it worked here: nothing is left for somebody to wonder
    // about later. A leftover would be harmless — readers address one exact
    // filename and never list the directory — but harmless litter still
    // accumulates.
    expect(await readdir(directory)).toEqual([]);
  });

  it('never leaves a partial record under the real name', async () => {
    renameMock.mockRejectedValue(fsError('EACCES'));

    const store = createProblemBindingStore({ directory });
    await store.writeBinding(SESSION, PROJECT, PROBLEM);

    // The destination name is only ever produced by a completed rename, so a
    // failed write cannot leave half a record where a reader looks.
    await expect(store.readBinding(SESSION, PROJECT)).resolves.toEqual({ kind: 'MISSING' });
    expect(await readdir(directory)).toEqual([]);
  });
});
