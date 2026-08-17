/**
 * Scheduling artifact generation without ever scheduling it twice at once.
 *
 * Generation is slow and costs somebody money: a summary call and an
 * embedding call per run. The canonical writes that make a run necessary are
 * fast and arrive in bursts — a close writes several Events in one
 * transaction, an investigation appends attempt after attempt. This module
 * sits between the two speeds and enforces exactly three things:
 *
 * - **Single-flight per Problem.** One generation per Problem at a time,
 *   ever. A burst of requests during a run collapses to one bit: *run once
 *   more when this one finishes*. The rerun reads the source fresh, so
 *   whatever the burst wrote is what it renders — latest wins, and the runs
 *   in between were never owed to anybody.
 * - **Bounded concurrency across Problems.** A backlog drains a few at a
 *   time rather than all at once, so a reconciliation sweep over a cold
 *   database is a queue, not a stampede.
 * - **A request never fails.** `request` returns nothing, throws nothing and
 *   waits for nothing. The caller has just committed a canonical write; what
 *   becomes of the rendering is not its problem, and could not be allowed to
 *   become its problem — correctness never depends on this module running at
 *   all, because the stale artifact is already gone. This is purely the
 *   liveness half.
 *
 * What this deliberately is not: a retry policy (a failed run stays failed
 * until something — the next write, the next sweep — asks again), a timer
 * (composition wires those), a queue that survives the process (absence in
 * the store is the durable state, and reconciliation reads it), or anything
 * that knows what a generation *is* (it is handed a function).
 */

import type { ProblemId } from '../domain/problem.js';

/**
 * The boundary a canonical write path schedules through.
 *
 * The contract, since a type cannot carry it: call after the write has
 * committed, never inside its transaction; expect nothing back; and expect
 * the call itself never to throw. Implementations that talk to anything
 * outside the process do so after returning, not during the call.
 */
export interface RetrievalGenerationRequests {
  /** Asks for this Problem's artifact to be (re)generated, eventually. */
  request(problemId: ProblemId): void;
}

/** What one run came to. `FAILED` is a fact for a counter, not an error. */
export type RetrievalGenerationRunOutcome = 'COMPLETED' | 'FAILED';

export interface RetrievalGenerationCoordinator extends RetrievalGenerationRequests {
  /**
   * Resolves when no run is active and nothing is waiting.
   *
   * For composition points that want to drain — a startup sweep before
   * accepting traffic, a test that needs the world to settle. New requests
   * arriving after it resolves start new work; this is a fence, not a
   * shutdown.
   */
  settled(): Promise<void>;
}

/**
 * How many Problems may generate at once when nothing says otherwise.
 *
 * One. Generation is background work for a single person's Memory, and the
 * bound exists to keep a backlog from becoming a burst of provider calls. A
 * working constant, not a recorded invariant.
 */
export const DEFAULT_MAX_CONCURRENT_GENERATIONS = 1;

export interface RetrievalGenerationCoordinatorOptions {
  /** Concurrent runs across distinct Problems. Per Problem it is always one. */
  readonly maxConcurrentGenerations?: number;

  /**
   * Told how each run ended, and nothing else — no Problem, no error, no
   * provider text. A reporter that throws is contained: the loop it would
   * break is the one thing that must keep running.
   */
  readonly onRunFinished?: (outcome: RetrievalGenerationRunOutcome) => void;
}

interface ProblemWork {
  /** True while a run for this Problem is in flight. */
  running: boolean;
  /** True when something asked again during the run. One bit, by design. */
  runAgain: boolean;
}

/**
 * Builds the coordinator around one generation function.
 *
 * The function is typically the generation service's `generateArtifact`,
 * owner-bound like everything on this path. Its outcome union is deliberately
 * not interpreted here: `SOURCE_CHANGED` means a newer write is about to
 * request again, `SOURCE_NOT_AVAILABLE` means the Problem is gone or was
 * never this owner's, `MEMORY_READ_DISABLED` means the owner said no — every
 * one of them is a reason to do nothing further, which is what not
 * interpreting them does. Only a thrown failure is counted, as `FAILED`.
 */
export function createRetrievalGenerationCoordinator(
  generate: (problemId: ProblemId) => Promise<unknown>,
  options: RetrievalGenerationCoordinatorOptions = {},
): RetrievalGenerationCoordinator {
  const maxConcurrent = options.maxConcurrentGenerations ?? DEFAULT_MAX_CONCURRENT_GENERATIONS;
  if (!Number.isInteger(maxConcurrent) || maxConcurrent <= 0) {
    throw new Error('A generation coordinator needs a positive whole concurrency bound.');
  }

  const work = new Map<ProblemId, ProblemWork>();
  /** Problems with work waiting for a slot, oldest request first. */
  const ready: ProblemId[] = [];
  let active = 0;
  const fences: (() => void)[] = [];

  function pump(): void {
    while (active < maxConcurrent) {
      const problemId = ready.shift();
      if (problemId === undefined) {
        break;
      }
      const entry = work.get(problemId);
      if (entry === undefined || entry.running) {
        // Unreachable while the bookkeeping below holds; skipping is the
        // shape of "and if it ever does not, do not run twice".
        continue;
      }
      entry.running = true;
      active += 1;
      void run(problemId, entry);
    }

    if (active === 0 && ready.length === 0) {
      for (const release of fences.splice(0)) {
        release();
      }
    }
  }

  async function run(problemId: ProblemId, entry: ProblemWork): Promise<void> {
    let outcome: RetrievalGenerationRunOutcome = 'COMPLETED';
    try {
      await generate(problemId);
    } catch {
      // The generation service has already turned everything reportable into
      // its outcome union; a throw is infrastructure failing. The artifact is
      // simply still absent, which reconciliation can see and this cannot fix.
      outcome = 'FAILED';
    }

    try {
      options.onRunFinished?.(outcome);
    } catch {
      // A broken reporter must not stop the scheduler.
    }

    active -= 1;
    if (entry.runAgain) {
      // Something changed the source mid-run. The next run reads it fresh,
      // so one rerun answers any number of requests.
      entry.runAgain = false;
      entry.running = false;
      ready.push(problemId);
    } else {
      work.delete(problemId);
    }
    pump();
  }

  return {
    request(problemId): void {
      const entry = work.get(problemId);
      if (entry !== undefined) {
        if (entry.running) {
          entry.runAgain = true;
        }
        // Queued but not yet running: the coming run will read the latest
        // source anyway, so this request is already answered.
        return;
      }
      work.set(problemId, { running: false, runAgain: false });
      ready.push(problemId);
      pump();
    },

    settled(): Promise<void> {
      if (active === 0 && ready.length === 0) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        fences.push(resolve);
      });
    },
  };
}
