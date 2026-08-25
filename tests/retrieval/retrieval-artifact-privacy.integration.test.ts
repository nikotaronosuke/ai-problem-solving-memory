/**
 * A retrieval artifact carrying a credential is refused whole.
 *
 * Being derived is not an exemption. An artifact is long-lived persistent data,
 * and the text in it is *new* — a summary is written by a generator, not copied
 * from the Memory — so a source that was clean does not make the artifact
 * clean. The specification's answer to secrets is a check on the server side of
 * every write, and this is a write.
 *
 * Refused rather than redacted, which is the part worth being careful about. A
 * Memory can be redacted because what is stored is the text: remove the
 * credential and the sentence still says what somebody wrote. An artifact is
 * several renderings of one source and one of them is an embedding, computed
 * from the text *before* any redaction could apply. Redacting the summary would
 * leave a row whose words read `[REDACTED]` and whose vector still encodes what
 * was taken out — and the half that cannot be read is the half that would still
 * be wrong. So the row is not written at all.
 *
 * Every fixture is synthetic.
 *
 * Skipped when `DATABASE_URL` is not set.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readDatabaseUrl } from '../../src/config/env.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import { resolveOwnerContextFor } from '../../src/owner/context.js';
import { generateOwnerId, type OwnerId } from '../../src/domain/owner.js';
import type { ProblemId } from '../../src/domain/problem.js';
import {
  createMemoryRepository,
  createRetrievalArtifactRepository,
  type MemoryRepository,
  type RetrievalArtifactRepository,
  type UpsertRetrievalArtifactInput,
} from '../../src/repository/index.js';
import {
  createArtifactInspectionPolicy,
  createSecretDetectionPolicy,
  SanitizationRejectedError,
  withSanitization,
} from '../../src/sanitization/index.js';

const databaseUrl = readDatabaseUrl();

/** Synthetic, each with a distinctive tail so a sweep can name what leaked. */
const SECRET = {
  inSummary: 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/fakeAa1Qv7X0123456789',
  inKeyword: 'API_KEY=fake-Bb2Lm2P-0123456789abcdef',
  inFeature: 'client_secret=fake-Cc3Tr8K-0123456789abcdef',
  inFeatureKey: 'PASSWORD=fake-Dd4Nw5J-0123456789',
  // The nested form the Phase 3 audit found, which read as prose until F1 was
  // closed. Included so the artifact boundary is known to see it too.
  nested: 'ran x=AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/fakeEe5Bz3Q0123456789 then failed',
} as const;

const MARKERS = ['Aa1Qv7X', 'Bb2Lm2P', 'Cc3Tr8K', 'Dd4Nw5J', 'Ee5Bz3Q'] as const;

describe.skipIf(databaseUrl === undefined)('a retrieval artifact holding a credential', () => {
  let pool: DatabasePool;
  let ownerId: OwnerId;
  let memory: MemoryRepository;
  let artifacts: RetrievalArtifactRepository;
  let problemId: ProblemId;
  const ownersCreated: OwnerId[] = [];

  function artifactFor(
    overrides: Partial<UpsertRetrievalArtifactInput> = {},
  ): UpsertRetrievalArtifactInput {
    return {
      problemId,
      normalizedSummary: 'an ordinary summary of an ordinary problem',
      keywords: ['deployment', 'callback'],
      structuralFeatures: { boundary: 'configuration' },
      summaryGeneratorId: 'fixture-summary-generator',
      summaryGeneratorVersion: '1',
      // Always present, so a rejection is known to discard a *complete*
      // candidate rather than one that was going to fail anyway.
      semantic: {
        embedding: [0.5, 0.25, 0.125],
        embeddingModel: 'fixture-model',
        embeddingModelVersion: '1',
      },
      sourceFingerprint: 'source-state-A',
      generatedAt: new Date('2026-08-15T10:00:00.000Z'),
      ...overrides,
    };
  }

  const artifactCount = async (): Promise<number> =>
    Number(
      (
        await pool.query<{ n: string }>(
          `select count(*) as n from public.retrieval_artifacts where owner_id = $1`,
          [ownerId],
        )
      ).rows[0]?.n ?? '0',
    );

  /** Everything this owner has, artifacts included, as text. */
  async function everythingStored(): Promise<string> {
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
        `select to_jsonb(t) as row from public.${table} t where owner_id = $1`,
        [ownerId],
      );
      dumps.push(JSON.stringify(rows.rows));
    }
    return dumps.join('\n');
  }

  beforeAll(async () => {
    pool = createPool(resolveDatabaseConfig({ nodeEnv: 'test', connectionTimeoutMillis: 5_000 }));
    ownerId = generateOwnerId();
    await insertOwnerIfAbsent(pool, ownerId);
    ownersCreated.push(ownerId);

    const context = await resolveOwnerContextFor(pool, ownerId);
    memory = withSanitization(createMemoryRepository(pool, context), createSecretDetectionPolicy());
    artifacts = withSanitization(
      createRetrievalArtifactRepository(pool, context),
      createArtifactInspectionPolicy(),
    );

    const project = await memory.createProject({ projectName: 'artifact privacy' });
    const environment = await memory.createEnvironment({
      projectId: project.projectId,
      snapshot: { runtime: 'node 22.12.0' },
    });
    const problem = await memory.createProblem({
      projectId: project.projectId,
      environmentId: environment.environmentId,
      title: 'a problem worth summarising',
      symptoms: 'it fails after deployment',
    });
    problemId = problem.problemId;
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

  it.each([
    ['the summary', () => artifactFor({ normalizedSummary: `deploy failed: ${SECRET.inSummary}` })],
    ['a nested assignment in the summary', () => artifactFor({ normalizedSummary: SECRET.nested })],
    ['a keyword', () => artifactFor({ keywords: ['deployment', SECRET.inKeyword] })],
    [
      'a structural feature value',
      () => artifactFor({ structuralFeatures: { boundary: SECRET.inFeature } }),
    ],
    [
      'a nested structural feature value',
      () =>
        artifactFor({
          structuralFeatures: { boundary: { detail: { observed: SECRET.inFeature } } },
        }),
    ],
    [
      'a structural feature key',
      () => artifactFor({ structuralFeatures: { [SECRET.inFeatureKey]: 'present' } }),
    ],
    [
      'the embedding model name',
      () =>
        artifactFor({
          semantic: {
            embedding: [0.5, 0.25, 0.125],
            embeddingModel: SECRET.inKeyword,
            embeddingModelVersion: '1',
          },
        }),
    ],
    ['the source fingerprint', () => artifactFor({ sourceFingerprint: SECRET.inSummary })],
  ])('is refused when %s carries one', async (_label, build) => {
    const before = await artifactCount();

    await expect(artifacts.upsertArtifact(build())).rejects.toBeInstanceOf(
      SanitizationRejectedError,
    );

    // Whole-write rejection: no row, and in particular no row holding the
    // embedding that was computed from the text being refused.
    expect(await artifactCount()).toBe(before);
  });

  it('leaves nothing of any refused candidate anywhere', async () => {
    const stored = await everythingStored();

    for (const marker of MARKERS) {
      expect(stored, `marker ${marker} reached storage`).not.toContain(marker);
    }
    // And the Problem the artifacts were about is untouched — a refused
    // artifact is not a reason for a Memory to change.
    expect(stored).toContain('a problem worth summarising');
  });

  it('still stores an artifact that only talks about credentials', async () => {
    // The false-positive half of the contract, which matters as much. A
    // summary may say a token expired; the certainty line is the same one the
    // write boundary and the export draw.
    const written = await artifacts.upsertArtifact(
      artifactFor({
        normalizedSummary: 'the access token had expired, so the callback returned 401',
        keywords: ['token', 'expired'],
        structuralFeatures: { boundary: 'authentication', detail: 'password: unknown' },
      }),
    );

    expect(written.normalizedSummary).toBe(
      'the access token had expired, so the callback returned 401',
    );
    expect(await artifactCount()).toBe(1);
  });

  it('refuses a credential without disturbing the artifact already there', async () => {
    // The row from the previous test is current. A refused regeneration must
    // not replace it, empty it, or leave it half written.
    const before = await artifacts.getArtifact(problemId);
    expect(before).toBeDefined();

    await expect(
      artifacts.upsertArtifact(
        artifactFor({
          normalizedSummary: `a regeneration carrying ${SECRET.inSummary}`,
          sourceFingerprint: 'source-state-B',
        }),
      ),
    ).rejects.toBeInstanceOf(SanitizationRejectedError);

    expect(await artifacts.getArtifact(problemId)).toEqual(before);
    expect(await artifactCount()).toBe(1);
  });

  it('refuses one whose embedding is not a number', async () => {
    // Storage-level rather than privacy, but the same principle: a row that
    // saves cleanly and breaks every later search is the worst outcome, so
    // NaN and Infinity are refused rather than stored.
    await expect(
      artifacts.upsertArtifact(
        artifactFor({
          semantic: {
            embedding: [1, Number.NaN, 3],
            embeddingModel: 'fixture-model',
            embeddingModelVersion: '1',
          },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      artifacts.upsertArtifact(
        artifactFor({
          semantic: {
            embedding: [1, Number.POSITIVE_INFINITY],
            embeddingModel: 'fixture-model',
            embeddingModelVersion: '1',
          },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      artifacts.upsertArtifact(
        artifactFor({
          semantic: { embedding: [], embeddingModel: 'fixture-model', embeddingModelVersion: '1' },
        }),
      ),
    ).rejects.toThrow();

    expect(await artifactCount()).toBe(1);
    expect(randomUUID).toBeDefined();
  });
});
