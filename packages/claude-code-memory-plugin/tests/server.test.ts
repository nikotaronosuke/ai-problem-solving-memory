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
  MARK_FIX_CANDIDATE_TOOL,
  MEMORY_TOOLS,
  PLUGIN_DATA_ENV,
  type MemoryTool,
} from '../src/runtime-constants.js';
import {
  ADD_EVENT_OUTPUT_SCHEMA,
  ADD_VERIFICATION_OUTPUT_SCHEMA,
  buildMemoryMcpServer,
  classify,
  CLOSE_PROBLEM_OUTPUT_SCHEMA,
  CONTINUE_PROBLEM_OUTPUT_SCHEMA,
  CURRENT_PROBLEM_OUTPUT_SCHEMA,
  handleContinueProblem,
  handleCurrentProblem,
  handleAddEvent,
  handleAddVerification,
  handleCloseProblem,
  handleMarkFixCandidate,
  handleRecallSimilarExperience,
  handleResumeProblem,
  handleStartProblem,
  RESUME_PROBLEM_OUTPUT_SCHEMA,
  MARK_FIX_CANDIDATE_OUTPUT_SCHEMA,
  resultOf,
  runtimeStatePathsOf,
  serveAuthenticated,
  RUNTIME_ERROR_CODES,
  START_PROBLEM_OUTPUT_SCHEMA,
} from '../src/server.js';

const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const CALL_ID = 'toolu_01AAAAAAAAAAAAAAAAAAAAAA';
const OTHER_CALL_ID = 'toolu_01BBBBBBBBBBBBBBBBBBBBBB';
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
  // No project directory. The server's environment carries state, not
  // location: where the session is arrives with each call.
  return {
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
  currentDirectory: string = projectDir,
): Promise<void> {
  const directory = join(pluginData, CALL_CONTEXT_DIRECTORY);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, callContextFilename(hostCallId)),
    JSON.stringify({
      format_version: 2,
      session_id: SESSION_ID,
      tool_name: toolName,
      current_directory: currentDirectory,
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

describe('the one path the server’s environment supplies', () => {
  it('is this plugin’s own state, absolute or not at all', () => {
    expect(runtimeStatePathsOf(environment())).toEqual({ pluginData });
    expect(runtimeStatePathsOf({})).toBeUndefined();
    expect(runtimeStatePathsOf(environment({ [PLUGIN_DATA_ENV]: '' }))).toBeUndefined();
    expect(
      runtimeStatePathsOf(environment({ [PLUGIN_DATA_ENV]: 'relative/path' })),
    ).toBeUndefined();
  });

  it('refuses the call rather than falling back to where the process happens to be', async () => {
    await mintFor();

    await expect(handle(request(), environment({ [PLUGIN_DATA_ENV]: undefined }))).resolves.toEqual(
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
        format_version: 2,
        session_id: SESSION_ID,
        tool_name: hostToolName(tool),
        current_directory: projectDir,
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
    recall_similar_experience: (req: unknown) =>
      handleRecallSimilarExperience(
        req,
        { environment: environment(), now: () => NOW },
        {
          lexical_text: 'export empty file',
          semantic_text: 'the scheduled export writes an empty file while reporting success',
          current_features: {
            problem_domain: null,
            symptom_patterns: [],
            suspected_boundaries: [],
            occurrence_conditions: [],
            successful_directions: [],
            dead_end_directions: [],
            environment_facts: [],
          },
        },
      ),
    add_event: (req: unknown) =>
      handleAddEvent(
        req,
        { environment: environment(), now: () => NOW },
        {
          event_type: 'DEAD_END',
          summary: 'the attempted direction did not work',
          client_event_id: 'aaaaaaaa-1111-4222-8333-444444444444',
        },
      ),
    add_verification: (req: unknown) =>
      handleAddVerification(
        req,
        { environment: environment(), now: () => NOW },
        {
          verification_type: 'TEST',
          result: false,
          summary: 'the regression still fails',
          client_event_id: 'bbbbbbbb-1111-4222-8333-444444444444',
        },
      ),
    [MARK_FIX_CANDIDATE_TOOL]: (req: unknown) =>
      handleMarkFixCandidate(req, { environment: environment(), now: () => NOW }),
    close_problem: (req: unknown) =>
      handleCloseProblem(
        req,
        { environment: environment(), now: () => NOW },
        { target_status: 'PAUSED' },
      ),
  } as const;

  it.each([
    ['continue_problem', 'resume_problem'],
    ['resume_problem', 'continue_problem'],
    ['current_problem', 'start_problem'],
    ['start_problem', 'current_problem'],
    // The fifth is not a special case: a context minted to look something up
    // must not authenticate an operation that changes a Problem, and one
    // minted to change a Problem must not authenticate a lookup.
    ['recall_similar_experience', 'start_problem'],
    ['start_problem', 'recall_similar_experience'],
    ['current_problem', 'recall_similar_experience'],
    ['recall_similar_experience', 'current_problem'],
    ['add_event', 'add_verification'],
    ['add_verification', 'mark_fix_candidate'],
    ['mark_fix_candidate', 'close_problem'],
    ['add_verification', 'close_problem'],
    ['close_problem', 'add_event'],
    ['recall_similar_experience', 'add_event'],
    ['add_event', 'recall_similar_experience'],
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
    expect(kindsOf(ADD_EVENT_OUTPUT_SCHEMA)).toEqual([
      'CURRENT_PROBLEM_NOT_AVAILABLE',
      'ERROR',
      'EVENT_RECORDED',
      'NO_CURRENT_PROBLEM',
    ]);
    // CAPABILITY_UNAVAILABLE is add_verification's alone (P9-03): only the
    // evidence-recording operation degrades at an entry point whose callers
    // cannot have performed the check; no other mutation may borrow it.
    expect(kindsOf(ADD_VERIFICATION_OUTPUT_SCHEMA)).toEqual([
      'CAPABILITY_UNAVAILABLE',
      'CURRENT_PROBLEM_NOT_AVAILABLE',
      'ERROR',
      'NO_CURRENT_PROBLEM',
      'VERIFICATION_RECORDED',
    ]);
    expect(kindsOf(MARK_FIX_CANDIDATE_OUTPUT_SCHEMA)).toEqual([
      'CURRENT_PROBLEM_NOT_AVAILABLE',
      'ERROR',
      'FIX_CANDIDATE_MARKED',
      'NO_CURRENT_PROBLEM',
    ]);
    expect(kindsOf(CLOSE_PROBLEM_OUTPUT_SCHEMA)).toEqual([
      'CURRENT_PROBLEM_NOT_AVAILABLE',
      'ERROR',
      'NO_CURRENT_PROBLEM',
      'PROBLEM_CLOSED',
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
    [
      'an Event record',
      ADD_EVENT_OUTPUT_SCHEMA,
      {
        kind: 'EVENT_RECORDED',
        problem_id: 'p',
        event_id: 'e',
        client_event_id: 'c',
        on_current_problem: false,
      },
    ],
    [
      'a Verification record',
      ADD_VERIFICATION_OUTPUT_SCHEMA,
      {
        kind: 'VERIFICATION_RECORDED',
        problem_id: 'p',
        verification_id: 'v',
        client_event_id: 'c',
        on_current_problem: true,
      },
    ],
    [
      'a fix-candidate transition',
      MARK_FIX_CANDIDATE_OUTPUT_SCHEMA,
      {
        kind: 'FIX_CANDIDATE_MARKED',
        problem_id: 'p',
        status: 'FIX_CANDIDATE',
        version: 2,
      },
    ],
    [
      'a close',
      CLOSE_PROBLEM_OUTPUT_SCHEMA,
      { kind: 'PROBLEM_CLOSED', problem_id: 'p', status: 'PAUSED', version: 2 },
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

describe('what a tool result carries on both halves (D-487)', () => {
  it('serializes the whole semantic answer into the text block', () => {
    // The structured half is canonical; the text half is the same object,
    // serialized, so a host that shows its model only text blocks still
    // hands over every field. Measured need: claude.ai renders exactly the
    // text blocks, and the kind-only text cost it the candidate ids.
    const answer = {
      kind: 'CURRENT_PROBLEM',
      project_id: 'p',
      problem_id: 'q',
    } as const;

    const result = resultOf(answer);

    expect(result.structuredContent).toBe(answer);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe('text');
    expect(JSON.parse(result.content[0]!.text)).toEqual(answer);
    expect('isError' in result).toBe(false);
  });

  it('keeps a failure marked and still text-recoverable', () => {
    const result = resultOf({ kind: 'ERROR', code: 'MEMORY_UNAVAILABLE' });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      kind: 'ERROR',
      code: 'MEMORY_UNAVAILABLE',
    });
  });

  it.each([...RUNTIME_ERROR_CODES])('round-trips ERROR %s through the text half', (code) => {
    const rendered = resultOf({ kind: 'ERROR', code }).content;

    expect(rendered).toHaveLength(1);
    expect(JSON.parse(rendered[0]!.text)).toEqual({ kind: 'ERROR', code });
  });

  it('hands a text-only client the full candidate list', () => {
    // The inversion of the old pin, deliberately: candidates must now be in
    // the text, because the one client that could not see the structured
    // half is exactly the one that needed these ids to continue.
    const answer = {
      kind: 'PROBLEM_CANDIDATES',
      project_id: 'p',
      candidates: [{ problem_id: 'q', status: 'PAUSED', title: PLANTED_TITLE }],
    } as const;

    const parsed = JSON.parse(resultOf(answer).content[0]!.text) as typeof answer;

    expect(parsed).toEqual(answer);
    expect(parsed.candidates[0]?.problem_id).toBe('q');
    expect(parsed.candidates[0]?.status).toBe('PAUSED');
    expect(parsed.candidates[0]?.title).toBe(PLANTED_TITLE);
  });

  it.each([
    ['a write refusal', { kind: 'NO_CURRENT_PROBLEM' }],
    ['a degraded verification', { kind: 'CAPABILITY_UNAVAILABLE' }],
    ['a memory refusal', { kind: 'ERROR', code: 'MEMORY_REFUSED' }],
    [
      'a recall outcome',
      {
        kind: 'RECALLED',
        candidate_count: 2,
        semantic_status: 'PROVIDER_UNAVAILABLE',
        structural_status: 'NOT_NEEDED',
      },
    ],
    [
      'an event record',
      {
        kind: 'EVENT_RECORDED',
        problem_id: 'p',
        event_id: 'e',
        client_event_id: 'c',
        on_current_problem: true,
      },
    ],
  ] as const)('lets a text-only client recover %s in full', (_label, outcome) => {
    expect(JSON.parse(resultOf(outcome as never).content[0]!.text)).toEqual(outcome);
  });
});

describe('where the call is answered from', () => {
  /** A second place, so "the call's location" can be told from "the server's". */
  let elsewhere: string;

  beforeEach(async () => {
    elsewhere = await mkdtemp(join(tmpdir(), 'moved-to-'));
  });

  afterEach(async () => {
    await rm(elsewhere, { recursive: true, force: true });
  });

  it('uses the directory the claim carried, not one the environment names', async () => {
    // The defect this closes: a session that moves while the server keeps
    // running was answered about the directory the server started in. Here the
    // environment still names the old place, loudly, and it must lose.
    await mintFor(CALL_ID, hostToolName(CURRENT_PROBLEM_TOOL), elsewhere);

    const seen: string[] = [];
    await serveAuthenticated(
      request(),
      { environment: environment({ MEMORY_CLAUDE_PROJECT_DIR: projectDir }), now: () => NOW },
      CURRENT_PROBLEM_TOOL,
      (call) => {
        seen.push(call.projectDir);
        return Promise.resolve({ kind: 'NO_PROBLEM', project_id: 'p' } as const);
      },
    );

    expect(seen).toEqual([elsewhere]);
    expect(seen.includes(projectDir)).toBe(false);
  });

  it('answers two calls of one session from the two places they were made', async () => {
    // A session that moved mid-run. Each call carries its own location, so the
    // second is not answered about where the first happened to be.
    await mintFor(CALL_ID, hostToolName(CURRENT_PROBLEM_TOOL), projectDir);
    await mintFor(OTHER_CALL_ID, hostToolName(CURRENT_PROBLEM_TOOL), elsewhere);

    const seen: string[] = [];
    const observe = (call: { projectDir: string }) => {
      seen.push(call.projectDir);
      return Promise.resolve({ kind: 'NO_PROBLEM', project_id: 'p' } as const);
    };
    const options = { environment: environment(), now: () => NOW };

    await serveAuthenticated(request(CALL_ID), options, CURRENT_PROBLEM_TOOL, observe);
    await serveAuthenticated(request(OTHER_CALL_ID), options, CURRENT_PROBLEM_TOOL, observe);

    expect(seen).toEqual([projectDir, elsewhere]);
  });

  it('gives every one of the tools the same one location', async () => {
    // One value feeds Project detection and Environment capture alike, so no
    // pair of them can describe different places.
    for (const [index, tool] of MEMORY_TOOLS.entries()) {
      // A distinct call each time: a claim is spent once, and its marker stays
      // behind precisely so the same identifier cannot be used again.
      const callId = `toolu_01FOUR${String(index)}AAAAAAAAAAAAAAAA`;
      await mintFor(callId, hostToolName(tool), elsewhere);
      const seen: string[] = [];

      await serveAuthenticated(
        request(callId),
        { environment: environment(), now: () => NOW },
        tool,
        (call) => {
          seen.push(call.projectDir);
          return Promise.resolve({ kind: 'NO_PROBLEM', project_id: 'p' } as const);
        },
      );

      expect(`${tool} answered from:${seen.join(',')}`).toBe(`${tool} answered from:${elsewhere}`);
    }
  });

  it('refuses a call whose record carries no usable location', async () => {
    // Written the way a previous version would have, with no location in it.
    const directory = join(pluginData, CALL_CONTEXT_DIRECTORY);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, callContextFilename(CALL_ID)),
      JSON.stringify({
        format_version: 1,
        session_id: SESSION_ID,
        tool_name: hostToolName(CURRENT_PROBLEM_TOOL),
        minted_at: NOW,
      }),
      'utf8',
    );

    // Refused before a credential is looked at, so nothing is revealed about
    // whether a Memory is configured either.
    await expect(handle(request(), environment())).resolves.toEqual({
      kind: 'ERROR',
      code: 'HOST_CONTEXT_UNAVAILABLE',
    });
    await expect(handle(request(), environment({ MEMORY_API_TOKEN: undefined }))).resolves.toEqual({
      kind: 'ERROR',
      code: 'HOST_CONTEXT_UNAVAILABLE',
    });
  });

  it('never says where it was, whatever goes wrong', async () => {
    await mintFor(CALL_ID, hostToolName(CURRENT_PROBLEM_TOOL), elsewhere);

    const result = await handle(request(), environment({ MEMORY_API_TOKEN: undefined }));
    const printed = JSON.stringify(resultOf(result));

    expect(printed.includes(elsewhere)).toBe(false);
    expect(printed.includes(pluginData)).toBe(false);
  });
});
