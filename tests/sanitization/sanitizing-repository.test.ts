/**
 * The anti-bypass test.
 *
 * The value of P3-01 is not that a sanitizer exists — it is that a write
 * cannot reach storage around it. So this suite does not check that the
 * wrapper was applied; it drives every operation on a real `MemoryRepository`
 * and checks which of them the policy actually saw.
 *
 * The inventory below is written out by hand, deliberately. A test that
 * discovered the operations it was checking would agree with whatever it
 * found, including a thirteenth write added next month and never classified.
 * Written out, adding an operation fails this file until someone says whether
 * it stores anything — which is the moment to think about it.
 *
 * No database is involved. The repository is real, the executor is a stub, and
 * what is under test is whether the policy was consulted before delegation —
 * which happens whether or not the statement underneath would have worked.
 */

import { describe, expect, it } from 'vitest';

import type { DatabaseExecutor } from '../../src/db/executor.js';
import { generateOwnerId } from '../../src/domain/owner.js';
import type { OwnerContext } from '../../src/domain/owner.js';
import { createMemoryRepository, type MemoryRepository } from '../../src/repository/index.js';
import {
  describeInspectionPath,
  isSanitizedOperation,
  withSanitization,
  type SanitizationPolicy,
  type SanitizationSite,
} from '../../src/sanitization/index.js';

const UUID = '5d41402a-bc4b-4a76-b971-9d911017c592';

/**
 * Every operation, and whether the boundary inspects its arguments.
 *
 * `inspected` is the question that matters, and it is deliberately not the
 * same question as "does this write". A write must be inspected and a read has
 * nothing to inspect, so for most operations the two coincide. `deleteProblem`
 * is where they come apart: it stores nothing and is inspected anyway, because
 * the boundary treats anything it was not told is a read as a write. Its
 * arguments are an identifier and an integer, so the inspection finds nothing
 * and costs nothing — and the alternative, an exception list, is a list
 * somebody eventually adds a content-carrying operation to.
 *
 * Both directions are asserted, so moving an operation to the other column to
 * make one test pass fails the other.
 */
const OPERATIONS: readonly { name: keyof MemoryRepository; inspected: boolean; args: unknown[] }[] =
  [
    { name: 'createProject', inspected: true, args: [{ projectName: 'p' }] },
    { name: 'getProject', inspected: false, args: [UUID] },
    { name: 'listProjects', inspected: false, args: [] },
    { name: 'updateProject', inspected: true, args: [UUID, { projectName: 'p' }] },

    {
      name: 'createEnvironment',
      inspected: true,
      args: [{ projectId: UUID, snapshot: { a: 'b' } }],
    },
    { name: 'getEnvironment', inspected: false, args: [UUID] },
    { name: 'listEnvironments', inspected: false, args: [UUID] },

    {
      name: 'createProblem',
      inspected: true,
      args: [{ projectId: UUID, environmentId: UUID, title: 't', symptoms: 's' }],
    },
    { name: 'getProblem', inspected: false, args: [UUID] },
    { name: 'listProblems', inspected: false, args: [UUID] },
    { name: 'updateProblem', inspected: true, args: [UUID, 1, { title: 't' }] },
    { name: 'updateProblemStatus', inspected: true, args: [UUID, 1, 'PAUSED'] },
    {
      name: 'updateProblemConclusion',
      inspected: true,
      args: [UUID, 1, { status: 'PAUSED', fixKind: null }],
    },

    {
      name: 'appendEvent',
      inspected: true,
      args: [{ problemId: UUID, eventType: 'FIX', summary: 's', clientEventId: UUID }],
    },
    { name: 'listEvents', inspected: false, args: [UUID] },

    {
      name: 'appendVerification',
      inspected: true,
      args: [
        {
          problemId: UUID,
          verificationType: 'TEST',
          result: true,
          summary: 's',
          clientEventId: UUID,
        },
      ],
    },
    { name: 'listVerifications', inspected: false, args: [UUID] },

    {
      name: 'createChangeLog',
      inspected: true,
      args: [{ problemId: UUID, changedBy: 'c', fromVersion: 1, toVersion: 2, changes: {} }],
    },
    { name: 'listChangeLogs', inspected: false, args: [UUID] },

    {
      name: 'createUsageLog',
      inspected: true,
      args: [{ problemId: UUID, sourceAi: 'a', action: 'ADOPTED', memoryId: UUID, reason: 'r' }],
    },
    { name: 'listUsageLogs', inspected: false, args: [UUID] },

    {
      name: 'createRelation',
      inspected: true,
      args: [{ fromId: UUID, toId: UUID, relationType: 'SIMILAR_TO', reason: 'r' }],
    },
    { name: 'listRelations', inspected: false, args: [UUID] },

    // Stores nothing, inspected all the same. See the note above the table.
    { name: 'deleteProblem', inspected: true, args: [UUID, 1] },
  ] as const;

/** An executor that answers everything with nothing. */
const stubExecutor: DatabaseExecutor = {
  query: () => Promise.resolve({ rows: [], rowCount: 0 }),
} as unknown as DatabaseExecutor;

function realRepository(): MemoryRepository {
  // An `OwnerContext` is branded so it can only come from `resolveOwnerContext`,
  // which needs a database. Nothing here reaches one, and the owner is
  // irrelevant to what is being tested.
  const context = { ownerId: generateOwnerId() } as unknown as OwnerContext;
  return createMemoryRepository(stubExecutor, context);
}

function recordingPolicy(): SanitizationPolicy & { seen: string[]; keys: string[] } {
  const seen: string[] = [];
  const keys: string[] = [];
  return {
    seen,
    keys,
    inspect(text: string, at: SanitizationSite) {
      seen.push(describeInspectionPath(at.path));
      if (at.kind === 'key') {
        keys.push(text);
      }
      return { kind: 'keep' };
    },
  };
}

/**
 * Calls an operation and reports what the policy saw.
 *
 * Whether the statement underneath would have succeeded is irrelevant: the
 * policy is consulted before delegation, so a stubbed executor failing after
 * the fact does not affect the answer.
 */
async function drive(
  name: keyof MemoryRepository,
  args: unknown[],
): Promise<{ seen: string[]; keys: string[] }> {
  const policy = recordingPolicy();
  const wrapped = withSanitization(realRepository(), policy) as unknown as Record<
    string,
    (...values: unknown[]) => Promise<unknown>
  >;

  try {
    await wrapped[name]?.(...args);
  } catch {
    // Expected: the stub returns no rows, so mappers downstream may complain.
  }

  return { seen: policy.seen, keys: policy.keys };
}

describe('the operation inventory', () => {
  it('covers every operation the repository has', () => {
    const actual = Object.keys(realRepository())
      .filter((key) => key !== 'ownerId')
      .sort();
    const classified = OPERATIONS.map((operation) => String(operation.name)).sort();

    // An operation added to `MemoryRepository` and not classified here fails
    // this, which is the point: someone has to say whether it stores anything.
    expect(actual).toEqual(classified);
  });

  it('names no operation twice', () => {
    const names = OPERATIONS.map((operation) => operation.name);

    expect(new Set(names).size).toBe(names.length);
  });

  it('classifies thirteen operations as inspected and eleven as reads', () => {
    const inspected = OPERATIONS.filter((operation) => operation.inspected);

    expect(inspected).toHaveLength(13);
    expect(OPERATIONS).toHaveLength(24);
  });
});

describe('what the boundary inspects', () => {
  it.each(OPERATIONS.filter((operation) => operation.inspected))(
    '$name is inspected before it reaches storage',
    async ({ name, args }) => {
      const { seen } = await drive(name, args);

      // The specific fields differ per operation; that any string reached the
      // policy is what proves this write cannot go around it.
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((locator) => locator.startsWith(`${String(name)}[`))).toBe(true);
    },
  );

  it.each(OPERATIONS.filter((operation) => !operation.inspected))(
    '$name is a read, so nothing is inspected',
    async ({ name, args }) => {
      const { seen } = await drive(name, args);

      // Identifiers used to find rows are not content on its way into one.
      expect(seen).toEqual([]);
    },
  );

  it('reaches inside a caller-composed snapshot', async () => {
    const { seen } = await drive('createEnvironment', [
      {
        projectId: UUID,
        snapshot: { runtime: 'node 22.12.0', auth: { provider: 'oauth2', scopes: ['openid'] } },
      },
    ]);

    // The shape of a snapshot is whatever the caller sent. A boundary that
    // only checked named fields would never see any of this.
    expect(seen).toEqual(
      expect.arrayContaining([
        'createEnvironment[0].snapshot.runtime',
        'createEnvironment[0].snapshot.auth.provider',
        'createEnvironment[0].snapshot.auth.scopes[0]',
      ]),
    );
  });

  it('reaches the keys a caller chose inside a snapshot, not only their values', async () => {
    const { keys } = await drive('createEnvironment', [
      { projectId: UUID, snapshot: { runtime: 'node', auth: { api_key: 'x' } } },
    ]);

    // A snapshot stores whatever JSON was sent, keys included, so a boundary
    // that inspected only values could be walked around by naming a field
    // after the secret.
    expect(keys).toEqual(
      expect.arrayContaining(['projectId', 'snapshot', 'runtime', 'auth', 'api_key']),
    );
  });

  it('reaches the free text a review event carries', async () => {
    const { seen } = await drive('appendEvent', [
      {
        problemId: UUID,
        eventType: 'DISCOVERY',
        summary: 'the registered redirect was stale',
        reason: 'compared against the deployed callback',
        sourceAi: 'claude-code',
        clientEventId: UUID,
      },
    ]);

    expect(seen).toEqual(
      expect.arrayContaining([
        'appendEvent[0].summary',
        'appendEvent[0].reason',
        'appendEvent[0].sourceAi',
      ]),
    );
  });

  it('reaches what a change log records about who changed something', async () => {
    const { seen } = await drive('createChangeLog', [
      { problemId: UUID, changedBy: 'claude-code', fromVersion: 1, toVersion: 2, changes: {} },
    ]);

    expect(seen).toContain('createChangeLog[0].changedBy');
  });

  it('treats an operation it has never heard of as storing', () => {
    // Fail-closed. An operation added and never classified is inspected, not
    // skipped: the cost of forgetting is a redundant check, not a gap.
    expect(isSanitizedOperation('somethingAddedLater')).toBe(true);
    expect(isSanitizedOperation('getProblem')).toBe(false);
  });
});

describe('what the wrapper leaves alone', () => {
  it('still reports the owner it is scoped to', () => {
    const repository = realRepository();

    expect(withSanitization(repository, recordingPolicy()).ownerId).toBe(repository.ownerId);
  });

  it('passes a write through unchanged when the policy keeps everything', async () => {
    const received: unknown[] = [];
    const spy = {
      ownerId: generateOwnerId(),
      appendEvent: (input: unknown) => {
        received.push(input);
        return Promise.resolve({});
      },
    } as unknown as MemoryRepository;

    const input = {
      problemId: UUID,
      eventType: 'FIX',
      summary: 'aligned the redirect',
      reason: undefined,
      evidenceRef: null,
      clientEventId: UUID,
    };
    await withSanitization(spy, { inspect: () => ({ kind: 'keep' }) }).appendEvent(input as never);

    // Installing the boundary must not change what a service asked for.
    expect(received[0]).toEqual(input);
  });

  it('hands the storage layer what the policy decided, not what the caller sent', async () => {
    const received: unknown[] = [];
    const spy = {
      ownerId: generateOwnerId(),
      appendEvent: (input: unknown) => {
        received.push(input);
        return Promise.resolve({});
      },
    } as unknown as MemoryRepository;

    await withSanitization(spy, {
      inspect: (value) =>
        value === 'sk-live-do-not-store'
          ? { kind: 'replace', value: '[removed]' }
          : { kind: 'keep' },
    }).appendEvent({ summary: 'sk-live-do-not-store', clientEventId: UUID } as never);

    // What P3-03 will rely on: the replacement is what gets stored.
    expect(received[0]).toMatchObject({ summary: '[removed]', clientEventId: UUID });
  });

  it('never delegates a write the policy refused', async () => {
    let called = false;
    const spy = {
      ownerId: generateOwnerId(),
      appendEvent: () => {
        called = true;
        return Promise.resolve({});
      },
    } as unknown as MemoryRepository;

    await expect(
      withSanitization(spy, {
        inspect: () => ({ kind: 'reject', reason: 'not storable' }),
      }).appendEvent({ summary: 'anything', clientEventId: UUID } as never),
    ).rejects.toThrow('cannot be stored');

    // Refused before delegation, so no statement was issued at all.
    expect(called).toBe(false);
  });
});
