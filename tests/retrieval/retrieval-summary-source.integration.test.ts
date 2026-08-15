/**
 * What a summary generator is shown, read from a real database.
 *
 * Two claims are being established here, and they are the ones the rest of the
 * task rests on.
 *
 * **The document contains exactly what it should.** Every semantic field, all
 * six Event types, both Verification outcomes, the Environment — and none of
 * the identifiers, timestamps, authorship or judgement fields. The proof of the
 * exclusions is stronger than an assertion about a field list: two Problems
 * built with the same content, in different projects, on different
 * Environments, with different identifiers and different creation times,
 * produce byte-identical documents. Nothing that differs between them is in it.
 *
 * **The digest tracks meaning, not storage.** It changes when the investigation
 * changes and holds still when something about how the Memory is judged
 * changes — confidence, freshness, importance, suppression, the memory
 * controls. A summary regenerated because somebody adjusted a confidence would
 * be work done for no reason, and one *not* regenerated after a `DEAD_END` was
 * recorded would be a summary that quietly no longer describes its Problem.
 *
 * Skipped when `DATABASE_URL` is not set.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readDatabaseUrl } from '../../src/config/env.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import { RETRIEVAL_SUMMARY_SOURCE_STATEMENT } from '../../src/db/retrieval-summary-source.js';
import { toClientEventId } from '../../src/domain/client-event-id.js';
import { generateOwnerId, type OwnerContext, type OwnerId } from '../../src/domain/owner.js';
import type { ProblemId } from '../../src/domain/problem.js';
import { fingerprintRetrievalSource } from '../../src/domain/retrieval-summary.js';
import { resolveOwnerContextFor } from '../../src/owner/context.js';
import {
  createMemoryRepository,
  createRetrievalSummarySourceReader,
  type MemoryRepository,
  type RetrievalSummarySourceReader,
} from '../../src/repository/index.js';
import { createSecretDetectionPolicy, withSanitization } from '../../src/sanitization/index.js';

const databaseUrl = readDatabaseUrl();

interface Actor {
  readonly ownerId: OwnerId;
  readonly context: OwnerContext;
  readonly memory: MemoryRepository;
  readonly source: RetrievalSummarySourceReader;
}

describe.skipIf(databaseUrl === undefined)('the source a retrieval summary is built from', () => {
  let pool: DatabasePool;
  let actor: Actor;
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
      source: createRetrievalSummarySourceReader(pool, context),
    };
  }

  /** A Problem with an Environment of its own, ready to be added to. */
  async function makeProblem(
    owner: Actor,
    tag: string,
    snapshot: Record<string, unknown> = { runtime: 'node 22.12.0' },
  ): Promise<ProblemId> {
    const project = await owner.memory.createProject({ projectName: `${tag} project` });
    const environment = await owner.memory.createEnvironment({
      projectId: project.projectId,
      snapshot,
    });
    const problem = await owner.memory.createProblem({
      projectId: project.projectId,
      environmentId: environment.environmentId,
      title: `${tag} title`,
      symptoms: `${tag} symptoms`,
      problemDomain: 'deployment',
      suspectedBoundary: 'configuration',
    });
    return problem.problemId;
  }

  /**
   * An Environment written straight to the column.
   *
   * The repository takes a JavaScript object, and a JavaScript object cannot
   * express either thing these tests are about: a key order that survives to
   * the database, or an integer larger than a double. So the JSON text goes to
   * PostgreSQL untouched. The identifier is supplied because the column has no
   * default — identifiers are minted in the domain here, not by the database.
   */
  async function insertRawEnvironment(projectId: string, snapshot: string): Promise<never> {
    const environmentId = randomUUID();
    await pool.query(
      `insert into public.environments (environment_id, owner_id, project_id, snapshot)
            values ($1, $2, $3, $4::jsonb)`,
      [environmentId, actor.ownerId, projectId, snapshot],
    );
    return environmentId as never;
  }

  /** The document, parsed. Not used where exact digits matter. */
  async function documentFor(problemId: ProblemId): Promise<Record<string, unknown>> {
    const read = await actor.source.readSource(problemId);
    expect(read).toBeDefined();
    return JSON.parse(read?.canonicalSource ?? '{}') as Record<string, unknown>;
  }

  async function fingerprintFor(problemId: ProblemId): Promise<string> {
    const read = await actor.source.readSource(problemId);
    expect(read).toBeDefined();
    return fingerprintRetrievalSource(read?.canonicalSource ?? '');
  }

  beforeAll(async () => {
    pool = createPool(resolveDatabaseConfig({ nodeEnv: 'test', connectionTimeoutMillis: 5_000 }));
    actor = await makeActor();
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

  describe('the document', () => {
    it('is one statement, so it is one snapshot', () => {
      // The claim the whole design rests on: four reads would take four
      // snapshots and could assemble a state that never existed. Asserted
      // against the statement itself, because "one query" is a property of
      // the text rather than of the function that runs it.
      expect(RETRIEVAL_SUMMARY_SOURCE_STATEMENT).not.toContain(';');
      expect(RETRIEVAL_SUMMARY_SOURCE_STATEMENT.match(/pr\.owner_id = \$1/g)).toHaveLength(1);
    });

    it('carries the Problem, its Environment and its record', async () => {
      const problemId = await makeProblem(actor, 'inventory');
      await actor.memory.appendEvent({
        problemId,
        eventType: 'DISCOVERY',
        summary: 'the redirect host is read at build time',
        clientEventId: toClientEventId('c9f1c1f0-0000-4000-8000-000000000001'),
      });
      await actor.memory.appendVerification({
        problemId,
        verificationType: 'TEST',
        result: true,
        summary: 'the suite passes against the deployed build',
        clientEventId: toClientEventId('c9f1c1f0-0000-4000-8000-000000000002'),
      });

      const document = await documentFor(problemId);

      expect(document['schema_version']).toBe('1');
      expect(document['problem']).toEqual({
        title: 'inventory title',
        symptoms: 'inventory symptoms',
        problem_domain: 'deployment',
        suspected_boundary: 'configuration',
        status: 'INVESTIGATING',
        fix_kind: null,
      });
      expect(document['environment']).toEqual({ runtime: 'node 22.12.0' });
      expect(document['events']).toEqual([
        {
          event_type: 'DISCOVERY',
          summary: 'the redirect host is read at build time',
          result: null,
          reason: null,
        },
      ]);
      expect(document['verifications']).toEqual([
        {
          verification_type: 'TEST',
          result: true,
          summary: 'the suite passes against the deployed build',
        },
      ]);
    });

    it('holds an empty list for a Problem nothing has happened to yet', async () => {
      const problemId = await makeProblem(actor, 'quiet');
      const document = await documentFor(problemId);

      // Not null, and not a missing key. A Problem with no Events is an
      // ordinary state — every Problem starts in it — and a generator should
      // not have to tell "none" from "this document does not cover events".
      expect(document['events']).toEqual([]);
      expect(document['verifications']).toEqual([]);
    });

    it('keeps all six kinds of Event, in the order they happened', async () => {
      const problemId = await makeProblem(actor, 'six');
      const types = [
        'HYPOTHESIS',
        'ATTEMPT',
        'DEAD_END',
        'DISCOVERY',
        'FIX',
        'USER_CORRECTION',
      ] as const;

      for (const [index, eventType] of types.entries()) {
        await actor.memory.appendEvent({
          problemId,
          eventType,
          summary: `${eventType} happened`,
          result: `${eventType} result`,
          reason: `${eventType} reason`,
          // Not in the document, and here to prove it: a generator seeing
          // authorship could attribute a conclusion to whoever wrote it down.
          sourceAi: 'an assistant',
          evidenceRef: 'repo@abc123',
          clientEventId: toClientEventId(`c9f1c1f0-0000-4000-8000-0000000001${String(index)}0`),
        });
      }

      const document = await documentFor(problemId);
      const events = document['events'] as { event_type: string }[];

      expect(events.map((event) => event.event_type)).toEqual([...types]);
      // Every type survives. Dropping any of these loses a distinct part of
      // the experience: where not to look, what was established, what was
      // corrected.
      expect(events).toHaveLength(6);
    });

    it('keeps a failed Verification, which is evidence too', async () => {
      const problemId = await makeProblem(actor, 'counter');
      await actor.memory.appendVerification({
        problemId,
        verificationType: 'REAL_DEVICE',
        result: false,
        summary: 'still fails on the device',
        verifiedBy: 'somebody',
        clientEventId: toClientEventId('c9f1c1f0-0000-4000-8000-000000000200'),
      });

      const document = await documentFor(problemId);

      expect(document['verifications']).toEqual([
        {
          verification_type: 'REAL_DEVICE',
          result: false,
          summary: 'still fails on the device',
        },
      ]);
    });

    it('holds nothing that identifies the Problem or when it was written', async () => {
      // The strong form of the exclusion list. Two Problems with the same
      // content, in different projects, on different Environments, created at
      // different times, with different identifiers, different authors and
      // different evidence references — one document.
      const first = await makeProblem(actor, 'twin');
      const second = await makeProblem(actor, 'twin');

      for (const [index, problemId] of [first, second].entries()) {
        await actor.memory.appendEvent({
          problemId,
          eventType: 'DEAD_END',
          summary: 'raising the timeout changed nothing',
          sourceAi: `assistant ${String(index)}`,
          evidenceRef: `repo@commit${String(index)}`,
          clientEventId: toClientEventId(`c9f1c1f0-0000-4000-8000-0000000003${String(index)}0`),
        });
      }

      const [a, b] = await Promise.all([documentFor(first), documentFor(second)]);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      expect(await fingerprintFor(first)).toBe(await fingerprintFor(second));
    });
  });

  describe('the Environment snapshot', () => {
    it('reads the same whichever order its keys were written in', async () => {
      // Written straight to the column in two different orders, because the
      // point is what `jsonb` does with them. Two Memories that say the same
      // thing must not produce different digests because one adapter
      // serialised an object differently from another.
      const project = await actor.memory.createProject({ projectName: 'key order' });
      const problems: ProblemId[] = [];

      for (const text of [
        '{"zeta": 1, "alpha": {"b": 2, "a": 1}}',
        '{"alpha": {"a": 1, "b": 2}, "zeta": 1}',
      ]) {
        const environmentId = await insertRawEnvironment(project.projectId, text);
        const problem = await actor.memory.createProblem({
          projectId: project.projectId,
          environmentId,
          title: 'same title',
          symptoms: 'same symptoms',
          problemDomain: 'deployment',
          suspectedBoundary: 'configuration',
        });
        problems.push(problem.problemId);
      }

      const [first, second] = problems as [ProblemId, ProblemId];
      expect(await fingerprintFor(first)).toBe(await fingerprintFor(second));
    });

    it('keeps a number JavaScript could not hold', async () => {
      // `jsonb` stores numbers as `numeric`, and the driver would parse this
      // into a float and lose the last three digits. The document is built and
      // returned as text by PostgreSQL precisely so that does not happen — a
      // build identifier is exactly the kind of value that is both large and
      // load-bearing.
      const project = await actor.memory.createProject({ projectName: 'precision' });
      const environmentId = await insertRawEnvironment(
        project.projectId,
        '{"build": 12345678901234567890}',
      );
      const problem = await actor.memory.createProblem({
        projectId: project.projectId,
        environmentId,
        title: 'a large build number',
        symptoms: 'it fails on one build only',
      });

      const read = await actor.source.readSource(problem.problemId);

      expect(read?.canonicalSource).toContain('12345678901234567890');
      // What the round trip would have produced.
      expect(read?.canonicalSource).not.toContain('12345678901234567000');
    });
  });

  describe('the facts that travel beside the document', () => {
    it('reports the memory read control without putting it in the document', async () => {
      const problemId = await makeProblem(actor, 'controls');
      const before = await actor.source.readSource(problemId);
      const problem = await actor.memory.getProblem(problemId);

      expect(before?.memoryReadEnabled).toBe(true);

      await actor.memory.updateProblem(problemId, problem?.version ?? 0, {
        memoryReadEnabled: false,
      });
      const after = await actor.source.readSource(problemId);

      expect(after?.memoryReadEnabled).toBe(false);
      // The control governs whether a summary may be generated; it is not
      // something the summary is about. So the document — and therefore the
      // digest — is unchanged by it.
      expect(after?.canonicalSource).toBe(before?.canonicalSource);
    });

    it('reports whether a successful Verification exists', async () => {
      const problemId = await makeProblem(actor, 'evidence');

      expect((await actor.source.readSource(problemId))?.hasSuccessfulVerification).toBe(false);

      await actor.memory.appendVerification({
        problemId,
        verificationType: 'BUILD',
        result: false,
        summary: 'the build still fails',
        clientEventId: toClientEventId('c9f1c1f0-0000-4000-8000-000000000400'),
      });
      // A failed check is not evidence that anything worked.
      expect((await actor.source.readSource(problemId))?.hasSuccessfulVerification).toBe(false);

      await actor.memory.appendVerification({
        problemId,
        verificationType: 'BUILD',
        result: true,
        summary: 'the build passes',
        clientEventId: toClientEventId('c9f1c1f0-0000-4000-8000-000000000401'),
      });

      const read = await actor.source.readSource(problemId);
      expect(read?.hasSuccessfulVerification).toBe(true);
      expect(read?.status).toBe('INVESTIGATING');
    });
  });

  describe('the owner boundary', () => {
    it('does not read another owner’s Problem', async () => {
      const other = await makeActor();
      const theirs = await makeProblem(other, 'theirs');

      // The same answer an unknown identifier gets. A caller able to tell them
      // apart would learn whether somebody else's Problem exists.
      expect(await actor.source.readSource(theirs)).toBeUndefined();
      expect(await other.source.readSource(theirs)).toBeDefined();
    });

    it('answers nothing for a Problem that is not there', async () => {
      const problemId = await makeProblem(actor, 'gone');
      expect(await actor.source.readSource(problemId)).toBeDefined();

      const problem = await actor.memory.getProblem(problemId);
      await actor.memory.deleteProblem(problemId, problem?.version ?? 0);

      expect(await actor.source.readSource(problemId)).toBeUndefined();
    });
  });

  describe('the digest', () => {
    it('is named for the source schema it was taken under', async () => {
      const problemId = await makeProblem(actor, 'format');
      expect(await fingerprintFor(problemId)).toMatch(/^retrieval-source-v1:[0-9a-f]{64}$/);
    });

    it('does not move when nothing about the investigation has', async () => {
      const problemId = await makeProblem(actor, 'stable');
      const first = await fingerprintFor(problemId);
      expect(await fingerprintFor(problemId)).toBe(first);
    });

    it.each([
      ['the symptoms', { symptoms: 'it now fails before deployment too' }],
      ['the problem domain', { problemDomain: 'networking' }],
      ['the suspected boundary', { suspectedBoundary: 'serialization' }],
      ['the title', { title: 'a different title' }],
    ])('moves when %s changes', async (_label, patch) => {
      const problemId = await makeProblem(actor, 'semantic');
      const before = await fingerprintFor(problemId);
      const problem = await actor.memory.getProblem(problemId);

      await actor.memory.updateProblem(problemId, problem?.version ?? 0, patch);

      expect(await fingerprintFor(problemId)).not.toBe(before);
    });

    it.each([
      ['a dead end is recorded', 'DEAD_END'],
      ['something is discovered', 'DISCOVERY'],
      ['a correction arrives', 'USER_CORRECTION'],
      ['a fix is recorded', 'FIX'],
    ] as const)('moves when %s', async (_label, eventType) => {
      const problemId = await makeProblem(actor, `event-${eventType}`);
      const before = await fingerprintFor(problemId);

      await actor.memory.appendEvent({
        problemId,
        eventType,
        summary: `${eventType} was recorded`,
        clientEventId: toClientEventId(randomUUID()),
      });

      expect(await fingerprintFor(problemId)).not.toBe(before);
    });

    it('moves when a Verification is added', async () => {
      const problemId = await makeProblem(actor, 'verified');
      const before = await fingerprintFor(problemId);

      await actor.memory.appendVerification({
        problemId,
        verificationType: 'API_RESULT',
        result: true,
        summary: 'the endpoint answers correctly now',
        clientEventId: toClientEventId(randomUUID()),
      });

      expect(await fingerprintFor(problemId)).not.toBe(before);
    });

    it('moves when the status or the fix kind is concluded', async () => {
      const problemId = await makeProblem(actor, 'concluded');
      const before = await fingerprintFor(problemId);
      const problem = await actor.memory.getProblem(problemId);

      await actor.memory.updateProblemConclusion(problemId, problem?.version ?? 0, {
        status: 'CLOSED_UNRESOLVED',
        fixKind: 'WORKAROUND',
      });

      expect(await fingerprintFor(problemId)).not.toBe(before);
    });

    it('moves when the Environment differs', async () => {
      const first = await makeProblem(actor, 'env', { runtime: 'node 22.12.0' });
      const second = await makeProblem(actor, 'env', { runtime: 'node 24.0.0' });

      // Everything else about these two is identical, so the Environment is
      // the only thing that could account for the difference. This is why the
      // snapshot is in the document: the same symptom on two versions is two
      // experiences, and a search that could not tell them apart would offer
      // the wrong one.
      expect(await fingerprintFor(first)).not.toBe(await fingerprintFor(second));
    });

    it.each([
      ['confidence', { confidence: 'HIGH' as const }],
      ['freshness', { freshness: 'STALE_UNKNOWN' as const }],
      ['importance', { importance: true }],
      ['suppression', { suppressed: true }],
      ['the memory write control', { memoryWriteEnabled: false }],
      ['the memory read control', { memoryReadEnabled: false }],
    ])('does not move when %s changes', async (_label, patch) => {
      // These are judgements about a Memory rather than content of one. They
      // are read live by whatever ranks results, so regenerating a summary
      // because one of them moved would be work that changes nothing — and the
      // version and `updated_at` that the edit bumps are not in the document
      // either, which this also proves.
      const problemId = await makeProblem(actor, 'judgement');
      const before = await fingerprintFor(problemId);
      const problem = await actor.memory.getProblem(problemId);

      const updated = await actor.memory.updateProblem(problemId, problem?.version ?? 0, patch);
      expect(updated?.version).not.toBe(problem?.version);

      expect(await fingerprintFor(problemId)).toBe(before);
    });
  });
});
