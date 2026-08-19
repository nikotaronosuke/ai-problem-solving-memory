// Generated file — do not edit directly.
//
// Built from this package’s TypeScript sources by scripts/build-bundle.mjs.
// The source is the authority: change src/, run the bundle script, commit the
// result. An edit made here is lost on the next build and is invisible to the
// type checker, the linter and every test in this repository.

// src/pre-tool-use.ts
import { realpathSync } from "node:fs";
import { isAbsolute as isAbsolute2, join as join2 } from "node:path";
import { fileURLToPath } from "node:url";

// src/host-call-context.ts
import { createHash } from "node:crypto";
import { mkdir, open, readdir, readFile, stat, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

// src/runtime-constants.ts
var PLUGIN_NAME = "problem-solving-memory";
var MCP_SERVER_KEY = "memory";
var CURRENT_PROBLEM_TOOL = "current_problem";
var CONTINUE_PROBLEM_TOOL = "continue_problem";
var RESUME_PROBLEM_TOOL = "resume_problem";
var START_PROBLEM_TOOL = "start_problem";
var RECALL_SIMILAR_EXPERIENCE_TOOL = "recall_similar_experience";
var MEMORY_TOOLS = [
  CURRENT_PROBLEM_TOOL,
  CONTINUE_PROBLEM_TOOL,
  RESUME_PROBLEM_TOOL,
  START_PROBLEM_TOOL,
  RECALL_SIMILAR_EXPERIENCE_TOOL
];
function hostToolName(tool) {
  return `mcp__plugin_${PLUGIN_NAME}_${MCP_SERVER_KEY}__${tool}`;
}
var HOST_TOOL_NAMES = MEMORY_TOOLS.map(hostToolName);
var CALL_CONTEXT_DIRECTORY = "call-context";
var CALL_CONTEXT_FORMAT_VERSION = 2;
var PENDING_PREFIX = "pending-";
var RECORD_SUFFIX = ".json";
var CALL_CONTEXT_MAX_AGE_MS = 60 * 60 * 1e3;

// src/host-call-context.ts
function callContextFilename(hostCallId, prefix = PENDING_PREFIX) {
  const digest = createHash("sha256").update(hostCallId, "utf8").digest("hex");
  return `${prefix}${digest}${RECORD_SUFFIX}`;
}
var OWNED_FILENAME = /^(?:pending-[0-9a-f]{64}\.json|claim-[0-9a-f]{64}\.lock|claimed-[0-9a-f]{64}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json)$/u;
function isOwnedCallContextFilename(entry) {
  return OWNED_FILENAME.test(entry);
}
async function mintCallContext(options) {
  await mkdir(options.directory, { recursive: true });
  const context = {
    format_version: CALL_CONTEXT_FORMAT_VERSION,
    session_id: options.sessionId,
    tool_name: options.toolName,
    // Written as the host gave it. Nothing here canonicalises a repository or
    // reads git: the hook is transport, and deciding what a directory means
    // is the adapter's, one process later.
    current_directory: options.currentDirectory,
    minted_at: options.now
  };
  const path = join(options.directory, callContextFilename(options.hostCallId));
  try {
    const handle = await open(path, "wx", 384);
    try {
      await handle.writeFile(JSON.stringify(context), "utf8");
    } finally {
      await handle.close();
    }
    return true;
  } catch {
    return false;
  }
}
async function sweepCallContexts(options) {
  let entries;
  try {
    entries = await readdir(options.directory);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!isOwnedCallContextFilename(entry)) {
      continue;
    }
    const path = join(options.directory, entry);
    let description;
    try {
      description = await stat(path);
    } catch {
      continue;
    }
    if (!description.isFile()) {
      continue;
    }
    const age = options.now - description.mtimeMs;
    if (age <= CALL_CONTEXT_MAX_AGE_MS) {
      continue;
    }
    await unlink(path).catch(() => void 0);
  }
}

// src/pre-tool-use.ts
var HOST_PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
var REASONS = {
  ALLOW: "Memory has the session context for this call.",
  SUBAGENT: "Memory works in the main session only.",
  UNUSABLE: "Memory could not establish the session context for this call."
};
function decide(permissionDecision, permissionDecisionReason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      permissionDecisionReason
    }
  };
}
function isNonBlank(value) {
  return typeof value === "string" && /\S/.test(value);
}
async function runPreToolUse(event, environment, now) {
  if (typeof event !== "object" || event === null) {
    return decide("deny", REASONS.UNUSABLE);
  }
  const input = event;
  const toolName = input["tool_name"];
  if (typeof toolName !== "string" || !HOST_TOOL_NAMES.includes(toolName)) {
    return decide("deny", REASONS.UNUSABLE);
  }
  if ("agent_id" in input && input["agent_id"] !== void 0 && input["agent_id"] !== null) {
    return decide("deny", REASONS.SUBAGENT);
  }
  const sessionId = input["session_id"];
  const hostCallId = input["tool_use_id"];
  const currentDirectory = input["cwd"];
  if (!isNonBlank(sessionId) || !isNonBlank(hostCallId) || !isNonBlank(currentDirectory) || !isAbsolute2(currentDirectory)) {
    return decide("deny", REASONS.UNUSABLE);
  }
  const pluginData = environment[HOST_PLUGIN_DATA_ENV];
  if (!isNonBlank(pluginData)) {
    return decide("deny", REASONS.UNUSABLE);
  }
  const directory = join2(pluginData, CALL_CONTEXT_DIRECTORY);
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
    now
  });
  return minted ? decide("allow", REASONS.ALLOW) : decide("deny", REASONS.UNUSABLE);
}
async function readEvent() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
async function main() {
  let decision;
  try {
    decision = await runPreToolUse(await readEvent(), process.env, Date.now());
  } catch {
    decision = decide("deny", REASONS.UNUSABLE);
  }
  process.stdout.write(JSON.stringify(decision));
}
function isEntrypoint() {
  const entry = process.argv[1];
  if (entry === void 0) {
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
export {
  runPreToolUse
};
