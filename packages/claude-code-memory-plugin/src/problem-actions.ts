/**
 * The three things somebody does once they know which Problem they mean.
 *
 * Each is the same shape: confirm the Project the caller was looking at is
 * still the Project this session is in, then hand the decision to the
 * composition that owns it. Neither half is repeated here — the Project check
 * is one call, the lifecycle rule is another, and this module is the order
 * between them.
 *
 * ## Why the Project is checked first, every time
 *
 * A caller decides "continue that Problem" while looking at an answer from an
 * earlier turn. Between then and now the session may have moved: a boundary
 * declared, a Project registered beside this one, a different checkout opened.
 * Acting on the Problem without re-checking the Project would carry out the
 * decision against a Project nobody chose — and the binding written afterwards
 * would make it durable.
 *
 * So a stale Project stops the call before a Problem is read, before an
 * Environment is captured, and before the binding store is touched at all.
 * Nothing is substituted: what is true now is a question with its own
 * operation, and this is not it.
 *
 * ## What comes back
 *
 * Identities, a status where one moved, and whether the local note survived.
 * A stale result says only that — the answer it was asked to act on no longer
 * holds. It carries no fresh resolution, because a caller that wants to know
 * what is true now asks the question rather than reading it out of a refusal.
 */

import type { MemoryApiClient, ProblemStatus } from '@ai-problem-solving-memory/api-client';
import {
  continueProblem,
  resumeProblem,
  startNewProblem,
  type DetectProjectSignalsInput,
  type ProblemBindingStore,
  type ProblemCandidate,
  type ProblemContinuity,
  type ResumeProblemTargetStatus,
  type RuntimeProvenance,
} from '@ai-problem-solving-memory/claude-code-adapter';

import { selectSuppliedProject } from './project-decision.js';

/** What every one of these needs before it may touch a Problem. */
interface ProblemActionContext {
  readonly client: MemoryApiClient;
  readonly bindingStore: ProblemBindingStore;
  readonly sessionId: string;
  readonly projectDir: string;
  readonly projectId: string;
  readonly runtimeProvenance?: RuntimeProvenance;
  /** How git is invoked while detecting. Production omits it. */
  readonly runGit?: DetectProjectSignalsInput['runGit'];
}

/** The refusal every one of these shares. */
type ProjectStale = { readonly kind: 'PROJECT_SELECTION_STALE' };

/** The refusal the two that act on an existing Problem share. */
type ProblemStale = { readonly kind: 'PROBLEM_SELECTION_STALE' };

export type ContinueProblemOutcome =
  | {
      readonly kind: 'CONTINUED';
      readonly projectId: string;
      readonly problemId: string;
      readonly continuity: ProblemContinuity;
    }
  | ProjectStale
  | ProblemStale;

export type ResumeProblemOutcome =
  | {
      readonly kind: 'RESUMED';
      readonly projectId: string;
      readonly problemId: string;
      readonly status: ResumeProblemTargetStatus;
      readonly continuity: ProblemContinuity;
    }
  | ProjectStale
  | ProblemStale;

export type StartProblemOutcome =
  | {
      readonly kind: 'STARTED';
      readonly projectId: string;
      readonly problemId: string;
      readonly status: ProblemStatus;
      readonly continuity: ProblemContinuity;
    }
  | {
      readonly kind: 'RECONSIDER';
      readonly reason: 'CANDIDATES_PRESENT' | 'CANDIDATES_CHANGED';
      readonly candidates: readonly ProblemCandidate[];
    }
  | ProjectStale;

/**
 * Confirms the supplied Project, or refuses.
 *
 * Shared so the ordering cannot differ between the three operations: a Project
 * that no longer holds must stop each of them at exactly the same point, which
 * is before anything about a Problem has been read.
 */
async function confirmProject(context: ProblemActionContext): Promise<string | undefined> {
  const selected = await selectSuppliedProject({
    client: context.client,
    projectDir: context.projectDir,
    projectId: context.projectId,
    ...(context.runGit === undefined ? {} : { runGit: context.runGit }),
  });

  return selected.kind === 'SELECTED' ? selected.projectId : undefined;
}

/** Carries on with a Problem somebody chose, if the choice still holds. */
export async function continueChosenProblem(
  context: ProblemActionContext & { readonly problemId: string },
): Promise<ContinueProblemOutcome> {
  const projectId = await confirmProject(context);
  if (projectId === undefined) {
    return { kind: 'PROJECT_SELECTION_STALE' };
  }

  const outcome = await continueProblem(
    context.client,
    context.bindingStore,
    context.sessionId,
    projectId,
    context.problemId,
  );

  return outcome.kind === 'CONTINUED'
    ? {
        kind: 'CONTINUED',
        projectId,
        problemId: outcome.problemId,
        continuity: outcome.continuity,
      }
    : { kind: 'PROBLEM_SELECTION_STALE' };
}

/** Brings a paused Problem back into work, if it is still paused and still here. */
export async function resumePausedProblem(
  context: ProblemActionContext & {
    readonly problemId: string;
    readonly targetStatus: ResumeProblemTargetStatus;
  },
): Promise<ResumeProblemOutcome> {
  const projectId = await confirmProject(context);
  if (projectId === undefined) {
    return { kind: 'PROJECT_SELECTION_STALE' };
  }

  const outcome = await resumeProblem(
    context.client,
    context.bindingStore,
    context.sessionId,
    projectId,
    context.problemId,
    context.targetStatus,
    context.runtimeProvenance,
  );

  return outcome.kind === 'RESUMED'
    ? {
        kind: 'RESUMED',
        projectId,
        problemId: outcome.problemId,
        status: outcome.status,
        continuity: outcome.continuity,
      }
    : { kind: 'PROBLEM_SELECTION_STALE' };
}

/** Starts a new Problem, if the decision that it is new still stands. */
export async function startFreshProblem(
  context: ProblemActionContext & {
    readonly title: string;
    readonly symptoms: string;
    readonly problemDomain?: string | null | undefined;
    readonly suspectedBoundary?: string | null | undefined;
    readonly expectedCandidateProblemIds?: readonly string[] | undefined;
  },
): Promise<StartProblemOutcome> {
  const projectId = await confirmProject(context);
  if (projectId === undefined) {
    return { kind: 'PROJECT_SELECTION_STALE' };
  }

  const outcome = await startNewProblem(
    context.client,
    context.bindingStore,
    context.sessionId,
    {
      projectId,
      // The host's own root, never anything a caller said. Absent and null
      // stay apart for the two optional fields: one leaves the column alone
      // and the other states there is no answer.
      projectDir: context.projectDir,
      title: context.title,
      symptoms: context.symptoms,
      ...(context.problemDomain === undefined ? {} : { problemDomain: context.problemDomain }),
      ...(context.suspectedBoundary === undefined
        ? {}
        : { suspectedBoundary: context.suspectedBoundary }),
      ...(context.runGit === undefined ? {} : { runGit: context.runGit }),
    },
    // Passed through exactly as given, and never filled in here. What the
    // caller considered and what this program observed are different facts,
    // and the guard is only worth anything as the first one.
    context.expectedCandidateProblemIds,
    context.runtimeProvenance,
  );

  return outcome.kind === 'STARTED'
    ? {
        kind: 'STARTED',
        projectId,
        problemId: outcome.problemId,
        status: outcome.status,
        continuity: outcome.continuity,
      }
    : { kind: 'RECONSIDER', reason: outcome.reason, candidates: outcome.candidates };
}
