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
  hostToolName,
  MEMORY_TOOLS,
  PLUGIN_DATA_ENV,
  PROJECT_DIR_ENV,
  type MemoryTool,
} from '../src/runtime-constants.js';
import {
  buildMemoryMcpServer,
  classify,
  CONTINUE_PROBLEM_OUTPUT_SCHEMA,
  CURRENT_PROBLEM_OUTPUT_SCHEMA,
  handleContinueProblem,
  handleCurrentProblem,
  handleResumeProblem,
  handleStartProblem,
  RESUME_PROBLEM_OUTPUT_SCHEMA,
  resultOf,
  runtimePathsOf,
  RUNTIME_ERROR_CODES,
  START_PROBLEM_OUTPUT_SCHEMA,
} from '../src/server.js';

const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const CALL_ID = 'toolu_01AAAAAAAAAAAAAAAAAAAAAA';
const NOW = 1_800_000_000_000;

/** Synthetic. Shaped like a credential and not one. */
const FAKE_TOKEN = 'memory_test_0000000000000000000000000000';

/** Synthetic. Stands in for anything a result must not restate in prose. */
const PLANTED_TITLE = 'a-title-nobody-should-see-in-a-transcript-line';

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
async function mintFor(
  hostCallId: string = CALL_ID,
  toolName = hostToolName(CURRENT_PROBLEM_TOOL),
): Promise<void> {
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
      'PROJECT_DECISION_STALE',
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

describe('a call context belongs to one operation', () => {
  /** Records a context the way the hook would, for a named tool. */
  async function mintForTool(tool: MemoryTool, hostCallId: string = CALL_ID): Promise<void> {
    const directory = join(pluginData, CALL_CONTEXT_DIRECTORY);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, callContextFilename(hostCallId)),
      JSON.stringify({
        format_version: 1,
        session_id: SESSION_ID,
        tool_name: hostToolName(tool),
        minted_at: NOW,
      }),
      'utf8',
    );
  }

  const handlers = {
    current_problem: (req: unknown) =>
      handleCurrentProblem(req, { environment: environment(), now: () => NOW }),
    continue_problem: (req: unknown) =>
      handleContinueProblem(
        req,
        { environment: environment(), now: () => NOW },
        {
          project_id: 'p',
          problem_id: 'q',
        },
      ),
    resume_problem: (req: unknown) =>
      handleResumeProblem(
        req,
        { environment: environment(), now: () => NOW },
        {
          project_id: 'p',
          problem_id: 'q',
          target_status: 'INVESTIGATING',
        },
      ),
    start_problem: (req: unknown) =>
      handleStartProblem(
        req,
        { environment: environment(), now: () => NOW },
        {
          project_id: 'p',
          title: 't',
          symptoms: 's',
        },
      ),
  } as const;

  it.each([
    ['continue_problem', 'resume_problem'],
    ['resume_problem', 'continue_problem'],
    ['current_problem', 'start_problem'],
    ['start_problem', 'current_problem'],
  ] as const)('refuses a %s context presented to %s', async (minted, presented) => {
    // The call identifier alone is not enough. A record says which operation it
    // was minted for, so a context for one tool cannot hand another tool a
    // session — which would let an answer about reading become permission to
    // write.
    await mintForTool(minted);

    await expect(handlers[presented](request())).resolves.toEqual({
      kind: 'ERROR',
      code: 'HOST_CONTEXT_UNAVAILABLE',
    });
  });

  it.each(MEMORY_TOOLS)('accepts its own context, for %s', async (tool) => {
    await mintForTool(tool);

    const result = await handlers[tool](request());

    // Past the gate, and stopped by the next thing instead: no credential.
    expect(result).not.toEqual({ kind: 'ERROR', code: 'HOST_CONTEXT_UNAVAILABLE' });
  });

  it.each(MEMORY_TOOLS)('refuses %s with no host context at all', async (tool) => {
    await expect(handlers[tool]({ method: 'tools/call' })).resolves.toEqual({
      kind: 'ERROR',
      code: 'HOST_CONTEXT_UNAVAILABLE',
    });
  });

  it.each(MEMORY_TOOLS)('tells nobody whether a Memory is configured, for %s', async (tool) => {
    const withToken = await handlers[tool]({ method: 'tools/call' });
    const without = await handleCurrentProblem(
      { method: 'tools/call' },
      { environment: environment({ MEMORY_API_TOKEN: undefined }), now: () => NOW },
    );

    expect(withToken).toEqual(without);
  });
});

describe('what each operation may conclude', () => {
  const kindsOf = (schema: { options: readonly { shape: { kind: { value: string } } }[] }) =>
    schema.options.map((option) => option.shape.kind.value).sort();

  it('lets the asking operation report a stale answer', () => {
    expect(kindsOf(CURRENT_PROBLEM_OUTPUT_SCHEMA)).toEqual([
      'BOUNDARY_REQUIRED',
      'CURRENT_PROBLEM',
      'ERROR',
      'EXPLICIT_REGISTRATION_REQUIRED',
      'NO_PROBLEM',
      'NO_PROJECT_SIGNAL',
      'PROBLEM_CANDIDATES',
      'PROJECT_AMBIGUOUS',
      'PROJECT_DECISION_STALE',
    ]);
  });

  it('keeps each mutation narrow', () => {
    // Not one union shared by everything. A schema that let `continue` answer
    // `RECONSIDER`, or `start` answer `PROBLEM_SELECTION_STALE`, would describe
    // conclusions those operations cannot reach — and a client would have to
    // handle answers that never come.
    expect(kindsOf(CONTINUE_PROBLEM_OUTPUT_SCHEMA)).toEqual([
      'CONTINUED',
      'ERROR',
      'PROBLEM_SELECTION_STALE',
      'PROJECT_SELECTION_STALE',
    ]);
    expect(kindsOf(RESUME_PROBLEM_OUTPUT_SCHEMA)).toEqual([
      'ERROR',
      'PROBLEM_SELECTION_STALE',
      'PROJECT_SELECTION_STALE',
      'RESUMED',
    ]);
    // Starting acts on no Problem somebody chose, so there is no chosen
    // Problem to go stale.
    expect(kindsOf(START_PROBLEM_OUTPUT_SCHEMA)).toEqual([
      'ERROR',
      'PROJECT_SELECTION_STALE',
      'RECONSIDER',
      'STARTED',
    ]);
  });

  it.each([
    [
      'a continuation',
      CONTINUE_PROBLEM_OUTPUT_SCHEMA,
      { kind: 'CONTINUED', project_id: 'p', problem_id: 'q', continuity: 'PERSISTED' },
    ],
    [
      'a resume',
      RESUME_PROBLEM_OUTPUT_SCHEMA,
      {
        kind: 'RESUMED',
        project_id: 'p',
        problem_id: 'q',
        status: 'INVESTIGATING',
        continuity: 'NOT_PERSISTED',
      },
    ],
    [
      'a start',
      START_PROBLEM_OUTPUT_SCHEMA,
      {
        kind: 'STARTED',
        project_id: 'p',
        problem_id: 'q',
        status: 'INVESTIGATING',
        continuity: 'PERSISTED',
      },
    ],
    [
      'a reconsideration',
      START_PROBLEM_OUTPUT_SCHEMA,
      {
        kind: 'RECONSIDER',
        reason: 'CANDIDATES_PRESENT',
        candidates: [{ problem_id: 'q', status: 'PAUSED', title: 't' }],
      },
    ],
  ])('validates %s', (_label, schema, answer) => {
    expect(schema.safeParse(answer).success).toBe(true);
  });

  it('refuses an answer carrying a field nobody published', () => {
    expect(
      CONTINUE_PROBLEM_OUTPUT_SCHEMA.safeParse({
        kind: 'CONTINUED',
        project_id: 'p',
        problem_id: 'q',
        continuity: 'PERSISTED',
        owner_id: 'somebody',
      }).success,
    ).toBe(false);
  });
});

describe('what a transcript is left holding', () => {
  it('says the category and repeats nothing back', () => {
    // The text half is read by a person, and by whatever logs a session. It is
    // the one place an answer could be restated in full, so it says one word
    // and the structured half carries the rest.
    const answer = {
      kind: 'CURRENT_PROBLEM',
      project_id: 'p',
      problem_id: 'q',
    } as const;

    const result = resultOf(answer);

    expect(result.content).toEqual([{ type: 'text', text: 'CURRENT_PROBLEM' }]);
    expect(result.structuredContent).toBe(answer);
    expect('isError' in result).toBe(false);
  });

  it('says the code and nothing about what went wrong', () => {
    // A failure is where a message would come from — an exception's text, a
    // response body, a path. The text is the category and the code, both of
    // which are already a closed list.
    const result = resultOf({ kind: 'ERROR', code: 'MEMORY_UNAVAILABLE' });

    expect(result.content).toEqual([{ type: 'text', text: 'ERROR MEMORY_UNAVAILABLE' }]);
    expect(result.isError).toBe(true);
  });

  it.each([...RUNTIME_ERROR_CODES])('renders %s as two words', (code) => {
    const rendered = resultOf({ kind: 'ERROR', code }).content;

    expect(rendered).toHaveLength(1);
    expect(rendered[0]?.text.split(' ')).toEqual(['ERROR', code]);
  });

  it('never renders a candidate list into the text', () => {
    const result = resultOf({
      kind: 'PROBLEM_CANDIDATES',
      project_id: 'p',
      candidates: [{ problem_id: 'q', status: 'PAUSED', title: PLANTED_TITLE }],
    });

    expect(result.content).toEqual([{ type: 'text', text: 'PROBLEM_CANDIDATES' }]);
  });
});
