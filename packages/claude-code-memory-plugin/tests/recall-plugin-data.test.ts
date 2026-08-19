/**
 * One authenticated call has one state directory.
 *
 * The call context is claimed against a directory validated at the start of the
 * call. Anything later in the same call that reads the environment again is
 * asking a question that has already been answered, and can get a different
 * answer: a path that disagrees with the one identity was established against,
 * or no path at all — which, patched up with a default, becomes a relative path
 * anchored on whatever directory the process happens to be running in. That is
 * how a plugin's private state ends up written into somebody's repository.
 *
 * So the validated directory is handed to the work rather than looked up again,
 * and these tests hold that shut with an environment that answers differently
 * the second time it is asked.
 */

import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createProblemBindingStore } from '@ai-problem-solving-memory/claude-code-adapter';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { callContextFilename } from '../src/host-call-context.js';
import { RECALL_FINGERPRINT_DIRECTORY } from '../src/recall-fingerprint-store.js';
import {
  BINDINGS_DIRECTORY,
  CALL_CONTEXT_DIRECTORY,
  hostToolName,
  PLUGIN_DATA_ENV,
  RECALL_SIMILAR_EXPERIENCE_TOOL,
  type MemoryTool,
} from '../src/runtime-constants.js';
import { handleCurrentProblem, handleRecallSimilarExperience } from '../src/server.js';

const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const PROJECT_ID = '22222222-3333-4444-8555-666666666666';
const PROBLEM_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
const OWNER_ID = '99999999-8888-4777-8666-555555555555';
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

const problem = (): unknown => ({
  problem_id: PROBLEM_ID,
  owner_id: OWNER_ID,
  project_id: PROJECT_ID,
  environment_id: 'cccccccc-1111-4222-8333-444444444444',
  title: 'the nightly export finishes with no rows',
  symptoms: 'an empty file, only on the scheduled run',
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
  version: 4,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
});

const QUERY = {
  lexical_text: 'export empty file',
  semantic_text: 'the scheduled export writes an empty file while reporting success',
  current_features: {
    problem_domain: 'batch export',
    symptom_patterns: ['an output file with no rows'],
    suspected_boundaries: ['the scheduler'],
    occurrence_conditions: ['only on the scheduled run'],
    successful_directions: [],
    dead_end_directions: [],
    environment_facts: [],
  },
};

/** The directory the call is authenticated against. */
let authenticated: string;
/** Somewhere else entirely, which nothing in this call may write into. */
let elsewhere: string;
let projectDir: string;
let memory: Server;
let base: string;
let searches: number;
/** How many times the environment was asked where state lives. */
let reads: number;

/**
 * An environment that answers once and then changes its mind.
 *
 * The first read is the authoritative one, exactly as a real environment would
 * be. Every read after it returns something else — which is not realistic and
 * is not meant to be: it is the only way to observe whether a second read
 * happened at all, and what it would have cost if it had.
 */
function shiftingEnvironment(after: string | undefined): NodeJS.ProcessEnv {
  reads = 0;
  return {
    MEMORY_API_TOKEN: FAKE_TOKEN,
    MEMORY_API_URL: base,
    get [PLUGIN_DATA_ENV](): string | undefined {
      reads += 1;
      return reads === 1 ? authenticated : after;
    },
  };
}

async function startMemory(): Promise<void> {
  searches = 0;
  memory = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      const url = incoming.url ?? '';
      const answer = (status: number, body: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      };

      if (url === '/v1/projects' && incoming.method === 'GET') {
        answer(200, { projects: [project()] });
        return;
      }
      if (url === `/v1/problems/${PROBLEM_ID}` && incoming.method === 'GET') {
        answer(200, problem());
        return;
      }
      if (url === `/v1/problems/${PROBLEM_ID}/search` && incoming.method === 'POST') {
        searches += 1;
        answer(200, {
          kind: 'SEARCHED',
          candidates: [],
          semantic_status: 'USED',
          structural_status: 'USED',
        });
        return;
      }
      answer(404, { error: { code: 'NOT_FOUND', message: 'nothing here' } });
    });
  });

  await new Promise<void>((resolve) => {
    memory.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${String((memory.address() as AddressInfo).port)}`;
}

/** Records a call context in the authenticated directory, as the hook would. */
async function mint(
  tool: MemoryTool = RECALL_SIMILAR_EXPERIENCE_TOOL,
  hostCallId = CALL_ID,
): Promise<void> {
  const directory = join(authenticated, CALL_CONTEXT_DIRECTORY);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, callContextFilename(hostCallId)),
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

const request = (hostCallId = CALL_ID): unknown => ({
  method: 'tools/call',
  _meta: { 'claudecode/toolUseId': hostCallId },
});

const recordsIn = async (directory: string): Promise<readonly string[]> => {
  try {
    return await readdir(join(directory, RECALL_FINGERPRINT_DIRECTORY));
  } catch {
    return [];
  }
};

beforeEach(async () => {
  authenticated = await mkdtemp(join(tmpdir(), 'authenticated-'));
  elsewhere = await mkdtemp(join(tmpdir(), 'elsewhere-'));
  projectDir = await mkdtemp(join(tmpdir(), 'plugin-data-root-'));

  const git = (...args: string[]): void => {
    spawnSync('git', args, { cwd: projectDir, encoding: 'utf8' });
  };
  await writeFile(join(projectDir, 'README.md'), '# widget\n', 'utf8');
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'nobody@example.invalid');
  git('config', 'user.name', 'Disposable');
  git('config', 'commit.gpgsign', 'false');
  git('remote', 'add', 'origin', REMOTE);
  git('add', '-A');
  git('commit', '-q', '-m', 'first');

  await startMemory();
  await createProblemBindingStore({
    directory: join(authenticated, BINDINGS_DIRECTORY),
  }).writeBinding(SESSION_ID, PROJECT_ID, PROBLEM_ID);
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    memory.close(() => resolve());
  });
  for (const directory of [authenticated, elsewhere, projectDir]) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('the directory a recall keeps its record in', () => {
  it('is the one the call was authenticated against', async () => {
    await mint();

    const outcome = await handleRecallSimilarExperience(
      request(),
      { environment: shiftingEnvironment(authenticated), now: () => NOW },
      QUERY,
    );

    expect((outcome as { kind: string }).kind).toBe('RECALLED');
    expect(await recordsIn(authenticated)).toHaveLength(1);
  });

  it('is asked for once, not once per thing that needs it', async () => {
    // The count is the whole point. Two reads is two answers, and the second
    // one is the one nothing validated against.
    await mint();

    await handleRecallSimilarExperience(
      request(),
      { environment: shiftingEnvironment(authenticated), now: () => NOW },
      QUERY,
    );

    expect(`environment reads during one recall:${String(reads)}`).toBe(
      'environment reads during one recall:1',
    );
  });

  it('cannot be moved by an environment that answers differently later', async () => {
    // If the handler asked again it would be told `elsewhere`, and the record
    // would land there — in a directory nothing about this call was checked
    // against.
    await mint();

    const outcome = await handleRecallSimilarExperience(
      request(),
      { environment: shiftingEnvironment(elsewhere), now: () => NOW },
      QUERY,
    );

    expect((outcome as { kind: string }).kind).toBe('RECALLED');
    expect(await recordsIn(authenticated)).toHaveLength(1);
    expect(`records written somewhere else:${String((await recordsIn(elsewhere)).length)}`).toBe(
      'records written somewhere else:0',
    );
  });

  it('cannot be lost by an environment that stops answering', async () => {
    // The dangerous version. A second read returning nothing, defaulted to an
    // empty string, is a relative path — so the record would be written under
    // whatever directory this process is running in, which on a real host is
    // somebody's repository.
    await mint();
    const before = await readdir(process.cwd());

    const outcome = await handleRecallSimilarExperience(
      request(),
      { environment: shiftingEnvironment(undefined), now: () => NOW },
      QUERY,
    );

    expect((outcome as { kind: string }).kind).toBe('RECALLED');
    expect(await recordsIn(authenticated)).toHaveLength(1);
    expect(
      `a fingerprint directory appeared beside the running process:${String(
        (await readdir(process.cwd())).length !== before.length,
      )}`,
    ).toBe('a fingerprint directory appeared beside the running process:false');
    expect(await recordsIn(process.cwd())).toEqual([]);
  });

  it('searched exactly once whatever the environment did afterwards', async () => {
    // A redirected record would have been a silent second search next time,
    // because the question would never have been found on record.
    await mint();

    await handleRecallSimilarExperience(
      request(),
      { environment: shiftingEnvironment(elsewhere), now: () => NOW },
      QUERY,
    );
    await mint(RECALL_SIMILAR_EXPERIENCE_TOOL, 'toolu_01BBBBBBBBBBBBBBBBBBBBBB');
    const again = await handleRecallSimilarExperience(
      request('toolu_01BBBBBBBBBBBBBBBBBBBBBB'),
      { environment: shiftingEnvironment(elsewhere), now: () => NOW },
      QUERY,
    );

    expect((again as { kind: string }).kind).toBe('ALREADY_RECALLED');
    expect(`searches issued:${String(searches)}`).toBe('searches issued:1');
  });
});

describe('the other tools', () => {
  it('still read the environment exactly once for a call', async () => {
    // Unchanged by this correction. The shared path already handed them what
    // they needed; only the recall handler was looking it up a second time.
    await mint('current_problem');

    await handleCurrentProblem(request(), {
      environment: shiftingEnvironment(elsewhere),
      now: () => NOW,
    });

    expect(`environment reads during one call:${String(reads)}`).toBe(
      'environment reads during one call:1',
    );
  });

  it('leave a binding in the authenticated directory and nowhere else', async () => {
    await mint('current_problem');

    await handleCurrentProblem(request(), {
      environment: shiftingEnvironment(elsewhere),
      now: () => NOW,
    });

    expect((await readdir(join(authenticated, BINDINGS_DIRECTORY))).length > 0).toBe(true);
    expect(
      `bindings written somewhere else:${String(
        (await readdir(elsewhere).catch(() => [])).length,
      )}`,
    ).toBe('bindings written somewhere else:0');
  });
});
