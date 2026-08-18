/**
 * Claude Code's side of the Memory boundary.
 *
 * Small on purpose. Everything host-specific that Phase 5 will need — session
 * continuity, when to search, what to record — arrives in the task that owns it,
 * and each one is a thing this package knows and the Memory does not.
 *
 * Project identity arrived first: reading what this machine can say about where
 * a session is working, and deciding which existing Project that is. Current
 * Problem resolution sits on top of it — given a Project, which Problem is
 * being worked on, or which ones could be. Both ask nobody anything and create
 * nothing, which is why there is still no MCP server, no hook and no Skill
 * here.
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

export {
  registerProject,
  selectProject,
  ProjectRegistrationArgumentError,
  ProjectRegistrationInvariantError,
  type ProjectRegistrationChoice,
  type ProjectRegistrationClient,
  type ProjectRegistrationResult,
  type ProjectSelectionClient,
  type ProjectSelectionResult,
} from './project-outcome.js';

export {
  captureEnvironment,
  EnvironmentCaptureArgumentError,
  type CaptureEnvironmentInput,
} from './environment-capture.js';

export {
  startProblem,
  type StartProblemClient,
  type StartProblemInput,
  type StartProblemResult,
} from './problem-start.js';

export {
  createProblemBindingStore,
  ProblemBindingArgumentError,
  type ProblemBindingRead,
  type ProblemBindingRemoval,
  type ProblemBindingStore,
  type ProblemBindingWrite,
} from './problem-binding-store.js';

export {
  CONTINUABLE_PROBLEM_STATUSES,
  isProblemGone,
  resolveCurrentProblem,
  type ContinuableProblemStatus,
  type CurrentProblemReader,
  type CurrentProblemResolution,
  type CurrentProblemStatusClass,
  type ProblemBindingHint,
  type ProblemCandidate,
} from './problem-resolution.js';

export {
  continueProblem,
  ProblemLifecycleInvariantError,
  RESUME_PROBLEM_TARGET_STATUSES,
  resolveProblemForSession,
  resumeProblem,
  startNewProblem,
  type ProblemBindingWriter,
  type ProblemContinuity,
  type ProblemSelectionResult,
  type ReconsiderReason,
  type ResumeProblemClient,
  type ResumeProblemResult,
  type ResumeProblemTargetStatus,
  type StartNewProblemClient,
  type StartNewProblemResult,
} from './problem-lifecycle.js';
