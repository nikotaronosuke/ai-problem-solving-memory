/**
 * Every write surface, over real HTTP and a real database, reaching the policy.
 *
 * The unit tests prove the wrapper inspects what it is given. This proves the
 * wrapper is actually on the path — that a request arriving at the API gets its
 * caller-written text in front of the policy before any of it is stored, for
 * every surface that stores anything.
 *
 * The method is to send a marker through each surface and ask the policy what
 * it saw. Markers are distinctive strings, so finding one is unambiguous: it
 * came from that request and nowhere else.
 *
 * The rest of the file is about what happens when a policy refuses. That is
 * the case P3-03 will rely on and the one nothing exercises today, so it is
 * checked now while the boundary is being built rather than assumed later —
 * including the case that matters most, a refusal partway through a close,
 * where several writes have already happened inside one transaction.
 *
 * Fixtures are self-contained: an owner per run, removed afterwards. Skipped
 * when `DATABASE_URL` is not set.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import {
  createChangeLogService,
  createEventService,
  createHealthService,
  createMemoryControlService,
  createProblemCloseService,
  createProblemService,
  createProblemStatusService,
  createProjectEnvironmentService,
  createRelationService,
  createRequestContextService,
  createUsageLogService,
  createVerificationService,
} from '../../src/app/index.js';
import { readDatabaseUrl } from '../../src/config/env.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import { createTransactionRunner } from '../../src/db/transaction.js';
import { generateClientEventId } from '../../src/domain/client-event-id.js';
import { generateOwnerId, type OwnerId } from '../../src/domain/owner.js';
import { buildMemoryHttpApp } from '../../src/http/index.js';
import { MEMORY_OWNER_ID_VAR } from '../../src/owner/context.js';
import {
  describeInspectionPath,
  type SanitizationPolicy,
  type SanitizationSite,
} from '../../src/sanitization/index.js';

const databaseUrl = readDatabaseUrl();

/** Distinctive enough that finding one proves which request it came from. */
const MARK = {
  projectName: 'mark-proj-Qv7X',
  projectUpdate: 'mark-projupd-Lm2P',
  snapshotLeaf: 'mark-snapleaf-Tr8K',
  snapshotDeep: 'mark-snapdeep-Nw5J',
  problemTitle: 'mark-title-Bz3Q',
  problemUpdate: 'mark-titleupd-Hd6R',
  eventSummary: 'mark-event-Cf9M',
  verificationSummary: 'mark-verif-Yk4W',
  relationReason: 'mark-relation-Pu2N',
  usageReason: 'mark-usage-Sx8V',
  changedBy: 'mark-changedby-Jq5T',
  closeSummary: 'mark-close-Wg7L',
} as const;

interface Sighting {
  readonly text: string;
  readonly at: string;
  readonly kind: 'key' | 'value';
}

interface Recorder extends SanitizationPolicy {
  readonly seen: Sighting[];
  saw(marker: string): Sighting[];
  reset(): void;
}

/** Keeps everything, and remembers what it was shown. */
function recorder(): Recorder {
  const seen: Sighting[] = [];
  return {
    seen,
    inspect(text: string, at: SanitizationSite) {
      seen.push({ text, at: describeInspectionPath(at.path), kind: at.kind });
      return { kind: 'keep' };
    },
    saw(marker) {
      return seen.filter((sighting) => sighting.text.includes(marker));
    },
    reset() {
      seen.length = 0;
    },
  };
}

describe.skipIf(databaseUrl === undefined)('the sanitization boundary, in place', () => {
  let pool: DatabasePool;
  const ownersCreated: OwnerId[] = [];
  const appsCreated: FastifyInstance[] = [];

  async function appWith(policy: SanitizationPolicy): Promise<FastifyInstance> {
    const ownerId = generateOwnerId();
    await insertOwnerIfAbsent(pool, ownerId);
    ownersCreated.push(ownerId);

    const app = buildMemoryHttpApp({
      healthService: createHealthService(pool),
      requestContextService: createRequestContextService(
        pool,
        createTransactionRunner(pool),
        { [MEMORY_OWNER_ID_VAR]: ownerId },
        policy,
      ),
      projectEnvironmentService: createProjectEnvironmentService(),
      problemService: createProblemService(),
      problemStatusService: createProblemStatusService(),
      eventService: createEventService(),
      verificationService: createVerificationService(),
      relationService: createRelationService(),
      usageLogService: createUsageLogService(),
      changeLogService: createChangeLogService(),
      memoryControlService: createMemoryControlService(),
      problemCloseService: createProblemCloseService(),
      logger: false,
    });
    appsCreated.push(app);
    return app;
  }

  beforeAll(() => {
    pool = createPool(resolveDatabaseConfig({ nodeEnv: 'test', connectionTimeoutMillis: 5_000 }));
  });

  afterAll(async () => {
    for (const app of appsCreated) {
      await app.close();
    }
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

  describe('every surface that stores caller text', () => {
    let app: FastifyInstance;
    let policy: Recorder;
    let projectId: string;
    let problemId: string;
    let secondProblemId: string;

    async function post<T>(url: string, payload: unknown, expected = 201): Promise<T> {
      const response = await app.inject({ method: 'POST', url, payload: payload as object });
      expect(response.statusCode, `${url} -> ${response.body}`).toBe(expected);
      return response.json<T>();
    }

    beforeAll(async () => {
      policy = recorder();
      app = await appWith(policy);

      const project = await post<{ project_id: string }>('/v1/projects', {
        project_name: MARK.projectName,
      });
      projectId = project.project_id;

      const environment = await post<{ environment_id: string }>(
        `/v1/projects/${projectId}/environments`,
        {
          snapshot: {
            runtime: MARK.snapshotLeaf,
            // Nested on purpose: a snapshot is whatever the caller composed,
            // and nothing named these keys.
            auth: { provider: { name: MARK.snapshotDeep } },
          },
        },
      );

      const problem = await post<{ problem_id: string }>(`/v1/projects/${projectId}/problems`, {
        environment_id: environment.environment_id,
        title: MARK.problemTitle,
        symptoms: 'Recorded so the boundary has caller text to see.',
      });
      problemId = problem.problem_id;

      const second = await post<{ problem_id: string }>(`/v1/projects/${projectId}/problems`, {
        environment_id: environment.environment_id,
        title: 'a second problem',
        symptoms: 'so a relation and a usage log have somewhere to point',
      });
      secondProblemId = second.problem_id;

      await app.inject({
        method: 'PATCH',
        url: `/v1/projects/${projectId}`,
        payload: { project_name: MARK.projectUpdate },
      });
      await app.inject({
        method: 'PATCH',
        url: `/v1/problems/${problemId}`,
        payload: {
          expected_version: 1,
          changed_by: MARK.changedBy,
          title: MARK.problemUpdate,
        },
      });
      await post(`/v1/problems/${problemId}/events`, {
        event_type: 'DISCOVERY',
        summary: MARK.eventSummary,
        client_event_id: generateClientEventId(),
      });
      await post(`/v1/problems/${problemId}/verifications`, {
        verification_type: 'TEST',
        result: true,
        summary: MARK.verificationSummary,
        client_event_id: generateClientEventId(),
      });
      await post(`/v1/problems/${problemId}/relations`, {
        to_id: secondProblemId,
        relation_type: 'SIMILAR_TO',
        reason: MARK.relationReason,
      });
      await post(`/v1/problems/${problemId}/usage-logs`, {
        source_ai: 'phase3-boundary',
        action: 'ADOPTED',
        memory_id: secondProblemId,
        reason: MARK.usageReason,
      });
      await app.inject({
        method: 'PATCH',
        url: `/v1/problems/${problemId}/memory-control`,
        payload: { expected_version: 2, changed_by: MARK.changedBy, suppressed: true },
      });
      await app.inject({
        method: 'POST',
        url: `/v1/problems/${problemId}/status-transitions`,
        payload: {
          expected_version: 3,
          changed_by: MARK.changedBy,
          target_status: 'FIX_CANDIDATE',
        },
      });
      await app.inject({
        method: 'POST',
        url: `/v1/problems/${problemId}/close`,
        payload: {
          expected_version: 4,
          changed_by: MARK.changedBy,
          target_status: 'VERIFIED',
          fix_kind: 'ROOT_FIX',
          final_cause_summary: MARK.closeSummary,
        },
      });
    });

    it.each([
      ['a project name', MARK.projectName, 'createProject'],
      ['a project update', MARK.projectUpdate, 'updateProject'],
      ['a problem title', MARK.problemTitle, 'createProblem'],
      ['a problem update', MARK.problemUpdate, 'updateProblem'],
      ['an event summary', MARK.eventSummary, 'appendEvent'],
      ['a verification summary', MARK.verificationSummary, 'appendVerification'],
      ['a relation reason', MARK.relationReason, 'createRelation'],
      ['a usage log reason', MARK.usageReason, 'createUsageLog'],
    ])('%s reaches the policy', (_label, marker, operation) => {
      const sightings = policy.saw(marker);

      expect(sightings.length).toBeGreaterThan(0);
      expect(sightings.some((sighting) => sighting.at.startsWith(`${operation}[`))).toBe(true);
    });

    it('reaches a value the caller buried inside an environment snapshot', () => {
      // The one a field-by-field boundary would have missed completely.
      expect(policy.saw(MARK.snapshotLeaf).map((sighting) => sighting.at)).toContain(
        'createEnvironment[0].snapshot.runtime',
      );
      expect(policy.saw(MARK.snapshotDeep).map((sighting) => sighting.at)).toContain(
        'createEnvironment[0].snapshot.auth.provider.name',
      );
    });

    it('reaches the review text a close turns into events', () => {
      const sightings = policy.saw(MARK.closeSummary);

      // Written inside a transaction, through the transactional repository.
      // Wrapping only the ordinary one would have left exactly this unchecked.
      expect(sightings.map((sighting) => sighting.at)).toContain('appendEvent[0].summary');
    });

    it('reaches who a change was attributed to, on its way into the history', () => {
      const sightings = policy.saw(MARK.changedBy);

      // `changed_by` is caller-written free text and it is persisted, so it
      // is content the boundary has to see like any other.
      expect(sightings.some((sighting) => sighting.at === 'createChangeLog[0].changedBy')).toBe(
        true,
      );
    });

    it('sees writes from every storing operation and from no reading one', async () => {
      policy.reset();

      for (const url of [
        `/v1/problems/${problemId}`,
        `/v1/problems/${problemId}/events`,
        `/v1/problems/${problemId}/verifications`,
        `/v1/problems/${problemId}/relations`,
        `/v1/problems/${problemId}/usage-logs`,
        `/v1/problems/${problemId}/change-logs`,
        `/v1/projects/${projectId}/problems`,
        '/v1/projects',
      ]) {
        expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
      }

      // Reading stores nothing, so there is nothing for a policy to rule on.
      expect(policy.seen).toEqual([]);
    });

    it('stored exactly what the caller sent, since this policy keeps everything', async () => {
      const problem = (await app.inject({ method: 'GET', url: `/v1/problems/${problemId}` })).json<{
        title: string;
        status: string;
        fix_kind: string;
        version: number;
      }>();

      // The boundary is on the path of all of that and changed none of it.
      expect(problem).toMatchObject({
        title: MARK.problemUpdate,
        status: 'VERIFIED',
        fix_kind: 'ROOT_FIX',
        version: 5,
      });

      const events = (
        await app.inject({ method: 'GET', url: `/v1/problems/${problemId}/events` })
      ).json<{ events: { summary: string }[] }>().events;
      expect(events.map((event) => event.summary)).toEqual([MARK.eventSummary, MARK.closeSummary]);
    });
  });

  describe('when a policy refuses', () => {
    /** Refuses any string containing the marker, keeps everything else. */
    function refusing(marker: string): SanitizationPolicy {
      return {
        inspect: (text) => (text.includes(marker) ? { kind: 'reject' } : { kind: 'keep' }),
      };
    }

    /**
     * An app whose real logger is captured.
     *
     * A refusal is written by pino exactly as it would be in production, so
     * what these tests read is the log line an operator would actually get.
     */
    async function loggingApp(
      policy: SanitizationPolicy,
      lines: string[],
    ): Promise<FastifyInstance> {
      const ownerId = generateOwnerId();
      await insertOwnerIfAbsent(pool, ownerId);
      ownersCreated.push(ownerId);

      const app = buildMemoryHttpApp({
        healthService: createHealthService(pool),
        requestContextService: createRequestContextService(
          pool,
          createTransactionRunner(pool),
          { [MEMORY_OWNER_ID_VAR]: ownerId },
          policy,
        ),
        projectEnvironmentService: createProjectEnvironmentService(),
        problemService: createProblemService(),
        problemStatusService: createProblemStatusService(),
        eventService: createEventService(),
        verificationService: createVerificationService(),
        relationService: createRelationService(),
        usageLogService: createUsageLogService(),
        changeLogService: createChangeLogService(),
        memoryControlService: createMemoryControlService(),
        problemCloseService: createProblemCloseService(),
        logger: {
          level: 'trace',
          stream: {
            write(line: string) {
              lines.push(line);
            },
          },
        },
      });
      appsCreated.push(app);
      return app;
    }

    async function fixture(policy: SanitizationPolicy) {
      const app = await appWith(policy);
      const project = (
        await app.inject({ method: 'POST', url: '/v1/projects', payload: { project_name: 'ok' } })
      ).json<{ project_id: string }>();
      const environment = (
        await app.inject({
          method: 'POST',
          url: `/v1/projects/${project.project_id}/environments`,
          payload: { snapshot: { runtime: 'node 22.12.0' } },
        })
      ).json<{ environment_id: string }>();
      const problem = (
        await app.inject({
          method: 'POST',
          url: `/v1/projects/${project.project_id}/problems`,
          payload: {
            environment_id: environment.environment_id,
            title: 'a problem',
            symptoms: 'observed',
          },
        })
      ).json<{ problem_id: string }>();
      return {
        app,
        projectId: project.project_id,
        environmentId: environment.environment_id,
        problemId: problem.problem_id,
      };
    }

    it('answers a refused write as a bad request', async () => {
      const marker = 'refuse-me-Az1';
      const { app, projectId, environmentId } = await fixture(refusing(marker));

      const response = await app.inject({
        method: 'POST',
        url: `/v1/projects/${projectId}/problems`,
        payload: { environment_id: environmentId, title: marker, symptoms: 'observed' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('INVALID_REQUEST');
    });

    it('never lets the refused value into the response', async () => {
      const marker = 'refuse-me-Bz2';
      const { app, problemId } = await fixture(refusing(marker));

      const response = await app.inject({
        method: 'POST',
        url: `/v1/problems/${problemId}/events`,
        payload: {
          event_type: 'FIX',
          summary: marker,
          client_event_id: generateClientEventId(),
        },
      });

      expect(response.statusCode).toBe(400);
      // The envelope is fixed text, and the refusal reason stays server-side.
      expect(response.body).not.toContain(marker);
    });

    it('writes nothing at all for a refused append', async () => {
      const marker = 'refuse-me-Cz3';
      const { app, problemId } = await fixture(refusing(marker));

      await app.inject({
        method: 'POST',
        url: `/v1/problems/${problemId}/events`,
        payload: { event_type: 'FIX', summary: marker, client_event_id: generateClientEventId() },
      });

      const events = (
        await app.inject({ method: 'GET', url: `/v1/problems/${problemId}/events` })
      ).json<{ events: unknown[] }>().events;
      // Refused before delegation, so no statement was ever issued.
      expect(events).toEqual([]);
    });

    it('leaves nothing behind when a close is refused partway through', async () => {
      // The case that matters: a close writes the conclusion, then review
      // events, then the history, all in one transaction. Refusing the last
      // of those is where a boundary that ran too late would leave a Problem
      // marked verified with no record of why.
      const marker = 'refuse-me-Dz4';
      const { app, problemId } = await fixture(refusing(marker));

      await app.inject({
        method: 'POST',
        url: `/v1/problems/${problemId}/status-transitions`,
        payload: { expected_version: 1, changed_by: 'ok', target_status: 'FIX_CANDIDATE' },
      });
      await app.inject({
        method: 'POST',
        url: `/v1/problems/${problemId}/verifications`,
        payload: {
          verification_type: 'TEST',
          result: true,
          summary: 'green',
          client_event_id: generateClientEventId(),
        },
      });

      const before = (await app.inject({ method: 'GET', url: `/v1/problems/${problemId}` })).json<
        Record<string, unknown>
      >();

      const refused = await app.inject({
        method: 'POST',
        url: `/v1/problems/${problemId}/close`,
        payload: {
          expected_version: 2,
          // Refused, and it is the change log — written last, after the
          // conclusion and the review events have already gone in.
          changed_by: marker,
          target_status: 'VERIFIED',
          fix_kind: 'ROOT_FIX',
          final_cause_summary: 'the registered redirect was stale',
        },
      });

      expect(refused.statusCode).toBe(400);

      const after = (await app.inject({ method: 'GET', url: `/v1/problems/${problemId}` })).json<
        Record<string, unknown>
      >();
      expect(after).toEqual(before);
      expect(after['status']).toBe('FIX_CANDIDATE');

      const events = (
        await app.inject({ method: 'GET', url: `/v1/problems/${problemId}/events` })
      ).json<{ events: unknown[] }>().events;
      expect(events).toEqual([]);

      const history = (
        await app.inject({ method: 'GET', url: `/v1/problems/${problemId}/change-logs` })
      ).json<{ change_logs: unknown[] }>().change_logs;
      // One entry, from the transition. Nothing from the refused close.
      expect(history).toHaveLength(1);
    });

    it('refuses a secret written into a snapshot key, not only into a value', async () => {
      const marker = 'refuse-me-Fz6';
      const { app, projectId } = await fixture(refusing(marker));

      // The bypass this closes. A snapshot stores whatever JSON was sent, so
      // a caller can put text in a key just as easily as in a value.
      const refused = await app.inject({
        method: 'POST',
        url: `/v1/projects/${projectId}/environments`,
        payload: { snapshot: { deployment: { [marker]: 'ordinary looking value' } } },
      });

      expect(refused.statusCode).toBe(400);
      expect(refused.body).not.toContain(marker);

      const environments = (
        await app.inject({ method: 'GET', url: `/v1/projects/${projectId}/environments` })
      ).json<{ environments: unknown[] }>().environments;
      expect(environments).toHaveLength(1);
    });

    it('keeps a refused key out of the operational log', async () => {
      const marker = 'refuse-me-Gz7';
      const lines: string[] = [];

      // A real logger, captured. This is where a locator built from raw
      // caller keys would deposit the secret it had just refused to store.
      const app = await loggingApp(refusing(marker), lines);

      const project = (
        await app.inject({ method: 'POST', url: '/v1/projects', payload: { project_name: 'ok' } })
      ).json<{ project_id: string }>();

      const refused = await app.inject({
        method: 'POST',
        url: `/v1/projects/${project.project_id}/environments`,
        payload: { snapshot: { [marker]: 'value' } },
      });
      expect(refused.statusCode).toBe(400);

      const logged = lines.join('\n');
      // It must have logged the refusal — a silent one would be worse.
      expect(logged).toContain('sanitization boundary');
      // And it must not have logged the thing it refused.
      expect(logged).not.toContain(marker);
      // What it may say instead: the shape of where it happened, and nothing
      // else. No key names, and no policy-supplied text of any kind.
      expect(logged).toContain('<redacted>');
    });

    it('keeps a refused value out of the operational log', async () => {
      const marker = 'refuse-me-Hz8';
      const lines: string[] = [];

      // A policy that would hand back the value if it could. It cannot: a
      // refusal has no field to put it in, and the boundary reads nothing
      // from an outcome but its kind.
      const app = await loggingApp(
        {
          inspect: (text: string) =>
            text.includes(marker) ? { kind: 'reject', reason: text } : { kind: 'keep' },
        } as unknown as SanitizationPolicy,
        lines,
      );

      const refused = await app.inject({
        method: 'POST',
        url: '/v1/projects',
        payload: { project_name: `a project named ${marker}` },
      });
      expect(refused.statusCode).toBe(400);

      const logged = lines.join('\n');
      expect(logged).toContain('sanitization boundary');
      expect(logged).not.toContain(marker);
    });

    it('keeps a kept ancestor key out of the log when a secret beneath it is refused', async () => {
      // The case the second review found. A secret detector keeps an email
      // address, correctly — and "may be stored" is not "may be written to a
      // log file". An earlier version rendered approved keys into the locator
      // on exactly that mistaken equivalence.
      const pii = 'ancestor-key-Jk9Y@example.com';
      const secret = 'refuse-me-Kl0Z';
      const lines: string[] = [];
      const app = await loggingApp(refusing(secret), lines);

      const project = (
        await app.inject({ method: 'POST', url: '/v1/projects', payload: { project_name: 'ok' } })
      ).json<{ project_id: string }>();

      const refused = await app.inject({
        method: 'POST',
        url: `/v1/projects/${project.project_id}/environments`,
        payload: { snapshot: { [pii]: { api_key: secret } } },
      });

      expect(refused.statusCode).toBe(400);
      expect(refused.body).not.toContain(pii);
      expect(refused.body).not.toContain(secret);

      const logged = lines.join('\n');
      expect(logged).toContain('sanitization boundary');
      expect(logged).not.toContain(secret);
      // The ancestor key the policy kept. It is caller-written text, and the
      // policy keeping it said nothing about logging it.
      expect(logged).not.toContain(pii);
      expect(logged).not.toContain('example.com');
    });

    it('keeps a policy’s own name out of the log', async () => {
      const marker = 'policy-name-Mn1A-secret';
      const lines: string[] = [];
      // A policy has no name field; this is one forced past the type, which is
      // all a plain JavaScript adapter would have to do.
      const named = {
        name: marker,
        inspect: (text: string) =>
          text.includes('refuse-me-Op2B') ? { kind: 'reject' } : { kind: 'keep' },
      } as unknown as SanitizationPolicy;
      const app = await loggingApp(named, lines);

      const refused = await app.inject({
        method: 'POST',
        url: '/v1/projects',
        payload: { project_name: 'a project named refuse-me-Op2B' },
      });

      expect(refused.statusCode).toBe(400);
      const logged = lines.join('\n');
      expect(logged).toContain('sanitization boundary');
      expect(logged).not.toContain(marker);
    });

    it('keeps a policy’s own name out of the log on an unsupported outcome', async () => {
      // Not caught anywhere, so the generic handler logs the whole error,
      // message and stack included. That makes it the more dangerous of the
      // two paths, not the less.
      const marker = 'policy-name-Qr3C-secret';
      const lines: string[] = [];
      const renaming = {
        name: marker,
        inspect: (_text: string, at: { kind: string }) =>
          at.kind === 'key' ? { kind: 'replace', value: 'renamed' } : { kind: 'keep' },
      } as unknown as SanitizationPolicy;
      const app = await loggingApp(renaming, lines);

      const failed = await app.inject({
        method: 'POST',
        url: '/v1/projects',
        payload: { project_name: 'anything' },
      });

      // A programming error, reported as one, with nothing revealed.
      expect(failed.statusCode).toBe(500);
      expect(failed.json<{ error: { code: string } }>().error.code).toBe('INTERNAL_ERROR');
      expect(failed.body).not.toContain(marker);

      const logged = lines.join('\n');
      expect(logged).toContain('unhandled error');
      expect(logged).not.toContain(marker);
    });

    it('refuses a value buried in a snapshot without storing the environment', async () => {
      const marker = 'refuse-me-Ez5';
      const { app, projectId } = await fixture(refusing(marker));

      const refused = await app.inject({
        method: 'POST',
        url: `/v1/projects/${projectId}/environments`,
        payload: { snapshot: { deployment: { env: { API_KEY: marker } } } },
      });

      expect(refused.statusCode).toBe(400);

      const environments = (
        await app.inject({ method: 'GET', url: `/v1/projects/${projectId}/environments` })
      ).json<{ environments: unknown[] }>().environments;
      // One from the fixture; the refused one is not there.
      expect(environments).toHaveLength(1);
    });
  });

  describe('what the boundary did not change', () => {
    it('leaves validation, locking and idempotency exactly as they were', async () => {
      const policy = recorder();
      const app = await appWith(policy);
      const project = (
        await app.inject({ method: 'POST', url: '/v1/projects', payload: { project_name: 'ok' } })
      ).json<{ project_id: string }>();
      const environment = (
        await app.inject({
          method: 'POST',
          url: `/v1/projects/${project.project_id}/environments`,
          payload: { snapshot: { runtime: 'node' } },
        })
      ).json<{ environment_id: string }>();
      const problem = (
        await app.inject({
          method: 'POST',
          url: `/v1/projects/${project.project_id}/problems`,
          payload: {
            environment_id: environment.environment_id,
            title: 'a problem',
            symptoms: 'observed',
          },
        })
      ).json<{ problem_id: string }>();

      // Schema validation still refuses before anything reaches the boundary.
      const unknownField = await app.inject({
        method: 'PATCH',
        url: `/v1/problems/${problem.problem_id}`,
        payload: { expected_version: 1, changed_by: 'x', status: 'VERIFIED' },
      });
      expect(unknownField.statusCode).toBe(400);

      // Optimistic locking still arbitrates.
      const first = await app.inject({
        method: 'PATCH',
        url: `/v1/problems/${problem.problem_id}`,
        payload: { expected_version: 1, changed_by: 'x', importance: true },
      });
      const stale = await app.inject({
        method: 'PATCH',
        url: `/v1/problems/${problem.problem_id}`,
        payload: { expected_version: 1, changed_by: 'x', confidence: 'HIGH' },
      });
      expect(first.statusCode).toBe(200);
      expect(stale.statusCode).toBe(409);

      // Idempotency still replays the original write.
      const key = generateClientEventId();
      const original = await app.inject({
        method: 'POST',
        url: `/v1/problems/${problem.problem_id}/events`,
        payload: { event_type: 'HYPOTHESIS', summary: 'first', client_event_id: key },
      });
      const retry = await app.inject({
        method: 'POST',
        url: `/v1/problems/${problem.problem_id}/events`,
        payload: { event_type: 'ATTEMPT', summary: 'second', client_event_id: key },
      });
      expect(retry.statusCode).toBe(201);
      expect(retry.json()).toEqual(original.json());

      // A refused write on a resource that is not the caller's must still be
      // indistinguishable from one that does not exist.
      const other = await app.inject({
        method: 'GET',
        url: '/v1/problems/5d41402a-bc4b-4a76-b971-9d911017c592',
      });
      expect(other.statusCode).toBe(404);
    });
  });
});
