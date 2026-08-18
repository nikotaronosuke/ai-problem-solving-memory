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
} from '@ai-problem-solving-memory/api-client';
import {
  createClaudeCodeMemoryClient,
  createProblemBindingStore,
  MissingMemoryCredentialError,
  ProblemBindingArgumentError,
  ProblemLifecycleInvariantError,
  ProjectRegistrationArgumentError,
  ProjectRegistrationInvariantError,
} from '@ai-problem-solving-memory/claude-code-adapter';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import { currentProblem, CurrentProblemInvariantError } from './current-problem.js';
import { claimCallContext, hostCallIdOf, sweepCallContexts } from './host-call-context.js';
import {
  BINDINGS_DIRECTORY,
  CALL_CONTEXT_DIRECTORY,
  CURRENT_PROBLEM_TOOL,
  HOST_TOOL_NAME,
  PLUGIN_DATA_ENV,
  PROJECT_DIR_ENV,
} from './runtime-constants.js';

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
  z.object({ kind: z.literal('ERROR'), code: z.enum(RUNTIME_ERROR_CODES) }).strict(),
]);

export type CurrentProblemToolResult = z.infer<typeof CURRENT_PROBLEM_OUTPUT_SCHEMA>;

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

function resultOf(outcome: CurrentProblemToolResult): {
  content: { type: 'text'; text: string }[];
  structuredContent: CurrentProblemToolResult;
  isError?: boolean;
} {
  // The text says the category and repeats nothing. A client reads the
  // structured half; a person reading a transcript needs one word.
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

/**
 * Serves one call, in the order that keeps a failure from telling anybody anything.
 */
export async function handleCurrentProblem(
  request: unknown,
  options: CurrentProblemHandlerOptions,
): Promise<CurrentProblemToolResult> {
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

  // 3. Claim the record for *this* call. Exactly once, or not at all.
  const claim = await claimCallContext({
    directory: join(paths.pluginData, CALL_CONTEXT_DIRECTORY),
    hostCallId,
    toolName: HOST_TOOL_NAME,
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

    return await currentProblem({
      client,
      bindingStore,
      sessionId: claim.sessionId,
      projectDir: paths.projectDir,
    });
  } catch (error) {
    return { kind: 'ERROR', code: classify(error) };
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
      // Empty and closed. Every field a later operation needs arrives with that
      // operation; a field added now would be a guess about a call nobody makes.
      inputSchema: z.object({}).strict(),
      outputSchema: CURRENT_PROBLEM_OUTPUT_SCHEMA,
      // Deliberately no `readOnlyHint`. The deterministic path registers a
      // Project for an unrecorded repository root, which is a durable write,
      // and telling a client otherwise would be a lie it might act on.
    },
    async (_args, extra) => resultOf(await handleCurrentProblem(extra?.mcpReq, options)),
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
