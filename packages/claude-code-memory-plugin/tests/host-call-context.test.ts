/**
 * The rendezvous between a trusted hook and the call it was run for.
 *
 * The property under test is narrow and the failure it prevents is not: a
 * record minted for one call must be usable by that call and by nothing else.
 * An earlier design keyed records on a value carried through the tool's input,
 * and a record left behind by a call whose handler never ran authenticated a
 * later unrelated call. Several tests here exist because of that measurement
 * rather than in anticipation of it.
 */

import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { randomUUID } from 'node:crypto';

import {
  callContextFilename,
  claimCallContext,
  hostCallIdOf,
  isHostCallContext,
  isOwnedCallContextFilename,
  mintCallContext,
  sweepCallContexts,
} from '../src/host-call-context.js';
import {
  CALL_CONTEXT_MAX_AGE_MS,
  CALL_CONTEXT_MAX_BYTES,
  HOST_TOOL_NAME,
} from '../src/runtime-constants.js';

/** Synthetic. Shaped like a host call id, and not one. */
const CALL_ID = 'toolu_01AAAAAAAAAAAAAAAAAAAAAA';
const OTHER_CALL_ID = 'toolu_01BBBBBBBBBBBBBBBBBBBBBB';
const SESSION_ID = '11111111-2222-4333-8444-555555555555';

const NOW = 1_800_000_000_000;

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'call-context-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function mint(hostCallId = CALL_ID, now = NOW): Promise<boolean> {
  return mintCallContext({
    directory,
    hostCallId,
    sessionId: SESSION_ID,
    toolName: HOST_TOOL_NAME,
    now,
  });
}

async function claim(hostCallId = CALL_ID, now = NOW) {
  return claimCallContext({ directory, hostCallId, toolName: HOST_TOOL_NAME, now });
}

describe('reading the host identifier for the call being served', () => {
  it('reads it from protocol metadata', () => {
    expect(hostCallIdOf({ _meta: { 'claudecode/toolUseId': CALL_ID } })).toBe(CALL_ID);
  });

  it.each([
    ['no request at all', undefined],
    ['a request with no metadata', { method: 'tools/call' }],
    ['metadata that is not an object', { _meta: 'x' }],
    ['metadata without the key', { _meta: { progressToken: 1 } }],
    ['a blank value', { _meta: { 'claudecode/toolUseId': '  ' } }],
    ['a value that is not text', { _meta: { 'claudecode/toolUseId': 7 } }],
  ])('answers nothing for %s', (_name, request) => {
    expect(hostCallIdOf(request)).toBeUndefined();
  });

  it('never reads an identifier out of the tool arguments', () => {
    // The arguments are the model's. Everything this refuses here is a name
    // somebody might reasonably expect to work, which is why each is listed.
    for (const request of [
      { arguments: { tool_use_id: CALL_ID } },
      { params: { arguments: { _meta: { 'claudecode/toolUseId': CALL_ID } } } },
      { id: CALL_ID },
      { _meta: { progressToken: CALL_ID } },
    ]) {
      expect(hostCallIdOf(request)).toBeUndefined();
    }
  });
});

describe('the name a record lives under', () => {
  it('is the same for the same call, every time', () => {
    expect(callContextFilename(CALL_ID)).toBe(callContextFilename(CALL_ID));
  });

  it('is different for a different call', () => {
    expect(callContextFilename(CALL_ID)).not.toBe(callContextFilename(OTHER_CALL_ID));
  });

  it('is fixed lowercase hex and never the identifier itself', () => {
    const name = callContextFilename(CALL_ID);

    expect(name).toMatch(/^pending-[0-9a-f]{64}\.json$/u);
    expect(name.includes(CALL_ID)).toBe(false);
  });

  it('cannot be talked out of the directory it belongs in', () => {
    // The identifier is an undocumented host value. It looks path-safe today,
    // and a hash means that never has to be true.
    for (const hostile of ['../../escape', 'C:\\Windows\\system32', 'a/b/c', '..']) {
      const name = callContextFilename(hostile);
      expect(name).toMatch(/^pending-[0-9a-f]{64}\.json$/u);
    }
  });
});

describe('minting', () => {
  it('writes one record with exactly the four fields', async () => {
    expect(await mint()).toBe(true);

    const files = await readdir(directory);
    expect(files).toEqual([callContextFilename(CALL_ID)]);
    const record: unknown = JSON.parse(await readFile(join(directory, files[0] as string), 'utf8'));
    expect(Object.keys(record as object).sort()).toEqual([
      'format_version',
      'minted_at',
      'session_id',
      'tool_name',
    ]);
    expect(isHostCallContext(record)).toBe(true);
  });

  it('records nothing about the work', async () => {
    await mint();
    const body = await readFile(join(directory, callContextFilename(CALL_ID)), 'utf8');

    // Asserted as the whole value rather than by searching for words, because
    // the tool name legitimately contains several of them. What matters is
    // that there is nowhere in here for a Project, a Problem, a title or a
    // path to be.
    expect(JSON.parse(body)).toEqual({
      format_version: 1,
      session_id: SESSION_ID,
      tool_name: HOST_TOOL_NAME,
      minted_at: NOW,
    });
    // And not even the identifier it is named after: the filename carries it,
    // so the contents never need to.
    expect(body.includes(CALL_ID)).toBe(false);
  });

  it('refuses to replace a record already there', async () => {
    // Two host events claiming one call is unexplained, and keeping the second
    // would hand the call whichever session wrote last.
    expect(await mint()).toBe(true);
    expect(await mint()).toBe(false);
    expect(await readdir(directory)).toHaveLength(1);
  });
});

describe('claiming', () => {
  it('hands back the session the hook recorded', async () => {
    await mint();

    await expect(claim()).resolves.toEqual({ kind: 'CLAIMED', sessionId: SESSION_ID });
  });

  it('leaves nothing behind to claim twice', async () => {
    await mint();

    await expect(claim()).resolves.toMatchObject({ kind: 'CLAIMED' });
    await expect(claim()).resolves.toEqual({ kind: 'UNAVAILABLE' });
    expect(await readdir(directory)).toEqual([]);
  });

  it('refuses a call nothing was minted for', async () => {
    await expect(claim()).resolves.toEqual({ kind: 'UNAVAILABLE' });
  });

  it('refuses the record minted for a different call', async () => {
    // The heart of it. A record that exists is not a record for *this* call,
    // and there is no second place to look.
    await mint(OTHER_CALL_ID);

    await expect(claim(CALL_ID)).resolves.toEqual({ kind: 'UNAVAILABLE' });
    // And the other call's record is untouched, still there for its own call.
    expect(await readdir(directory)).toEqual([callContextFilename(OTHER_CALL_ID)]);
  });

  it('gives one record to exactly one of ten simultaneous claimants', async () => {
    await mint();

    const claims = await Promise.all(Array.from({ length: 10 }, () => claim()));

    expect(claims.filter((c) => c.kind === 'CLAIMED')).toHaveLength(1);
    expect(claims.filter((c) => c.kind === 'UNAVAILABLE')).toHaveLength(9);
  });

  it('lets ten distinct calls succeed independently', async () => {
    const ids = Array.from({ length: 10 }, (_v, index) => `toolu_parallel_${String(index)}`);
    await Promise.all(ids.map((id) => mint(id)));

    const claims = await Promise.all(ids.map((id) => claim(id)));

    expect(claims.every((c) => c.kind === 'CLAIMED')).toBe(true);
  });

  it('refuses a record minted for another tool', async () => {
    await mintCallContext({
      directory,
      hostCallId: CALL_ID,
      sessionId: SESSION_ID,
      toolName: 'mcp__something__else',
      now: NOW,
    });

    await expect(claim()).resolves.toEqual({ kind: 'UNAVAILABLE' });
  });

  it.each([
    ['malformed JSON', 'not json at all'],
    [
      'a record with an extra field',
      JSON.stringify({
        format_version: 1,
        session_id: 's',
        tool_name: HOST_TOOL_NAME,
        minted_at: NOW,
        extra: 1,
      }),
    ],
    [
      'a record missing a field',
      JSON.stringify({ format_version: 1, session_id: 's', minted_at: NOW }),
    ],
    [
      'an unknown format version',
      JSON.stringify({
        format_version: 2,
        session_id: 's',
        tool_name: HOST_TOOL_NAME,
        minted_at: NOW,
      }),
    ],
    [
      'a blank session',
      JSON.stringify({
        format_version: 1,
        session_id: '  ',
        tool_name: HOST_TOOL_NAME,
        minted_at: NOW,
      }),
    ],
    [
      'a fractional timestamp',
      JSON.stringify({
        format_version: 1,
        session_id: 's',
        tool_name: HOST_TOOL_NAME,
        minted_at: 1.5,
      }),
    ],
  ])('refuses %s', async (_name, body) => {
    await writeFile(join(directory, callContextFilename(CALL_ID)), body, 'utf8');

    await expect(claim()).resolves.toEqual({ kind: 'UNAVAILABLE' });
  });

  it('refuses a record that has aged out', async () => {
    await mint(CALL_ID, NOW - CALL_CONTEXT_MAX_AGE_MS - 1);

    await expect(claim(CALL_ID, NOW)).resolves.toEqual({ kind: 'UNAVAILABLE' });
  });

  it('accepts one that has not', async () => {
    await mint(CALL_ID, NOW - CALL_CONTEXT_MAX_AGE_MS + 1000);

    await expect(claim(CALL_ID, NOW)).resolves.toMatchObject({ kind: 'CLAIMED' });
  });

  it('refuses a record stamped in the future', async () => {
    // Not written by a clock this process shares, so its age means nothing.
    await mint(CALL_ID, NOW + 60_000);

    await expect(claim(CALL_ID, NOW)).resolves.toEqual({ kind: 'UNAVAILABLE' });
  });
});

describe('recognising this component’s own files', () => {
  it('accepts exactly the two shapes it generates', () => {
    const digest = 'a'.repeat(64);

    expect(isOwnedCallContextFilename(`pending-${digest}.json`)).toBe(true);
    expect(isOwnedCallContextFilename(`claimed-${digest}-${randomUUID()}.json`)).toBe(true);
  });

  it.each([
    ['a name nobody here could have produced', 'pending-not-ours.json'],
    ['the same, claimed', 'claimed-not-ours.json'],
    ['a digest that is too short', `pending-${'a'.repeat(63)}.json`],
    ['a digest that is not hex', `pending-${'g'.repeat(64)}.json`],
    ['an uppercase digest', `pending-${'A'.repeat(64)}.json`],
    ['a claim with no identifier', `claimed-${'a'.repeat(64)}.json`],
    ['a claim whose identifier is not one', `claimed-${'a'.repeat(64)}-abc.json`],
    ['something else entirely', 'notes.txt'],
  ])('refuses %s', (_name, entry) => {
    expect(isOwnedCallContextFilename(entry)).toBe(false);
  });
});

describe('sweeping', () => {
  /** Ages a file by moving its timestamps, which is what the sweep reads. */
  async function age(name: string, milliseconds: number): Promise<void> {
    const when = new Date(Date.now() - milliseconds);
    await utimes(join(directory, name), when, when);
  }

  const claimedName = (hostCallId: string) =>
    callContextFilename(hostCallId, 'claimed-').replace('.json', `-${randomUUID()}.json`);

  it('removes pending records nobody will ever claim', async () => {
    await mint();
    await age(callContextFilename(CALL_ID), CALL_CONTEXT_MAX_AGE_MS + 60_000);

    await sweepCallContexts({ directory, now: Date.now() });

    expect(await readdir(directory)).toEqual([]);
  });

  it('removes claimed records a crash left behind', async () => {
    const name = claimedName(CALL_ID);
    await writeFile(join(directory, name), '{}', 'utf8');
    await age(name, CALL_CONTEXT_MAX_AGE_MS + 60_000);

    await sweepCallContexts({ directory, now: Date.now() });

    expect(await readdir(directory)).toEqual([]);
  });

  it('leaves a record that is still current', async () => {
    await mint();

    await sweepCallContexts({ directory, now: Date.now() });

    expect(await readdir(directory)).toEqual([callContextFilename(CALL_ID)]);
  });

  it('leaves a record another hook is still writing', async () => {
    // The race this rule exists for. Two hooks run in parallel; one has created
    // its file and not finished writing it, and the other sweeps. A sweep that
    // judged files by whether they parse would delete exactly that one, and the
    // first call — perfectly valid, already allowed — would find nothing to
    // claim. That is an availability failure in the parallel path this runtime
    // is meant to support, so incompleteness is never a reason to delete.
    const name = callContextFilename(CALL_ID);
    await writeFile(join(directory, name), '{', 'utf8');

    await sweepCallContexts({ directory, now: Date.now() });

    expect(await readdir(directory)).toEqual([name]);
  });

  it('leaves a claim another call is still writing', async () => {
    const name = claimedName(CALL_ID);
    await writeFile(join(directory, name), '{"format_ver', 'utf8');

    await sweepCallContexts({ directory, now: Date.now() });

    expect(await readdir(directory)).toEqual([name]);
  });

  it('removes an old record it could never have read', async () => {
    // Age is the only question a sweep asks. Once a file of ours is genuinely
    // old, whether its contents parse is beside the point — and not reading
    // them means housekeeping never parses half-written data at all.
    const name = callContextFilename(CALL_ID);
    await writeFile(join(directory, name), 'not json', 'utf8');
    await age(name, CALL_CONTEXT_MAX_AGE_MS + 60_000);

    await sweepCallContexts({ directory, now: Date.now() });

    expect(await readdir(directory)).toEqual([]);
  });

  it('removes an old claim it could never have read', async () => {
    const name = claimedName(CALL_ID);
    await writeFile(join(directory, name), 'not json', 'utf8');
    await age(name, CALL_CONTEXT_MAX_AGE_MS + 60_000);

    await sweepCallContexts({ directory, now: Date.now() });

    expect(await readdir(directory)).toEqual([]);
  });

  it.each([
    ['pending-not-ours.json'],
    ['claimed-not-ours.json'],
    [`pending-${'a'.repeat(63)}.json`],
  ])('never removes %s, however old', async (name) => {
    // This directory belongs to the plugin, not to this module. A file it
    // could not have written is somebody else's, and age is no licence.
    await writeFile(join(directory, name), 'x', 'utf8');
    await age(name, CALL_CONTEXT_MAX_AGE_MS * 100);

    await sweepCallContexts({ directory, now: Date.now() });

    expect(await readdir(directory)).toEqual([name]);
  });

  it('never removes a file stamped in the future', async () => {
    // Further ahead than the cleanup age, deliberately. A distance is not an
    // age: a file stamped after now was not written long ago, and treating the
    // gap as one would delete a record whose clock merely disagrees.
    const name = callContextFilename(CALL_ID);
    await mint();
    const ahead = new Date(Date.now() + CALL_CONTEXT_MAX_AGE_MS * 2);
    await utimes(join(directory, name), ahead, ahead);

    await sweepCallContexts({ directory, now: Date.now() });

    expect(await readdir(directory)).toEqual([name]);
  });

  it('does not mind a directory that is not there', async () => {
    await expect(
      sweepCallContexts({ directory: join(directory, 'absent'), now: Date.now() }),
    ).resolves.toBeUndefined();
  });

  it('authenticates nothing when it cannot tidy', async () => {
    // A stale file that cannot be removed is litter, not a key. The claim for
    // this call still fails because no record for *this* call exists.
    await writeFile(join(directory, 'pending-unreadable.json'), '{', 'utf8');

    await sweepCallContexts({ directory, now: Date.now() });

    await expect(claim()).resolves.toEqual({ kind: 'UNAVAILABLE' });
  });
});

describe('minting and sweeping at the same time', () => {
  it('leaves every minted call claimable', async () => {
    // Supplementary to the deterministic tests above rather than a substitute:
    // real interleaving, no sleeps, and the property is that nothing minted
    // goes missing.
    const ids = Array.from({ length: 20 }, (_v, index) => `toolu_together_${String(index)}`);

    await Promise.all(
      ids.flatMap((id) => [
        mint(id, Date.now()),
        sweepCallContexts({ directory, now: Date.now() }),
      ]),
    );

    const claims = await Promise.all(ids.map((id) => claim(id, Date.now())));

    expect(claims.filter((c) => c.kind === 'CLAIMED')).toHaveLength(ids.length);
  });
});

describe('how much of a claimed record is read', () => {
  it('refuses one larger than a record could be, without parsing it', async () => {
    // The size is a property of the file, checked before its bytes are taken.
    // Measuring a string after reading it is not a bound: by then whatever was
    // there is already in memory.
    await writeFile(
      join(directory, callContextFilename(CALL_ID)),
      JSON.stringify({
        format_version: 1,
        session_id: SESSION_ID,
        tool_name: HOST_TOOL_NAME,
        minted_at: NOW,
        // Valid JSON, and far too much of it.
        filler: 'x'.repeat(CALL_CONTEXT_MAX_BYTES),
      }),
      'utf8',
    );

    await expect(claim(CALL_ID, NOW)).resolves.toEqual({ kind: 'UNAVAILABLE' });
    // And the oversized file does not stay behind.
    expect(await readdir(directory)).toEqual([]);
  });

  it('accepts an ordinary record', async () => {
    await mint();

    await expect(claim()).resolves.toEqual({ kind: 'CLAIMED', sessionId: SESSION_ID });
  });
});
