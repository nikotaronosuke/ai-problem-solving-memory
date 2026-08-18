/**
 * Starting a Problem, once somebody has decided to.
 *
 * This is the mutation primitive and none of the judgement. Two decisions have
 * already been made by the time it runs, and neither of them is made here:
 * which Project this is, and that what is happening deserves a new Problem
 * rather than continuing an existing one. The second of those is the one the
 * specification describes in terms of independent cause, impact and resolution
 * — a reading of a situation, not a rule code can apply — and a primitive that
 * tried to check it would be guessing on the caller's behalf at the moment the
 * caller has the most context.
 *
 * What it does own is the order. An Environment is recorded first because a
 * Problem cannot exist without one, and a Problem that pointed at conditions
 * captured afterwards would describe the wrong moment.
 *
 * ## What happens when a call does not come back
 *
 * Nothing is retried. If creating the Problem is unanswered, the caller does
 * not know whether it committed, and this module cannot find out — a second
 * attempt would be as likely to create a duplicate as to recover. So the
 * failure travels unchanged, and whoever called is the one with a way to look:
 * they can list the Project's Problems and see. That is the same reasoning the
 * client applies to every write, kept intact one layer up.
 *
 * ## What is not here
 *
 * No Project detection or resolution, no candidate enumeration, no duplicate
 * check, no session identity, no binding, no user question, no Project
 * creation, no status transition, no cleanup of what a partial failure left.
 * Each belongs to the composition above this, and doing any of them here would
 * put a decision in the layer with the least context to make it.
 */

import type { MemoryApiClient, ProblemStatus } from '@ai-problem-solving-memory/api-client';

import { captureEnvironment, type CaptureEnvironmentInput } from './environment-capture.js';
import { CLAUDE_CODE_SOURCE_AI } from './source-ai.js';

/** Only the two writes this needs. Nothing here reads, lists or transitions. */
export type StartProblemClient = Pick<MemoryApiClient, 'createEnvironment' | 'createProblem'>;

export interface StartProblemInput {
  /** The Project this belongs to. Already resolved; not decided here. */
  readonly projectId: string;
  /** Where to read conditions from. Transient, and never recorded. */
  readonly projectDir: string;
  /** What the problem is called. The caller's words, unchanged. */
  readonly title: string;
  /** What was observed. The caller's words, unchanged. */
  readonly symptoms: string;
  /** Optional. Absent and `null` mean different things and both survive. */
  readonly problemDomain?: string | null;
  /** Optional, same rule. */
  readonly suspectedBoundary?: string | null;
  /** How git is invoked while capturing. Production omits it. */
  readonly runGit?: CaptureEnvironmentInput['runGit'];
}

/**
 * What was started.
 *
 * An identity and a state. Everything else the server said about the new
 * Problem — its owner, its Environment, its version, its timestamps, the
 * symptoms echoed back — is a `getProblem` away for anybody who needs it, and
 * a result that carried them by default would make every caller a place they
 * can leak from. The same rule the Project and Problem resolutions already
 * follow.
 */
export interface StartProblemResult {
  readonly problemId: string;
  readonly status: ProblemStatus;
}

/**
 * Records the conditions, then starts the Problem under them.
 *
 * Fails before touching the Memory if the directory cannot describe anywhere,
 * and stops at the first failure after that: a Problem is never created against
 * an Environment that was not recorded.
 */
export async function startProblem(
  client: StartProblemClient,
  input: StartProblemInput,
): Promise<StartProblemResult> {
  const snapshot = await captureEnvironment({
    projectDir: input.projectDir,
    ...(input.runGit === undefined ? {} : { runGit: input.runGit }),
  });

  const environment = await client.createEnvironment(input.projectId, { snapshot });

  const problem = await client.createProblem(input.projectId, {
    environment_id: environment.environment_id,
    title: input.title,
    symptoms: input.symptoms,
    // Absent stays absent, `null` stays null. Spreading the input would have
    // written `undefined` for a field nobody mentioned, which the request
    // contract refuses and which would have meant something different anyway.
    ...('problemDomain' in input ? { problem_domain: input.problemDomain } : {}),
    ...('suspectedBoundary' in input ? { suspected_boundary: input.suspectedBoundary } : {}),
    // This adapter's own name, never the caller's. `source_ai` is provenance —
    // which assistant recorded this — and a value the caller could set would be
    // a value worth setting wrongly.
    source_ai: CLAUDE_CODE_SOURCE_AI,
  });

  return { problemId: problem.problem_id, status: problem.status };
}
