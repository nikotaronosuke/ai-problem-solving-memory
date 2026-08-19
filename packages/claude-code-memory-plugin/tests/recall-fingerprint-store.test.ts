/**
 * The file that remembers what was already asked.
 *
 * Everything here is about a cache being allowed to fail. It may be missing,
 * unreadable, half-written or from a version this code has never seen, and in
 * every one of those cases the answer must be "we do not know" — which the
 * composition reads as "then ask". The one thing it must never do is claim a
 * match it cannot support, because that is a search that silently never happens.
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createRecallFingerprintStore,
  recallFingerprintFilename,
  RECALL_FINGERPRINT_FORMAT_VERSION,
  RECALL_FINGERPRINT_MAX_BYTES,
} from '../src/recall-fingerprint-store.js';

const PROBLEM_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
const OTHER_PROBLEM_ID = 'bbbbbbbb-1111-4222-8333-444444444444';
const DIGEST = 'a'.repeat(64);
const OTHER_DIGEST = 'b'.repeat(64);

let directory: string;
let store: ReturnType<typeof createRecallFingerprintStore>;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'recall-fingerprints-'));
  store = createRecallFingerprintStore({ directory });
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('remembering one question per Problem', () => {
  it('reads back exactly what was written', async () => {
    await expect(store.writeFingerprint(PROBLEM_ID, DIGEST)).resolves.toEqual({
      kind: 'PERSISTED',
    });

    await expect(store.readFingerprint(PROBLEM_ID)).resolves.toEqual({
      kind: 'FOUND',
      fingerprint: DIGEST,
    });
  });

  it('says nothing about a Problem never asked about', async () => {
    await expect(store.readFingerprint(PROBLEM_ID)).resolves.toEqual({ kind: 'MISSING' });
  });

  it('keeps one record per Problem, replacing rather than accumulating', async () => {
    // This is the last settled question, not an archive. An archive would grow
    // for the lifetime of a Problem and answer a question nobody asks.
    await store.writeFingerprint(PROBLEM_ID, DIGEST);
    await store.writeFingerprint(PROBLEM_ID, OTHER_DIGEST);

    await expect(store.readFingerprint(PROBLEM_ID)).resolves.toEqual({
      kind: 'FOUND',
      fingerprint: OTHER_DIGEST,
    });
    expect(await readdir(directory)).toHaveLength(1);
  });

  it('keeps two Problems apart', async () => {
    await store.writeFingerprint(PROBLEM_ID, DIGEST);
    await store.writeFingerprint(OTHER_PROBLEM_ID, OTHER_DIGEST);

    await expect(store.readFingerprint(PROBLEM_ID)).resolves.toEqual({
      kind: 'FOUND',
      fingerprint: DIGEST,
    });
    await expect(store.readFingerprint(OTHER_PROBLEM_ID)).resolves.toEqual({
      kind: 'FOUND',
      fingerprint: OTHER_DIGEST,
    });
  });
});

describe('what is on disk', () => {
  it('names the file after a digest, never after the Problem', async () => {
    await store.writeFingerprint(PROBLEM_ID, DIGEST);
    const [name] = await readdir(directory);

    // A directory listing is not a list of what somebody is working on.
    expect(name).toBe(recallFingerprintFilename(PROBLEM_ID));
    expect(`the filename carries the id:${String(name).includes(PROBLEM_ID)}`).toBe(
      'the filename carries the id:false',
    );
    expect(name).toMatch(/^recall-[0-9a-f]{64}\.json$/u);
  });

  it('holds a version and a digest, and nothing else at all', async () => {
    await store.writeFingerprint(PROBLEM_ID, DIGEST);
    const body = await readFile(join(directory, recallFingerprintFilename(PROBLEM_ID)), 'utf8');

    // Asserted whole rather than by searching for words: what matters is that
    // there is nowhere in here for a query, a path or an identity to be.
    expect(JSON.parse(body)).toEqual({
      format_version: RECALL_FINGERPRINT_FORMAT_VERSION,
      fingerprint: DIGEST,
    });
    expect(body.includes(PROBLEM_ID)).toBe(false);
  });

  it('leaves nothing behind but the record', async () => {
    await store.writeFingerprint(PROBLEM_ID, DIGEST);
    await store.writeFingerprint(PROBLEM_ID, OTHER_DIGEST);

    expect((await readdir(directory)).every((name) => name.endsWith('.json'))).toBe(true);
  });
});

describe('what it refuses to call a match', () => {
  const write = async (body: string): Promise<void> => {
    await store.writeFingerprint(PROBLEM_ID, DIGEST);
    await writeFile(join(directory, recallFingerprintFilename(PROBLEM_ID)), body, 'utf8');
  };

  it.each([
    ['malformed JSON', 'not json at all'],
    [
      'a record from a version this code has not seen',
      JSON.stringify({ format_version: 2, fingerprint: DIGEST }),
    ],
    [
      'a record with an extra field',
      JSON.stringify({ format_version: 1, fingerprint: DIGEST, extra: 1 }),
    ],
    ['a record missing the digest', JSON.stringify({ format_version: 1 })],
    [
      'a digest that is not one',
      JSON.stringify({ format_version: 1, fingerprint: 'not-a-digest' }),
    ],
    [
      'an uppercase digest',
      JSON.stringify({ format_version: 1, fingerprint: DIGEST.toUpperCase() }),
    ],
    ['a truncated digest', JSON.stringify({ format_version: 1, fingerprint: 'a'.repeat(63) })],
    ['a digest that is not a string', JSON.stringify({ format_version: 1, fingerprint: 7 })],
  ])('refuses %s', async (_label, body) => {
    await write(body);

    // Unavailable, not `MISSING` and never `FOUND`. The composition treats it
    // the same way either way — it searches — but the two are different facts.
    await expect(store.readFingerprint(PROBLEM_ID)).resolves.toEqual({ kind: 'UNAVAILABLE' });
  });

  it('refuses a record too large to be one of its own', async () => {
    // Padded rather than given an extra field, so that what turns it away is
    // its size and not its shape. The bytes still parse to a record this
    // version would otherwise accept, which is the only way to tell the two
    // refusals apart.
    const valid = JSON.stringify({ format_version: 1, fingerprint: DIGEST });
    await write(' '.repeat(RECALL_FINGERPRINT_MAX_BYTES) + valid);

    await expect(store.readFingerprint(PROBLEM_ID)).resolves.toEqual({ kind: 'UNAVAILABLE' });
  });

  it('still accepts a record that is merely close to the bound', async () => {
    // The other half of the same fact: a bound that refused everything would
    // pass the test above while never reading a record at all.
    const valid = JSON.stringify({ format_version: 1, fingerprint: DIGEST });
    await write(' '.repeat(RECALL_FINGERPRINT_MAX_BYTES - valid.length) + valid);

    await expect(store.readFingerprint(PROBLEM_ID)).resolves.toEqual({
      kind: 'FOUND',
      fingerprint: DIGEST,
    });
  });

  it('refuses to write something that is not a digest', async () => {
    await expect(store.writeFingerprint(PROBLEM_ID, 'not-a-digest')).resolves.toEqual({
      kind: 'NOT_PERSISTED',
    });
    await expect(store.readFingerprint(PROBLEM_ID)).resolves.toEqual({ kind: 'MISSING' });
  });
});

describe('when the filesystem will not cooperate', () => {
  it('reports a directory it cannot write into, rather than throwing', async () => {
    // A path whose parent is a file, so creating the directory cannot work.
    const blocked = join(directory, 'a-file', 'inside-it');
    await writeFile(join(directory, 'a-file'), 'not a directory', 'utf8');
    const stubborn = createRecallFingerprintStore({ directory: blocked });

    await expect(stubborn.writeFingerprint(PROBLEM_ID, DIGEST)).resolves.toEqual({
      kind: 'NOT_PERSISTED',
    });
    // Which of the two not-found answers comes back is the platform's to say —
    // a path under a file is ENOENT here and ENOTDIR elsewhere. What must hold
    // is that it neither throws nor claims a match.
    const read = await stubborn.readFingerprint(PROBLEM_ID);
    expect(read.kind === 'MISSING' || read.kind === 'UNAVAILABLE').toBe(true);
  });

  it('cannot be left half-written in a state that reads as a match', async () => {
    // The record is written beside and moved into place, so an interruption
    // leaves litter rather than a plausible-looking record that would suppress
    // a search which never happened.
    await store.writeFingerprint(PROBLEM_ID, DIGEST);
    const path = join(directory, recallFingerprintFilename(PROBLEM_ID));
    const whole = await readFile(path, 'utf8');

    for (let cut = 1; cut < whole.length; cut++) {
      await writeFile(path, whole.slice(0, cut), 'utf8');
      const read = await store.readFingerprint(PROBLEM_ID);
      expect(`a ${String(cut)}-byte prefix reads as:${read.kind}`).toBe(
        `a ${String(cut)}-byte prefix reads as:UNAVAILABLE`,
      );
    }
  });
});

describe('two writers at once', () => {
  it('leaves one whole record, never a mixture of several', async () => {
    // Two sessions can reach the same Problem at the same time. Each writes
    // beside and moves into place, so a loser is overwritten rather than
    // interleaved with a winner. A mixture would be a digest belonging to no
    // question anybody asked, which is the one outcome that would suppress a
    // search that never ran.
    //
    // Some of these writes are expected to report that they did not persist.
    // Replacing a file that another writer is replacing at that instant is
    // refused on Windows, and this store deliberately does not retry: a lost
    // cache write costs one repeated search, whereas a retry loop here would
    // be real complexity guarding a value nothing is allowed to trust.
    const digests = Array.from({ length: 8 }, (_unused, index) =>
      String(index).padStart(64, String(index)),
    );

    const written = await Promise.all(
      digests.map(async (digest) => store.writeFingerprint(PROBLEM_ID, digest)),
    );

    expect(written.some((outcome) => outcome.kind === 'PERSISTED')).toBe(true);
    expect(await readdir(directory)).toHaveLength(1);

    const read = await store.readFingerprint(PROBLEM_ID);
    expect(read.kind).toBe('FOUND');
    expect(
      `the record is one of the digests written:${String(digests.includes((read as { fingerprint: string }).fingerprint))}`,
    ).toBe('the record is one of the digests written:true');
  });

  it('reports a write it did not make, rather than claiming it', async () => {
    // The direction of the lie that matters: a writer told PERSISTED when
    // nothing landed would believe the question was on record. Told
    // NOT_PERSISTED, the worst it does is ask again.
    const digests = Array.from({ length: 8 }, (_unused, index) =>
      String(index).padStart(64, String(index)),
    );

    const written = await Promise.all(
      digests.map(async (digest) => store.writeFingerprint(PROBLEM_ID, digest)),
    );
    const stored = (await store.readFingerprint(PROBLEM_ID)) as { fingerprint: string };

    // Whichever writers were told they persisted, the record is one of theirs.
    const claimed = digests.filter((_unused, index) => written[index]?.kind === 'PERSISTED');
    expect(
      `the record belongs to a writer that was told it persisted:${String(claimed.includes(stored.fingerprint))}`,
    ).toBe('the record belongs to a writer that was told it persisted:true');
  });

  it('reads cleanly while a write is in flight', async () => {
    await store.writeFingerprint(PROBLEM_ID, DIGEST);

    const [read] = await Promise.all([
      store.readFingerprint(PROBLEM_ID),
      store.writeFingerprint(PROBLEM_ID, OTHER_DIGEST),
    ]);

    // Either the old record or the new one. Never a partial file, and never a
    // failure caused by somebody else replacing it mid-read.
    expect(read.kind).toBe('FOUND');
    expect([DIGEST, OTHER_DIGEST]).toContain((read as { fingerprint: string }).fingerprint);
  });
});
