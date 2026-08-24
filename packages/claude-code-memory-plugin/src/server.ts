/**
 * The MCP runtime: nine tools, and the order in which they are allowed to fail.
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
  CLOSE_PROBLEM_TARGET_STATUSES,
  EVENT_TYPES,
  FIX_KINDS,
  PROBLEM_STATUSES,
  VERIFICATION_TYPES,
  type MemoryApiClient,
} from '@ai-problem-solving-memory/api-client';
import {
  MEMORY_SEARCH_MAX_LEXICAL_TEXT_LENGTH,
  MEMORY_SEARCH_MAX_SEMANTIC_TEXT_LENGTH,
  MEMORY_SEARCH_MAX_STRUCTURAL_FEATURE_ITEMS,
  MEMORY_SEARCH_MAX_STRUCTURAL_FEATURE_LENGTH,
  MEMORY_SEARCH_SEMANTIC_STATUSES,
  MEMORY_SEARCH_STRUCTURAL_STATUSES,
} from '@ai-problem-solving-memory/api-client';
import {
  addEventToCurrentProblem,
  addVerificationToCurrentProblem,
  CLAUDE_CODE_RUNTIME_PROVENANCE,
  closeCurrentProblem,
  CODEX_RUNTIME_PROVENANCE,
  markCurrentProblemFixCandidate,
  recallSimilarExperience,
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
  type RuntimeProvenance,
} from '@ai-problem-solving-memory/claude-code-adapter';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import { createRecallFingerprintStore } from './recall-fingerprint-store.js';
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
  ADD_EVENT_TOOL,
  ADD_VERIFICATION_TOOL,
  BINDINGS_DIRECTORY,
  CALL_CONTEXT_DIRECTORY,
  CLOSE_PROBLEM_TOOL,
  CONTINUE_PROBLEM_TOOL,
  CURRENT_PROBLEM_TOOL,
  RECALL_FINGERPRINT_DIRECTORY,
  RECALL_SIMILAR_EXPERIENCE_TOOL,
  hostToolNames,
  MARK_FIX_CANDIDATE_TOOL,
  PLUGIN_DATA_ENV,
  RESUME_PROBLEM_TOOL,
  START_PROBLEM_TOOL,
  runtimeHostOf,
  type MemoryTool,
} from './runtime-constants.js';
import { readStateDirPointerForInstalledRoot } from './state-dir-pointer.js';

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

/**
 * A string the model wrote, checked and then left alone.
 *
 * The checking is deliberately not a cleaning. A schema that trimmed would
 * change the request before anything saw it, and that is wrong twice over: the
 * search that goes out is no longer the one the model composed, and a string
 * whose real length is over what the Memory accepts becomes acceptable merely
 * because trimming shortened it — so this tool would stop enforcing the
 * contract on what was actually sent. Both failures are silent.
 *
 * So the length checked is the string's own, the blank test asks whether there
 * is any non-whitespace character in it rather than removing anything, and the
 * value that comes out is the value that went in. That is the same rule the
 * common client applies when it validates the request it is handed, which is
 * why an accepted request here is one that client accepts too.
 *
 * Bounds come from the common client rather than being restated here: the
 * server that will read this request already publishes what it accepts, and a
 * second copy of a number is a second thing to keep in step.
 */
const boundedNonBlank = (maxLength: number): z.ZodType<string> =>
  z
    .string()
    .max(maxLength)
    .refine((value) => /\S/u.test(value), {
      // Says what was wrong, never what was sent.
      message: 'must contain at least one non-whitespace character',
    });

const FEATURE_ENTRY_SCHEMA = boundedNonBlank(MEMORY_SEARCH_MAX_STRUCTURAL_FEATURE_LENGTH);
const FEATURE_LIST_SCHEMA = z
  .array(FEATURE_ENTRY_SCHEMA)
  .max(MEMORY_SEARCH_MAX_STRUCTURAL_FEATURE_ITEMS);

/**
 * How the model describes what it currently understands.
 *
 * Seven fields and no eighth: one scalar domain, which may be absent because a
 * model may genuinely not know yet, and six lists. `schema_version` is
 * deliberately absent: which vocabulary these words are written in is the
 * runtime's to state, and a caller that could name it could claim to be
 * speaking a version it is not.
 */
const RECALL_FEATURES_SCHEMA = z
  .object({
    problem_domain: boundedNonBlank(MEMORY_SEARCH_MAX_STRUCTURAL_FEATURE_LENGTH).nullable(),
    symptom_patterns: FEATURE_LIST_SCHEMA,
    suspected_boundaries: FEATURE_LIST_SCHEMA,
    occurrence_conditions: FEATURE_LIST_SCHEMA,
    successful_directions: FEATURE_LIST_SCHEMA,
    dead_end_directions: FEATURE_LIST_SCHEMA,
    environment_facts: FEATURE_LIST_SCHEMA,
  })
  .strict();

/** Required semantic text for the existing append/close HTTP contracts. */
const NON_BLANK_TEXT_SCHEMA = z.string().refine((value) => /\S/u.test(value), {
  message: 'must contain at least one non-whitespace character',
});
const OPTIONAL_NULLABLE_TEXT_SCHEMA = z.string().nullable().optional();
const CLIENT_EVENT_ID_SCHEMA = z.string().uuid();

const ADD_EVENT_INPUT_SCHEMA = z
  .object({
    event_type: z.enum(EVENT_TYPES),
    summary: NON_BLANK_TEXT_SCHEMA,
    client_event_id: CLIENT_EVENT_ID_SCHEMA,
    result: OPTIONAL_NULLABLE_TEXT_SCHEMA,
    reason: OPTIONAL_NULLABLE_TEXT_SCHEMA,
    evidence_ref: OPTIONAL_NULLABLE_TEXT_SCHEMA,
  })
  .strict();

const ADD_VERIFICATION_INPUT_SCHEMA = z
  .object({
    verification_type: z.enum(VERIFICATION_TYPES),
    result: z.boolean(),
    summary: NON_BLANK_TEXT_SCHEMA,
    client_event_id: CLIENT_EVENT_ID_SCHEMA,
    evidence_ref: OPTIONAL_NULLABLE_TEXT_SCHEMA,
  })
  .strict();

const CLOSE_PROBLEM_INPUT_SCHEMA = z
  .object({
    target_status: z.enum(CLOSE_PROBLEM_TARGET_STATUSES),
    fix_kind: z.enum(FIX_KINDS).nullable().optional(),
    final_cause_summary: NON_BLANK_TEXT_SCHEMA.optional(),
    effective_direction: NON_BLANK_TEXT_SCHEMA.optional(),
    dead_end_summary: NON_BLANK_TEXT_SCHEMA.optional(),
    unresolved_points: NON_BLANK_TEXT_SCHEMA.optional(),
  })
  .strict();

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

/** No operation that acts may do so under a Project that has moved. */
const PROJECT_SELECTION_STALE_VARIANT = z
  .object({ kind: z.literal('PROJECT_SELECTION_STALE') })
  .strict();

/** Nor either of the two that act on a chosen Problem, if that choice has. */
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

/**
 * What a recall may answer with.
 *
 * `RECALLED` says how the search went and nothing about what it found. A count
 * and the two stage statuses separate "ran and found nothing" from "ran and
 * found something" from "a provider was degraded", which is what a caller needs
 * to decide what to do next. What the Memory actually said is somebody else's
 * to present.
 */
export const RECALL_SIMILAR_EXPERIENCE_OUTPUT_SCHEMA = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('RECALLED'),
      candidate_count: z.number().int().nonnegative(),
      semantic_status: z.enum(MEMORY_SEARCH_SEMANTIC_STATUSES),
      structural_status: z.enum(MEMORY_SEARCH_STRUCTURAL_STATUSES),
    })
    .strict(),
  // The same question about the same Problem, already asked and answered.
  z.object({ kind: z.literal('ALREADY_RECALLED') }).strict(),
  // Nothing authoritative to attach a search to. Deliberately one answer for
  // every reason: a recall does not ask Project or Problem questions, and
  // listing candidates here would be `current_problem`'s job done badly.
  z.object({ kind: z.literal('NO_CURRENT_PROBLEM') }).strict(),
  z.object({ kind: z.literal('MEMORY_READ_DISABLED') }).strict(),
  z.object({ kind: z.literal('CURRENT_SOURCE_CHANGED') }).strict(),
  z.object({ kind: z.literal('CURRENT_PROBLEM_NOT_AVAILABLE') }).strict(),
  ERROR_VARIANT,
]);

/** A current-Problem write that had no authoritative working subject. */
const CURRENT_PROBLEM_WRITE_UNAVAILABLE_VARIANTS = [
  z.object({ kind: z.literal('NO_CURRENT_PROBLEM') }).strict(),
  z.object({ kind: z.literal('CURRENT_PROBLEM_NOT_AVAILABLE') }).strict(),
] as const;

export const ADD_EVENT_OUTPUT_SCHEMA = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('EVENT_RECORDED'),
      problem_id: z.string(),
      event_id: z.string(),
      client_event_id: z.string(),
      on_current_problem: z.boolean(),
    })
    .strict(),
  ...CURRENT_PROBLEM_WRITE_UNAVAILABLE_VARIANTS,
  ERROR_VARIANT,
]);

export const ADD_VERIFICATION_OUTPUT_SCHEMA = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('VERIFICATION_RECORDED'),
      problem_id: z.string(),
      verification_id: z.string(),
      client_event_id: z.string(),
      on_current_problem: z.boolean(),
    })
    .strict(),
  ...CURRENT_PROBLEM_WRITE_UNAVAILABLE_VARIANTS,
  ERROR_VARIANT,
]);

export const CLOSE_PROBLEM_OUTPUT_SCHEMA = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('PROBLEM_CLOSED'),
      problem_id: z.string(),
      status: z.enum(CLOSE_PROBLEM_TARGET_STATUSES),
      version: z.number().int().min(1),
    })
    .strict(),
  ...CURRENT_PROBLEM_WRITE_UNAVAILABLE_VARIANTS,
  ERROR_VARIANT,
]);

export const MARK_FIX_CANDIDATE_OUTPUT_SCHEMA = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('FIX_CANDIDATE_MARKED'),
      problem_id: z.string(),
      status: z.literal('FIX_CANDIDATE'),
      version: z.number().int().min(1),
    })
    .strict(),
  ...CURRENT_PROBLEM_WRITE_UNAVAILABLE_VARIANTS,
  ERROR_VARIANT,
]);

export type RecallSimilarExperienceToolResult = z.infer<
  typeof RECALL_SIMILAR_EXPERIENCE_OUTPUT_SCHEMA
>;

export type AddEventToolResult = z.infer<typeof ADD_EVENT_OUTPUT_SCHEMA>;
export type AddVerificationToolResult = z.infer<typeof ADD_VERIFICATION_OUTPUT_SCHEMA>;
export type CloseProblemToolResult = z.infer<typeof CLOSE_PROBLEM_OUTPUT_SCHEMA>;
export type MarkFixCandidateToolResult = z.infer<typeof MARK_FIX_CANDIDATE_OUTPUT_SCHEMA>;

export type ContinueProblemToolResult = z.infer<typeof CONTINUE_PROBLEM_OUTPUT_SCHEMA>;
export type ResumeProblemToolResult = z.infer<typeof RESUME_PROBLEM_OUTPUT_SCHEMA>;
export type StartProblemToolResult = z.infer<typeof START_PROBLEM_OUTPUT_SCHEMA>;

/** Anything one of the tools may answer with. */
type ToolResult =
  | CurrentProblemOutcome
  | CurrentProblemToolResult
  | ContinueProblemToolResult
  | ResumeProblemToolResult
  | StartProblemToolResult
  | RecallSimilarExperienceToolResult
  | AddEventToolResult
  | AddVerificationToolResult
  | MarkFixCandidateToolResult
  | CloseProblemToolResult;

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
/**
 * Where this plugin's own state lives.
 *
 * One path, and deliberately only one. Where the session *is* used to arrive
 * here too, read once when this process started — which is why a session that
 * moved mid-run went on being answered about the directory it had left. That
 * value now comes per call, from the host's own event, and this is left with
 * the one thing that genuinely does not move: the plugin's data directory.
 */
export interface RuntimeStatePaths {
  readonly pluginData: string;
}

/**
 * The one path the server's environment supplies, or nothing.
 *
 * Absolute is required rather than resolved: a relative value would be resolved
 * against this process's working directory, which is exactly the thing a
 * Project must never be anchored on.
 */
/**
 * The fallback half of state-path resolution: the state-directory pointer for
 * the installation this process belongs to, or nothing. Injectable so a test
 * can stand anywhere; the real one is the pointer module's own reader, which
 * is the single place an installed-root identity may come from.
 */
export type ReadOwnStateDirPointer = () => string | undefined;

export function runtimeStatePathsOf(
  environment: Record<string, string | undefined>,
  readOwnPointer: ReadOwnStateDirPointer = readStateDirPointerForInstalledRoot,
): RuntimeStatePaths | undefined {
  const pluginData = environment[PLUGIN_DATA_ENV];
  if (pluginData !== undefined) {
    // The trusted environment remains first and final: a host that set the
    // variable said where the state is, and a value it got wrong is a refusal,
    // never a reason to go looking somewhere else.
    return isAbsolute(pluginData) ? { pluginData } : undefined;
  }
  // No environment at all is the measured Codex shape: its MCP child receives
  // no host variables, so the hook recorded where the host put the state,
  // keyed by the installed root this process was started in (`cwd: "."`).
  // The pointer module fails closed on everything malformed or foreign; a
  // relative answer is refused here for the same reason the variable is.
  const pointed = readOwnPointer();
  if (pointed === undefined || !isAbsolute(pointed)) {
    return undefined;
  }
  return { pluginData: pointed };
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
  readonly runtimeProvenance: RuntimeProvenance;
  /**
   * This plugin's own state directory, as validated for *this* call.
   *
   * Handed on rather than left to be looked up again. A second read of the
   * environment is a second answer: it can disagree with the one the call
   * context was claimed against, it can come back absent, and an absent one
   * that is patched up with a default becomes a relative path anchored on
   * whatever directory the process happens to be in. One authenticated call has
   * one state directory, and this is it.
   *
   * Internal composition only. It reaches no result, no error, no log, no
   * record and no Memory request.
   */
  readonly pluginData: string;
}

/**
 * Serves one call, in the order that keeps a failure from telling anybody anything.
 *
 * Written once and shared by every tool rather than repeated per handler:
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

  // 2. This plugin's own state directory, before the context is claimed —
  //    because claiming needs it, and because neither step reveals anything
  //    about the Memory. Nothing here says where the session is: that arrives
  //    with the call itself, in step 3.
  const paths = runtimeStatePathsOf(options.environment);
  if (paths === undefined) {
    return { kind: 'ERROR', code: 'HOST_CONTEXT_UNAVAILABLE' };
  }

  // 3. Claim the record for *this* call, and for this operation. Exactly once,
  //    or not at all. It yields the session, and where that session was when
  //    the host announced this call.
  const claim = await claimCallContext({
    directory: join(paths.pluginData, CALL_CONTEXT_DIRECTORY),
    hostCallId,
    toolNames: hostToolNames(tool),
    now: options.now(),
  });
  if (claim.kind !== 'CLAIMED') {
    // Still before any word about whether a Memory is configured.
    return { kind: 'ERROR', code: 'HOST_CONTEXT_UNAVAILABLE' };
  }

  const runtimeHost = runtimeHostOf(claim.toolName);
  if (runtimeHost === undefined) {
    return { kind: 'ERROR', code: 'HOST_CONTEXT_UNAVAILABLE' };
  }
  const runtimeProvenance =
    runtimeHost === 'codex' ? CODEX_RUNTIME_PROVENANCE : CLAUDE_CODE_RUNTIME_PROVENANCE;

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
      // The call's own location, and the only one. There is deliberately no
      // fallback to a start-up path: a stale directory does not fail, it
      // answers confidently about the wrong Project, which is worse than
      // saying nothing. The same value goes to Project detection and to
      // Environment capture, so the two cannot describe different places.
      projectDir: claim.currentDirectory,
      runtimeProvenance,
      // The same validated directory the claim above was made against.
      pluginData: paths.pluginData,
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
      runtimeProvenance: call.runtimeProvenance,
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
      runtimeProvenance: call.runtimeProvenance,
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

/**
 * Looks up what the Memory already knows about the Problem in hand.
 *
 * Everything about *which* Problem is established here, from the call's own
 * host context, and nothing about it is a model input. What the model supplies
 * is the question in its own words.
 */
export async function handleRecallSimilarExperience(
  request: unknown,
  options: CurrentProblemHandlerOptions,
  input: {
    readonly lexical_text: string;
    readonly semantic_text: string;
    readonly current_features: z.infer<typeof RECALL_FEATURES_SCHEMA>;
  },
): Promise<RecallSimilarExperienceToolResult> {
  return serveAuthenticated(request, options, RECALL_SIMILAR_EXPERIENCE_TOOL, async (call) => {
    const outcome = await recallSimilarExperience({
      client: call.client,
      bindingStore: call.bindingStore,
      fingerprintStore: createRecallFingerprintStore({
        // The call's own validated directory, not a second reading of the
        // environment. See `AuthenticatedCall.pluginData`.
        directory: join(call.pluginData, RECALL_FINGERPRINT_DIRECTORY),
      }),
      sessionId: call.sessionId,
      projectDir: call.projectDir,
      runtimeProvenance: call.runtimeProvenance,
      query: {
        lexicalText: input.lexical_text,
        semanticText: input.semantic_text,
        features: {
          problemDomain: input.current_features.problem_domain,
          symptomPatterns: input.current_features.symptom_patterns,
          suspectedBoundaries: input.current_features.suspected_boundaries,
          occurrenceConditions: input.current_features.occurrence_conditions,
          successfulDirections: input.current_features.successful_directions,
          deadEndDirections: input.current_features.dead_end_directions,
          environmentFacts: input.current_features.environment_facts,
        },
      },
    });

    return outcome.kind === 'RECALLED'
      ? {
          kind: 'RECALLED' as const,
          candidate_count: outcome.candidateCount,
          semantic_status: outcome.semanticStatus,
          structural_status: outcome.structuralStatus,
        }
      : { kind: outcome.kind };
  });
}

/** Records one typed Event on the current server-revalidated Problem. */
export async function handleAddEvent(
  request: unknown,
  options: CurrentProblemHandlerOptions,
  input: z.infer<typeof ADD_EVENT_INPUT_SCHEMA>,
): Promise<AddEventToolResult> {
  const outcome = await serveAuthenticated(request, options, ADD_EVENT_TOOL, async (call) =>
    addEventToCurrentProblem({
      client: call.client,
      bindingStore: call.bindingStore,
      sessionId: call.sessionId,
      projectDir: call.projectDir,
      runtimeProvenance: call.runtimeProvenance,
      eventType: input.event_type,
      summary: input.summary,
      clientEventId: input.client_event_id,
      ...(input.result !== undefined ? { result: input.result } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.evidence_ref !== undefined ? { evidenceRef: input.evidence_ref } : {}),
    }),
  );

  return outcome.kind === 'EVENT_RECORDED'
    ? {
        kind: 'EVENT_RECORDED',
        problem_id: outcome.problemId,
        event_id: outcome.eventId,
        client_event_id: outcome.clientEventId,
        on_current_problem: outcome.onCurrentProblem,
      }
    : outcome;
}

/** Records one typed Verification on the current server-revalidated Problem. */
export async function handleAddVerification(
  request: unknown,
  options: CurrentProblemHandlerOptions,
  input: z.infer<typeof ADD_VERIFICATION_INPUT_SCHEMA>,
): Promise<AddVerificationToolResult> {
  const outcome = await serveAuthenticated(request, options, ADD_VERIFICATION_TOOL, async (call) =>
    addVerificationToCurrentProblem({
      client: call.client,
      bindingStore: call.bindingStore,
      sessionId: call.sessionId,
      projectDir: call.projectDir,
      runtimeProvenance: call.runtimeProvenance,
      verificationType: input.verification_type,
      result: input.result,
      summary: input.summary,
      clientEventId: input.client_event_id,
      ...(input.evidence_ref !== undefined ? { evidenceRef: input.evidence_ref } : {}),
    }),
  );

  return outcome.kind === 'VERIFICATION_RECORDED'
    ? {
        kind: 'VERIFICATION_RECORDED',
        problem_id: outcome.problemId,
        verification_id: outcome.verificationId,
        client_event_id: outcome.clientEventId,
        on_current_problem: outcome.onCurrentProblem,
      }
    : outcome;
}

/** Concludes or pauses the current Problem using its final-read version. */
export async function handleCloseProblem(
  request: unknown,
  options: CurrentProblemHandlerOptions,
  input: z.infer<typeof CLOSE_PROBLEM_INPUT_SCHEMA>,
): Promise<CloseProblemToolResult> {
  const outcome = await serveAuthenticated(request, options, CLOSE_PROBLEM_TOOL, async (call) =>
    closeCurrentProblem({
      client: call.client,
      bindingStore: call.bindingStore,
      sessionId: call.sessionId,
      projectDir: call.projectDir,
      runtimeProvenance: call.runtimeProvenance,
      targetStatus: input.target_status,
      ...(input.fix_kind !== undefined ? { fixKind: input.fix_kind } : {}),
      ...(input.final_cause_summary !== undefined
        ? { finalCauseSummary: input.final_cause_summary }
        : {}),
      ...(input.effective_direction !== undefined
        ? { effectiveDirection: input.effective_direction }
        : {}),
      ...(input.dead_end_summary !== undefined ? { deadEndSummary: input.dead_end_summary } : {}),
      ...(input.unresolved_points !== undefined
        ? { unresolvedPoints: input.unresolved_points }
        : {}),
    }),
  );

  return outcome.kind === 'PROBLEM_CLOSED'
    ? {
        kind: 'PROBLEM_CLOSED',
        problem_id: outcome.problemId,
        status: outcome.status,
        version: outcome.version,
      }
    : outcome;
}

/** Marks the current investigation ready for Verification. */
export async function handleMarkFixCandidate(
  request: unknown,
  options: CurrentProblemHandlerOptions,
): Promise<MarkFixCandidateToolResult> {
  const outcome = await serveAuthenticated(
    request,
    options,
    MARK_FIX_CANDIDATE_TOOL,
    async (call) =>
      markCurrentProblemFixCandidate({
        client: call.client,
        bindingStore: call.bindingStore,
        sessionId: call.sessionId,
        projectDir: call.projectDir,
        runtimeProvenance: call.runtimeProvenance,
      }),
  );

  return outcome.kind === 'FIX_CANDIDATE_MARKED'
    ? {
        kind: 'FIX_CANDIDATE_MARKED',
        problem_id: outcome.problemId,
        status: outcome.status,
        version: outcome.version,
      }
    : outcome;
}

/** Builds the server. Exported so a test can drive it without a transport. */
export function buildMemoryMcpServer(options: CurrentProblemHandlerOptions): McpServer {
  const server = new McpServer({ name: 'memory', version: '0.0.0' });

  server.registerTool(
    CURRENT_PROBLEM_TOOL,
    {
      description:
        'Which problem this session is working on in this project, or what must be decided first. ' +
        'Normally takes no decision: session identity and the project root come from the host, ' +
        'never from a caller. If an earlier result asked a project question, call this again ' +
        'with project_decision to answer that question; the answer is revalidated against what ' +
        'this session resolves to now rather than taken as authority. ' +
        'Never picks between project or problem candidates — that judgement is the reader’s.',
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

  server.registerTool(
    RECALL_SIMILAR_EXPERIENCE_TOOL,
    {
      description:
        'Look up what past problem-solving has already learned that bears on the problem this ' +
        'session is working on. Describe your current understanding in your own words: short ' +
        'search terms, a fuller description, and the structural features you would compare ' +
        'against. Which project and problem this attaches to come from the host, never from you. ' +
        'Summarize — do not paste credentials, raw terminal or command output, or absolute paths ' +
        'from this machine. Reports how the lookup went, not what it found.',
      inputSchema: z
        .object({
          lexical_text: boundedNonBlank(MEMORY_SEARCH_MAX_LEXICAL_TEXT_LENGTH),
          semantic_text: boundedNonBlank(MEMORY_SEARCH_MAX_SEMANTIC_TEXT_LENGTH),
          current_features: RECALL_FEATURES_SCHEMA,
        })
        .strict(),
      outputSchema: RECALL_SIMILAR_EXPERIENCE_OUTPUT_SCHEMA,
      // Deliberately no `readOnlyHint`. A search is a read of the Memory, but
      // the server records that it happened, and telling a client otherwise
      // would be a lie it might act on.
    },
    async (args, extra) =>
      resultOf(await handleRecallSimilarExperience(extra?.mcpReq, options, args)),
  );

  server.registerTool(
    ADD_EVENT_TOOL,
    {
      description:
        'Record one typed event on the problem this session is currently working on. ' +
        'The project, problem and source assistant come from the authenticated host context; ' +
        'do not supply them. Mint client_event_id once for this logical event and reuse the ' +
        'same UUID after an unanswered attempt. Summarize what happened; do not paste ' +
        'credentials, raw terminal or command output, or absolute paths. The returned record ' +
        'may be an earlier owner-wide idempotency-key replay, so check on_current_problem.',
      inputSchema: ADD_EVENT_INPUT_SCHEMA,
      outputSchema: ADD_EVENT_OUTPUT_SCHEMA,
    },
    async (args, extra) => resultOf(await handleAddEvent(extra?.mcpReq, options, args)),
  );

  server.registerTool(
    ADD_VERIFICATION_TOOL,
    {
      description:
        'Record one check that was actually performed on the problem this session is currently ' +
        'working on. result is strictly true or false; absence means no Verification should be ' +
        'recorded. The project, problem and verifying assistant come from the authenticated host ' +
        'context. Mint client_event_id once and reuse the same UUID after an unanswered attempt. ' +
        'Summarize the evidence; do not paste credentials, raw output or absolute paths. The ' +
        'returned record may be an earlier owner-wide key replay, so check on_current_problem.',
      inputSchema: ADD_VERIFICATION_INPUT_SCHEMA,
      outputSchema: ADD_VERIFICATION_OUTPUT_SCHEMA,
    },
    async (args, extra) => resultOf(await handleAddVerification(extra?.mcpReq, options, args)),
  );

  server.registerTool(
    MARK_FIX_CANDIDATE_TOOL,
    {
      description:
        'Mark the current INVESTIGATING problem as FIX_CANDIDATE, ready for an actual ' +
        'Verification. Takes no content or identifiers: the problem, actor, fixed target and ' +
        'optimistic-lock version come from a fresh authenticated server read. Record what the ' +
        'candidate fix is with add_event first. A concurrent change or illegal state is ' +
        'reported and is never retried automatically.',
      inputSchema: z.object({}).strict(),
      outputSchema: MARK_FIX_CANDIDATE_OUTPUT_SCHEMA,
    },
    async (_args, extra) => resultOf(await handleMarkFixCandidate(extra?.mcpReq, options)),
  );

  server.registerTool(
    CLOSE_PROBLEM_TOOL,
    {
      description:
        'Conclude or pause the problem this session is currently working on. The problem, actor ' +
        'and optimistic-lock version come from a fresh authenticated server read, never from ' +
        'you. VERIFIED is refused by the Memory unless this Problem already has a successful ' +
        'Verification. Review fields are summaries only; do not paste credentials, raw output ' +
        'or absolute paths. A concurrent change is reported and is never retried automatically.',
      inputSchema: CLOSE_PROBLEM_INPUT_SCHEMA,
      outputSchema: CLOSE_PROBLEM_OUTPUT_SCHEMA,
    },
    async (args, extra) => resultOf(await handleCloseProblem(extra?.mcpReq, options, args)),
  );

  return server;
}

async function main(): Promise<void> {
  const paths = runtimeStatePathsOf(process.env);
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
