/**
 * What the binding store keeps, and what it refuses to guess.
 *
 * Two properties carry most of the weight here, and both are about losing
 * something quietly rather than about failing loudly.
 *
 * The first is that a binding belongs to a *pair*. A session that visits
 * Project B and comes back to Project A must still be on the Problem it was on
 * — so `A → B → A` is tested directly, because the version of this that keys on
 * the session alone passes every other test in this file.
 *
 * The second is that a failure is never an answer. A corrupt record and a
 * permission error both mean "ask the server", but neither of them means "this
 * owner has no Problem here", and a store that reported `MISSING` for them
 * would be indistinguishable from an empty one for as long as it stayed broken.
 */

import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createProblemBindingStore,
  ProblemBindingArgumentError,
  type ProblemBindingStore,
} from '../src/index.js';

const SESSION = '2a2a675a-a932-43c1-92db-04bed693927f';
const OTHER_SESSION = 'f30e26fe-a76b-44c9-a3a7-aa5527f224ce';
const PROJECT_A = '11111111-2222-4333-8444-555555555555';
const PROJECT_B = '77777777-6666-4555-8444-333333333333';
const PROBLEM_A = 'aaaaaaaa-1111-4222-8333-444444444444';
const PROBLEM_B = 'cccccccc-1111-4222-8333-444444444444';

let directory: string;
let store: ProblemBindingStore;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'binding-store-'));
  store = createProblemBindingStore({ directory });
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** Every file in the store directory, so leftovers are visible. */
async function entries(): Promise<string[]> {
  return (await readdir(directory)).sort();
}

/** The single stored file, parsed. Fails loudly if there is not exactly one. */
async function onlyRecord(): Promise<Record<string, unknown>> {
  const files = await entries();
  expect(files).toHaveLength(1);
  return JSON.parse(await readFile(join(directory, files[0] as string), 'utf8')) as Record<
    string,
    unknown
  >;
}

/** Plants a raw file at whatever name the store would use for this pair. */
async function plant(sessionId: string, projectId: string, contents: string): Promise<void> {
  await store.writeBinding(sessionId, projectId, PROBLEM_A);
  const files = await entries();
  await writeFile(join(directory, files[0] as string), contents, 'utf8');
}

describe('the directory it is given', () => {
  it('accepts an absolute one', () => {
    expect(() => createProblemBindingStore({ directory })).not.toThrow();
  });

  it('refuses a relative one, before anything is written', async () => {
    // Relative would resolve against whatever the working directory happens to
    // be — for a tool running inside somebody's editor, their repository.
    for (const bad of ['bindings', './bindings', '../bindings', '', '   ']) {
      expect(() => createProblemBindingStore({ directory: bad })).toThrow(
        ProblemBindingArgumentError,
      );
    }
    expect(await entries()).toEqual([]);
  });

  it('names the argument and not the value it refused', () => {
    const planted = 'a-path-nobody-should-see-in-a-log';
    try {
      createProblemBindingStore({ directory: planted });
      expect.unreachable('a relative directory must be refused');
    } catch (error) {
      expect((error as ProblemBindingArgumentError).argument).toBe('directory');
      expect((error as Error).message.includes(planted)).toBe(false);
    }
  });

  it('creates the directory when it does not exist yet', async () => {
    const nested = join(directory, 'a', 'b', 'bindings');
    const deep = createProblemBindingStore({ directory: nested });

    await expect(deep.writeBinding(SESSION, PROJECT_A, PROBLEM_A)).resolves.toEqual({
      kind: 'WRITTEN',
    });
    await expect(deep.readBinding(SESSION, PROJECT_A)).resolves.toEqual({
      kind: 'VALID',
      binding: { projectId: PROJECT_A, problemId: PROBLEM_A },
    });
  });
});

describe('the identities it is given', () => {
  it.each([
    ['session id', () => store.readBinding('', PROJECT_A)],
    ['project id', () => store.readBinding(SESSION, '')],
    ['session id', () => store.writeBinding('', PROJECT_A, PROBLEM_A)],
    ['project id', () => store.writeBinding(SESSION, '', PROBLEM_A)],
    ['problem id', () => store.writeBinding(SESSION, PROJECT_A, '')],
    ['session id', () => store.removeBinding('', PROJECT_A)],
    ['project id', () => store.removeBinding(SESSION, '')],
  ])('refuses a blank %s', async (argument, call) => {
    await expect(call()).rejects.toMatchObject({
      name: 'ProblemBindingArgumentError',
      argument,
    });
  });

  it('treats a session identifier as opaque rather than as a UUID', async () => {
    // The host owns that syntax and may change it. A second copy of the rule
    // here would start rejecting perfectly good identities the day it moved.
    for (const opaque of [
      'not-a-uuid',
      'session/../..',
      'ABC',
      '  spaced  ',
      '日本語',
      'x'.repeat(4096),
    ]) {
      await expect(store.writeBinding(opaque, PROJECT_A, PROBLEM_A)).resolves.toEqual({
        kind: 'WRITTEN',
      });
      await expect(store.readBinding(opaque, PROJECT_A)).resolves.toEqual({
        kind: 'VALID',
        binding: { projectId: PROJECT_A, problemId: PROBLEM_A },
      });
    }
  });

  it('does not trim, fold or otherwise change an identity into another one', async () => {
    await store.writeBinding(' padded ', PROJECT_A, PROBLEM_A);

    // Each of these is a different identity, so none of them may find it.
    for (const near of ['padded', ' padded', 'padded ', 'PADDED']) {
      await expect(store.readBinding(near, PROJECT_A)).resolves.toEqual({ kind: 'MISSING' });
    }
  });
});

describe('the key is a session and a Project together', () => {
  it('keeps one file per pair', async () => {
    await store.writeBinding(SESSION, PROJECT_A, PROBLEM_A);
    await store.writeBinding(SESSION, PROJECT_B, PROBLEM_B);
    await store.writeBinding(OTHER_SESSION, PROJECT_A, PROBLEM_A);

    expect(await entries()).toHaveLength(3);
  });

  it('preserves a binding across A to B and back to A', async () => {
    // The property this whole key exists for. A store keyed on the session
    // alone passes every other test in this file and fails here.
    await store.writeBinding(SESSION, PROJECT_A, PROBLEM_A);
    await store.writeBinding(SESSION, PROJECT_B, PROBLEM_B);

    await expect(store.readBinding(SESSION, PROJECT_A)).resolves.toEqual({
      kind: 'VALID',
      binding: { projectId: PROJECT_A, problemId: PROBLEM_A },
    });
    await expect(store.readBinding(SESSION, PROJECT_B)).resolves.toEqual({
      kind: 'VALID',
      binding: { projectId: PROJECT_B, problemId: PROBLEM_B },
    });
  });

  it('gives the same pair the same file every time', async () => {
    await store.writeBinding(SESSION, PROJECT_A, PROBLEM_A);
    const first = await entries();
    await store.writeBinding(SESSION, PROJECT_A, PROBLEM_B);

    expect(await entries()).toEqual(first);
  });

  it('does not run the two halves of the key together', async () => {
    // `["ab","c"]` and `["a","bc"]` must not hash alike, which plain
    // concatenation would make them.
    await store.writeBinding('ab', 'c', PROBLEM_A);
    await store.writeBinding('a', 'bc', PROBLEM_B);

    expect(await entries()).toHaveLength(2);
    await expect(store.readBinding('ab', 'c')).resolves.toMatchObject({
      binding: { problemId: PROBLEM_A },
    });
  });

  it('bounds the filename however long the identity is', async () => {
    await store.writeBinding('x'.repeat(100_000), PROJECT_A, PROBLEM_A);

    const [name] = await entries();
    // A hex digest and a suffix, whatever went in.
    expect(name).toBe(`${(name as string).slice(0, 64)}.json`);
    expect(name).toMatch(/^[0-9a-f]{64}\.json$/);
  });

  it('puts no identity in the filename', async () => {
    await store.writeBinding(SESSION, PROJECT_A, PROBLEM_A);

    const [name] = await entries();
    for (const identity of [SESSION, PROJECT_A, PROBLEM_A]) {
      expect(`${name} contains ${identity}:${(name as string).includes(identity)}`).toBe(
        `${name} contains ${identity}:false`,
      );
    }
  });

  it('cannot be argued out of its own directory', async () => {
    // Traversal is not filtered here, it is unreachable: a hex digest has no
    // separator, no dot-dot and no drive letter in it.
    for (const hostile of ['../../etc/passwd', '..\\..\\windows', '/absolute', 'C:\\somewhere']) {
      await store.writeBinding(hostile, hostile, PROBLEM_A);
    }

    for (const name of await entries()) {
      expect(name).toMatch(/^[0-9a-f]{64}\.json$/);
    }
    expect(await entries()).toHaveLength(4);
  });
});

describe('reading', () => {
  it('reports a pair nothing was ever written for as missing', async () => {
    await expect(store.readBinding(SESSION, PROJECT_A)).resolves.toEqual({ kind: 'MISSING' });
  });

  it('returns the hint and nothing else', async () => {
    await store.writeBinding(SESSION, PROJECT_A, PROBLEM_A);

    const read = await store.readBinding(SESSION, PROJECT_A);

    expect(read).toEqual({
      kind: 'VALID',
      binding: { projectId: PROJECT_A, problemId: PROBLEM_A },
    });
    expect(Object.keys((read as { binding: object }).binding).sort()).toEqual([
      'problemId',
      'projectId',
    ]);
  });

  it.each([
    ['malformed JSON', '{not json'],
    ['an empty file', ''],
    ['an array', '[]'],
    ['a string', '"a binding"'],
    ['null', 'null'],
    ['a number', '7'],
  ])('reports %s as unreadable', async (_name, contents) => {
    await plant(SESSION, PROJECT_A, contents);

    await expect(store.readBinding(SESSION, PROJECT_A)).resolves.toEqual({ kind: 'UNREADABLE' });
  });

  it.each([
    ['a missing field', { format_version: 1, session_id: SESSION, project_id: PROJECT_A }],
    [
      'an extra field',
      {
        format_version: 1,
        session_id: SESSION,
        project_id: PROJECT_A,
        problem_id: PROBLEM_A,
        recorded_at: '2026-01-01T00:00:00.000Z',
      },
    ],
    [
      'a version nobody here knows',
      { format_version: 2, session_id: SESSION, project_id: PROJECT_A, problem_id: PROBLEM_A },
    ],
    [
      'a version that is not a number',
      { format_version: '1', session_id: SESSION, project_id: PROJECT_A, problem_id: PROBLEM_A },
    ],
    [
      'another session',
      {
        format_version: 1,
        session_id: OTHER_SESSION,
        project_id: PROJECT_A,
        problem_id: PROBLEM_A,
      },
    ],
    [
      'another Project',
      { format_version: 1, session_id: SESSION, project_id: PROJECT_B, problem_id: PROBLEM_A },
    ],
    [
      'a Problem that is not a string',
      { format_version: 1, session_id: SESSION, project_id: PROJECT_A, problem_id: 42 },
    ],
    [
      'a blank Problem',
      { format_version: 1, session_id: SESSION, project_id: PROJECT_A, problem_id: '' },
    ],
  ])('reports a record carrying %s as unreadable', async (_name, record) => {
    await plant(SESSION, PROJECT_A, JSON.stringify(record));

    await expect(store.readBinding(SESSION, PROJECT_A)).resolves.toEqual({ kind: 'UNREADABLE' });
  });

  it.each([
    ['does not parse', '{not json'],
    [
      'parses but is not this contract',
      JSON.stringify({
        format_version: 1,
        session_id: OTHER_SESSION,
        project_id: PROJECT_A,
        problem_id: PROBLEM_A,
      }),
    ],
    [
      'came from a version nobody here knows',
      JSON.stringify({
        format_version: 99,
        session_id: SESSION,
        project_id: PROJECT_A,
        problem_id: PROBLEM_A,
      }),
    ],
  ])('leaves a record that %s where it is', async (_name, contents) => {
    // Deleting what cannot be read is how local state disappears without
    // anybody deciding it should. The next successful write replaces it.
    //
    // Both unreadable paths are covered deliberately: a record that fails to
    // parse returns earlier than one that parses and fails validation, and a
    // test for only the first leaves the second free to start deleting.
    await plant(SESSION, PROJECT_A, contents);

    await store.readBinding(SESSION, PROJECT_A);

    expect(await entries()).toHaveLength(1);
    expect(await readFile(join(directory, (await entries())[0] as string), 'utf8')).toBe(contents);
  });

  it('recovers when a later write replaces the unreadable record', async () => {
    await plant(SESSION, PROJECT_A, '{not json');

    await expect(store.writeBinding(SESSION, PROJECT_A, PROBLEM_B)).resolves.toEqual({
      kind: 'WRITTEN',
    });
    await expect(store.readBinding(SESSION, PROJECT_A)).resolves.toEqual({
      kind: 'VALID',
      binding: { projectId: PROJECT_A, problemId: PROBLEM_B },
    });
  });

  it('reports a filesystem failure as one rather than as an absent binding', async () => {
    // A directory where the record should be: the read fails with something
    // that is not ENOENT, which is the shape every real IO failure has.
    await store.writeBinding(SESSION, PROJECT_A, PROBLEM_A);
    const [name] = await entries();
    await rm(join(directory, name as string));
    await mkdir(join(directory, name as string));

    await expect(store.readBinding(SESSION, PROJECT_A)).resolves.toEqual({ kind: 'IO_FAILURE' });
  });
});

describe('writing', () => {
  it('stores exactly the four fields, and the version', async () => {
    await store.writeBinding(SESSION, PROJECT_A, PROBLEM_A);

    const record = await onlyRecord();

    expect(record).toEqual({
      format_version: 1,
      session_id: SESSION,
      project_id: PROJECT_A,
      problem_id: PROBLEM_A,
    });
    expect(Object.keys(record).sort()).toEqual([
      'format_version',
      'problem_id',
      'project_id',
      'session_id',
    ]);
  });

  it('replaces the binding for the same pair', async () => {
    await store.writeBinding(SESSION, PROJECT_A, PROBLEM_A);
    await store.writeBinding(SESSION, PROJECT_A, PROBLEM_B);

    await expect(store.readBinding(SESSION, PROJECT_A)).resolves.toEqual({
      kind: 'VALID',
      binding: { projectId: PROJECT_A, problemId: PROBLEM_B },
    });
  });

  it('leaves no temporary behind', async () => {
    await store.writeBinding(SESSION, PROJECT_A, PROBLEM_A);
    await store.writeBinding(SESSION, PROJECT_A, PROBLEM_B);
    await store.writeBinding(SESSION, PROJECT_B, PROBLEM_A);

    for (const name of await entries()) {
      expect(`${name} is a temporary:${name.endsWith('.tmp')}`).toBe(
        `${name} is a temporary:false`,
      );
    }
  });

  it('reports a failure rather than claiming to have written', async () => {
    // A file where the store's directory should be, so creating it fails.
    const blocked = join(directory, 'blocked');
    await writeFile(blocked, 'not a directory', 'utf8');
    const broken = createProblemBindingStore({ directory: join(blocked, 'bindings') });

    await expect(broken.writeBinding(SESSION, PROJECT_A, PROBLEM_A)).resolves.toEqual({
      kind: 'IO_FAILURE',
    });
  });
});

describe('removing', () => {
  it('removes the binding for the pair', async () => {
    await store.writeBinding(SESSION, PROJECT_A, PROBLEM_A);

    await expect(store.removeBinding(SESSION, PROJECT_A)).resolves.toEqual({ kind: 'REMOVED' });
    await expect(store.readBinding(SESSION, PROJECT_A)).resolves.toEqual({ kind: 'MISSING' });
  });

  it('reports a second removal as missing rather than as a failure', async () => {
    await store.writeBinding(SESSION, PROJECT_A, PROBLEM_A);
    await store.removeBinding(SESSION, PROJECT_A);

    await expect(store.removeBinding(SESSION, PROJECT_A)).resolves.toEqual({ kind: 'MISSING' });
  });

  it('removes only the pair it was asked about', async () => {
    await store.writeBinding(SESSION, PROJECT_A, PROBLEM_A);
    await store.writeBinding(SESSION, PROJECT_B, PROBLEM_B);

    await store.removeBinding(SESSION, PROJECT_A);

    await expect(store.readBinding(SESSION, PROJECT_B)).resolves.toEqual({
      kind: 'VALID',
      binding: { projectId: PROJECT_B, problemId: PROBLEM_B },
    });
  });

  it('reports a filesystem failure as one', async () => {
    await store.writeBinding(SESSION, PROJECT_A, PROBLEM_A);
    const [name] = await entries();
    await rm(join(directory, name as string));
    await mkdir(join(directory, name as string));

    await expect(store.removeBinding(SESSION, PROJECT_A)).resolves.toEqual({ kind: 'IO_FAILURE' });
  });

  it('removes a record it could not read, when told to', async () => {
    // Removal is explicit and does not consult the contents: the caller who
    // asks has a reason this module cannot see.
    await plant(SESSION, PROJECT_A, '{not json');

    await expect(store.removeBinding(SESSION, PROJECT_A)).resolves.toEqual({ kind: 'REMOVED' });
  });
});

describe('two writers at once', () => {
  it('keeps pairs independent when they are written in parallel', async () => {
    const pairs = Array.from({ length: 6 }, (_, session) =>
      Array.from({ length: 4 }, (_, project) => ({
        session: `session-${session}`,
        project: `project-${project}`,
        problem: `problem-${session}-${project}`,
      })),
    ).flat();

    await Promise.all(pairs.map((p) => store.writeBinding(p.session, p.project, p.problem)));

    // Six sessions across four Projects: every combination, each its own file.
    expect(pairs).toHaveLength(24);
    expect(await entries()).toHaveLength(24);
    for (const pair of pairs) {
      await expect(store.readBinding(pair.session, pair.project)).resolves.toEqual({
        kind: 'VALID',
        binding: { projectId: pair.project, problemId: pair.problem },
      });
    }
  });

  it('leaves one complete record when the same pair is written concurrently', async () => {
    const problems = Array.from({ length: 30 }, (_, index) => `problem-${index}`);

    const results = await Promise.all(
      problems.map((problem) => store.writeBinding(SESSION, PROJECT_A, problem)),
    );

    // Every write either succeeded or reported a failure; none claimed a
    // success it did not have.
    for (const result of results) {
      expect(['WRITTEN', 'IO_FAILURE']).toContain(result.kind);
    }

    const read = await store.readBinding(SESSION, PROJECT_A);
    expect(read.kind).toBe('VALID');
    // Whichever landed last, it is one of the values actually submitted and it
    // parsed cleanly — never a blend of two, never half a record.
    expect(problems).toContain((read as { binding: { problemId: string } }).binding.problemId);
    expect(await entries()).toHaveLength(1);
  });

  it('never shows a partial record to a reader racing the writer', async () => {
    await store.writeBinding(SESSION, PROJECT_A, PROBLEM_A);

    const reads: string[] = [];
    await Promise.all([
      ...Array.from({ length: 40 }, (_, index) =>
        store.writeBinding(SESSION, PROJECT_A, `problem-${index}`),
      ),
      ...Array.from({ length: 40 }, async () => {
        const read = await store.readBinding(SESSION, PROJECT_A);
        reads.push(read.kind);
      }),
    ]);

    // The point: no reader ever saw a half-written file. `UNREADABLE` here
    // would mean the write path had let a partial record be observable.
    expect(reads).not.toContain('UNREADABLE');
    for (const kind of reads) {
      expect(['VALID', 'MISSING', 'IO_FAILURE']).toContain(kind);
    }
  });
});

describe('what a stored record may carry', () => {
  it('holds identities and a version, and nothing about the Problem itself', async () => {
    await store.writeBinding(SESSION, PROJECT_A, PROBLEM_A);

    const serialised = await readFile(join(directory, (await entries())[0] as string), 'utf8');

    for (const forbidden of [
      'path',
      'repo',
      'title',
      'symptoms',
      'transcript',
      'credential',
      'token',
      'source_ai',
      'environment',
      'status',
      'owner_id',
      'created_at',
      'updated_at',
      'cwd',
      'directory',
    ]) {
      expect(`${forbidden}:${serialised.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
    // And nothing about where it lives, which is the one value the store knows
    // and the record has no reason to repeat.
    expect(serialised.includes(directory)).toBe(false);

    // The exact key set, which is what actually rules out a field arriving by
    // any route — a substring sweep cannot, since `format_version` legitimately
    // contains the word a Problem's own `version` would.
    expect(Object.keys(JSON.parse(serialised) as object).sort()).toEqual([
      'format_version',
      'problem_id',
      'project_id',
      'session_id',
    ]);
  });
});
