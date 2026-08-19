/**
 * The MCP runtime: one tool, and the order in which it is allowed to fail.
 *
 * ## The order is the design
 *
 * Session context is established before anything else happens — before a
 * credential is looked for, before a path is validated, before a client exists.
 * That is not tidiness. A caller that has no host context must not be able to
 * tell the difference between a configured Memory and an unconfigured one:
 * every such difference is an oracle, and this tool would otherwise answer
 * questions about somebody's setup for anyone who can reach the socket.
 *
 * So the first refusal is always the same refusal, and it costs one file
 * lookup.
 *
 * ## What a failure is allowed to say
 *
 * A category, and nothing else. No exception text, no response body, no request
 * id, no path, no session, no call identifier. A Memory that cannot be reached
 * says so; it never says what it could not reach or with what.
 *
 * ## What a failure must never become
 *
 * An answer. "Unreachable" is not "no Project", "no Problem", or an empty
 * candidate list — each of those is a claim about somebody's work that would be
 * false, and the next thing that happens after a false "no Problem" is a second
 * Problem for the trouble already open.
 */

import { realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MemoryApiError,
  MemoryApiProtocolError,
  MemoryApiUnreachableError,
  PROBLEM_STATUSES,
  type MemoryApiClient,
} from '@ai-problem-solving-memory/api-client';
import {
  createClaudeCodeMemoryClient,
  createProblemBindingStore,
  MissingMemoryCredentialError,
  ProblemBindingArgumentError,
  ProblemLifecycleArgumentError,
  ProblemLifecycleInvariantError,
  ProjectRegistrationArgumentError,
  ProjectRegistrationInvariantError,
  RESUME_PROBLEM_TARGET_STATUSES,
  type ProblemBindingStore,
  type ResumeProblemTargetStatus,
} from '@ai-problem-solving-memory/claude-code-adapter';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import {
  currentProblem,
  CurrentProblemInvariantError,
  type CurrentProblemOutcome,
} from './current-problem.js';
import { claimCallContext, hostCallIdOf, sweepCallContexts } from './host-call-context.js';
import {
  continueChosenProblem,
  resumePausedProblem,
  startFreshProblem,
} from './problem-actions.js';
import type { ProjectDecision } from './project-decision.js';
import {
  BINDINGS_DIRECTORY,
  CALL_CONTEXT_DIRECTORY,
  CONTINUE_PROBLEM_TOOL,
  CURRENT_PROBLEM_TOOL,
  hostToolName,
  PLUGIN_DATA_ENV,
  PROJECT_DIR_ENV,
  RESUME_PROBLEM_TOOL,
  START_PROBLEM_TOOL,
  type MemoryTool,
} from './runtime-constants.js';

/**
 * An answer to a Project question, in the smallest form that carries it.
 *
 * The only Project material a caller may send. There is deliberately no field
 * for a repository, a remote, a name, a platform or a path from this machine:
 * those are the detector's to observe, and a caller supplying one would be
 * describing somebody's machine from memory. A boundary is repository-relative
 * because that is the only kind this system stores.
 */
const PROJECT_DECISION_SCHEMA = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('SELECT_EXISTING'), project_id: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('REPOSITORY_ROOT') }).strict(),
  z.object({ kind: z.literal('REPOSITORY_BOUNDARY'), repo_subpath: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('REGISTER_WITHOUT_REPOSITORY') }).strict(),
]);

/** The categories a failure may be reported as. Closed, and carrying nothing. */
export const RUNTIME_ERROR_CODES = [
  'HOST_CONTEXT_UNAVAILABLE',
  'MEMORY_NOT_CONFIGURED',
  'MEMORY_UNAVAILABLE',
  'MEMORY_REFUSED',
  'MEMORY_PROTOCOL_ERROR',
  'INTERNAL_INVARIANT',
] as const;

export type RuntimeErrorCode = (typeof RUNTIME_ERROR_CODES)[number];

const CANDIDATE_SCHEMA = z
  .object({
    problem_id: z.string(),
    status: z.enum(['INVESTIGATING', 'FIX_CANDIDATE', 'PAUSED']),
    title: z.string(),
  })
  .strict();

const PROJECT_CANDIDATE_SCHEMA = z
  .object({
    project_id: z.string(),
    project_name: z.string(),
    canonical_repo: z.string().nullable(),
    repo_subpath: z.string().nullable(),
  })
  .strict();

/**
 * Every shape this tool may answer with, semantic and failure alike.
 *
 * Declared as output rather than described in prose, so a variant that grew a
 * field nobody meant to publish fails here instead of travelling.
 */
export const CURRENT_PROBLEM_OUTPUT_SCHEMA = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('CURRENT_PROBLEM'), project_id: z.string(), problem_id: z.string() })
    .strict(),
  z.object({ kind: z.literal('NO_PROBLEM'), project_id: z.string() }).strict(),
  z
    .object({
      kind: z.literal('PROBLEM_CANDIDATES'),
      project_id: z.string(),
      candidates: z.array(CANDIDATE_SCHEMA).readonly(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('PROJECT_AMBIGUOUS'),
      reason: z.enum([
        'MULTIPLE_PROJECTS_FOR_REMOTE',
        'ONLY_SECONDARY_REMOTE_MATCHED',
        'NAME_ONLY_MATCH',
        'NO_MATCHING_REPO_BOUNDARY',
      ]),
      candidates: z.array(PROJECT_CANDIDATE_SCHEMA).readonly(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('BOUNDARY_REQUIRED'),
      project_name: z.string(),
      detected_repo_subpath: z.string(),
    })
    .strict(),
  z
    .object({ kind: z.literal('EXPLICIT_REGISTRATION_REQUIRED'), project_name: z.string() })
    .strict(),
  z.object({ kind: z.literal('NO_PROJECT_SIGNAL') }).strict(),
  // An answer this operation was given that no longer describes anything true.
  // It carries nothing: what is true now is this same question, asked again
  // without the answer that expired.
  z.object({ kind: z.literal('PROJECT_DECISION_STALE') }).strict(),
  z.object({ kind: z.literal('ERROR'), code: z.enum(RUNTIME_ERROR_CODES) }).strict(),
]);

export type CurrentProblemToolResult = z.infer<typeof CURRENT_PROBLEM_OUTPUT_SCHEMA>;

/**
 * A failure, in every tool's vocabulary.
 *
 * Shared because a caller should not have to learn a different failure
 * language per operation — but each tool's *semantic* variants are its own, so
 * no schema promises an answer its operation cannot reach.
 */
const ERROR_VARIANT = z
  .object({ kind: z.literal('ERROR'), code: z.enum(RUNTIME_ERROR_CODES) })
  .strict();

/** Neither mutation may quietly act under a Project that has moved. */
const PROJECT_SELECTION_STALE_VARIANT = z
  .object({ kind: z.literal('PROJECT_SELECTION_STALE') })
  .strict();

/** Nor under a Problem whose chosen state no longer holds. */
const PROBLEM_SELECTION_STALE_VARIANT = z
  .object({ kind: z.literal('PROBLEM_SELECTION_STALE') })
  .strict();

export const CONTINUE_PROBLEM_OUTPUT_SCHEMA = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('CONTINUED'),
      project_id: z.string(),
      problem_id: z.string(),
      continuity: z.enum(['PERSISTED', 'NOT_PERSISTED']),
    })
    .strict(),
  PROJECT_SELECTION_STALE_VARIANT,
  PROBLEM_SELECTION_STALE_VARIANT,
  ERROR_VARIANT,
]);

export const RESUME_PROBLEM_OUTPUT_SCHEMA = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('RESUMED'),
      project_id: z.string(),
      problem_id: z.string(),
      status: z.enum(RESUME_PROBLEM_TARGET_STATUSES),
      continuity: z.enum(['PERSISTED', 'NOT_PERSISTED']),
    })
    .strict(),
  PROJECT_SELECTION_STALE_VARIANT,
  PROBLEM_SELECTION_STALE_VARIANT,
  ERROR_VARIANT,
]);

export const START_PROBLEM_OUTPUT_SCHEMA = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('STARTED'),
      project_id: z.string(),
      problem_id: z.string(),
      status: z.enum(PROBLEM_STATUSES),
      continuity: z.enum(['PERSISTED', 'NOT_PERSISTED']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('RECONSIDER'),
      reason: z.enum(['CANDIDATES_PRESENT', 'CANDIDATES_CHANGED']),
      candidates: z.array(CANDIDATE_SCHEMA).readonly(),
    })
    .strict(),
  // Deliberately no PROBLEM_SELECTION_STALE: starting does not act on a
  // Problem somebody chose, so there is no chosen Problem to go stale.
  PROJECT_SELECTION_STALE_VARIANT,
  ERROR_VARIANT,
]);

export type ContinueProblemToolResult = z.infer<typeof CONTINUE_PROBLEM_OUTPUT_SCHEMA>;
export type ResumeProblemToolResult = z.infer<typeof RESUME_PROBLEM_OUTPUT_SCHEMA>;
export type StartProblemToolResult = z.infer<typeof START_PROBLEM_OUTPUT_SCHEMA>;

/** Anything one of the four may answer with. */
type ToolResult =
  | CurrentProblemOutcome
  | CurrentProblemToolResult
  | ContinueProblemToolResult
  | ResumeProblemToolResult
  | StartProblemToolResult;

/**
 * Turns a failure into a category, by class and never by prose.
 *
 * A name or a message is text that anything can carry; the client publishes
 * concrete classes for exactly this, and reading them is what keeps a proxy's
 * error page from being reported as the Memory refusing something.
 */
export function classify(error: unknown): RuntimeErrorCode {
  if (error instanceof MissingMemoryCredentialError) {
    return 'MEMORY_NOT_CONFIGURED';
  }
  if (error instanceof MemoryApiUnreachableError) {
    return 'MEMORY_UNAVAILABLE';
  }
  if (error instanceof MemoryApiProtocolError) {
    return 'MEMORY_PROTOCOL_ERROR';
  }
  if (error instanceof MemoryApiError) {
    return 'MEMORY_REFUSED';
  }
  if (
    error instanceof ProjectRegistrationArgumentError ||
    error instanceof ProjectRegistrationInvariantError ||
    error instanceof ProblemBindingArgumentError ||
    error instanceof ProblemLifecycleInvariantError ||
    // Reachable only if the schema and the adapter disagreed about what a
    // resume target is, which is a contradiction rather than a caller mistake.
    error instanceof ProblemLifecycleArgumentError ||
    error instanceof CurrentProblemInvariantError
  ) {
    return 'INTERNAL_INVARIANT';
  }
  return 'INTERNAL_INVARIANT';
}

/** Where the host said this session's Project is, and where state may live. */
export interface RuntimePaths {
  readonly projectDir: string;
  readonly pluginData: string;
}

/**
 * The two paths the host supplies, or nothing.
 *
 * Absolute is required rather than resolved: a relative value would be resolved
 * against this process's working directory, which is exactly the thing a
 * Project must never be anchored on.
 */
export function runtimePathsOf(
  environment: Record<string, string | undefined>,
): RuntimePaths | undefined {
  const projectDir = environment[PROJECT_DIR_ENV];
  const pluginData = environment[PLUGIN_DATA_ENV];
  if (projectDir === undefined || pluginData === undefined) {
    return undefined;
  }
  if (!isAbsolute(projectDir) || !isAbsolute(pluginData)) {
    return undefined;
  }
  return { projectDir, pluginData };
}

export function resultOf(outcome: ToolResult): {
  content: { type: 'text'; text: string }[];
  structuredContent: ToolResult;
  isError?: boolean;
} {
  // The text says the category and repeats nothing. A client reads the
  // structured half; a person reading a transcript needs one word. Exported so
  // that this — what a transcript ends up holding — is asserted directly.
  const text = outcome.kind === 'ERROR' ? `ERROR ${outcome.code}` : outcome.kind;
  return {
    content: [{ type: 'text', text }],
    structuredContent: outcome,
    ...(outcome.kind === 'ERROR' ? { isError: true } : {}),
  };
}

/** What the handler needs from the world, so a test can supply all of it. */
export interface CurrentProblemHandlerOptions {
  readonly environment: Record<string, string | undefined>;
  readonly now: () => number;
}

/** What a tool's own work needs, once the call has been established as real. */
export interface AuthenticatedCall {
  readonly client: MemoryApiClient;
  readonly bindingStore: ProblemBindingStore;
  readonly sessionId: string;
  readonly projectDir: string;
}

/**
 * Serves one call, in the order that keeps a failure from telling anybody anything.
 *
 * Written once and shared by all four tools rather than repeated per handler:
 * the order below is the security property, and four copies of it would be
 * four chances for one to drift a step.
 *
 * The expected tool name is a parameter because a call context is minted for a
 * *particular* operation. A record for `continue_problem` must not authenticate
 * `resume_problem` even if the same identifier somehow arrived — so the name is
 * part of what the claim checks, not merely of what the hook matched.
 */
export async function serveAuthenticated<T>(
  request: unknown,
  options: CurrentProblemHandlerOptions,
  tool: MemoryTool,
  work: (call: AuthenticatedCall) => Promise<T>,
): Promise<T | { kind: 'ERROR'; code: RuntimeErrorCode }> {
  // 1. The host's identifier for this call. Read from protocol metadata, which
  //    the model's arguments cannot reach.
  const hostCallId = hostCallIdOf(request);
  if (hostCallId === undefined) {
    return { kind: 'ERROR', code: 'HOST_CONTEXT_UNAVAILABLE' };
  }

  // 2. The paths, before the context is claimed — because claiming needs the
  //    directory, and because neither step reveals anything about the Memory.
  const paths = runtimePathsOf(options.environment);
  if (paths === undefined) {
    return { kind: 'ERROR', code: 'HOST_CONTEXT_UNAVAILABLE' };
  }

  // 3. Claim the record for *this* call, and for this operation. Exactly once,
  //    or not at all.
  const claim = await claimCallContext({
    directory: join(paths.pluginData, CALL_CONTEXT_DIRECTORY),
    hostCallId,
    toolName: hostToolName(tool),
    now: options.now(),
  });
  if (claim.kind !== 'CLAIMED') {
    // Still before any word about whether a Memory is configured.
    return { kind: 'ERROR', code: 'HOST_CONTEXT_UNAVAILABLE' };
  }

  try {
    // 4. Only now does anything about the Memory get looked at.
    const client = createClaudeCodeMemoryClient(options.environment);
    const bindingStore = createProblemBindingStore({
      directory: join(paths.pluginData, BINDINGS_DIRECTORY),
    });

    return await work({
      client,
      bindingStore,
      sessionId: claim.sessionId,
      projectDir: paths.projectDir,
    });
  } catch (error) {
    return { kind: 'ERROR', code: classify(error) };
  }
}

/** Which Problem this session is on, or what has to be settled first. */
export async function handleCurrentProblem(
  request: unknown,
  options: CurrentProblemHandlerOptions,
  decision?: ProjectDecision,
): Promise<CurrentProblemOutcome | { kind: 'ERROR'; code: RuntimeErrorCode }> {
  // `serveAuthenticated` may answer with a failure of its own, and this
  // operation's union already describes one, so the two meet exactly.
  const outcome = await serveAuthenticated(request, options, CURRENT_PROBLEM_TOOL, async (call) =>
    currentProblem({
      client: call.client,
      bindingStore: call.bindingStore,
      sessionId: call.sessionId,
      projectDir: call.projectDir,
      ...(decision === undefined ? {} : { projectDecision: decision }),
    }),
  );

  return outcome;
}

/** Carries on with a Problem somebody chose. */
export async function handleContinueProblem(
  request: unknown,
  options: CurrentProblemHandlerOptions,
  args: { readonly project_id: string; readonly problem_id: string },
): Promise<ContinueProblemToolResult> {
  const outcome = await serveAuthenticated(request, options, CONTINUE_PROBLEM_TOOL, async (call) =>
    continueChosenProblem({
      client: call.client,
      bindingStore: call.bindingStore,
      sessionId: call.sessionId,
      projectDir: call.projectDir,
      projectId: args.project_id,
      problemId: args.problem_id,
    }),
  );

  return outcome.kind === 'CONTINUED'
    ? {
        kind: 'CONTINUED',
        project_id: outcome.projectId,
        problem_id: outcome.problemId,
        continuity: outcome.continuity,
      }
    : outcome;
}

/** Brings a paused Problem back into work. */
export async function handleResumeProblem(
  request: unknown,
  options: CurrentProblemHandlerOptions,
  args: {
    readonly project_id: string;
    readonly problem_id: string;
    readonly target_status: ResumeProblemTargetStatus;
  },
): Promise<ResumeProblemToolResult> {
  const outcome = await serveAuthenticated(request, options, RESUME_PROBLEM_TOOL, async (call) =>
    resumePausedProblem({
      client: call.client,
      bindingStore: call.bindingStore,
      sessionId: call.sessionId,
      projectDir: call.projectDir,
      projectId: args.project_id,
      problemId: args.problem_id,
      targetStatus: args.target_status,
    }),
  );

  return outcome.kind === 'RESUMED'
    ? {
        kind: 'RESUMED',
        project_id: outcome.projectId,
        problem_id: outcome.problemId,
        status: outcome.status,
        continuity: outcome.continuity,
      }
    : outcome;
}

/** Starts a new Problem, once it is clear the decision to start one stands. */
export async function handleStartProblem(
  request: unknown,
  options: CurrentProblemHandlerOptions,
  args: {
    readonly project_id: string;
    readonly title: string;
    readonly symptoms: string;
    readonly problem_domain?: string | null | undefined;
    readonly suspected_boundary?: string | null | undefined;
    readonly expected_candidate_problem_ids?: readonly string[] | undefined;
  },
): Promise<StartProblemToolResult> {
  const outcome = await serveAuthenticated(request, options, START_PROBLEM_TOOL, async (call) =>
    startFreshProblem({
      client: call.client,
      bindingStore: call.bindingStore,
      sessionId: call.sessionId,
      projectDir: call.projectDir,
      projectId: args.project_id,
      title: args.title,
      symptoms: args.symptoms,
      // Absent and null are different claims all the way down: one leaves the
      // column alone, the other says there is no answer.
      ...('problem_domain' in args ? { problemDomain: args.problem_domain } : {}),
      ...('suspected_boundary' in args ? { suspectedBoundary: args.suspected_boundary } : {}),
      ...(args.expected_candidate_problem_ids === undefined
        ? {}
        : { expectedCandidateProblemIds: args.expected_candidate_problem_ids }),
    }),
  );

  switch (outcome.kind) {
    case 'STARTED':
      return {
        kind: 'STARTED',
        project_id: outcome.projectId,
        problem_id: outcome.problemId,
        status: outcome.status,
        continuity: outcome.continuity,
      };
    case 'RECONSIDER':
      return {
        kind: 'RECONSIDER',
        reason: outcome.reason,
        candidates: outcome.candidates.map((candidate) => ({
          problem_id: candidate.problemId,
          status: candidate.status,
          title: candidate.title,
        })),
      };
    default:
      return outcome;
  }
}

/** Builds the server. Exported so a test can drive it without a transport. */
export function buildMemoryMcpServer(options: CurrentProblemHandlerOptions): McpServer {
  const server = new McpServer({ name: 'memory', version: '0.0.0' });

  server.registerTool(
    CURRENT_PROBLEM_TOOL,
    {
      description:
        'Which problem this session is working on in this project, or what it could be. ' +
        'Takes no arguments: the session and the project root come from the host. ' +
        'Never picks between candidates — that judgement is the reader’s.',
      // One optional field, and it exists because this operation asks the
      // questions it answers. Everything else a Project needs is observed
      // here rather than described by a caller.
      inputSchema: z.object({ project_decision: PROJECT_DECISION_SCHEMA.optional() }).strict(),
      outputSchema: CURRENT_PROBLEM_OUTPUT_SCHEMA,
      // Deliberately no `readOnlyHint`. The deterministic path registers a
      // Project for an unrecorded repository root, which is a durable write,
      // and telling a client otherwise would be a lie it might act on.
    },
    async (args, extra) =>
      resultOf(await handleCurrentProblem(extra?.mcpReq, options, args.project_decision)),
  );

  server.registerTool(
    CONTINUE_PROBLEM_TOOL,
    {
      description:
        'Carry on with a problem this project already has open. ' +
        'Give the project and problem ids a previous current_problem answer showed. ' +
        'Refuses rather than switching if either has moved since.',
      inputSchema: z
        .object({ project_id: z.string().min(1), problem_id: z.string().min(1) })
        .strict(),
      outputSchema: CONTINUE_PROBLEM_OUTPUT_SCHEMA,
    },
    async (args, extra) => resultOf(await handleContinueProblem(extra?.mcpReq, options, args)),
  );

  server.registerTool(
    RESUME_PROBLEM_TOOL,
    {
      description:
        'Bring a paused problem back into work. ' +
        'Give the project and problem ids a previous current_problem answer showed, ' +
        'and which working state it resumes into.',
      inputSchema: z
        .object({
          project_id: z.string().min(1),
          problem_id: z.string().min(1),
          // Taken from the adapter's own list rather than restated, so the two
          // cannot come to disagree about what resuming means.
          target_status: z.enum(RESUME_PROBLEM_TARGET_STATUSES),
        })
        .strict(),
      outputSchema: RESUME_PROBLEM_OUTPUT_SCHEMA,
    },
    async (args, extra) => resultOf(await handleResumeProblem(extra?.mcpReq, options, args)),
  );

  server.registerTool(
    START_PROBLEM_TOOL,
    {
      description:
        'Start a new problem in this project, for trouble that is not one already open. ' +
        'If current_problem offered candidates, pass the ids you considered as ' +
        'expected_candidate_problem_ids; if the open problems have changed since you ' +
        'looked, this asks you to reconsider rather than starting a second one.',
      inputSchema: z
        .object({
          project_id: z.string().min(1),
          title: z.string().min(1),
          symptoms: z.string().min(1),
          problem_domain: z.string().nullable().optional(),
          suspected_boundary: z.string().nullable().optional(),
          expected_candidate_problem_ids: z.array(z.string().min(1)).optional(),
        })
        .strict(),
      outputSchema: START_PROBLEM_OUTPUT_SCHEMA,
    },
    async (args, extra) => resultOf(await handleStartProblem(extra?.mcpReq, options, args)),
  );

  return server;
}

async function main(): Promise<void> {
  const paths = runtimePathsOf(process.env);
  if (paths !== undefined) {
    // One bounded tidy-up of records nobody will claim. Its failure is not a
    // reason to refuse to start.
    await sweepCallContexts({
      directory: join(paths.pluginData, CALL_CONTEXT_DIRECTORY),
      now: Date.now(),
    }).catch(() => undefined);
  }

  serveStdio(() => buildMemoryMcpServer({ environment: process.env, now: () => Date.now() }));
}

/**
 * Whether Node was asked to run this file, rather than to import it.
 *
 * The tests import this module to drive the server without a transport, and
 * serving stdio on import would take the test process's own streams.
 */
function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  await main();
}
