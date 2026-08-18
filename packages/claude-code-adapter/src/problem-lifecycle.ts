/**
 * Entering a Problem: continuing one, resuming one, or starting a new one.
 *
 * The pieces this composes each answer one question and refuse the next. The
 * resolver says which Problem a session is on, or which ones it could be, and
 * decides nothing. The binding store keeps a note across turns and knows
 * nothing about Problems. The start primitive records conditions and creates a
 * Problem, and never asks whether it should. This module is where those become
 * the three things somebody actually does — and it is the only one of them that
 * holds a policy.
 *
 * ## Which Problem is being discussed is not decided here either
 *
 * Nothing below reads a title, compares symptoms, counts candidates or picks a
 * newest. Those are readings of what a conversation is about, and every one of
 * them is the same mistake: an assistant filing this week's trouble under last
 * week's record, invisibly. What this module owns is narrower and mechanical —
 * given that somebody has made that judgement, is it still safe to act on?
 *
 * ## Every decision is rechecked against the server before it is acted on
 *
 * A judgement is made at one moment and acted on at another, and Problems
 * appear, pause and close in between. So a chosen Problem is revalidated
 * through the resolver before anything is bound to it, a paused Problem is
 * re-read before it is transitioned, and — the one that is easy to get wrong —
 * a decision that something is *new* is rechecked by enumerating every
 * continuable Problem, not by consulting this session's own binding.
 *
 * ## The local note is a hint and never a fact
 *
 * A binding that cannot be read is not evidence that there is no Problem. It is
 * the absence of a shortcut, and the server is asked either way. Nothing here
 * deletes one: a stale hint is revalidated and discarded per call, and a later
 * write replaces it.
 *
 * ## What a failed note does not undo
 *
 * A Problem that was resumed on the server was resumed. If writing the local
 * note then fails, the answer says so — `NOT_PERSISTED` — and the server action
 * is neither repeated nor reported as failed. Telling somebody their resume
 * failed because a file could not be written would be false, and doing it again
 * would move a Problem twice.
 */

import type {
  MemoryApiClient,
  ProblemResource,
  ProblemStatus,
} from '@ai-problem-solving-memory/api-client';

import type { ProblemBindingStore } from './problem-binding-store.js';
import {
  isProblemGone,
  resolveCurrentProblem,
  type CurrentProblemReader,
  type CurrentProblemResolution,
  type ProblemCandidate,
} from './problem-resolution.js';
import { startProblem, type StartProblemInput } from './problem-start.js';
import { CLAUDE_CODE_SOURCE_AI } from './source-ai.js';

/**
 * The store, minus the one method this module must not call.
 *
 * `removeBinding` is absent by construction rather than by convention. Tidying
 * away a hint the server disagreed with looks like hygiene and is not: the
 * resolver already revalidates every hint and falls back, so a stale one costs
 * a single read and is replaced by the next write. Deleting it would only add a
 * way for a working session to lose its place because a Memory was briefly
 * unreachable.
 */
export type ProblemBindingWriter = Pick<ProblemBindingStore, 'readBinding' | 'writeBinding'>;

/** Reads, plus the one transition a resume performs. */
export type ResumeProblemClient = CurrentProblemReader &
  Pick<MemoryApiClient, 'transitionProblemStatus'>;

/** Reads, plus the two writes starting a Problem performs. */
export type StartNewProblemClient = CurrentProblemReader &
  Pick<MemoryApiClient, 'createEnvironment' | 'createProblem'>;

/**
 * Whether the local note survived.
 *
 * Two words, because there are two states worth telling apart and no more. It
 * says nothing about *why* — a path, an error code and a filesystem message are
 * all things a caller cannot act on and would print somewhere.
 */
export type ProblemContinuity = 'PERSISTED' | 'NOT_PERSISTED';

/**
 * The statuses a paused Problem may be resumed into.
 *
 * A subset on purpose, and deliberately not another authority on what a status
 * is. These two are the states somebody is *working in*; the rest are either
 * where the Problem already is or where it ends up when the work is over, and
 * none of them is a resume. `satisfies` proves each name is real without
 * claiming the list is exhaustive of anything, because it is not meant to be.
 *
 * Which transitions are actually legal remains the server's, checked against
 * the record. This narrows what this adapter will ask for; it does not restate
 * the rule.
 */
export const RESUME_PROBLEM_TARGET_STATUSES = [
  'INVESTIGATING',
  'FIX_CANDIDATE',
] as const satisfies readonly ProblemStatus[];

export type ResumeProblemTargetStatus = (typeof RESUME_PROBLEM_TARGET_STATUSES)[number];

/** What continuing an already-working Problem concluded. */
export type ProblemSelectionResult =
  | {
      readonly kind: 'CONTINUED';
      readonly problemId: string;
      readonly continuity: ProblemContinuity;
    }
  | { readonly kind: 'SELECTION_STALE'; readonly resolution: CurrentProblemResolution };

/** What resuming a paused Problem concluded. */
export type ResumeProblemResult =
  | {
      readonly kind: 'RESUMED';
      readonly problemId: string;
      readonly status: ResumeProblemTargetStatus;
      readonly continuity: ProblemContinuity;
    }
  | { readonly kind: 'SELECTION_STALE'; readonly resolution: CurrentProblemResolution };

/** Why a decision to start something new needs making again. */
export type ReconsiderReason = 'CANDIDATES_PRESENT' | 'CANDIDATES_CHANGED';

/** What starting a new Problem concluded. */
export type StartNewProblemResult =
  | {
      readonly kind: 'STARTED';
      readonly problemId: string;
      readonly status: ProblemStatus;
      readonly continuity: ProblemContinuity;
    }
  | {
      readonly kind: 'RECONSIDER';
      readonly reason: ReconsiderReason;
      readonly candidates: readonly ProblemCandidate[];
    };

/**
 * Raised when the world is in a state that cannot happen.
 *
 * Not a condition to handle and not something to retry. Both cases it covers
 * mean this module and the server disagree about something basic, and carrying
 * on would attach a session's work to a Problem on that disagreement. It
 * carries no id, no path and no response — there is nothing in the situation a
 * caller could act on, and the parts that would identify it are somebody's.
 */
export class ProblemLifecycleInvariantError extends Error {
  constructor() {
    super('The Memory answered with a Problem this session cannot act on.');
    this.name = 'ProblemLifecycleInvariantError';
  }
}

/**
 * Proves the binding key could be used, before anything irreversible happens.
 *
 * A read, for its argument checking rather than its answer. The store owns what
 * a usable session and Project identity is, and asking it here means an
 * unusable one stops the call *before* a Problem is created or moved — rather
 * than after, as an exception thrown at the moment of writing a note, with the
 * server already changed and the caller holding neither a result nor a way to
 * find out what happened.
 *
 * Restating the store's rule instead would be a second copy of a syntax the
 * host owns, wrong the first time either end changed.
 *
 * Every ordinary outcome passes, including the ones that mean the local state
 * is unusable: those are answers about a note, not about the identities.
 */
async function requireUsableBindingKey(
  store: ProblemBindingWriter,
  sessionId: string,
  projectId: string,
): Promise<void> {
  await store.readBinding(sessionId, projectId);
}

/**
 * Records the note, and says whether it survived.
 *
 * A `switch` rather than a comparison, so a third write outcome added later
 * does not silently fall into one of these two.
 */
async function bind(
  store: ProblemBindingWriter,
  sessionId: string,
  projectId: string,
  problemId: string,
): Promise<ProblemContinuity> {
  const written = await store.writeBinding(sessionId, projectId, problemId);
  switch (written.kind) {
    case 'WRITTEN':
      return 'PERSISTED';
    case 'IO_FAILURE':
      return 'NOT_PERSISTED';
  }
}

/**
 * Which Problem this session is on, with the local note used only as a hint.
 *
 * The four things a read can say collapse to two questions here: is there a
 * usable hint, and what does the server say. Only `VALID` produces a hint;
 * `MISSING`, `UNREADABLE` and a filesystem failure all mean the same thing to
 * this composition — no shortcut — and the server is enumerated in every one of
 * them.
 *
 * That is a policy about what to do, not a claim that those three are the same.
 * The store keeps them apart because they are different facts about a file, and
 * whoever needs to act on the difference has it.
 *
 * The one thing none of them may become is `NONE`. That answer means the server
 * was asked and there is nothing to continue; letting a local failure produce it
 * would tell a session its work does not exist because a file could not be read,
 * and the next thing that happens is a second Problem for the same trouble.
 */
export async function resolveProblemForSession(
  client: CurrentProblemReader,
  store: ProblemBindingWriter,
  sessionId: string,
  projectId: string,
): Promise<CurrentProblemResolution> {
  const read = await store.readBinding(sessionId, projectId);

  return read.kind === 'VALID'
    ? resolveCurrentProblem(client, projectId, read.binding)
    : resolveCurrentProblem(client, projectId);
}

/**
 * Accepts somebody's choice of the Problem to carry on with, if it still holds.
 *
 * The choice is revalidated by handing it to the resolver as a binding hint,
 * which is the same path a remembered choice takes. That is deliberate reuse
 * rather than convenience: "this Problem is one this session can be working on"
 * is a rule with one definition, and a second check written here would be a
 * second opinion that drifts. Everything that should stop a continuation —
 * paused, verified, closed, belonging to another Project, deleted since — is
 * already what that rule refuses, so none of them is a case here.
 *
 * Nothing is written until the server has agreed. A note recorded first and
 * corrected afterwards is a note that is wrong in between, and in between is
 * exactly when the next turn reads it.
 */
export async function continueProblem(
  client: CurrentProblemReader,
  store: ProblemBindingWriter,
  sessionId: string,
  projectId: string,
  problemId: string,
): Promise<ProblemSelectionResult> {
  const fresh = await resolveCurrentProblem(client, projectId, { projectId, problemId });

  if (fresh.kind !== 'RESOLVED' || fresh.problemId !== problemId) {
    return { kind: 'SELECTION_STALE', resolution: fresh };
  }

  return {
    kind: 'CONTINUED',
    problemId,
    continuity: await bind(store, sessionId, projectId, problemId),
  };
}

/**
 * Brings a paused Problem back into work.
 *
 * The Problem is read again immediately before the transition, and the version
 * that goes with the request is the one that read returned. A version the
 * caller supplied would be from whenever the caller last looked, which is the
 * definition of the state this concurrency token exists to catch.
 *
 * `changed_by` is this adapter's own name and is not an argument. It records
 * which assistant moved the Problem, and a value a caller could set would say
 * what that caller wished to be recorded as.
 *
 * A `409` is not handled here, and that is the handling. It means somebody else
 * wrote to this Problem between the read and the transition, so the answer to
 * "should this be resumed" was decided against a record that no longer exists.
 * Re-reading and trying again would be this module making that decision on
 * somebody's behalf; the failure travels, and whoever asked can ask again about
 * what is true now.
 *
 * An unreachable transition travels for a different reason: nobody knows
 * whether it committed. Turning that into a stale selection would state that it
 * did not.
 */
export async function resumeProblem(
  client: ResumeProblemClient,
  store: ProblemBindingWriter,
  sessionId: string,
  projectId: string,
  problemId: string,
  targetStatus: ResumeProblemTargetStatus,
): Promise<ResumeProblemResult> {
  await requireUsableBindingKey(store, sessionId, projectId);

  let problem: ProblemResource;
  try {
    problem = await client.getProblem(problemId);
  } catch (error) {
    if (isProblemGone(error)) {
      return {
        kind: 'SELECTION_STALE',
        resolution: await resolveCurrentProblem(client, projectId),
      };
    }
    throw error;
  }

  // Both, and re-read rather than taken on trust. A Problem that is already
  // being worked in has nothing to resume, a finished one is not coming back
  // this way, and one that belongs to another Project was never this session's
  // to move.
  if (problem.project_id !== projectId || problem.status !== 'PAUSED') {
    return { kind: 'SELECTION_STALE', resolution: await resolveCurrentProblem(client, projectId) };
  }

  const transitioned = await client.transitionProblemStatus(problemId, {
    target_status: targetStatus,
    expected_version: problem.version,
    changed_by: CLAUDE_CODE_SOURCE_AI,
  });

  // The client already checked that this is the Problem asked about and that it
  // is in the status asked for. The Project is this composition's to check,
  // because only here is there a Project the answer has to belong to — and
  // binding a session to a Problem in a different one is the quiet version of
  // working in the wrong place.
  if (transitioned.project_id !== projectId) {
    throw new ProblemLifecycleInvariantError();
  }

  return {
    kind: 'RESUMED',
    problemId,
    status: targetStatus,
    continuity: await bind(store, sessionId, projectId, problemId),
  };
}

/**
 * Whether two sets of Problem identities are the same set.
 *
 * Order is not compared, because the resolver's order is the server's and means
 * nothing here. Length is compared first and duplicates are refused outright,
 * so `['a', 'a']` is not the same claim as `['a']` — otherwise a caller could
 * satisfy this guard while having considered fewer Problems than exist.
 *
 * Neither list is sorted or copied out. What is passed in is somebody's record
 * of what they considered, and what comes back to them stays in the order the
 * server sent.
 */
function sameProblemIdentities(expected: readonly string[], fresh: readonly string[]): boolean {
  if (expected.length !== fresh.length) {
    return false;
  }

  const expectedIdentities = new Set(expected);
  if (expectedIdentities.size !== expected.length) {
    return false;
  }

  const freshIdentities = new Set(fresh);
  return (
    freshIdentities.size === expectedIdentities.size &&
    [...expectedIdentities].every((identity) => freshIdentities.has(identity))
  );
}

/**
 * Starts a Problem, once it is clear the decision to start one still stands.
 *
 * ## Why the recheck must ignore this session's binding
 *
 * This is the part that is easy to write wrongly and hard to notice. Resolving
 * with a binding hint short-circuits: a session already working on a Problem
 * gets `RESOLVED` back immediately, and the list of everything else continuable
 * is never built. For "which Problem am I on" that is exactly right and is the
 * point of the hint. For "is my judgement that this is a *new* Problem still
 * safe to act on" it is precisely wrong — the Problem that would change that
 * judgement is some *other* Problem, and the shortcut is what stops it being
 * seen. So the recheck resolves with no hint, every time.
 *
 * Without a hint the resolver can only answer `NONE` or `CANDIDATES`. A
 * `RESOLVED` would mean it resolved something out of nothing, which is not a
 * situation to guess through.
 *
 * ## What the expected set is, and is not
 *
 * A record of which continuable Problems the caller had in front of it when it
 * judged this to be something new. If continuable Problems exist and no such
 * record was offered, the judgement was made without them and is returned for
 * reconsideration — including when there is exactly one, because one Problem is
 * still a Problem somebody has to have looked at.
 *
 * Identities are compared and nothing else. The race worth catching is a
 * continuable Problem appearing or disappearing while somebody was deciding; the
 * same Problem being paused, resumed or retitled meanwhile is not a different
 * Problem, and demanding that its status match too would send people back to
 * reconsider things that had not changed.
 *
 * It is not a token, not a secret and not a hash. It is the material somebody
 * already saw, handed back to say what they saw.
 *
 * ## What is deliberately still possible
 *
 * Two sessions can each recheck, each see the same set, and each start a
 * Problem for the same trouble. Closing that would take a same-Problem key, and
 * there is none: a title is not one, symptoms are not one, and inventing either
 * would merge genuinely different investigations that happened to be described
 * alike. This guard removes stale-decision duplicates, which are the preventable
 * kind, and the simultaneous case is left visible rather than papered over.
 */
export async function startNewProblem(
  client: StartNewProblemClient,
  store: ProblemBindingWriter,
  sessionId: string,
  input: StartProblemInput,
  expectedCandidateProblemIds?: readonly string[],
): Promise<StartNewProblemResult> {
  await requireUsableBindingKey(store, sessionId, input.projectId);

  const fresh = await resolveCurrentProblem(client, input.projectId);

  if (fresh.kind === 'RESOLVED') {
    throw new ProblemLifecycleInvariantError();
  }

  const candidates = fresh.kind === 'CANDIDATES' ? fresh.candidates : [];

  if (candidates.length === 0) {
    // Nothing to consider now. A caller that arrived expecting something did
    // its thinking against a Problem that has since gone.
    if (expectedCandidateProblemIds !== undefined && expectedCandidateProblemIds.length > 0) {
      return { kind: 'RECONSIDER', reason: 'CANDIDATES_CHANGED', candidates };
    }
  } else if (expectedCandidateProblemIds === undefined) {
    return { kind: 'RECONSIDER', reason: 'CANDIDATES_PRESENT', candidates };
  } else if (
    !sameProblemIdentities(
      expectedCandidateProblemIds,
      candidates.map((candidate) => candidate.problemId),
    )
  ) {
    return { kind: 'RECONSIDER', reason: 'CANDIDATES_CHANGED', candidates };
  }

  // The existing primitive, not a second copy of it. It records the conditions
  // before creating anything and stops at the first failure, and an unanswered
  // create travels unchanged — there is no fact that would prove which of the
  // Problems now under this Project was the one this call may have made.
  const started = await startProblem(client, input);

  return {
    kind: 'STARTED',
    problemId: started.problemId,
    status: started.status,
    continuity: await bind(store, sessionId, input.projectId, started.problemId),
  };
}
