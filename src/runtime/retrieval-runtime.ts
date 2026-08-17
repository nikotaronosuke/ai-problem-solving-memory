/**
 * The production retrieval maintenance runtime: everything between "a
 * canonical write committed" and "a provider call happens", wired for a
 * server that stays up.
 *
 * ## What this owns
 *
 * Per-owner generation stacks, built lazily from the same factories every
 * test and the Phase 4 E2E composed by hand, cached for the life of the
 * process so single-flight holds across requests. The doorbell the write
 * services ring, implemented so it can never fail a write. The startup and
 * periodic reconciliation sweeps that give the lifecycle its liveness. And a
 * process-wide bound on provider generation, because per-owner coordinators
 * bound owners individually and N owners would otherwise mean N concurrent
 * provider calls.
 *
 * ## What this refuses to know
 *
 * Any vendor. The ports and the profile arrive from the provider composition
 * boundary; nothing here names a model, reads a credential, or could tell
 * OpenAI from a scripted double — the tests exploit exactly that. And any
 * Memory content across owners: discovery returns owner identifiers only,
 * every context is resolved through `resolveOwnerContextFor`, and every
 * actual read below that is owner-scoped. There is no global generation
 * service and no way to write one through this file.
 *
 * ## Failure posture
 *
 * Correctness never needed this module (the invalidation is the writes'
 * own), so nothing here is allowed to matter to a caller: a doorbell whose
 * dispatch fails is a dropped request reconciliation will repeat; a sweep
 * that fails is a sweep the next tick retries; an owner who vanished between
 * discovery and resolution is a request safely dropped. Every failure
 * surfaces at most as a closed diagnostic word.
 */

import { createRetrievalArtifactGenerationService } from '../app/retrieval-artifact-generation-service.js';
import type { RetrievalArtifactMaintenance } from '../app/retrieval-artifact-maintenance.js';
import {
  createRetrievalArtifactReconciliationService,
  type RetrievalArtifactReconciliationService,
} from '../app/retrieval-artifact-reconciliation-service.js';
import {
  createRetrievalGenerationCoordinator,
  type RetrievalGenerationCoordinator,
} from '../app/retrieval-generation-coordinator.js';
import { createRetrievalSummaryService } from '../app/retrieval-summary-service.js';
import type { RetrievalSummaryGenerator } from '../app/retrieval-summary-service.js';
import { listOwnerIdsWithReadableProblems } from '../db/owner-discovery.js';
import type { DatabasePool } from '../db/pool.js';
import { createTransactionRunner } from '../db/transaction.js';
import type { OwnerId } from '../domain/owner.js';
import type { ProblemId } from '../domain/problem.js';
import type { EmbeddingProvider } from '../domain/retrieval-embedding.js';
import type { RetrievalGenerationProfile } from '../domain/retrieval-generation-profile.js';
import { resolveOwnerContextFor } from '../owner/context.js';
import {
  createRetrievalArtifactReconciliationReader,
  createRetrievalSummarySourceReader,
} from '../repository/index.js';

/**
 * How often the safety net runs when nobody says otherwise.
 *
 * The doorbell is the normal path; this exists for crashes, outages and
 * migrations, so minutes are the right unit. A working constant — never a
 * recorded invariant.
 */
export const RETRIEVAL_RECONCILIATION_INTERVAL_MS = 5 * 60 * 1000;

/**
 * How many provider generations the whole process runs at once.
 *
 * One, by default: this is one person's background maintenance, and the
 * bound is what keeps a cold-store backfill a queue rather than a stampede —
 * across owners, which the per-owner coordinators cannot see.
 */
export const DEFAULT_PROCESS_GENERATION_BOUND = 1;

/** The closed diagnostics this runtime can emit. Words, never values. */
export type RetrievalRuntimeEvent =
  | 'RETRIEVAL_GENERATION_COMPLETED'
  | 'RETRIEVAL_GENERATION_FAILED'
  | 'RETRIEVAL_RECONCILIATION_FAILED';

/**
 * The timer seam, so tests drive ticks by hand.
 *
 * `schedule` returns the canceller. The default uses `setInterval` and
 * unrefs it, so the maintenance loop never keeps a process alive on its own.
 */
export interface RetrievalRuntimeScheduler {
  schedule(callback: () => void, intervalMs: number): () => void;
}

const NODE_SCHEDULER: RetrievalRuntimeScheduler = {
  schedule(callback, intervalMs) {
    const timer = setInterval(callback, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  },
};

export interface RetrievalRuntimeDependencies {
  /** The pool. Owner contexts, readers and transactions are built on it. */
  readonly pool: DatabasePool;
  /** The configured stack's ports, already vendor-anonymous. */
  readonly summaryGenerator: RetrievalSummaryGenerator;
  readonly embeddingProvider: EmbeddingProvider;
  readonly generationProfile: RetrievalGenerationProfile;
  /** Diagnostics, closed words only. Optional, contained if it throws. */
  readonly onEvent?: (event: RetrievalRuntimeEvent) => void;
  /** Overrides for tests. Production takes the defaults. */
  readonly scheduler?: RetrievalRuntimeScheduler;
  readonly reconciliationIntervalMs?: number;
  readonly processGenerationBound?: number;
  /**
   * Which owners a sweep considers. Production takes the default — every
   * owner with a read-enabled Problem, via the discovery read — and tests
   * running against a shared database inject their own owners so a sweep
   * cannot write into a neighbouring suite's fixtures.
   */
  readonly discoverOwners?: () => Promise<OwnerId[]>;
}

export interface RetrievalRuntime {
  /** The doorbell the write services are composed with. */
  readonly maintenance: RetrievalArtifactMaintenance;

  /** Starts the safety net: one immediate sweep, then the interval. Idempotent. */
  start(): void;

  /** Stops timers and refuses new work. Safe to call repeatedly. */
  stop(): void;

  /** One global sweep, for the timer and for tests. Never rejects. */
  sweep(): Promise<void>;

  /** Resolves when every known coordinator is idle. A fence for tests. */
  settled(): Promise<void>;
}

interface OwnerRuntime {
  readonly coordinator: RetrievalGenerationCoordinator;
  readonly reconciliation: RetrievalArtifactReconciliationService;
}

/**
 * A plain FIFO bounded permit. No priorities, no cancellation, no timeouts,
 * no identifiers — the only thing it is for is holding provider generations
 * to a bound without letting the queue starve.
 *
 * ## Why a release hands the permit over instead of freeing it
 *
 * The obvious implementation decrements a counter and then wakes the head of
 * the queue. Between those two steps the permit is *free*, and waking is only
 * a promise resolution — the woken waiter resumes a microtask later. A caller
 * arriving inside that window finds the counter free, takes the permit, and
 * the waiter who had been queued first resumes to find the gate busy and goes
 * to the back of the queue. The bound still holds. The order does not, and
 * under a steady arrival rate the first waiter can be passed indefinitely.
 *
 * So a release never returns the permit to the pool while anyone is waiting:
 * it transfers the permit to the head of the queue, and **being woken is
 * holding the permit** — a woken waiter re-tests nothing. The fast path is
 * correspondingly narrow: a newcomer may take a permit only when one is free
 * *and* nobody is queued, which is what makes overtaking unstateable rather
 * than merely unlikely.
 *
 * The invariant, either way round: holders + available === bound.
 *
 * Exported for the fairness witness in this module's tests, and internal to
 * the runtime otherwise — a guard keeps it from becoming a general-purpose
 * semaphore somewhere else.
 */
export function createGenerationGate(bound: number) {
  let available = bound;
  const waiters: (() => void)[] = [];

  return async function gated<T>(work: () => Promise<T>): Promise<T> {
    if (available > 0 && waiters.length === 0) {
      available -= 1;
    } else {
      // Nothing is re-checked when this resolves: the wake *is* the permit.
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    }

    try {
      return await work();
    } finally {
      const next = waiters.shift();
      if (next === undefined) {
        available += 1;
      } else {
        // Handed over, not freed. There is no window for a late arrival to
        // take because the permit is never unheld.
        next();
      }
    }
  };
}

export function createRetrievalRuntime(
  dependencies: RetrievalRuntimeDependencies,
): RetrievalRuntime {
  const {
    pool,
    summaryGenerator,
    embeddingProvider,
    generationProfile,
    onEvent,
    scheduler = NODE_SCHEDULER,
    reconciliationIntervalMs = RETRIEVAL_RECONCILIATION_INTERVAL_MS,
    processGenerationBound = DEFAULT_PROCESS_GENERATION_BOUND,
    discoverOwners = () => listOwnerIdsWithReadableProblems(pool),
  } = dependencies;

  if (!Number.isInteger(processGenerationBound) || processGenerationBound <= 0) {
    throw new Error('The retrieval runtime needs a positive whole generation bound.');
  }

  const transactionRunner = createTransactionRunner(pool);
  const gate = createGenerationGate(processGenerationBound);

  /**
   * Owner runtimes, keyed by owner, cached as promises so concurrent first
   * doorbells build one stack. A failed build is evicted rather than cached:
   * an owner whose context could not be resolved this time may exist again
   * to the next request, and a permanently poisoned entry would silence that
   * owner's maintenance forever.
   */
  const owners = new Map<OwnerId, Promise<OwnerRuntime>>();

  let stopped = false;
  let cancelTimer: (() => void) | undefined;
  let sweeping = false;

  function report(event: RetrievalRuntimeEvent): void {
    try {
      onEvent?.(event);
    } catch {
      // A broken reporter must not stop maintenance.
    }
  }

  async function buildOwnerRuntime(ownerId: OwnerId): Promise<OwnerRuntime> {
    // Through the same gate as every owner resolution in the system — never
    // a cast. An owner that is gone throws here, and the caller drops the
    // request.
    const ownerContext = await resolveOwnerContextFor(pool, ownerId);

    const generation = createRetrievalArtifactGenerationService(
      createRetrievalSummaryService(
        createRetrievalSummarySourceReader(pool, ownerContext),
        summaryGenerator,
      ),
      embeddingProvider,
      transactionRunner,
      ownerContext,
    );

    const coordinator = createRetrievalGenerationCoordinator(
      // The process-wide gate wraps the whole generation — provider calls
      // and the short final transaction alike — so whatever the number of
      // owners, at most `processGenerationBound` generations are in flight.
      (problemId) => gate(() => generation.generateArtifact(problemId)),
      {
        onRunFinished: (outcome) => {
          report(
            outcome === 'COMPLETED'
              ? 'RETRIEVAL_GENERATION_COMPLETED'
              : 'RETRIEVAL_GENERATION_FAILED',
          );
        },
      },
    );

    return {
      coordinator,
      reconciliation: createRetrievalArtifactReconciliationService(
        createRetrievalArtifactReconciliationReader(pool, ownerContext),
        coordinator,
        generationProfile,
      ),
    };
  }

  function ownerRuntime(ownerId: OwnerId): Promise<OwnerRuntime> {
    const cached = owners.get(ownerId);
    if (cached !== undefined) {
      return cached;
    }
    const building = buildOwnerRuntime(ownerId);
    owners.set(ownerId, building);
    building.catch(() => {
      // Evict, so the failure is not permanent. The catch is on a separate
      // chain: callers still see the rejection and handle it themselves.
      owners.delete(ownerId);
    });
    return building;
  }

  async function dispatch(ownerId: OwnerId, problemId: ProblemId): Promise<void> {
    try {
      const runtime = await ownerRuntime(ownerId);
      if (stopped) {
        return;
      }
      runtime.coordinator.request(problemId);
    } catch {
      // The owner vanished, or the stack could not be built. The write this
      // followed has committed and stands; reconciliation covers the gap.
      report('RETRIEVAL_GENERATION_FAILED');
    }
  }

  async function sweep(): Promise<void> {
    if (stopped || sweeping) {
      // One sweep at a time, globally. A tick that lands mid-sweep is
      // skipped rather than queued: the next tick runs soon enough, and a
      // pending pile-up has no meaning for a scan of current state.
      return;
    }
    sweeping = true;
    try {
      const ownerIds = await discoverOwners();
      // Sequential on purpose: discovery is cheap, reconciliation is one
      // bounded read per owner, and the expensive part — generation — is
      // bounded by the gate regardless. Parallelising this would add
      // failure modes and save nothing that matters.
      for (const ownerId of ownerIds) {
        if (stopped) {
          break;
        }
        try {
          const runtime = await ownerRuntime(ownerId);
          await runtime.reconciliation.reconcile();
        } catch {
          report('RETRIEVAL_RECONCILIATION_FAILED');
        }
      }
    } catch {
      report('RETRIEVAL_RECONCILIATION_FAILED');
    } finally {
      sweeping = false;
    }
  }

  return {
    maintenance: {
      requestGeneration(context, problemId): void {
        if (stopped) {
          return;
        }
        // The owner comes from the context's own owner-scoped repository —
        // established by authentication, never by anything a caller supplied
        // by name. Only the identifier is taken; the context itself is not
        // retained beyond this synchronous frame.
        const ownerId = context.retrievalArtifacts.ownerId;
        void dispatch(ownerId, problemId);
      },
    },

    start(): void {
      if (stopped || cancelTimer !== undefined) {
        return;
      }
      cancelTimer = scheduler.schedule(() => {
        void sweep();
      }, reconciliationIntervalMs);
      // The startup sweep is the backfill and the crash recovery, and it is
      // fire-and-forget: the server is already listening, and ordinary CRUD
      // must not wait for a provider.
      void sweep();
    },

    stop(): void {
      stopped = true;
      cancelTimer?.();
      cancelTimer = undefined;
    },

    sweep,

    async settled(): Promise<void> {
      // Coordinators drain their own queues; new owners cannot appear while
      // the loop below runs unless something requests them, which a test
      // controls.
      for (const pending of [...owners.values()]) {
        const runtime = await pending.catch(() => undefined);
        await runtime?.coordinator.settled();
      }
    },
  };
}
