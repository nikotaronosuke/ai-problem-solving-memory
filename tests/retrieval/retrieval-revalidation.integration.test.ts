/**
 * What a Memory was recorded under, read back against a real database.
 *
 * Four things are proven here:
 *
 * **Each Memory gets its own history.** The conditions and checks attached to
 * a candidate must be that candidate's — mixing two up would tell somebody to
 * re-verify against an environment that belongs to a different Problem, which
 * is worse than saying nothing.
 *
 * **The snapshot is returned uninterpreted.** Whatever was recorded, nested or
 * flat or empty, comes back as it was stored. The server has no schema for it
 * and inventing one would mean guessing.
 *
 * **Failed checks are kept.** A verification that did not confirm anything is
 * evidence about what was tried, and dropping it would make every Memory read
 * as though everything attempted had worked.
 *
 * **A Memory that has gone is dropped, not returned hollow.** Deleted,
 * switched off and never-this-owner's are one answer, and the positions of
 * what remains close up.
 *
 * Skipped without `DATABASE_URL`.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createRetrievalRevalidationService,
  InvalidRevalidationRequestError,
  MissingHistoricalEnvironmentError,
  REVALIDATION_CHECKS,
  type RetrievalRevalidationService,
} from '../../src/app/index.js';
import { readDatabaseUrl } from '../../src/config/env.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import type { DatabaseExecutor } from '../../src/db/executor.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import type { ClientEventId } from '../../src/domain/client-event-id.js';
import type { Confidence, Freshness, VerificationType } from '../../src/domain/enums.js';
import { generateOwnerId, type OwnerContext, type OwnerId } from '../../src/domain/owner.js';
import type { ProblemId } from '../../src/domain/problem.js';
import type { ProjectId } from '../../src/domain/project.js';
import type { RankedMemoryCandidate } from '../../src/domain/retrieval-ranking.js';
import { resolveOwnerContextFor } from '../../src/owner/context.js';
import {
  createMemoryRepository,
  createRetrievalRevalidationReader,
  type MemoryRepository,
} from '../../src/repository/index.js';
import { createSecretDetectionPolicy, withSanitization } from '../../src/sanitization/index.js';

const databaseUrl = readDatabaseUrl();

interface Actor {
  readonly ownerId: OwnerId;
  readonly context: OwnerContext;
  readonly memory: MemoryRepository;
}

describe.skipIf(databaseUrl === undefined)('retrieval revalidation', () => {
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
    owner: Actor,
    executor: DatabaseExecutor = pool,
  ): RetrievalRevalidationService {
    return createRetrievalRevalidationService(
      createRetrievalRevalidationReader(executor, owner.context),
    );
  }

  /** A Problem, with a chosen Environment snapshot. */
  async function seed(
    owner: Actor,
    options: {
      readonly snapshot?: Record<string, unknown>;
      readonly projectId?: ProjectId;
    } = {},
  ): Promise<{ problemId: ProblemId; projectId: ProjectId }> {
    const projectId =
      options.projectId ??
      (await owner.memory.createProject({ projectName: `project ${randomUUID()}` })).projectId;
    const environment = await owner.memory.createEnvironment({
      projectId,
      snapshot: options.snapshot ?? { runtime: 'node 22.12.0' },
    });
    const problem = await owner.memory.createProblem({
      projectId,
      environmentId: environment.environmentId,
      title: 'a seeded title',
      symptoms: 'seeded symptoms',
    });
    return { problemId: problem.problemId, projectId };
  }

  async function verify(
    owner: Actor,
    problemId: ProblemId,
    options: {
      readonly verificationType?: VerificationType;
      readonly result?: boolean;
      readonly summary?: string;
      readonly evidenceRef?: string | null;
    } = {},
  ): Promise<void> {
    await owner.memory.appendVerification({
      problemId,
      verificationType: options.verificationType ?? 'TEST',
      result: options.result ?? true,
      summary: options.summary ?? 'the suite passed',
      ...(options.evidenceRef === undefined ? {} : { evidenceRef: options.evidenceRef }),
      clientEventId: randomUUID() as ClientEventId,
    });
  }

  const ranked = (
    problemId: ProblemId,
    projectId: ProjectId,
    rankingRank: number,
  ): RankedMemoryCandidate => ({
    problemId,
    projectId,
    rankingRank,
    projectRelation: 'CURRENT_PROJECT',
    confidence: 'HIGH',
    freshness: 'CURRENT',
    suppressed: false,
    structuralScore: 0.5,
    hybridRank: rankingRank,
    matchedDimensions: ['symptom_patterns'],
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

  describe('the conditions a Memory was recorded under', () => {
    it('gives each candidate its own', async () => {
      const owner = await makeActor();
      const first = await seed(owner, { snapshot: { runtime: 'node 20.11.0' } });
      const second = await seed(owner, { snapshot: { runtime: 'deno 2.0.0' } });

      const enriched = await serviceFor(owner).enrich([
        ranked(first.problemId, first.projectId, 1),
        ranked(second.problemId, second.projectId, 2),
      ]);

      // Mixing two up would tell somebody to re-verify against an environment
      // belonging to a different Problem.
      expect(enriched[0]?.revalidation.historicalEnvironment).toEqual({ runtime: 'node 20.11.0' });
      expect(enriched[1]?.revalidation.historicalEnvironment).toEqual({ runtime: 'deno 2.0.0' });
    });

    it('returns whatever was stored, uninterpreted', async () => {
      const owner = await makeActor();
      const snapshot = {
        runtime: 'node 22.12.0',
        framework: { name: 'fastify', version: '5.11.3' },
        flags: ['--experimental-strip-types'],
        deployment: { region: 'eu-west-1', replicas: 3 },
      };
      const seeded = await seed(owner, { snapshot });

      const enriched = await serviceFor(owner).enrich([
        ranked(seeded.problemId, seeded.projectId, 1),
      ]);

      // No schema, no extraction, no normalisation. Which keys appear is not
      // fixed, and picking values out would mean guessing at a shape that does
      // not exist.
      expect(enriched[0]?.revalidation.historicalEnvironment).toEqual(snapshot);
    });

    it('treats an empty snapshot as an ordinary one', async () => {
      const owner = await makeActor();
      const seeded = await seed(owner, { snapshot: {} });

      const enriched = await serviceFor(owner).enrich([
        ranked(seeded.problemId, seeded.projectId, 1),
      ]);

      // "The conditions were not recorded" is not "there were none", and is
      // certainly not a reason to withhold the Memory.
      expect(enriched).toHaveLength(1);
      expect(enriched[0]?.revalidation.historicalEnvironment).toEqual({});
    });

    it('reads every candidate in one query', async () => {
      const owner = await makeActor();
      const first = await seed(owner);
      const second = await seed(owner, { projectId: first.projectId });
      const third = await seed(owner, { projectId: first.projectId });
      const executor = counting();
      const service = serviceFor(owner, executor);
      executor.statements.length = 0;

      await service.enrich([
        ranked(first.problemId, first.projectId, 1),
        ranked(second.problemId, first.projectId, 2),
        ranked(third.problemId, first.projectId, 3),
      ]);

      expect(executor.statements).toHaveLength(1);
    });

    it('asks nothing when there is nothing to enrich', async () => {
      const owner = await makeActor();
      const executor = counting();

      expect(await serviceFor(owner, executor).enrich([])).toEqual([]);
      expect(executor.statements).toHaveLength(0);
    });
  });

  describe('the checks that were performed', () => {
    it('keeps the ones that failed as well as the ones that passed', async () => {
      const owner = await makeActor();
      const seeded = await seed(owner);
      await verify(owner, seeded.problemId, { result: false, summary: 'the suite still failed' });
      await verify(owner, seeded.problemId, { result: true, summary: 'the suite passed' });

      const enriched = await serviceFor(owner).enrich([
        ranked(seeded.problemId, seeded.projectId, 1),
      ]);

      // A check that failed says what was tried and did not settle the matter,
      // which is exactly what stops it being repeated.
      const evidence = enriched[0]?.revalidation.evidence ?? [];
      expect(evidence.map((entry) => entry.result)).toEqual([false, true]);
      expect(evidence.map((entry) => entry.summary)).toEqual([
        'the suite still failed',
        'the suite passed',
      ]);
    });

    it('returns them oldest first', async () => {
      const owner = await makeActor();
      const seeded = await seed(owner);
      for (const summary of ['first', 'second', 'third', 'fourth']) {
        await verify(owner, seeded.problemId, { summary });
      }

      const enriched = await serviceFor(owner).enrich([
        ranked(seeded.problemId, seeded.projectId, 1),
      ]);

      expect(enriched[0]?.revalidation.evidence.map((entry) => entry.summary)).toEqual([
        'first',
        'second',
        'third',
        'fourth',
      ]);
    });

    it('carries the kind, the reference and the moment', async () => {
      const owner = await makeActor();
      const seeded = await seed(owner);
      await verify(owner, seeded.problemId, {
        verificationType: 'REAL_DEVICE',
        result: true,
        summary: 'confirmed on the device',
        evidenceRef: 'https://example.invalid/runs/1234',
      });

      const evidence = (
        await serviceFor(owner).enrich([ranked(seeded.problemId, seeded.projectId, 1)])
      )[0]?.revalidation.evidence[0];

      expect(evidence?.verificationType).toBe('REAL_DEVICE');
      expect(evidence?.result).toBe(true);
      expect(evidence?.summary).toBe('confirmed on the device');
      // A reference, returned as one. Nothing fetched it, resolved it, or
      // checked that it still exists — whether it does is a question about
      // now, which is the caller's to answer.
      expect(evidence?.evidenceRef).toBe('https://example.invalid/runs/1234');
      expect(evidence?.createdAt).toBeInstanceOf(Date);
    });

    it('accepts a check with no reference', async () => {
      const owner = await makeActor();
      const seeded = await seed(owner);
      await verify(owner, seeded.problemId, { evidenceRef: null });

      const evidence = (
        await serviceFor(owner).enrich([ranked(seeded.problemId, seeded.projectId, 1)])
      )[0]?.revalidation.evidence[0];

      expect(evidence?.evidenceRef).toBeNull();
      expect(evidence?.summary).toBe('the suite passed');
    });

    it('names nothing a re-check does not need', async () => {
      const owner = await makeActor();
      const seeded = await seed(owner);
      await verify(owner, seeded.problemId);

      const evidence = (
        await serviceFor(owner).enrich([ranked(seeded.problemId, seeded.projectId, 1)])
      )[0]?.revalidation.evidence[0];

      // Its own identifier, its owner, its Problem, who confirmed it and the
      // key it arrived under all answer questions nobody is asking here.
      expect(Object.keys(evidence ?? {}).sort()).toEqual([
        'createdAt',
        'evidenceRef',
        'result',
        'summary',
        'verificationType',
      ]);
    });

    it('returns an empty list for a Problem nobody verified', async () => {
      const owner = await makeActor();
      const seeded = await seed(owner);

      const enriched = await serviceFor(owner).enrich([
        ranked(seeded.problemId, seeded.projectId, 1),
      ]);

      // Most Problems are never verified. That is not a reason to withhold
      // one, and it is a different thing from having no conditions recorded.
      expect(enriched).toHaveLength(1);
      expect(enriched[0]?.revalidation.evidence).toEqual([]);
      expect(enriched[0]?.revalidation.historicalEnvironment).toEqual({ runtime: 'node 22.12.0' });
    });

    it('keeps one candidate’s checks off another', async () => {
      const owner = await makeActor();
      const verified = await seed(owner);
      const bare = await seed(owner, { projectId: verified.projectId });
      await verify(owner, verified.problemId, { summary: 'only this one' });

      const enriched = await serviceFor(owner).enrich([
        ranked(verified.problemId, verified.projectId, 1),
        ranked(bare.problemId, verified.projectId, 2),
      ]);

      expect(enriched[0]?.revalidation.evidence).toHaveLength(1);
      expect(enriched[1]?.revalidation.evidence).toEqual([]);
    });
  });

  describe('what must be re-established', () => {
    const everyFreshness: Freshness[] = ['CURRENT', 'STALE_UNKNOWN', 'SUPERSEDED', 'INVALID'];

    it.each(everyFreshness)('is the same four for a %s Memory', async (freshness) => {
      const owner = await makeActor();
      const seeded = await seed(owner);

      const enriched = await serviceFor(owner).enrich([
        { ...ranked(seeded.problemId, seeded.projectId, 1), freshness },
      ]);

      // `CURRENT` means nobody has marked the record superseded. It is a
      // statement about the record rather than about the world, and the
      // specification says the confirmation is not skipped for a trusted or an
      // important Memory either.
      expect(enriched[0]?.revalidation.requiredChecks).toEqual([
        'CURRENT_CODE',
        'CURRENT_ENVIRONMENT',
        'RELEVANT_VERSION',
        'OFFICIAL_SPEC',
      ]);
    });

    it.each(['HIGH', 'MEDIUM', 'LOW', 'CONFLICTED'] as Confidence[])(
      'is the same four for a %s Memory',
      async (confidence) => {
        const owner = await makeActor();
        const seeded = await seed(owner);

        const enriched = await serviceFor(owner).enrich([
          { ...ranked(seeded.problemId, seeded.projectId, 1), confidence },
        ]);

        expect(enriched[0]?.revalidation.requiredChecks).toHaveLength(4);
      },
    );

    it('is the same four however close the Memory is', async () => {
      const owner = await makeActor();
      const seeded = await seed(owner);

      for (const projectRelation of [
        'CURRENT_PROJECT',
        'SAME_TECH_OTHER_PROJECT',
        'OTHER_TECH',
        'UNKNOWN_TECH',
      ] as const) {
        const enriched = await serviceFor(owner).enrich([
          { ...ranked(seeded.problemId, seeded.projectId, 1), projectRelation },
        ]);
        expect(enriched[0]?.revalidation.requiredChecks).toEqual([...REVALIDATION_CHECKS]);
      }
    });
  });

  describe('a Memory that has since gone', () => {
    it('is dropped when it has been deleted', async () => {
      const owner = await makeActor();
      const kept = await seed(owner);
      const doomed = await seed(owner, { projectId: kept.projectId });

      const problem = await owner.memory.getProblem(doomed.problemId);
      await owner.memory.deleteProblem(doomed.problemId, problem?.version ?? 0);

      const enriched = await serviceFor(owner).enrich([
        ranked(kept.problemId, kept.projectId, 1),
        ranked(doomed.problemId, kept.projectId, 2),
      ]);

      expect(enriched.map((entry) => entry.ranking.problemId)).toEqual([kept.problemId]);
    });

    it('is dropped when automatic reading has been switched off', async () => {
      const owner = await makeActor();
      const kept = await seed(owner);
      const off = await seed(owner, { projectId: kept.projectId });

      const problem = await owner.memory.getProblem(off.problemId);
      await owner.memory.updateProblem(off.problemId, problem?.version ?? 0, {
        memoryReadEnabled: false,
      });

      const enriched = await serviceFor(owner).enrich([
        ranked(kept.problemId, kept.projectId, 1),
        ranked(off.problemId, kept.projectId, 2),
      ]);

      expect(enriched.map((entry) => entry.ranking.problemId)).toEqual([kept.problemId]);
    });

    it('answers the same way for another owner’s and for one that never existed', async () => {
      const owner = await makeActor();
      const stranger = await makeActor();
      const mine = await seed(owner);
      const theirs = await seed(stranger);

      const withStranger = await serviceFor(owner).enrich([
        ranked(mine.problemId, mine.projectId, 1),
        ranked(theirs.problemId, mine.projectId, 2),
      ]);
      const withInvented = await serviceFor(owner).enrich([
        ranked(mine.problemId, mine.projectId, 1),
        ranked(randomUUID() as ProblemId, mine.projectId, 2),
      ]);

      // A search must not be usable to learn that somebody else's Problem
      // exists.
      expect(JSON.stringify(withStranger)).toBe(JSON.stringify(withInvented));
    });

    it('is never returned with an empty history instead', async () => {
      const owner = await makeActor();
      const kept = await seed(owner);
      const doomed = await seed(owner, { projectId: kept.projectId });
      const problem = await owner.memory.getProblem(doomed.problemId);
      await owner.memory.deleteProblem(doomed.problemId, problem?.version ?? 0);

      const enriched = await serviceFor(owner).enrich([
        ranked(kept.problemId, kept.projectId, 1),
        ranked(doomed.problemId, kept.projectId, 2),
      ]);

      // Offering it with no conditions would imply it had none, which is a
      // different and false statement.
      expect(enriched).toHaveLength(1);
    });
  });

  describe('the positions of what is left', () => {
    it('closes up when one in the middle drops out', async () => {
      const owner = await makeActor();
      const first = await seed(owner);
      const doomed = await seed(owner, { projectId: first.projectId });
      const third = await seed(owner, { projectId: first.projectId });

      const problem = await owner.memory.getProblem(doomed.problemId);
      await owner.memory.deleteProblem(doomed.problemId, problem?.version ?? 0);

      const enriched = await serviceFor(owner).enrich([
        ranked(first.problemId, first.projectId, 1),
        ranked(doomed.problemId, first.projectId, 2),
        ranked(third.problemId, first.projectId, 3),
      ]);

      // `rankingRank` is where a candidate sits in the list actually offered,
      // so it renumbers.
      expect(enriched.map((entry) => entry.ranking.rankingRank)).toEqual([1, 2]);
      expect(enriched.map((entry) => entry.ranking.problemId)).toEqual([
        first.problemId,
        third.problemId,
      ]);
    });

    it('leaves the earlier stage’s positions alone', async () => {
      const owner = await makeActor();
      const first = await seed(owner);
      const doomed = await seed(owner, { projectId: first.projectId });
      const third = await seed(owner, { projectId: first.projectId });

      const problem = await owner.memory.getProblem(doomed.problemId);
      await owner.memory.deleteProblem(doomed.problemId, problem?.version ?? 0);

      const enriched = await serviceFor(owner).enrich([
        { ...ranked(first.problemId, first.projectId, 1), hybridRank: 1 },
        { ...ranked(doomed.problemId, first.projectId, 2), hybridRank: 4 },
        { ...ranked(third.problemId, first.projectId, 3), hybridRank: 7 },
      ]);

      // `hybridRank` records where the first retrieval stage put a candidate
      // and keeps its gaps. Two different facts, two fields.
      expect(enriched.map((entry) => entry.ranking.hybridRank)).toEqual([1, 7]);
    });

    it('keeps the order it was given', async () => {
      const owner = await makeActor();
      const first = await seed(owner);
      const second = await seed(owner, { projectId: first.projectId });
      const third = await seed(owner, { projectId: first.projectId });

      const enriched = await serviceFor(owner).enrich([
        ranked(third.problemId, first.projectId, 1),
        ranked(first.problemId, first.projectId, 2),
        ranked(second.problemId, first.projectId, 3),
      ]);

      // Ranking decided the order; nothing here re-sorts by whatever the
      // database happened to return.
      expect(enriched.map((entry) => entry.ranking.problemId)).toEqual([
        third.problemId,
        first.problemId,
        second.problemId,
      ]);
    });

    it('carries the rest of the ranking through untouched', async () => {
      const owner = await makeActor();
      const seeded = await seed(owner);
      const candidate = {
        ...ranked(seeded.problemId, seeded.projectId, 1),
        confidence: 'MEDIUM' as Confidence,
        freshness: 'SUPERSEDED' as Freshness,
        suppressed: true,
        structuralScore: 0.25,
        matchedDimensions: ['symptom_patterns', 'environment_facts'] as const,
      };

      const enriched = await serviceFor(owner).enrich([candidate]);

      expect(enriched[0]?.ranking.confidence).toBe('MEDIUM');
      expect(enriched[0]?.ranking.freshness).toBe('SUPERSEDED');
      expect(enriched[0]?.ranking.suppressed).toBe(true);
      expect(enriched[0]?.ranking.structuralScore).toBe(0.25);
      expect(enriched[0]?.ranking.matchedDimensions).toEqual([
        'symptom_patterns',
        'environment_facts',
      ]);
    });

    it('leaves the list it was given alone', async () => {
      const owner = await makeActor();
      const first = await seed(owner);
      const doomed = await seed(owner, { projectId: first.projectId });
      const problem = await owner.memory.getProblem(doomed.problemId);
      await owner.memory.deleteProblem(doomed.problemId, problem?.version ?? 0);

      const given = [
        ranked(first.problemId, first.projectId, 1),
        ranked(doomed.problemId, first.projectId, 2),
      ];
      const enriched = await serviceFor(owner).enrich(given);

      expect(given).toHaveLength(2);
      expect(given[0]?.rankingRank).toBe(1);
      // And the copy does not share the dimension array with the original.
      expect(enriched[0]?.ranking.matchedDimensions).not.toBe(given[0]?.matchedDimensions);
    });
  });

  describe('what it refuses', () => {
    it('refuses more candidates than a rerank can produce', async () => {
      const owner = await makeActor();
      const first = await seed(owner);
      // Six distinct Problems, so the count is the only thing wrong here — six
      // copies of one would be refused for appearing twice instead, and would
      // prove nothing about the bound.
      const six = [first];
      for (let index = 0; index < 5; index += 1) {
        six.push(await seed(owner, { projectId: first.projectId }));
      }

      await expect(
        serviceFor(owner).enrich(
          six.map((seeded, index) => ranked(seeded.problemId, seeded.projectId, index + 1)),
        ),
      ).rejects.toBeInstanceOf(InvalidRevalidationRequestError);
    });

    it('refuses the same Problem twice', async () => {
      const owner = await makeActor();
      const seeded = await seed(owner);

      await expect(
        serviceFor(owner).enrich([
          ranked(seeded.problemId, seeded.projectId, 1),
          ranked(seeded.problemId, seeded.projectId, 2),
        ]),
      ).rejects.toBeInstanceOf(InvalidRevalidationRequestError);
    });

    describe('positions that disagree with the order', () => {
      /** Every rejection here must cost nothing — no query, no round trip. */
      async function refuses(
        owner: Actor,
        candidates: readonly RankedMemoryCandidate[],
      ): Promise<void> {
        const executor = counting();
        await expect(serviceFor(owner, executor).enrich(candidates)).rejects.toBeInstanceOf(
          InvalidRevalidationRequestError,
        );
        expect(executor.statements).toHaveLength(0);
      }

      it('accepts a list that is already 1, 2, 3', async () => {
        const owner = await makeActor();
        const first = await seed(owner);
        const second = await seed(owner, { projectId: first.projectId });

        const enriched = await serviceFor(owner).enrich([
          ranked(first.problemId, first.projectId, 1),
          ranked(second.problemId, first.projectId, 2),
        ]);
        expect(enriched).toHaveLength(2);
      });

      it('refuses a gap in the positions', async () => {
        // Renumbering below reads a candidate's place in the array, which is
        // only correct if the array *was* the order. A gapped list would be
        // silently renumbered into something that agreed with neither, and
        // the result would look perfectly ordinary.
        const owner = await makeActor();
        const first = await seed(owner);
        const second = await seed(owner, { projectId: first.projectId });

        await refuses(owner, [
          ranked(first.problemId, first.projectId, 1),
          ranked(second.problemId, first.projectId, 3),
        ]);
      });

      it('refuses positions that disagree with the order they arrived in', async () => {
        const owner = await makeActor();
        const first = await seed(owner);
        const second = await seed(owner, { projectId: first.projectId });

        await refuses(owner, [
          ranked(first.problemId, first.projectId, 2),
          ranked(second.problemId, first.projectId, 1),
        ]);
      });

      it('refuses a list that does not start at one', async () => {
        const owner = await makeActor();
        const seeded = await seed(owner);

        await refuses(owner, [ranked(seeded.problemId, seeded.projectId, 0)]);
        await refuses(owner, [ranked(seeded.problemId, seeded.projectId, 2)]);
      });

      it.each([
        // 1.4 rather than only 1.5, so "exactly one" is distinguishable from
        // "near enough to round to one". A position is an index into a list;
        // there is no such thing as approximately the second item.
        ['fractional', 1.4],
        ['fractional the other way', 1.5],
        ['not a number', Number.NaN],
        ['not finite', Number.POSITIVE_INFINITY],
      ])('refuses a position that is %s', async (_label, rankingRank) => {
        // The type says these are numbers from the ranking stage; this
        // function is exported, so that is a claim rather than a fact. The
        // comparison against an integer index rejects all of them on its own.
        const owner = await makeActor();
        const seeded = await seed(owner);

        await refuses(owner, [ranked(seeded.problemId, seeded.projectId, rankingRank)]);
      });

      it('still renumbers when a candidate drops out', async () => {
        // The rule is about the input, not the output. A well-formed 1, 2, 3
        // whose second Memory has since gone still comes back as 1, 2.
        const owner = await makeActor();
        const first = await seed(owner);
        const doomed = await seed(owner, { projectId: first.projectId });
        const third = await seed(owner, { projectId: first.projectId });
        const problem = await owner.memory.getProblem(doomed.problemId);
        await owner.memory.deleteProblem(doomed.problemId, problem?.version ?? 0);

        const enriched = await serviceFor(owner).enrich([
          { ...ranked(first.problemId, first.projectId, 1), hybridRank: 2 },
          { ...ranked(doomed.problemId, first.projectId, 2), hybridRank: 5 },
          { ...ranked(third.problemId, first.projectId, 3), hybridRank: 9 },
        ]);

        expect(enriched.map((entry) => entry.ranking.rankingRank)).toEqual([1, 2]);
        expect(enriched.map((entry) => entry.ranking.hybridRank)).toEqual([2, 9]);
      });

      it('names no position when it refuses', async () => {
        const owner = await makeActor();
        const seeded = await seed(owner);

        let raised: unknown;
        try {
          await serviceFor(owner).enrich([ranked(seeded.problemId, seeded.projectId, 7)]);
        } catch (error) {
          raised = error;
        }
        const message = (raised as Error).message;
        expect(message.includes('7'), 'the refusal named a position').toBe(false);
        expect(message.includes(seeded.problemId), 'the refusal named a Problem').toBe(false);
      });
    });

    it('names no identifier when it refuses', async () => {
      const owner = await makeActor();
      const seeded = await seed(owner);

      let raised: unknown;
      try {
        await serviceFor(owner).enrich([
          ranked(seeded.problemId, seeded.projectId, 1),
          ranked(seeded.problemId, seeded.projectId, 2),
        ]);
      } catch (error) {
        raised = error;
      }
      expect((raised as Error).message.includes(seeded.problemId)).toBe(false);
    });

    it('cannot be given a readable Problem with no conditions', async () => {
      const owner = await makeActor();
      const seeded = await seed(owner);

      // The strongest form of the argument: the state cannot be produced. The
      // column is not null and the composite foreign key requires the
      // Environment to exist under the same owner and Project, so the database
      // refuses the write outright.
      await expect(
        pool.query(
          `update public.problems set environment_id = $3 where owner_id = $1 and problem_id = $2`,
          [owner.ownerId, seeded.problemId, randomUUID()],
        ),
      ).rejects.toThrow();
    });

    it('raises rather than dropping a readable Problem with no conditions', async () => {
      const owner = await makeActor();
      const seeded = await seed(owner);

      // Since the database cannot produce that state, the reader is driven
      // directly. This is not a hypothetical worth guarding for its own sake —
      // it is that short results are *ordinary* here, so a Problem arriving
      // without its conditions must not be swallowed by the same code path
      // that quietly drops deleted ones. A broken database hiding inside a
      // normal-looking short answer would never be noticed.
      const service = createRetrievalRevalidationService({
        ownerId: owner.ownerId,
        readForCandidates: (problemIds) =>
          Promise.resolve(
            new Map(
              problemIds.map((problemId) => [
                problemId,
                { problemId, historicalEnvironment: undefined, evidence: [] },
              ]),
            ),
          ),
      });

      let raised: unknown;
      try {
        await service.enrich([ranked(seeded.problemId, seeded.projectId, 1)]);
      } catch (error) {
        raised = error;
      }

      expect(raised).toBeInstanceOf(MissingHistoricalEnvironmentError);
      const message = (raised as Error).message;
      for (const absent of [owner.ownerId, seeded.problemId, seeded.projectId]) {
        expect(message.includes(absent), 'the refusal named an identifier').toBe(false);
      }
    });
  });
});
