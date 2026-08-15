/**
 * The retrieval artifact, against a real database.
 *
 * What is being checked is mostly what an artifact is *not*. It is not a source
 * of truth, so writing one must leave every Memory table exactly as it was. It
 * is not owned by whoever asks for it, so an artifact naming one owner and
 * another owner's Problem has to be unstorable rather than merely unwritten. It
 * is not a history, so a second generation replaces the first rather than
 * joining it. And it is not exempt from the privacy boundary because it is
 * derived — a summary is new text, and new text is inspected.
 *
 * Nothing here generates anything. P4-01 owns storage; the summaries,
 * keywords, features and embeddings below are fixtures a later task will
 * produce for real. The embeddings are short and arbitrary on purpose: this
 * file must not encode a dimension, because fixing one would fix a model.
 *
 * Skipped when `DATABASE_URL` is not set.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readDatabaseUrl } from '../../src/config/env.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { ProblemNotAvailableError } from '../../src/db/errors.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import { resolveOwnerContextFor } from '../../src/owner/context.js';
import { generateOwnerId, type OwnerId, type OwnerContext } from '../../src/domain/owner.js';
import type { ProblemId } from '../../src/domain/problem.js';
import { toClientEventId } from '../../src/domain/client-event-id.js';
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
  withSanitization,
} from '../../src/sanitization/index.js';

const databaseUrl = readDatabaseUrl();

/** Every table holding Memory content — the things an artifact must not touch. */
const MEMORY_TABLES = [
  'projects',
  'environments',
  'problems',
  'events',
  'verifications',
  'relations',
  'usage_logs',
  'change_logs',
] as const;

interface Actor {
  readonly ownerId: OwnerId;
  readonly context: OwnerContext;
  readonly memory: MemoryRepository;
  readonly artifacts: RetrievalArtifactRepository;
  readonly problemId: ProblemId;
  readonly projectId: string;
}

describe.skipIf(databaseUrl === undefined)('a problem’s retrieval artifact', () => {
  let pool: DatabasePool;
  const ownersCreated: OwnerId[] = [];

  /** Wired exactly as `request-context.ts` wires it, policies included. */
  async function makeActor(tag: string): Promise<Actor> {
    const ownerId = generateOwnerId();
    await insertOwnerIfAbsent(pool, ownerId);
    ownersCreated.push(ownerId);

    const context = await resolveOwnerContextFor(pool, ownerId);
    const memory = withSanitization(
      createMemoryRepository(pool, context),
      createSecretDetectionPolicy(),
    );
    const artifacts = withSanitization(
      createRetrievalArtifactRepository(pool, context),
      createArtifactInspectionPolicy(),
    );

    const project = await memory.createProject({ projectName: `${tag} project` });
    const environment = await memory.createEnvironment({
      projectId: project.projectId,
      snapshot: { runtime: 'node 22.12.0' },
    });
    const problem = await memory.createProblem({
      projectId: project.projectId,
      environmentId: environment.environmentId,
      title: `${tag} problem`,
      symptoms: `${tag} symptoms`,
    });

    return {
      ownerId,
      context,
      memory,
      artifacts,
      problemId: problem.problemId,
      projectId: project.projectId,
    };
  }

  /** A complete artifact. Every field, because a partial one is not a state. */
  function artifactFor(
    problemId: ProblemId,
    overrides: Partial<UpsertRetrievalArtifactInput> = {},
  ): UpsertRetrievalArtifactInput {
    return {
      problemId,
      normalizedSummary: 'a callback fails only after deployment',
      keywords: ['callback', 'deployment', 'redirect'],
      structuralFeatures: { boundary: 'configuration', shape: 'environment-dependent' },
      embedding: [0.25, -0.5, 0.125],
      summaryGeneratorId: 'fixture-summary-generator',
      summaryGeneratorVersion: '1',
      embeddingModel: 'fixture-model',
      embeddingModelVersion: '1',
      sourceFingerprint: 'source-state-A',
      generatedAt: new Date('2026-08-15T10:00:00.000Z'),
      ...overrides,
    };
  }

  /** Every Memory row an owner has, as text. Used to prove nothing moved. */
  async function memoryFingerprint(ownerId: OwnerId): Promise<string> {
    const dumps: string[] = [];
    for (const table of MEMORY_TABLES) {
      const rows = await pool.query(
        `select to_jsonb(t) as row from public.${table} t
          where owner_id = $1 order by to_jsonb(t)::text`,
        [ownerId],
      );
      dumps.push(`${table}:${JSON.stringify(rows.rows)}`);
    }
    return dumps.join('\n');
  }

  const artifactRows = async (ownerId: OwnerId, problemId: string): Promise<number> =>
    Number(
      (
        await pool.query<{ n: string }>(
          `select count(*) as n from public.retrieval_artifacts
            where owner_id = $1 and problem_id = $2`,
          [ownerId, problemId],
        )
      ).rows[0]?.n ?? '0',
    );

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

  describe('storing one', () => {
    it('reads back exactly what was written', async () => {
      const actor = await makeActor('roundtrip');
      const input = artifactFor(actor.problemId);

      const written = await actor.artifacts.upsertArtifact(input);
      const read = await actor.artifacts.getArtifact(actor.problemId);

      expect(written.ownerId).toBe(actor.ownerId);
      expect(written.problemId).toBe(actor.problemId);
      expect(read).toEqual(written);
      // Provenance survives the round trip. Model and version are free text,
      // and the fingerprint is opaque — stored and compared, never parsed.
      expect(read?.embeddingModel).toBe('fixture-model');
      expect(read?.embeddingModelVersion).toBe('1');
      expect(read?.sourceFingerprint).toBe('source-state-A');
      expect(read?.generatedAt.toISOString()).toBe('2026-08-15T10:00:00.000Z');
      expect(read?.embedding).toEqual([0.25, -0.5, 0.125]);
      expect(read?.keywords).toEqual(['callback', 'deployment', 'redirect']);
      expect(read?.structuralFeatures).toEqual({
        boundary: 'configuration',
        shape: 'environment-dependent',
      });
    });

    it('is absent until something writes one', async () => {
      const actor = await makeActor('absent');

      // Every Problem starts here, and nothing generates artifacts yet, so
      // this is the ordinary state rather than an edge case.
      expect(await actor.artifacts.getArtifact(actor.problemId)).toBeUndefined();
      expect(await artifactRows(actor.ownerId, actor.problemId)).toBe(0);
    });

    it('keeps an empty keyword list, which is a real answer', async () => {
      const actor = await makeActor('no-keywords');

      const written = await actor.artifacts.upsertArtifact(
        artifactFor(actor.problemId, { keywords: [] }),
      );

      expect(written.keywords).toEqual([]);
    });
  });

  describe('regenerating', () => {
    it('replaces the current artifact rather than adding one', async () => {
      const actor = await makeActor('replace');

      await actor.artifacts.upsertArtifact(artifactFor(actor.problemId));
      const second = await actor.artifacts.upsertArtifact(
        artifactFor(actor.problemId, {
          normalizedSummary: 'a second reading of the same problem',
          keywords: ['second'],
          embedding: [0.75, 0.25, 0.5, 0.125],
          summaryGeneratorId: 'fixture-summary-generator',
          summaryGeneratorVersion: '1',
          embeddingModel: 'fixture-model-2',
          embeddingModelVersion: '4',
          sourceFingerprint: 'source-state-B',
          generatedAt: new Date('2026-08-15T11:00:00.000Z'),
        }),
      );

      // One row, not two: an artifact is what a Problem currently looks like
      // to a search, and a history would make a search choose.
      expect(await artifactRows(actor.ownerId, actor.problemId)).toBe(1);

      const read = await actor.artifacts.getArtifact(actor.problemId);
      expect(read).toEqual(second);
      expect(read?.normalizedSummary).toBe('a second reading of the same problem');
      expect(read?.sourceFingerprint).toBe('source-state-B');
      expect(read?.embedding).toEqual([0.75, 0.25, 0.5, 0.125]);
    });

    it('accepts an earlier generated_at, because storage does not judge freshness', async () => {
      const actor = await makeActor('earlier');

      await actor.artifacts.upsertArtifact(
        artifactFor(actor.problemId, { generatedAt: new Date('2026-08-15T12:00:00.000Z') }),
      );
      const older = await actor.artifacts.upsertArtifact(
        artifactFor(actor.problemId, {
          generatedAt: new Date('2026-08-15T09:00:00.000Z'),
          sourceFingerprint: 'source-state-older',
        }),
      );

      // Deliberate. A generation that read the source first and finished last
      // carries a later timestamp for an earlier state, so "newer timestamp"
      // does not mean "newer source" — and a storage primitive that refused on
      // that basis would refuse the right write about half the time. Whether a
      // generated artifact still describes the current Memory is decided by
      // whatever read the source, using the fingerprint.
      expect(older.generatedAt.toISOString()).toBe('2026-08-15T09:00:00.000Z');
      expect((await actor.artifacts.getArtifact(actor.problemId))?.sourceFingerprint).toBe(
        'source-state-older',
      );
    });

    it('lets different problems carry different embedding dimensions', async () => {
      const short = await makeActor('short-vector');
      const long = await makeActor('long-vector');

      await short.artifacts.upsertArtifact(artifactFor(short.problemId, { embedding: [1, 2, 3] }));
      await long.artifacts.upsertArtifact(
        artifactFor(long.problemId, { embedding: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6] }),
      );

      // The column is an untyped `vector`, which is what keeps a model change
      // from being a schema change. Two Problems mid-migration hold different
      // dimensions; one Problem never holds two artifacts, which is why this
      // is written across two rather than as a second write to one.
      expect((await short.artifacts.getArtifact(short.problemId))?.embedding).toHaveLength(3);
      expect((await long.artifacts.getArtifact(long.problemId))?.embedding).toHaveLength(6);
    });
  });

  describe('the source it was made from', () => {
    it('is not touched by writing an artifact', async () => {
      const actor = await makeActor('untouched');
      await actor.memory.appendEvent({
        problemId: actor.problemId,
        eventType: 'DISCOVERY',
        summary: 'something observed',
        clientEventId: toClientEventId(randomUUID()),
      });

      const before = await memoryFingerprint(actor.ownerId);
      await actor.artifacts.upsertArtifact(artifactFor(actor.problemId));
      await actor.artifacts.upsertArtifact(
        artifactFor(actor.problemId, { sourceFingerprint: 'source-state-B' }),
      );

      // The whole point of the separation. Generating a rendering of a Memory
      // must never be a way to change the Memory — not its version, not its
      // timestamps, not a change log entry.
      expect(await memoryFingerprint(actor.ownerId)).toBe(before);
    });

    it('must exist, and must be the same owner’s', async () => {
      const actor = await makeActor('fk');
      const stranger = await makeActor('fk-stranger');

      // A Problem nobody has.
      await expect(
        actor.artifacts.upsertArtifact(artifactFor(randomUUID() as ProblemId)),
      ).rejects.toBeInstanceOf(ProblemNotAvailableError);

      // A Problem somebody else has. The foreign key is composite, so this is
      // refused by the database rather than by the code above it.
      await expect(
        actor.artifacts.upsertArtifact(artifactFor(stranger.problemId)),
      ).rejects.toBeInstanceOf(ProblemNotAvailableError);

      expect(await artifactRows(actor.ownerId, stranger.problemId)).toBe(0);
      expect(await artifactRows(stranger.ownerId, stranger.problemId)).toBe(0);
    });
  });

  describe('the owner boundary', () => {
    it('does not hand one owner’s artifact to another', async () => {
      const mine = await makeActor('mine');
      const theirs = await makeActor('theirs');

      await theirs.artifacts.upsertArtifact(
        artifactFor(theirs.problemId, {
          normalizedSummary: 'a summary belonging to somebody else',
        }),
      );

      // Answered the same way as a Problem that does not exist: absent.
      expect(await mine.artifacts.getArtifact(theirs.problemId)).toBeUndefined();
      expect(await mine.artifacts.getArtifact(randomUUID() as ProblemId)).toBeUndefined();

      // And still there for the owner it belongs to.
      expect((await theirs.artifacts.getArtifact(theirs.problemId))?.normalizedSummary).toBe(
        'a summary belonging to somebody else',
      );
    });
  });
});
