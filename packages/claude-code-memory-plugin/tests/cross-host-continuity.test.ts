/**
 * One authoritative Problem continued through the same MCP runtime by two hosts.
 *
 * The HTTP fixture is stateful on purpose: the final assertions read its
 * canonical typed history rather than trusting earlier MCP results.
 */

import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { callContextFilename } from '../src/host-call-context.js';
import {
  ADD_EVENT_TOOL,
  ADD_VERIFICATION_TOOL,
  CALL_CONTEXT_DIRECTORY,
  CLOSE_PROBLEM_TOOL,
  CONTINUE_PROBLEM_TOOL,
  CURRENT_PROBLEM_TOOL,
  MARK_FIX_CANDIDATE_TOOL,
  PLUGIN_DATA_ENV,
  START_PROBLEM_TOOL,
  codexHostToolName,
  hostToolName,
  type MemoryTool,
} from '../src/runtime-constants.js';
import {
  handleAddEvent,
  handleAddVerification,
  handleCloseProblem,
  handleContinueProblem,
  handleCurrentProblem,
  handleMarkFixCandidate,
  handleStartProblem,
} from '../src/server.js';

const PROJECT_ID = '22222222-3333-4444-8555-666666666666';
const PROBLEM_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
const ENVIRONMENT_ID = 'bbbbbbbb-1111-4222-8333-444444444444';
const OWNER_ID = '99999999-8888-4777-8666-555555555555';
const CLAUDE_SESSION = '11111111-2222-4333-8444-555555555555';
const CODEX_SESSION = '77777777-2222-4333-8444-555555555555';
const EVENT_ONE_KEY = 'cccccccc-1111-4222-8333-444444444444';
const EVENT_TWO_KEY = 'dddddddd-1111-4222-8333-444444444444';
const VERIFICATION_KEY = 'eeeeeeee-1111-4222-8333-444444444444';
const NOW = 1_800_000_000_000;
const REMOTE = 'https://github.com/acme/widget.git';
const FAKE_TOKEN = 'memory_test_0000000000000000000000000000';

type Host = 'claude-code' | 'codex';

interface StoredEvent {
  readonly event_type: string;
  readonly summary: string;
  readonly source_ai: string | null;
}

interface StoredVerification {
  readonly verification_type: string;
  readonly result: boolean;
  readonly summary: string;
  readonly verified_by: string | null;
}

let pluginData: string;
let projectDir: string;
let memory: ReturnType<typeof createServer>;
let memoryUrl: string;
let nextCall = 0;
let problem: Record<string, unknown> | undefined;
let events: StoredEvent[];
let verifications: StoredVerification[];

const project = {
  project_id: PROJECT_ID,
  owner_id: OWNER_ID,
  project_name: 'widget',
  repo: 'github.com/acme/widget',
  platform: null,
  repo_subpath: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

function answer(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function problemResource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    problem_id: PROBLEM_ID,
    owner_id: OWNER_ID,
    project_id: PROJECT_ID,
    environment_id: ENVIRONMENT_ID,
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
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

async function startMemory(): Promise<void> {
  memory = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      const path = incoming.url ?? '';
      const body =
        chunks.length === 0
          ? {}
          : (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);

      if (incoming.method === 'GET' && path === '/v1/projects') {
        answer(response, 200, { projects: [project] });
        return;
      }
      if (incoming.method === 'GET' && path === `/v1/projects/${PROJECT_ID}/problems`) {
        answer(response, 200, { problems: problem === undefined ? [] : [problem] });
        return;
      }
      if (incoming.method === 'GET' && path === `/v1/problems/${PROBLEM_ID}` && problem) {
        answer(response, 200, problem);
        return;
      }
      if (incoming.method === 'POST' && path === `/v1/projects/${PROJECT_ID}/environments`) {
        answer(response, 201, {
          environment_id: ENVIRONMENT_ID,
          owner_id: OWNER_ID,
          project_id: PROJECT_ID,
          snapshot: body['snapshot'],
          created_at: '2026-01-01T00:00:00.000Z',
        });
        return;
      }
      if (incoming.method === 'POST' && path === `/v1/projects/${PROJECT_ID}/problems`) {
        problem = problemResource({
          environment_id: body['environment_id'],
          title: body['title'],
          symptoms: body['symptoms'],
          source_ai: body['source_ai'] ?? null,
        });
        answer(response, 201, problem);
        return;
      }
      if (incoming.method === 'POST' && path === `/v1/problems/${PROBLEM_ID}/events`) {
        const stored = {
          event_type: String(body['event_type']),
          summary: String(body['summary']),
          source_ai: typeof body['source_ai'] === 'string' ? body['source_ai'] : null,
        };
        events.push(stored);
        answer(response, 201, {
          event_id: events.length === 1 ? EVENT_ONE_KEY : EVENT_TWO_KEY,
          owner_id: OWNER_ID,
          problem_id: PROBLEM_ID,
          ...stored,
          result: null,
          reason: null,
          evidence_ref: null,
          client_event_id: body['client_event_id'],
          created_at: '2026-01-02T00:00:00.000Z',
        });
        return;
      }
      if (
        incoming.method === 'POST' &&
        path === `/v1/problems/${PROBLEM_ID}/status-transitions` &&
        problem
      ) {
        problem = {
          ...problem,
          status: body['target_status'],
          version: Number(problem['version']) + 1,
        };
        answer(response, 200, problem);
        return;
      }
      if (incoming.method === 'POST' && path === `/v1/problems/${PROBLEM_ID}/verifications`) {
        const stored = {
          verification_type: String(body['verification_type']),
          result: body['result'] === true,
          summary: String(body['summary']),
          verified_by: typeof body['verified_by'] === 'string' ? body['verified_by'] : null,
        };
        verifications.push(stored);
        answer(response, 201, {
          verification_id: VERIFICATION_KEY,
          owner_id: OWNER_ID,
          problem_id: PROBLEM_ID,
          ...stored,
          evidence_ref: null,
          client_event_id: body['client_event_id'],
          created_at: '2026-01-03T00:00:00.000Z',
        });
        return;
      }
      if (incoming.method === 'POST' && path === `/v1/problems/${PROBLEM_ID}/close` && problem) {
        const successful = verifications.some((verification) => verification.result);
        if (
          body['target_status'] !== 'VERIFIED' ||
          problem['status'] !== 'FIX_CANDIDATE' ||
          !successful
        ) {
          answer(response, 400, { error: { code: 'INVALID_REQUEST', message: 'Refused.' } });
          return;
        }
        problem = {
          ...problem,
          status: 'VERIFIED',
          fix_kind: body['fix_kind'] ?? null,
          version: Number(problem['version']) + 1,
        };
        answer(response, 200, problem);
        return;
      }

      answer(response, 404, { error: { code: 'NOT_FOUND', message: 'Not found.' } });
    });
  });
  await new Promise<void>((resolve) => memory.listen(0, '127.0.0.1', resolve));
  memoryUrl = `http://127.0.0.1:${String((memory.address() as AddressInfo).port)}`;
}

const options = () => ({
  environment: {
    [PLUGIN_DATA_ENV]: pluginData,
    MEMORY_API_TOKEN: FAKE_TOKEN,
    MEMORY_API_URL: memoryUrl,
  },
  now: () => NOW,
});

async function hostCall(host: Host, sessionId: string, tool: MemoryTool): Promise<unknown> {
  nextCall += 1;
  const callId = `${host}-call-${String(nextCall)}`;
  const directory = join(pluginData, CALL_CONTEXT_DIRECTORY);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, callContextFilename(callId)),
    JSON.stringify({
      format_version: 2,
      session_id: sessionId,
      tool_name: host === 'codex' ? codexHostToolName(tool) : hostToolName(tool),
      current_directory: projectDir,
      minted_at: NOW,
    }),
    'utf8',
  );
  return {
    method: 'tools/call',
    _meta: host === 'codex' ? { callId } : { 'claudecode/toolUseId': callId },
  };
}

beforeAll(async () => {
  pluginData = await mkdtemp(join(tmpdir(), 'cross-host-data-'));
  projectDir = await mkdtemp(join(tmpdir(), 'cross-host-root-'));
  const git = (...args: string[]): void => {
    const result = spawnSync('git', args, { cwd: projectDir, encoding: 'utf8' });
    if (result.status !== 0) throw new Error('Could not create the disposable repository.');
  };
  git('init', '-q');
  git('remote', 'add', 'origin', REMOTE);
  problem = undefined;
  events = [];
  verifications = [];
  await startMemory();
});

afterAll(async () => {
  await new Promise<void>((resolve) => memory.close(() => resolve()));
  await rm(pluginData, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

describe('same-Problem cross-host continuity', () => {
  it('keeps both hosts’ typed evidence and requires Codex Verification before VERIFIED', async () => {
    const started = await handleStartProblem(
      await hostCall('claude-code', CLAUDE_SESSION, START_PROBLEM_TOOL),
      options(),
      {
        project_id: PROJECT_ID,
        title: 'the export is empty',
        symptoms: 'the scheduled run writes no rows',
      },
    );
    expect(started).toMatchObject({ kind: 'STARTED', problem_id: PROBLEM_ID });

    await handleAddEvent(await hostCall('claude-code', CLAUDE_SESSION, ADD_EVENT_TOOL), options(), {
      event_type: 'DISCOVERY',
      summary: 'Claude isolated the empty export to the query boundary.',
      client_event_id: EVENT_ONE_KEY,
    });

    const offered = await handleCurrentProblem(
      await hostCall('codex', CODEX_SESSION, CURRENT_PROBLEM_TOOL),
      options(),
    );
    expect(offered).toMatchObject({
      kind: 'PROBLEM_CANDIDATES',
      project_id: PROJECT_ID,
      candidates: [{ problem_id: PROBLEM_ID }],
    });

    await expect(
      handleContinueProblem(
        await hostCall('codex', CODEX_SESSION, CONTINUE_PROBLEM_TOOL),
        options(),
        { project_id: PROJECT_ID, problem_id: PROBLEM_ID },
      ),
    ).resolves.toMatchObject({ kind: 'CONTINUED', problem_id: PROBLEM_ID });

    await handleAddEvent(await hostCall('codex', CODEX_SESSION, ADD_EVENT_TOOL), options(), {
      event_type: 'FIX',
      summary: 'Codex repaired the query boundary without replacing earlier evidence.',
      client_event_id: EVENT_TWO_KEY,
    });

    await expect(
      handleCurrentProblem(
        await hostCall('claude-code', CLAUDE_SESSION, CURRENT_PROBLEM_TOOL),
        options(),
      ),
    ).resolves.toEqual({
      kind: 'CURRENT_PROBLEM',
      project_id: PROJECT_ID,
      problem_id: PROBLEM_ID,
    });

    await handleMarkFixCandidate(
      await hostCall('codex', CODEX_SESSION, MARK_FIX_CANDIDATE_TOOL),
      options(),
    );
    await handleAddVerification(
      await hostCall('codex', CODEX_SESSION, ADD_VERIFICATION_TOOL),
      options(),
      {
        verification_type: 'TEST',
        result: true,
        summary: 'Codex ran the regression suite successfully.',
        client_event_id: VERIFICATION_KEY,
      },
    );
    await expect(
      handleCloseProblem(await hostCall('codex', CODEX_SESSION, CLOSE_PROBLEM_TOOL), options(), {
        target_status: 'VERIFIED',
        fix_kind: 'ROOT_FIX',
      }),
    ).resolves.toMatchObject({ kind: 'PROBLEM_CLOSED', status: 'VERIFIED' });

    expect(problem).toMatchObject({ problem_id: PROBLEM_ID, status: 'VERIFIED' });
    expect(events).toEqual([
      {
        event_type: 'DISCOVERY',
        summary: 'Claude isolated the empty export to the query boundary.',
        source_ai: 'claude-code',
      },
      {
        event_type: 'FIX',
        summary: 'Codex repaired the query boundary without replacing earlier evidence.',
        source_ai: 'codex',
      },
    ]);
    expect(verifications).toEqual([
      {
        verification_type: 'TEST',
        result: true,
        summary: 'Codex ran the regression suite successfully.',
        verified_by: 'codex',
      },
    ]);
  }, 30_000);
});
