/**
 * Carrying somebody's answer about a Project from one call to the next.
 *
 * A Project question is asked in one turn and answered in another, and between
 * them the world moves: a Project is registered, a boundary is declared, a
 * repository gains a second part. So an answer is never authority here. It is
 * a candidate, revalidated against a fresh look at the machine before anything
 * acts on it.
 *
 * ## What may travel
 *
 * Four answers, and nothing else. Not a repository, not a remote, not a path
 * from this machine, not a name, not a platform, not an owner — every one of
 * those is either the detector's to observe or the Memory's to hold, and a
 * model supplying one would be describing somebody's machine from memory.
 * What a person decides is *which of the four things they meant*, and a
 * repository-relative boundary when they meant that one.
 *
 * ## What this module is not
 *
 * It holds no rules. Whether a boundary is an ancestor of where the session
 * is, whether an ambiguity may be registered against, what a canonical remote
 * looks like, when a repository-less Project is allowed — all of that lives in
 * the adapter and is tested there. This translates a decision into the
 * adapter's own vocabulary and hands it over.
 */

import type { MemoryApiClient } from '@ai-problem-solving-memory/api-client';
import {
  detectProjectSignals,
  ProjectRegistrationArgumentError,
  registerProject,
  selectProject,
  type DetectProjectSignalsInput,
  type ProjectAmbiguityReason,
  type ProjectCandidate,
  type ProjectRegistrationChoice,
  type ProjectSuggestion,
} from '@ai-problem-solving-memory/claude-code-adapter';

/**
 * What somebody decided about which Project this session is in.
 *
 * The smallest form that carries the decision: three of these say "register
 * what is here, in this shape", and one says "it is that one".
 */
export type ProjectDecision =
  | { readonly kind: 'SELECT_EXISTING'; readonly project_id: string }
  | { readonly kind: 'REPOSITORY_ROOT' }
  | { readonly kind: 'REPOSITORY_BOUNDARY'; readonly repo_subpath: string }
  | { readonly kind: 'REGISTER_WITHOUT_REPOSITORY' };

/**
 * What settling the Project concluded.
 *
 * `SETTLED` is an identity and nothing else. The rest are questions, carried in
 * the shapes the resolver already built for them — and `DECISION_STALE`, which
 * says only that the answer this call was given no longer describes anything
 * true. It carries nothing at all: what is true now is a fresh question, and
 * there is a first-class operation for asking it.
 */
export type ProjectOutcome =
  | { readonly kind: 'SETTLED'; readonly projectId: string }
  | {
      readonly kind: 'AMBIGUOUS';
      readonly reason: ProjectAmbiguityReason;
      readonly candidates: readonly ProjectCandidate[];
    }
  | { readonly kind: 'BOUNDARY_REQUIRED'; readonly suggestion: ProjectSuggestion }
  | { readonly kind: 'EXPLICIT_REGISTRATION_REQUIRED'; readonly suggestion: ProjectSuggestion }
  | { readonly kind: 'NO_PROJECT_SIGNAL' }
  | { readonly kind: 'DECISION_STALE' };

export interface SettleProjectInput {
  readonly client: MemoryApiClient;
  readonly projectDir: string;
  readonly decision?: ProjectDecision | undefined;
  /** How git is invoked while detecting. Production omits it. */
  readonly runGit?: DetectProjectSignalsInput['runGit'];
}

/** The adapter's own vocabulary for a registration answer. */
function choiceOf(decision: ProjectDecision): ProjectRegistrationChoice | undefined {
  switch (decision.kind) {
    case 'REPOSITORY_ROOT':
      return { kind: 'REPOSITORY_ROOT' };
    case 'REPOSITORY_BOUNDARY':
      return { kind: 'REPOSITORY_BOUNDARY', repoSubpath: decision.repo_subpath };
    case 'REGISTER_WITHOUT_REPOSITORY':
      return { kind: 'REGISTER_WITHOUT_REPOSITORY' };
    case 'SELECT_EXISTING':
      // Not a registration at all: choosing an existing Project is a read.
      return undefined;
  }
}

/**
 * Settles which Project this session is in, honouring an answer if one came.
 *
 * Signals are detected here, freshly, on every call. An answer given a turn ago
 * was given about the machine as it was then, and the whole point of
 * revalidating is that nothing between the question and the answer is assumed
 * to have held still.
 */
export async function settleProject(input: SettleProjectInput): Promise<ProjectOutcome> {
  const signals = await detectProjectSignals({
    projectDir: input.projectDir,
    ...(input.runGit === undefined ? {} : { runGit: input.runGit }),
  });

  if (input.decision?.kind === 'SELECT_EXISTING') {
    // Chosen from a list somebody was shown. The list is not consulted — the
    // id is checked against what resolves *now*, because a Project that has
    // since been given a boundary may have settled the question by itself, and
    // an id accepted on the strength of the old list would attach this
    // session's work to a Project the evidence no longer points at.
    const selected = await selectProject(input.client, signals, input.decision.project_id);
    return selected.kind === 'SELECTED'
      ? { kind: 'SETTLED', projectId: selected.projectId }
      : { kind: 'DECISION_STALE' };
  }

  const choice = input.decision === undefined ? undefined : choiceOf(input.decision);

  let registered;
  try {
    registered = await registerProject(
      input.client,
      signals,
      ...(choice === undefined ? [] : ([choice] as const)),
    );
  } catch (error) {
    if (error instanceof ProjectRegistrationArgumentError) {
      // The answer cannot describe anything this session is in — a boundary
      // that no longer covers it, or a repository-less registration in a
      // repository that now has a remote. That is an answer that went out of
      // date, not a broken program, and it says so without repeating the value
      // it was given.
      return { kind: 'DECISION_STALE' };
    }
    throw error;
  }

  switch (registered.kind) {
    case 'RESOLVED':
    case 'CREATED':
      return { kind: 'SETTLED', projectId: registered.projectId };
    case 'AMBIGUOUS':
      return {
        kind: 'AMBIGUOUS',
        reason: registered.reason,
        candidates: registered.candidates,
      };
    case 'BOUNDARY_REQUIRED':
      return { kind: 'BOUNDARY_REQUIRED', suggestion: registered.suggestion };
    case 'EXPLICIT_REGISTRATION_REQUIRED':
      return { kind: 'EXPLICIT_REGISTRATION_REQUIRED', suggestion: registered.suggestion };
    case 'NO_PROJECT_SIGNAL':
      return { kind: 'NO_PROJECT_SIGNAL' };
  }
}

/** What checking a supplied Project identity concluded. */
export type ProjectSelectionOutcome =
  { readonly kind: 'SELECTED'; readonly projectId: string } | { readonly kind: 'STALE' };

export interface SelectSuppliedProjectInput {
  readonly client: MemoryApiClient;
  readonly projectDir: string;
  readonly projectId: string;
  readonly runGit?: DetectProjectSignalsInput['runGit'];
}

/**
 * Checks a Project identity a caller is about to act under.
 *
 * The only thing an operation that changes a Problem may do with a supplied
 * Project: confirm it, or refuse. It never registers — deciding that a Project
 * should exist is a conversation, and a mutation tool is not where somebody is
 * having it. And it never substitutes: silently acting under whatever resolves
 * now would carry out, against a different Project, a decision made about the
 * one the caller was looking at.
 */
export async function selectSuppliedProject(
  input: SelectSuppliedProjectInput,
): Promise<ProjectSelectionOutcome> {
  const signals = await detectProjectSignals({
    projectDir: input.projectDir,
    ...(input.runGit === undefined ? {} : { runGit: input.runGit }),
  });

  const selected = await selectProject(input.client, signals, input.projectId);

  return selected.kind === 'SELECTED'
    ? { kind: 'SELECTED', projectId: selected.projectId }
    : { kind: 'STALE' };
}
