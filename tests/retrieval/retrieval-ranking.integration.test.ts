/**
 * Ranking against a real database.
 *
 * The ordering itself is arithmetic and is pinned by the unit tests. What is
 * proven here is everything the orchestration owns:
 *
 * **Where the ranking inputs come from.** Trust, currency, suppression and the
 * technology label are read from the database at ranking time, never taken
 * from the caller. A change made between the rerank and the ranking has to
 * show up in the next result — otherwise "suppress this" would be advice
 * rather than an instruction.
 *
 * **One snapshot.** Every field involved is editable, so the current Project's
 * label and the candidates' controls come from a single statement. Two
 * statements could produce a "same technology" verdict for a pairing that
 * never existed at any instant.
 *
 * **Who may be ranked.** Owner and `memory_read_enabled` are applied again,
 * and a Problem that has been deleted, switched off or was never this owner's
 * simply is not there — all indistinguishable. A current Project belonging to
 * somebody else fails exactly as one that never existed.
 *
 * **That nothing is written**, and no order comes back that the fixtures did
 * not put there.
 *
 * Every credential fixture is synthetic. Skipped without `DATABASE_URL`.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createRetrievalRankingService,
  InvalidRetrievalRankingError,
  type RetrievalRankingService,
} from '../../src/app/index.js';
import { readDatabaseUrl } from '../../src/config/env.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import type { DatabaseExecutor } from '../../src/db/executor.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import type { Confidence, Freshness } from '../../src/domain/enums.js';
import { generateOwnerId, type OwnerContext, type OwnerId } from '../../src/domain/owner.js';
import type { ProblemId } from '../../src/domain/problem.js';
import type { ProjectId } from '../../src/domain/project.js';
import type {
  StructuralCandidate,
  StructuralRerankStatus,
} from '../../src/domain/retrieval-structural-rerank.js';
import { resolveOwnerContextFor } from '../../src/owner/context.js';
import {
  createMemoryRepository,
  createRetrievalRankingReader,
  type MemoryRepository,
} from '../../src/repository/index.js';
import { createSecretDetectionPolicy, withSanitization } from '../../src/sanitization/index.js';

const databaseUrl = readDatabaseUrl();

interface Actor {
  readonly ownerId: OwnerId;
  readonly context: OwnerContext;
  readonly memory: MemoryRepository;
}

describe.skipIf(databaseUrl === undefined)('retrieval ranking', () => {
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

  /** Every statement the reader runs, so "one snapshot" can be counted. */
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

  function serviceFor(owner: Actor, executor: DatabaseExecutor = pool): RetrievalRankingService {
    return createRetrievalRankingService(createRetrievalRankingReader(executor, owner.context));
  }

  async function makeProject(owner: Actor, platform: string | null): Promise<ProjectId> {
    const project = await owner.memory.createProject({
      projectName: `project ${randomUUID()}`,
      platform,
    });
    return project.projectId;
  }

  /** A Problem, with whichever ranking controls a test wants set. */
  async function seed(
    owner: Actor,
    projectId: ProjectId,
    controls: {
      readonly confidence?: Confidence;
      readonly freshness?: Freshness;
      readonly suppressed?: boolean;
    } = {},
  ): Promise<ProblemId> {
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

    if (Object.keys(controls).length > 0) {
      await owner.memory.updateProblem(problem.problemId, problem.version, controls);
    }
    return problem.problemId;
  }

  const candidate = (
    problemId: ProblemId,
    projectId: ProjectId,
    index: number,
    structuralScore: number | null = 0.5,
  ): StructuralCandidate => ({
    problemId,
    projectId,
    structuralScore,
    hybridRank: index + 1,
    matchedDimensions: [],
  });

  const rank = async (
    service: RetrievalRankingService,
    currentProjectId: ProjectId,
    candidates: readonly StructuralCandidate[],
    status: StructuralRerankStatus = 'USED',
  ) => service.rank({ currentProjectId, structuralResult: { candidates, status } });

  async function everythingStored(ownerId: OwnerId): Promise<string> {
    const dumps: string[] = [];
    for (const table of [
      'projects',
      'environments',
      'problems',
      'events',
      'verifications',
      'relations',
      'usage_logs',
      'change_logs',
      'retrieval_artifacts',
    ]) {
      const rows = await pool.query(
        `select to_jsonb(t) as row from public.${table} t where owner_id = $1 order by 1`,
        [ownerId],
      );
      dumps.push(`${table}:${JSON.stringify(rows.rows)}`);
    }
    return dumps.join('\n');
  }

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

  describe('the current Project', () => {
    it('reports its owner', async () => {
      const owner = await makeActor();
      expect(serviceFor(owner).ownerId).toBe(owner.ownerId);
    });

    it('refuses one belonging to somebody else, exactly as one that never existed', async () => {
      const owner = await makeActor();
      const stranger = await makeActor();
      const mine = await makeProject(owner, 'react');
      const theirs = await makeProject(stranger, 'react');
      const problemId = await seed(owner, mine);
      const candidates = [candidate(problemId, mine, 0)];

      let foreign: unknown;
      let invented: unknown;
      try {
        await rank(serviceFor(owner), theirs, candidates);
      } catch (error) {
        foreign = error;
      }
      try {
        await rank(serviceFor(owner), randomUUID() as ProjectId, candidates);
      } catch (error) {
        invented = error;
      }

      expect(foreign).toBeInstanceOf(InvalidRetrievalRankingError);
      // Byte-identical: a ranking cannot be used to find out whether somebody
      // else's Project identifier is real.
      expect((foreign as Error).message).toBe((invented as Error).message);
      expect((foreign as Error).message.includes(theirs), 'the refusal named a Project').toBe(
        false,
      );
    });

    it('is not looked up at all when there is nothing to rank', async () => {
      const owner = await makeActor();
      const executor = counting();

      const result = await rank(serviceFor(owner, executor), randomUUID() as ProjectId, []);

      // No candidates means no order to decide, and asking would turn an empty
      // ranking into a way to test whether a Project identifier exists.
      expect(result).toEqual({ candidates: [], structuralStatus: 'USED' });
      expect(executor.statements).toHaveLength(0);
    });
  });

  describe('reading the ranking inputs', () => {
    it('takes the current Project and every candidate from one statement', async () => {
      const owner = await makeActor();
      const project = await makeProject(owner, 'react');
      const first = await seed(owner, project);
      const second = await seed(owner, project);
      const executor = counting();
      executor.statements.length = 0;

      await rank(serviceFor(owner, executor), project, [
        candidate(first, project, 0),
        candidate(second, project, 1),
      ]);

      // Every field involved is editable, so two statements could compare a
      // Project label against candidates that never coexisted with it.
      expect(executor.statements).toHaveLength(1);
    });

    it('reads trust from the database, not from the caller', async () => {
      const owner = await makeActor();
      const project = await makeProject(owner, 'react');
      const high = await seed(owner, project, { confidence: 'HIGH' });
      const low = await seed(owner, project, { confidence: 'LOW' });
      const service = serviceFor(owner);
      const candidates = [candidate(low, project, 0), candidate(high, project, 1)];

      const before = await rank(service, project, candidates);
      expect(before.candidates.map((entry) => entry.problemId)).toEqual([high, low]);
      expect(before.candidates[0]?.confidence).toBe('HIGH');

      const problem = await owner.memory.getProblem(high);
      await owner.memory.updateProblem(high, problem?.version ?? 0, { confidence: 'CONFLICTED' });

      const after = await rank(service, project, candidates);
      expect(after.candidates.map((entry) => entry.problemId)).toEqual([low, high]);
    });

    it('reads currency from the database', async () => {
      const owner = await makeActor();
      const project = await makeProject(owner, 'react');
      const one = await seed(owner, project);
      const other = await seed(owner, project);
      const service = serviceFor(owner);
      const candidates = [candidate(one, project, 0), candidate(other, project, 1)];

      const problem = await owner.memory.getProblem(one);
      await owner.memory.updateProblem(one, problem?.version ?? 0, { freshness: 'INVALID' });

      const result = await rank(service, project, candidates);
      expect(result.candidates.map((entry) => entry.problemId)).toEqual([other, one]);
      expect(result.candidates[1]?.freshness).toBe('INVALID');
      // Marked invalid, not deleted: still offered, and offered last.
      expect(result.candidates).toHaveLength(2);
    });

    it('reads suppression from the database, and demotes without removing', async () => {
      const owner = await makeActor();
      const project = await makeProject(owner, 'react');
      const strong = await seed(owner, project, { confidence: 'HIGH' });
      const weaker = await seed(owner, project, { confidence: 'MEDIUM' });
      const service = serviceFor(owner);
      const candidates = [candidate(strong, project, 0), candidate(weaker, project, 1)];

      expect((await rank(service, project, candidates)).candidates[0]?.problemId).toBe(strong);

      const problem = await owner.memory.getProblem(strong);
      await owner.memory.updateProblem(strong, problem?.version ?? 0, { suppressed: true });

      const after = await rank(service, project, candidates);
      expect(after.candidates.map((entry) => entry.problemId)).toEqual([weaker, strong]);
      expect(after.candidates[1]?.suppressed).toBe(true);
      // Still there. "Show this less" is not "hide this".
      expect(after.candidates).toHaveLength(2);
    });

    it('follows a technology label that has been edited', async () => {
      const owner = await makeActor();
      const current = await makeProject(owner, 'react');
      const other = await makeProject(owner, 'fastify');
      const problemId = await seed(owner, other);
      const service = serviceFor(owner);
      const candidates = [candidate(problemId, other, 0)];

      expect((await rank(service, current, candidates)).candidates[0]?.projectRelation).toBe(
        'OTHER_TECH',
      );

      await owner.memory.updateProject(other, { platform: 'React' });

      expect((await rank(service, current, candidates)).candidates[0]?.projectRelation).toBe(
        'SAME_TECH_OTHER_PROJECT',
      );
    });

    it('classifies an unlabelled Project as unknown rather than different', async () => {
      const owner = await makeActor();
      const current = await makeProject(owner, 'react');
      const unlabelled = await makeProject(owner, null);
      const problemId = await seed(owner, unlabelled);

      const result = await rank(serviceFor(owner), current, [candidate(problemId, unlabelled, 0)]);
      expect(result.candidates[0]?.projectRelation).toBe('UNKNOWN_TECH');
    });

    it('never reports a Problem in the current Project as merely sharing its technology', async () => {
      const owner = await makeActor();
      const current = await makeProject(owner, 'react');
      const problemId = await seed(owner, current);

      const result = await rank(serviceFor(owner), current, [candidate(problemId, current, 0)]);
      expect(result.candidates[0]?.projectRelation).toBe('CURRENT_PROJECT');
    });
  });

  describe('who may be ranked', () => {
    it('drops another owner’s Problem, indistinguishably from an invented one', async () => {
      const owner = await makeActor();
      const stranger = await makeActor();
      const project = await makeProject(owner, 'react');
      const strangerProject = await makeProject(stranger, 'react');
      const mine = await seed(owner, project);
      const theirs = await seed(stranger, strangerProject);
      const service = serviceFor(owner);

      const withStranger = await rank(service, project, [
        candidate(mine, project, 0),
        candidate(theirs, project, 1),
      ]);
      const withInvented = await rank(service, project, [
        candidate(mine, project, 0),
        candidate(randomUUID() as ProblemId, project, 1),
      ]);

      expect(withStranger.candidates.map((entry) => entry.problemId)).toEqual([mine]);
      expect(JSON.stringify(withStranger)).toBe(JSON.stringify(withInvented));
    });

    it('drops a Problem whose automatic reading has been turned off', async () => {
      const owner = await makeActor();
      const project = await makeProject(owner, 'react');
      const kept = await seed(owner, project);
      const switchedOff = await seed(owner, project);
      const service = serviceFor(owner);
      const candidates = [candidate(kept, project, 0), candidate(switchedOff, project, 1)];

      expect((await rank(service, project, candidates)).candidates).toHaveLength(2);

      const problem = await owner.memory.getProblem(switchedOff);
      await owner.memory.updateProblem(switchedOff, problem?.version ?? 0, {
        memoryReadEnabled: false,
      });

      const after = await rank(service, project, candidates);
      expect(after.candidates.map((entry) => entry.problemId)).toEqual([kept]);
    });

    it('separates switching reads off from suppressing', async () => {
      const owner = await makeActor();
      const project = await makeProject(owner, 'react');
      const suppressed = await seed(owner, project, { suppressed: true });
      const unreadable = await seed(owner, project);
      const problem = await owner.memory.getProblem(unreadable);
      await owner.memory.updateProblem(unreadable, problem?.version ?? 0, {
        memoryReadEnabled: false,
      });

      const result = await rank(serviceFor(owner), project, [
        candidate(suppressed, project, 0),
        candidate(unreadable, project, 1),
      ]);

      // One is returned last; the other is not returned at all.
      expect(result.candidates.map((entry) => entry.problemId)).toEqual([suppressed]);
      expect(result.candidates[0]?.suppressed).toBe(true);
    });

    it('drops a Problem deleted between the stages', async () => {
      const owner = await makeActor();
      const project = await makeProject(owner, 'react');
      const kept = await seed(owner, project);
      const doomed = await seed(owner, project);

      const problem = await owner.memory.getProblem(doomed);
      await owner.memory.deleteProblem(doomed, problem?.version ?? 0);

      const result = await rank(serviceFor(owner), project, [
        candidate(kept, project, 0),
        candidate(doomed, project, 1),
      ]);
      expect(result.candidates.map((entry) => entry.problemId)).toEqual([kept]);
    });

    it('keeps the earlier stage’s positions when one disappears', async () => {
      const owner = await makeActor();
      const project = await makeProject(owner, 'react');
      const first = await seed(owner, project);
      const doomed = await seed(owner, project);
      const third = await seed(owner, project);

      const problem = await owner.memory.getProblem(doomed);
      await owner.memory.deleteProblem(doomed, problem?.version ?? 0);

      const result = await rank(serviceFor(owner), project, [
        candidate(first, project, 0, 0.9),
        candidate(doomed, project, 1, 0.8),
        candidate(third, project, 2, 0.7),
      ]);

      // The hybrid positions keep their gap — that gap is the trace of the
      // Problem that went away — while this stage numbers what it returns
      // from one, because that is a different fact.
      expect(result.candidates.map((entry) => entry.hybridRank)).toEqual([1, 3]);
      expect(result.candidates.map((entry) => entry.rankingRank)).toEqual([1, 2]);
    });

    it('raises when a candidate is reported under a Project it is not in', async () => {
      const owner = await makeActor();
      const project = await makeProject(owner, 'react');
      const elsewhere = await makeProject(owner, 'react');
      const problemId = await seed(owner, project);

      await expect(
        rank(serviceFor(owner), project, [candidate(problemId, elsewhere, 0)]),
      ).rejects.toThrow();
    });
  });

  describe('what comes back', () => {
    it('orders by the policy, end to end', async () => {
      const owner = await makeActor();
      const current = await makeProject(owner, 'react');
      const sameTech = await makeProject(owner, 'React');
      const crossTech = await makeProject(owner, 'fastify');

      const a = await seed(owner, current, { confidence: 'HIGH' });
      const b = await seed(owner, sameTech, { confidence: 'HIGH' });
      const c = await seed(owner, crossTech, { confidence: 'HIGH' });

      const result = await rank(serviceFor(owner), current, [
        candidate(a, current, 0, 0.7),
        candidate(b, sameTech, 1, 0.8),
        candidate(c, crossTech, 2, 0.95),
      ]);

      // Structure decides at equal trust, so the different-technology Memory
      // with the strongest structural match leads. A shared technology name
      // does not bury it.
      expect(result.candidates.map((entry) => entry.problemId)).toEqual([c, b, a]);
      expect(result.candidates.map((entry) => entry.projectRelation)).toEqual([
        'OTHER_TECH',
        'SAME_TECH_OTHER_PROJECT',
        'CURRENT_PROJECT',
      ]);
      expect(result.candidates.map((entry) => entry.rankingRank)).toEqual([1, 2, 3]);
    });

    it('falls back to the search order when no rerank ran', async () => {
      const owner = await makeActor();
      const current = await makeProject(owner, 'react');
      const sameTech = await makeProject(owner, 'react');
      const crossTech = await makeProject(owner, 'fastify');

      const a = await seed(owner, current);
      const b = await seed(owner, sameTech);
      const c = await seed(owner, crossTech);

      const result = await rank(
        serviceFor(owner),
        current,
        [
          candidate(c, crossTech, 0, null),
          candidate(b, sameTech, 1, null),
          candidate(a, current, 2, null),
        ],
        'RERANKER_UNAVAILABLE',
      );

      // No structural judgement to order by, so the specification's basic
      // search order comes to the front on its own — and no score is invented
      // to fill the gap.
      expect(result.candidates.map((entry) => entry.problemId)).toEqual([a, b, c]);
      expect(result.candidates.every((entry) => entry.structuralScore === null)).toBe(true);
      expect(result.structuralStatus).toBe('RERANKER_UNAVAILABLE');
    });

    it.each([
      ['USED'],
      ['NOT_NEEDED'],
      ['SKIPPED_SENSITIVE_INPUT'],
      ['RERANKER_UNAVAILABLE'],
      ['STRUCTURAL_DATA_UNAVAILABLE'],
    ] as const)('carries the %s outcome through unchanged', async (status) => {
      const owner = await makeActor();
      const project = await makeProject(owner, 'react');
      const problemId = await seed(owner, project);
      const score = status === 'USED' ? 0.5 : null;

      const result = await rank(
        serviceFor(owner),
        project,
        [candidate(problemId, project, 0, score)],
        status,
      );
      // Without it, a null score would be unreadable downstream.
      expect(result.structuralStatus).toBe(status);
    });

    it('never puts a technology label in the result', async () => {
      const owner = await makeActor();
      const current = await makeProject(owner, 'a-very-distinctive-platform-label');
      const other = await makeProject(owner, 'another-distinctive-platform-label');
      const problemId = await seed(owner, other);

      const result = await rank(serviceFor(owner), current, [candidate(problemId, other, 0)]);

      // The label is read to classify and then left behind: what a Project is
      // built on is the owner's free text, and the relation is all a caller
      // needs.
      const reported = JSON.stringify(result);
      expect(reported.includes('distinctive-platform-label'), 'a platform label came back').toBe(
        false,
      );
      expect(result.candidates[0]?.projectRelation).toBe('OTHER_TECH');
    });

    it('returns every candidate it was given that still exists', async () => {
      const owner = await makeActor();
      const project = await makeProject(owner, 'react');
      const seeded = [
        await seed(owner, project, { suppressed: true }),
        await seed(owner, project, { freshness: 'INVALID' }),
        await seed(owner, project, { confidence: 'CONFLICTED' }),
        await seed(owner, project, { freshness: 'SUPERSEDED' }),
        await seed(owner, project, { confidence: 'LOW' }),
      ];

      const result = await rank(
        serviceFor(owner),
        project,
        seeded.map((problemId, index) => candidate(problemId, project, index, 0)),
      );

      // Five demoted candidates, five returned. Ranking low is not a reason to
      // remove, and there is no threshold anywhere in this stage.
      expect(result.candidates).toHaveLength(5);
      expect(result.candidates.map((entry) => entry.rankingRank)).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe('what it stores', () => {
    it('writes nothing, on any path', async () => {
      const owner = await makeActor();
      const current = await makeProject(owner, 'react');
      const other = await makeProject(owner, null);
      const first = await seed(owner, current, { suppressed: true });
      const second = await seed(owner, other, { freshness: 'INVALID' });

      const before = await everythingStored(owner.ownerId);
      const service = serviceFor(owner);

      await rank(service, current, [candidate(first, current, 0), candidate(second, other, 1)]);
      await rank(
        service,
        current,
        [candidate(first, current, 0, null), candidate(second, other, 1, null)],
        'NOT_NEEDED',
      );
      await rank(service, current, []);
      await rank(service, current, [
        candidate(first, current, 0),
        candidate(randomUUID() as ProblemId, current, 1),
      ]);

      // A ranking is a read. No usage log, no cache, no recorded order.
      expect(await everythingStored(owner.ownerId)).toBe(before);
    });
  });
});
