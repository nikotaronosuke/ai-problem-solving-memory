/**
 * The remote Streamable HTTP edge, driven end to end through its fetch face.
 *
 * These tests stop at a small HTTP fixture standing in for the Memory Server,
 * so they can observe exactly which credential every request presented and
 * exactly which body every write carried. The properties held here are the
 * P9-02 boundary: transport authentication before any tool runs, an explicit
 * origin allowlist, provenance the model cannot choose, no ambient-credential
 * fallback, and every core refusal — verification gate, version conflict —
 * arriving through the remote path as the same typed outcome the local path
 * reports.
 */

import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createRemoteEdgeHandler,
  RemoteEdgeConfigError,
  resolveRemoteEdgeConfig,
} from '../src/remote-edge.js';
import { handleCurrentProblem } from '../src/server.js';

const OWNER_ID = '99999999-8888-4777-8666-555555555555';
const PROJECT_ID = '22222222-3333-4444-8555-666666666666';
const PROBLEM_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
const EVENT_ID = 'cccccccc-1111-4222-8333-444444444444';
const EVENT_KEY = 'eeeeeeee-1111-4222-8333-444444444444';
const NOW = 1_800_000_000_000;
const REMOTE = 'https://github.com/acme/widget.git';
const ALLOWED_ORIGIN = 'https://allowed.example';

/** Synthetic. Shaped like credentials and not credentials. */
const GOOD_TOKEN = 'memory_test_1111111111111111111111111111';
const AMBIENT_TOKEN = 'memory_test_ambient_must_never_be_sent00';

const project = (): unknown => ({
  project_id: PROJECT_ID,
  owner_id: OWNER_ID,
  project_name: 'widget',
  repo: 'github.com/acme/widget',
  platform: null,
  repo_subpath: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
});

const problem = (overrides: Record<string, unknown> = {}): unknown => ({
  problem_id: PROBLEM_ID,
  owner_id: OWNER_ID,
  project_id: PROJECT_ID,
  environment_id: '12121212-1111-4222-8333-444444444444',
  title: 'the export is empty',
  symptoms: 'the scheduled run writes no rows',
  problem_domain: null,
  suspected_boundary: null,
  source_ai: 'claude-code',
  status: 'INVESTIGATING',
  fix_kind: null,
  importance: false,
  confidence: 'LOW',
  freshness: 'CURRENT',
  memory_read_enabled: true,
  memory_write_enabled: true,
  suppressed: false,
  version: 11,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
  ...overrides,
});

interface ReceivedRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: Record<string, unknown>;
}

let stateDir: string;
let projectDir: string;
let memory: Server;
let baseUrl: string;
let received: ReceivedRequest[];
/** What the fixture's close endpoint answers with next. */
let closeAnswer: { status: number; body: unknown };

function answer(response: import('node:http').ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function startMemory(): Promise<void> {
  received = [];
  closeAnswer = { status: 200, body: problem({ status: 'PAUSED', version: 12 }) };
  memory = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      const path = incoming.url ?? '';
      const parsed =
        chunks.length === 0
          ? {}
          : (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
      received.push({
        method: incoming.method ?? '',
        path,
        authorization: incoming.headers.authorization,
        body: parsed,
      });

      if (incoming.headers.authorization !== `Bearer ${GOOD_TOKEN}`) {
        answer(response, 401, {
          error: { code: 'UNAUTHENTICATED', message: 'Unauthenticated.' },
          request_id: 'req-fixture',
        });
        return;
      }
      if (incoming.method === 'GET' && path === '/v1/me') {
        answer(response, 200, { owner_id: OWNER_ID });
        return;
      }
      if (incoming.method === 'GET' && path === '/v1/projects') {
        answer(response, 200, { projects: [project()] });
        return;
      }
      if (incoming.method === 'GET' && path === `/v1/projects/${PROJECT_ID}/problems`) {
        answer(response, 200, { problems: [problem()] });
        return;
      }
      if (incoming.method === 'GET' && path === `/v1/problems/${PROBLEM_ID}`) {
        answer(response, 200, problem());
        return;
      }
      if (incoming.method === 'POST' && path === `/v1/problems/${PROBLEM_ID}/events`) {
        answer(response, 201, {
          event_id: EVENT_ID,
          owner_id: OWNER_ID,
          problem_id: PROBLEM_ID,
          event_type: 'DEAD_END',
          summary: 'the attempted direction did not work',
          result: null,
          reason: null,
          source_ai: 'remote-mcp',
          evidence_ref: null,
          client_event_id: EVENT_KEY,
          created_at: '2026-01-03T00:00:00.000Z',
        });
        return;
      }
      if (incoming.method === 'POST' && path === `/v1/problems/${PROBLEM_ID}/close`) {
        answer(response, closeAnswer.status, closeAnswer.body);
        return;
      }

      answer(response, 404, {
        error: { code: 'NOT_FOUND', message: 'Not found.' },
        request_id: 'req-fixture',
      });
    });
  });
  await new Promise<void>((resolve) => memory.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${String((memory.address() as AddressInfo).port)}`;
}

const environment = (): Record<string, string | undefined> => ({
  MEMORY_API_URL: baseUrl,
  MEMORY_REMOTE_WORKSPACE: projectDir,
  MEMORY_CLAUDE_PLUGIN_DATA: stateDir,
  MEMORY_REMOTE_ALLOWED_ORIGINS: ALLOWED_ORIGIN,
  // Deliberately present, deliberately wrong: the edge must present only the
  // caller's verified credential, never this ambient one.
  MEMORY_API_TOKEN: AMBIENT_TOKEN,
});

const edge = (): ((request: Request) => Promise<Response>) =>
  createRemoteEdgeHandler({ environment: environment(), now: () => NOW });

function mcpRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://127.0.0.1/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${GOOD_TOKEN}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const toolCall = (name: string, args: Record<string, unknown>): unknown => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name, arguments: args },
});

/** Reads one JSON-RPC response out of either a JSON or an SSE answer. */
async function rpcResultOf(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream')) {
    const data = text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim())
      .filter((line) => line.length > 0);
    expect(data.length).toBeGreaterThan(0);
    return JSON.parse(data[data.length - 1]!) as Record<string, unknown>;
  }
  return JSON.parse(text) as Record<string, unknown>;
}

/** The tool's structured result, after asserting the RPC layer succeeded. */
async function structuredContentOf(response: Response): Promise<Record<string, unknown>> {
  expect(response.status).toBe(200);
  const rpc = await rpcResultOf(response);
  const result = rpc['result'] as Record<string, unknown> | undefined;
  expect(result, JSON.stringify(rpc)).toBeDefined();
  return result!['structuredContent'] as Record<string, unknown>;
}

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'remote-edge-data-'));
  projectDir = await mkdtemp(join(tmpdir(), 'remote-edge-root-'));
  const git = (...args: string[]): void => {
    const result = spawnSync('git', args, { cwd: projectDir, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error('Could not create the disposable repository.');
    }
  };
  git('init', '-q');
  git('remote', 'add', 'origin', REMOTE);
  await startMemory();
});

afterEach(async () => {
  await new Promise<void>((resolve) => memory.close(() => resolve()));
  await rm(stateDir, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

describe('the remote edge transport boundary', () => {
  it('refuses an unauthenticated request without consulting the Memory', async () => {
    const response = await edge()(
      new Request('http://127.0.0.1/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(toolCall('current_problem', {})),
      }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
    expect(received).toHaveLength(0);
  });

  it('refuses a credential the Memory does not recognise', async () => {
    const response = await edge()(
      mcpRequest(toolCall('current_problem', {}), {
        authorization: 'Bearer memory_test_2222222222222222222222222222',
      }),
    );
    expect(response.status).toBe(401);
    // Only the verification request reached the fixture; no tool ran.
    expect(received.map((one) => one.path)).toEqual(['/v1/me']);
  });

  it('refuses a disallowed Origin before reading any credential', async () => {
    const response = await edge()(
      mcpRequest(toolCall('current_problem', {}), { origin: 'https://evil.example' }),
    );
    expect(response.status).toBe(403);
    expect(received).toHaveLength(0);
  });

  it('accepts the explicitly allowed Origin', async () => {
    const outcome = await structuredContentOf(
      await edge()(mcpRequest(toolCall('current_problem', {}), { origin: ALLOWED_ORIGIN })),
    );
    expect(outcome['kind']).toBe('PROBLEM_CANDIDATES');
  });

  it('answers only the one endpoint', async () => {
    const response = await edge()(
      new Request('http://127.0.0.1/other', { method: 'POST', body: '{}' }),
    );
    expect(response.status).toBe(404);
  });

  it('refuses a wildcard origin allowlist at configuration time', () => {
    expect(() =>
      resolveRemoteEdgeConfig({ ...environment(), MEMORY_REMOTE_ALLOWED_ORIGINS: '*' }),
    ).toThrow(RemoteEdgeConfigError);
  });
});

describe('the remote edge over the one core', () => {
  it('serves current_problem to a verified owner', async () => {
    const outcome = await structuredContentOf(
      await edge()(mcpRequest(toolCall('current_problem', {}))),
    );
    expect(outcome['kind']).toBe('PROBLEM_CANDIDATES');
    expect(outcome['candidates']).toEqual([
      { problem_id: PROBLEM_ID, status: 'INVESTIGATING', title: 'the export is empty' },
    ]);
  });

  it('continues a chosen Problem and appends a typed Event with the edge’s own provenance', async () => {
    const handle = edge();

    const continued = await structuredContentOf(
      await handle(
        mcpRequest(
          toolCall('continue_problem', { project_id: PROJECT_ID, problem_id: PROBLEM_ID }),
        ),
      ),
    );
    expect(continued['kind']).toBe('CONTINUED');

    const recorded = await structuredContentOf(
      await handle(
        mcpRequest(
          toolCall('add_event', {
            event_type: 'DEAD_END',
            summary: 'the attempted direction did not work',
            client_event_id: EVENT_KEY,
          }),
        ),
      ),
    );
    expect(recorded).toEqual({
      kind: 'EVENT_RECORDED',
      problem_id: PROBLEM_ID,
      event_id: EVENT_ID,
      client_event_id: EVENT_KEY,
      on_current_problem: true,
    });

    const write = received.find((one) => one.path.endsWith('/events'));
    expect(write).toBeDefined();
    // The provenance is the edge's own constant, not anything a model sent.
    expect(write!.body['source_ai']).toBe('remote-mcp');
    // And every request presented the caller's verified credential — the
    // ambient environment token never travelled anywhere.
    for (const one of received) {
      expect(one.authorization).toBe(`Bearer ${GOOD_TOKEN}`);
    }
  });

  it('rejects a model-supplied source_ai without reaching the Memory', async () => {
    const handle = edge();
    await structuredContentOf(
      await handle(
        mcpRequest(
          toolCall('continue_problem', { project_id: PROJECT_ID, problem_id: PROBLEM_ID }),
        ),
      ),
    );
    const writesBefore = received.filter((one) => one.method === 'POST').length;

    const response = await handle(
      mcpRequest(
        toolCall('add_event', {
          event_type: 'DEAD_END',
          summary: 'a forged attribution',
          client_event_id: EVENT_KEY,
          source_ai: 'claude-code',
        }),
      ),
    );
    const rpc = await rpcResultOf(response);
    const result = rpc['result'] as Record<string, unknown> | undefined;
    const isRefused = result === undefined || result['isError'] === true;
    expect(isRefused, JSON.stringify(rpc)).toBe(true);
    expect(received.filter((one) => one.method === 'POST')).toHaveLength(writesBefore);
  });

  it('rejects a model-supplied problem_id as write authority', async () => {
    const handle = edge();
    const response = await handle(
      mcpRequest(
        toolCall('add_event', {
          event_type: 'DEAD_END',
          summary: 'an arbitrary subject',
          client_event_id: EVENT_KEY,
          problem_id: PROBLEM_ID,
        }),
      ),
    );
    const rpc = await rpcResultOf(response);
    const result = rpc['result'] as Record<string, unknown> | undefined;
    const isRefused = result === undefined || result['isError'] === true;
    expect(isRefused, JSON.stringify(rpc)).toBe(true);
    expect(received.filter((one) => one.method === 'POST')).toHaveLength(0);
  });

  it('carries the verification gate through as the typed refusal', async () => {
    closeAnswer = {
      status: 400,
      body: {
        error: { code: 'INVALID_REQUEST', message: 'Request validation failed.' },
        request_id: 'req-fixture',
      },
    };
    const handle = edge();
    await structuredContentOf(
      await handle(
        mcpRequest(
          toolCall('continue_problem', { project_id: PROJECT_ID, problem_id: PROBLEM_ID }),
        ),
      ),
    );

    const outcome = await structuredContentOf(
      await handle(
        mcpRequest(toolCall('close_problem', { target_status: 'VERIFIED', fix_kind: 'ROOT_FIX' })),
      ),
    );
    expect(outcome).toEqual({ kind: 'ERROR', code: 'MEMORY_REFUSED' });
  });

  it('reports a stale-version conflict once, without retrying', async () => {
    closeAnswer = {
      status: 409,
      body: {
        error: { code: 'VERSION_CONFLICT', message: 'Problem version conflict.' },
        request_id: 'req-fixture',
      },
    };
    const handle = edge();
    await structuredContentOf(
      await handle(
        mcpRequest(
          toolCall('continue_problem', { project_id: PROJECT_ID, problem_id: PROBLEM_ID }),
        ),
      ),
    );

    const outcome = await structuredContentOf(
      await handle(mcpRequest(toolCall('close_problem', { target_status: 'PAUSED' }))),
    );
    expect(outcome).toEqual({ kind: 'ERROR', code: 'MEMORY_REFUSED' });
    expect(received.filter((one) => one.path.endsWith('/close'))).toHaveLength(1);
  });
});

describe('the local path beside the remote edge', () => {
  it('still authenticates by the hook claim when no establishment is injected', async () => {
    const outcome = await handleCurrentProblem(
      { method: 'tools/call' },
      { environment: {}, now: () => NOW },
    );
    expect(outcome).toEqual({ kind: 'ERROR', code: 'HOST_CONTEXT_UNAVAILABLE' });
  });
});
