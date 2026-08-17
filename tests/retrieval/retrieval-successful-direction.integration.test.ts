/**
 * The directions a Memory's record supports calling successful, read back
 * against a real database.
 *
 * The property this suite exists to hold is a negative one: **nothing here
 * ever says a fix worked because a fix was recorded.** A `FIX` Event says
 * somebody tried something. Nothing links it to the Verification that later
 * passed, so a Problem with three fixes and one successful check does not say
 * which fix the check was about — and this stage reads no Event at all rather
 * than guess.
 *
 * What it does read is the stored search profile, which a summary generator
 * wrote after reading the whole canonical history, and which is refused at
 * generation time if it claims a direction the record does not support. That
 * gate is re-applied here against the record **as it is now**, so a record that
 * does not pass it stops offering directions its artifact still names.
 *
 * Two of the states below are not reachable through the supported surface —
 * `VERIFIED` is terminal, and the status service refuses it without a passing
 * check. They are written through the storage boundary on purpose: the point is
 * that this stage holds the gate itself rather than inheriting it from a
 * lifecycle rule enforced elsewhere, and a rule that can only be tested through
 * the layer that already enforces it has not been tested at all.
 *
 * Skipped without `DATABASE_URL`.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createRetrievalSuccessfulDirectionService,
  InvalidSuccessfulDirectionRequestError,
  REVALIDATION_CHECKS,
  type RetrievalSuccessfulDirectionService,
} from '../../src/app/index.js';
import { readDatabaseUrl } from '../../src/config/env.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import type { DatabaseExecutor } from '../../src/db/executor.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import type { ClientEventId } from '../../src/domain/client-event-id.js';
import type { ProblemStatus } from '../../src/domain/enums.js';
import { generateOwnerId, type OwnerContext, type OwnerId } from '../../src/domain/owner.js';
import type { ProblemId } from '../../src/domain/problem.js';
import type { ProjectId } from '../../src/domain/project.js';
import type { DeadEndAwareMemoryCandidate } from '../../src/domain/retrieval-result.js';
import type { StructuralFeatures } from '../../src/domain/retrieval-summary.js';
import { resolveOwnerContextFor } from '../../src/owner/context.js';
import {
  createMemoryRepository,
  createRetrievalArtifactRepository,
  createRetrievalSuccessfulDirectionReader,
  type MemoryRepository,
  type RetrievalArtifactRepository,
} from '../../src/repository/index.js';
import {
  createArtifactInspectionPolicy,
  createSecretDetectionPolicy,
  withSanitization,
} from '../../src/sanitization/index.js';

const databaseUrl = readDatabaseUrl();

const MODEL = { id: 'fixture-embedding-model', version: '2' } as const;

/** The steps each terminal status is reached through, from `INVESTIGATING`. */
const TRANSITIONS: Readonly<Record<string, readonly ProblemStatus[]>> = {
  FIX_CANDIDATE: ['FIX_CANDIDATE'],
  VERIFIED: ['FIX_CANDIDATE', 'VERIFIED'],
  CLOSED_UNRESOLVED: ['CLOSED_UNRESOLVED'],
  PAUSED: ['PAUSED'],
};

/** What worked, as the generator put it — not as any Event puts it. */
const DERIVED_DIRECTIONS = [
  'resolve configuration at runtime instead of during packaging',
  'fail the start-up when a required value is absent',
];

interface Actor {
  readonly ownerId: OwnerId;
  readonly context: OwnerContext;
  readonly memory: MemoryRepository;
  readonly artifacts: RetrievalArtifactRepository;
}

interface Seeded {
  readonly problemId: ProblemId;
  readonly projectId: ProjectId;
}

describe.skipIf(databaseUrl === undefined)('retrieval successful directions', () => {
  let pool: DatabasePool;
  const ownersCreated: OwnerId[] = [];

  async function makeActor(): Promise<Actor> {
    const ownerId = generateOwnerId();
    await insertOwnerIfAbsent(pool, ownerId);
    ownersCreated.push(ownerId);

    const context = await resolveOwnerContextFor(pool, ownerId);
    return {
      ownerId,
      context,
      memory: withSanitization(
        createMemoryRepository(pool, context),
        createSecretDetectionPolicy(),
      ),
      artifacts: withSanitization(
        createRetrievalArtifactRepository(pool, context),
        createArtifactInspectionPolicy(),
      ),
    };
  }

  /** Every statement the reader runs, so "one query" can be counted. */
  function counting(): DatabaseExecutor & { statements: string[] } {
    const statements: string[] = [];
    return {
      statements,
      query(text, values) {
        statements.push(text);
        return pool.query(text, values);
      },
    };
  }

  function serviceFor(
    actor: Actor,
    executor: DatabaseExecutor = pool,
  ): RetrievalSuccessfulDirectionService {
    return createRetrievalSuccessfulDirectionService(
      createRetrievalSuccessfulDirectionReader(executor, actor.context),
    );
  }

  const features = (directions: readonly string[]): StructuralFeatures => ({
    schema_version: '1',
    problem_domain: 'deployment',
    symptom_patterns: ['blank once deployed'],
    suspected_boundaries: ['configuration captured during build'],
    occurrence_conditions: ['only in the deployed environment'],
    successful_directions: [...directions],
    dead_end_directions: ['raising the build timeout'],
    environment_facts: ['node 22.12.0'],
  });

  /**
   * A Problem, and whatever of the three inputs the gate reads.
   *
   * The three are independent on purpose: status, a passing check, and an
   * artifact naming directions. Every combination is a real state.
   */
  async function seed(
    actor: Actor,
    options: {
      readonly projectId?: ProjectId;
      readonly status?: ProblemStatus;
      readonly verification?: boolean | 'failed';
      readonly directions?: readonly string[] | 'no-artifact';
      readonly fixEvents?: readonly string[];
    } = {},
  ): Promise<Seeded> {
    const projectId =
      options.projectId ??
      (await actor.memory.createProject({ projectName: `project ${randomUUID()}` })).projectId;
    const environment = await actor.memory.createEnvironment({
      projectId,
      snapshot: { runtime: 'node 22.12.0' },
    });
    const problem = await actor.memory.createProblem({
      projectId,
      environmentId: environment.environmentId,
      title: 'a seeded title',
      symptoms: 'seeded symptoms',
    });

    for (const summary of options.fixEvents ?? []) {
      await actor.memory.appendEvent({
        problemId: problem.problemId,
        eventType: 'FIX',
        summary,
        clientEventId: randomUUID() as ClientEventId,
      });
    }

    if (options.verification !== undefined) {
      await actor.memory.appendVerification({
        problemId: problem.problemId,
        verificationType: 'TEST',
        result: options.verification === true,
        summary: 'a recorded check',
        clientEventId: randomUUID() as ClientEventId,
      });
    }

    if (options.status !== undefined && options.status !== 'INVESTIGATING') {
      // Status moves through its own path, not `updateProblem` — the two are
      // deliberately separate so a status change cannot ride along with an
      // ordinary edit.
      for (const step of TRANSITIONS[options.status] ?? []) {
        const stored = await actor.memory.getProblem(problem.problemId);
        await actor.memory.updateProblemStatus(problem.problemId, stored?.version ?? 0, step);
      }
    }

    // Last, after every canonical write above: a status transition or an
    // append takes the stored artifact with it in its own statement, which is
    // the lifecycle rule rather than an inconvenience of this fixture. The
    // artifact a test reads through is the one a current record would have.
    const directions = options.directions ?? DERIVED_DIRECTIONS;
    if (directions !== 'no-artifact') {
      await actor.artifacts.upsertArtifact({
        problemId: problem.problemId,
        normalizedSummary: 'a summary about deployment',
        keywords: ['deployment'],
        structuralFeatures: features(directions),
        summaryGeneratorId: 'fixture-summary-generator',
        summaryGeneratorVersion: '1',
        embedding: [1, 0, 0],
        embeddingModel: MODEL.id,
        embeddingModelVersion: MODEL.version,
        sourceFingerprint: `retrieval-source-v1:${randomUUID().replace(/-/g, '')}`,
        generatedAt: new Date('2026-08-16T14:00:00.000Z'),
      });
    }

    return { problemId: problem.problemId, projectId };
  }

  const candidate = (seeded: Seeded, rankingRank: number): DeadEndAwareMemoryCandidate => ({
    ranking: {
      problemId: seeded.problemId,
      projectId: seeded.projectId,
      rankingRank,
      projectRelation: 'CURRENT_PROJECT',
      confidence: 'HIGH',
      freshness: 'CURRENT',
      suppressed: false,
      structuralScore: 0.5,
      hybridRank: rankingRank,
      matchedDimensions: ['symptom_patterns'],
    },
    revalidation: {
      historicalEnvironment: { runtime: 'node 22.12.0' },
      evidence: [],
      requiredChecks: REVALIDATION_CHECKS,
    },
    deadEndWarnings: [],
  });

  beforeAll(() => {
    pool = createPool(resolveDatabaseConfig({ nodeEnv: 'test', connectionTimeoutMillis: 5_000 }));
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

  describe('what the record supports', () => {
    it('offers the directions when the Problem is verified by a passing check', async () => {
      const owner = await makeActor();
      const seeded = await seed(owner, { status: 'VERIFIED', verification: true });

      const enriched = await serviceFor(owner).enrich([candidate(seeded, 1)]);

      expect(enriched[0]?.successfulDirections).toEqual(DERIVED_DIRECTIONS);
    });

    it('offers nothing while the Problem is still being investigated', async () => {
      const owner = await makeActor();
      const seeded = await seed(owner, { verification: true });

      // The artifact names directions and a check passed, but the record does
      // not yet call the Problem solved. Nothing here decides that it is.
      const enriched = await serviceFor(owner).enrich([candidate(seeded, 1)]);
      expect(enriched[0]?.successfulDirections).toEqual([]);
    });

    it('offers nothing for a Problem closed without a resolution', async () => {
      const owner = await makeActor();
      const seeded = await seed(owner, {
        status: 'CLOSED_UNRESOLVED',
        verification: true,
        fixEvents: ['tried moving the lookup', 'tried caching the value'],
      });

      const enriched = await serviceFor(owner).enrich([candidate(seeded, 1)]);
      expect(enriched[0]?.successfulDirections).toEqual([]);
    });

    it('offers nothing when no check has passed', async () => {
      const owner = await makeActor();
      const seeded = await seed(owner, { status: 'VERIFIED', verification: 'failed' });

      // `VERIFIED` alone is a label. The evidence gate asks for a Verification
      // that actually confirmed something, and one that failed is not it.
      //
      // This state is reachable on purpose: the rule that refuses `VERIFIED`
      // without a passing check lives in the status *service*, and the storage
      // boundary below it will take the transition. So a row can arrive here
      // saying `VERIFIED` with nothing behind it, and the gate this stage
      // applies itself is what has to hold.
      expect((await owner.memory.getProblem(seeded.problemId))?.status).toBe('VERIFIED');
      const enriched = await serviceFor(owner).enrich([candidate(seeded, 1)]);
      expect(enriched[0]?.successfulDirections).toEqual([]);
    });

    it('offers nothing when the profile names none', async () => {
      const owner = await makeActor();
      const seeded = await seed(owner, {
        status: 'VERIFIED',
        verification: true,
        directions: [],
      });

      const enriched = await serviceFor(owner).enrich([candidate(seeded, 1)]);
      expect(enriched[0]?.successfulDirections).toEqual([]);
    });

    it('keeps a Memory whose search profile has not been generated', async () => {
      const owner = await makeActor();
      const seeded = await seed(owner, {
        status: 'VERIFIED',
        verification: true,
        directions: 'no-artifact',
      });

      // The artifact is derived data. A Memory without one is still a Memory,
      // and dropping it from a search would let a regenerable file decide
      // whether somebody's experience exists.
      const enriched = await serviceFor(owner).enrich([candidate(seeded, 1)]);
      expect(enriched).toHaveLength(1);
      expect(enriched[0]?.successfulDirections).toEqual([]);
    });

    it('stops offering them once the stored status no longer passes the gate', async () => {
      const owner = await makeActor();
      const seeded = await seed(owner, { status: 'VERIFIED', verification: true });
      const service = serviceFor(owner);

      expect((await service.enrich([candidate(seeded, 1)]))[0]?.successfulDirections).toEqual(
        DERIVED_DIRECTIONS,
      );

      // Written below the storage boundary, because no supported surface
      // produces this state: `VERIFIED` is terminal, and since the lifecycle
      // work even the repository's own status write would take the artifact
      // with it. A raw SQL update is exactly the "write through a lower
      // layer" the read-time gate exists for — a persisted state the
      // generation-time rule no longer holds for, with an artifact still
      // naming directions.
      await pool.query(
        `update public.problems set status = 'INVESTIGATING'
          where owner_id = $1 and problem_id = $2`,
        [owner.ownerId, seeded.problemId],
      );

      // The artifact still names them — nothing rewrote it. The gate is asked
      // again of the record as it is now, which is the whole reason it is
      // asked again rather than trusted from generation time.
      const artifact = await owner.artifacts.getArtifact(seeded.problemId);
      expect(artifact?.structuralFeatures.successful_directions).toEqual(DERIVED_DIRECTIONS);
      expect((await service.enrich([candidate(seeded, 1)]))[0]?.successfulDirections).toEqual([]);
    });

    it('offers nothing from an artifact fingerprinted under another source schema', async () => {
      const owner = await makeActor();
      const seeded = await seed(owner, { status: 'VERIFIED', verification: true });
      const service = serviceFor(owner);
      expect((await service.enrich([candidate(seeded, 1)]))[0]?.successfulDirections).toEqual(
        DERIVED_DIRECTIONS,
      );

      // A lower-layer write plants what a future deployment would leave
      // behind: a rendering under a schema the readers no longer accept. It
      // answers as no artifact — an empty list — while the Memory itself
      // stays offered; a stale schema must not surface directions and must
      // not cost the candidate its place either.
      await pool.query(
        `update public.retrieval_artifacts
            set source_fingerprint = 'retrieval-source-v0:legacy'
          where owner_id = $1 and problem_id = $2`,
        [owner.ownerId, seeded.problemId],
      );

      const enriched = await service.enrich([candidate(seeded, 1)]);
      expect(enriched).toHaveLength(1);
      expect(enriched[0]?.successfulDirections).toEqual([]);
    });
  });

  describe('a recorded fix is not a verified one', () => {
    it('never turns FIX Events into directions', async () => {
      const owner = await makeActor();
      const seeded = await seed(owner, {
        status: 'VERIFIED',
        verification: true,
        fixEvents: [
          'moved the configuration lookup out of the packaging step',
          'added a retry around the failing call',
          'pinned the dependency to the previous minor version',
        ],
      });

      const enriched = await serviceFor(owner).enrich([candidate(seeded, 1)]);

      // Three fixes were recorded and one check passed. Nothing links them, so
      // reporting all three as successful would be a fabricated causal claim
      // and picking one would be a guess. What comes back is the generator's
      // reading, in its own words.
      expect(enriched[0]?.successfulDirections).toEqual(DERIVED_DIRECTIONS);
      const serialised = JSON.stringify(enriched[0]?.successfulDirections);
      for (const fix of ['packaging step', 'added a retry', 'pinned the dependency']) {
        expect(serialised.includes(fix), `a FIX Event surfaced as a direction`).toBe(false);
      }
    });

    it('offers directions for a verified Problem with no FIX Event at all', async () => {
      const owner = await makeActor();
      const seeded = await seed(owner, { status: 'VERIFIED', verification: true, fixEvents: [] });

      // Reaching `VERIFIED` needs a passing check, not a `FIX` Event. The
      // record supports the claim; whether an Event was written is a different
      // question and not this gate's.
      const enriched = await serviceFor(owner).enrich([candidate(seeded, 1)]);
      expect(enriched[0]?.successfulDirections).toEqual(DERIVED_DIRECTIONS);
    });

    it('carries no Event shape at all', async () => {
      const owner = await makeActor();
      const seeded = await seed(owner, { status: 'VERIFIED', verification: true });

      const directions = (await serviceFor(owner).enrich([candidate(seeded, 1)]))[0]
        ?.successfulDirections;

      // Plain strings. A summary, a result and a timestamp would dress a
      // generator's reading up as something somebody recorded at a moment.
      expect(directions?.every((direction) => typeof direction === 'string')).toBe(true);
      for (const shape of ['summary', 'createdAt', 'eventId', 'sourceAi', 'evidenceRef']) {
        expect(JSON.stringify(directions).includes(shape)).toBe(false);
      }
    });
  });

  describe('order, and how many', () => {
    it('keeps the profile’s own order and its repeats', async () => {
      const owner = await makeActor();
      const listed = ['third in the file', 'first alphabetically', 'third in the file'];
      const seeded = await seed(owner, {
        status: 'VERIFIED',
        verification: true,
        directions: listed,
      });

      // Returned as stored: not sorted, not de-duplicated, not capped. The
      // generator chose an order and repeating itself is its own statement.
      const enriched = await serviceFor(owner).enrich([candidate(seeded, 1)]);
      expect(enriched[0]?.successfulDirections).toEqual(listed);
    });

    it('gives each candidate its own', async () => {
      const owner = await makeActor();
      const first = await seed(owner, {
        status: 'VERIFIED',
        verification: true,
        directions: ['the first one'],
      });
      const second = await seed(owner, {
        projectId: first.projectId,
        status: 'VERIFIED',
        verification: true,
        directions: ['the second one'],
      });

      const enriched = await serviceFor(owner).enrich([candidate(first, 1), candidate(second, 2)]);

      expect(enriched[0]?.successfulDirections).toEqual(['the first one']);
      expect(enriched[1]?.successfulDirections).toEqual(['the second one']);
    });

    it('reads every candidate in one query', async () => {
      const owner = await makeActor();
      const first = await seed(owner, { status: 'VERIFIED', verification: true });
      const second = await seed(owner, {
        projectId: first.projectId,
        status: 'VERIFIED',
        verification: true,
      });
      const executor = counting();
      const service = serviceFor(owner, executor);
      executor.statements.length = 0;

      await service.enrich([candidate(first, 1), candidate(second, 2)]);

      expect(executor.statements).toHaveLength(1);
    });

    it('asks nothing when there is nothing to enrich', async () => {
      const owner = await makeActor();
      const executor = counting();

      expect(await serviceFor(owner, executor).enrich([])).toEqual([]);
      expect(executor.statements).toHaveLength(0);

      // And the service is what declines to ask, not just the statement below.
      let asked = 0;
      const service = createRetrievalSuccessfulDirectionService({
        ownerId: owner.ownerId,
        readForCandidates: () => {
          asked += 1;
          return Promise.resolve(new Map<ProblemId, readonly string[]>());
        },
      });
      expect(await service.enrich([])).toEqual([]);
      expect(asked).toBe(0);
    });
  });

  describe('a Memory that has since gone', () => {
    it('is dropped when it has been deleted', async () => {
      const owner = await makeActor();
      const kept = await seed(owner, { status: 'VERIFIED', verification: true });
      const doomed = await seed(owner, { projectId: kept.projectId });
      const stored = await owner.memory.getProblem(doomed.problemId);
      await owner.memory.deleteProblem(doomed.problemId, stored?.version ?? 0);

      const enriched = await serviceFor(owner).enrich([candidate(kept, 1), candidate(doomed, 2)]);
      expect(enriched.map((entry) => entry.ranking.problemId)).toEqual([kept.problemId]);
    });

    it('is dropped when automatic reading has been switched off', async () => {
      const owner = await makeActor();
      const kept = await seed(owner, { status: 'VERIFIED', verification: true });
      const off = await seed(owner, { projectId: kept.projectId });
      const stored = await owner.memory.getProblem(off.problemId);
      await owner.memory.updateProblem(off.problemId, stored?.version ?? 0, {
        memoryReadEnabled: false,
      });

      const enriched = await serviceFor(owner).enrich([candidate(kept, 1), candidate(off, 2)]);
      expect(enriched.map((entry) => entry.ranking.problemId)).toEqual([kept.problemId]);
    });

    it('answers the same way for another owner’s and for one that never existed', async () => {
      const owner = await makeActor();
      const stranger = await makeActor();
      const mine = await seed(owner, { status: 'VERIFIED', verification: true });
      const theirs = await seed(stranger, { status: 'VERIFIED', verification: true });

      const withStranger = await serviceFor(owner).enrich([
        candidate(mine, 1),
        candidate({ problemId: theirs.problemId, projectId: mine.projectId }, 2),
      ]);
      const withInvented = await serviceFor(owner).enrich([
        candidate(mine, 1),
        candidate({ problemId: randomUUID() as ProblemId, projectId: mine.projectId }, 2),
      ]);

      expect(JSON.stringify(withStranger)).toBe(JSON.stringify(withInvented));
    });

    it('closes up the positions and leaves everything earlier alone', async () => {
      const owner = await makeActor();
      const first = await seed(owner, { status: 'VERIFIED', verification: true });
      const doomed = await seed(owner, { projectId: first.projectId });
      const third = await seed(owner, {
        projectId: first.projectId,
        status: 'VERIFIED',
        verification: true,
      });
      const stored = await owner.memory.getProblem(doomed.problemId);
      await owner.memory.deleteProblem(doomed.problemId, stored?.version ?? 0);

      const withHybrid = (seeded: Seeded, rank: number, hybridRank: number) => {
        const base = candidate(seeded, rank);
        return { ...base, ranking: { ...base.ranking, hybridRank } };
      };
      const given = [withHybrid(first, 1, 3), withHybrid(doomed, 2, 6), withHybrid(third, 3, 9)];
      const enriched = await serviceFor(owner).enrich(given);

      expect(enriched.map((entry) => entry.ranking.rankingRank)).toEqual([1, 2]);
      expect(enriched.map((entry) => entry.ranking.hybridRank)).toEqual([3, 9]);
      expect(enriched.map((entry) => entry.ranking.structuralScore)).toEqual([0.5, 0.5]);
      expect(enriched[0]?.revalidation.requiredChecks).toEqual([...REVALIDATION_CHECKS]);
      expect(enriched[0]?.deadEndWarnings).toEqual([]);
      // And the caller's list is untouched.
      expect(given.map((entry) => entry.ranking.rankingRank)).toEqual([1, 2, 3]);
    });
  });

  describe('what the earlier stages decided', () => {
    it('carries the dead-end warnings through untouched', async () => {
      const owner = await makeActor();
      const seeded = await seed(owner, { status: 'VERIFIED', verification: true });
      const given: DeadEndAwareMemoryCandidate = {
        ...candidate(seeded, 1),
        deadEndWarnings: [
          {
            summary: 'raising the packaging timeout',
            result: 'still wrong afterwards',
            reason: null,
            evidenceRef: null,
            createdAt: new Date('2026-08-16T10:00:00.000Z'),
          },
        ],
      };

      // Non-empty on purpose: an assertion made against an already-empty list
      // would pass whether or not this stage preserved anything.
      const enriched = await serviceFor(owner).enrich([given]);
      expect(enriched[0]?.deadEndWarnings.map((warning) => warning.summary)).toEqual([
        'raising the packaging timeout',
      ]);
      expect(enriched[0]?.deadEndWarnings[0]?.result).toBe('still wrong afterwards');
      expect(enriched[0]?.successfulDirections).toEqual(DERIVED_DIRECTIONS);
    });
  });

  describe('when the read itself fails', () => {
    it('raises rather than answering as though nothing were supported', async () => {
      const owner = await makeActor();
      const seeded = await seed(owner, { status: 'VERIFIED', verification: true });
      const failing: DatabaseExecutor = {
        query: () => Promise.reject(new Error('connection terminated unexpectedly')),
      };

      await expect(serviceFor(owner, failing).enrich([candidate(seeded, 1)])).rejects.toThrow(
        'connection terminated unexpectedly',
      );
    });

    it('raises on a stored profile it cannot read, rather than emptying it', async () => {
      const owner = await makeActor();
      const seeded = await seed(owner, { status: 'VERIFIED', verification: true });
      // Written past the repository on purpose: this is the shape a future
      // schema change or an older writer could leave behind, and an empty list
      // would be this stage asserting something about it.
      await pool.query(
        `update public.retrieval_artifacts
            set structural_features = '{"schema_version":"1"}'::jsonb
          where owner_id = $1 and problem_id = $2`,
        [owner.ownerId, seeded.problemId],
      );

      let raised: unknown;
      try {
        await serviceFor(owner).enrich([candidate(seeded, 1)]);
      } catch (error) {
        raised = error;
      }
      expect(raised).toBeInstanceOf(Error);
      expect((raised as Error).message.includes(seeded.problemId)).toBe(false);
    });
  });

  describe('what it refuses', () => {
    it('refuses more candidates than a rerank can produce', async () => {
      const owner = await makeActor();
      const first = await seed(owner);
      const six = [first];
      for (let index = 0; index < 5; index += 1) {
        six.push(await seed(owner, { projectId: first.projectId }));
      }

      await expect(
        serviceFor(owner).enrich(six.map((seeded, index) => candidate(seeded, index + 1))),
      ).rejects.toBeInstanceOf(InvalidSuccessfulDirectionRequestError);
    });

    it('refuses the same Problem twice', async () => {
      const owner = await makeActor();
      const seeded = await seed(owner);

      await expect(
        serviceFor(owner).enrich([candidate(seeded, 1), candidate(seeded, 2)]),
      ).rejects.toBeInstanceOf(InvalidSuccessfulDirectionRequestError);
    });

    it('refuses positions that disagree with the order', async () => {
      const owner = await makeActor();
      const first = await seed(owner);
      const second = await seed(owner, { projectId: first.projectId });
      const executor = counting();

      await expect(
        serviceFor(owner, executor).enrich([candidate(first, 2), candidate(second, 1)]),
      ).rejects.toBeInstanceOf(InvalidSuccessfulDirectionRequestError);
      expect(executor.statements).toHaveLength(0);
    });

    it('names no identifier when it refuses', async () => {
      const owner = await makeActor();
      const seeded = await seed(owner);

      let raised: unknown;
      try {
        await serviceFor(owner).enrich([candidate(seeded, 1), candidate(seeded, 2)]);
      } catch (error) {
        raised = error;
      }
      expect((raised as Error).message.includes(seeded.problemId)).toBe(false);
    });
  });
});
