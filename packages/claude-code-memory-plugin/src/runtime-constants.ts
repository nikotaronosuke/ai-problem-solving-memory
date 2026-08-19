/**
 * The names and numbers both halves of this plugin have to agree on.
 *
 * A hook process and an MCP server process never meet. They agree by writing
 * and reading the same files under the same names, and every value that has to
 * match is here rather than typed twice — two copies of a filename prefix or a
 * maximum age are two things that drift, and the drift shows up as a session
 * quietly failing to find its own Problem.
 */

/**
 * The plugin's name, as declared in its manifest.
 *
 * The host builds the tool name a hook matcher sees out of this and the MCP
 * server key, so the three move together or not at all.
 */
export const PLUGIN_NAME = 'problem-solving-memory';

/** The MCP server key, as declared in `.mcp.json`. */
export const MCP_SERVER_KEY = 'memory';

/**
 * The four ways somebody enters a Problem.
 *
 * Named for goals rather than for the calls underneath them: which Problem am
 * I on, carry on with this one, bring this paused one back, start a new one.
 * There is deliberately no tool for resolving a Project, creating an
 * Environment or moving a status — those are steps, and a surface made of
 * steps asks the model to assemble a lifecycle it has no way to get right.
 */
export const CURRENT_PROBLEM_TOOL = 'current_problem';
export const CONTINUE_PROBLEM_TOOL = 'continue_problem';
export const RESUME_PROBLEM_TOOL = 'resume_problem';
export const START_PROBLEM_TOOL = 'start_problem';

/**
 * Looking up what the Memory already knows about the Problem in hand.
 *
 * The fifth, and the first that is not about *which* Problem this session is
 * on. The four above are how somebody enters a Problem; this is what they do
 * once they are in one.
 */
export const RECALL_SIMILAR_EXPERIENCE_TOOL = 'recall_similar_experience';

/** Every tool this runtime exposes. Exactly these, and a guard says so. */
export const MEMORY_TOOLS = [
  CURRENT_PROBLEM_TOOL,
  CONTINUE_PROBLEM_TOOL,
  RESUME_PROBLEM_TOOL,
  START_PROBLEM_TOOL,
  RECALL_SIMILAR_EXPERIENCE_TOOL,
] as const;

export type MemoryTool = (typeof MEMORY_TOOLS)[number];

/**
 * The name the host actually exposes for a tool, assembled the way it does.
 *
 * Built from one rule rather than written out once per tool, so the hook's
 * matchers, the record a hook mints and the name a handler claims under cannot
 * drift apart. The shape is measured against the installed host rather than
 * assumed, and a probe re-checks every tool: if the host ever names tools
 * differently, this function and the manifest move together.
 */
export function hostToolName(tool: MemoryTool): string {
  return `mcp__plugin_${PLUGIN_NAME}_${MCP_SERVER_KEY}__${tool}`;
}

/** The exact host names, which are the only set that may mint identity. */
export const HOST_TOOL_NAMES: readonly string[] = MEMORY_TOOLS.map(hostToolName);

/**
 * Where the host tells this plugin to keep state that outlives a session.
 *
 * Passed in through the MCP server's declared environment rather than read
 * from the host's own variable names, so the runtime depends on one name it
 * controls instead of on the host's spelling.
 *
 * This is the *only* path the server's environment carries, and deliberately
 * so. Where the session currently is arrives per call instead, because a
 * value read once at start-up describes where the session *began*: a session
 * that moves while the server keeps running would otherwise go on being
 * answered about the place it left.
 */
export const PLUGIN_DATA_ENV = 'MEMORY_CLAUDE_PLUGIN_DATA';

/** Bindings and call contexts are different formats with different lifetimes. */
export const BINDINGS_DIRECTORY = 'bindings';
export const CALL_CONTEXT_DIRECTORY = 'call-context';

/**
 * Where repeated recalls are remembered, kept apart from both of those.
 *
 * A binding is what a session is working on and a call context is one call's
 * identity; this is a cache nobody must trust. Putting it in with either would
 * place a file that may be lost beside files that may not.
 */
export const RECALL_FINGERPRINT_DIRECTORY = 'recall-fingerprints';

/**
 * The only record layout this version writes, and the only one it reads.
 *
 * Version 2 added the call's current directory. Version 1 is refused rather
 * than tolerated: it carries no location, so accepting one would mean
 * answering the call from somewhere else — which is the defect this version
 * exists to close. A version-1 file left behind by an older install is
 * ordinary litter, and the sweep removes it by name and age without parsing
 * it.
 */
export const CALL_CONTEXT_FORMAT_VERSION = 2;

/** The keys a pending record carries. Exactly these, in this order. */
export const CALL_CONTEXT_FIELDS = [
  'format_version',
  'session_id',
  'tool_name',
  'current_directory',
  'minted_at',
] as const;

export const PENDING_PREFIX = 'pending-';
export const RECORD_SUFFIX = '.json';

/**
 * The marker whose creation *is* the claim.
 *
 * One name per host call, derived from the same hash as the record it guards,
 * with nothing random in it — every contender for a call has to contend for
 * exactly the same filesystem object, and a unique name per contender would
 * mean nobody contends for anything.
 */
export const CLAIM_MARKER_PREFIX = 'claim-';
export const CLAIM_MARKER_SUFFIX = '.lock';

/**
 * How old a record may be before it is swept, and refused.
 *
 * **This is not the authentication property**, and reading it as one is the
 * mistake this comment exists to prevent. What authenticates a call is that
 * its record is keyed by *that call's* host identifier: a later call has a
 * different identifier and therefore looks for a different file, whatever the
 * age of anything on disk. A record that could authenticate the wrong call
 * would be no safer for expiring in an hour.
 *
 * What the age is for is storage: a call that was denied, or refused by schema
 * validation, or interrupted, leaves a record nobody will ever claim. This
 * bounds how long those sit there.
 */
export const CALL_CONTEXT_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * A ceiling on how much of a record is read before it is judged malformed.
 *
 * These files are written by this plugin and are a few hundred bytes. Reading
 * without a bound would make anything that ends up in that directory this
 * process's problem.
 *
 * Kept at 4096 after the record gained a directory: the rest of a record is
 * under 200 bytes, so this leaves room for a path far longer than any host
 * this runtime supports can hand it — Windows' own extended limit is 32,767
 * *characters*, but a project root that long is not a path anybody has, and a
 * record that overran this would be refused rather than silently truncated.
 */
export const CALL_CONTEXT_MAX_BYTES = 4096;
