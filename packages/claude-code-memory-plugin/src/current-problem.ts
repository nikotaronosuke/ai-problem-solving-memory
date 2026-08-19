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
 * ## A question comes back through the same operation
 *
 * A question stays a question until somebody decides it — but the decision
 * returns here, as `projectDecision`, rather than to the operations that act
 * on a Problem. Asking and being answered are two halves of one conversation,
 * and a call that continues or starts a Problem is not where anybody is having
 * it. Those operations confirm the Project they were handed and can settle
 * nothing.
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
  resolveProblemForSession,
  type ContinuableProblemStatus,
  type DetectProjectSignalsInput,
  type ProblemBindingStore,
  type ProjectAmbiguityReason,
} from '@ai-problem-solving-memory/claude-code-adapter';

import { settleProject, type ProjectDecision } from './project-decision.js';

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
 * Some of these are answers and some are questions. The questions carry
 * exactly the material somebody needs to answer them, and the answer comes
 * back to this same operation as a `projectDecision`. One outcome is neither:
 * a decision that no longer describes this session is stale, which is a reply
 * to an answer rather than a question of its own.
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
  | { readonly kind: 'NO_PROJECT_SIGNAL' }
  | { readonly kind: 'PROJECT_DECISION_STALE' };

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
  /**
   * An answer to a Project question this operation asked earlier.
   *
   * Optional because most calls have nothing to answer: a session in a
   * recorded repository never sees a question at all. When one does arrive it
   * is a candidate rather than an instruction — revalidated against a fresh
   * look at the machine before anything is registered or resolved.
   */
  readonly projectDecision?: ProjectDecision | undefined;
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
  // Detection, the answer if one came, and the revalidation of it all happen
  // in one place — so this operation and the three that act on a Problem
  // cannot come to differ about what settling a Project means.
  const project = await settleProject({
    client: input.client,
    projectDir: input.projectDir,
    decision: input.projectDecision,
    ...(input.runGit === undefined ? {} : { runGit: input.runGit }),
  });

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

    case 'DECISION_STALE':
      // The answer this call was given no longer describes anything true. It
      // carries nothing back: what *is* true is this same question asked
      // again, without the answer that expired.
      return { kind: 'PROJECT_DECISION_STALE' };

    case 'SETTLED': {
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
