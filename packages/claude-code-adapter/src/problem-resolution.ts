/**
 * Which Problem this session is working on — as far as that can be *known*.
 *
 * The distinction in that sentence is the whole design. "Which Problem is being
 * discussed right now" is a question about meaning: whether the thing on screen
 * is the same trouble as a record written last Tuesday, or a new one that
 * merely looks similar. Nothing here can answer that, and the failure mode of
 * pretending otherwise is quiet — a session silently attaching its work to the
 * wrong Problem, or starting a second one for something already open, and
 * either way the Memory ends up describing an investigation that never
 * happened that way.
 *
 * So this module answers a much smaller question, deterministically, and hands
 * the rest on as material:
 *
 * - `RESOLVED` — a decision that was already made, re-checked against the
 *   server and still true.
 * - `CANDIDATES` — Problems that could still be worked on. Which one, if any,
 *   the conversation is about is not decided here.
 * - `NONE` — there is nothing under this Project that could be continued.
 *
 * ## Why one candidate is still only a candidate
 *
 * The tempting shortcut is that a Project with exactly one open Problem must be
 * the one being worked on. It is wrong in the ordinary case, not an exotic one:
 * somebody with one open Problem starts a second, unrelated investigation, and
 * the shortcut files it under the first. The specification's own test for this
 * is whether an issue needs independent cause, impact and resolution — a
 * judgement about the situation, not a count of rows. So the count never
 * decides, and nothing here reads a title or symptoms to guess at similarity.
 *
 * ## Why the order the server sent is preserved and never used
 *
 * The list arrives in a deterministic order, and it is passed through in that
 * order because reordering it would be this module inventing a ranking. It is
 * also never *consulted*: "first" and "newest" are the two most natural ways to
 * turn a list into an answer, and both of them are the same mistake as the
 * count above, wearing a different hat.
 *
 * ## What is not here
 *
 * No session identity, and no storage. A binding hint arrives as an argument if
 * a caller has one; where it came from, how long it lives and what invalidates
 * it on disk belong to the task that keeps it. This module holds nothing
 * between calls, which is what lets it be tested with two fixtures and no
 * environment.
 */

import type {
  MemoryApiClient,
  ProblemResource,
  ProblemStatus,
} from '@ai-problem-solving-memory/api-client';
import { MemoryApiError } from '@ai-problem-solving-memory/api-client';

/**
 * What a Problem's state means to a session looking for the one it is on.
 *
 * Three meanings, and they are not the same question the status vocabulary
 * answers. `ProblemStatus` is the wire contract and stays the only authority on
 * which states exist; this is the policy layer on top of it, which is genuinely
 * this module's to own: whether a state is being worked in *now*, can be
 * returned to, or is finished is a judgement about resolving a current Problem
 * rather than a fact about the record.
 */
export type CurrentProblemStatusClass = 'WORKING' | 'PAUSED' | 'TERMINAL';

/**
 * Every status, classified.
 *
 * `Record<ProblemStatus, …>` is what makes this exhaustive rather than merely
 * valid, and the distinction is the whole point of writing it as a map. A list
 * of the states that happen to be continuable proves only that each name is a
 * real status; it says nothing about the ones left out. So a sixth status
 * arriving in the contract would leave such a list still compiling, still
 * passing, and quietly excluding that state from every candidate it should have
 * appeared in — the exact shape of drift that is invisible until somebody
 * notices their work is not being offered back to them.
 *
 * Written this way, a new status does not compile until somebody decides what
 * it means here. That decision is small; making it is the point.
 */
const CURRENT_PROBLEM_STATUS_CLASS = {
  INVESTIGATING: 'WORKING',
  FIX_CANDIDATE: 'WORKING',
  PAUSED: 'PAUSED',
  VERIFIED: 'TERMINAL',
  CLOSED_UNRESOLVED: 'TERMINAL',
} as const satisfies Record<ProblemStatus, CurrentProblemStatusClass>;

/** The statuses classified into one of the given meanings. */
type StatusesClassedAs<C extends CurrentProblemStatusClass> = {
  [S in ProblemStatus]: (typeof CURRENT_PROBLEM_STATUS_CLASS)[S] extends C ? S : never;
}[ProblemStatus];

/**
 * A state a Problem can still be continued from — worked in, or paused.
 *
 * Derived from the classification rather than listed beside it, so the two
 * cannot disagree.
 */
export type ContinuableProblemStatus = StatusesClassedAs<'WORKING' | 'PAUSED'>;

/**
 * Whether a Problem in this state could still be continued.
 *
 * A `switch` over the classification rather than a membership test, because it
 * makes the second dimension exhaustive too: the function is annotated to
 * return a boolean, so a class nobody handled leaves a path that falls off the
 * end and does not compile. Neither an unclassified status nor an unhandled
 * meaning can reach a silent default here, which is the failure this whole
 * section exists to make impossible.
 */
function isContinuable(status: ProblemStatus): status is ContinuableProblemStatus {
  switch (CURRENT_PROBLEM_STATUS_CLASS[status]) {
    case 'WORKING':
    case 'PAUSED':
      return true;
    case 'TERMINAL':
      return false;
  }
}

/**
 * Whether a Problem in this state is one being worked in right now.
 *
 * `PAUSED` is deliberately not. A paused Problem can be returned to, which is
 * not the same as being the one in progress: resuming it is a decision somebody
 * makes, and it changes the record's status when they do. Treating a binding to
 * a paused Problem as "currently working on it" would skip both the decision
 * and the transition, and the Memory would show a Problem that was never
 * resumed accumulating work.
 */
export function isWorkingProblemStatus(status: ProblemStatus): boolean {
  return CURRENT_PROBLEM_STATUS_CLASS[status] === 'WORKING';
}

/**
 * The continuable statuses, in the order the classification lists them.
 *
 * Filtered out of the classification rather than written again, for the same
 * reason the type is derived from it: a second list is a second thing to keep
 * in step. The assertion on `Object.keys` is sound by construction — the
 * `satisfies` above is what guarantees these keys are exactly the statuses.
 */
export const CONTINUABLE_PROBLEM_STATUSES: readonly ContinuableProblemStatus[] = (
  Object.keys(CURRENT_PROBLEM_STATUS_CLASS) as readonly ProblemStatus[]
).filter(isContinuable);

/**
 * A previously recorded answer to "which Problem is this session on".
 *
 * A hint and never an authority: it is checked against the server every time it
 * is used, and it is discarded the moment the server disagrees.
 *
 * It carries the Project it was recorded under, and that is not redundant. A
 * session identifier alone says nothing about which Project a session is in —
 * the same session can be resumed from somewhere else entirely — so a hint
 * without a Project would be a Problem id offered up wherever that session
 * happened to be reopened. Whoever stores these looks one up by session; what
 * they get back has to say which Project it was about.
 */
export interface ProblemBindingHint {
  readonly projectId: string;
  readonly problemId: string;
}

/**
 * One Problem that could be continued, with the least that identifies it.
 *
 * An identity, a state and a name. Enough for somebody — or something — to tell
 * these apart and decide, and no more: symptoms, environment, source, version
 * and timestamps are all a `getProblem` away for whoever actually needs them,
 * and a shape that carried them by default would make every consumer a place
 * they can leak from. The same reasoning that put a bare identity in a Project
 * resolution applies here one step further out.
 */
export interface ProblemCandidate {
  readonly problemId: string;
  readonly status: ContinuableProblemStatus;
  readonly title: string;
}

/**
 * What a Current Problem resolution concluded.
 *
 * `CANDIDATES` rather than `AMBIGUOUS`, and the difference is not cosmetic. An
 * ambiguous Project is deterministic evidence in conflict, and a person settles
 * it once. Candidate Problems are not in conflict at all: they are the
 * continuable work under this Project, and choosing among them is a reading of
 * what the conversation is about. Calling that "ambiguous" would suggest
 * something went wrong and somebody must be interrupted, when the ordinary
 * answer is that the material is now in front of the thing that can read it.
 */
export type CurrentProblemResolution =
  | { readonly kind: 'RESOLVED'; readonly problemId: string }
  | { readonly kind: 'NONE' }
  | { readonly kind: 'CANDIDATES'; readonly candidates: readonly ProblemCandidate[] };

/** Only the reads this needs. Nothing here creates, updates or transitions. */
export type CurrentProblemReader = Pick<MemoryApiClient, 'getProblem' | 'listProblems'>;

/**
 * Takes the narrowed status as an argument rather than re-reading it.
 *
 * The caller has already established that this status is continuable, and
 * passing the narrowed value through is what makes that provable here instead
 * of asserted with a cast. Three fields are copied out by name, so a field
 * added to the resource cannot arrive in a candidate by default.
 */
function toCandidate(problem: ProblemResource, status: ContinuableProblemStatus): ProblemCandidate {
  return {
    problemId: problem.problem_id,
    status,
    title: problem.title,
  };
}

/**
 * Whether a failure means the bound Problem is gone, as opposed to unavailable.
 *
 * Both halves are required. A `404` from something that is not this contract's
 * refusal — a proxy, a captive portal, a misconfigured base URL — is not the
 * server saying the Problem does not exist, and the status line alone cannot
 * tell those apart. The client already draws that boundary by raising a
 * different error for an answer it cannot read; this only refuses to widen it.
 *
 * Exported because a composition on top of this module has to draw the same
 * line — a bound Problem that is gone and a Memory that cannot be reached lead
 * somewhere different — and two copies of "what counts as gone" would be two
 * places to widen it by accident.
 */
export function isProblemGone(error: unknown): boolean {
  return error instanceof MemoryApiError && error.status === 404 && error.code === 'NOT_FOUND';
}

/**
 * Reads the bound Problem back and says whether it still resolves.
 *
 * Returns the identity when the hint holds up, and `undefined` when it does not
 * — where "does not" means the server answered and disagreed. Anything that is
 * not an answer leaves as the failure it was: a Memory that cannot be reached
 * has said nothing about this binding, and treating silence as "stale" would
 * quietly drop a valid continuation during an outage, which is the one moment
 * somebody most needs their work to stay attached to where it was.
 */
async function resolveBinding(
  client: CurrentProblemReader,
  projectId: string,
  binding: ProblemBindingHint,
): Promise<string | undefined> {
  // Checked before the call, so a hint recorded somewhere else costs no request
  // and — more to the point — never gets the chance to be revalidated against
  // the wrong Project and pass.
  if (binding.projectId !== projectId) {
    return undefined;
  }

  let problem: ProblemResource;
  try {
    problem = await client.getProblem(binding.problemId);
  } catch (error) {
    if (isProblemGone(error)) {
      return undefined;
    }
    throw error;
  }

  // The hint said which Project it was for and the record says which Project it
  // is in. Both are checked: the first is what the caller believed, the second
  // is what is true, and a hint that survived a Problem being moved would
  // otherwise resolve against a Project it no longer belongs to.
  if (problem.project_id !== projectId) {
    return undefined;
  }

  return isWorkingProblemStatus(problem.status) ? problem.problem_id : undefined;
}

/**
 * Resolves which Problem this session is on, or hands back what it could be.
 *
 * Takes the Project as an identity, not as a resolution. Deciding *which*
 * Project a session is in — and what to do when that is ambiguous, or the
 * Project is not registered, or there is no signal at all — is a settled
 * question with its own answers, and none of them is a Problem. A caller that
 * has not resolved a Project has nothing to ask this function.
 *
 * Nothing here retries, and no failure becomes an answer. `NONE` means the
 * server was asked and there is nothing to continue; it never means the server
 * could not be asked.
 */
export async function resolveCurrentProblem(
  client: CurrentProblemReader,
  projectId: string,
  binding?: ProblemBindingHint,
): Promise<CurrentProblemResolution> {
  if (binding !== undefined) {
    const problemId = await resolveBinding(client, projectId, binding);
    if (problemId !== undefined) {
      return { kind: 'RESOLVED', problemId };
    }
  }

  const problems = await client.listProblems(projectId);
  // `flatMap` rather than filter-then-map so the guard's narrowing survives to
  // the construction. Order is the server's throughout: nothing is sorted here,
  // and nothing reads the order either.
  const candidates = problems.flatMap((problem) =>
    isContinuable(problem.status) ? [toCandidate(problem, problem.status)] : [],
  );

  return candidates.length === 0 ? { kind: 'NONE' } : { kind: 'CANDIDATES', candidates };
}
