/**
 * The tool surface, and the order in which the runtime is allowed to fail.
 *
 * The order is the part worth testing hardest. A caller with no host context
 * must not be able to learn whether a Memory is configured, reachable, or even
 * pointed anywhere — every difference it could observe is an oracle about
 * somebody's machine. So the first refusal is always the same refusal, and the
 * tests below assert not only what came back but that nothing was consulted to
 * produce it.
 */

import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MemoryApiError,
  MemoryApiProtocolError,
  MemoryApiUnreachableError,
} from '@ai-problem-solving-memory/api-client';
import {
  MissingMemoryCredentialError,
  ProblemBindingArgumentError,
  ProjectRegistrationInvariantError,
} from '@ai-problem-solving-memory/claude-code-adapter';

import { CurrentProblemInvariantError } from '../src/current-problem.js';
import { callContextFilename } from '../src/host-call-context.js';
import {
  CALL_CONTEXT_DIRECTORY,
  CURRENT_PROBLEM_TOOL,
  HOST_TOOL_NAME,
  PLUGIN_DATA_ENV,
  PROJECT_DIR_ENV,
} from '../src/runtime-constants.js';
import {
  buildMemoryMcpServer,
  classify,
  CURRENT_PROBLEM_OUTPUT_SCHEMA,
  handleCurrentProblem,
  runtimePathsOf,
  RUNTIME_ERROR_CODES,
} from '../src/server.js';

const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const CALL_ID = 'toolu_01AAAAAAAAAAAAAAAAAAAAAA';
const NOW = 1_800_000_000_000;

/** Synthetic. Shaped like a credential and not one. */
const FAKE_TOKEN = 'memory_test_0000000000000000000000000000';

let pluginData: string;
let projectDir: string;

beforeEach(async () => {
  pluginData = await mkdtemp(join(tmpdir(), 'plugin-data-'));
  projectDir = await mkdtemp(join(tmpdir(), 'project-root-'));
});

afterEach(async () => {
  await rm(pluginData, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

function environment(overrides: Record<string, string | undefined> = {}) {
  return {
    [PROJECT_DIR_ENV]: projectDir,
    [PLUGIN_DATA_ENV]: pluginData,
    MEMORY_API_TOKEN: FAKE_TOKEN,
    ...overrides,
  };
}

/** A request as the host sends one, carrying its own identifier for the call. */
function request(hostCallId: string = CALL_ID): unknown {
  return { method: 'tools/call', _meta: { 'claudecode/toolUseId': hostCallId } };
}

/** Records a context the way the trusted hook would have. */
async function mintFor(hostCallId: string = CALL_ID, toolName = HOST_TOOL_NAME): Promise<void> {
  const directory = join(pluginData, CALL_CONTEXT_DIRECTORY);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, callContextFilename(hostCallId)),
    JSON.stringify({
      format_version: 1,
      session_id: SESSION_ID,
      tool_name: toolName,
      minted_at: NOW,
    }),
    'utf8',
  );
}

const handle = (req: unknown, env = environment()) =>
  handleCurrentProblem(req, { environment: env, now: () => NOW });

describe('the tool this runtime exposes', () => {
  it('is exactly one, named for the question it answers', () => {
    expect(CURRENT_PROBLEM_TOOL).toBe('current_problem');
    // The operations that act on the answers arrive with their own task.
    for (const absent of ['continue_problem', 'resume_problem', 'start_problem']) {
      expect(`${absent} exists:${CURRENT_PROBLEM_TOOL === absent}`).toBe(`${absent} exists:false`);
    }
  });

  it('builds without a transport', () => {
    expect(buildMemoryMcpServer({ environment: environment(), now: () => NOW })).toBeDefined();
  });

  it('describes every answer it may give, and no other', () => {
    const kinds = CURRENT_PROBLEM_OUTPUT_SCHEMA.options.map(
      (option) => option.shape.kind.value as string,
    );

    expect(kinds.sort()).toEqual([
      'BOUNDARY_REQUIRED',
      'CURRENT_PROBLEM',
      'ERROR',
      'EXPLICIT_REGISTRATION_REQUIRED',
      'NO_PROBLEM',
      'NO_PROJECT_SIGNAL',
      'PROBLEM_CANDIDATES',
      'PROJECT_AMBIGUOUS',
    ]);
  });

  it('validates each answer it may give', () => {
    const answers = [
      { kind: 'CURRENT_PROBLEM', project_id: 'p', problem_id: 'q' },
      { kind: 'NO_PROBLEM', project_id: 'p' },
      {
        kind: 'PROBLEM_CANDIDATES',
        project_id: 'p',
        candidates: [{ problem_id: 'q', status: 'PAUSED', title: 't' }],
      },
      {
        kind: 'PROJECT_AMBIGUOUS',
        reason: 'NO_MATCHING_REPO_BOUNDARY',
        candidates: [
          { project_id: 'p', project_name: 'n', canonical_repo: null, repo_subpath: null },
        ],
      },
      { kind: 'BOUNDARY_REQUIRED', project_name: 'n', detected_repo_subpath: 'apps/web' },
      { kind: 'EXPLICIT_REGISTRATION_REQUIRED', project_name: 'n' },
      { kind: 'NO_PROJECT_SIGNAL' },
      ...RUNTIME_ERROR_CODES.map((code) => ({ kind: 'ERROR', code })),
    ];

    for (const answer of answers) {
      expect(`${answer.kind}:${CURRENT_PROBLEM_OUTPUT_SCHEMA.safeParse(answer).success}`).toBe(
        `${answer.kind}:true`,
      );
    }
  });

  it('refuses an answer carrying a field nobody published', () => {
    const leaked = { kind: 'NO_PROBLEM', project_id: 'p', owner_id: 'somebody' };

    expect(CURRENT_PROBLEM_OUTPUT_SCHEMA.safeParse(leaked).success).toBe(false);
  });
});

describe('before anything about the Memory is looked at', () => {
  it('refuses a call the host did not identify', async () => {
    await expect(handle({ method: 'tools/call' })).resolves.toEqual({
      kind: 'ERROR',
      code: 'HOST_CONTEXT_UNAVAILABLE',
    });
  });

  it('refuses a call identified by something nothing was minted for', async () => {
    await mintFor('toolu_someone_elses_call');

    await expect(handle(request())).resolves.toEqual({
      kind: 'ERROR',
      code: 'HOST_CONTEXT_UNAVAILABLE',
    });
  });

  it('refuses an identifier the caller put in the arguments instead', async () => {
    await mintFor();

    // The arguments are the model's. Nothing reachable from them is read.
    await expect(
      handle({ method: 'tools/call', arguments: { tool_use_id: CALL_ID } }),
    ).resolves.toEqual({ kind: 'ERROR', code: 'HOST_CONTEXT_UNAVAILABLE' });
  });

  it('refuses a request carrying the transport session instead', async () => {
    // The MCP transport has a session of its own, and it is not the
    // conversation's. It is fixed for the life of the process, so trusting it
    // would file work under whichever session happened to start the server —
    // which is the whole reason identity arrives per call.
    await mintFor();

    await expect(
      handle({ method: 'tools/call', sessionId: CALL_ID, _meta: { progressToken: 1 } }),
    ).resolves.toEqual({ kind: 'ERROR', code: 'HOST_CONTEXT_UNAVAILABLE' });
  });

  it('gives the same answer whether or not a Memory is configured', async () => {
    // The oracle this ordering exists to close. A caller with no host context
    // learns nothing about somebody's setup — not whether a token exists, not
    // where the Memory is, not whether it answers.
    const withToken = await handle({ method: 'tools/call' }, environment());
    const without = await handle(
      { method: 'tools/call' },
      environment({ MEMORY_API_TOKEN: undefined }),
    );

    expect(withToken).toEqual(without);
    expect(withToken).toEqual({ kind: 'ERROR', code: 'HOST_CONTEXT_UNAVAILABLE' });
  });

  it('says the same thing when the identifier is real but unknown', async () => {
    // The other half of the same oracle, and the one that is easy to leave
    // uncovered: a call that got as far as looking for a record and did not
    // find one must still not reveal whether a Memory is configured.
    const withToken = await handle(request('toolu_never_minted'), environment());
    const without = await handle(
      request('toolu_never_minted'),
      environment({ MEMORY_API_TOKEN: undefined }),
    );

    expect(withToken).toEqual(without);
    expect(withToken).toEqual({ kind: 'ERROR', code: 'HOST_CONTEXT_UNAVAILABLE' });
  });

  it('refuses before reading a binding, and writes nothing', async () => {
    await handle({ method: 'tools/call' });

    // Not even a directory: nothing about this call got as far as state.
    await expect(readdir(pluginData)).resolves.toEqual([]);
  });

  it('consults nothing on disk when the host did not identify the call', async () => {
    // The refusal comes from the absence of an identifier, not from failing to
    // find a record for one. A runtime that reached the claim step with a
    // stand-in identifier would answer the same way today and would be one
    // unlucky filename away from not doing.
    await mintFor();
    const before = await readdir(join(pluginData, CALL_CONTEXT_DIRECTORY));

    await handle({ method: 'tools/call' });

    expect(await readdir(join(pluginData, CALL_CONTEXT_DIRECTORY))).toEqual(before);
  });

  it('consumes the context exactly once', async () => {
    await mintFor();

    const first = await handle(request());
    const second = await handle(request());

    // The first got past the gate and failed for its own reason; the second
    // has no context left at all.
    expect(first).not.toEqual({ kind: 'ERROR', code: 'HOST_CONTEXT_UNAVAILABLE' });
    expect(second).toEqual({ kind: 'ERROR', code: 'HOST_CONTEXT_UNAVAILABLE' });
  });

  it('refuses a context minted for another tool', async () => {
    await mintFor(CALL_ID, 'mcp__plugin_other_memory__current_problem');

    await expect(handle(request())).resolves.toEqual({
      kind: 'ERROR',
      code: 'HOST_CONTEXT_UNAVAILABLE',
    });
  });
});

describe('the paths the host supplies', () => {
  it('are read from the runtime environment, absolute or not at all', () => {
    expect(runtimePathsOf(environment())).toEqual({ projectDir, pluginData });
    expect(runtimePathsOf({})).toBeUndefined();
    expect(runtimePathsOf(environment({ [PROJECT_DIR_ENV]: 'relative/path' }))).toBeUndefined();
    expect(runtimePathsOf(environment({ [PLUGIN_DATA_ENV]: '' }))).toBeUndefined();
  });

  it('refuse the call rather than falling back to where the process happens to be', async () => {
    await mintFor();

    await expect(handle(request(), environment({ [PROJECT_DIR_ENV]: undefined }))).resolves.toEqual(
      { kind: 'ERROR', code: 'HOST_CONTEXT_UNAVAILABLE' },
    );
  });
});

describe('once the call is the host’s own', () => {
  it('says a Memory is not configured, without saying anything else', async () => {
    await mintFor();

    await expect(handle(request(), environment({ MEMORY_API_TOKEN: undefined }))).resolves.toEqual({
      kind: 'ERROR',
      code: 'MEMORY_NOT_CONFIGURED',
    });
  });
});

describe('a Memory that cannot be reached', () => {
  it('is reported as an outage and never as an answer', async () => {
    // The failure this whole runtime exists to keep honest. "Unreachable" must
    // not arrive as "no Project" or "no Problem" — a caller acts on those by
    // starting a second Problem for the trouble already open.
    await mintFor();

    const result = await handle(
      request(),
      // A port nothing listens on: refused immediately rather than slowly.
      environment({ MEMORY_API_URL: 'http://127.0.0.1:1' }),
    );

    expect(result).toEqual({ kind: 'ERROR', code: 'MEMORY_UNAVAILABLE' });
  });
});

describe('turning a failure into a category', () => {
  it.each([
    ['a missing credential', new MissingMemoryCredentialError(), 'MEMORY_NOT_CONFIGURED'],
    ['an unreachable Memory', new MemoryApiUnreachableError('TRANSPORT'), 'MEMORY_UNAVAILABLE'],
    [
      'an answer it cannot read',
      new MemoryApiProtocolError('RESOURCE_MALFORMED', 200),
      'MEMORY_PROTOCOL_ERROR',
    ],
    ['a refusal', new MemoryApiError(400, 'INVALID_REQUEST', 'req-0'), 'MEMORY_REFUSED'],
    ['a registration invariant', new ProjectRegistrationInvariantError(), 'INTERNAL_INVARIANT'],
    ['a binding argument', new ProblemBindingArgumentError('session id'), 'INTERNAL_INVARIANT'],
    ['a composition invariant', new CurrentProblemInvariantError(), 'INTERNAL_INVARIANT'],
    ['something nobody expected', new TypeError('synthetic'), 'INTERNAL_INVARIANT'],
    ['a thrown value that is not an error', 'synthetic', 'INTERNAL_INVARIANT'],
  ])('reports %s as its category', (_name, error, code) => {
    expect(classify(error)).toBe(code);
  });

  it('reads the class and never the prose', () => {
    // A name is text anything can carry. One that says it is unreachable, and
    // is not, must not be reported as an outage.
    const impostor = new Error('synthetic');
    impostor.name = 'MemoryApiUnreachableError';

    expect(classify(impostor)).toBe('INTERNAL_INVARIANT');
  });

  it('never becomes an answer about somebody’s work', () => {
    // An outage is not "no Problem", and "no Problem" is what a caller acts on
    // by starting a second one.
    for (const code of RUNTIME_ERROR_CODES) {
      expect(['NO_PROBLEM', 'NO_PROJECT_SIGNAL', 'PROBLEM_CANDIDATES'].includes(code)).toBe(false);
    }
  });
});

describe('what a failure is allowed to say', () => {
  it('carries a category and nothing else', async () => {
    await mintFor();
    const result = await handle(request(), environment({ MEMORY_API_TOKEN: undefined }));

    expect(Object.keys(result).sort()).toEqual(['code', 'kind']);
  });

  it('carries no credential, path, session or call identifier', async () => {
    await mintFor();
    const printed = JSON.stringify(
      await handle(request(), environment({ MEMORY_API_TOKEN: undefined })),
    );

    for (const secret of [FAKE_TOKEN, pluginData, projectDir, SESSION_ID, CALL_ID]) {
      expect(printed.includes(secret)).toBe(false);
    }
  });
});
