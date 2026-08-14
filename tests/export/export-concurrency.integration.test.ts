/**
 * An export taken while somebody else is writing.
 *
 * This is the property that decided how the export is built. An artifact has to
 * describe one moment: every Problem it names with its events, every relation
 * pointing at a Problem that is also in the file. Read the eight tables as
 * eight statements under the default isolation level and you get eight moments,
 * so a delete landing between the third and the fourth produces a document
 * describing a state that never existed — a Problem whose events are missing,
 * or a relation pointing at nothing. Restoring that fails on a foreign key, or
 * worse, succeeds and is wrong.
 *
 * Building the whole document in one statement makes that impossible rather
 * than unlikely: a statement sees a single snapshot by definition. These tests
 * race a real delete and a real append against a real export to check the
 * consequence, because the alternative is trusting an argument.
 *
 * Skipped when `DATABASE_URL` is not set.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readDatabaseUrl } from '../../src/config/env.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { createEnvironment } from '../../src/db/environments.js';
import { appendEvent } from '../../src/db/events.js';
import { exportOwnerMemory } from '../../src/db/memory-export.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import { deleteProblemAggregate } from '../../src/db/problem-deletion.js';
import { createProblem } from '../../src/db/problems.js';
import { createProject } from '../../src/db/projects.js';
import { createRelation } from '../../src/db/relations.js';
import { createTransactionRunner } from '../../src/db/transaction.js';
import { createUsageLog } from '../../src/db/usage-logs.js';
import { appendVerification } from '../../src/db/verifications.js';
import { generateClientEventId } from '../../src/domain/client-event-id.js';
import { generateOwnerId, type OwnerContext, type OwnerId } from '../../src/domain/owner.js';
import type { ProblemId } from '../../src/domain/problem.js';
import { MEMORY_OWNER_ID_VAR, resolveOwnerContext } from '../../src/owner/context.js';

const databaseUrl = readDatabaseUrl();

interface Fixture {
  readonly context: OwnerContext;
  readonly targetId: ProblemId;
  readonly neighbourId: ProblemId;
  readonly version: number;
}

interface Artifact {
  readonly problems: { problem_id: string }[];
  readonly events: { problem_id: string }[];
  readonly verifications: { problem_id: string }[];
  readonly relations: { from_id: string; to_id: string }[];
  readonly usage_logs: { problem_id: string; memory_id: string }[];
  readonly change_logs: { problem_id: string }[];
}

describe.skipIf(databaseUrl === undefined)('an export racing other work', () => {
  let pool: DatabasePool;
  const ownersCreated: OwnerId[] = [];

  async function seed(): Promise<Fixture> {
    const ownerId = generateOwnerId();
    await insertOwnerIfAbsent(pool, ownerId);
    ownersCreated.push(ownerId);
    const context = await resolveOwnerContext(pool, { [MEMORY_OWNER_ID_VAR]: ownerId });

    const project = await createProject(pool, context, { projectName: 'export race' });
    const environment = await createEnvironment(pool, context, {
      projectId: project.projectId,
      snapshot: { runtime: 'node 22' },
    });
    const make = (title: string) =>
      createProblem(pool, context, {
        projectId: project.projectId,
        environmentId: environment.environmentId,
        title,
        symptoms: 'symptoms',
      });

    const target = await make('the problem being deleted');
    const neighbour = await make('the problem that survives');

    await appendEvent(pool, context, {
      problemId: target.problemId,
      eventType: 'HYPOTHESIS',
      summary: 'a thought',
      clientEventId: generateClientEventId(),
    });
    await appendVerification(pool, context, {
      problemId: target.problemId,
      verificationType: 'TEST',
      result: true,
      summary: 'a check',
      clientEventId: generateClientEventId(),
    });
    await createRelation(pool, context, {
      fromId: neighbour.problemId,
      toId: target.problemId,
      relationType: 'SIMILAR_TO',
      reason: 'points at the target',
    });
    await createUsageLog(pool, context, {
      problemId: neighbour.problemId,
      memoryId: target.problemId,
      sourceAi: 'claude-code',
      action: 'ADOPTED',
      reason: 'used the target',
    });

    return {
      context,
      targetId: target.problemId,
      neighbourId: neighbour.problemId,
      version: target.version,
    };
  }

  const parse = async (context: OwnerContext): Promise<Artifact> =>
    JSON.parse((await exportOwnerMemory(pool, context)).json) as Artifact;

  /**
   * Whether an artifact describes the target as wholly present or wholly gone.
   *
   * Anything else is the failure this is looking for: a half-deleted Memory in
   * a file that claims to be a snapshot.
   */
  function describeTarget(artifact: Artifact, fixture: Fixture): 'present' | 'absent' | 'torn' {
    const counts = [
      artifact.problems.filter((row) => row.problem_id === fixture.targetId).length,
      artifact.events.filter((row) => row.problem_id === fixture.targetId).length,
      artifact.verifications.filter((row) => row.problem_id === fixture.targetId).length,
      artifact.relations.filter(
        (row) => row.from_id === fixture.targetId || row.to_id === fixture.targetId,
      ).length,
      artifact.usage_logs.filter(
        (row) => row.problem_id === fixture.targetId || row.memory_id === fixture.targetId,
      ).length,
    ];

    if (counts.every((n) => n === 1)) {
      return 'present';
    }
    if (counts.every((n) => n === 0)) {
      return 'absent';
    }
    return 'torn';
  }

  beforeAll(() => {
    pool = createPool(resolveDatabaseConfig({ nodeEnv: 'test', connectionTimeoutMillis: 5_000 }));
  });

  afterAll(async () => {
    if (ownersCreated.length > 0) {
      for (const table of [
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

  it('sees a Problem either wholly or not at all while it is being deleted', async () => {
    const fixture = await seed();

    const client = await pool.connect();
    try {
      await client.query('begin');
      // The delete has removed everything and is holding its transaction open.
      const outcome = await deleteProblemAggregate(
        client,
        fixture.context,
        fixture.targetId,
        fixture.version,
      );
      expect(outcome).toBe('DELETED');

      // An export on another connection, while that is uncommitted. It sees
      // the state before the delete — whole.
      expect(describeTarget(await parse(fixture.context), fixture)).toBe('present');

      await client.query('commit');
    } finally {
      client.release();
    }

    // And afterwards, wholly gone. Never anything in between.
    expect(describeTarget(await parse(fixture.context), fixture)).toBe('absent');
  });

  it('is never torn by a delete committing mid-export', async () => {
    const fixture = await seed();
    const runner = createTransactionRunner(pool);

    // Started together, so the commit lands somewhere in the middle of the
    // export's work rather than at a moment this test chose.
    const [artifact] = await Promise.all([
      parse(fixture.context),
      runner.run((transactional) =>
        deleteProblemAggregate(transactional, fixture.context, fixture.targetId, fixture.version),
      ),
    ]);

    // Either answer is correct. `torn` is the one that must never happen: a
    // Problem in the file with its events missing, or a relation left pointing
    // at a Problem that is not there.
    expect(['present', 'absent']).toContain(describeTarget(artifact, fixture));
  });

  it('stays closed under its own references while events are being appended', async () => {
    const fixture = await seed();

    const appends = Array.from({ length: 8 }, (_unused, index) =>
      appendEvent(pool, fixture.context, {
        problemId: index % 2 === 0 ? fixture.targetId : fixture.neighbourId,
        eventType: 'DISCOVERY',
        summary: `arrived during the export ${String(index)}`,
        clientEventId: generateClientEventId(),
      }),
    );

    const [artifact] = await Promise.all([parse(fixture.context), ...appends]);

    // However many of the appends the snapshot caught, every event in the file
    // belongs to a Problem in the file. An export that read events after
    // problems under a per-statement snapshot could carry one that does not.
    const problems = new Set(artifact.problems.map((row) => row.problem_id));
    for (const event of artifact.events) {
      expect(problems.has(event.problem_id)).toBe(true);
    }
    for (const relation of artifact.relations) {
      expect(problems.has(relation.from_id)).toBe(true);
      expect(problems.has(relation.to_id)).toBe(true);
    }
    for (const usage of artifact.usage_logs) {
      expect(problems.has(usage.problem_id)).toBe(true);
      expect(problems.has(usage.memory_id)).toBe(true);
    }
  });

  it('does not block a writer while it runs', async () => {
    const fixture = await seed();

    // A read that took a lock would make an export a small outage on a large
    // Memory. Both finish; neither waits for the other.
    const [, appended] = await Promise.all([
      parse(fixture.context),
      appendEvent(pool, fixture.context, {
        problemId: fixture.neighbourId,
        eventType: 'FIX',
        summary: 'written during the export',
        clientEventId: generateClientEventId(),
      }),
    ]);

    expect(appended.summary).toBe('written during the export');
  });
});
