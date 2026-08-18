/**
 * "Which Problem am I on?", answered by composing what already decides that.
 *
 * Every rule this needs exists: which Project a session is in, when that is a
 * question rather than an answer, which Problem is bound to a session, and when
 * candidates must be offered instead of chosen. None of it is repeated here.
 * What this module owns is the translation between those answers and something
 * a tool can return — and the discipline that a question stays a question.
 *
 * ## Nothing is chosen on anybody's behalf
 *
 * Not the only Problem candidate, not the only Project candidate, not a
 * boundary that happens to match the directory somebody is in. Each of those is
 * a judgement about what the work *is*, and an assistant making it silently is
 * how a Memory ends up describing an investigation that never happened.
 *
 * ## Registration is not the same as choosing
 *
 * A session at the root of a repository nothing has recorded does register a
 * Project, deterministically, because there is nothing to decide: one Project
 * for one repository is the only thing that could be meant. That is why this
 * tool is not advertised as read-only — it can create a durable record.
 *
 * ## What travels out
 *
 * Identities, a status, and the few words somebody needs to tell candidates
 * apart. No resource passthrough, no owner, no timestamps, no version, no
 * environment, and no path from this machine.
 */

import type { MemoryApiClient } from '@ai-problem-solving-memory/api-client';
import {
  detectProjectSignals,
  registerProject,
  resolveProblemForSession,
  type ContinuableProblemStatus,
  type DetectProjectSignalsInput,
  type ProblemBindingStore,
  type ProjectAmbiguityReason,
} from '@ai-problem-solving-memory/claude-code-adapter';

/** One Problem somebody could continue, in the least that identifies it. */
export interface CurrentProblemCandidate {
  readonly problem_id: string;
  readonly status: ContinuableProblemStatus;
  readonly title: string;
}

/** One Project somebody could be in, with what they would choose between. */
export interface CurrentProblemProjectCandidate {
  readonly project_id: string;
  readonly project_name: string;
  readonly canonical_repo: string | null;
  readonly repo_subpath: string | null;
}

/**
 * What asking about the current Problem concluded.
 *
 * Three of these are answers and four are questions. The questions carry
 * exactly the material somebody needs to answer them, and answering them is
 * not something this tool can yet accept — that arrives with the operations
 * that act on the answers.
 */
export type CurrentProblemOutcome =
  | { readonly kind: 'CURRENT_PROBLEM'; readonly project_id: string; readonly problem_id: string }
  | { readonly kind: 'NO_PROBLEM'; readonly project_id: string }
  | {
      readonly kind: 'PROBLEM_CANDIDATES';
      readonly project_id: string;
      readonly candidates: readonly CurrentProblemCandidate[];
    }
  | {
      readonly kind: 'PROJECT_AMBIGUOUS';
      readonly reason: ProjectAmbiguityReason;
      readonly candidates: readonly CurrentProblemProjectCandidate[];
    }
  | {
      readonly kind: 'BOUNDARY_REQUIRED';
      readonly project_name: string;
      readonly detected_repo_subpath: string;
    }
  | { readonly kind: 'EXPLICIT_REGISTRATION_REQUIRED'; readonly project_name: string }
  | { readonly kind: 'NO_PROJECT_SIGNAL' };

/**
 * Raised when a deterministic answer cannot be turned into a result.
 *
 * One case only, and it is a contradiction rather than a condition: a Project
 * that needs a boundary decided, in a session the detector said is not inside a
 * subdirectory. Carries nothing.
 */
export class CurrentProblemInvariantError extends Error {
  constructor() {
    super('A Project question arrived without the material that defines it.');
    this.name = 'CurrentProblemInvariantError';
  }
}

/** What this composition needs, so a test supplies exactly it. */
export interface CurrentProblemInput {
  readonly client: MemoryApiClient;
  readonly bindingStore: ProblemBindingStore;
  readonly sessionId: string;
  readonly projectDir: string;
  /** How git is invoked while detecting. Production omits it. */
  readonly runGit?: DetectProjectSignalsInput['runGit'];
}

/**
 * Answers the question, or hands back the one that has to be answered first.
 *
 * The Project comes first because a Problem has no meaning without one, and it
 * is resolved from what this machine can see rather than from anything the
 * model said — the root is the host's, and the model has no field to put one in.
 */
export async function currentProblem(input: CurrentProblemInput): Promise<CurrentProblemOutcome> {
  const signals = await detectProjectSignals({
    projectDir: input.projectDir,
    // Absent stays absent: passing `undefined` explicitly is a different claim
    // under this repository's exact-optional rule.
    ...(input.runGit === undefined ? {} : { runGit: input.runGit }),
  });

  // No owner choice is passed, and none can be: this tool has no input for one
  // yet. So this registers only what needs no decision, and returns every
  // question untouched.
  const project = await registerProject(input.client, signals);

  switch (project.kind) {
    case 'AMBIGUOUS':
      return {
        kind: 'PROJECT_AMBIGUOUS',
        reason: project.reason,
        candidates: project.candidates.map((candidate) => ({
          project_id: candidate.projectId,
          project_name: candidate.projectName,
          canonical_repo: candidate.canonicalRepo,
          repo_subpath: candidate.repoSubpath,
        })),
      };

    case 'BOUNDARY_REQUIRED': {
      const detected = project.suggestion.monorepoSubpath;
      if (detected === null) {
        // The resolver only asks this because a subdirectory was detected, so
        // the two disagree about what was seen.
        throw new CurrentProblemInvariantError();
      }
      return {
        kind: 'BOUNDARY_REQUIRED',
        project_name: project.suggestion.projectName,
        detected_repo_subpath: detected,
      };
    }

    case 'EXPLICIT_REGISTRATION_REQUIRED':
      // Deliberately without the repository: there is none, which is the whole
      // reason this is being asked.
      return {
        kind: 'EXPLICIT_REGISTRATION_REQUIRED',
        project_name: project.suggestion.projectName,
      };

    case 'NO_PROJECT_SIGNAL':
      return { kind: 'NO_PROJECT_SIGNAL' };

    case 'CREATED':
    case 'RESOLVED': {
      const problem = await resolveProblemForSession(
        input.client,
        input.bindingStore,
        input.sessionId,
        project.projectId,
      );

      switch (problem.kind) {
        case 'RESOLVED':
          return {
            kind: 'CURRENT_PROBLEM',
            project_id: project.projectId,
            problem_id: problem.problemId,
          };
        case 'NONE':
          return { kind: 'NO_PROBLEM', project_id: project.projectId };
        case 'CANDIDATES':
          // However few. One candidate is still a candidate, and turning it
          // into an answer here would be the count deciding what somebody is
          // working on.
          return {
            kind: 'PROBLEM_CANDIDATES',
            project_id: project.projectId,
            candidates: problem.candidates.map((candidate) => ({
              problem_id: candidate.problemId,
              status: candidate.status,
              title: candidate.title,
            })),
          };
      }
    }
  }
}
