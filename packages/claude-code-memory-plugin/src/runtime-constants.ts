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

/** The one tool this runtime exposes. */
export const CURRENT_PROBLEM_TOOL = 'current_problem';

/**
 * The tool name the host actually exposes, assembled the way it assembles it.
 *
 * Written out rather than pattern-matched, because the hook has to decide
 * whether a call is *this* tool before it mints anything, and a loose matcher
 * would mint host identity for whatever else happened to look similar. The
 * shape is measured against the installed host rather than assumed, and a
 * probe re-checks it: if the host ever names tools differently, this constant
 * and the manifest matcher move together.
 */
export const HOST_TOOL_NAME = `mcp__plugin_${PLUGIN_NAME}_${MCP_SERVER_KEY}__${CURRENT_PROBLEM_TOOL}`;

/**
 * Where the host tells this plugin to keep state that outlives a session.
 *
 * Passed in through the MCP server's declared environment rather than read
 * from the host's own variable names, so the runtime depends on one name it
 * controls instead of on the host's spelling.
 */
export const PROJECT_DIR_ENV = 'MEMORY_CLAUDE_PROJECT_DIR';
export const PLUGIN_DATA_ENV = 'MEMORY_CLAUDE_PLUGIN_DATA';

/** Bindings and call contexts are different formats with different lifetimes. */
export const BINDINGS_DIRECTORY = 'bindings';
export const CALL_CONTEXT_DIRECTORY = 'call-context';

/** The only record layout this version writes, and the only one it reads. */
export const CALL_CONTEXT_FORMAT_VERSION = 1;

/** The keys a pending record carries. Exactly these, in this order. */
export const CALL_CONTEXT_FIELDS = [
  'format_version',
  'session_id',
  'tool_name',
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
 */
export const CALL_CONTEXT_MAX_BYTES = 4096;
