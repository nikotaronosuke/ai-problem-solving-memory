/**
 * Structural reranking against a real database.
 *
 * The scoring itself is a model's, and a scripted reranker says nothing about
 * whether a real one judges structure well — that is measured against
 * evaluation fixtures later, and nothing here is written as though it had been
 * settled. What is proven here is everything around the model call, which is
 * where this stage can actually go wrong:
 *
 * **Who the candidates are re-checked against.** The earlier stage checked the
 * owner and the read control, and then time passed. A Problem that has since
 * been deleted, lost its artifact, been switched off, or was never this
 * owner's must simply not be there — and all four must look the same, so a
 * caller cannot use a rerank to learn that somebody else's Problem exists.
 *
 * **What crosses the boundary.** The model is sent two structural
 * descriptions. Not the project, not the first stage's scores or ranks, not the
 * summary — and never a credential, whichever of the two unchecked inputs it
 * arrived in.
 *
 * **What happens when something is wrong.** A reranker that cannot be reached
 * degrades and the first stage's order stands; a reranker answering with
 * something that is not an answer does not degrade, because a component that
 * has quietly stopped honouring its contract must not keep running behind
 * plausible results.
 *
 * **That nothing is written.** A search must not be a way to write, and a
 * rerank that could not find an artifact must not generate one.
 *
 * Every credential fixture is synthetic. Skipped without `DATABASE_URL`.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createRetrievalStructuralRerankService,
  InvalidStructuralRerankError,
  InvalidStructuralRerankerOutputError,
  type RetrievalStructuralRerankService,
} from '../../src/app/index.js';
import { readDatabaseUrl } from '../../src/config/env.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import type { DatabaseExecutor } from '../../src/db/executor.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import { generateOwnerId, type OwnerContext, type OwnerId } from '../../src/domain/owner.js';
import type { ProblemId } from '../../src/domain/problem.js';
import type { ProjectId } from '../../src/domain/project.js';
import type { HybridCandidate } from '../../src/domain/retrieval-hybrid-search.js';
import type {
  StructuralReranker,
  StructuralRerankerInput,
} from '../../src/domain/retrieval-structural-rerank.js';
import type { StructuralFeatures } from '../../src/domain/retrieval-summary.js';
import { resolveOwnerContextFor } from '../../src/owner/context.js';
import {
  createMemoryRepository,
  createRetrievalArtifactRepository,
  createRetrievalStructuralReader,
  type MemoryRepository,
  type RetrievalArtifactRepository,
} from '../../src/repository/index.js';
import {
  createArtifactInspectionPolicy,
  createSecretDetectionPolicy,
  withSanitization,
} from '../../src/sanitization/index.js';

const databaseUrl = readDatabaseUrl();

const CURRENT_SECRET = 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI-fake-Tt4Hn8Z0123456789abcd';
const STORED_SECRET = 'Bearer fake-Vv2Jm6Q-0123456789abcdefghij';

/** A valid v1 profile. Plain data, so a test can spoil exactly one field. */
function rawFeatures(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: '1',
    problem_domain: 'deployment',
    symptom_patterns: ['works locally, fails once deployed'],
    suspected_boundaries: ['configuration read at build time'],
    occurrence_conditions: ['only in the deployed environment'],
    successful_directions: [],
    dead_end_directions: ['raising the timeout'],
    environment_facts: ['node 22.12.0'],
    ...overrides,
  };
}

const asFeatures = (overrides: Record<string, unknown> = {}): StructuralFeatures =>
  rawFeatures(overrides) as unknown as StructuralFeatures;

/** A reranker that answers however a test tells it to, and counts. */
function scripted(respond: (input: StructuralRerankerInput) => unknown): StructuralReranker & {
  calls: number;
  seen: StructuralRerankerInput[];
} {
  const state = {
    calls: 0,
    seen: [] as StructuralRerankerInput[],
    rerank(input: StructuralRerankerInput): Promise<unknown> {
      state.calls += 1;
      state.seen.push(input);
      return Promise.resolve(respond(input));
    },
  };
  return state;
}

/** Scores every candidate, best first in the order it was handed them. */
const inOrderGiven = (input: StructuralRerankerInput): unknown => ({
  candidates: input.candidates.map((candidate, index) => ({
    problemId: candidate.problemId,
    structuralScore: Math.max(0.1, 1 - index / 10),
    matchedDimensions: ['symptom_patterns'],
  })),
});

/** Scores every candidate zero: judged, and judged not alike. */
const allUnalike = (input: StructuralRerankerInput): unknown => ({
  candidates: input.candidates.map((candidate) => ({
    problemId: candidate.problemId,
    structuralScore: 0,
    matchedDimensions: [],
  })),
});

interface Actor {
  readonly ownerId: OwnerId;
  readonly context: OwnerContext;
  readonly memory: MemoryRepository;
  readonly artifacts: RetrievalArtifactRepository;
  /** Unwrapped, for planting what a write gate would have refused. */
  readonly rawArtifacts: RetrievalArtifactRepository;
}

describe.skipIf(databaseUrl === undefined)('structural reranking', () => {
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
      rawArtifacts: createRetrievalArtifactRepository(pool, context),
    };
  }

  /** Every statement this reader runs, so "one batch read" can be counted. */
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
    reranker: StructuralReranker,
    executor: DatabaseExecutor = pool,
  ): RetrievalStructuralRerankService {
    return createRetrievalStructuralRerankService(
      createRetrievalStructuralReader(executor, owner.context),
      reranker,
    );
  }

  /** A Problem, and optionally an artifact carrying a chosen profile. */
  async function seed(
    owner: Actor,
    options: {
      readonly features?: Record<string, unknown>;
      readonly projectId?: ProjectId;
      readonly withArtifact?: boolean;
      readonly bypassWriteGate?: boolean;
    } = {},
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

    if (options.withArtifact !== false) {
      const repository = options.bypassWriteGate === true ? owner.rawArtifacts : owner.artifacts;
      await repository.upsertArtifact({
        problemId: problem.problemId,
        normalizedSummary: 'a summary the reranker must never be shown',
        keywords: ['keyword-the-reranker-must-never-be-shown'],
        structuralFeatures: options.features ?? rawFeatures(),
        summaryGeneratorId: 'fixture-summary-generator',
        summaryGeneratorVersion: '1',
        embedding: [1, 0, 0],
        embeddingModel: 'fixture-embedding-model',
        embeddingModelVersion: '2',
        sourceFingerprint: `retrieval-source-v1:${randomUUID().replace(/-/g, '')}`,
        generatedAt: new Date('2026-08-16T14:00:00.000Z'),
      });
    }

    return { problemId: problem.problemId, projectId };
  }

  const asCandidate = (
    seeded: { problemId: ProblemId; projectId: ProjectId },
    index: number,
  ): HybridCandidate => ({
    problemId: seeded.problemId,
    projectId: seeded.projectId,
    fusionScore: 1 / (10 + index + 1),
    lexicalRank: index + 1,
    vectorRank: null,
  });

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

  describe('before anything runs', () => {
    it('refuses an unusable request without touching the database or the model', async () => {
      const owner = await makeActor();
      const reranker = scripted(inOrderGiven);
      const executor = counting();
      const service = serviceFor(owner, reranker, executor);
      const seeded = await seed(owner);
      const statementsAfterSeeding = executor.statements.length;

      await expect(
        service.rerank({
          currentFeatures: asFeatures({ symptom_patterns: null }),
          candidates: [asCandidate(seeded, 0)],
        }),
      ).rejects.toBeInstanceOf(InvalidStructuralRerankError);

      // A request that could never have succeeded reached neither.
      expect(executor.statements).toHaveLength(statementsAfterSeeding);
      expect(reranker.calls).toBe(0);
    });

    it('reports the owner it reranks for', async () => {
      const owner = await makeActor();
      expect(serviceFor(owner, scripted(inOrderGiven)).ownerId).toBe(owner.ownerId);
    });
  });

  describe('re-checking who the candidates are', () => {
    it('drops another owner’s Problem', async () => {
      const owner = await makeActor();
      const stranger = await makeActor();
      const mine = await seed(owner);
      const alsoMine = await seed(owner);
      const theirs = await seed(stranger);
      const reranker = scripted(inOrderGiven);

      const result = await serviceFor(owner, reranker).rerank({
        currentFeatures: asFeatures(),
        candidates: [asCandidate(mine, 0), asCandidate(theirs, 1), asCandidate(alsoMine, 2)],
      });

      expect(result.candidates.map((candidate) => candidate.problemId).sort()).toEqual(
        [mine.problemId, alsoMine.problemId].sort(),
      );
      // And the model was never told the third one had been asked about.
      expect(reranker.seen[0]?.candidates).toHaveLength(2);
    });

    it('makes another owner’s Problem indistinguishable from one that never existed', async () => {
      const owner = await makeActor();
      const stranger = await makeActor();
      const mine = await seed(owner);
      const alsoMine = await seed(owner);
      const theirs = await seed(stranger);
      const invented = { problemId: randomUUID() as ProblemId, projectId: mine.projectId };

      const service = serviceFor(owner, scripted(allUnalike));
      const withStranger = await service.rerank({
        currentFeatures: asFeatures(),
        candidates: [asCandidate(mine, 0), asCandidate(theirs, 1), asCandidate(alsoMine, 2)],
      });
      const withNobody = await service.rerank({
        currentFeatures: asFeatures(),
        candidates: [asCandidate(mine, 0), asCandidate(invented, 1), asCandidate(alsoMine, 2)],
      });

      expect(JSON.stringify(withStranger)).toBe(JSON.stringify(withNobody));
    });

    it('drops a Problem whose automatic reading has been turned off', async () => {
      const owner = await makeActor();
      const kept = await seed(owner);
      const switchedOff = await seed(owner);
      const service = serviceFor(owner, scripted(inOrderGiven));

      const request = {
        currentFeatures: asFeatures(),
        candidates: [asCandidate(kept, 0), asCandidate(switchedOff, 1)],
      };
      expect((await service.rerank(request)).candidates).toHaveLength(2);

      const problem = await owner.memory.getProblem(switchedOff.problemId);
      await owner.memory.updateProblem(switchedOff.problemId, problem?.version ?? 0, {
        memoryReadEnabled: false,
      });

      const after = await service.rerank(request);
      expect(after.candidates.map((candidate) => candidate.problemId)).toEqual([kept.problemId]);
      // Still stored: turning off automatic reading is not a delete.
      expect(await owner.artifacts.getArtifact(switchedOff.problemId)).toBeDefined();
    });

    it('drops a Problem deleted between the two stages', async () => {
      const owner = await makeActor();
      const kept = await seed(owner);
      const doomed = await seed(owner);
      const service = serviceFor(owner, scripted(inOrderGiven));

      const problem = await owner.memory.getProblem(doomed.problemId);
      await owner.memory.deleteProblem(doomed.problemId, problem?.version ?? 0);

      const result = await service.rerank({
        currentFeatures: asFeatures(),
        candidates: [asCandidate(kept, 0), asCandidate(doomed, 1)],
      });
      expect(result.candidates.map((candidate) => candidate.problemId)).toEqual([kept.problemId]);
    });

    it('drops a Problem that has no artifact to compare', async () => {
      const owner = await makeActor();
      const kept = await seed(owner);
      const bare = await seed(owner, { withArtifact: false });

      const result = await serviceFor(owner, scripted(inOrderGiven)).rerank({
        currentFeatures: asFeatures(),
        candidates: [asCandidate(kept, 0), asCandidate(bare, 1)],
      });

      expect(result.candidates.map((candidate) => candidate.problemId)).toEqual([kept.problemId]);
      // And it did not fill the gap by generating one.
      expect(await owner.artifacts.getArtifact(bare.problemId)).toBeUndefined();
    });

    it('reads every candidate in one statement, from one snapshot', async () => {
      const owner = await makeActor();
      const seeded = [await seed(owner), await seed(owner), await seed(owner)];
      const executor = counting();
      const service = serviceFor(owner, scripted(inOrderGiven), executor);
      executor.statements.length = 0;

      await service.rerank({
        currentFeatures: asFeatures(),
        candidates: seeded.map(asCandidate),
      });

      // Twenty round trips would also be twenty snapshots, and the set handed
      // to a reranker would describe a state that never existed.
      expect(executor.statements).toHaveLength(1);
    });

    it('asks nothing at all when there is nothing to ask about', async () => {
      const owner = await makeActor();
      const executor = counting();
      const reranker = scripted(inOrderGiven);
      const result = await serviceFor(owner, reranker, executor).rerank({
        currentFeatures: asFeatures(),
        candidates: [],
      });

      expect(result).toEqual({ candidates: [], status: 'NOT_NEEDED' });
      expect(executor.statements).toHaveLength(0);
      expect(reranker.calls).toBe(0);
    });

    it('raises when a candidate is reported under a Project it is not in', async () => {
      const owner = await makeActor();
      const one = await seed(owner);
      const other = await seed(owner);
      const reranker = scripted(inOrderGiven);

      await expect(
        serviceFor(owner, reranker).rerank({
          currentFeatures: asFeatures(),
          candidates: [asCandidate(one, 0), { ...asCandidate(other, 1), projectId: one.projectId }],
        }),
      ).rejects.toThrow();
      // A broken invariant is not something to degrade around.
      expect(reranker.calls).toBe(0);
    });
  });

  describe('when there is nothing to reorder', () => {
    it.each([[0], [1]])('asks no model for %i candidate(s)', async (count) => {
      const owner = await makeActor();
      const seeded = [];
      for (let index = 0; index < count; index += 1) {
        seeded.push(await seed(owner));
      }
      const reranker = scripted(inOrderGiven);

      const result = await serviceFor(owner, reranker).rerank({
        currentFeatures: asFeatures(),
        candidates: seeded.map(asCandidate),
      });

      expect(result.status).toBe('NOT_NEEDED');
      expect(result.candidates).toHaveLength(count);
      expect(reranker.calls).toBe(0);
      // Nothing was judged, so nothing claims to have been.
      expect(result.candidates.every((candidate) => candidate.structuralScore === null)).toBe(true);
    });
  });

  describe('what the model is shown', () => {
    it('sends structure, and nothing that belongs to another stage', async () => {
      const owner = await makeActor();
      const first = await seed(owner);
      const second = await seed(owner);
      const reranker = scripted(inOrderGiven);

      await serviceFor(owner, reranker).rerank({
        currentFeatures: asFeatures({ problem_domain: 'the current problem domain' }),
        candidates: [asCandidate(first, 0), asCandidate(second, 1)],
      });

      const input = reranker.seen[0];
      expect(input).toBeDefined();
      expect(Object.keys(input ?? {}).sort()).toEqual(['candidates', 'current']);
      expect(Object.keys(input?.candidates[0] ?? {}).sort()).toEqual(['features', 'problemId']);
      expect(Object.keys(input?.candidates[0]?.features ?? {})).toHaveLength(8);

      // A model shown the first stage's ordering could reproduce it; one shown
      // the project could prefer the current one. Both are a later stage's
      // decisions, and neither was asked of this one.
      const sent = JSON.stringify(input);
      for (const absent of [
        'projectId',
        'fusionScore',
        'lexicalRank',
        'vectorRank',
        'hybridRank',
        first.projectId,
        'a summary the reranker must never be shown',
        'keyword-the-reranker-must-never-be-shown',
        'embedding',
      ]) {
        expect(sent.includes(absent), `the reranker was sent ${absent}`).toBe(false);
      }
    });

    it('sends the caller’s profile as the current one, not a stored artifact', async () => {
      const owner = await makeActor();
      const first = await seed(owner);
      const second = await seed(owner);
      const reranker = scripted(inOrderGiven);

      await serviceFor(owner, reranker).rerank({
        currentFeatures: asFeatures({ problem_domain: 'supplied-by-the-caller' }),
        candidates: [asCandidate(first, 0), asCandidate(second, 1)],
      });

      expect(reranker.seen[0]?.current.problem_domain).toBe('supplied-by-the-caller');
    });
  });

  describe('a credential in what would be sent', () => {
    it('stops the call when the caller’s own profile carries one', async () => {
      const owner = await makeActor();
      const first = await seed(owner);
      const second = await seed(owner);
      const reranker = scripted(inOrderGiven);

      const result = await serviceFor(owner, reranker).rerank({
        currentFeatures: asFeatures({ environment_facts: [CURRENT_SECRET] }),
        candidates: [asCandidate(first, 0), asCandidate(second, 1)],
      });

      expect(result.status).toBe('SKIPPED_SENSITIVE_INPUT');
      expect(reranker.calls).toBe(0);
      expect(result.candidates).toHaveLength(2);
      expect(result.candidates.every((candidate) => candidate.structuralScore === null)).toBe(true);
    });

    it('stops the call when a stored profile carries one', async () => {
      const owner = await makeActor();
      // Planted past the write gate on purpose. Relying on "the artifact
      // boundary already checked it" would be trusting a fact about how
      // today's callers happen to be wired, at the moment text leaves the
      // process — and this row came out of a database, which vouches for
      // storage rather than for content.
      const first = await seed(owner, {
        features: rawFeatures({ environment_facts: [STORED_SECRET] }),
        bypassWriteGate: true,
      });
      const second = await seed(owner);
      const reranker = scripted(inOrderGiven);

      const result = await serviceFor(owner, reranker).rerank({
        currentFeatures: asFeatures(),
        candidates: [asCandidate(first, 0), asCandidate(second, 1)],
      });

      expect(result.status).toBe('SKIPPED_SENSITIVE_INPUT');
      expect(reranker.calls).toBe(0);
    });

    it('says only that it was skipped, never what was found or where', async () => {
      const owner = await makeActor();
      const first = await seed(owner, {
        features: rawFeatures({ environment_facts: [STORED_SECRET] }),
        bypassWriteGate: true,
      });
      const second = await seed(owner);

      const result = await serviceFor(owner, scripted(inOrderGiven)).rerank({
        currentFeatures: asFeatures({ occurrence_conditions: [CURRENT_SECRET] }),
        candidates: [asCandidate(first, 0), asCandidate(second, 1)],
      });

      const reported = JSON.stringify(result);
      expect(reported.includes('Tt4Hn8Z'), 'the result carried the value').toBe(false);
      expect(reported.includes('Vv2Jm6Q'), 'the result carried the value').toBe(false);
      expect(reported.includes('environment_facts'), 'the result named the location').toBe(false);
      expect(reported.includes('occurrence_conditions'), 'the result named the location').toBe(
        false,
      );
      // Which side it was on is absent too: one status, both cases.
      expect(result.status).toBe('SKIPPED_SENSITIVE_INPUT');
    });
  });

  describe('a stored profile that cannot be read', () => {
    it('stops the whole stage rather than quietly dropping the candidate', async () => {
      const owner = await makeActor();
      const readable = await seed(owner);
      const unreadable = await seed(owner, {
        features: { schema_version: '1', problem_domain: 'deployment' },
      });
      const alsoReadable = await seed(owner);
      const reranker = scripted(inOrderGiven);

      const result = await serviceFor(owner, reranker).rerank({
        currentFeatures: asFeatures(),
        candidates: [
          asCandidate(readable, 0),
          asCandidate(unreadable, 1),
          asCandidate(alsoReadable, 2),
        ],
      });

      expect(result.status).toBe('STRUCTURAL_DATA_UNAVAILABLE');
      // Dropping it would be indistinguishable from judging it dissimilar, and
      // there is nothing wrong with the Problem — so all three come back, in
      // the order the first stage put them in.
      expect(result.candidates.map((candidate) => candidate.problemId)).toEqual([
        readable.problemId,
        unreadable.problemId,
        alsoReadable.problemId,
      ]);
      expect(result.candidates.every((candidate) => candidate.structuralScore === null)).toBe(true);
      expect(reranker.calls).toBe(0);
    });
  });

  describe('a reranker that fails', () => {
    it('degrades to the first stage’s order when it cannot be reached', async () => {
      const owner = await makeActor();
      const first = await seed(owner);
      const second = await seed(owner);
      const third = await seed(owner);
      const unreachable: StructuralReranker = {
        rerank: () => Promise.reject(new Error('the reranker is unreachable')),
      };

      const result = await serviceFor(owner, unreachable).rerank({
        currentFeatures: asFeatures(),
        candidates: [asCandidate(first, 0), asCandidate(second, 1), asCandidate(third, 2)],
      });

      expect(result.status).toBe('RERANKER_UNAVAILABLE');
      expect(result.candidates.map((candidate) => candidate.problemId)).toEqual([
        first.problemId,
        second.problemId,
        third.problemId,
      ]);
      expect(result.candidates.map((candidate) => candidate.hybridRank)).toEqual([1, 2, 3]);
      // A Memory failure must not stop ordinary work, and an ordering nobody
      // made must not be dressed up as one that was.
      expect(result.candidates.every((candidate) => candidate.structuralScore === null)).toBe(true);
      expect(result.candidates.every((candidate) => candidate.matchedDimensions.length === 0)).toBe(
        true,
      );
    });

    it('raises rather than degrades when its answer is not an answer', async () => {
      const owner = await makeActor();
      const first = await seed(owner);
      const second = await seed(owner);

      // An outage is infrastructure; a malformed answer is a contract
      // violation. Hiding the second behind the first would let a model that
      // has stopped honouring its contract keep running behind results that
      // look ordinary.
      await expect(
        serviceFor(
          owner,
          scripted(() => ({ candidates: [] })),
        ).rerank({
          currentFeatures: asFeatures(),
          candidates: [asCandidate(first, 0), asCandidate(second, 1)],
        }),
      ).rejects.toBeInstanceOf(InvalidStructuralRerankerOutputError);
    });

    it('raises when the answer covers only some of the candidates', async () => {
      const owner = await makeActor();
      const first = await seed(owner);
      const second = await seed(owner);

      await expect(
        serviceFor(
          owner,
          scripted((input) => ({
            candidates: [
              {
                problemId: input.candidates[0]?.problemId,
                structuralScore: 0.9,
                matchedDimensions: ['symptom_patterns'],
              },
            ],
          })),
        ).rerank({
          currentFeatures: asFeatures(),
          candidates: [asCandidate(first, 0), asCandidate(second, 1)],
        }),
      ).rejects.toBeInstanceOf(InvalidStructuralRerankerOutputError);
    });
  });

  describe('a rerank that worked', () => {
    it('reorders by structure and keeps the evidence', async () => {
      const owner = await makeActor();
      const first = await seed(owner);
      const second = await seed(owner);
      const third = await seed(owner);

      // Deliberately the reverse of the order it was handed: a rerank that
      // could not move the first stage's top result would not be a rerank.
      const result = await serviceFor(
        owner,
        scripted((input) => ({
          candidates: input.candidates.map((candidate, index) => ({
            problemId: candidate.problemId,
            structuralScore: (index + 1) / 10,
            matchedDimensions: ['suspected_boundaries'],
          })),
        })),
      ).rerank({
        currentFeatures: asFeatures(),
        candidates: [asCandidate(first, 0), asCandidate(second, 1), asCandidate(third, 2)],
      });

      expect(result.status).toBe('USED');
      expect(result.candidates.map((candidate) => candidate.problemId)).toEqual([
        third.problemId,
        second.problemId,
        first.problemId,
      ]);
      expect(result.candidates[0]?.structuralScore).toBeCloseTo(0.3);
      expect(result.candidates[0]?.matchedDimensions).toEqual(['suspected_boundaries']);
      expect(result.candidates[0]?.hybridRank).toBe(3);
    });

    it('keeps a candidate the model found nothing in common with', async () => {
      const owner = await makeActor();
      const first = await seed(owner);
      const second = await seed(owner);

      const result = await serviceFor(owner, scripted(allUnalike)).rerank({
        currentFeatures: asFeatures(),
        candidates: [asCandidate(first, 0), asCandidate(second, 1)],
      });

      expect(result.status).toBe('USED');
      expect(result.candidates).toHaveLength(2);
      // Zero is a judgement that they are not alike, not a reason to hide one.
      expect(result.candidates.map((candidate) => candidate.structuralScore)).toEqual([0, 0]);
    });

    it('cuts to the limit here rather than asking the model to', async () => {
      const owner = await makeActor();
      const seeded = [await seed(owner), await seed(owner), await seed(owner)];
      const reranker = scripted(inOrderGiven);

      const result = await serviceFor(owner, reranker).rerank({
        currentFeatures: asFeatures(),
        candidates: seeded.map(asCandidate),
        limit: 2,
      });

      expect(result.candidates).toHaveLength(2);
      // The model still judged all three: the cut is this code's, so it is the
      // same every time.
      expect(reranker.seen[0]?.candidates).toHaveLength(3);
    });

    it('leaves out the Problem being worked on', async () => {
      const owner = await makeActor();
      const current = await seed(owner);
      const other = await seed(owner);
      const another = await seed(owner);

      const result = await serviceFor(owner, scripted(inOrderGiven)).rerank({
        currentFeatures: asFeatures(),
        candidates: [asCandidate(current, 0), asCandidate(other, 1), asCandidate(another, 2)],
        excludeProblemId: current.problemId,
      });

      expect(result.candidates.map((candidate) => candidate.problemId).sort()).toEqual(
        [other.problemId, another.problemId].sort(),
      );
    });
  });

  describe('where the first stage put each candidate', () => {
    it('keeps the later ranks where they were when the middle one disappears', async () => {
      const owner = await makeActor();
      const first = await seed(owner);
      const doomed = await seed(owner);
      const third = await seed(owner);

      const problem = await owner.memory.getProblem(doomed.problemId);
      await owner.memory.deleteProblem(doomed.problemId, problem?.version ?? 0);

      const result = await serviceFor(owner, scripted(inOrderGiven)).rerank({
        currentFeatures: asFeatures(),
        candidates: [asCandidate(first, 0), asCandidate(doomed, 1), asCandidate(third, 2)],
      });

      expect(result.status).toBe('USED');
      // 1 and 3, with no 2. `hybridRank` says where the hybrid stage put a
      // candidate; renumbering the survivors would rewrite that stage's answer
      // and hide the gap, which is the one visible sign that something
      // disappeared between the two.
      expect(result.candidates.map((candidate) => candidate.problemId)).toEqual([
        first.problemId,
        third.problemId,
      ]);
      expect(result.candidates.map((candidate) => candidate.hybridRank)).toEqual([1, 3]);
    });

    it('keeps them on a degraded path too', async () => {
      const owner = await makeActor();
      const first = await seed(owner);
      const bare = await seed(owner, { withArtifact: false });
      const third = await seed(owner);

      const result = await serviceFor(owner, {
        rerank: () => Promise.reject(new Error('the reranker is unreachable')),
      }).rerank({
        currentFeatures: asFeatures(),
        candidates: [asCandidate(first, 0), asCandidate(bare, 1), asCandidate(third, 2)],
      });

      expect(result.status).toBe('RERANKER_UNAVAILABLE');
      expect(result.candidates.map((candidate) => candidate.hybridRank)).toEqual([1, 3]);
      expect(result.candidates.every((candidate) => candidate.structuralScore === null)).toBe(true);
    });

    it('keeps them when only the last of three survives', async () => {
      const owner = await makeActor();
      const gone = await seed(owner, { withArtifact: false });
      const alsoGone = await seed(owner, { withArtifact: false });
      const survivor = await seed(owner);

      const result = await serviceFor(owner, scripted(inOrderGiven)).rerank({
        currentFeatures: asFeatures(),
        candidates: [asCandidate(gone, 0), asCandidate(alsoGone, 1), asCandidate(survivor, 2)],
      });

      // One candidate, so no model is asked — and the position it came in at
      // is still 3, not 1.
      expect(result.status).toBe('NOT_NEEDED');
      expect(result.candidates.map((candidate) => candidate.hybridRank)).toEqual([3]);
    });
  });

  describe('what it stores', () => {
    it('writes nothing, on any path', async () => {
      const owner = await makeActor();
      const first = await seed(owner);
      const second = await seed(owner);
      const bare = await seed(owner, { withArtifact: false });
      const unreadable = await seed(owner, { features: { schema_version: '1' } });

      const before = await everythingStored(owner.ownerId);
      const candidates = [
        asCandidate(first, 0),
        asCandidate(second, 1),
        asCandidate(bare, 2),
        asCandidate(unreadable, 3),
      ];
      const current = asFeatures();

      // Every outcome this stage has, one after another.
      await serviceFor(owner, scripted(inOrderGiven)).rerank({
        currentFeatures: current,
        candidates: candidates.slice(0, 2),
      });
      await serviceFor(owner, scripted(inOrderGiven)).rerank({
        currentFeatures: current,
        candidates,
      });
      await serviceFor(owner, scripted(inOrderGiven)).rerank({
        currentFeatures: asFeatures({ environment_facts: [CURRENT_SECRET] }),
        candidates: candidates.slice(0, 2),
      });
      await serviceFor(owner, {
        rerank: () => Promise.reject(new Error('the reranker is unreachable')),
      }).rerank({ currentFeatures: current, candidates: candidates.slice(0, 2) });
      await serviceFor(owner, scripted(inOrderGiven)).rerank({
        currentFeatures: current,
        candidates: [],
      });

      // A search must not be a way to write, and a rerank that could not find
      // an artifact must not make one.
      expect(await everythingStored(owner.ownerId)).toBe(before);
    });
  });
});
