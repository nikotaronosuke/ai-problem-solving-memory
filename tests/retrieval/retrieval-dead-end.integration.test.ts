/**
 * Where a Memory already knows a direction does not lead, read back against a
 * real database.
 *
 * The property that matters most here is a negative one: **nothing a dead end
 * says removes, reorders or forbids anything**. A candidate with ten of them
 * comes back exactly where ranking put it, with no field saying it may not be
 * retried — because a direction that failed under one runtime or one library
 * version may be right under another, and the record cannot tell which.
 *
 * Two more things are pinned. The warnings come from the Events that recorded
 * them, not from the regenerable search profile that happens to carry a
 * similar-looking list. And a later correction does not cancel one: nothing
 * links the two Events, so deciding that one retracts another would mean
 * reading free text and guessing.
 *
 * Skipped without `DATABASE_URL`.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createRetrievalDeadEndService,
  InvalidDeadEndRequestError,
  REVALIDATION_CHECKS,
  type RetrievalDeadEndService,
} from '../../src/app/index.js';
import { readDatabaseUrl } from '../../src/config/env.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import type { DatabaseExecutor } from '../../src/db/executor.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import type { ClientEventId } from '../../src/domain/client-event-id.js';
import type { EventType, Freshness } from '../../src/domain/enums.js';
import { generateOwnerId, type OwnerContext, type OwnerId } from '../../src/domain/owner.js';
import type { ProblemId } from '../../src/domain/problem.js';
import type { ProjectId } from '../../src/domain/project.js';
import type { DeadEndWarning } from '../../src/domain/retrieval-dead-end.js';
import type { RevalidatedMemoryCandidate } from '../../src/domain/retrieval-result.js';
import { resolveOwnerContextFor } from '../../src/owner/context.js';
import {
  createMemoryRepository,
  createRetrievalDeadEndReader,
  type MemoryRepository,
} from '../../src/repository/index.js';
import { createSecretDetectionPolicy, withSanitization } from '../../src/sanitization/index.js';

const databaseUrl = readDatabaseUrl();

interface Actor {
  readonly ownerId: OwnerId;
  readonly context: OwnerContext;
  readonly memory: MemoryRepository;
}

describe.skipIf(databaseUrl === undefined)('retrieval dead ends', () => {
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

  function serviceFor(owner: Actor, executor: DatabaseExecutor = pool): RetrievalDeadEndService {
    return createRetrievalDeadEndService(createRetrievalDeadEndReader(executor, owner.context));
  }

  async function seed(
    owner: Actor,
    options: { readonly projectId?: ProjectId } = {},
  ): Promise<{ problemId: ProblemId; projectId: ProjectId }> {
    const projectId =
      options.projectId ??
      (await owner.memory.createProject({ projectName: `project ${randomUUID()}` })).projectId;
    const environment = await owner.memory.createEnvironment({
      projectId,
      snapshot: { runtime: 'node 22.12.0' },
    });
    const problem = await owner.memory.createProblem({
      projectId,
      environmentId: environment.environmentId,
      title: 'a seeded title',
      symptoms: 'seeded symptoms',
    });
    return { problemId: problem.problemId, projectId };
  }

  async function append(
    owner: Actor,
    problemId: ProblemId,
    options: {
      readonly eventType?: EventType;
      readonly summary?: string;
      readonly result?: string | null;
      readonly reason?: string | null;
      readonly evidenceRef?: string | null;
    } = {},
  ): Promise<void> {
    await owner.memory.appendEvent({
      problemId,
      eventType: options.eventType ?? 'DEAD_END',
      summary: options.summary ?? 'raising the timeout did not help',
      ...(options.result === undefined ? {} : { result: options.result }),
      ...(options.reason === undefined ? {} : { reason: options.reason }),
      ...(options.evidenceRef === undefined ? {} : { evidenceRef: options.evidenceRef }),
      clientEventId: randomUUID() as ClientEventId,
    });
  }

  const revalidated = (
    problemId: ProblemId,
    projectId: ProjectId,
    rankingRank: number,
  ): RevalidatedMemoryCandidate => ({
    ranking: {
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
    },
    revalidation: {
      historicalEnvironment: { runtime: 'node 22.12.0' },
      evidence: [],
      requiredChecks: REVALIDATION_CHECKS,
    },
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

  describe('what is recorded as a dead end', () => {
    it('comes back with what was tried, what happened and why', async () => {
      const owner = await makeActor();
      const seeded = await seed(owner);
      await append(owner, seeded.problemId, {
        summary: 'raising the timeout',
        result: 'the request still failed at the same point',
        reason: 'the timeout was never the limiting factor',
        evidenceRef: 'https://example.invalid/runs/99',
      });

      const enriched = await serviceFor(owner).enrich([
        revalidated(seeded.problemId, seeded.projectId, 1),
      ]);

      const warning = enriched[0]?.deadEndWarnings[0];
      expect(warning?.summary).toBe('raising the timeout');
      expect(warning?.result).toBe('the request still failed at the same point');
      expect(warning?.reason).toBe('the timeout was never the limiting factor');
      // A reference, returned as one. Nothing followed it.
      expect(warning?.evidenceRef).toBe('https://example.invalid/runs/99');
      expect(warning?.createdAt).toBeInstanceOf(Date);
    });

    it('leaves absent fields absent', async () => {
      const owner = await makeActor();
      const seeded = await seed(owner);
      await append(owner, seeded.problemId, { summary: 'only a summary' });

      const warning = (
        await serviceFor(owner).enrich([revalidated(seeded.problemId, seeded.projectId, 1)])
      )[0]?.deadEndWarnings[0];

      // An attempt may have no result worth stating separately and no reason
      // beyond the attempt itself. Nothing is filled in.
      expect(warning?.summary).toBe('only a summary');
      expect(warning?.result).toBeNull();
      expect(warning?.reason).toBeNull();
      expect(warning?.evidenceRef).toBeNull();
    });

    it('names nothing a reader does not need', async () => {
      const owner = await makeActor();
      const seeded = await seed(owner);
      await append(owner, seeded.problemId);

      const warning = (
        await serviceFor(owner).enrich([revalidated(seeded.problemId, seeded.projectId, 1)])
      )[0]?.deadEndWarnings[0];

      // The Event's own id, its owner, its Problem — already named by the
      // candidate — the key it arrived under, and which assistant hit it.
      expect(Object.keys(warning ?? {}).sort()).toEqual([
        'createdAt',
        'evidenceRef',
        'reason',
        'result',
        'summary',
      ]);
    });

    it.each([['HYPOTHESIS'], ['ATTEMPT'], ['DISCOVERY'], ['FIX'], ['USER_CORRECTION']] as [
      EventType,
    ][])('does not treat a %s as one', async (eventType) => {
      const owner = await makeActor();
      const seeded = await seed(owner);
      await append(owner, seeded.problemId, { eventType, summary: 'something else happened' });

      const enriched = await serviceFor(owner).enrich([
        revalidated(seeded.problemId, seeded.projectId, 1),
      ]);
      expect(enriched[0]?.deadEndWarnings).toEqual([]);
    });

    it('returns an empty list for a Memory with none recorded', async () => {
      const owner = await makeActor();
      const seeded = await seed(owner);

      const enriched = await serviceFor(owner).enrich([
        revalidated(seeded.problemId, seeded.projectId, 1),
      ]);

      // Not a recommendation: an unexplored direction and one nobody wrote
      // down look identical from here.
      expect(enriched).toHaveLength(1);
      expect(enriched[0]?.deadEndWarnings).toEqual([]);
    });

    it('gives each candidate its own', async () => {
      const owner = await makeActor();
      const first = await seed(owner);
      const second = await seed(owner, { projectId: first.projectId });
      await append(owner, first.problemId, { summary: 'the first one' });
      await append(owner, second.problemId, { summary: 'the second one' });

      const enriched = await serviceFor(owner).enrich([
        revalidated(first.problemId, first.projectId, 1),
        revalidated(second.problemId, first.projectId, 2),
      ]);

      expect(enriched[0]?.deadEndWarnings.map((entry) => entry.summary)).toEqual(['the first one']);
      expect(enriched[1]?.deadEndWarnings.map((entry) => entry.summary)).toEqual([
        'the second one',
      ]);
    });

    it('reads every candidate in one query', async () => {
      const owner = await makeActor();
      const first = await seed(owner);
      const second = await seed(owner, { projectId: first.projectId });
      const executor = counting();
      const service = serviceFor(owner, executor);
      executor.statements.length = 0;

      await service.enrich([
        revalidated(first.problemId, first.projectId, 1),
        revalidated(second.problemId, first.projectId, 2),
      ]);

      expect(executor.statements).toHaveLength(1);
    });

    it('asks nothing when there is nothing to enrich', async () => {
      const owner = await makeActor();
      const executor = counting();

      expect(await serviceFor(owner, executor).enrich([])).toEqual([]);
      expect(executor.statements).toHaveLength(0);

      // And the service is what declines to ask, not just the statement below
      // it. Two gates, and this is the one that would otherwise be the reason
      // an empty list still cost a round trip.
      let asked = 0;
      const service = createRetrievalDeadEndService({
        ownerId: owner.ownerId,
        readForCandidates: () => {
          asked += 1;
          return Promise.resolve(new Map<ProblemId, DeadEndWarning[]>());
        },
      });
      expect(await service.enrich([])).toEqual([]);
      expect(asked).toBe(0);
    });

    it('names in its answer exactly the Memories it can still see', async () => {
      const owner = await makeActor();
      const kept = await seed(owner);
      const doomed = await seed(owner, { projectId: kept.projectId });
      const problem = await owner.memory.getProblem(doomed.problemId);
      await owner.memory.deleteProblem(doomed.problemId, problem?.version ?? 0);

      const warnings = await createRetrievalDeadEndReader(pool, owner.context).readForCandidates([
        kept.problemId,
        doomed.problemId,
      ]);

      // "Nowhere is known not to lead" and "this Memory is no longer
      // available" are different statements. A key with an empty list is the
      // first; no key at all is the second, and the caller must be able to
      // tell them apart.
      expect([...warnings.keys()]).toEqual([kept.problemId]);
      expect(warnings.get(kept.problemId)).toEqual([]);
    });
  });

  describe('how many and in what order', () => {
    it('returns all of them, uncapped', async () => {
      const owner = await makeActor();
      const seeded = await seed(owner);
      for (let index = 0; index < 8; index += 1) {
        await append(owner, seeded.problemId, { summary: `attempt ${String(index)}` });
      }

      const enriched = await serviceFor(owner).enrich([
        revalidated(seeded.problemId, seeded.projectId, 1),
      ]);

      // No number in the specification, and cutting historical fact at an
      // arbitrary N would silently drop the part somebody needed.
      expect(enriched[0]?.deadEndWarnings).toHaveLength(8);
    });

    it('returns them oldest first', async () => {
      const owner = await makeActor();
      const seeded = await seed(owner);
      for (const summary of ['first', 'second', 'third']) {
        await append(owner, seeded.problemId, { summary });
      }

      const enriched = await serviceFor(owner).enrich([
        revalidated(seeded.problemId, seeded.projectId, 1),
      ]);
      expect(enriched[0]?.deadEndWarnings.map((entry) => entry.summary)).toEqual([
        'first',
        'second',
        'third',
      ]);
    });

    it('keeps two identical records as two', async () => {
      const owner = await makeActor();
      const seeded = await seed(owner);
      await append(owner, seeded.problemId, { summary: 'the same words', reason: 'first time' });
      await append(owner, seeded.problemId, { summary: 'the same words', reason: 'and again' });

      const enriched = await serviceFor(owner).enrich([
        revalidated(seeded.problemId, seeded.projectId, 1),
      ]);

      // Two Events at two moments for two reasons. Merging them on matching
      // text would lose both.
      expect(enriched[0]?.deadEndWarnings).toHaveLength(2);
      expect(enriched[0]?.deadEndWarnings.map((entry) => entry.reason)).toEqual([
        'first time',
        'and again',
      ]);
    });
  });

  describe('a correction does not cancel one', () => {
    it('keeps the dead end after a later correction', async () => {
      const owner = await makeActor();
      const seeded = await seed(owner);
      await append(owner, seeded.problemId, { summary: 'raising the timeout' });
      await append(owner, seeded.problemId, {
        eventType: 'USER_CORRECTION',
        summary: 'raising the timeout was never really tried properly',
      });

      const enriched = await serviceFor(owner).enrich([
        revalidated(seeded.problemId, seeded.projectId, 1),
      ]);

      // Nothing links the two Events, so deciding that one retracts the other
      // would mean reading free text and guessing. The dead end stays a
      // historical fact; whether it still applies is what the revalidation
      // contract asks to be re-established.
      expect(enriched[0]?.deadEndWarnings.map((entry) => entry.summary)).toEqual([
        'raising the timeout',
      ]);
    });
  });

  describe('a warning is never a prohibition', () => {
    it('carries no field that could forbid a retry', async () => {
      const owner = await makeActor();
      const seeded = await seed(owner);
      await append(owner, seeded.problemId);

      const enriched = await serviceFor(owner).enrich([
        revalidated(seeded.problemId, seeded.projectId, 1),
      ]);

      const serialised = JSON.stringify(enriched);
      for (const prohibition of [
        'retryBlocked',
        'retryAllowed',
        'blocked',
        'forbidden',
        'doNotTry',
        'hardBlock',
        'approvalRequired',
        'severity',
      ]) {
        expect(serialised.includes(prohibition), `a warning carries ${prohibition}`).toBe(false);
      }
    });

    it('keeps a candidate however many it has', async () => {
      const owner = await makeActor();
      const littered = await seed(owner);
      const clean = await seed(owner, { projectId: littered.projectId });
      for (let index = 0; index < 5; index += 1) {
        await append(owner, littered.problemId, { summary: `attempt ${String(index)}` });
      }

      // The one with five recorded failures is ranked first on purpose, so the
      // expected order contradicts every arrangement a warning count could
      // produce. A fixture where the two agree would pass whether or not the
      // warnings were being weighed.
      const enriched = await serviceFor(owner).enrich([
        revalidated(littered.problemId, littered.projectId, 1),
        revalidated(clean.problemId, littered.projectId, 2),
      ]);

      // Both returned, in the order ranking gave them. A Memory that records
      // its failures honestly is not a worse Memory.
      expect(enriched.map((entry) => entry.ranking.problemId)).toEqual([
        littered.problemId,
        clean.problemId,
      ]);
      expect(enriched.map((entry) => entry.ranking.rankingRank)).toEqual([1, 2]);
      expect(enriched.map((entry) => entry.deadEndWarnings.length)).toEqual([5, 0]);
    });

    it.each([['CURRENT'], ['STALE_UNKNOWN'], ['SUPERSEDED'], ['INVALID']] as [Freshness][])(
      'attaches them to a %s Memory without changing anything else about it',
      async (freshness) => {
        const owner = await makeActor();
        const seeded = await seed(owner);
        await append(owner, seeded.problemId, { summary: 'raising the timeout' });
        const given = revalidated(seeded.problemId, seeded.projectId, 1);

        const enriched = await serviceFor(owner).enrich([
          { ...given, ranking: { ...given.ranking, freshness } },
        ]);

        // How current the record claims to be and what was tried and failed
        // are two separate facts. Neither adjusts the other, and the warning
        // arrives the same way whichever the record says.
        expect(enriched[0]?.deadEndWarnings.map((entry) => entry.summary)).toEqual([
          'raising the timeout',
        ]);
        expect(enriched[0]?.ranking.freshness).toBe(freshness);
        expect(enriched[0]?.ranking.suppressed).toBe(false);
        expect(enriched[0]?.ranking.confidence).toBe('HIGH');
        expect(enriched[0]?.ranking.structuralScore).toBe(0.5);
        expect(enriched[0]?.revalidation.requiredChecks).toEqual([...REVALIDATION_CHECKS]);
      },
    );

    it('leaves the historical context beside it', async () => {
      const owner = await makeActor();
      const seeded = await seed(owner);
      await append(owner, seeded.problemId);

      const enriched = await serviceFor(owner).enrich([
        revalidated(seeded.problemId, seeded.projectId, 1),
      ]);

      // Warning plus conditions plus the checklist is what lets a caller ask
      // whether the conditions have moved on since — which is the whole of
      // "an environment difference means it can be tried again".
      expect(enriched[0]?.deadEndWarnings).toHaveLength(1);
      expect(enriched[0]?.revalidation.historicalEnvironment).toEqual({ runtime: 'node 22.12.0' });
      expect(enriched[0]?.revalidation.requiredChecks).toEqual([...REVALIDATION_CHECKS]);
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
        revalidated(kept.problemId, kept.projectId, 1),
        revalidated(doomed.problemId, kept.projectId, 2),
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
        revalidated(kept.problemId, kept.projectId, 1),
        revalidated(off.problemId, kept.projectId, 2),
      ]);

      expect(enriched.map((entry) => entry.ranking.problemId)).toEqual([kept.problemId]);
    });

    it('answers the same way for another owner’s and for one that never existed', async () => {
      const owner = await makeActor();
      const stranger = await makeActor();
      const mine = await seed(owner);
      const theirs = await seed(stranger);

      const withStranger = await serviceFor(owner).enrich([
        revalidated(mine.problemId, mine.projectId, 1),
        revalidated(theirs.problemId, mine.projectId, 2),
      ]);
      const withInvented = await serviceFor(owner).enrich([
        revalidated(mine.problemId, mine.projectId, 1),
        revalidated(randomUUID() as ProblemId, mine.projectId, 2),
      ]);

      expect(JSON.stringify(withStranger)).toBe(JSON.stringify(withInvented));
    });

    it('closes up the positions and leaves the provenance alone', async () => {
      const owner = await makeActor();
      const first = await seed(owner);
      const doomed = await seed(owner, { projectId: first.projectId });
      const third = await seed(owner, { projectId: first.projectId });
      const problem = await owner.memory.getProblem(doomed.problemId);
      await owner.memory.deleteProblem(doomed.problemId, problem?.version ?? 0);

      const given = [
        {
          ...revalidated(first.problemId, first.projectId, 1),
          ranking: { ...revalidated(first.problemId, first.projectId, 1).ranking, hybridRank: 3 },
        },
        {
          ...revalidated(doomed.problemId, first.projectId, 2),
          ranking: { ...revalidated(doomed.problemId, first.projectId, 2).ranking, hybridRank: 6 },
        },
        {
          ...revalidated(third.problemId, first.projectId, 3),
          ranking: { ...revalidated(third.problemId, first.projectId, 3).ranking, hybridRank: 9 },
        },
      ];
      const enriched = await serviceFor(owner).enrich(given);

      expect(enriched.map((entry) => entry.ranking.rankingRank)).toEqual([1, 2]);
      expect(enriched.map((entry) => entry.ranking.hybridRank)).toEqual([3, 9]);
      // And the caller's list is untouched.
      expect(given.map((entry) => entry.ranking.rankingRank)).toEqual([1, 2, 3]);
    });

    it('keeps the historical context of the ones that remain', async () => {
      const owner = await makeActor();
      const kept = await seed(owner);
      const doomed = await seed(owner, { projectId: kept.projectId });
      const problem = await owner.memory.getProblem(doomed.problemId);
      await owner.memory.deleteProblem(doomed.problemId, problem?.version ?? 0);

      const enriched = await serviceFor(owner).enrich([
        revalidated(kept.problemId, kept.projectId, 1),
        revalidated(doomed.problemId, kept.projectId, 2),
      ]);

      expect(enriched[0]?.revalidation.historicalEnvironment).toEqual({ runtime: 'node 22.12.0' });
      expect(enriched[0]?.revalidation.requiredChecks).toEqual([...REVALIDATION_CHECKS]);
    });
  });

  describe('when the read itself fails', () => {
    it('raises rather than answering as though there were none', async () => {
      const owner = await makeActor();
      const seeded = await seed(owner);
      await append(owner, seeded.problemId);
      const failing: DatabaseExecutor = {
        query: () => Promise.reject(new Error('connection terminated unexpectedly')),
      };

      // An empty list means "nothing was recorded", and a database that could
      // not be reached has not established that. Swallowing the failure would
      // present a Memory full of known dead ends as one with none.
      await expect(
        serviceFor(owner, failing).enrich([revalidated(seeded.problemId, seeded.projectId, 1)]),
      ).rejects.toThrow('connection terminated unexpectedly');
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
        serviceFor(owner).enrich(
          six.map((seeded, index) => revalidated(seeded.problemId, seeded.projectId, index + 1)),
        ),
      ).rejects.toBeInstanceOf(InvalidDeadEndRequestError);
    });

    it('refuses the same Problem twice', async () => {
      const owner = await makeActor();
      const seeded = await seed(owner);

      await expect(
        serviceFor(owner).enrich([
          revalidated(seeded.problemId, seeded.projectId, 1),
          revalidated(seeded.problemId, seeded.projectId, 2),
        ]),
      ).rejects.toBeInstanceOf(InvalidDeadEndRequestError);
    });

    it('refuses positions that disagree with the order', async () => {
      const owner = await makeActor();
      const first = await seed(owner);
      const second = await seed(owner, { projectId: first.projectId });
      const executor = counting();

      await expect(
        serviceFor(owner, executor).enrich([
          revalidated(first.problemId, first.projectId, 2),
          revalidated(second.problemId, first.projectId, 1),
        ]),
      ).rejects.toBeInstanceOf(InvalidDeadEndRequestError);
      expect(executor.statements).toHaveLength(0);
    });

    it('names no identifier when it refuses', async () => {
      const owner = await makeActor();
      const seeded = await seed(owner);

      let raised: unknown;
      try {
        await serviceFor(owner).enrich([
          revalidated(seeded.problemId, seeded.projectId, 1),
          revalidated(seeded.problemId, seeded.projectId, 2),
        ]);
      } catch (error) {
        raised = error;
      }
      expect((raised as Error).message.includes(seeded.problemId)).toBe(false);
    });
  });
});
