/**
 * Authentication, end to end, with nothing substituted.
 *
 * Every other HTTP suite uses a test double for the request context, because
 * they are about routes rather than about credentials. This one is the
 * opposite: a real database, the real credential repository, the real
 * authenticator, the real `createRequestContextService`, and the real
 * `preHandler` hook. If authentication is wrong, it is wrong here.
 *
 * Three claims carry the weight.
 *
 * That a credential is required — not an owner id, not configuration, not a
 * default. `MEMORY_OWNER_ID` used to establish an HTTP context; a test below
 * sets it to a real owner and confirms it now buys nothing, because a
 * fallback would turn an identifier that lives in configuration files into a
 * password that cannot be revoked.
 *
 * That the secret half is what proves anything. The lookup half is stored in
 * the clear and is not a secret, so a test presents a real lookup with a
 * different well-formed secret. If that succeeded, the hash column would be
 * decoration.
 *
 * And that revocation is immediate. No restart, no wait, same process.
 *
 * Skipped when `DATABASE_URL` is not set.
 */

import { createHash } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import {
  createChangeLogService,
  createEventService,
  createHealthService,
  createMemoryControlService,
  createProblemCloseService,
  createExportService,
  createProblemDeleteService,
  createProblemService,
  createProblemStatusService,
  createProjectEnvironmentService,
  createRelationService,
  createRequestContextService,
  createUsageLogService,
  createVerificationService,
} from '../../src/app/index.js';
import { readDatabaseUrl } from '../../src/config/env.js';
import {
  createCredentialAuthenticator,
  createCredentialRepository,
} from '../../src/credentials/index.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { insertOwnerIfAbsent } from '../../src/db/owners.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';
import { createTransactionRunner } from '../../src/db/transaction.js';
import { generateClientId, type ClientId } from '../../src/domain/client.js';
import {
  formatCredentialToken,
  generateCredentialId,
  generateCredentialToken,
  hashCredentialSecret,
  TOKEN_PREFIX,
  type CredentialId,
} from '../../src/domain/credential.js';
import { generateOwnerId, type OwnerId } from '../../src/domain/owner.js';
import { buildMemoryHttpApp, createLoggerOptions } from '../../src/http/index.js';
import { MEMORY_OWNER_ID_VAR } from '../../src/owner/context.js';

const databaseUrl = readDatabaseUrl();

interface Issued {
  readonly token: string;
  readonly secret: string;
  readonly lookup: string;
  readonly credentialId: CredentialId;
  readonly clientId: ClientId;
}

describe.skipIf(databaseUrl === undefined)('authenticating a request', () => {
  let pool: DatabasePool;
  let app: FastifyInstance;
  const logLines: string[] = [];
  const ownersCreated: OwnerId[] = [];
  const appsCreated: FastifyInstance[] = [];

  /** The real server, wired exactly as `src/index.ts` wires it. */
  function buildApp(lines: string[]): FastifyInstance {
    const built = buildMemoryHttpApp({
      healthService: createHealthService(pool),
      requestContextService: createRequestContextService(
        pool,
        createTransactionRunner(pool),
        createCredentialAuthenticator(createCredentialRepository(pool)),
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
      problemDeleteService: createProblemDeleteService(),
      exportService: createExportService(),
      logger: {
        // The production options, not a copy of them. A log-leak test against
        // a logger configured differently from production proves nothing
        // about production, and a copy stops being one silently.
        ...createLoggerOptions('trace'),
        stream: {
          write(line: string) {
            lines.push(line);
          },
        },
      },
    });
    appsCreated.push(built);
    return built;
  }

  async function makeOwner(): Promise<OwnerId> {
    const ownerId = generateOwnerId();
    await insertOwnerIfAbsent(pool, ownerId);
    ownersCreated.push(ownerId);
    return ownerId;
  }

  /** Issues a credential the way the CLI does, for a new client. */
  async function issue(ownerId: OwnerId, label = 'test client'): Promise<Issued> {
    const clientId = generateClientId();
    const credentialId = generateCredentialId();
    const token = generateCredentialToken();

    await createCredentialRepository(pool).issueClientCredential({
      clientId,
      ownerId,
      label,
      credentialId,
      tokenLookup: token.lookup,
      tokenHash: hashCredentialSecret(token.secret),
    });

    return {
      token: formatCredentialToken(token),
      secret: token.secret,
      lookup: token.lookup,
      credentialId,
      clientId,
    };
  }

  /** Adds a second credential to a client that already exists. */
  async function issueFor(clientId: ClientId): Promise<Issued> {
    const credentialId = generateCredentialId();
    const token = generateCredentialToken();

    await createCredentialRepository(pool).issueCredentialForClient({
      clientId,
      credentialId,
      tokenLookup: token.lookup,
      tokenHash: hashCredentialSecret(token.secret),
    });

    return {
      token: formatCredentialToken(token),
      secret: token.secret,
      lookup: token.lookup,
      credentialId,
      clientId,
    };
  }

  const me = (token?: string) =>
    app.inject({
      method: 'GET',
      url: '/v1/me',
      ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
    });

  beforeAll(() => {
    pool = createPool(resolveDatabaseConfig({ nodeEnv: 'test', connectionTimeoutMillis: 5_000 }));
    app = buildApp(logLines);
  });

  afterAll(async () => {
    for (const instance of appsCreated) {
      await instance.close();
    }
    if (ownersCreated.length > 0) {
      await pool.query(
        `delete from public.client_credentials
          where client_id in (select client_id from public.clients where owner_id = any($1::uuid[]))`,
        [ownersCreated],
      );
      // Child rows first. Every foreign key in this schema is `ON DELETE
      // RESTRICT` on purpose, so nothing cascades and the order here is the
      // order the graph requires rather than a convenience.
      for (const table of [
        'change_logs',
        'usage_logs',
        'relations',
        'verifications',
        'events',
        'clients',
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

  describe('a valid credential', () => {
    it('reaches the owner it was issued for', async () => {
      const ownerId = await makeOwner();
      const issued = await issue(ownerId);

      const response = await me(issued.token);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ owner_id: ownerId });
    });

    it('reaches that owner and no other', async () => {
      const first = await makeOwner();
      const second = await makeOwner();
      const forFirst = await issue(first);
      const forSecond = await issue(second);

      expect((await me(forFirst.token)).json()).toEqual({ owner_id: first });
      expect((await me(forSecond.token)).json()).toEqual({ owner_id: second });
    });

    it('scopes the data a request can see to its own owner', async () => {
      const mine = await makeOwner();
      const theirs = await makeOwner();
      const forMine = await issue(mine);
      const forTheirs = await issue(theirs);

      const project = await app.inject({
        method: 'POST',
        url: '/v1/projects',
        headers: { authorization: `Bearer ${forTheirs.token}` },
        payload: { project_name: 'theirs' },
      });
      expect(project.statusCode).toBe(201);

      // A credential is an owner boundary, not just a door: what it opens is
      // one owner's data.
      const listed = await app.inject({
        method: 'GET',
        url: '/v1/projects',
        headers: { authorization: `Bearer ${forMine.token}` },
      });
      expect(listed.json<{ projects: unknown[] }>().projects).toEqual([]);
    });

    it('is accepted with a lowercase scheme, as HTTP allows', async () => {
      const issued = await issue(await makeOwner());

      const response = await app.inject({
        method: 'GET',
        url: '/v1/me',
        headers: { authorization: `bearer ${issued.token}` },
      });

      expect(response.statusCode).toBe(200);
    });
  });

  describe('what is refused, and how alike the refusals are', () => {
    let bodies: string[];

    it.each([
      ['nothing at all', async () => me()],
      [
        'an empty header',
        async () => app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: '' } }),
      ],
      [
        'another scheme',
        async () =>
          app.inject({
            method: 'GET',
            url: '/v1/me',
            headers: { authorization: 'Basic dXNlcjpwYXNz' },
          }),
      ],
      [
        'a scheme with no token',
        async () =>
          app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: 'Bearer' } }),
      ],
      ['a token of the wrong shape', async () => me('not-a-memory-token')],
      [
        'a token with the wrong prefix',
        async () =>
          me(`key_${generateCredentialToken().lookup}_${generateCredentialToken().secret}`),
      ],
      [
        'a well-formed token that was never issued',
        async () => me(formatCredentialToken(generateCredentialToken())),
      ],
    ])('refuses %s', async (_label, send) => {
      const response = await send();

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    });

    it('refuses a real lookup carrying a different secret', async () => {
      // The test that makes the hash column matter. The lookup half is stored
      // in the clear and is not a secret; if presenting a known one were
      // enough, the secret would be decoration and anyone who had ever seen a
      // token could authenticate.
      const issued = await issue(await makeOwner());
      const impostor = `${TOKEN_PREFIX}_${issued.lookup}_${generateCredentialToken().secret}`;

      const response = await me(impostor);

      expect(response.statusCode).toBe(401);
      expect((await me(issued.token)).statusCode).toBe(200);
    });

    it('answers every refusal with the same body', async () => {
      const issued = await issue(await makeOwner());
      const revoked = await issue(await makeOwner());
      await createCredentialRepository(pool).revoke(
        ownersCreated[ownersCreated.length - 1] as OwnerId,
        revoked.credentialId,
      );

      const responses = await Promise.all([
        me(),
        app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: 'Bearer' } }),
        me('not-a-memory-token'),
        me(formatCredentialToken(generateCredentialToken())),
        me(`${TOKEN_PREFIX}_${issued.lookup}_${generateCredentialToken().secret}`),
        me(revoked.token),
      ]);

      bodies = responses.map((response) => {
        const body = response.json<{ error: unknown; request_id: string }>();
        return JSON.stringify(body.error);
      });

      // Missing, malformed, unknown, wrong and revoked are five different
      // things to an operator and one thing to a caller. Distinguishing them
      // would answer questions about credentials the caller does not hold.
      expect(new Set(bodies).size).toBe(1);
      expect(responses.every((response) => response.statusCode === 401)).toBe(true);
    });
  });

  describe('the owner id is not a credential', () => {
    it('refuses a request with no credential even when MEMORY_OWNER_ID names a real owner', async () => {
      const ownerId = await makeOwner();
      const previous = process.env[MEMORY_OWNER_ID_VAR];
      process.env[MEMORY_OWNER_ID_VAR] = ownerId;

      try {
        // A fresh app, so nothing could have been captured before the variable
        // was set. There is no path from configuration to an HTTP context: an
        // identifier that lives in `.env` and cannot be revoked must not open
        // anything.
        const fresh = buildApp([]);
        const response = await fresh.inject({ method: 'GET', url: '/v1/me' });

        expect(response.statusCode).toBe(401);
      } finally {
        if (previous === undefined) {
          delete process.env[MEMORY_OWNER_ID_VAR];
        } else {
          process.env[MEMORY_OWNER_ID_VAR] = previous;
        }
      }
    });

    it('refuses an owner id presented as a bearer token', async () => {
      const ownerId = await makeOwner();

      expect((await me(ownerId)).statusCode).toBe(401);
    });
  });

  describe('revocation', () => {
    it('takes effect on the next request, in the same process', async () => {
      const ownerId = await makeOwner();
      const issued = await issue(ownerId);

      expect((await me(issued.token)).statusCode).toBe(200);

      await createCredentialRepository(pool).revoke(ownerId, issued.credentialId);

      // No restart, no wait. Nothing about a credential is held between
      // requests, so there is no window in which a revoked one still works.
      expect((await me(issued.token)).statusCode).toBe(401);
    });

    it('leaves a client’s other credential working, so one can replace the other', async () => {
      const ownerId = await makeOwner();
      const first = await issue(ownerId);
      const second = await issueFor(first.clientId);

      expect((await me(first.token)).statusCode).toBe(200);
      expect((await me(second.token)).statusCode).toBe(200);

      await createCredentialRepository(pool).revoke(ownerId, first.credentialId);

      // This is why a client and a credential are separate rows: rotation is
      // an overlap rather than a gap.
      expect((await me(first.token)).statusCode).toBe(401);
      expect((await me(second.token)).statusCode).toBe(200);
    });

    it('will not revoke another owner’s credential', async () => {
      const mine = await makeOwner();
      const theirs = await makeOwner();
      const forTheirs = await issue(theirs);

      const revoked = await createCredentialRepository(pool).revoke(mine, forTheirs.credentialId);

      // Scoped in the statement, so knowing an id is not enough.
      expect(revoked).toBe(false);
      expect((await me(forTheirs.token)).statusCode).toBe(200);
    });

    it('reports nothing to do when revoking twice', async () => {
      const ownerId = await makeOwner();
      const issued = await issue(ownerId);
      const repository = createCredentialRepository(pool);

      expect(await repository.revoke(ownerId, issued.credentialId)).toBe(true);
      // The first revocation is the one that happened; moving the timestamp
      // would rewrite when it did.
      expect(await repository.revoke(ownerId, issued.credentialId)).toBe(false);
    });
  });

  describe('nothing keeps the secret', () => {
    it('stores a digest, and no part of the token', async () => {
      const ownerId = await makeOwner();
      const issued = await issue(ownerId);
      await me(issued.token);

      const dump = await pool.query<{ row: unknown }>(
        `select to_jsonb(cc) as row from public.client_credentials cc
          where cc.token_lookup = $1`,
        [issued.lookup],
      );
      const stored = JSON.stringify(dump.rows);

      // The lookup is a public selector and is meant to be here; finding it is
      // not a leak. The secret is what must be absent.
      expect(stored).toContain(issued.lookup);
      expect(stored).not.toContain(issued.secret);
      expect(stored).not.toContain(issued.token);

      // The three assertions above are not enough on their own, which is worth
      // recording. `to_jsonb` renders `bytea` as hex, so a column holding the
      // secret in plain bytes reads as `\x6b...` and no substring search for
      // the secret finds it. Storing the secret's own bytes in place of a
      // digest passed every test in this file until these two were added.
      const column = await pool.query<{ readable: string; digest: Buffer }>(
        `select encode(cc.token_hash, 'escape') as readable, cc.token_hash as digest
           from public.client_credentials cc where cc.token_lookup = $1`,
        [issued.lookup],
      );
      const [row] = column.rows;
      expect(row).toBeDefined();

      // Decoded rather than hex-rendered: what a person reading the bytes sees.
      expect(row?.readable).not.toContain(issued.secret);
      expect(row?.readable).not.toContain(issued.secret.slice(0, 16));

      // Computed here, from the standard library, rather than by calling the
      // function under test — otherwise this asserts only that hashing is
      // self-consistent, which a reversible "digest" satisfies too.
      const expected = createHash('sha256').update(issued.secret, 'utf8').digest();
      expect(row?.digest.equals(expected)).toBe(true);
    });

    it('has the secret nowhere in the database at all', async () => {
      const ownerId = await makeOwner();
      const issued = await issue(ownerId);

      // Use it, so anything that records a request has had its chance.
      await me(issued.token);
      const project = await app.inject({
        method: 'POST',
        url: '/v1/projects',
        headers: { authorization: `Bearer ${issued.token}` },
        payload: { project_name: 'after authenticating' },
      });
      expect(project.statusCode).toBe(201);

      const tables = [
        'owners',
        'clients',
        'client_credentials',
        'projects',
        'environments',
        'problems',
        'events',
        'verifications',
        'relations',
        'usage_logs',
        'change_logs',
      ];
      const dumps: string[] = [];
      for (const table of tables) {
        const rows = await pool.query(`select to_jsonb(t) as row from public.${table} t`);
        dumps.push(JSON.stringify(rows.rows));
      }
      const everything = dumps.join('\n');

      expect(everything).not.toContain(issued.secret);
      expect(everything).not.toContain(issued.token);
    });

    it('keeps the token out of responses, successful or refused', async () => {
      const issued = await issue(await makeOwner());

      const ok = await me(issued.token);
      const refused = await me(
        `${TOKEN_PREFIX}_${issued.lookup}_${generateCredentialToken().secret}`,
      );

      for (const body of [ok.body, refused.body]) {
        expect(body).not.toContain(issued.secret);
        expect(body).not.toContain(issued.token);
        expect(body).not.toContain(issued.lookup);
      }
    });

    it('keeps the token out of the operational log', async () => {
      const issued = await issue(await makeOwner());
      const lines: string[] = [];
      const logged = buildApp(lines);

      await logged.inject({
        method: 'GET',
        url: '/v1/me',
        headers: { authorization: `Bearer ${issued.token}` },
      });
      await logged.inject({
        method: 'GET',
        url: '/v1/me',
        headers: {
          authorization: `Bearer ${TOKEN_PREFIX}_${issued.lookup}_${generateCredentialToken().secret}`,
        },
      });

      const written = lines.join('\n');
      expect(written).not.toContain(issued.secret);
      expect(written).not.toContain(issued.token);
    });

    it('lists the credential headers it removes, and removes rather than marks them', () => {
      const options = createLoggerOptions('trace');

      // Asserted structurally, and the reason is worth stating rather than
      // hiding behind a request that appears to prove more. Fastify's own
      // `req` serializer writes method, url and address and never headers, so
      // no request this server serves can carry a credential into a log line,
      // and redaction removes nothing today. That makes it dormant defence for
      // the moment a serializer changes or an error path dumps a request —
      // exactly when nobody re-derives which headers are credentials — and it
      // also makes it impossible to falsify through a request. Pinning the
      // configuration is the honest test; a behavioural one here would pass
      // whether or not redaction existed.
      expect(options.redact.paths).toContain('req.headers.authorization');
      expect(options.redact.paths).toContain('req.headers.cookie');
      expect(options.redact.paths).toContain('req.headers["x-api-key"]');
      expect(options.redact.paths).toContain('req.headers["proxy-authorization"]');

      // Removed outright rather than replaced by a marker: a marker still
      // reports whether a request carried a credential.
      expect(options.redact.remove).toBe(true);
    });

    it('reports a failure by a reason this codebase chose, never by what was sent', async () => {
      const issued = await issue(await makeOwner());
      const lines: string[] = [];
      const logged = buildApp(lines);

      await logged.inject({
        method: 'GET',
        url: '/v1/me',
        headers: {
          authorization: `Bearer ${TOKEN_PREFIX}_${issued.lookup}_${generateCredentialToken().secret}`,
        },
      });

      const written = lines.join('\n');
      // A closed set of identifiers. P3-01 through P3-03 arrived at this rule
      // the hard way: any string an outside party can influence reaches a log.
      expect(written).toMatch(/MISSING|MALFORMED|UNKNOWN|INVALID|REVOKED/);
      expect(written).not.toContain(issued.secret);
    });
  });

  describe('credentials are not Memory content', () => {
    it('never puts a digest or a client id into what an owner recorded', async () => {
      const ownerId = await makeOwner();
      const issued = await issue(ownerId);
      const auth = { authorization: `Bearer ${issued.token}` };

      const project = (
        await app.inject({
          method: 'POST',
          url: '/v1/projects',
          headers: auth,
          payload: { project_name: 'p' },
        })
      ).json<{ project_id: string }>();
      const environment = (
        await app.inject({
          method: 'POST',
          url: `/v1/projects/${project.project_id}/environments`,
          headers: auth,
          payload: { snapshot: { runtime: 'node 22.12.0' } },
        })
      ).json<{ environment_id: string }>();
      const problem = (
        await app.inject({
          method: 'POST',
          url: `/v1/projects/${project.project_id}/problems`,
          headers: auth,
          payload: {
            environment_id: environment.environment_id,
            title: 'a problem',
            symptoms: 'observed',
          },
        })
      ).json<{ problem_id: string }>();
      await app.inject({
        method: 'PATCH',
        url: `/v1/problems/${problem.problem_id}`,
        headers: auth,
        payload: { expected_version: 1, changed_by: 'phase3-e2e', importance: true },
      });

      const digest = hashCredentialSecret(issued.secret).toString('hex');
      const dumps: string[] = [];
      for (const table of ['projects', 'environments', 'problems', 'events', 'change_logs']) {
        const rows = await pool.query(`select to_jsonb(t) as row from public.${table} t`);
        dumps.push(JSON.stringify(rows.rows));
      }
      const memory = dumps.join('\n');

      // The completion condition, stated plainly: credential material does not
      // appear in what an owner wrote down.
      expect(memory).not.toContain(digest);
      expect(memory).not.toContain(issued.clientId);
      expect(memory).not.toContain(issued.credentialId);
      expect(memory).not.toContain(issued.secret);
    });

    it('still redacts a credential a caller pastes into Memory content', async () => {
      const ownerId = await makeOwner();
      const issued = await issue(ownerId);
      const auth = { authorization: `Bearer ${issued.token}` };
      const pasted = generateCredentialToken();

      const project = await app.inject({
        method: 'POST',
        url: '/v1/projects',
        headers: auth,
        payload: { project_name: `Authorization: Bearer ${formatCredentialToken(pasted)}` },
      });

      // Two separate mechanisms, and both still work: authentication reads a
      // credential from a header, and sanitization keeps one out of content.
      expect(project.statusCode).toBe(201);
      expect(project.body).toContain('[REDACTED]');
      expect(project.body).not.toContain(pasted.secret);
    });
  });
});
