/**
 * Claude Code's side of the Memory boundary.
 *
 * Small on purpose. Everything host-specific that Phase 5 will need — session
 * continuity, when to search, what to record — arrives in the task that owns it,
 * and each one is a thing this package knows and the Memory does not.
 *
 * Project identity arrived in P5-03: reading what this machine can say about
 * where a session is working, and deciding which existing Project that is. It
 * asks nobody anything and creates nothing, which is why there is still no MCP
 * server, no hook and no Skill here.
 */

export {
  createClaudeCodeMemoryClient,
  MissingMemoryCredentialError,
  MEMORY_API_TOKEN_ENV,
  MEMORY_API_URL_ENV,
  type ClaudeCodeMemoryEnvironment,
} from './environment.js';

export { CLAUDE_CODE_SOURCE_AI } from './source-ai.js';

export { canonicaliseGitRemote } from './project-remote.js';

export {
  detectProjectSignals,
  runGitCommand,
  type DetectProjectSignalsInput,
  type GitCommandResult,
  type GitRunner,
  type ProjectSignals,
} from './project-signals.js';

export {
  PROJECT_AMBIGUITY_REASONS,
  resolveProject,
  type ProjectAmbiguityReason,
  type ProjectCandidate,
  type ProjectReader,
  type ProjectResolution,
  type ProjectSuggestion,
} from './project-resolution.js';
