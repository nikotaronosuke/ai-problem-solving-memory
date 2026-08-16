/**
 * Memories that disagree, read back against a real database.
 *
 * The specification is specific about what a conflict is answered with. Not a
 * verdict, and not a vote: what gets compared is the difference in
 * environment, in version, in symptoms, the stated reason, and the strength of
 * the verification behind each — and if that cannot settle it, the record
 * stays `CONFLICTED` rather than being resolved. So the central test here is
 * that a caller holding one search result can perform all five comparisons
 * without asking anything else, and that nothing in the result performs them
 * on the caller's behalf.
 *
 * Two things travel under the word conflict and are kept apart. A Problem's
 * own `CONFLICTED` confidence is a statement about that one record. A
 * `CONTRADICTS` Relation is a link somebody stored between two Problems. All
 * four combinations of the two occur, and all four are distinguishable here.
 *
 * Skipped without `DATABASE_URL`.
 */

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createRetrievalConflictService,
  InvalidConflictRequestError,
  REVALIDATION_CHECKS,
  type RetrievalConflictService,
} from '../../src/app/index.js';
import { readDatabaseUrl } from '../../src/config/env.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import type { DatabaseExecutor } from '../../src/db/executor.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import type { ClientEventId } from '../../src/domain/client-event-id.js';
import type { Confidence, Freshness, RelationType } from '../../src/domain/enums.js';
import type { EnvironmentSnapshot } from '../../src/domain/environment.js';
import { generateOwnerId, type OwnerContext, type OwnerId } from '../../src/domain/owner.js';
import type { ProblemId } from '../../src/domain/problem.js';
import type { ProjectId } from '../../src/domain/project.js';
import type { DeadEndAwareMemoryCandidate } from '../../src/domain/retrieval-result.js';
import { resolveOwnerContextFor } from '../../src/owner/context.js';
import {
  createMemoryRepository,
  createRetrievalConflictReader,
  type ConflictRow,
  type MemoryRepository,
} from '../../src/repository/index.js';
import { createSecretDetectionPolicy, withSanitization } from '../../src/sanitization/index.js';

const databaseUrl = readDatabaseUrl();

interface Actor {
  readonly ownerId: OwnerId;
  readonly context: OwnerContext;
  readonly memory: MemoryRepository;
}

interface Seeded {
  readonly problemId: ProblemId;
  readonly projectId: ProjectId;
}

describe.skipIf(databaseUrl === undefined)('retrieval conflicts', () => {
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

  function serviceFor(owner: Actor, executor: DatabaseExecutor = pool): RetrievalConflictService {
    return createRetrievalConflictService(createRetrievalConflictReader(executor, owner.context));
  }

  async function seed(
    owner: Actor,
    options: {
      readonly projectId?: ProjectId;
      readonly snapshot?: EnvironmentSnapshot;
      readonly symptoms?: string;
      readonly problemDomain?: string;
      readonly suspectedBoundary?: string;
    } = {},
  ): Promise<Seeded> {
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
      symptoms: options.symptoms ?? 'seeded symptoms',
      ...(options.problemDomain === undefined ? {} : { problemDomain: options.problemDomain }),
      ...(options.suspectedBoundary === undefined
        ? {}
        : { suspectedBoundary: options.suspectedBoundary }),
    });
    return { problemId: problem.problemId, projectId };
  }

  /** Links two Problems. Direction is the caller's; CONTRADICTS reads both ways. */
  async function link(
    owner: Actor,
    from: Seeded,
    to: Seeded,
    options: { readonly relationType?: RelationType; readonly reason?: string } = {},
  ): Promise<void> {
    await owner.memory.createRelation({
      fromId: from.problemId,
      toId: to.problemId,
      relationType: options.relationType ?? 'CONTRADICTS',
      reason: options.reason ?? 'they reached opposite conclusions',
    });
  }

  async function setControls(
    owner: Actor,
    seeded: Seeded,
    update: { readonly confidence?: Confidence; readonly freshness?: Freshness },
  ): Promise<void> {
    const problem = await owner.memory.getProblem(seeded.problemId);
    await owner.memory.updateProblem(seeded.problemId, problem?.version ?? 0, update);
  }

  async function verify(
    owner: Actor,
    seeded: Seeded,
    options: { readonly result?: boolean; readonly summary?: string; readonly ref?: string | null },
  ): Promise<void> {
    await owner.memory.appendVerification({
      problemId: seeded.problemId,
      verificationType: 'TEST',
      result: options.result ?? true,
      summary: options.summary ?? 'the suite passed',
      ...(options.ref === undefined ? {} : { evidenceRef: options.ref }),
      clientEventId: randomUUID() as ClientEventId,
    });
  }

  const candidate = (
    seeded: Seeded,
    rankingRank: number,
    overrides: { readonly confidence?: Confidence; readonly snapshot?: EnvironmentSnapshot } = {},
  ): DeadEndAwareMemoryCandidate => ({
    ranking: {
      problemId: seeded.problemId,
      projectId: seeded.projectId,
      rankingRank,
      projectRelation: 'CURRENT_PROJECT',
      confidence: overrides.confidence ?? 'HIGH',
      freshness: 'CURRENT',
      suppressed: false,
      structuralScore: 0.5,
      hybridRank: rankingRank,
      matchedDimensions: ['symptom_patterns'],
    },
    revalidation: {
      historicalEnvironment: overrides.snapshot ?? { runtime: 'node 22.12.0' },
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

  describe('the five things a conflict is compared on', () => {
    it('supplies every one of them from a single result', async () => {
      const owner = await makeActor();
      const mine = await seed(owner, {
        snapshot: { runtime: 'node 20.11.0', framework: 'next 14.0.0' },
        symptoms: 'the build succeeds but the page renders blank',
      });
      const theirs = await seed(owner, {
        projectId: mine.projectId,
        snapshot: { runtime: 'node 22.12.0', framework: 'next 15.4.0' },
        symptoms: 'the build fails outright before any page is served',
      });
      await link(owner, mine, theirs, {
        reason: 'one says the loader is at fault, the other says the config is',
      });
      await verify(owner, theirs, { result: true, summary: 'reproduced on a real device' });

      const enriched = await serviceFor(owner).enrich([
        {
          ...candidate(mine, 1, {
            snapshot: { runtime: 'node 20.11.0', framework: 'next 14.0.0' },
          }),
          revalidation: {
            historicalEnvironment: { runtime: 'node 20.11.0', framework: 'next 14.0.0' },
            evidence: [],
            requiredChecks: REVALIDATION_CHECKS,
          },
        },
      ]);

      const offered = enriched[0];
      const contradiction = offered?.conflict.contradictions[0];

      // 1. Environment difference — both sides, uninterpreted.
      expect(offered?.revalidation.historicalEnvironment).toEqual({
        runtime: 'node 20.11.0',
        framework: 'next 14.0.0',
      });
      expect(contradiction?.other.historicalEnvironment).toEqual({
        runtime: 'node 22.12.0',
        framework: 'next 15.4.0',
      });

      // 2. Version difference — carried inside those snapshots, because which
      //    versions matter to a Problem is not a fixed set.
      expect(JSON.stringify(offered?.revalidation.historicalEnvironment)).toContain('next 14.0.0');
      expect(JSON.stringify(contradiction?.other.historicalEnvironment)).toContain('next 15.4.0');

      // 3. Symptom difference — which is why the candidate's own symptoms are
      //    here at all. Half a subtraction is not a comparison.
      expect(offered?.conflict.subject.symptoms).toBe(
        'the build succeeds but the page renders blank',
      );
      expect(contradiction?.other.symptoms).toBe(
        'the build fails outright before any page is served',
      );

      // 4. The stated reason, as somebody wrote it.
      expect(contradiction?.reason).toBe(
        'one says the loader is at fault, the other says the config is',
      );

      // 5. Verification strength, on both sides.
      expect(offered?.revalidation.evidence).toEqual([]);
      expect(contradiction?.other.evidence.map((entry) => entry.summary)).toEqual([
        'reproduced on a real device',
      ]);
    });

    it('never says which of the two wins', async () => {
      const owner = await makeActor();
      const weak = await seed(owner);
      const strong = await seed(owner, { projectId: weak.projectId });
      await link(owner, weak, strong);
      await setControls(owner, weak, { confidence: 'LOW', freshness: 'INVALID' });
      // `MEDIUM` rather than `HIGH` on purpose: `HIGH` is the value a stage
      // that had stopped reading the column would most naturally invent, and a
      // fixture that agreed with it would pass either way.
      await setControls(owner, strong, { confidence: 'MEDIUM', freshness: 'SUPERSEDED' });

      const enriched = await serviceFor(owner).enrich([candidate(weak, 1)]);

      // Every ingredient for preferring one is present and no preference is
      // expressed. The specification says a conflict is not settled by
      // majority, and which record applies depends on the conditions the work
      // is happening under — which this process cannot see.
      const serialised = JSON.stringify(enriched);
      for (const verdict of [
        'winner',
        'loser',
        'preferred',
        'canonical',
        'resolved',
        'resolution',
        'conflictScore',
        'severity',
        'chooseThis',
        'ignoreOther',
        'notify',
      ]) {
        expect(serialised.includes(verdict), `the conflict declares ${verdict}`).toBe(false);
      }
      expect(enriched[0]?.conflict.contradictions[0]?.other.confidence).toBe('MEDIUM');
      expect(enriched[0]?.conflict.contradictions[0]?.other.freshness).toBe('SUPERSEDED');
    });

    it.each([['HIGH'], ['MEDIUM'], ['LOW'], ['CONFLICTED']] as [Confidence][])(
      'reports the other Memory as %s when that is what the record says',
      async (confidence) => {
        const owner = await makeActor();
        const mine = await seed(owner);
        const theirs = await seed(owner, { projectId: mine.projectId });
        await link(owner, mine, theirs);
        await setControls(owner, theirs, { confidence });

        const enriched = await serviceFor(owner).enrich([candidate(mine, 1)]);
        expect(enriched[0]?.conflict.contradictions[0]?.other.confidence).toBe(confidence);
      },
    );
  });

  describe('the candidate’s own side', () => {
    it('carries only what the rest of the result does not', async () => {
      const owner = await makeActor();
      const mine = await seed(owner, {
        symptoms: 'requests time out under load',
        problemDomain: 'networking',
        suspectedBoundary: 'the connection pool',
      });

      const subject = (await serviceFor(owner).enrich([candidate(mine, 1)]))[0]?.conflict.subject;

      expect(subject?.symptoms).toBe('requests time out under load');
      expect(subject?.problemDomain).toBe('networking');
      expect(subject?.suspectedBoundary).toBe('the connection pool');
      expect(subject?.status).toBe('INVESTIGATING');
      expect(subject?.fixKind).toBeNull();

      // Identity, Project, trust and currency live in the ranking view; the
      // conditions and evidence live in the revalidation context. One fact
      // with two homes is one fact that will eventually disagree with itself.
      expect(Object.keys(subject ?? {}).sort()).toEqual([
        'fixKind',
        'problemDomain',
        'status',
        'suspectedBoundary',
        'symptoms',
      ]);
    });

    it('is there even when nothing was recorded as disagreeing', async () => {
      const owner = await makeActor();
      const mine = await seed(owner, { symptoms: 'nothing contradicts this one' });

      const enriched = await serviceFor(owner).enrich([candidate(mine, 1)]);

      expect(enriched[0]?.conflict.contradictions).toEqual([]);
      expect(enriched[0]?.conflict.subject.symptoms).toBe('nothing contradicts this one');
    });
  });

  describe('the other Memory', () => {
    it('carries the comparison material and nothing recursive', async () => {
      const owner = await makeActor();
      const mine = await seed(owner);
      const theirs = await seed(owner, {
        projectId: mine.projectId,
        symptoms: 'their symptoms',
        problemDomain: 'their domain',
        suspectedBoundary: 'their boundary',
      });
      await link(owner, mine, theirs);

      const other = (await serviceFor(owner).enrich([candidate(mine, 1)]))[0]?.conflict
        .contradictions[0]?.other;

      // No rank, no structural score, no position: it was never a candidate of
      // this search, and giving it one would invent a placement nobody
      // computed. No dead ends and no conflicts of its own either — one hop is
      // the whole of it.
      expect(Object.keys(other ?? {}).sort()).toEqual([
        'confidence',
        'evidence',
        'fixKind',
        'freshness',
        'historicalEnvironment',
        'problemDomain',
        'problemId',
        'projectId',
        'status',
        'suspectedBoundary',
        'symptoms',
      ]);
    });

    it('keeps checks that failed', async () => {
      const owner = await makeActor();
      const mine = await seed(owner);
      const theirs = await seed(owner, { projectId: mine.projectId });
      await link(owner, mine, theirs);
      await verify(owner, theirs, { result: true, summary: 'the suite passed' });
      await verify(owner, theirs, { result: false, summary: 'the build failed afterwards' });

      const evidence = (await serviceFor(owner).enrich([candidate(mine, 1)]))[0]?.conflict
        .contradictions[0]?.other.evidence;

      // A check that did not confirm anything is still part of how strongly a
      // conclusion was established. Keeping only successes would make both
      // sides of every disagreement look equally well checked.
      expect(evidence?.map((entry) => [entry.summary, entry.result])).toEqual([
        ['the suite passed', true],
        ['the build failed afterwards', false],
      ]);
    });

    it('returns a reference as a reference', async () => {
      const owner = await makeActor();
      const mine = await seed(owner);
      const theirs = await seed(owner, { projectId: mine.projectId });
      await link(owner, mine, theirs);
      await verify(owner, theirs, { summary: 'with a link', ref: 'https://example.invalid/ci/7' });
      await verify(owner, theirs, { summary: 'without one', ref: null });

      const evidence = (await serviceFor(owner).enrich([candidate(mine, 1)]))[0]?.conflict
        .contradictions[0]?.other.evidence;

      expect(evidence?.map((entry) => entry.evidenceRef)).toEqual([
        'https://example.invalid/ci/7',
        null,
      ]);
    });

    it.each([['CURRENT'], ['STALE_UNKNOWN'], ['SUPERSEDED'], ['INVALID']] as [Freshness][])(
      'is still returned when it is %s',
      async (freshness) => {
        const owner = await makeActor();
        const mine = await seed(owner);
        const theirs = await seed(owner, { projectId: mine.projectId });
        await link(owner, mine, theirs);
        await setControls(owner, theirs, { freshness });

        const other = (await serviceFor(owner).enrich([candidate(mine, 1)]))[0]?.conflict
          .contradictions[0]?.other;

        // Marking a Memory invalid is distinct from deleting it, and a
        // disagreement recorded against an invalid Memory is still a fact about
        // what somebody found. Whether it matters now is the caller's call.
        expect(other?.problemId).toBe(theirs.problemId);
        expect(other?.freshness).toBe(freshness);
      },
    );

    it('is still returned when it has been suppressed', async () => {
      const owner = await makeActor();
      const mine = await seed(owner);
      const theirs = await seed(owner, { projectId: mine.projectId });
      await link(owner, mine, theirs);
      const problem = await owner.memory.getProblem(theirs.problemId);
      await owner.memory.updateProblem(theirs.problemId, problem?.version ?? 0, {
        suppressed: true,
      });

      const enriched = await serviceFor(owner).enrich([candidate(mine, 1)]);

      // Suppression means "show less of this", not "do not read this". It is a
      // presentation control the ranking stage already applies, and it is not
      // repeated in the payload.
      expect(enriched[0]?.conflict.contradictions[0]?.other.problemId).toBe(theirs.problemId);
      // The candidate's own `ranking.suppressed` is a different field and
      // stays; what must not appear is a suppression flag on the other side.
      expect(JSON.stringify(enriched[0]?.conflict).includes('suppressed')).toBe(false);
    });

    it('is dropped when automatic reading has been switched off, leaving the candidate', async () => {
      const owner = await makeActor();
      const mine = await seed(owner);
      const readable = await seed(owner, { projectId: mine.projectId });
      const off = await seed(owner, { projectId: mine.projectId });
      await link(owner, mine, readable, { reason: 'the readable one' });
      await link(owner, mine, off, { reason: 'the unreadable one' });
      const problem = await owner.memory.getProblem(off.problemId);
      await owner.memory.updateProblem(off.problemId, problem?.version ?? 0, {
        memoryReadEnabled: false,
      });

      const enriched = await serviceFor(owner).enrich([candidate(mine, 1)]);

      // The item goes rather than coming back hollow. A contradiction whose
      // other side cannot be read is not comparison material, and a link is
      // not permission to read the Problem at its far end.
      expect(enriched).toHaveLength(1);
      expect(enriched[0]?.conflict.contradictions.map((entry) => entry.reason)).toEqual([
        'the readable one',
      ]);
    });

    it('is never another owner’s', async () => {
      const owner = await makeActor();
      const stranger = await makeActor();
      const mine = await seed(owner);
      const theirs = await seed(stranger);
      await link(stranger, theirs, await seed(stranger, { projectId: theirs.projectId }));

      const enriched = await serviceFor(owner).enrich([candidate(mine, 1)]);

      expect(enriched[0]?.conflict.contradictions).toEqual([]);
      expect(JSON.stringify(enriched).includes(theirs.problemId)).toBe(false);
    });
  });

  describe('which links count', () => {
    it.each([['SIMILAR_TO'], ['RELATED_TO'], ['CAUSED_BY'], ['SUPERSEDES'], ['DERIVED_FROM']] as [
      RelationType,
    ][])('does not read a %s as a disagreement', async (relationType) => {
      const owner = await makeActor();
      const mine = await seed(owner);
      const theirs = await seed(owner, { projectId: mine.projectId });
      await link(owner, mine, theirs, { relationType, reason: 'a different kind of link' });

      const enriched = await serviceFor(owner).enrich([candidate(mine, 1)]);
      expect(enriched[0]?.conflict.contradictions).toEqual([]);
    });

    it('does not read a SUPERSEDES as settling one', async () => {
      const owner = await makeActor();
      const mine = await seed(owner);
      const theirs = await seed(owner, { projectId: mine.projectId });
      await link(owner, mine, theirs, { reason: 'they disagree' });
      await link(owner, theirs, mine, {
        relationType: 'SUPERSEDES',
        reason: 'and this one came later',
      });

      const enriched = await serviceFor(owner).enrich([candidate(mine, 1)]);

      // Working out that a later conclusion resolves an earlier disagreement
      // is graph reasoning, and there is nothing in the record that says a
      // SUPERSEDES refers to the same disagreement as a CONTRADICTS.
      expect(enriched[0]?.conflict.contradictions.map((entry) => entry.reason)).toEqual([
        'they disagree',
      ]);
    });

    it('does not follow the other Memory’s own disagreements', async () => {
      const owner = await makeActor();
      const mine = await seed(owner);
      const middle = await seed(owner, { projectId: mine.projectId });
      const far = await seed(owner, { projectId: mine.projectId });
      await link(owner, mine, middle, { reason: 'one hop' });
      await link(owner, middle, far, { reason: 'two hops' });

      const enriched = await serviceFor(owner).enrich([candidate(mine, 1)]);

      expect(enriched[0]?.conflict.contradictions.map((entry) => entry.reason)).toEqual([
        'one hop',
      ]);
      expect(JSON.stringify(enriched).includes('two hops')).toBe(false);
      expect(JSON.stringify(enriched).includes(far.problemId)).toBe(false);
    });
  });

  describe('direction', () => {
    it('finds the same disagreement from either end', async () => {
      const owner = await makeActor();
      const from = await seed(owner, { symptoms: 'symptoms of the from side' });
      const to = await seed(owner, {
        projectId: from.projectId,
        symptoms: 'symptoms of the to side',
      });
      await link(owner, from, to, { reason: 'recorded once, from one side' });

      const service = serviceFor(owner);
      const asFrom = await service.enrich([candidate(from, 1)]);
      const asTo = await service.enrich([candidate(to, 1)]);

      // One row is stored, whichever end it was written from, and CONTRADICTS
      // reads the same both ways. The other Memory is whichever one is not the
      // candidate — `from` and `to` decide which Problem to look up and then
      // stop mattering.
      expect(asFrom[0]?.conflict.contradictions[0]?.other.problemId).toBe(to.problemId);
      expect(asTo[0]?.conflict.contradictions[0]?.other.problemId).toBe(from.problemId);
      expect(asFrom[0]?.conflict.contradictions[0]?.reason).toBe('recorded once, from one side');
      expect(asTo[0]?.conflict.contradictions[0]?.reason).toBe('recorded once, from one side');
    });

    it('never reports a Memory as disagreeing with itself', async () => {
      const owner = await makeActor();
      const from = await seed(owner, { symptoms: 'the candidate' });
      const to = await seed(owner, { projectId: from.projectId, symptoms: 'the other one' });
      await link(owner, from, to);

      const enriched = await serviceFor(owner).enrich([candidate(from, 1)]);
      const other = enriched[0]?.conflict.contradictions[0]?.other;

      expect(other?.problemId).not.toBe(from.problemId);
      expect(other?.symptoms).toBe('the other one');
      expect(enriched[0]?.conflict.subject.symptoms).toBe('the candidate');
    });

    it('exposes nothing about which end it was written from', async () => {
      const owner = await makeActor();
      const from = await seed(owner);
      const to = await seed(owner, { projectId: from.projectId });
      await link(owner, from, to);

      const serialised = JSON.stringify(await serviceFor(owner).enrich([candidate(from, 1)]));
      for (const stored of ['fromId', 'toId', 'from_id', 'to_id', 'relationId', 'relationType']) {
        expect(serialised.includes(stored), `the response exposes ${stored}`).toBe(false);
      }
    });
  });

  describe('how many, and in what order', () => {
    it('returns every recorded disagreement, uncapped', async () => {
      const owner = await makeActor();
      const mine = await seed(owner);
      for (let index = 0; index < 6; index += 1) {
        const other = await seed(owner, { projectId: mine.projectId });
        await link(owner, mine, other, { reason: `disagreement ${String(index)}` });
      }

      const enriched = await serviceFor(owner).enrich([candidate(mine, 1)]);

      expect(enriched[0]?.conflict.contradictions).toHaveLength(6);
    });

    it('returns them oldest first', async () => {
      const owner = await makeActor();
      const mine = await seed(owner);
      for (const reason of ['first', 'second', 'third']) {
        const other = await seed(owner, { projectId: mine.projectId });
        await link(owner, mine, other, { reason });
      }

      const enriched = await serviceFor(owner).enrich([candidate(mine, 1)]);
      expect(enriched[0]?.conflict.contradictions.map((entry) => entry.reason)).toEqual([
        'first',
        'second',
        'third',
      ]);
      expect(enriched[0]?.conflict.contradictions[0]?.relationCreatedAt).toBeInstanceOf(Date);
    });

    it('says when each link was recorded, not when it was read', async () => {
      const owner = await makeActor();
      const mine = await seed(owner);
      for (const reason of ['first', 'second', 'third']) {
        const other = await seed(owner, { projectId: mine.projectId });
        await link(owner, mine, other, { reason });
      }

      const stamps = (
        await serviceFor(owner).enrich([candidate(mine, 1)])
      )[0]?.conflict.contradictions.map((entry) => entry.relationCreatedAt.getTime());

      // Three links written at three moments carry three moments. A stage that
      // stamped them as they were read would give all three the statement's
      // clock, and every disagreement would look simultaneous.
      expect(stamps).toHaveLength(3);
      expect(new Set(stamps).size).toBe(3);
      expect(stamps?.[0]).toBeLessThan(stamps?.[1] ?? 0);
      expect(stamps?.[1]).toBeLessThan(stamps?.[2] ?? 0);
    });

    it('keeps two links between the same pair as two', async () => {
      const owner = await makeActor();
      const mine = await seed(owner);
      const theirs = await seed(owner, { projectId: mine.projectId });
      await link(owner, mine, theirs, { reason: 'they disagree about the cause' });
      await link(owner, theirs, mine, { reason: 'they disagree about the fix as well' });

      const enriched = await serviceFor(owner).enrich([candidate(mine, 1)]);

      // Two links, recorded at two moments for two reasons, and nothing in
      // the schema makes them the same link. Merging them on the pair would
      // lose whichever account was written second.
      expect(enriched[0]?.conflict.contradictions.map((entry) => entry.reason)).toEqual([
        'they disagree about the cause',
        'they disagree about the fix as well',
      ]);
      expect(enriched[0]?.conflict.contradictions.map((entry) => entry.other.problemId)).toEqual([
        theirs.problemId,
        theirs.problemId,
      ]);
    });

    it('keeps two links with identical wording as two', async () => {
      const owner = await makeActor();
      const mine = await seed(owner);
      const theirs = await seed(owner, { projectId: mine.projectId });
      await link(owner, mine, theirs, { reason: 'the same words' });
      await link(owner, mine, theirs, { reason: 'the same words' });

      const enriched = await serviceFor(owner).enrich([candidate(mine, 1)]);
      expect(enriched[0]?.conflict.contradictions).toHaveLength(2);
    });

    it('gives each candidate its own', async () => {
      const owner = await makeActor();
      const first = await seed(owner);
      const second = await seed(owner, { projectId: first.projectId });
      const firstOther = await seed(owner, { projectId: first.projectId });
      const secondOther = await seed(owner, { projectId: first.projectId });
      await link(owner, first, firstOther, { reason: 'the first one' });
      await link(owner, second, secondOther, { reason: 'the second one' });

      const enriched = await serviceFor(owner).enrich([candidate(first, 1), candidate(second, 2)]);

      expect(enriched[0]?.conflict.contradictions.map((entry) => entry.reason)).toEqual([
        'the first one',
      ]);
      expect(enriched[1]?.conflict.contradictions.map((entry) => entry.reason)).toEqual([
        'the second one',
      ]);
    });

    it('reads every candidate, every link and every check in one query', async () => {
      const owner = await makeActor();
      const first = await seed(owner);
      const second = await seed(owner, { projectId: first.projectId });
      const other = await seed(owner, { projectId: first.projectId });
      await link(owner, first, other);
      await link(owner, second, other);
      await verify(owner, other, { summary: 'checked' });
      const executor = counting();
      const service = serviceFor(owner, executor);
      executor.statements.length = 0;

      await service.enrich([candidate(first, 1), candidate(second, 2)]);

      // One snapshot. Read across several statements, the two halves of a
      // comparison could come from two moments, and a reader could see a
      // difference that never existed at any single instant.
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
      const service = createRetrievalConflictService({
        ownerId: owner.ownerId,
        readForCandidates: () => {
          asked += 1;
          return Promise.resolve(new Map<ProblemId, ConflictRow>());
        },
      });
      expect(await service.enrich([])).toEqual([]);
      expect(asked).toBe(0);
    });
  });

  describe('the two kinds of conflict stay apart', () => {
    it('leaves a trusted Memory trusted when something contradicts it', async () => {
      const owner = await makeActor();
      const mine = await seed(owner);
      const theirs = await seed(owner, { projectId: mine.projectId });
      await link(owner, mine, theirs);

      const enriched = await serviceFor(owner).enrich([candidate(mine, 1, { confidence: 'HIGH' })]);

      // Recording that two Memories disagree does not adjust either one's
      // confidence — a link is not an inheritance — and this stage writes
      // nothing at all.
      expect(enriched[0]?.ranking.confidence).toBe('HIGH');
      expect(enriched[0]?.conflict.contradictions).toHaveLength(1);
      const stored = await owner.memory.getProblem(mine.problemId);
      expect(stored?.confidence).toBe('LOW');
    });

    it('invents no link for a Memory whose own record conflicts', async () => {
      const owner = await makeActor();
      const mine = await seed(owner);
      await setControls(owner, mine, { confidence: 'CONFLICTED' });

      const enriched = await serviceFor(owner).enrich([
        candidate(mine, 1, { confidence: 'CONFLICTED' }),
      ]);

      // `CONFLICTED` says this record holds evidence pointing both ways. It
      // does not name another Memory, and nothing here will name one for it.
      expect(enriched[0]?.ranking.confidence).toBe('CONFLICTED');
      expect(enriched[0]?.conflict.contradictions).toEqual([]);
      const relations = await owner.memory.listRelations(mine.problemId);
      expect(relations).toEqual([]);
    });

    it('tells all four combinations apart', async () => {
      const owner = await makeActor();
      const a = await seed(owner);
      const b = await seed(owner, { projectId: a.projectId });
      const c = await seed(owner, { projectId: a.projectId });
      const d = await seed(owner, { projectId: a.projectId });
      const bOther = await seed(owner, { projectId: a.projectId });
      const dOther = await seed(owner, { projectId: a.projectId });
      await link(owner, b, bOther, { reason: 'b disagrees with something' });
      await link(owner, d, dOther, { reason: 'd disagrees with something' });

      const enriched = await serviceFor(owner).enrich([
        candidate(a, 1, { confidence: 'HIGH' }),
        candidate(b, 2, { confidence: 'HIGH' }),
        candidate(c, 3, { confidence: 'CONFLICTED' }),
        candidate(d, 4, { confidence: 'CONFLICTED' }),
      ]);

      const shape = enriched.map((entry) => [
        entry.ranking.confidence,
        entry.conflict.contradictions.length,
      ]);
      expect(shape).toEqual([
        ['HIGH', 0],
        ['HIGH', 1],
        ['CONFLICTED', 0],
        ['CONFLICTED', 1],
      ]);

      // And no derived marker collapses the four back into two.
      for (const derived of ['hasConflict', 'conflictState', 'selfConflicted', 'hasUnlinked']) {
        expect(JSON.stringify(enriched).includes(derived)).toBe(false);
      }
    });
  });

  describe('a disagreement never costs a candidate its place', () => {
    it('keeps a Memory however much contradicts it', async () => {
      const owner = await makeActor();
      const contested = await seed(owner);
      const quiet = await seed(owner, { projectId: contested.projectId });
      for (let index = 0; index < 4; index += 1) {
        const other = await seed(owner, { projectId: contested.projectId });
        await link(owner, contested, other, { reason: `disagreement ${String(index)}` });
      }

      // The contested one is ranked first on purpose, so the expected order
      // contradicts every arrangement a contradiction count could produce.
      const enriched = await serviceFor(owner).enrich([
        candidate(contested, 1),
        candidate(quiet, 2),
      ]);

      expect(enriched.map((entry) => entry.ranking.problemId)).toEqual([
        contested.problemId,
        quiet.problemId,
      ]);
      expect(enriched.map((entry) => entry.ranking.rankingRank)).toEqual([1, 2]);
      expect(enriched.map((entry) => entry.conflict.contradictions.length)).toEqual([4, 0]);
    });

    it('leaves everything the earlier stages decided alone', async () => {
      const owner = await makeActor();
      const mine = await seed(owner);
      const theirs = await seed(owner, { projectId: mine.projectId });
      await link(owner, mine, theirs);
      const given = candidate(mine, 1);

      const enriched = await serviceFor(owner).enrich([given]);

      expect(enriched[0]?.ranking.hybridRank).toBe(given.ranking.hybridRank);
      expect(enriched[0]?.ranking.structuralScore).toBe(0.5);
      expect(enriched[0]?.ranking.matchedDimensions).toEqual(['symptom_patterns']);
      expect(enriched[0]?.revalidation.requiredChecks).toEqual([...REVALIDATION_CHECKS]);
      expect(enriched[0]?.deadEndWarnings).toEqual([]);
    });

    it('carries the dead-end warnings through untouched', async () => {
      const owner = await makeActor();
      const mine = await seed(owner);
      const theirs = await seed(owner, { projectId: mine.projectId });
      await link(owner, mine, theirs);
      const given: DeadEndAwareMemoryCandidate = {
        ...candidate(mine, 1),
        deadEndWarnings: [
          {
            summary: 'raising the timeout',
            result: null,
            reason: null,
            evidenceRef: null,
            createdAt: new Date('2026-08-16T10:00:00.000Z'),
          },
        ],
      };

      const enriched = await serviceFor(owner).enrich([given]);
      expect(enriched[0]?.deadEndWarnings.map((entry) => entry.summary)).toEqual([
        'raising the timeout',
      ]);
    });
  });

  describe('a Memory that has since gone', () => {
    it('is dropped when it has been deleted', async () => {
      const owner = await makeActor();
      const kept = await seed(owner);
      const doomed = await seed(owner, { projectId: kept.projectId });
      const problem = await owner.memory.getProblem(doomed.problemId);
      await owner.memory.deleteProblem(doomed.problemId, problem?.version ?? 0);

      const enriched = await serviceFor(owner).enrich([candidate(kept, 1), candidate(doomed, 2)]);

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

      const enriched = await serviceFor(owner).enrich([candidate(kept, 1), candidate(off, 2)]);

      expect(enriched.map((entry) => entry.ranking.problemId)).toEqual([kept.problemId]);
    });

    it('answers the same way for another owner’s and for one that never existed', async () => {
      const owner = await makeActor();
      const stranger = await makeActor();
      const mine = await seed(owner);
      const theirs = await seed(stranger);

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

    it('closes up the positions and leaves the provenance alone', async () => {
      const owner = await makeActor();
      const first = await seed(owner);
      const doomed = await seed(owner, { projectId: first.projectId });
      const third = await seed(owner, { projectId: first.projectId });
      const problem = await owner.memory.getProblem(doomed.problemId);
      await owner.memory.deleteProblem(doomed.problemId, problem?.version ?? 0);

      const withHybrid = (seeded: Seeded, rank: number, hybridRank: number) => {
        const base = candidate(seeded, rank);
        return { ...base, ranking: { ...base.ranking, hybridRank } };
      };
      const given = [withHybrid(first, 1, 3), withHybrid(doomed, 2, 6), withHybrid(third, 3, 9)];
      const enriched = await serviceFor(owner).enrich(given);

      expect(enriched.map((entry) => entry.ranking.rankingRank)).toEqual([1, 2]);
      expect(enriched.map((entry) => entry.ranking.hybridRank)).toEqual([3, 9]);
      // And the caller's list is untouched.
      expect(given.map((entry) => entry.ranking.rankingRank)).toEqual([1, 2, 3]);
    });
  });

  describe('when the read itself fails', () => {
    it('raises rather than answering as though nothing disagreed', async () => {
      const owner = await makeActor();
      const mine = await seed(owner);
      const theirs = await seed(owner, { projectId: mine.projectId });
      await link(owner, mine, theirs);
      const failing: DatabaseExecutor = {
        query: () => Promise.reject(new Error('connection terminated unexpectedly')),
      };

      // An empty list means "nothing was recorded as disagreeing", and a
      // database that could not be reached has not established that.
      await expect(serviceFor(owner, failing).enrich([candidate(mine, 1)])).rejects.toThrow(
        'connection terminated unexpectedly',
      );
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
      ).rejects.toBeInstanceOf(InvalidConflictRequestError);
    });

    it('refuses the same Problem twice', async () => {
      const owner = await makeActor();
      const mine = await seed(owner);

      await expect(
        serviceFor(owner).enrich([candidate(mine, 1), candidate(mine, 2)]),
      ).rejects.toBeInstanceOf(InvalidConflictRequestError);
    });

    it('refuses positions that disagree with the order', async () => {
      const owner = await makeActor();
      const first = await seed(owner);
      const second = await seed(owner, { projectId: first.projectId });
      const executor = counting();

      await expect(
        serviceFor(owner, executor).enrich([candidate(first, 2), candidate(second, 1)]),
      ).rejects.toBeInstanceOf(InvalidConflictRequestError);
      expect(executor.statements).toHaveLength(0);
    });

    it('names no identifier when it refuses', async () => {
      const owner = await makeActor();
      const mine = await seed(owner);

      let raised: unknown;
      try {
        await serviceFor(owner).enrich([candidate(mine, 1), candidate(mine, 2)]);
      } catch (error) {
        raised = error;
      }
      expect((raised as Error).message.includes(mine.problemId)).toBe(false);
    });
  });
});
