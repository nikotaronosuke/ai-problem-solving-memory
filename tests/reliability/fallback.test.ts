/**
 * What an assistant is told to do when the Memory is not available.
 *
 * Two claims carry the weight, and they pull against each other.
 *
 * Nothing about a Memory failure stops the caller. Every expected failure —
 * a queued write, a refused credential, a full queue, a payload the boundary
 * would not store, a disk that would not cooperate, a search that could not
 * run — comes back as a decision to carry on.
 *
 * And nothing hides a bug. An owner mismatch, a delivery that threw where its
 * contract says to return, an error nobody here has heard of: all propagate.
 * The tests for that are as important as the ones above, because the easy way
 * to satisfy the first claim is a `catch` that swallows both.
 *
 * The queue is real and on a real directory. Whether a file exists, and what is
 * in it, is what several of these assert.
 */

import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { OwnerId } from '../../src/domain/owner.js';
import type { ProblemId } from '../../src/domain/problem.js';
import {
  collectImportantUnsavedNotices,
  createReliableWriteCoordinator,
  createRetryQueue,
  fallbackForSearch,
  MEMORY_NOTICE_KINDS,
  OwnerMismatchError,
  QueueCapacityError,
  QueueStorageError,
  submitEventWithFallback,
  submitVerificationWithFallback,
  type DeliveryOutcome,
  type MemorySearchAttempt,
  type QueueItem,
  type ReliableWriteCoordinator,
  type RetryDelivery,
  type RetryQueue,
  type SubmitOutcome,
  type SubmitResult,
} from '../../src/reliability/index.js';
import { SanitizationRejectedError } from '../../src/sanitization/index.js';

const LIMITS = { maxItems: 100, maxItemBytes: 64 * 1024, maxTotalBytes: 1024 * 1024 };
const POLICY = { baseDelayMs: 1_000, maxDelayMs: 60_000, maxAttempts: 3 };
const AT = new Date('2026-08-14T13:00:00.000Z');

const SUCCESS: DeliveryOutcome = { kind: 'SUCCESS' };
const DOWN: DeliveryOutcome = { kind: 'TRANSPORT_FAILURE' };
const REFUSED: DeliveryOutcome = { kind: 'HTTP_FAILURE', status: 400 };
const UNAUTHENTICATED: DeliveryOutcome = { kind: 'HTTP_FAILURE', status: 401 };

function fake(outcome: DeliveryOutcome): RetryDelivery & { readonly seen: QueueItem[] } {
  const seen: QueueItem[] = [];
  return {
    seen,
    deliver(item) {
      seen.push(item);
      return Promise.resolve(outcome);
    },
  };
}

/** A coordinator that reports one submit outcome, or fails one way. */
function coordinatorAnswering(
  answer: SubmitOutcome | Error,
): ReliableWriteCoordinator & { readonly seen: { problemImportant: boolean }[] } {
  const seen: { problemImportant: boolean }[] = [];
  const respond = (input: { problemImportant: boolean }): Promise<SubmitResult> => {
    seen.push({ problemImportant: input.problemImportant });
    return answer instanceof Error
      ? Promise.reject(answer)
      : Promise.resolve({ outcome: answer, clientEventId: randomUUID() as never });
  };

  return {
    seen,
    submitEvent: (input) => respond(input),
    submitVerification: (input) => respond(input),
  };
}

describe('carrying on when the Memory will not take a write', () => {
  let directory: string;
  let queue: RetryQueue;
  let coordinator: ReliableWriteCoordinator;
  let ownerId: OwnerId;
  let problemId: ProblemId;

  const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

  const event = (problemImportant: boolean) => ({
    ownerId,
    problemId,
    problemImportant,
    payload: { eventType: 'DISCOVERY' as const, summary: 'the cache was stale' },
  });

  const verification = (problemImportant: boolean) => ({
    ownerId,
    problemId,
    problemImportant,
    payload: { verificationType: 'TEST' as const, result: true, summary: 'the suite agreed' },
  });

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'memory-fallback-'));
    queue = createRetryQueue({ directory, limits: LIMITS, policy: POLICY });
    coordinator = createReliableWriteCoordinator(queue);
    ownerId = randomUUID() as OwnerId;
    problemId = randomUUID() as ProblemId;
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  describe('reading a completed submission', () => {
    it.each([
      ['DELIVERED', 'SAVED'],
      ['QUEUED', 'PENDING'],
      ['AUTH_REQUIRED', 'PENDING'],
      ['PERMANENT_FAILURE', 'UNSAVED'],
    ] as const)('turns %s into %s, and never stops the work', async (outcome, memoryState) => {
      for (const problemImportant of [true, false]) {
        const decision = await submitEventWithFallback(
          coordinatorAnswering(outcome),
          event(problemImportant),
          AT,
          { ownerId },
          fake(SUCCESS),
        );

        expect(decision.continueMainWork).toBe(true);
        expect(decision.memoryState).toBe(memoryState);
      }
    });

    // A write that arrived, one waiting to be retried, and one whose credential
    // needs replacing. None of the three is a Memory that could not be saved.
    it.each(['DELIVERED', 'QUEUED', 'AUTH_REQUIRED'] as const)(
      'says nothing about %s, even for an important Problem',
      async (outcome) => {
        const decision = await submitEventWithFallback(
          coordinatorAnswering(outcome),
          event(true),
          AT,
          { ownerId },
          fake(SUCCESS),
        );

        // A queued write is the failure design working: there is a durable
        // copy, it will be tried again, and a recovery path exists. Announcing
        // it would interrupt somebody every time a laptop lost its network,
        // with news usually retracted a minute later.
        expect(decision.noticeIntent).toBeNull();
      },
    );

    it('mentions an important write that will not be retried', async () => {
      const decision = await submitEventWithFallback(
        coordinatorAnswering('PERMANENT_FAILURE'),
        event(true),
        AT,
        { ownerId },
        fake(SUCCESS),
      );

      expect(decision.noticeIntent?.kind).toBe('IMPORTANT_MEMORY_UNSAVED');
      expect(decision.noticeIntent?.operation).toBe('appendEvent');
      expect(decision.noticeIntent?.dedupKey?.startsWith('appendEvent:')).toBe(true);
    });

    it('says nothing about a routine write that will not be retried', async () => {
      const decision = await submitEventWithFallback(
        coordinatorAnswering('PERMANENT_FAILURE'),
        event(false),
        AT,
        { ownerId },
        fake(SUCCESS),
      );

      expect(decision.noticeIntent).toBeNull();
    });

    it('names the write by the call that made it, not by an argument', async () => {
      // The importance and the kind of write are stated once each: importance
      // by the caller, the operation by which function was used. There is no
      // second place to say either, so no way for the two to disagree — a
      // mismatch would silence a notice or attach the wrong handle to one, and
      // neither shows up as a failure at the time.
      const asEvent = await submitEventWithFallback(
        coordinatorAnswering('PERMANENT_FAILURE'),
        event(true),
        AT,
        { ownerId },
        fake(SUCCESS),
      );
      const asVerification = await submitVerificationWithFallback(
        coordinatorAnswering('PERMANENT_FAILURE'),
        verification(true),
        AT,
        { ownerId },
        fake(SUCCESS),
      );

      expect(asEvent.noticeIntent?.operation).toBe('appendEvent');
      expect(asEvent.noticeIntent?.dedupKey?.startsWith('appendEvent:')).toBe(true);
      expect(asVerification.noticeIntent?.operation).toBe('appendVerification');
      expect(asVerification.noticeIntent?.dedupKey?.startsWith('appendVerification:')).toBe(true);
    });

    it('uses the importance it was given, once', async () => {
      const answering = coordinatorAnswering('PERMANENT_FAILURE');

      const decision = await submitEventWithFallback(
        answering,
        event(true),
        AT,
        { ownerId },
        fake(SUCCESS),
      );

      // The same value reached the submission and the decision. Passing it
      // twice is what made an important Event describable as routine.
      expect(answering.seen).toEqual([{ problemImportant: true }]);
      expect(decision.noticeIntent).not.toBeNull();
    });

    it('offers exactly one kind of notice', () => {
      // The spec names six occasions to say anything, and one concerns saving.
      // Splitting it by cause would describe the internals of a system the
      // person did not ask about, and would mean the same thing to them either
      // way.
      expect([...MEMORY_NOTICE_KINDS]).toEqual(['IMPORTANT_MEMORY_UNSAVED']);
    });
  });

  describe('a write the queue would not take', () => {
    it('carries on, and says so when the Problem is important', async () => {
      const full = createRetryQueue({
        directory,
        limits: { ...LIMITS, maxItems: 0 },
        policy: POLICY,
      });
      const attempted = fake(SUCCESS);

      const decision = await submitEventWithFallback(
        createReliableWriteCoordinator(full),
        event(true),
        AT,
        { ownerId },
        attempted,
      );

      expect(decision.continueMainWork).toBe(true);
      expect(decision.memoryState).toBe('UNSAVED');
      expect(decision.noticeIntent?.kind).toBe('IMPORTANT_MEMORY_UNSAVED');
      // Nothing durable exists, so there is nothing for a later scan to find
      // and recognise.
      expect(decision.noticeIntent?.dedupKey).toBeUndefined();
      // And the write was never sent: no durable copy, no delivery.
      expect(attempted.seen).toHaveLength(0);
      expect(await readdir(directory)).toEqual([]);
    });

    it('carries on quietly when the Problem is routine', async () => {
      const full = createRetryQueue({
        directory,
        limits: { ...LIMITS, maxItems: 0 },
        policy: POLICY,
      });

      const decision = await submitEventWithFallback(
        createReliableWriteCoordinator(full),
        event(false),
        AT,
        { ownerId },
        fake(SUCCESS),
      );

      expect(decision.continueMainWork).toBe(true);
      expect(decision.memoryState).toBe('UNSAVED');
      expect(decision.noticeIntent).toBeNull();
    });

    it('carries on when the payload holds a credential that cannot be removed', async () => {
      const attempted = fake(SUCCESS);

      const decision = await submitEventWithFallback(
        coordinator,
        {
          ownerId,
          problemId,
          problemImportant: true,
          payload: {
            eventType: 'DISCOVERY',
            summary: 'a private key, whole',
            reason: `-----BEGIN PRIVATE KEY-----\n${SECRET}`,
          },
        },
        AT,
        { ownerId },
        attempted,
      );

      // The boundary did its job; from the caller's position the result is the
      // same as any other write that was not saved, and a security refusal must
      // not be the thing that stops somebody working.
      expect(decision.continueMainWork).toBe(true);
      expect(decision.memoryState).toBe('UNSAVED');
      expect(decision.noticeIntent?.kind).toBe('IMPORTANT_MEMORY_UNSAVED');
      expect(attempted.seen).toHaveLength(0);
      expect(await readdir(directory)).toEqual([]);

      // Nothing about what was found. Not the secret, not where it was, not
      // why — the notice is shown to a person and the point of the refusal was
      // that the content should not travel.
      const rendered = JSON.stringify(decision);
      expect(rendered).not.toContain(SECRET);
      expect(rendered).not.toContain('PRIVATE KEY');
      expect(rendered).not.toContain('reason');
      expect(rendered).not.toContain('summary');
    });
  });

  describe('a disk that will not cooperate', () => {
    /**
     * A queue directory that cannot exist.
     *
     * A regular file where the directory should be: `mkdir` fails the same way
     * on every platform, deterministically, with no permissions to arrange and
     * nothing to skip on Windows.
     */
    async function blockedDirectory(): Promise<string> {
      const blocked = join(directory, 'not-a-directory');
      await writeFile(blocked, 'this is a file', 'utf8');
      return join(blocked, 'queue');
    }

    it('turns a filesystem failure into a safe one', async () => {
      const broken = createRetryQueue({
        directory: await blockedDirectory(),
        limits: LIMITS,
        policy: POLICY,
      });

      await expect(
        createReliableWriteCoordinator(broken).submitEvent(
          event(true),
          AT,
          { ownerId },
          fake(SUCCESS),
        ),
      ).rejects.toBeInstanceOf(QueueStorageError);
    });

    it('says which kind of work failed, and nothing else at all', async () => {
      const blocked = await blockedDirectory();
      const broken = createRetryQueue({ directory: blocked, limits: LIMITS, policy: POLICY });

      try {
        await createReliableWriteCoordinator(broken).submitEvent(
          event(true),
          AT,
          { ownerId },
          fake(SUCCESS),
        );
        expect.unreachable('the write should have failed');
      } catch (error) {
        const failure = error as QueueStorageError;
        expect(failure).toBeInstanceOf(QueueStorageError);
        expect(failure.operation).toBe('WRITE');

        // A Node filesystem error's message is the absolute path it failed on,
        // and an error carrying one travels wherever errors travel. Not the
        // message, not the stack, and deliberately no `cause` to reach through.
        const everything = `${failure.message}\n${failure.stack ?? ''}\n${JSON.stringify(failure)}`;
        expect(everything).not.toContain(blocked);
        expect(everything).not.toContain(directory);
        expect(everything).not.toContain('ENOTDIR');
        expect(everything).not.toContain('ENOENT');
        expect(everything).not.toContain('mkdir');
        expect((failure as { cause?: unknown }).cause).toBeUndefined();
      }
    });

    it('lets the caller carry on, with a notice when it matters', async () => {
      const broken = createRetryQueue({
        directory: await blockedDirectory(),
        limits: LIMITS,
        policy: POLICY,
      });
      const attempted = fake(SUCCESS);

      const decision = await submitEventWithFallback(
        createReliableWriteCoordinator(broken),
        event(true),
        AT,
        { ownerId },
        attempted,
      );

      expect(decision.continueMainWork).toBe(true);
      expect(decision.memoryState).toBe('UNSAVED');
      expect(decision.noticeIntent?.kind).toBe('IMPORTANT_MEMORY_UNSAVED');
      expect(attempted.seen).toHaveLength(0);

      const rendered = JSON.stringify(decision);
      expect(rendered).not.toContain(directory);
      expect(rendered).not.toContain('ENOTDIR');
    });

    it('carries on quietly for a routine write', async () => {
      const broken = createRetryQueue({
        directory: await blockedDirectory(),
        limits: LIMITS,
        policy: POLICY,
      });

      const decision = await submitEventWithFallback(
        createReliableWriteCoordinator(broken),
        event(false),
        AT,
        { ownerId },
        fake(SUCCESS),
      );

      expect(decision.continueMainWork).toBe(true);
      expect(decision.noticeIntent).toBeNull();
    });
  });

  describe('a disk that fails after the write is already safe', () => {
    // A review found the fallback calling every storage failure "unsaved".
    // The filesystem can also fail *after* a write is durable, and after the
    // server has accepted it, and those mean opposite things — one of them is
    // a write that never happened and the other is a write that did.

    /** Replaces a path with a directory, so the next operation on it fails. */
    async function blockWith(name: string): Promise<void> {
      await rm(join(directory, name), { force: true });
      await mkdir(join(directory, name));
    }

    it('reports a write the server took, even when the file cannot be removed', async () => {
      let delivered = false;
      const delivering: RetryDelivery = {
        async deliver(item) {
          // The server has it. The queue file is about to become impossible to
          // delete — a `unlink` on a directory fails everywhere.
          await blockWith(`${item.queueItemId}.json`);
          delivered = true;
          return SUCCESS;
        },
      };

      const decision = await submitEventWithFallback(
        coordinator,
        event(true),
        AT,
        { ownerId },
        delivering,
      );

      expect(delivered).toBe(true);
      // The Memory has the Event. Failing to tidy up afterwards is not a
      // failure to save, and saying otherwise tells somebody their work was
      // lost when it is sitting on the server.
      expect(decision.continueMainWork).toBe(true);
      expect(decision.memoryState).toBe('SAVED');
      expect(decision.noticeIntent).toBeNull();
    });

    it('reports a queued write as pending when its bookkeeping cannot be saved', async () => {
      const delivering: RetryDelivery = {
        async deliver(item) {
          // The delivery failed, and now the attempt count cannot be written
          // back: `open` for writing a directory fails everywhere.
          await mkdir(join(directory, `${item.queueItemId}.json.tmp`));
          return DOWN;
        },
      };

      const decision = await submitEventWithFallback(
        coordinator,
        event(true),
        AT,
        { ownerId },
        delivering,
      );

      // There is a durable copy — the write was admitted before anything was
      // attempted. Not being able to update its attempt count does not undo
      // that, and "unsaved" would be a claim about a file that exists.
      expect(decision.continueMainWork).toBe(true);
      expect(decision.memoryState).toBe('PENDING');
      expect(decision.noticeIntent).toBeNull();
    });

    it('reports a pending write when recording its outcome would exceed the size limit', async () => {
      // The per-item size limit is checked on every write, not only on a new
      // one, so it can refuse an update to an item that is already durable —
      // a limit that has been lowered, or an item that has grown past it.
      const submitted = await coordinator.submitEvent(event(true), AT, { ownerId }, fake(DOWN));
      expect(submitted.outcome).toBe('QUEUED');

      const [name] = await readdir(directory);
      const exactSize = (await stat(join(directory, name ?? ''))).size;

      // A queue over the same directory whose limit no longer admits the item
      // it is holding.
      const tight = createRetryQueue({
        directory,
        limits: { ...LIMITS, maxItemBytes: exactSize - 1 },
        policy: POLICY,
      });
      const held = (await tight.list()).items[0];

      const outcome = await tight.attempt(
        held?.queueItemId ?? '',
        new Date(held?.nextAttemptAt ?? AT),
        { ownerId },
        fake(DOWN),
      );

      // Not an admission failure: the write is on disk and untouched. Calling
      // it unsaved would describe a file that exists, and marking it terminal
      // would stop something that was never stopped.
      expect(outcome).toBe('QUEUE_UNAVAILABLE');
      const after = (await tight.list()).items[0];
      expect(after?.terminalFailure).toBeNull();
      expect(after?.attemptCount).toBe(held?.attemptCount);
    });

    it('still calls a write that never reached the disk unsaved', async () => {
      // The other side of the same line, so the fix cannot be "call everything
      // pending". Nothing was admitted here, so nothing exists to retry.
      const blocked = join(directory, 'blocking-file');
      await writeFile(blocked, 'not a directory', 'utf8');
      const broken = createRetryQueue({ directory: blocked, limits: LIMITS, policy: POLICY });
      const attempted = fake(SUCCESS);

      const decision = await submitEventWithFallback(
        createReliableWriteCoordinator(broken),
        event(true),
        AT,
        { ownerId },
        attempted,
      );

      expect(decision.memoryState).toBe('UNSAVED');
      expect(decision.noticeIntent?.kind).toBe('IMPORTANT_MEMORY_UNSAVED');
      expect(attempted.seen).toHaveLength(0);
    });
  });

  describe('what it refuses to absorb', () => {
    it('lets an owner mismatch through', async () => {
      await expect(
        submitEventWithFallback(
          coordinator,
          event(true),
          AT,
          { ownerId: randomUUID() as OwnerId },
          fake(SUCCESS),
        ),
      ).rejects.toBeInstanceOf(OwnerMismatchError);
    });

    it('lets a delivery that broke its contract through', async () => {
      const broken: RetryDelivery = {
        deliver() {
          // The interface says an ordinary failure is an outcome, not an
          // exception. Throwing means the implementation has a bug.
          throw new TypeError('the delivery implementation is wrong');
        },
      };

      await expect(
        submitEventWithFallback(coordinator, event(true), AT, { ownerId }, broken),
      ).rejects.toBeInstanceOf(TypeError);
    });

    it('lets an error it has never heard of through', async () => {
      class SomethingElse extends Error {}

      await expect(
        submitEventWithFallback(
          coordinatorAnswering(new SomethingElse('not a Memory failure')),
          event(true),
          AT,
          { ownerId },
          fake(SUCCESS),
        ),
      ).rejects.toBeInstanceOf(SomethingElse);
    });

    it('absorbs only the three it names', async () => {
      // Stated as a list so that widening it is a deliberate edit rather than
      // a `catch` quietly growing.
      for (const error of [
        new QueueCapacityError('maxItems'),
        new QueueStorageError('WRITE'),
        // The third: a payload the boundary would not store. Constructed the
        // way the boundary constructs one, so the list here is the real set
        // rather than a paraphrase of it.
        new SanitizationRejectedError({
          path: [{ kind: 'operation', name: 'appendEvent' }],
          kind: 'value',
        }),
      ]) {
        const decision = await submitEventWithFallback(
          coordinatorAnswering(error),
          event(false),
          AT,
          { ownerId },
          fake(SUCCESS),
        );
        expect(decision.continueMainWork).toBe(true);
        expect(decision.memoryState).toBe('UNSAVED');
      }

      for (const error of [new OwnerMismatchError(), new RangeError('nope'), new Error('nope')]) {
        await expect(
          submitEventWithFallback(
            coordinatorAnswering(error),
            event(false),
            AT,
            { ownerId },
            fake(SUCCESS),
          ),
        ).rejects.toBe(error);
      }
    });
  });

  describe('finding what was never saved', () => {
    /** Fails an item until it has no attempts left. */
    async function exhaust(problemImportant: boolean): Promise<string> {
      const submitted = await coordinator.submitEvent(
        event(problemImportant),
        AT,
        { ownerId },
        fake(DOWN),
      );
      let at = AT;
      for (let attempt = 1; attempt < POLICY.maxAttempts + 1; attempt += 1) {
        const held = (await queue.list()).items[0];
        if (held?.terminalFailure !== null) {
          break;
        }
        at = new Date(held?.nextAttemptAt ?? at);
        await queue.drain(at, { ownerId }, fake(DOWN));
      }
      return submitted.clientEventId;
    }

    it('reports an important write that ran out of attempts, after a restart', async () => {
      const clientEventId = await exhaust(true);
      expect((await queue.list()).items[0]?.terminalFailure).toBe('RETRY_EXHAUSTED');

      // A new queue over the same directory, as a restarted process would
      // build. Importance comes from the file — the only place it can come from
      // when the reason the write is stuck is that the server is unreachable.
      const restarted = createRetryQueue({ directory, limits: LIMITS, policy: POLICY });
      const scan = await collectImportantUnsavedNotices(restarted);

      expect(scan.kind).toBe('AVAILABLE');
      expect(scan.notices).toEqual([
        {
          kind: 'IMPORTANT_MEMORY_UNSAVED',
          operation: 'appendEvent',
          dedupKey: `appendEvent:${clientEventId}`,
        },
      ]);
    });

    it('says nothing about a routine write that ran out of attempts', async () => {
      await exhaust(false);
      expect((await queue.list()).items[0]?.terminalFailure).toBe('RETRY_EXHAUSTED');

      const scan = await collectImportantUnsavedNotices(
        createRetryQueue({ directory, limits: LIMITS, policy: POLICY }),
      );

      expect(scan.notices).toEqual([]);
    });

    it('says nothing about an important write that is still being retried', async () => {
      await coordinator.submitEvent(event(true), AT, { ownerId }, fake(DOWN));
      const held = (await queue.list()).items[0];
      expect(held?.terminalFailure).toBeNull();

      const scan = await collectImportantUnsavedNotices(queue);

      // Still in hand, still being tried. Not a failure yet.
      expect(scan.notices).toEqual([]);
    });

    it('says nothing about an important write waiting on a credential', async () => {
      await coordinator.submitEvent(event(true), AT, { ownerId }, fake(UNAUTHENTICATED));
      const held = (await queue.list()).items[0];
      expect(held?.attemptCount).toBe(0);
      expect(held?.terminalFailure).toBeNull();

      expect((await collectImportantUnsavedNotices(queue)).notices).toEqual([]);
    });

    it('gives the same handle whether the failure is fresh or found later', async () => {
      const immediate = await submitEventWithFallback(
        coordinator,
        event(true),
        AT,
        { ownerId },
        fake(REFUSED),
      );
      expect(immediate.memoryState).toBe('UNSAVED');

      const found = await collectImportantUnsavedNotices(
        createRetryQueue({ directory, limits: LIMITS, policy: POLICY }),
      );

      // The same logical write, so the same key — which is what lets an adapter
      // recognise a notice it has already given, without this module keeping
      // any record of what has been said.
      expect(found.notices).toHaveLength(1);
      expect(found.notices[0]?.dedupKey).toBe(immediate.noticeIntent?.dedupKey);
      expect(found.notices[0]).toEqual(immediate.noticeIntent);
    });

    it('distinguishes an Event from a Verification sharing a key', async () => {
      // The two deduplicate in separate tables on the server and can carry the
      // same key, so the handle has to name the operation as well.
      await coordinator.submitVerification(verification(true), AT, { ownerId }, fake(REFUSED));

      const scan = await collectImportantUnsavedNotices(queue);
      expect(scan.notices[0]?.operation).toBe('appendVerification');
      expect(scan.notices[0]?.dedupKey?.startsWith('appendVerification:')).toBe(true);
    });

    it('carries nothing from the write itself', async () => {
      await coordinator.submitEvent(
        {
          ownerId,
          problemId,
          problemImportant: true,
          payload: { eventType: 'DISCOVERY', summary: 'a very memorable sentence' },
        },
        AT,
        { ownerId },
        fake(REFUSED),
      );

      const scan = await collectImportantUnsavedNotices(queue);
      const rendered = JSON.stringify(scan);

      expect(Object.keys(scan.notices[0] ?? {}).sort()).toEqual(['dedupKey', 'kind', 'operation']);
      expect(rendered).not.toContain('a very memorable sentence');
      expect(rendered).not.toContain(ownerId);
      expect(rendered).not.toContain(problemId);
      expect(rendered).not.toContain(directory);
    });

    it('answers that it could not look, rather than guessing', async () => {
      // A regular file where the queue directory should be. Listing it fails
      // with ENOTDIR — a real failure — rather than the ENOENT that means
      // "nothing has been queued yet", which is not one.
      const blocked = join(directory, 'blocking-file');
      await writeFile(blocked, 'not a directory', 'utf8');
      const unreadable = createRetryQueue({
        directory: blocked,
        limits: LIMITS,
        policy: POLICY,
      });

      const scan = await collectImportantUnsavedNotices(unreadable);

      // Not a failure for the caller, and deliberately not "you have unsaved
      // important Memory" either — that would be a guess. The honest answer is
      // that nothing could be determined.
      expect(scan.kind).toBe('UNAVAILABLE');
      expect(scan.notices).toEqual([]);
    });

    it('treats a directory that does not exist as an empty queue', async () => {
      // Absent is not broken: nothing has been queued yet. Reporting that as
      // "could not look" would make a first run indistinguishable from a
      // failure.
      const fresh = createRetryQueue({
        directory: join(directory, 'not-created-yet'),
        limits: LIMITS,
        policy: POLICY,
      });

      const scan = await collectImportantUnsavedNotices(fresh);

      expect(scan.kind).toBe('AVAILABLE');
      expect(scan.notices).toEqual([]);
    });

    it('lets an unexpected failure of the scan through', async () => {
      const broken: RetryQueue = {
        enqueue: () => Promise.reject(new Error('unused')),
        list: () => Promise.reject(new TypeError('a bug in the queue')),
        attempt: () => Promise.reject(new Error('unused')),
        drain: () => Promise.reject(new Error('unused')),
      };

      await expect(collectImportantUnsavedNotices(broken)).rejects.toBeInstanceOf(TypeError);
    });
  });

  describe('a search that could not run', () => {
    it('sends the caller back to ordinary investigation', () => {
      const decision = fallbackForSearch({ kind: 'UNAVAILABLE' });

      expect(decision.mode).toBe('NORMAL_INVESTIGATION');
    });

    it('says nothing to the person about it', () => {
      // The spec lists what is worth interrupting somebody for, and a search
      // that did not run is not on it. "I could not check my notes", said at
      // every failure, is noise around work proceeding perfectly well without
      // them.
      const decision = fallbackForSearch({ kind: 'UNAVAILABLE' });

      expect(Object.keys(decision)).toEqual(['mode']);
      expect(JSON.stringify(decision)).not.toContain('NOTICE');
      expect(JSON.stringify(decision)).not.toContain('UNSAVED');
    });

    it('treats finding nothing as an answer, not a failure', () => {
      const attempt: MemorySearchAttempt<string[]> = { kind: 'AVAILABLE', value: [] };

      const decision = fallbackForSearch(attempt);

      // "Nothing matched" means this problem is new. "The search did not
      // happen" means nothing is known. Collapsing them would have an assistant
      // conclude a problem is novel because a database was briefly away.
      expect(decision.mode).toBe('USE_MEMORY_RESULT');
      expect(decision).toEqual({ mode: 'USE_MEMORY_RESULT', value: [] });
    });

    it('hands back what was found', () => {
      const found = ['a similar problem', 'another one'];

      expect(fallbackForSearch({ kind: 'AVAILABLE', value: found })).toEqual({
        mode: 'USE_MEMORY_RESULT',
        value: found,
      });
    });
  });

  describe('the work itself', () => {
    it('is the caller’s to run, and it runs', async () => {
      const full = createRetryQueue({
        directory,
        limits: { ...LIMITS, maxItems: 0 },
        policy: POLICY,
      });

      // The shape an adapter will have: ask, then get on with it. The library
      // never receives the work as a callback — a Memory module that ran the
      // assistant's work would be deciding whether real work happens.
      const decision = await submitEventWithFallback(
        createReliableWriteCoordinator(full),
        event(true),
        AT,
        { ownerId },
        fake(SUCCESS),
      );

      let mainWorkCompleted = false;
      if (decision.continueMainWork) {
        mainWorkCompleted = true;
      }

      expect(mainWorkCompleted).toBe(true);
    });
  });
});
