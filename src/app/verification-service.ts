/**
 * Verification operations.
 *
 * Between transport and the repository, shaped like the Event service and for
 * the same reasons: both append and list settle ownership of the problem
 * before anything else happens, and both answer with the same
 * `ResourceNotFoundError` whether it does not exist or belongs to someone
 * else.
 *
 * Appending is idempotent on `client_event_id`, so that check is not
 * redundant. An unchecked append against an unknown problem could replay a
 * verification the caller never had a right to see, and listing another
 * owner's problem would return an empty list, which reads as "it exists and
 * has no verifications".
 *
 * What this service does not do is act on `result`. A verification recording
 * that a check succeeded does not move the Problem to `VERIFIED` and does not
 * touch its status at all. Deciding a Problem is solved is a domain judgement
 * that weighs the transition rules as well as the evidence, and it is P2-06's.
 * Making it a side effect of a write would put the rule where it could not see
 * the rest of the rules.
 *
 * Verifications are append-only. A later or corrected check is another
 * Verification with its own key — there is no `USER_CORRECTION` here as there
 * is for Events, because a second piece of evidence is the correction.
 */

import { ResourceNotFoundError } from './errors.js';
import type { AuthenticatedRequestContext } from './request-context.js';
import { toClientEventId } from '../domain/client-event-id.js';
import type { VerificationType } from '../domain/enums.js';
import { toProblemId, type ProblemId } from '../domain/problem.js';
import type { VerificationRecord } from '../repository/index.js';

export interface AppendVerificationCommand {
  readonly verificationType: VerificationType;
  /**
   * Whether the check confirmed the state.
   *
   * Both values mean a check was actually carried out. There is no third
   * value for "not checked yet": that is the absence of a Verification, not a
   * Verification saying no.
   */
  readonly result: boolean;
  readonly summary: string;
  readonly clientEventId: string;
  readonly evidenceRef?: string | null;
  readonly verifiedBy?: string | null;
}

export interface VerificationService {
  appendVerification(
    context: AuthenticatedRequestContext,
    problemId: string,
    command: AppendVerificationCommand,
  ): Promise<VerificationRecord>;
  listVerifications(
    context: AuthenticatedRequestContext,
    problemId: string,
  ): Promise<VerificationRecord[]>;
}

/**
 * Converts a path identifier, treating a malformed one as absent.
 *
 * A string that cannot be an id names nothing the owner has. Transport
 * validates the format first; this is the backstop for any other caller.
 */
function asProblemId(value: string): ProblemId {
  try {
    return toProblemId(value);
  } catch {
    throw new ResourceNotFoundError();
  }
}

export function createVerificationService(): VerificationService {
  async function requireProblem(
    context: AuthenticatedRequestContext,
    problemId: ProblemId,
  ): Promise<void> {
    if ((await context.repository.getProblem(problemId)) === undefined) {
      throw new ResourceNotFoundError();
    }
  }

  return {
    async appendVerification(context, problemId, command) {
      const problem = asProblemId(problemId);
      // Before the client event id is looked at, so idempotency can never be
      // the route by which someone reaches a problem that is not theirs.
      await requireProblem(context, problem);

      let clientEventId;
      try {
        clientEventId = toClientEventId(command.clientEventId);
      } catch {
        throw new ResourceNotFoundError();
      }

      // The verification id and the timestamp are the server's. A caller
      // supplies what was checked and what came of it, never when or under
      // which identity.
      return context.repository.appendVerification({
        problemId: problem,
        verificationType: command.verificationType,
        result: command.result,
        summary: command.summary,
        clientEventId,
        ...(command.evidenceRef !== undefined ? { evidenceRef: command.evidenceRef } : {}),
        ...(command.verifiedBy !== undefined ? { verifiedBy: command.verifiedBy } : {}),
      });
    },

    async listVerifications(context, problemId) {
      const problem = asProblemId(problemId);
      await requireProblem(context, problem);

      return context.repository.listVerifications(problem);
    },
  };
}
