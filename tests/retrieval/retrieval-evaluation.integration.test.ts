/**
 * The retrieval evaluation corpus, run against a real database.
 *
 * Every earlier retrieval suite proves one stage does its own job. This one
 * proves the stages together answer the question the specification actually
 * asks: that experience from another Project, written in another vocabulary
 * about another technology, is found because the *shape* of the problem
 * matches — and that agreeing on the surface is not enough to win.
 *
 * Nine named scenarios, one shared corpus, and a deliberate wrong answer in
 * every one of them. The corpus and the deterministic stand-ins live in
 * `fixtures/retrieval-evaluation-corpus.ts`; this file seeds them and states
 * what must be true.
 *
 * **What this proves.** Given a working keyword signal, a working semantic
 * signal and a structural judgement, the pipeline retrieves, fuses, reranks,
 * ranks, enriches, bounds and reuses exactly as the specification says.
 *
 * **What this does not prove.** Anything about a real embedding model or a real
 * reranking model. There is no vendor here, no network and no credential. The
 * judgement is a fixture instrument standing where a model will stand, and a
 * green run says the pipeline carries structure correctly — not that any
 * particular model judges structure well.
 *
 * Skipped without `DATABASE_URL`.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createRetrievalConflictService,
  createRetrievalDeadEndService,
  createRetrievalSuccessfulDirectionService,
  createRetrievalHybridSearchService,
  createRetrievalRankingService,
  createRetrievalRevalidationService,
  createRetrievalSearchCache,
  createRetrievalSearchService,
  createRetrievalStructuralRerankService,
  createRetrievalUsageLogWriter,
  createRetrievalVectorSearchService,
  REVALIDATION_CHECKS,
  type RetrievalSearchOutcome,
  type RetrievalSearchService,
  type RetrievalUsageLogFailure,
  type RetrievalUsageLogFailureReporter,
} from '../../src/app/index.js';
import { readDatabaseUrl } from '../../src/config/env.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import { createTransactionRunner } from '../../src/db/transaction.js';
import type { ClientId } from '../../src/domain/client.js';
import type { ClientEventId } from '../../src/domain/client-event-id.js';
import { generateOwnerId, type OwnerContext, type OwnerId } from '../../src/domain/owner.js';
import type { ProblemId } from '../../src/domain/problem.js';
import type { StructuralFeatures } from '../../src/domain/retrieval-summary.js';
import { resolveOwnerContextFor } from '../../src/owner/context.js';
import {
  createMemoryRepository,
  createRetrievalArtifactRepository,
  createRetrievalConflictReader,
  createRetrievalDeadEndReader,
  createRetrievalSuccessfulDirectionReader,
  createRetrievalRankingReader,
  createRetrievalRevalidationReader,
  createRetrievalSearchReader,
  createRetrievalStructuralReader,
  createRetrievalSummarySourceReader,
  createRetrievalVectorSearchReader,
  type MemoryRepository,
  type RetrievalArtifactRepository,
} from '../../src/repository/index.js';
import {
  createArtifactInspectionPolicy,
  createSecretDetectionPolicy,
  withSanitization,
} from '../../src/sanitization/index.js';
import type { AuthenticatedRequestContext } from '../../src/app/index.js';
import {
  CONFLICT_COUNTERPART,
  CONFLICT_REASON,
  CONFLICTED_MEMORY,
  CONFLICTED_VERIFICATIONS,
  CONTROLS_BEYOND_BOUND,
  CONTROLS_CANDIDATES,
  CONTROLS_CURRENT,
  CONTROLS_EXPECTED_ORDER,
  CONTROLS_QUERY,
  CONTROLS_QUERY_FEATURES,
  CORPUS_MEMORIES,
  CORPUS_PROJECTS,
  COUNTERPART_VERIFICATIONS,
  createEvaluationEmbeddingProvider,
  createFixtureStructuralOracle,
  CROSS_TECH_MEMORY,
  DEAD_END_EVENTS,
  DEAD_END_MEMORY,
  DELIVERY_CURRENT,
  DELIVERY_QUERY,
  DELIVERY_QUERY_FEATURES,
  ENRICHMENT_CURRENT,
  ENRICHMENT_QUERY,
  ENRICHMENT_QUERY_FEATURES,
  EVALUATION_MODEL,
  FOREIGN_DECOY,
  FOREIGN_PROJECT,
  judgeStructurally,
  SAME_TECH_MEMORY,
  SEMANTIC_CLASSES,
  SURFACE_DECOY_MEMORY,
  type CorpusMemory,
} from './fixtures/retrieval-evaluation-corpus.js';

const databaseUrl = readDatabaseUrl();

interface Actor {
  readonly ownerId: OwnerId;
  readonly context: OwnerContext;
  readonly memory: MemoryRepository;
  readonly artifacts: RetrievalArtifactRepository;
}

describe.skipIf(databaseUrl === undefined)('retrieval evaluation', () => {
  let pool: DatabasePool;
  const ownersCreated: OwnerId[] = [];

  /** Every corpus Memory, by its stable role name. */
  const problems = new Map<string, ProblemId>();
  let owner: Actor;
  let stranger: Actor;

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

  function requestContextFor(actor: Actor): AuthenticatedRequestContext {
    const runner = createTransactionRunner(pool);
    return {
      clientId: 'evaluation-client' as ClientId,
      repository: actor.memory,
      retrievalArtifacts: actor.artifacts,
      runInTransaction: (work) =>
        runner.run((transactional) =>
          work(
            withSanitization(
              createMemoryRepository(transactional, actor.context),
              createSecretDetectionPolicy(),
            ),
          ),
        ),
    };
  }

  function silentReporter(): RetrievalUsageLogFailureReporter & {
    failures: RetrievalUsageLogFailure[];
  } {
    const failures: RetrievalUsageLogFailure[] = [];
    return {
      failures,
      report: (failure) => {
        failures.push(failure);
      },
    };
  }

  /** The whole pipeline, wired for one owner with the fixture stand-ins. */
  function evaluationService(
    actor: Actor,
    parts: {
      cache?: ReturnType<typeof createRetrievalSearchCache>;
      embedding?: ReturnType<typeof createEvaluationEmbeddingProvider>;
      oracle?: ReturnType<typeof createFixtureStructuralOracle>;
    } = {},
  ): RetrievalSearchService {
    return createRetrievalSearchService(
      createRetrievalSummarySourceReader(pool, actor.context),
      createRetrievalHybridSearchService(
        createRetrievalSearchReader(pool, actor.context),
        createRetrievalVectorSearchService(
          parts.embedding ?? createEvaluationEmbeddingProvider(),
          createRetrievalVectorSearchReader(pool, actor.context),
        ),
      ),
      createRetrievalStructuralRerankService(
        createRetrievalStructuralReader(pool, actor.context),
        parts.oracle ?? createFixtureStructuralOracle(),
      ),
      createRetrievalRankingService(createRetrievalRankingReader(pool, actor.context)),
      createRetrievalRevalidationService(createRetrievalRevalidationReader(pool, actor.context)),
      createRetrievalDeadEndService(createRetrievalDeadEndReader(pool, actor.context)),
      createRetrievalSuccessfulDirectionService(
        createRetrievalSuccessfulDirectionReader(pool, actor.context),
      ),
      createRetrievalConflictService(createRetrievalConflictReader(pool, actor.context)),
      parts.cache ?? createRetrievalSearchCache(),
      createRetrievalUsageLogWriter(requestContextFor(actor)),
      silentReporter(),
    );
  }

  /** Seeds one corpus Memory: Project, Environment, Problem, artifact, controls. */
  async function seedMemory(
    actor: Actor,
    memory: CorpusMemory,
    projectIds: Map<string, string>,
  ): Promise<ProblemId> {
    const projectId = projectIds.get(memory.projectRole);
    if (projectId === undefined) {
      throw new Error(`No project seeded for role ${memory.projectRole}.`);
    }
    const environment = await actor.memory.createEnvironment({
      projectId: projectId as never,
      snapshot: memory.environment,
    });
    const problem = await actor.memory.createProblem({
      projectId: projectId as never,
      environmentId: environment.environmentId,
      title: memory.role,
      symptoms: memory.symptoms,
      problemDomain: memory.problemDomain,
      suspectedBoundary: memory.suspectedBoundary,
    });

    const update = {
      ...(memory.confidence === undefined ? {} : { confidence: memory.confidence }),
      ...(memory.freshness === undefined ? {} : { freshness: memory.freshness }),
      ...(memory.suppressed === undefined ? {} : { suppressed: memory.suppressed }),
    };
    if (Object.keys(update).length > 0) {
      const stored = await actor.memory.getProblem(problem.problemId);
      await actor.memory.updateProblem(problem.problemId, stored?.version ?? 0, update);
    }

    return problem.problemId;
  }

  /**
   * The Memory's search rendering, written after every canonical write.
   *
   * Separate from `seedMemory`, and called last, because the lifecycle rule
   * applies to fixtures too: the Events and Verifications seeded below are
   * canonical writes, and each takes the artifact of its Problem with it. The
   * corpus therefore writes the whole record first and renders it once, in
   * the order production regeneration would.
   */
  async function seedArtifact(
    actor: Actor,
    memory: CorpusMemory,
    problemId: ProblemId,
  ): Promise<void> {
    if (memory.artifact === undefined) {
      return;
    }
    await actor.artifacts.upsertArtifact({
      problemId,
      normalizedSummary: memory.artifact.normalizedSummary,
      keywords: [...memory.artifact.keywords],
      structuralFeatures: memory.artifact.features,
      summaryGeneratorId: 'evaluation-summary-generator',
      summaryGeneratorVersion: '1',
      semantic: {
        embedding: [...SEMANTIC_CLASSES[memory.artifact.semanticClass]],
        embeddingModel: EVALUATION_MODEL.id,
        embeddingModelVersion: memory.artifact.modelVersion ?? EVALUATION_MODEL.version,
      },
      sourceFingerprint: `retrieval-source-v1:${randomUUID().replace(/-/g, '')}`,
      generatedAt: new Date('2026-08-16T09:00:00.000Z'),
    });
  }

  /** The identifier a role was seeded under. */
  const idOf = (role: string): ProblemId => {
    const problemId = problems.get(role);
    if (problemId === undefined) {
      throw new Error(`Role ${role} was never seeded.`);
    }
    return problemId;
  };

  /** The roles a search offered, in the order it offered them. */
  const rolesOf = (outcome: RetrievalSearchOutcome): string[] => {
    if (outcome.kind !== 'SEARCHED') {
      throw new Error(`The search did not run: ${outcome.kind}.`);
    }
    const byId = new Map([...problems].map(([role, problemId]) => [problemId, role]));
    return outcome.candidates.map(
      (candidate) => byId.get(candidate.ranking.problemId) ?? 'unknown',
    );
  };

  const searchFor = async (
    service: RetrievalSearchService,
    currentRole: string,
    query: { readonly lexical: string; readonly semantic: string },
    currentFeatures: StructuralFeatures,
  ): Promise<RetrievalSearchOutcome> =>
    service.search(
      {
        currentProblemId: idOf(currentRole),
        lexicalText: query.lexical,
        semanticText: query.semantic,
        currentFeatures,
      },
      { sourceAi: 'evaluation-assistant' },
    );

  beforeAll(async () => {
    pool = createPool(resolveDatabaseConfig({ nodeEnv: 'test', connectionTimeoutMillis: 5_000 }));
    owner = await makeActor();
    stranger = await makeActor();

    const projectIds = new Map<string, string>();
    for (const project of CORPUS_PROJECTS) {
      const created = await owner.memory.createProject({
        projectName: `${project.role} ${randomUUID()}`,
        platform: project.platform,
      });
      projectIds.set(project.role, created.projectId);
    }
    for (const memory of CORPUS_MEMORIES) {
      problems.set(memory.role, await seedMemory(owner, memory, projectIds));
    }

    // What was recorded as a dead end, in the words used at the time.
    for (const event of DEAD_END_EVENTS) {
      await owner.memory.appendEvent({
        problemId: idOf(DEAD_END_MEMORY.role),
        eventType: 'DEAD_END',
        summary: event.summary,
        ...(event.result === null ? {} : { result: event.result }),
        ...(event.reason === null ? {} : { reason: event.reason }),
        clientEventId: randomUUID() as ClientEventId,
      });
    }

    // The disagreement, and what each side had checked.
    await owner.memory.createRelation({
      fromId: idOf(CONFLICTED_MEMORY.role),
      toId: idOf(CONFLICT_COUNTERPART.role),
      relationType: 'CONTRADICTS',
      reason: CONFLICT_REASON,
    });
    for (const [role, checks] of [
      [CONFLICTED_MEMORY.role, CONFLICTED_VERIFICATIONS],
      [CONFLICT_COUNTERPART.role, COUNTERPART_VERIFICATIONS],
    ] as const) {
      for (const check of checks) {
        await owner.memory.appendVerification({
          problemId: idOf(role),
          verificationType: 'TEST',
          result: check.result,
          summary: check.summary,
          clientEventId: randomUUID() as ClientEventId,
        });
      }
    }

    // Every canonical write is in; now render each Memory once, as
    // regeneration would after the record settled.
    for (const memory of CORPUS_MEMORIES) {
      await seedArtifact(owner, memory, idOf(memory.role));
    }

    // Another owner's perfect match for the delivery query.
    const foreignProject = await stranger.memory.createProject({
      projectName: `${FOREIGN_PROJECT.role} ${randomUUID()}`,
      platform: FOREIGN_PROJECT.platform,
    });
    problems.set(
      FOREIGN_DECOY.role,
      await seedMemory(
        stranger,
        FOREIGN_DECOY,
        new Map([[FOREIGN_PROJECT.role, foreignProject.projectId]]),
      ),
    );
    await seedArtifact(stranger, FOREIGN_DECOY, idOf(FOREIGN_DECOY.role));
  }, 60_000);

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

  describe('the corpus is hard enough to be worth running', () => {
    it('states the cross-technology structure in different words', () => {
      const current = DELIVERY_QUERY_FEATURES;
      const candidate = CROSS_TECH_MEMORY.artifact?.features;
      expect(candidate).toBeDefined();
      if (candidate === undefined) {
        return;
      }

      // Not one shared phrase on the four dimensions that carry the argument.
      // A comparison built from string equality or set overlap scores this pair
      // at nothing — which is the measurement that made structural judgement a
      // model port rather than an intersection, and the reason this fixture is
      // not self-fulfilling.
      for (const dimension of [
        'suspected_boundaries',
        'occurrence_conditions',
        'successful_directions',
        'dead_end_directions',
      ] as const) {
        const shared = current[dimension].filter((phrase) => candidate[dimension].includes(phrase));
        expect(shared, `${dimension} was copied rather than paraphrased`).toEqual([]);
      }
      expect(current.problem_domain).not.toBe(candidate.problem_domain);
    });

    it('gives the surface decoy the stronger words and the weaker structure', () => {
      const decoy = SURFACE_DECOY_MEMORY.artifact;
      const crossTech = CROSS_TECH_MEMORY.artifact;
      expect(decoy).toBeDefined();
      expect(crossTech).toBeDefined();
      if (decoy === undefined || crossTech === undefined) {
        return;
      }

      // The decoy shares the query's vocabulary outright; the cross-technology
      // Memory shares none of it. Whatever wins does so on structure.
      const queryWords = DELIVERY_QUERY.lexical.split(' ');
      const decoyHits = queryWords.filter((word) => decoy.normalizedSummary.includes(word));
      const crossHits = queryWords.filter((word) => crossTech.normalizedSummary.includes(word));
      expect(decoyHits.length).toBeGreaterThan(crossHits.length);

      expect(
        judgeStructurally(DELIVERY_QUERY_FEATURES, crossTech.features).structuralScore,
      ).toBeGreaterThan(judgeStructurally(DELIVERY_QUERY_FEATURES, decoy.features).structuralScore);
    });

    it('judges structure without ever seeing whose Memory it is', () => {
      const features = CROSS_TECH_MEMORY.artifact?.features;
      expect(features).toBeDefined();
      if (features === undefined) {
        return;
      }

      // The oracle is handed features and nothing else, so the same features
      // must judge the same however the candidate is labelled. If a score could
      // move with an identifier, the whole suite would be checking that a
      // stand-in remembers the answer rather than that the pipeline carries
      // structure from the artifact to the judgement.
      const once = judgeStructurally(DELIVERY_QUERY_FEATURES, features);
      const again = judgeStructurally(DELIVERY_QUERY_FEATURES, { ...features });
      expect(again).toEqual(once);
      expect(once.structuralScore).toBeGreaterThan(0);
    });
  });

  describe('SAME_TECH_SAME_SYMPTOM', () => {
    it('finds the same trouble in another Project on the same technology', async () => {
      const outcome = await searchFor(
        evaluationService(owner),
        DELIVERY_CURRENT.role,
        DELIVERY_QUERY,
        DELIVERY_QUERY_FEATURES,
      );
      const roles = rolesOf(outcome);
      expect(roles).toContain(SAME_TECH_MEMORY.role);

      if (outcome.kind !== 'SEARCHED') {
        return;
      }
      const offered = outcome.candidates.find(
        (candidate) => candidate.ranking.problemId === idOf(SAME_TECH_MEMORY.role),
      );
      expect(offered?.ranking.projectRelation).toBe('SAME_TECH_OTHER_PROJECT');
      // Ahead of the Memory that shares the words but not the cause.
      expect(roles.indexOf(SAME_TECH_MEMORY.role)).toBeLessThan(
        roles.indexOf(SURFACE_DECOY_MEMORY.role),
      );
    });

    it('reaches it by keyword, which is the only channel that can see it', async () => {
      const embedding = createEvaluationEmbeddingProvider();
      const outcome = await searchFor(
        evaluationService(owner, { embedding }),
        DELIVERY_CURRENT.role,
        DELIVERY_QUERY,
        DELIVERY_QUERY_FEATURES,
      );

      // Its artifact is stored under a model version this search never queries
      // with, and comparing across models is refused — a production rule, not a
      // fixture one. So the semantic channel cannot return it at all, and if the
      // keyword channel stops working the candidate simply disappears.
      expect(embedding.calls).toBeGreaterThan(0);
      expect(SAME_TECH_MEMORY.artifact?.modelVersion).not.toBe(EVALUATION_MODEL.version);
      expect(rolesOf(outcome)).toContain(SAME_TECH_MEMORY.role);
    });
  });

  describe('CROSS_TECH_STRUCTURAL_SIMILARITY', () => {
    it('finds a Memory from another technology, written in other words', async () => {
      const outcome = await searchFor(
        evaluationService(owner),
        DELIVERY_CURRENT.role,
        DELIVERY_QUERY,
        DELIVERY_QUERY_FEATURES,
      );
      expect(rolesOf(outcome)).toContain(CROSS_TECH_MEMORY.role);

      if (outcome.kind !== 'SEARCHED') {
        return;
      }
      const offered = outcome.candidates.find(
        (candidate) => candidate.ranking.problemId === idOf(CROSS_TECH_MEMORY.role),
      );
      expect(offered?.ranking.projectRelation).toBe('OTHER_TECH');
    });

    it('offers it above the Memory that only shares the words', async () => {
      const outcome = await searchFor(
        evaluationService(owner),
        DELIVERY_CURRENT.role,
        DELIVERY_QUERY,
        DELIVERY_QUERY_FEATURES,
      );
      const roles = rolesOf(outcome);

      // This is the acceptance the whole phase exists for. Both are equally
      // trusted, equally current and neither is suppressed, so nothing but
      // structure separates them — and the one that wins is on a different
      // technology, in a different vocabulary, in a Project further away.
      expect(roles).toContain(CROSS_TECH_MEMORY.role);
      expect(roles).toContain(SURFACE_DECOY_MEMORY.role);
      expect(roles.indexOf(CROSS_TECH_MEMORY.role)).toBeLessThan(
        roles.indexOf(SURFACE_DECOY_MEMORY.role),
      );

      if (outcome.kind !== 'SEARCHED') {
        return;
      }
      const [crossTech, decoy] = [CROSS_TECH_MEMORY.role, SURFACE_DECOY_MEMORY.role].map((role) =>
        outcome.candidates.find((candidate) => candidate.ranking.problemId === idOf(role)),
      );
      expect(crossTech?.ranking.confidence).toBe(decoy?.ranking.confidence);
      expect(crossTech?.ranking.freshness).toBe(decoy?.ranking.freshness);
      expect(crossTech?.ranking.suppressed).toBe(false);
      expect(decoy?.ranking.suppressed).toBe(false);
      // And the further-away Project really is further away.
      expect(crossTech?.ranking.projectRelation).toBe('OTHER_TECH');
      expect(decoy?.ranking.projectRelation).toBe('SAME_TECH_OTHER_PROJECT');
    });

    it('reaches it semantically, and says on what structure it agreed', async () => {
      const oracle = createFixtureStructuralOracle();
      const outcome = await searchFor(
        evaluationService(owner, { oracle }),
        DELIVERY_CURRENT.role,
        DELIVERY_QUERY,
        DELIVERY_QUERY_FEATURES,
      );

      expect(oracle.calls).toBe(1);
      if (outcome.kind !== 'SEARCHED') {
        return;
      }
      const offered = outcome.candidates.find(
        (candidate) => candidate.ranking.problemId === idOf(CROSS_TECH_MEMORY.role),
      );

      // Several structures, not one lucky overlap — and among them the
      // direction that worked, which is the derived material the specification
      // names as a similarity factor.
      const matched = offered?.ranking.matchedDimensions ?? [];
      expect(matched.length).toBeGreaterThan(3);
      expect(matched).toContain('suspected_boundaries');
      expect(matched).toContain('occurrence_conditions');
      expect(matched).toContain('successful_directions');
      expect(matched).toContain('dead_end_directions');
      // Its own environment differs, and that is not held against it.
      expect(matched).not.toContain('environment_facts');
    });

    it('carries the whole structural profile to the judgement', async () => {
      const oracle = createFixtureStructuralOracle();
      await searchFor(
        evaluationService(owner, { oracle }),
        DELIVERY_CURRENT.role,
        DELIVERY_QUERY,
        DELIVERY_QUERY_FEATURES,
      );

      // The judgement can only be about structure if the structure arrives.
      const input = oracle.seen[0];
      const candidate = input?.candidates.find(
        (entry) => entry.problemId === idOf(CROSS_TECH_MEMORY.role),
      );
      expect(candidate?.features.suspected_boundaries).toEqual([
        'settings frozen before the runtime starts',
      ]);
      expect(candidate?.features.successful_directions).toEqual([
        'resolve the value when the request arrives rather than when the image is assembled',
      ]);
      expect(candidate?.features.dead_end_directions).toEqual([
        'giving the packaging step more time',
      ]);
      expect(input?.current.suspected_boundaries).toEqual(['configuration captured during build']);
    });
  });

  describe('SURFACE_SIMILAR_DIFFERENT_CAUSE', () => {
    it('keeps the look-alike as a candidate rather than hiding it', async () => {
      const outcome = await searchFor(
        evaluationService(owner),
        DELIVERY_CURRENT.role,
        DELIVERY_QUERY,
        DELIVERY_QUERY_FEATURES,
      );

      // A search returns candidates, not answers. Sharing the words is a real
      // if weak reason to look, and the specification asks for the order to
      // reflect that — not for the weaker reason to be suppressed.
      expect(rolesOf(outcome)).toContain(SURFACE_DECOY_MEMORY.role);
    });

    it('puts both Memories that share the cause above it', async () => {
      const roles = rolesOf(
        await searchFor(
          evaluationService(owner),
          DELIVERY_CURRENT.role,
          DELIVERY_QUERY,
          DELIVERY_QUERY_FEATURES,
        ),
      );
      const decoy = roles.indexOf(SURFACE_DECOY_MEMORY.role);
      expect(roles.indexOf(SAME_TECH_MEMORY.role)).toBeLessThan(decoy);
      expect(roles.indexOf(CROSS_TECH_MEMORY.role)).toBeLessThan(decoy);
    });
  });

  describe('STALE_MEMORY', () => {
    it('offers a current Memory ahead of one nobody has checked since', async () => {
      const roles = rolesOf(
        await searchFor(
          evaluationService(owner),
          CONTROLS_CURRENT.role,
          CONTROLS_QUERY,
          CONTROLS_QUERY_FEATURES,
        ),
      );

      // The stale one is the *stronger* structural match of the two and equally
      // trusted, so currency is the only thing that can be putting the other
      // first.
      expect(roles.indexOf('controls-trusted')).toBeLessThan(roles.indexOf('controls-stale'));
    });

    it('still offers the stale Memory', async () => {
      const outcome = await searchFor(
        evaluationService(owner),
        CONTROLS_CURRENT.role,
        CONTROLS_QUERY,
        CONTROLS_QUERY_FEATURES,
      );

      // Marking a Memory stale is not deleting it. It comes back, further down,
      // with the currency it claims and the checks that would settle it.
      expect(rolesOf(outcome)).toContain('controls-stale');
      if (outcome.kind !== 'SEARCHED') {
        return;
      }
      const stale = outcome.candidates.find(
        (candidate) => candidate.ranking.problemId === idOf('controls-stale'),
      );
      expect(stale?.ranking.freshness).toBe('STALE_UNKNOWN');
      expect(stale?.revalidation.requiredChecks).toEqual([...REVALIDATION_CHECKS]);
    });
  });

  describe('RANKING_CONTROLS', () => {
    it('orders by suppression, then currency, then trust — against the structure', async () => {
      const roles = rolesOf(
        await searchFor(
          evaluationService(owner),
          CONTROLS_CURRENT.role,
          CONTROLS_QUERY,
          CONTROLS_QUERY_FEATURES,
        ),
      );

      // The five survivors were deliberately built so that structural strength
      // runs the *opposite* way to the order they should be offered in: the
      // best structural match is the one somebody set aside, and the weakest is
      // the one the record calls current and trusted. A pipeline that stopped
      // consulting any one of the three controls would produce something close
      // to the reverse of this list rather than something subtly different.
      expect(roles).toEqual([...CONTROLS_EXPECTED_ORDER]);
    });

    it('demotes a suppressed Memory without removing it', async () => {
      const outcome = await searchFor(
        evaluationService(owner),
        CONTROLS_CURRENT.role,
        CONTROLS_QUERY,
        CONTROLS_QUERY_FEATURES,
      );
      const roles = rolesOf(outcome);

      expect(roles).toContain('controls-suppressed');
      expect(roles.at(-1)).toBe('controls-suppressed');
      if (outcome.kind !== 'SEARCHED') {
        return;
      }
      const suppressed = outcome.candidates.find(
        (candidate) => candidate.ranking.problemId === idOf('controls-suppressed'),
      );
      expect(suppressed?.ranking.suppressed).toBe(true);
    });
  });

  describe('RESULT_BOUND', () => {
    it('offers five of seven eligible Memories, and cuts by structure', async () => {
      const outcome = await searchFor(
        evaluationService(owner),
        CONTROLS_CURRENT.role,
        CONTROLS_QUERY,
        CONTROLS_QUERY_FEATURES,
      );
      const roles = rolesOf(outcome);

      expect(CONTROLS_CANDIDATES).toHaveLength(7);
      expect(roles).toHaveLength(5);

      // The two left out are current, trusted and unsuppressed — the best
      // controls in the group. They are absent because the reranking stage
      // stops at five, which is what makes the bound its own fact rather than a
      // side effect of ranking.
      for (const role of CONTROLS_BEYOND_BOUND) {
        expect(roles).not.toContain(role);
      }
      expect(roles.every((role) => role.startsWith('controls-'))).toBe(true);
    });

    it('records exactly the Memories it offered', async () => {
      const before = await usageLogCount(owner.ownerId);
      const outcome = await searchFor(
        evaluationService(owner),
        CONTROLS_CURRENT.role,
        CONTROLS_QUERY,
        CONTROLS_QUERY_FEATURES,
      );
      const added = (await usageLogCount(owner.ownerId)) - before;

      if (outcome.kind !== 'SEARCHED') {
        return;
      }
      expect(added).toBe(outcome.candidates.length);
    });
  });

  describe('DEAD_END_MEMORY', () => {
    it('warns about directions already known not to lead anywhere', async () => {
      const outcome = await searchFor(
        evaluationService(owner),
        ENRICHMENT_CURRENT.role,
        ENRICHMENT_QUERY,
        ENRICHMENT_QUERY_FEATURES,
      );
      expect(rolesOf(outcome)).toContain(DEAD_END_MEMORY.role);

      if (outcome.kind !== 'SEARCHED') {
        return;
      }
      const offered = outcome.candidates.find(
        (candidate) => candidate.ranking.problemId === idOf(DEAD_END_MEMORY.role),
      );

      // The words somebody wrote at the time, not the artifact's paraphrase of
      // them. The artifact says "extending the token lifetime for everybody"
      // and is kept for comparing shapes; the warning says what was actually
      // tried and what it cost.
      expect(offered?.deadEndWarnings.map((warning) => warning.summary)).toEqual(
        DEAD_END_EVENTS.map((event) => event.summary),
      );
      expect(offered?.deadEndWarnings[0]?.reason).toBe(DEAD_END_EVENTS[0]?.reason);
      expect(JSON.stringify(offered?.deadEndWarnings)).not.toContain(
        'extending the token lifetime for everybody',
      );
    });

    it('warns without forbidding, and says what would settle it', async () => {
      const outcome = await searchFor(
        evaluationService(owner),
        ENRICHMENT_CURRENT.role,
        ENRICHMENT_QUERY,
        ENRICHMENT_QUERY_FEATURES,
      );
      if (outcome.kind !== 'SEARCHED') {
        return;
      }
      const offered = outcome.candidates.find(
        (candidate) => candidate.ranking.problemId === idOf(DEAD_END_MEMORY.role),
      );

      // Two recorded failures and the Memory is offered anyway, with the
      // conditions it was recorded under and the four checks beside them —
      // which is exactly what makes "an environment difference is a reason to
      // try again" something a caller can act on.
      expect(offered?.deadEndWarnings).toHaveLength(2);
      expect(offered?.revalidation.historicalEnvironment).toEqual(DEAD_END_MEMORY.environment);
      expect(offered?.revalidation.requiredChecks).toEqual([...REVALIDATION_CHECKS]);
      for (const prohibition of ['retryBlocked', 'forbidden', 'hardBlock', 'severity']) {
        expect(JSON.stringify(offered)).not.toContain(prohibition);
      }
    });
  });

  describe('CONFLICTING_MEMORY', () => {
    it('shows the disagreement, with both sides of every comparison', async () => {
      const outcome = await searchFor(
        evaluationService(owner),
        ENRICHMENT_CURRENT.role,
        ENRICHMENT_QUERY,
        ENRICHMENT_QUERY_FEATURES,
      );
      expect(rolesOf(outcome)).toContain(CONFLICTED_MEMORY.role);

      if (outcome.kind !== 'SEARCHED') {
        return;
      }
      const offered = outcome.candidates.find(
        (candidate) => candidate.ranking.problemId === idOf(CONFLICTED_MEMORY.role),
      );
      const contradiction = offered?.conflict.contradictions[0];

      // The five things the specification says to compare, all reachable from
      // this one result: conditions, versions, symptoms, the stated reason and
      // the strength of the checking behind each.
      expect(offered?.revalidation.historicalEnvironment).toEqual(CONFLICTED_MEMORY.environment);
      expect(contradiction?.other.historicalEnvironment).toEqual(CONFLICT_COUNTERPART.environment);
      expect(JSON.stringify(offered?.revalidation.historicalEnvironment)).toContain('rails 7.1.0');
      expect(JSON.stringify(contradiction?.other.historicalEnvironment)).toContain('rails 6.1.7');
      expect(offered?.conflict.subject.symptoms).toBe(CONFLICTED_MEMORY.symptoms);
      expect(contradiction?.other.symptoms).toBe(CONFLICT_COUNTERPART.symptoms);
      expect(contradiction?.reason).toBe(CONFLICT_REASON);
      expect(offered?.revalidation.evidence.map((entry) => entry.summary)).toEqual(
        CONFLICTED_VERIFICATIONS.map((check) => check.summary),
      );
      expect(contradiction?.other.evidence.map((entry) => entry.summary)).toEqual(
        COUNTERPART_VERIFICATIONS.map((check) => check.summary),
      );
    });

    it('names no winner', async () => {
      const outcome = await searchFor(
        evaluationService(owner),
        ENRICHMENT_CURRENT.role,
        ENRICHMENT_QUERY,
        ENRICHMENT_QUERY_FEATURES,
      );
      if (outcome.kind !== 'SEARCHED') {
        return;
      }
      const offered = outcome.candidates.find(
        (candidate) => candidate.ranking.problemId === idOf(CONFLICTED_MEMORY.role),
      );

      // Everything needed to decide is present and nothing decides. The
      // counterpart is the weaker record on both counts, and the server still
      // does not say so.
      expect(offered?.conflict.contradictions).toHaveLength(1);
      expect(offered?.conflict.contradictions[0]?.other.confidence).toBe('MEDIUM');
      expect(offered?.conflict.contradictions[0]?.other.freshness).toBe('STALE_UNKNOWN');
      for (const verdict of ['winner', 'preferred', 'resolved', 'canonical', 'conflictScore']) {
        expect(JSON.stringify(offered?.conflict)).not.toContain(verdict);
      }
    });
  });

  describe('CACHE_REUSE', () => {
    it('answers the same search again without asking the expensive stages', async () => {
      const cache = createRetrievalSearchCache();
      const embedding = createEvaluationEmbeddingProvider();
      const oracle = createFixtureStructuralOracle();
      const service = evaluationService(owner, { cache, embedding, oracle });

      const first = rolesOf(
        await searchFor(service, DELIVERY_CURRENT.role, DELIVERY_QUERY, DELIVERY_QUERY_FEATURES),
      );
      const afterFirst = { embedding: embedding.calls, oracle: oracle.calls };
      const second = rolesOf(
        await searchFor(service, DELIVERY_CURRENT.role, DELIVERY_QUERY, DELIVERY_QUERY_FEATURES),
      );

      expect(afterFirst.embedding).toBeGreaterThan(0);
      expect(afterFirst.oracle).toBeGreaterThan(0);
      // Nothing expensive ran twice, and the answer is the same one.
      expect(embedding.calls).toBe(afterFirst.embedding);
      expect(oracle.calls).toBe(afterFirst.oracle);
      expect(second).toEqual(first);
    });
  });

  describe('the boundaries the corpus is built to test', () => {
    it('never offers another owner’s Memory, however perfectly it matches', async () => {
      const outcome = await searchFor(
        evaluationService(owner),
        DELIVERY_CURRENT.role,
        DELIVERY_QUERY,
        DELIVERY_QUERY_FEATURES,
      );

      // The decoy is written word for word like the query, on the same subject,
      // with the same structure. A boundary that only holds against weak
      // matches is not a boundary.
      expect(rolesOf(outcome)).not.toContain(FOREIGN_DECOY.role);
      if (outcome.kind !== 'SEARCHED') {
        return;
      }
      expect(
        outcome.candidates.some(
          (candidate) => candidate.ranking.problemId === idOf(FOREIGN_DECOY.role),
        ),
      ).toBe(false);
    });

    it('never offers the Problem being worked on', async () => {
      const outcome = await searchFor(
        evaluationService(owner),
        DELIVERY_CURRENT.role,
        DELIVERY_QUERY,
        DELIVERY_QUERY_FEATURES,
      );

      // It is the best match in the corpus for its own query, and offering
      // somebody the Problem they are already looking at is not a memory.
      expect(rolesOf(outcome)).not.toContain(DELIVERY_CURRENT.role);
    });

    it('offers at most five Memories on every scenario', async () => {
      for (const [role, query, features] of [
        [DELIVERY_CURRENT.role, DELIVERY_QUERY, DELIVERY_QUERY_FEATURES],
        [CONTROLS_CURRENT.role, CONTROLS_QUERY, CONTROLS_QUERY_FEATURES],
        [ENRICHMENT_CURRENT.role, ENRICHMENT_QUERY, ENRICHMENT_QUERY_FEATURES],
      ] as const) {
        const outcome = await searchFor(evaluationService(owner), role, query, features);
        if (outcome.kind !== 'SEARCHED') {
          throw new Error(`The ${role} search did not run.`);
        }
        expect(outcome.candidates.length).toBeGreaterThan(0);
        expect(outcome.candidates.length).toBeLessThanOrEqual(5);
        // And the offered positions are the positions actually offered.
        expect(outcome.candidates.map((candidate) => candidate.ranking.rankingRank)).toEqual(
          outcome.candidates.map((_, index) => index + 1),
        );
      }
    });
  });

  /** How many Memories this owner has been recorded as being shown. */
  async function usageLogCount(ownerId: OwnerId): Promise<number> {
    const rows = await pool.query<{ count: string }>(
      'select count(*)::text as count from public.usage_logs where owner_id = $1',
      [ownerId],
    );
    return Number(rows.rows[0]?.count ?? '0');
  }
});
