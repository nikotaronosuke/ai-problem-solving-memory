/**
 * The coordinator's three promises: one run per Problem, a burst collapses to
 * one rerun, and a bounded number of Problems generate at once.
 *
 * Every generation here is a controlled gate the test opens by hand, because
 * all three promises are about what happens *while a run is in flight* — a
 * scheduler tested only with instantly-resolving work has never had two
 * things in flight to schedule.
 */

import { describe, expect, it } from 'vitest';

import {
  createRetrievalGenerationCoordinator,
  DEFAULT_MAX_CONCURRENT_GENERATIONS,
} from '../../src/app/index.js';
import type { ProblemId } from '../../src/domain/problem.js';

const problem = (name: string): ProblemId => name as ProblemId;

/** A generation the test starts and finishes explicitly. */
function gatedGeneration() {
  const started: ProblemId[] = [];
  const finishers: (() => void)[] = [];
  const generate = (problemId: ProblemId): Promise<unknown> => {
    started.push(problemId);
    return new Promise((resolve) => {
      finishers.push(() => resolve({ kind: 'STORED' }));
    });
  };
  return {
    started,
    generate,
    finishNext(): void {
      const finish = finishers.shift();
      if (finish === undefined) {
        throw new Error('No run to finish.');
      }
      finish();
    },
  };
}

/** Lets queued microtasks run, so "nothing further started" is a fact. */
const drain = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the generation coordinator', () => {
  it('defaults to one generation at a time', () => {
    expect(DEFAULT_MAX_CONCURRENT_GENERATIONS).toBe(1);
  });

  it('runs one generation per Problem, however many requests arrive', async () => {
    const work = gatedGeneration();
    const coordinator = createRetrievalGenerationCoordinator(work.generate);

    coordinator.request(problem('a'));
    await drain();
    coordinator.request(problem('a'));
    coordinator.request(problem('a'));
    coordinator.request(problem('a'));
    await drain();

    // One in flight, none stacked behind it.
    expect(work.started).toEqual(['a']);

    work.finishNext();
    await drain();
    // The burst collapsed to exactly one rerun — latest wins, and the runs in
    // between were never owed to anybody.
    expect(work.started).toEqual(['a', 'a']);

    work.finishNext();
    await coordinator.settled();
    expect(work.started).toEqual(['a', 'a']);
  });

  it('coalesces a request that arrives while the Problem is only queued', async () => {
    const work = gatedGeneration();
    const coordinator = createRetrievalGenerationCoordinator(work.generate, {
      maxConcurrentGenerations: 1,
    });

    coordinator.request(problem('a'));
    await drain();
    coordinator.request(problem('b'));
    coordinator.request(problem('b'));
    coordinator.request(problem('b'));
    await drain();
    // `b` is waiting for the slot; asking again buys nothing because the
    // coming run reads the latest source anyway.
    expect(work.started).toEqual(['a']);

    work.finishNext();
    await drain();
    expect(work.started).toEqual(['a', 'b']);
    work.finishNext();
    await coordinator.settled();
    expect(work.started).toEqual(['a', 'b']);
  });

  it('holds distinct Problems to the concurrency bound', async () => {
    const work = gatedGeneration();
    const coordinator = createRetrievalGenerationCoordinator(work.generate, {
      maxConcurrentGenerations: 2,
    });

    for (const name of ['a', 'b', 'c', 'd']) {
      coordinator.request(problem(name));
    }
    await drain();
    expect(work.started).toEqual(['a', 'b']);

    work.finishNext();
    await drain();
    expect(work.started).toEqual(['a', 'b', 'c']);

    work.finishNext();
    work.finishNext();
    await drain();
    expect(work.started).toEqual(['a', 'b', 'c', 'd']);
    work.finishNext();
    await coordinator.settled();
  });

  it('counts a thrown generation as failed and keeps scheduling', async () => {
    const outcomes: string[] = [];
    let attempts = 0;
    const coordinator = createRetrievalGenerationCoordinator(
      // The first run dies, the second answers; the scheduler must survive
      // the first to start the second.
      (problemId) => {
        attempts += 1;
        if (attempts === 1) {
          return Promise.reject(new Error(`provider down for ${problemId}`));
        }
        return Promise.resolve({ kind: 'STORED' });
      },
      { onRunFinished: (outcome) => outcomes.push(outcome) },
    );

    coordinator.request(problem('a'));
    await coordinator.settled();
    coordinator.request(problem('b'));
    await coordinator.settled();

    expect(outcomes).toEqual(['FAILED', 'COMPLETED']);
  });

  it('does not let a broken reporter stop the loop', async () => {
    const started: ProblemId[] = [];
    const coordinator = createRetrievalGenerationCoordinator(
      (problemId) => {
        started.push(problemId);
        return Promise.resolve({ kind: 'STORED' });
      },
      {
        onRunFinished: () => {
          throw new Error('the counter is on fire');
        },
      },
    );

    coordinator.request(problem('a'));
    coordinator.request(problem('b'));
    await coordinator.settled();

    expect(started).toEqual(['a', 'b']);
  });

  it('never throws from request, whatever generate does', async () => {
    const coordinator = createRetrievalGenerationCoordinator(() =>
      Promise.reject(new Error('always down')),
    );

    expect(() => {
      coordinator.request(problem('a'));
      coordinator.request(problem('a'));
    }).not.toThrow();
    await coordinator.settled();
  });

  it('lets a pending rerun pick up what a stale run missed', async () => {
    // The real interleaving this models: run one reads the source, a
    // mutation lands, run one ends SOURCE_CHANGED at the locked gate, and
    // the request the mutation made is already pending — so the next run
    // reads the post-mutation source. The coordinator's part is only that
    // the pending bit survives the first run's uselessness.
    const sources = ['before the mutation', 'after the mutation'];
    const rendered: string[] = [];
    const work = gatedGeneration();
    const coordinator = createRetrievalGenerationCoordinator((problemId) => {
      rendered.push(sources[Math.min(rendered.length, sources.length - 1)] ?? '');
      return work.generate(problemId);
    });

    coordinator.request(problem('a'));
    await drain();
    coordinator.request(problem('a'));
    work.finishNext();
    await drain();
    work.finishNext();
    await coordinator.settled();

    expect(rendered).toEqual(['before the mutation', 'after the mutation']);
  });

  it('refuses a nonsense concurrency bound', () => {
    for (const bound of [0, -1, 1.5]) {
      expect(() =>
        createRetrievalGenerationCoordinator(() => Promise.resolve(undefined), {
          maxConcurrentGenerations: bound,
        }),
      ).toThrow();
    }
  });
});
