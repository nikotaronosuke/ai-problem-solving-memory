/**
 * Concluding a Problem, and writing down what was learned.
 *
 * One act rather than several: the status settles, the fix kind is recorded
 * if there is one to record, and whatever the person wants to leave for the
 * next reader becomes Events. All of it commits together or none of it does —
 * a Problem marked verified with the account of why it was verified missing is
 * the worst of the possible outcomes, and so is an account of a conclusion
 * that never happened.
 *
 * The rules are not re-decided here. Which moves are legal is the domain
 * matrix's, and `VERIFIED` still requires a successful Verification of this
 * Problem's own — closing is a place to record a conclusion, not a way around
 * having earned it. The ordinary transition route stays available for moving
 * between working states; this is the higher-level surface for ending.
 *
 * Only three targets. `VERIFIED`, `CLOSED_UNRESOLVED` and `PAUSED` are the
 * ways a Problem stops being actively worked; `INVESTIGATING` and
 * `FIX_CANDIDATE` are working states and belong to the transition route.
 *
 * Nothing is inferred. A conclusion does not raise confidence, refresh
 * freshness, touch the memory controls, create a Verification to justify
 * itself, or decide a fix kind from the status — verified says the fix holds,
 * not whether it addressed the cause.
 */

import {
  InvalidApplicationInputError,
  ProblemVersionConflictError,
  ResourceNotFoundError,
} from './errors.js';
import { describeProblemChanges } from './problem-changes.js';
import type { AuthenticatedRequestContext } from './request-context.js';
import {
  requestGenerationQuietly,
  type RetrievalArtifactMaintenance,
} from './retrieval-artifact-maintenance.js';
import { generateClientEventId, type ClientEventId } from '../domain/client-event-id.js';
import type { EventType, FixKind, ProblemStatus } from '../domain/enums.js';
import { toProblemId, type ProblemId } from '../domain/problem.js';
import {
  decideTransition,
  isConclusionProblemStatus,
  requiresSuccessfulVerification,
} from '../domain/problem-status.js';
import type { MemoryRepository, ProblemRecord } from '../repository/index.js';

export interface CloseProblemCommand {
  readonly expectedVersion: number;
  readonly changedBy: string;
  readonly targetStatus: ProblemStatus;
  /**
   * How the fix related to the cause, when that is being recorded.
   *
   * Absent leaves whatever is there; `null` clears it. A separate axis from
   * status: a Problem can be verified with no fix kind stated, and a
   * workaround can be recorded on one that was only set aside.
   */
  readonly fixKind?: FixKind | null;
  /** What turned out to be the cause. */
  readonly finalCauseSummary?: string;
  /** What actually worked. */
  readonly effectiveDirection?: string;
  /** What was tried and did not work. */
  readonly deadEndSummary?: string;
  /** What is still open. */
  readonly unresolvedPoints?: string;
}

export interface ProblemCloseService {
  closeProblem(
    context: AuthenticatedRequestContext,
    problemId: string,
    command: CloseProblemCommand,
  ): Promise<ProblemRecord>;
}

/**
 * Where each part of a review is recorded.
 *
 * The existing Event vocabulary, not a new one. A review is a set of ordinary
 * statements about the investigation, and giving them their own types — or
 * their own table — would leave the same information in two places with two
 * ways of reading it.
 *
 * `unresolvedPoints` becomes a `HYPOTHESIS` because that is what an open
 * question is: something believed to matter and not yet settled. Recording it
 * as a `DISCOVERY` would file an unknown as a fact, which is the one mistake
 * this record exists to avoid.
 */
const REVIEW_EVENTS = [
  { field: 'finalCauseSummary', eventType: 'DISCOVERY' },
  { field: 'effectiveDirection', eventType: 'FIX' },
  { field: 'deadEndSummary', eventType: 'DEAD_END' },
  { field: 'unresolvedPoints', eventType: 'HYPOTHESIS' },
] as const satisfies readonly {
  field: keyof CloseProblemCommand;
  eventType: EventType;
}[];

interface ReviewEventWrite {
  readonly eventType: EventType;
  readonly summary: string;
  readonly clientEventId: ClientEventId;
}

/**
 * Converts a path identifier, treating a malformed one as absent.
 *
 * Transport validates the format first; this is the backstop for any other
 * caller.
 */
function asProblemId(value: string): ProblemId {
  try {
    return toProblemId(value);
  } catch {
    throw new ResourceNotFoundError();
  }
}

export function createProblemCloseService(
  retrievalMaintenance?: RetrievalArtifactMaintenance,
): ProblemCloseService {
  return {
    async closeProblem(context, problemId, command) {
      const target = asProblemId(problemId);

      if (!isConclusionProblemStatus(command.targetStatus)) {
        // Working states are the transition route's. Accepting them here
        // would make two surfaces that do the same thing differently.
        throw new InvalidApplicationInputError('That status is not a conclusion.');
      }

      // Minted per request rather than asked of the caller. A close is
      // already protected as a whole by `expected_version` — resending it
      // conflicts rather than duplicating — so a client event id per summary
      // would be four extra things to get right for no additional guarantee.
      const reviewWrites: ReviewEventWrite[] = REVIEW_EVENTS.flatMap((entry) => {
        const summary = command[entry.field];
        return typeof summary === 'string'
          ? [{ eventType: entry.eventType, summary, clientEventId: generateClientEventId() }]
          : [];
      });

      const concluded = await context.runInTransaction(async (repository) => {
        const current = await repository.getProblem(target);
        if (current === undefined) {
          // Unknown and another owner's are one answer, and it comes first: a
          // conflict raised for someone else's problem would confirm it
          // exists.
          throw new ResourceNotFoundError();
        }
        if (current.version !== command.expectedVersion) {
          // Before the rule, as in the transition service. A caller working
          // from a stale read has a stale idea of the status too.
          throw new ProblemVersionConflictError();
        }

        const hasSuccessfulVerification = requiresSuccessfulVerification(command.targetStatus)
          ? (await repository.listVerifications(target)).some((verification) => verification.result)
          : false;

        const decision = decideTransition({
          currentStatus: current.status,
          targetStatus: command.targetStatus,
          hasSuccessfulVerification,
        });
        if (!decision.allowed) {
          // The same matrix and the same evidence gate as the transition
          // route. Throwing rolls the transaction back, so a refused close
          // leaves no events behind.
          throw new InvalidApplicationInputError(decision.reason);
        }

        // Absent means "leave it", which is not the same as `null`.
        const fixKind = command.fixKind !== undefined ? command.fixKind : current.fixKind;

        const updated = await repository.updateProblemConclusion(target, command.expectedVersion, {
          status: command.targetStatus,
          fixKind,
        });
        if (updated === undefined) {
          // The version matched when it was read, so another writer landed in
          // between.
          throw new ProblemVersionConflictError();
        }

        await appendReviewEvents(repository, target, command.changedBy, reviewWrites);

        // Status always; fix kind only when the caller said something about
        // it, so an unchanged field is not reported as a change. The summaries
        // are not recorded here — the Events are where that text lives, and
        // copying it would put free text somewhere it cannot later be removed
        // from.
        await repository.createChangeLog({
          problemId: target,
          changedBy: command.changedBy,
          fromVersion: current.version,
          toVersion: updated.version,
          changes: describeProblemChanges(current, updated, [
            'status',
            ...(command.fixKind !== undefined ? ['fix_kind'] : []),
          ]),
        });

        return updated;
      });

      // After the conclusion has committed. Status, fix kind and the review
      // Events are all canonical source, and their transaction took the old
      // artifact with it; a refused or conflicted close threw before here.
      requestGenerationQuietly(retrievalMaintenance, context, target);

      return concluded;
    },
  };
}

/**
 * Writes the review down as Events.
 *
 * `changed_by` becomes the Event's `source_ai`: whoever concluded the Problem
 * is who recorded these. The rest of an Event is left alone — a review
 * summary is an account, not a result or a reference to evidence.
 *
 * They are written in reading order but do not come back in it: one
 * transaction gives them one `created_at`, and the Event list breaks that tie
 * on the identifier. That is truthful — the four statements were made at the
 * same moment — and costs nothing, since each carries its own type and a
 * reader never needs their order to tell them apart.
 */
async function appendReviewEvents(
  repository: MemoryRepository,
  problemId: ProblemId,
  changedBy: string,
  writes: readonly ReviewEventWrite[],
): Promise<void> {
  for (const write of writes) {
    await repository.appendEvent({
      problemId,
      eventType: write.eventType,
      summary: write.summary,
      sourceAi: changedBy,
      clientEventId: write.clientEventId,
    });
  }
}
