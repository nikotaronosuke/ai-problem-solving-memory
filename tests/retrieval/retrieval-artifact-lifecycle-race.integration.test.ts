/**
 * The three interleavings of a generation and a canonical write, against the
 * real lock.
 *
 * Case A — the generation wins the lock. The append waits on the Problem row
 * (its foreign-key check needs a key-share the `for update` holds), the
 * artifact commits, the append then commits and takes it away in the same
 * statement. Final state: absent, which is correct — an artifact of the
 * pre-append source must not outlive the append.
 *
 * Case B — the write commits first. The generation had already read the old
 * source; at the locked gate the fingerprint no longer matches, and nothing
 * is written. Final state: absent.
 *
 * Case C — a generation that starts after the write renders the new source
 * and stores it. Final state: present and current.
 *
 * Stale data loses every race by construction: A deletes it, B refuses to
 * write it, and C replaces absence with the current rendering. These are
 * measured here rather than argued, on a real PostgreSQL, because every one
 * of them is a property of locks and snapshots that a double cannot have.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createRetrievalArtifactGenerationService,
  createRetrievalSummaryService,
  type RetrievalSummaryGenerator,
} from '../../src/app/index.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import type { DatabaseExecutor } from '../../src/db/executor.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import {
  createTransactionRunner,
  type DatabaseTransactionRunner,
} from '../../src/db/transaction.js';
import type { ClientEventId } from '../../src/domain/client-event-id.js';
import { generateOwnerId, type OwnerContext, type OwnerId } from '../../src/domain/owner.js';
import type { ProblemId } from '../../src/domain/problem.js';
import type { EmbeddingProvider } from '../../src/domain/retrieval-embedding.js';
import { resolveOwnerContextFor } from '../../src/owner/context.js';
import {
  createMemoryRepository,
  createRetrievalArtifactRepository,
  createRetrievalSummarySourceReader,
  type MemoryRepository,
  type RetrievalArtifactRepository,
} from '../../src/repository/index.js';
import {
  createArtifactInspectionPolicy,
  createSecretDetectionPolicy,
  withSanitization,
} from '../../src/sanitization/index.js';

const databaseUrl = process.env['DATABASE_URL'];

/** A generator whose output satisfies every domain rule, instantly. */
function generator(): RetrievalSummaryGenerator {
  return {
    generatorId: 'race-summary-generator',
    generatorVersion: '1',
    generate: () =>
      Promise.resolve({
        normalizedSummary: 'a rendering for the race',
        keywords: ['race'],
        structuralFeatures: {
          schema_version: '1',
          problem_domain: null,
          symptom_patterns: ['raced symptoms'],
          suspected_boundaries: [],
          occurrence_conditions: [],
          successful_directions: [],
          dead_end_directions: [],
          environment_facts: [],
        },
      }),
  };
}

function provider(): EmbeddingProvider {
  return {
    modelId: 'race-embedding-model',
    modelVersion: '1',
    dimensions: 3,
    embed: () => Promise.resolve([0.5, -0.25, 0.125]),
  };
}

describe.skipIf(databaseUrl === undefined)('the generation-versus-write races', () => {
  let pool: DatabasePool;
  let memory: MemoryRepository;
  let artifacts: RetrievalArtifactRepository;
  let context: OwnerContext;
  const ownersCreated: OwnerId[] = [];

  beforeAll(async () => {
    pool = createPool(resolveDatabaseConfig({ nodeEnv: 'test', connectionTimeoutMillis: 5_000 }));
    const ownerId = generateOwnerId();
    await insertOwnerIfAbsent(pool, ownerId);
    ownersCreated.push(ownerId);
    context = await resolveOwnerContextFor(pool, ownerId);
    memory = withSanitization(createMemoryRepository(pool, context), createSecretDetectionPolicy());
    artifacts = withSanitization(
      createRetrievalArtifactRepository(pool, context),
      createArtifactInspectionPolicy(),
    );
  });

  afterAll(async () => {
    if (ownersCreated.length > 0) {
      for (const table of [
        'retrieval_artifacts',
        'change_logs',
        'usage_logs',
        'relations',
        'verifications',
        'events',
        'problems',
        'environments',
        'projects',
        'owners',
      ]) {
        await pool.query(`delete from public.${table} where owner_id = any($1::uuid[])`, [
          ownersCreated,
        ]);
      }
    }
    await closePool(pool);
  });

  async function makeProblem(): Promise<ProblemId> {
    const project = await memory.createProject({ projectName: `project ${randomUUID()}` });
    const environment = await memory.createEnvironment({
      projectId: project.projectId,
      snapshot: { runtime: 'node 22.12.0' },
    });
    const problem = await memory.createProblem({
      projectId: project.projectId,
      environmentId: environment.environmentId,
      title: 'a raced title',
      symptoms: 'raced symptoms',
    });
    return problem.problemId;
  }

  function serviceWith(runner: DatabaseTransactionRunner) {
    return createRetrievalArtifactGenerationService(
      createRetrievalSummaryService(createRetrievalSummarySourceReader(pool, context), generator()),
      provider(),
      runner,
      context,
    );
  }

  /**
   * A transaction runner that pauses after the `for update` lock is taken,
   * so a test can hold the gate open and watch what waits on it.
   */
  function pausingRunner() {
    let announce = (): void => {};
    let open = (): void => {};
    const locked = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const real = createTransactionRunner(pool);

    const runner: DatabaseTransactionRunner = {
      run: (work) =>
        real.run((executor) =>
          work({
            query: async (text, params) => {
              const result = await executor.query(text, params);
              if (/for update/i.test(text)) {
                announce();
                await gate;
              }
              return result;
            },
          } as DatabaseExecutor),
        ),
    };

    return { runner, locked, release: () => open() };
  }

  const settledWithin = async (promise: Promise<unknown>, ms: number): Promise<boolean> => {
    const marker = Symbol('pending');
    const raced = await Promise.race([
      promise,
      new Promise((resolve) => setTimeout(() => resolve(marker), ms)),
    ]);
    return raced !== marker;
  };

  it(
    'case A: the append waits for the lock, then takes the fresh artifact with it',
    { timeout: 15_000 },
    async () => {
      const problemId = await makeProblem();
      const paused = pausingRunner();

      const generating = serviceWith(paused.runner).generateArtifact(problemId);
      await paused.locked;

      // The append blocks on the held lock: its foreign-key check needs a
      // key-share on the locked Problem row. Measured, not assumed.
      const appending = memory.appendEvent({
        problemId,
        eventType: 'ATTEMPT',
        summary: 'landed while the artifact was committing',
        clientEventId: randomUUID() as ClientEventId,
      });
      expect(await settledWithin(appending, 150)).toBe(false);

      paused.release();
      // The generation commits its artifact first — at that moment the
      // fingerprint was true — and the append then commits and deletes it in
      // the same statement that records the Event.
      expect((await generating).kind).toBe('STORED');
      await appending;

      expect(await artifacts.getArtifact(problemId)).toBeUndefined();
    },
  );

  it('case B: the write commits first, and the old generation refuses to store', async () => {
    const problemId = await makeProblem();

    // A provider held open by the test: the generation has read its source
    // and is waiting on the embedding when the append lands.
    let enterEmbed = (): void => {};
    let releaseEmbed = (): void => {};
    const embedEntered = new Promise<void>((resolve) => {
      enterEmbed = resolve;
    });
    const embedGate = new Promise<void>((resolve) => {
      releaseEmbed = resolve;
    });
    const pausedProvider: EmbeddingProvider = {
      modelId: 'race-embedding-model',
      modelVersion: '1',
      dimensions: 3,
      embed: async () => {
        enterEmbed();
        await embedGate;
        return [0.5, -0.25, 0.125];
      },
    };
    const service = createRetrievalArtifactGenerationService(
      createRetrievalSummaryService(createRetrievalSummarySourceReader(pool, context), generator()),
      pausedProvider,
      createTransactionRunner(pool),
      context,
    );

    const generating = service.generateArtifact(problemId);
    await embedEntered;

    // The append commits while the generation is mid-provider. Nothing
    // blocks it — no lock is held during external calls, by design.
    await memory.appendEvent({
      problemId,
      eventType: 'DISCOVERY',
      summary: 'landed before the gate',
      clientEventId: randomUUID() as ClientEventId,
    });
    releaseEmbed();

    // At the locked gate the fingerprint the draft carries no longer
    // matches, so the rendering of the pre-append source goes nowhere.
    expect((await generating).kind).toBe('SOURCE_CHANGED');
    expect(await artifacts.getArtifact(problemId)).toBeUndefined();
  });

  it('case C: a generation after the write stores the current rendering', async () => {
    const problemId = await makeProblem();

    await memory.appendEvent({
      problemId,
      eventType: 'DISCOVERY',
      summary: 'the record settled before rendering',
      clientEventId: randomUUID() as ClientEventId,
    });

    const outcome = await serviceWith(createTransactionRunner(pool)).generateArtifact(problemId);
    expect(outcome.kind).toBe('STORED');

    const stored = await artifacts.getArtifact(problemId);
    expect(stored).toBeDefined();
    expect(stored?.sourceFingerprint.startsWith('retrieval-source-v1:')).toBe(true);
  });
});
