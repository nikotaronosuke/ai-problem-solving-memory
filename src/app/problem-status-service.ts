/**
 * Moving a Problem from one status to another.
 *
 * A service of its own rather than part of the Problem service, because this
 * is the only way a status changes. `updateProblem` cannot set one — its input
 * has no status field, and neither does the PATCH schema — so the transition
 * rules are not something a caller can route around by assigning a field.
 *
 * What happens here is orchestration only. Which moves are legal is the domain
 * rule's to decide; this establishes the facts that rule needs — the Problem's
 * current status, and whether a successful Verification exists for it — and
 * turns a refusal into the error transport understands.
 *
 * The evidence question is the substance. `VERIFIED` requires at least one
 * Verification on *this* Problem whose boolean `result` is true. Nothing else
 * counts: not a FIX Event, not a summary that reads conclusively, not the
 * confidence level, not another Problem's evidence. The whole reason a
 * Verification is a separate entity with a boolean outcome is so that this
 * check can be made mechanically rather than by reading prose.
 *
 * Since P2-07 the caller also says which version it is acting on, and the
 * write is a compare-and-swap on that version. Two callers transitioning the
 * same Problem at once no longer both succeed: one wins and the other is told
 * to look again. The same version guards the ordinary Problem update, so an
 * edit and a transition can conflict with each other rather than each holding
 * a lock the other cannot see.
 *
 * The version is checked before the rule is applied, not after. A caller
 * working from a stale read has a stale idea of the current status too, so
 * judging its request against the status it has not seen would answer a
 * question it did not ask — sometimes allowing a move it would not have
 * requested had it known.
 */

import {
  InvalidApplicationInputError,
  ProblemVersionConflictError,
  ResourceNotFoundError,
} from './errors.js';
import type { AuthenticatedRequestContext } from './request-context.js';
import type { ProblemStatus } from '../domain/enums.js';
import { decideTransition, requiresSuccessfulVerification } from '../domain/problem-status.js';
import { toProblemId, type ProblemId } from '../domain/problem.js';
import type { ProblemRecord } from '../repository/index.js';

export interface TransitionCommand {
  readonly targetStatus: ProblemStatus;
  /** The version the caller last read. Required, as for any Problem write. */
  readonly expectedVersion: number;
}

export interface ProblemStatusService {
  transition(
    context: AuthenticatedRequestContext,
    problemId: string,
    command: TransitionCommand,
  ): Promise<ProblemRecord>;
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

export function createProblemStatusService(): ProblemStatusService {
  return {
    async transition(context, problemId, command) {
      const { targetStatus, expectedVersion } = command;
      const target = asProblemId(problemId);

      const problem = await context.repository.getProblem(target);
      if (problem === undefined) {
        // Unknown and another owner's are the same answer, as everywhere else,
        // and this comes first: a conflict raised for someone else's problem
        // would confirm that it exists.
        throw new ResourceNotFoundError();
      }

      if (problem.version !== expectedVersion) {
        // Before the rule, deliberately. The caller is reasoning about a
        // problem as it was, so the useful answer is "read it again" rather
        // than a verdict on a move it might not have asked for had it known.
        throw new ProblemVersionConflictError();
      }

      // Looked up only when it can matter, and which status that is comes
      // from the domain rather than a comparison written here. The repository
      // is owner-scoped and takes the problem id, so this can only ever see
      // this Problem's own verifications — another Problem's evidence is not
      // reachable from here even by mistake.
      const hasSuccessfulVerification = requiresSuccessfulVerification(targetStatus)
        ? (await context.repository.listVerifications(target)).some(
            (verification) => verification.result,
          )
        : false;

      const decision = decideTransition({
        currentStatus: problem.status,
        targetStatus,
        hasSuccessfulVerification,
      });

      if (!decision.allowed) {
        // Every refusal is bad input rather than a conflict. P2-07 introduces
        // the vocabulary for concurrency conflicts, and inventing part of it
        // here would leave two tasks describing the same thing differently.
        throw new InvalidApplicationInputError(decision.reason);
      }

      const updated = await context.repository.updateProblemStatus(
        target,
        expectedVersion,
        targetStatus,
      );
      if (updated === undefined) {
        // The version matched when it was read, so another writer landed in
        // between. The predicate on the update is what turns that into a
        // refusal instead of one of them quietly overwriting the other.
        throw new ProblemVersionConflictError();
      }
      return updated;
    },
  };
}
