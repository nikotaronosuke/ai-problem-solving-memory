/**
 * Claude Code's side of the Memory boundary.
 *
 * Small on purpose. Everything host-specific that Phase 5 will need — project
 * identity, session continuity, when to search, what to record — arrives in
 * the task that owns it, and each one will be a thing this package knows and
 * the Memory does not.
 */

export {
  createClaudeCodeMemoryClient,
  MissingMemoryCredentialError,
  MEMORY_API_TOKEN_ENV,
  MEMORY_API_URL_ENV,
  type ClaudeCodeMemoryEnvironment,
} from './environment.js';

export { CLAUDE_CODE_SOURCE_AI } from './source-ai.js';
