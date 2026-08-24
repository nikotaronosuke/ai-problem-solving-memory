/**
 * The four current-Problem write handlers over their real adapter and client.
 *
 * These tests stop at a small HTTP fixture so they can observe the exact body
 * the Memory receives and independently choose the resource it returns. That
 * matters for owner-wide first-write-wins: a successful append may truthfully
 * return an older record from another Problem, and the plugin must not rewrite
 * that answer into the Problem it attempted to append to.
 */

import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createProblemBindingStore } from '@ai-problem-solving-memory/claude-code-adapter';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { callContextFilename } from '../src/host-call-context.js';
import {
  ADD_EVENT_TOOL,
  ADD_VERIFICATION_TOOL,
  BINDINGS_DIRECTORY,
  CALL_CONTEXT_DIRECTORY,
  CLOSE_PROBLEM_TOOL,
  hostToolName,
  MARK_FIX_CANDIDATE_TOOL,
  PLUGIN_DATA_ENV,
  type MemoryTool,
} from '../src/runtime-constants.js';
import {
  handleAddEvent,
  handleAddVerification,
  handleCloseProblem,
  handleMarkFixCandidate,
} from '../src/server.js';

const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const PROJECT_ID = '22222222-3333-4444-8555-666666666666';
const PROBLEM_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
const OTHER_PROBLEM_ID = 'bbbbbbbb-1111-4222-8333-444444444444';
const OWNER_ID = '99999999-8888-4777-8666-555555555555';
const EVENT_ID = 'cccccccc-1111-4222-8333-444444444444';
const VERIFICATION_ID = 'dddddddd-1111-4222-8333-444444444444';
const EVENT_KEY = 'eeeeeeee-1111-4222-8333-444444444444';
const VERIFICATION_KEY = 'ffffffff-1111-4222-8333-444444444444';
const CALL_ID = 'toolu_01AAAAAAAAAAAAAAAAAAAAAA';
const NOW = 1_800_000_000_000;
const REMOTE = 'https://github.com/acme/widget.git';

/** Synthetic. Shaped like a credential and not one. */
const FAKE_TOKEN = 'memory_test_0000000000000000000000000000';

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

interface ReceivedWrite {
  readonly path: string;
  readonly body: Record<string, unknown>;
}

let pluginData: string;
let projectDir: string;
let memory: Server;
let baseUrl: string;
let received: ReceivedWrite[];

function answer(response: import('node:http').ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

/** A Memory fixture whose append answers deliberately replay another Problem. */
async function startMemory(): Promise<void> {
  received = [];
  memory = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      const path = incoming.url ?? '';
      const parsed =
        chunks.length === 0
          ? {}
          : (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);

      if (incoming.method === 'POST') {
        received.push({ path, body: parsed });
      }
      if (incoming.method === 'GET' && path === '/v1/projects') {
        answer(response, 200, { projects: [project()] });
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
          problem_id: OTHER_PROBLEM_ID,
          event_type: 'DISCOVERY',
          summary: 'the first write remains authoritative',
          result: 'an earlier result',
          reason: null,
          source_ai: 'another-adapter',
          evidence_ref: null,
          client_event_id: EVENT_KEY,
          created_at: '2026-01-03T00:00:00.000Z',
        });
        return;
      }
      if (incoming.method === 'POST' && path === `/v1/problems/${PROBLEM_ID}/verifications`) {
        answer(response, 201, {
          verification_id: VERIFICATION_ID,
          owner_id: OWNER_ID,
          problem_id: OTHER_PROBLEM_ID,
          verification_type: 'BUILD',
          result: false,
          summary: 'the first check remains authoritative',
          evidence_ref: null,
          verified_by: 'another-adapter',
          client_event_id: VERIFICATION_KEY,
          created_at: '2026-01-03T00:00:00.000Z',
        });
        return;
      }
      if (incoming.method === 'POST' && path === `/v1/problems/${PROBLEM_ID}/close`) {
        // Deliberately not derived from the request version. The handler maps
        // the resource the client accepted; it does not invent response state.
        answer(response, 200, problem({ status: 'PAUSED', version: 23 }));
        return;
      }
      if (incoming.method === 'POST' && path === `/v1/problems/${PROBLEM_ID}/status-transitions`) {
        answer(response, 200, problem({ status: 'FIX_CANDIDATE', version: 17 }));
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

async function mintFor(tool: MemoryTool): Promise<void> {
  const directory = join(pluginData, CALL_CONTEXT_DIRECTORY);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, callContextFilename(CALL_ID)),
    JSON.stringify({
      format_version: 2,
      session_id: SESSION_ID,
      tool_name: hostToolName(tool),
      current_directory: projectDir,
      minted_at: NOW,
    }),
    'utf8',
  );
}

const request = (): unknown => ({
  method: 'tools/call',
  _meta: { 'claudecode/toolUseId': CALL_ID },
});

const options = () => ({
  environment: {
    [PLUGIN_DATA_ENV]: pluginData,
    MEMORY_API_TOKEN: FAKE_TOKEN,
    MEMORY_API_URL: baseUrl,
  },
  now: () => NOW,
});

function writeTo(suffix: string): ReceivedWrite {
  const found = received.find((entry) => entry.path.endsWith(suffix));
  if (found === undefined) {
    throw new Error('Expected write was not received.');
  }
  return found;
}

beforeEach(async () => {
  pluginData = await mkdtemp(join(tmpdir(), 'recording-data-'));
  projectDir = await mkdtemp(join(tmpdir(), 'recording-root-'));

  const git = (...args: string[]): void => {
    const result = spawnSync('git', args, { cwd: projectDir, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error('Could not create the disposable repository.');
    }
  };
  git('init', '-q');
  git('remote', 'add', 'origin', REMOTE);

  await startMemory();
  await createProblemBindingStore({
    directory: join(pluginData, BINDINGS_DIRECTORY),
  }).writeBinding(SESSION_ID, PROJECT_ID, PROBLEM_ID);
});

afterEach(async () => {
  await new Promise<void>((resolve) => memory.close(() => resolve()));
  await rm(pluginData, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

describe('current-Problem write handlers', () => {
  it('preserves Event nulls and exposes a cross-Problem first-write replay', async () => {
    await mintFor(ADD_EVENT_TOOL);

    await expect(
      handleAddEvent(request(), options(), {
        event_type: 'DEAD_END',
        summary: 'the attempted direction did not work',
        client_event_id: EVENT_KEY,
        result: null,
        reason: null,
        evidence_ref: null,
      }),
    ).resolves.toEqual({
      kind: 'EVENT_RECORDED',
      problem_id: OTHER_PROBLEM_ID,
      event_id: EVENT_ID,
      client_event_id: EVENT_KEY,
      on_current_problem: false,
    });

    expect(writeTo('/events').body).toEqual({
      event_type: 'DEAD_END',
      summary: 'the attempted direction did not work',
      client_event_id: EVENT_KEY,
      source_ai: 'claude-code',
      result: null,
      reason: null,
      evidence_ref: null,
    });
  });

  it('preserves a Verification null and exposes a cross-Problem first-write replay', async () => {
    await mintFor(ADD_VERIFICATION_TOOL);

    await expect(
      handleAddVerification(request(), options(), {
        verification_type: 'TEST',
        result: true,
        summary: 'the regression suite passed',
        client_event_id: VERIFICATION_KEY,
        evidence_ref: null,
      }),
    ).resolves.toEqual({
      kind: 'VERIFICATION_RECORDED',
      problem_id: OTHER_PROBLEM_ID,
      verification_id: VERIFICATION_ID,
      client_event_id: VERIFICATION_KEY,
      on_current_problem: false,
    });

    expect(writeTo('/verifications').body).toEqual({
      verification_type: 'TEST',
      result: true,
      summary: 'the regression suite passed',
      client_event_id: VERIFICATION_KEY,
      verified_by: 'claude-code',
      evidence_ref: null,
    });
  });

  it('preserves a null fix kind and maps the close resource status and version', async () => {
    await mintFor(CLOSE_PROBLEM_TOOL);

    await expect(
      handleCloseProblem(request(), options(), {
        target_status: 'PAUSED',
        fix_kind: null,
      }),
    ).resolves.toEqual({
      kind: 'PROBLEM_CLOSED',
      problem_id: PROBLEM_ID,
      status: 'PAUSED',
      version: 23,
    });

    expect(writeTo('/close').body).toEqual({
      expected_version: 11,
      changed_by: 'claude-code',
      target_status: 'PAUSED',
      fix_kind: null,
    });
  });

  it('fixes the transition target and maps the accepted resource version', async () => {
    await mintFor(MARK_FIX_CANDIDATE_TOOL);

    await expect(handleMarkFixCandidate(request(), options())).resolves.toEqual({
      kind: 'FIX_CANDIDATE_MARKED',
      problem_id: PROBLEM_ID,
      status: 'FIX_CANDIDATE',
      version: 17,
    });

    expect(writeTo('/status-transitions').body).toEqual({
      expected_version: 11,
      changed_by: 'claude-code',
      target_status: 'FIX_CANDIDATE',
    });
  });
});
