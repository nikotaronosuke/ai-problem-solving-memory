/**
 * The trusted half of the bridge: a pre-tool hook the host runs, not the model.
 *
 * It is given the current session and the host's identifier for the call about
 * to happen, and it writes exactly one small record joining them. It changes
 * nothing about the call — no rewritten input, no injected field — so there is
 * nothing for the model to carry, nothing to appear in a transcript, and
 * nothing for a later call to present again.
 *
 * ## Everything it refuses
 *
 * A hook that mints on doubt is worse than one that mints on nothing. So: only
 * this exact tool, only with both identifiers present, only in the main
 * session, and only when no record for that call already exists. Every other
 * case denies the Memory tool and writes nothing, which costs a person one
 * unavailable tool and costs nothing else.
 *
 * ## Why a subagent gets nothing
 *
 * The host marks a subagent's calls with its own identifier and passes the main
 * session's id alongside. Minting for one would lend the main conversation's
 * Problem lifecycle to delegated work that cannot be seen from it — a subagent
 * binding a Problem, or starting one, on behalf of a session it is not.
 *
 * ## What it prints
 *
 * Standard output is a protocol channel and carries the decision and nothing
 * else: no path, no session, no call identifier. Errors are fixed prose on
 * standard error, because a hook's diagnostics are somewhere a value would
 * otherwise leak.
 */

import { realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mintCallContext, sweepCallContexts } from './host-call-context.js';
import { CALL_CONTEXT_DIRECTORY, HOST_TOOL_NAMES } from './runtime-constants.js';

/** The host's variable, read here because a hook is a host process. */
const HOST_PLUGIN_DATA_ENV = 'CLAUDE_PLUGIN_DATA';

/** What the hook decided, in the host's own vocabulary. */
export interface PreToolUseDecision {
  readonly hookSpecificOutput: {
    readonly hookEventName: 'PreToolUse';
    readonly permissionDecision: 'allow' | 'deny';
    readonly permissionDecisionReason: string;
  };
}

/**
 * Fixed prose, chosen from a closed set.
 *
 * A reason is shown to a person and to the model, so it says what happened in
 * general terms and never which session, call or path it happened to.
 */
const REASONS = {
  ALLOW: 'Memory has the session context for this call.',
  SUBAGENT: 'Memory works in the main session only.',
  UNUSABLE: 'Memory could not establish the session context for this call.',
} as const;

function decide(
  permissionDecision: 'allow' | 'deny',
  permissionDecisionReason: string,
): PreToolUseDecision {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision,
      permissionDecisionReason,
    },
  };
}

function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && /\S/.test(value);
}

/**
 * Decides one pre-tool event, and records the call context when it should.
 *
 * Written as a function over an already-parsed event so it can be driven
 * without a host: the entrypoint below only reads standard input and prints.
 */
export async function runPreToolUse(
  event: unknown,
  environment: Record<string, string | undefined>,
  now: number,
): Promise<PreToolUseDecision> {
  if (typeof event !== 'object' || event === null) {
    return decide('deny', REASONS.UNUSABLE);
  }
  const input = event as Record<string, unknown>;

  // One of these exactly, and nothing that merely resembles one. A hook
  // matcher is configuration and can be widened by accident; this is the check
  // that decides whether session identity is minted at all.
  const toolName = input['tool_name'];
  if (typeof toolName !== 'string' || !HOST_TOOL_NAMES.includes(toolName)) {
    return decide('deny', REASONS.UNUSABLE);
  }

  // Delegated work is not the owner's Problem lifecycle. Presence is the whole
  // test — what kind of subagent it is changes nothing.
  if ('agent_id' in input && input['agent_id'] !== undefined && input['agent_id'] !== null) {
    return decide('deny', REASONS.SUBAGENT);
  }

  const sessionId = input['session_id'];
  const hostCallId = input['tool_use_id'];
  // Where the session is *now*, from the host's own event rather than from
  // anything this process could look up. `tool_input` is the model's and is
  // never consulted; a relative value is refused rather than resolved,
  // because resolving one would anchor a Project on whichever process
  // happened to read it.
  const currentDirectory = input['cwd'];
  if (
    !isNonBlank(sessionId) ||
    !isNonBlank(hostCallId) ||
    !isNonBlank(currentDirectory) ||
    !isAbsolute(currentDirectory)
  ) {
    return decide('deny', REASONS.UNUSABLE);
  }

  const pluginData = environment[HOST_PLUGIN_DATA_ENV];
  if (!isNonBlank(pluginData)) {
    return decide('deny', REASONS.UNUSABLE);
  }

  const directory = join(pluginData, CALL_CONTEXT_DIRECTORY);

  // Litter from calls that were denied or refused before their handler ran.
  // Its failure is not this call's problem, which is why nothing is checked.
  await sweepCallContexts({ directory, now });

  const minted = await mintCallContext({
    directory,
    hostCallId,
    sessionId,
    // The *actual* tool, not the category. A record minted for one operation
    // must not authenticate another, so the name it was minted for is part of
    // what the handler later checks.
    toolName,
    currentDirectory,
    now,
  });

  // A record already there means two host events claim one call. Nobody has
  // explained that, and replacing it would hand this call whichever session
  // wrote last.
  return minted ? decide('allow', REASONS.ALLOW) : decide('deny', REASONS.UNUSABLE);
}

/** Reads the event from standard input, as the host delivers it. */
async function readEvent(): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function main(): Promise<void> {
  let decision: PreToolUseDecision;
  try {
    decision = await runPreToolUse(await readEvent(), process.env, Date.now());
  } catch {
    // Including a malformed event. Nothing about it is described: the failure
    // is the same to a caller either way, and the contents are somebody's.
    decision = decide('deny', REASONS.UNUSABLE);
  }
  process.stdout.write(JSON.stringify(decision));
}

/**
 * Whether Node was asked to run this file, rather than to import it.
 *
 * Compared as resolved real paths, because a hook is launched by an absolute
 * path on one platform and through a link on another — and because the tests
 * import this module, where reading standard input would hang them.
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
