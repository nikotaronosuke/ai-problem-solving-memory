/**
 * Reconciliation: the sweep that finds what needs generating, and only that.
 *
 * The most load-bearing assertion in this file is the quiet one — a database
 * whose artifacts are all current answers with nothing, however often the
 * sweep runs. Everything else is classification: missing rows, rows from
 * another source schema, rows from another generation stack, each found for
 * the stated reason, with read-disabled and deleted Problems never on the
 * list and another owner's rows never visible.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createRetrievalArtifactReconciliationService,
  type RetrievalGenerationRequests,
} from '../../src/app/index.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import { generateOwnerId, type OwnerContext, type OwnerId } from '../../src/domain/owner.js';
import type { ProblemId } from '../../src/domain/problem.js';
import type { RetrievalGenerationProfile } from '../../src/domain/retrieval-generation-profile.js';
import { resolveOwnerContextFor } from '../../src/owner/context.js';
import {
  createMemoryRepository,
  createRetrievalArtifactReconciliationReader,
  createRetrievalArtifactRepository,
  type MemoryRepository,
  type RetrievalArtifactRepository,
} from '../../src/repository/index.js';
import {
  createArtifactInspectionPolicy,
  createSecretDetectionPolicy,
  withSanitization,
} from '../../src/sanitization/index.js';

const databaseUrl = process.env['DATABASE_URL'];

/** The stack the fixtures pretend is configured. */
const PROFILE: RetrievalGenerationProfile = {
  summaryGeneratorId: 'fixture-summary-generator',
  summaryGeneratorVersion: '1',
  semantic: {
    embeddingModel: 'fixture-model',
    embeddingModelVersion: '1',
    embeddingDimensions: 3,
  },
};

interface Actor {
  readonly ownerId: OwnerId;
  readonly context: OwnerContext;
  readonly memory: MemoryRepository;
  readonly artifacts: RetrievalArtifactRepository;
}

describe.skipIf(databaseUrl === undefined)('artifact reconciliation', () => {
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

  async function makeProblem(actor: Actor): Promise<ProblemId> {
    const project = await actor.memory.createProject({ projectName: `project ${randomUUID()}` });
    const environment = await actor.memory.createEnvironment({
      projectId: project.projectId,
      snapshot: { runtime: 'node 22.12.0' },
    });
    const problem = await actor.memory.createProblem({
      projectId: project.projectId,
      environmentId: environment.environmentId,
      title: 'a seeded title',
      symptoms: 'seeded symptoms',
    });
    return problem.problemId;
  }

  /** An artifact from exactly the configured stack, current in every way. */
  async function currentArtifact(
    actor: Actor,
    problemId: ProblemId,
    overrides: {
      readonly generatorId?: string;
      readonly generatorVersion?: string;
      readonly model?: string;
      readonly modelVersion?: string;
      readonly embedding?: readonly number[];
      readonly fingerprint?: string;
      readonly structuralSchemaVersion?: string;
    } = {},
  ): Promise<void> {
    await actor.artifacts.upsertArtifact({
      problemId,
      normalizedSummary: 'a rendering',
      keywords: ['seeded'],
      structuralFeatures: {
        schema_version: overrides.structuralSchemaVersion ?? '1',
        problem_domain: null,
        symptom_patterns: [],
        suspected_boundaries: [],
        occurrence_conditions: [],
        successful_directions: [],
        dead_end_directions: [],
        environment_facts: [],
      },
      summaryGeneratorId: overrides.generatorId ?? PROFILE.summaryGeneratorId,
      summaryGeneratorVersion: overrides.generatorVersion ?? PROFILE.summaryGeneratorVersion,
      semantic: {
        embedding: [...(overrides.embedding ?? [1, 0, 0])],
        embeddingModel: overrides.model ?? PROFILE.semantic!.embeddingModel,
        embeddingModelVersion: overrides.modelVersion ?? PROFILE.semantic!.embeddingModelVersion,
      },
      sourceFingerprint:
        overrides.fingerprint ?? `retrieval-source-v1:${randomUUID().replace(/-/g, '')}`,
      generatedAt: new Date('2026-08-17T09:00:00.000Z'),
    });
  }

  function readerFor(actor: Actor) {
    return createRetrievalArtifactReconciliationReader(pool, actor.context);
  }

  /** A scheduler double that records what was asked of it. */
  function recordingRequests(): RetrievalGenerationRequests & { requested: ProblemId[] } {
    const requested: ProblemId[] = [];
    return {
      requested,
      request(problemId) {
        requested.push(problemId);
      },
    };
  }

  it('finds a Problem with no artifact at all', async () => {
    const actor = await makeActor();
    const problemId = await makeProblem(actor);

    const findings = await readerFor(actor).findProblemsNeedingGeneration(PROFILE);

    expect(findings).toEqual([{ problemId, reason: 'ARTIFACT_MISSING' }]);
  });

  it('finds an artifact from another source schema, as hard-incompatible', async () => {
    const actor = await makeActor();
    const problemId = await makeProblem(actor);
    await currentArtifact(actor, problemId, { fingerprint: 'retrieval-source-v0:legacy' });

    const findings = await readerFor(actor).findProblemsNeedingGeneration(PROFILE);

    expect(findings).toEqual([{ problemId, reason: 'SOURCE_SCHEMA_INCOMPATIBLE' }]);
  });

  it('finds every way a generation stack can be outdated', async () => {
    const actor = await makeActor();

    for (const overrides of [
      { generatorId: 'another-generator' },
      { generatorVersion: '2' },
      { model: 'another-model' },
      { modelVersion: '2' },
      { embedding: [1, 0] },
      { structuralSchemaVersion: '0' },
    ]) {
      const problemId = await makeProblem(actor);
      await currentArtifact(actor, problemId, overrides);

      const findings = await readerFor(actor).findProblemsNeedingGeneration(PROFILE);
      expect(
        findings.some(
          (finding) =>
            finding.problemId === problemId && finding.reason === 'GENERATION_PROFILE_OUTDATED',
        ),
        `overrides ${JSON.stringify(overrides)} were not found`,
      ).toBe(true);

      // Reset for the next case, so each mismatch is measured on its own.
      await currentArtifact(actor, problemId, {});
    }
  });

  it('finds nothing when everything is current, however often it runs', async () => {
    const actor = await makeActor();
    const problemId = await makeProblem(actor);
    await currentArtifact(actor, problemId);

    const reader = readerFor(actor);
    for (let sweep = 0; sweep < 3; sweep += 1) {
      expect(await reader.findProblemsNeedingGeneration(PROFILE)).toEqual([]);
    }
  });

  it('never lists a read-disabled Problem', async () => {
    const actor = await makeActor();
    const problemId = await makeProblem(actor);
    const problem = await actor.memory.getProblem(problemId);
    await actor.memory.updateProblem(problemId, problem?.version ?? 0, {
      memoryReadEnabled: false,
    });

    // Missing artifact and disabled reading: the sweep's output is a list of
    // Problems whose source will be handed to a generator, and the owner said
    // no. Not on the list.
    expect(await readerFor(actor).findProblemsNeedingGeneration(PROFILE)).toEqual([]);
  });

  it('never lists another owner or a deleted Problem', async () => {
    const actor = await makeActor();
    const stranger = await makeActor();
    const own = await makeProblem(actor);
    await makeProblem(stranger);

    const findings = await readerFor(actor).findProblemsNeedingGeneration(PROFILE);
    expect(findings.map((finding) => finding.problemId)).toEqual([own]);

    const problem = await actor.memory.getProblem(own);
    await actor.memory.deleteProblem(own, problem?.version ?? 0);
    expect(await readerFor(actor).findProblemsNeedingGeneration(PROFILE)).toEqual([]);
  });

  it('bounds the scan and keeps the oldest first', async () => {
    const actor = await makeActor();
    const first = await makeProblem(actor);
    const second = await makeProblem(actor);
    const third = await makeProblem(actor);

    const findings = await readerFor(actor).findProblemsNeedingGeneration(PROFILE, 2);

    expect(findings.map((finding) => finding.problemId)).toEqual([first, second]);
    expect(findings.map((finding) => finding.problemId)).not.toContain(third);
  });

  it('refuses a blank profile and a nonsense limit', async () => {
    const actor = await makeActor();
    const reader = readerFor(actor);

    await expect(
      reader.findProblemsNeedingGeneration({
        ...PROFILE,
        semantic: { ...PROFILE.semantic!, embeddingModel: '  ' },
      }),
    ).rejects.toThrow();
    await expect(reader.findProblemsNeedingGeneration(PROFILE, 0)).rejects.toThrow();
  });

  describe('the one-shot service', () => {
    it('requests exactly what the sweep found, and reports it by kind', async () => {
      const actor = await makeActor();
      const missing = await makeProblem(actor);
      const legacy = await makeProblem(actor);
      await currentArtifact(actor, legacy, { fingerprint: 'retrieval-source-v0:legacy' });
      const outdated = await makeProblem(actor);
      await currentArtifact(actor, outdated, { model: 'another-model' });
      const current = await makeProblem(actor);
      await currentArtifact(actor, current);

      const requests = recordingRequests();
      const service = createRetrievalArtifactReconciliationService(
        readerFor(actor),
        requests,
        PROFILE,
      );

      const report = await service.reconcile();

      expect(report).toEqual({
        requested: 3,
        artifactMissing: 1,
        sourceSchemaIncompatible: 1,
        generationProfileOutdated: 1,
      });
      expect(requests.requested.sort()).toEqual([missing, legacy, outdated].sort());
      expect(requests.requested).not.toContain(current);
    });

    it('does nothing at all over an up-to-date store', async () => {
      const actor = await makeActor();
      const problemId = await makeProblem(actor);
      await currentArtifact(actor, problemId);

      const requests = recordingRequests();
      const service = createRetrievalArtifactReconciliationService(
        readerFor(actor),
        requests,
        PROFILE,
      );

      expect(await service.reconcile()).toEqual({
        requested: 0,
        artifactMissing: 0,
        sourceSchemaIncompatible: 0,
        generationProfileOutdated: 0,
      });
      expect(requests.requested).toEqual([]);
    });
  });
});
