/**
 * The runtime's scheduling promises, proven against controlled time and a
 * scripted world.
 *
 * Everything database-shaped here is a double: these tests are about the
 * runtime's own behaviour — the global bound, the sweep serialisation, the
 * stop semantics, owner-stack caching — and a real store would only blur
 * whose behaviour a failure belongs to. The integration file next door runs
 * the same runtime against real PostgreSQL.
 */

import { describe, expect, it } from 'vitest';

import type { AuthenticatedRequestContext } from '../../src/app/index.js';
import type { OwnerId } from '../../src/domain/owner.js';
import {
  createGenerationGate,
  createRetrievalRuntime,
  DEFAULT_PROCESS_GENERATION_BOUND,
  type RetrievalRuntimeScheduler,
} from '../../src/runtime/retrieval-runtime.js';
import type { RetrievalRuntimeDependencies } from '../../src/runtime/retrieval-runtime.js';

/** A generator/provider pair no test here ever lets reach a network. */
const PORTS = {
  summaryGenerator: {
    generatorId: 'scripted-generator',
    generatorVersion: '1',
    generate: () => Promise.resolve({}),
  },
  embeddingProvider: {
    modelId: 'scripted-model',
    modelVersion: '1',
    dimensions: 3,
    embed: () => Promise.resolve([1, 0, 0]),
  },
  generationProfile: {
    summaryGeneratorId: 'scripted-generator',
    summaryGeneratorVersion: '1',
    embeddingModel: 'scripted-model',
    embeddingModelVersion: '1',
    embeddingDimensions: 3,
  },
} as const;

/** A pool double: answers owner resolution and records everything else. */
function fakePool(options: { ownerRows?: string[]; failDiscovery?: boolean } = {}) {
  const queries: string[] = [];
  const pool = {
    query(text: string) {
      queries.push(text);
      if (text.includes('from public.owners')) {
        // Owner resolution: every owner exists.
        return Promise.resolve({ rows: [{ owner_id: 'x' }], rowCount: 1 });
      }
      if (text.includes('select distinct owner_id')) {
        if (options.failDiscovery === true) {
          return Promise.reject(new Error('discovery broke'));
        }
        return Promise.resolve({
          rows: (options.ownerRows ?? []).map((id) => ({ owner_id: id })),
          rowCount: (options.ownerRows ?? []).length,
        });
      }
      // Reconciliation scans and everything else: nothing to do.
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  };
  return { pool: pool as never, queries };
}

/** A scheduler the test ticks by hand. */
function manualScheduler() {
  let callback: (() => void) | undefined;
  let cancelled = 0;
  let scheduled = 0;
  const scheduler: RetrievalRuntimeScheduler = {
    schedule(handler) {
      scheduled += 1;
      callback = handler;
      return () => {
        cancelled += 1;
        callback = undefined;
      };
    },
  };
  return {
    scheduler,
    tick: () => callback?.(),
    get scheduled() {
      return scheduled;
    },
    get cancelled() {
      return cancelled;
    },
  };
}

function contextFor(ownerId: string): AuthenticatedRequestContext {
  return { retrievalArtifacts: { ownerId: ownerId as OwnerId } } as AuthenticatedRequestContext;
}

function runtimeWith(overrides: Partial<RetrievalRuntimeDependencies> = {}) {
  const { pool } = fakePool();
  return createRetrievalRuntime({
    pool,
    ...PORTS,
    ...overrides,
  });
}

const drain = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * The generation gate's fairness, measured directly.
 *
 * The bound is proven through the runtime further down — two owners racing,
 * peak in-flight one. Fairness cannot be, because it is a property of a
 * window one microtask wide, and the runtime's DB reads sit between a request
 * and the gate. So these test the permit itself.
 *
 * Neither test counts microtask hops. The distinguishing scenario is "a
 * newcomer arrives exactly at the handoff", and rather than guessing which
 * hop that is, each test lets a newcomer arrive on *every* hop across the
 * whole release path: whichever one the handoff lands on, an arrival is there
 * to try to take the permit. Under free-then-wake, that arrival finds the
 * slot free and starts ahead of the waiter that queued before it. Under
 * permit handoff, there is nothing to take.
 */
describe('the process-wide generation gate', () => {
  /** Runs `count` microtask hops, letting `onHop` act on each boundary. */
  async function acrossReleaseHops(count: number, onHop: (hop: number) => void): Promise<void> {
    for (let hop = 0; hop < count; hop += 1) {
      await Promise.resolve();
      onHop(hop);
    }
  }

  it('hands a released permit to the queued waiter, not to a late arrival', async () => {
    const gate = createGenerationGate(1);
    const started: string[] = [];
    let releaseA = (): void => {};
    const held = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    // A holds; everything else is instant, so the order they start in is the
    // order the gate admitted them in.
    const running = [
      gate(async () => {
        started.push('A');
        await held;
      }),
    ];
    await drain();
    expect(started).toEqual(['A']);

    // B queues while A is still holding: it is the rightful next holder.
    running.push(
      gate(() => {
        started.push('B');
        return Promise.resolve();
      }),
    );
    await drain();
    expect(started).toEqual(['A']);

    releaseA();
    await acrossReleaseHops(6, (hop) => {
      running.push(
        gate(() => {
          started.push(`C${String(hop)}`);
          return Promise.resolve();
        }),
      );
    });
    await Promise.all(running);

    // B second, and the latecomers behind it in arrival order. Under
    // free-then-wake the hop that coincides with the handoff overtakes B,
    // and B — re-testing admission on resume — goes to the back.
    expect(started).toEqual(['A', 'B', 'C0', 'C1', 'C2', 'C3', 'C4', 'C5']);
  });

  it('does not let a burst of late arrivals starve a queued waiter', async () => {
    // The same property at a bound above one, where two holders release
    // independently and there are more windows to slip through.
    const gate = createGenerationGate(2);
    const started: string[] = [];
    const releases: (() => void)[] = [];
    const holder = (name: string) =>
      gate(async () => {
        started.push(name);
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
      });

    const running = [holder('A'), holder('B')];
    await drain();
    expect(started).toEqual(['A', 'B']);

    // Queued before any latecomer exists.
    running.push(
      gate(() => {
        started.push('C');
        return Promise.resolve();
      }),
    );
    await drain();
    expect(started).toEqual(['A', 'B']);

    releases.shift()?.();
    await acrossReleaseHops(6, (hop) => {
      running.push(
        gate(() => {
          started.push(`D${String(hop)}`);
          return Promise.resolve();
        }),
      );
    });
    releases.shift()?.();
    await Promise.all(running);

    // C is next after the two holders, and nobody who arrived later is
    // stranded: everyone runs, in the order they asked.
    expect(started).toEqual(['A', 'B', 'C', 'D0', 'D1', 'D2', 'D3', 'D4', 'D5']);
  });

  it('never exceeds the bound while handing permits over', async () => {
    const gate = createGenerationGate(2);
    let inFlight = 0;
    let peak = 0;
    const releases: (() => void)[] = [];

    const running = Array.from({ length: 6 }, () =>
      gate(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
        inFlight -= 1;
      }),
    );

    for (let step = 0; step < 6; step += 1) {
      await drain();
      releases.shift()?.();
    }
    await Promise.all(running);

    expect(peak).toBe(2);
    expect(inFlight).toBe(0);
  });
});

describe('the retrieval runtime', () => {
  it('defaults the process-wide bound to one', () => {
    expect(DEFAULT_PROCESS_GENERATION_BOUND).toBe(1);
  });

  it('refuses a nonsense bound', () => {
    for (const bound of [0, -1, 2.5]) {
      expect(() => runtimeWith({ processGenerationBound: bound })).toThrow();
    }
  });

  it('holds concurrent owners to the shared bound, not just each to their own', async () => {
    // Two owners, one slot. Per-owner coordinators alone would run these in
    // parallel — each owner is that coordinator's only client — so what this
    // measures is specifically the process-wide gate. The pool serves a real
    // source row so each generation actually reaches its generator, which is
    // where the in-flight counter sits — inside the gate.
    let inFlight = 0;
    let peak = 0;
    const finishers: (() => void)[] = [];
    const sourcefulPool = {
      query(text: string) {
        if (text.includes('from public.owners')) {
          return Promise.resolve({ rows: [{ owner_id: 'x' }], rowCount: 1 });
        }
        if (text.includes('canonical_source')) {
          return Promise.resolve({
            rows: [
              {
                canonical_source: '{"schema_version":"1"}',
                memory_read_enabled: true,
                status: 'INVESTIGATING',
                has_successful_verification: false,
                project_id: '99999999-0000-4000-8000-000000000009',
              },
            ],
            rowCount: 1,
          });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
    };
    const runtime = createRetrievalRuntime({
      pool: sourcefulPool as never,
      ...PORTS,
      summaryGenerator: {
        ...PORTS.summaryGenerator,
        generate: () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          return new Promise((resolve) => {
            finishers.push(() => {
              inFlight -= 1;
              resolve({});
            });
          });
        },
      },
    });

    runtime.maintenance.requestGeneration(
      contextFor('aaaaaaaa-0000-4000-8000-000000000001'),
      'p1' as never,
    );
    runtime.maintenance.requestGeneration(
      contextFor('bbbbbbbb-0000-4000-8000-000000000002'),
      'p2' as never,
    );
    await drain();
    await drain();

    expect(peak).toBe(1);
    finishers.shift()?.();
    await drain();
    await drain();
    expect(peak).toBe(1);
    finishers.shift()?.();
    await runtime.settled();
    expect(peak).toBe(1);
  });

  it('builds one owner stack for concurrent first doorbells', async () => {
    let resolutions = 0;
    const { pool } = fakePool();
    const counting = {
      query(text: string) {
        if (text.includes('from public.owners')) {
          resolutions += 1;
        }
        return (pool as { query: (t: string) => Promise<unknown> }).query(text);
      },
    };
    const runtime = createRetrievalRuntime({ pool: counting as never, ...PORTS });
    const owner = contextFor('cccccccc-0000-4000-8000-000000000003');

    runtime.maintenance.requestGeneration(owner, 'p1' as never);
    runtime.maintenance.requestGeneration(owner, 'p1' as never);
    runtime.maintenance.requestGeneration(owner, 'p1' as never);
    await runtime.settled();
    await drain();

    // One resolution: the cache is a promise, so even simultaneous firsts
    // share the build.
    expect(resolutions).toBe(1);
  });

  it('does not cache a failed owner-stack build forever', async () => {
    let attempts = 0;
    const failingThenFine = {
      query(text: string) {
        if (text.includes('from public.owners')) {
          attempts += 1;
          if (attempts === 1) {
            return Promise.reject(new Error('resolution broke'));
          }
          return Promise.resolve({ rows: [{ owner_id: 'x' }], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
    };
    const events: string[] = [];
    const runtime = createRetrievalRuntime({
      pool: failingThenFine as never,
      ...PORTS,
      onEvent: (event) => events.push(event),
    });
    const owner = contextFor('dddddddd-0000-4000-8000-000000000004');

    runtime.maintenance.requestGeneration(owner, 'p1' as never);
    await drain();
    await drain();
    expect(events).toContain('RETRIEVAL_GENERATION_FAILED');

    // The next doorbell rebuilds rather than reusing the poisoned promise.
    runtime.maintenance.requestGeneration(owner, 'p1' as never);
    await runtime.settled();
    await drain();
    expect(attempts).toBe(2);
  });

  it('never throws from the doorbell, whatever breaks inside', async () => {
    const exploding = {
      query() {
        return Promise.reject(new Error('everything is broken'));
      },
    };
    const runtime = createRetrievalRuntime({ pool: exploding as never, ...PORTS });

    expect(() => {
      runtime.maintenance.requestGeneration(
        contextFor('eeeeeeee-0000-4000-8000-000000000005'),
        'p1' as never,
      );
    }).not.toThrow();
    await drain();
    await drain();
  });

  it('runs one global sweep at a time', async () => {
    let discoveries = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowDiscovery = {
      async query(text: string) {
        if (text.includes('select distinct owner_id')) {
          discoveries += 1;
          await gate;
          return { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    const timer = manualScheduler();
    const runtime = createRetrievalRuntime({
      pool: slowDiscovery as never,
      ...PORTS,
      scheduler: timer.scheduler,
    });

    runtime.start();
    await drain();
    // The interval fires twice while the startup sweep is still inside its
    // discovery; both land mid-sweep and are skipped, not queued.
    timer.tick();
    timer.tick();
    await drain();
    expect(discoveries).toBe(1);

    release();
    await drain();
    await drain();
    // A later tick, after the first sweep finished, runs again.
    timer.tick();
    await drain();
    expect(discoveries).toBe(2);
    runtime.stop();
  });

  it('starts once, stops cleanly, and stays stopped', async () => {
    const { pool, queries } = fakePool({ ownerRows: [] });
    const timer = manualScheduler();
    const runtime = createRetrievalRuntime({ pool, ...PORTS, scheduler: timer.scheduler });

    runtime.start();
    runtime.start();
    expect(timer.scheduled).toBe(1);

    runtime.stop();
    runtime.stop();
    expect(timer.cancelled).toBe(1);

    const before = queries.length;
    // A stopped runtime refuses everything new: no doorbell dispatch, no
    // sweep, and a tick that still fires finds nothing to do.
    runtime.maintenance.requestGeneration(
      contextFor('ffffffff-0000-4000-8000-000000000006'),
      'p1' as never,
    );
    await runtime.sweep();
    timer.tick();
    await drain();
    await drain();
    expect(queries.length).toBe(before);
  });

  it('keeps sweeping through owners whose reconciliation fails', async () => {
    // First owner's scan breaks; the second owner must still be swept, and
    // the failure surfaces as one closed word.
    const events: string[] = [];
    const owners = ['aaaaaaaa-1111-4000-8000-000000000001', 'bbbbbbbb-1111-4000-8000-000000000002'];
    let scans = 0;
    const pool = {
      query(text: string) {
        if (text.includes('select distinct owner_id')) {
          return Promise.resolve({ rows: owners.map((id) => ({ owner_id: id })), rowCount: 2 });
        }
        if (text.includes('from public.owners')) {
          return Promise.resolve({ rows: [{ owner_id: 'x' }], rowCount: 1 });
        }
        // The reconciliation scan: first owner's breaks.
        scans += 1;
        if (scans === 1) {
          return Promise.reject(new Error('scan broke'));
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
    };
    const runtime = createRetrievalRuntime({
      pool: pool as never,
      ...PORTS,
      onEvent: (event) => events.push(event),
    });

    await runtime.sweep();

    expect(scans).toBe(2);
    expect(events).toContain('RETRIEVAL_RECONCILIATION_FAILED');
  });
});
