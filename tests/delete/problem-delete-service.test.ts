/**
 * The delete service, at the seam where it decides how to run.
 *
 * The integration tests around this one cover what ends up in the database.
 * They cannot cover one thing, and it turned out to matter: whether the
 * service opens a transaction at all.
 *
 * That gap was found by mutation rather than by reading. Replacing
 * `runInTransaction(...)` with a direct call on the request context's
 * repository left every integration test passing — the deletes still ran, in
 * order, and every row still went. What changed was invisible from outside: six
 * statements each committing on their own, a row lock released the moment the
 * select returned, and no way back if the fourth one failed. A test that only
 * looks at the final state of a successful delete cannot see the difference,
 * because in the successful case there is none.
 *
 * So this file asserts the shape instead. The context handed in is the real
 * interface with a recording implementation behind it, which is the same seam
 * production uses — no flag, no branch, nothing in `src/` that exists to be
 * observed.
 */

import { describe, expect, it } from 'vitest';

import {
  createProblemDeleteService,
  ProblemVersionConflictError,
  ResourceNotFoundError,
  type AuthenticatedRequestContext,
} from '../../src/app/index.js';
import type { DeleteProblemOutcome, MemoryRepository } from '../../src/repository/index.js';
import type { ClientId } from '../../src/domain/client.js';
import { generateOwnerId } from '../../src/domain/owner.js';
import type { ProblemId } from '../../src/domain/problem.js';

const PROBLEM_ID = '5d41402a-bc4b-4a76-b971-9d911017c592';

interface Recorded {
  readonly context: AuthenticatedRequestContext;
  /** Every call to `deleteProblem`, and whether a transaction was open. */
  readonly calls: { problemId: ProblemId; expectedVersion: number; transactional: boolean }[];
  transactions: number;
}

/**
 * A context that records how it was used.
 *
 * `transactional` is true only for a repository handed out by
 * `runInTransaction`. The one reachable directly through `repository` reports
 * false, so a service that skips the transaction is visible here rather than
 * merely different.
 */
function recordingContext(outcome: DeleteProblemOutcome): Recorded {
  const recorded = {
    calls: [],
    transactions: 0,
  } as unknown as { -readonly [K in keyof Recorded]: Recorded[K] };

  const repositoryFor = (transactional: boolean): MemoryRepository =>
    ({
      ownerId: generateOwnerId(),
      deleteProblem: (problemId: ProblemId, expectedVersion: number) => {
        recorded.calls.push({ problemId, expectedVersion, transactional });
        return Promise.resolve(outcome);
      },
    }) as unknown as MemoryRepository;

  const context: AuthenticatedRequestContext = {
    clientId: 'client' as unknown as ClientId,
    retrievalArtifacts: undefined as unknown as AuthenticatedRequestContext['retrievalArtifacts'],
    repository: repositoryFor(false),
    runInTransaction: async (work) => {
      recorded.transactions += 1;
      return work(repositoryFor(true));
    },
  };

  recorded.context = context;
  return recorded;
}

describe('deleting through the service', () => {
  it('runs the delete inside a transaction, once', async () => {
    const recorded = recordingContext('DELETED');

    await createProblemDeleteService().delete(recorded.context, {
      problemId: PROBLEM_ID,
      expectedVersion: 3,
    });

    // The claim, stated three ways because each is a different mistake: a
    // transaction was opened, exactly one was, and the delete happened inside
    // it rather than beside it.
    expect(recorded.transactions).toBe(1);
    expect(recorded.calls).toHaveLength(1);
    expect(recorded.calls[0]?.transactional).toBe(true);
  });

  it('passes the caller’s version through untouched', async () => {
    const recorded = recordingContext('DELETED');

    await createProblemDeleteService().delete(recorded.context, {
      problemId: PROBLEM_ID,
      expectedVersion: 7,
    });

    expect(recorded.calls[0]?.expectedVersion).toBe(7);
    expect(recorded.calls[0]?.problemId).toBe(PROBLEM_ID);
  });

  it('turns a missing Problem into a not-found', async () => {
    const recorded = recordingContext('NOT_FOUND');

    await expect(
      createProblemDeleteService().delete(recorded.context, {
        problemId: PROBLEM_ID,
        expectedVersion: 1,
      }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it('turns a moved Problem into a conflict', async () => {
    const recorded = recordingContext('VERSION_CONFLICT');

    await expect(
      createProblemDeleteService().delete(recorded.context, {
        problemId: PROBLEM_ID,
        expectedVersion: 1,
      }),
    ).rejects.toBeInstanceOf(ProblemVersionConflictError);
  });

  it('treats an id that is not one as a Problem that is not there', async () => {
    const recorded = recordingContext('DELETED');

    await expect(
      createProblemDeleteService().delete(recorded.context, {
        problemId: 'not-a-uuid',
        expectedVersion: 1,
      }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);

    // And it never reached storage, so a malformed id cannot open a
    // transaction or take a lock.
    expect(recorded.transactions).toBe(0);
    expect(recorded.calls).toEqual([]);
  });
});
