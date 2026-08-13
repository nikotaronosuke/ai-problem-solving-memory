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
  isSanitizedOperation,
  withSanitization,
  type FieldPath,
  type SanitizationPolicy,
} from '../../src/sanitization/index.js';

const UUID = '5d41402a-bc4b-4a76-b971-9d911017c592';

/**
 * Every operation, and whether it puts caller data into storage.
 *
 * `stores` is the question that matters: a write must be inspected, a read has
 * nothing to inspect. Both directions are asserted, so classifying a write as
 * a read to make a test pass fails a different one.
 */
const OPERATIONS: readonly { name: keyof MemoryRepository; stores: boolean; args: unknown[] }[] = [
  { name: 'createProject', stores: true, args: [{ projectName: 'p' }] },
  { name: 'getProject', stores: false, args: [UUID] },
  { name: 'listProjects', stores: false, args: [] },
  { name: 'updateProject', stores: true, args: [UUID, { projectName: 'p' }] },

  { name: 'createEnvironment', stores: true, args: [{ projectId: UUID, snapshot: { a: 'b' } }] },
  { name: 'getEnvironment', stores: false, args: [UUID] },
  { name: 'listEnvironments', stores: false, args: [UUID] },

  {
    name: 'createProblem',
    stores: true,
    args: [{ projectId: UUID, environmentId: UUID, title: 't', symptoms: 's' }],
  },
  { name: 'getProblem', stores: false, args: [UUID] },
  { name: 'listProblems', stores: false, args: [UUID] },
  { name: 'updateProblem', stores: true, args: [UUID, 1, { title: 't' }] },
  { name: 'updateProblemStatus', stores: true, args: [UUID, 1, 'PAUSED'] },
  {
    name: 'updateProblemConclusion',
    stores: true,
    args: [UUID, 1, { status: 'PAUSED', fixKind: null }],
  },

  {
    name: 'appendEvent',
    stores: true,
    args: [{ problemId: UUID, eventType: 'FIX', summary: 's', clientEventId: UUID }],
  },
  { name: 'listEvents', stores: false, args: [UUID] },

  {
    name: 'appendVerification',
    stores: true,
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
  { name: 'listVerifications', stores: false, args: [UUID] },

  {
    name: 'createChangeLog',
    stores: true,
    args: [{ problemId: UUID, changedBy: 'c', fromVersion: 1, toVersion: 2, changes: {} }],
  },
  { name: 'listChangeLogs', stores: false, args: [UUID] },

  {
    name: 'createUsageLog',
    stores: true,
    args: [{ problemId: UUID, sourceAi: 'a', action: 'ADOPTED', memoryId: UUID, reason: 'r' }],
  },
  { name: 'listUsageLogs', stores: false, args: [UUID] },

  {
    name: 'createRelation',
    stores: true,
    args: [{ fromId: UUID, toId: UUID, relationType: 'SIMILAR_TO', reason: 'r' }],
  },
  { name: 'listRelations', stores: false, args: [UUID] },
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

function recordingPolicy(): SanitizationPolicy & { seen: string[] } {
  const seen: string[] = [];
  return {
    name: 'recording',
    seen,
    inspect(_value: string, field: FieldPath) {
      seen.push(field.join('.'));
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
async function drive(name: keyof MemoryRepository, args: unknown[]): Promise<{ seen: string[] }> {
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

  return { seen: policy.seen };
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

  it('classifies twelve operations as storing and eleven as not', () => {
    const storing = OPERATIONS.filter((operation) => operation.stores);

    expect(storing).toHaveLength(12);
    expect(OPERATIONS).toHaveLength(23);
  });
});

describe('what the boundary inspects', () => {
  it.each(OPERATIONS.filter((operation) => operation.stores))(
    '$name is inspected before it can store anything',
    async ({ name, args }) => {
      const { seen } = await drive(name, args);

      // The specific fields differ per operation; that any string reached the
      // policy is what proves this write cannot go around it.
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((field) => field.startsWith(`${String(name)}.`))).toBe(true);
    },
  );

  it.each(OPERATIONS.filter((operation) => !operation.stores))(
    '$name stores nothing, so nothing is inspected',
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
        'createEnvironment.0.snapshot.runtime',
        'createEnvironment.0.snapshot.auth.provider',
        'createEnvironment.0.snapshot.auth.scopes.0',
      ]),
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
        'appendEvent.0.summary',
        'appendEvent.0.reason',
        'appendEvent.0.sourceAi',
      ]),
    );
  });

  it('reaches what a change log records about who changed something', async () => {
    const { seen } = await drive('createChangeLog', [
      { problemId: UUID, changedBy: 'claude-code', fromVersion: 1, toVersion: 2, changes: {} },
    ]);

    expect(seen).toContain('createChangeLog.0.changedBy');
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
    await withSanitization(spy, {
      name: 'keep',
      inspect: () => ({ kind: 'keep' }),
    }).appendEvent(input as never);

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
      name: 'replacing',
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
        name: 'refusing',
        inspect: () => ({ kind: 'reject', reason: 'not storable' }),
      }).appendEvent({ summary: 'anything', clientEventId: UUID } as never),
    ).rejects.toThrow('cannot be stored');

    // Refused before delegation, so no statement was issued at all.
    expect(called).toBe(false);
  });
});
