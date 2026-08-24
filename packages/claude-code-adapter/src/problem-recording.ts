/**
 * Recording evidence and concluding the Problem this session is actually on.
 *
 * These are deliberately compositions over existing Memory API operations,
 * not a second lifecycle. The host establishes a Project for this call, the
 * local binding contributes only a hint, and the server is read again before
 * every write. What the caller contributes is the evidence or conclusion;
 * which Problem receives it and which assistant recorded it are runtime facts.
 */

import type {
  AppendEventRequest,
  AppendVerificationRequest,
  CloseProblemTargetStatus,
  EventType,
  FixKind,
  MemoryApiClient,
  ProblemResource,
  VerificationType,
} from '@ai-problem-solving-memory/api-client';

import { detectProjectSignals, type DetectProjectSignalsInput } from './project-signals.js';
import { resolveProject } from './project-resolution.js';
import { isWorkingProblemStatus } from './problem-resolution.js';
import { resolveProblemForSession, type ProblemBindingWriter } from './problem-lifecycle.js';
import { CLAUDE_CODE_SOURCE_AI } from './source-ai.js';
import { MemoryApiError } from '@ai-problem-solving-memory/api-client';

/** The host facts and deterministic readers every current-Problem write needs. */
interface CurrentProblemWriteContext {
  readonly client: MemoryApiClient;
  readonly bindingStore: ProblemBindingWriter;
  readonly sessionId: string;
  readonly projectDir: string;
  /** How git is invoked while detecting. Production omits it. */
  readonly runGit?: DetectProjectSignalsInput['runGit'];
}

/** Ordinary semantic reasons no current Problem may be written. */
export type CurrentProblemWriteUnavailable =
  { readonly kind: 'NO_CURRENT_PROBLEM' } | { readonly kind: 'CURRENT_PROBLEM_NOT_AVAILABLE' };

interface CurrentWorkingProblem {
  readonly projectId: string;
  readonly problem: ProblemResource;
}

/**
 * Resolve the current working Problem and then read it one final time.
 *
 * Project resolution is read-only. A candidate — even one candidate — is not
 * selected, and a paused or terminal binding is not treated as current work.
 * Only a server `NOT_FOUND` is translated to a semantic absence; transport and
 * protocol failures still propagate, because silence is not evidence that the
 * Problem disappeared.
 */
async function currentWorkingProblem(
  input: CurrentProblemWriteContext,
): Promise<CurrentWorkingProblem | CurrentProblemWriteUnavailable> {
  const signals = await detectProjectSignals({
    projectDir: input.projectDir,
    ...(input.runGit === undefined ? {} : { runGit: input.runGit }),
  });
  const project = await resolveProject(input.client, signals);
  if (project.kind !== 'RESOLVED') {
    return { kind: 'NO_CURRENT_PROBLEM' };
  }

  const resolution = await resolveProblemForSession(
    input.client,
    input.bindingStore,
    input.sessionId,
    project.projectId,
  );
  if (resolution.kind !== 'RESOLVED') {
    return { kind: 'NO_CURRENT_PROBLEM' };
  }

  let problem: ProblemResource;
  try {
    problem = await input.client.getProblem(resolution.problemId);
  } catch (error) {
    if (isProblemNotFound(error)) {
      return { kind: 'CURRENT_PROBLEM_NOT_AVAILABLE' };
    }
    throw error;
  }

  if (problem.project_id !== project.projectId || !isWorkingProblemStatus(problem.status)) {
    return { kind: 'NO_CURRENT_PROBLEM' };
  }

  return { projectId: project.projectId, problem };
}

/** What the caller says happened. The subject and provenance are absent. */
export interface AddEventToCurrentProblemInput extends CurrentProblemWriteContext {
  readonly eventType: EventType;
  readonly summary: string;
  readonly clientEventId: string;
  readonly result?: string | null;
  readonly reason?: string | null;
  readonly evidenceRef?: string | null;
}

export type AddEventToCurrentProblemOutcome =
  | {
      /** A record now exists for this logical append; it may be a replay. */
      readonly kind: 'EVENT_RECORDED';
      readonly problemId: string;
      readonly eventId: string;
      readonly clientEventId: string;
      /** False means the owner-wide key had already been used on another Problem. */
      readonly onCurrentProblem: boolean;
    }
  | CurrentProblemWriteUnavailable;

/** Append one typed Event, at most one HTTP request. */
export async function addEventToCurrentProblem(
  input: AddEventToCurrentProblemInput,
): Promise<AddEventToCurrentProblemOutcome> {
  const current = await currentWorkingProblem(input);
  if ('kind' in current) {
    return current;
  }

  const request: AppendEventRequest = {
    event_type: input.eventType,
    summary: input.summary,
    client_event_id: input.clientEventId,
    source_ai: CLAUDE_CODE_SOURCE_AI,
    ...('result' in input ? { result: input.result } : {}),
    ...('reason' in input ? { reason: input.reason } : {}),
    ...('evidenceRef' in input ? { evidence_ref: input.evidenceRef } : {}),
  };
  const event = await input.client.appendEvent(current.problem.problem_id, request);

  return {
    kind: 'EVENT_RECORDED',
    problemId: event.problem_id,
    eventId: event.event_id,
    clientEventId: event.client_event_id,
    onCurrentProblem: event.problem_id === current.problem.problem_id,
  };
}

/** What the caller says was checked. The subject and verifier are absent. */
export interface AddVerificationToCurrentProblemInput extends CurrentProblemWriteContext {
  readonly verificationType: VerificationType;
  readonly result: boolean;
  readonly summary: string;
  readonly clientEventId: string;
  readonly evidenceRef?: string | null;
}

export type AddVerificationToCurrentProblemOutcome =
  | {
      /** A record now exists for this logical append; it may be a replay. */
      readonly kind: 'VERIFICATION_RECORDED';
      readonly problemId: string;
      readonly verificationId: string;
      readonly clientEventId: string;
      /** False means the owner-wide key had already been used on another Problem. */
      readonly onCurrentProblem: boolean;
    }
  | CurrentProblemWriteUnavailable;

/** Append one typed Verification, at most one HTTP request. */
export async function addVerificationToCurrentProblem(
  input: AddVerificationToCurrentProblemInput,
): Promise<AddVerificationToCurrentProblemOutcome> {
  const current = await currentWorkingProblem(input);
  if ('kind' in current) {
    return current;
  }

  const request: AppendVerificationRequest = {
    verification_type: input.verificationType,
    result: input.result,
    summary: input.summary,
    client_event_id: input.clientEventId,
    verified_by: CLAUDE_CODE_SOURCE_AI,
    ...('evidenceRef' in input ? { evidence_ref: input.evidenceRef } : {}),
  };
  const verification = await input.client.appendVerification(current.problem.problem_id, request);

  return {
    kind: 'VERIFICATION_RECORDED',
    problemId: verification.problem_id,
    verificationId: verification.verification_id,
    clientEventId: verification.client_event_id,
    onCurrentProblem: verification.problem_id === current.problem.problem_id,
  };
}

/** What the caller concludes. The subject, actor and concurrency token are absent. */
export interface CloseCurrentProblemInput extends CurrentProblemWriteContext {
  readonly targetStatus: CloseProblemTargetStatus;
  readonly fixKind?: FixKind | null;
  readonly finalCauseSummary?: string;
  readonly effectiveDirection?: string;
  readonly deadEndSummary?: string;
  readonly unresolvedPoints?: string;
}

export type CloseCurrentProblemOutcome =
  | {
      readonly kind: 'PROBLEM_CLOSED';
      readonly problemId: string;
      readonly status: CloseProblemTargetStatus;
      readonly version: number;
    }
  | CurrentProblemWriteUnavailable;

/** Conclude or pause the current Problem using the version from the final read. */
export async function closeCurrentProblem(
  input: CloseCurrentProblemInput,
): Promise<CloseCurrentProblemOutcome> {
  const current = await currentWorkingProblem(input);
  if ('kind' in current) {
    return current;
  }

  const problem = await input.client.closeProblem(current.problem.problem_id, {
    expected_version: current.problem.version,
    changed_by: CLAUDE_CODE_SOURCE_AI,
    target_status: input.targetStatus,
    ...('fixKind' in input ? { fix_kind: input.fixKind } : {}),
    ...('finalCauseSummary' in input ? { final_cause_summary: input.finalCauseSummary } : {}),
    ...('effectiveDirection' in input ? { effective_direction: input.effectiveDirection } : {}),
    ...('deadEndSummary' in input ? { dead_end_summary: input.deadEndSummary } : {}),
    ...('unresolvedPoints' in input ? { unresolved_points: input.unresolvedPoints } : {}),
  });

  return {
    kind: 'PROBLEM_CLOSED',
    problemId: problem.problem_id,
    status: problem.status as CloseProblemTargetStatus,
    version: problem.version,
  };
}

function isProblemNotFound(error: unknown): boolean {
  return error instanceof MemoryApiError && error.status === 404 && error.code === 'NOT_FOUND';
}
