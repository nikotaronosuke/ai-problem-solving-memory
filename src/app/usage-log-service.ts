/**
 * Usage log operations.
 *
 * Between transport and the repository. It settles two Problems before
 * writing: the one being worked on, and the past one used as memory. Both
 * have to be the caller's, and both failing must look identical from outside.
 *
 * Recording usage is explicit. Nothing in this service is called by a read —
 * fetching a Problem, listing its Events or its Relations logs nothing. A read
 * that quietly writes is a read that can fail for reasons the caller did not
 * ask about, and it would also make the log claim an adapter *used* a memory
 * when all it did was look. The adapter says what it used, and when.
 *
 * Nothing about either Problem changes. Using a memory is not a claim about
 * it: no status moves, no version increments, no confidence rises, no
 * Relation or Event appears. Adopting a memory does not make the current
 * Problem verified — it still needs a successful Verification of its own.
 *
 * `source_ai` describes who did the using and is never consulted for
 * authorisation. The owner comes from the established request context, so a
 * caller naming a different AI reaches exactly the same data.
 */

import { ResourceNotFoundError } from './errors.js';
import type { AuthenticatedRequestContext } from './request-context.js';
import type { UsageAction } from '../domain/enums.js';
import { toProblemId, type ProblemId } from '../domain/problem.js';
import type { UsageLogRecord } from '../repository/index.js';

export interface CreateUsageLogCommand {
  readonly sourceAi: string;
  readonly action: UsageAction;
  /** The past problem used as memory. May equal the problem being worked on. */
  readonly memoryId: string;
  readonly reason: string;
  readonly result?: string | null;
}

export interface UsageLogService {
  createUsageLog(
    context: AuthenticatedRequestContext,
    problemId: string,
    command: CreateUsageLogCommand,
  ): Promise<UsageLogRecord>;
  listUsageLogs(context: AuthenticatedRequestContext, problemId: string): Promise<UsageLogRecord[]>;
}

/**
 * Converts an identifier, treating a malformed one as absent.
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

export function createUsageLogService(): UsageLogService {
  async function requireProblem(
    context: AuthenticatedRequestContext,
    problemId: ProblemId,
  ): Promise<void> {
    if ((await context.repository.getProblem(problemId)) === undefined) {
      throw new ResourceNotFoundError();
    }
  }

  return {
    async createUsageLog(context, problemId, command) {
      const current = asProblemId(problemId);
      await requireProblem(context, current);

      const memory = asProblemId(command.memoryId);
      // The same not-found as for the problem being worked on. Another
      // owner's memory and one that does not exist are indistinguishable, so
      // this cannot be used to discover which ids are real.
      await requireProblem(context, memory);

      // The two may be in different projects — that is what makes memory
      // worth keeping across them — and may be the same Problem, which is
      // what continuing an investigation under a different AI looks like.
      return context.repository.createUsageLog({
        problemId: current,
        sourceAi: command.sourceAi,
        action: command.action,
        memoryId: memory,
        reason: command.reason,
        ...(command.result !== undefined ? { result: command.result } : {}),
      });
    },

    async listUsageLogs(context, problemId) {
      const current = asProblemId(problemId);
      // Checked first, so another owner's problem cannot answer with an empty
      // list — which would read as "it exists and has none".
      await requireProblem(context, current);

      return context.repository.listUsageLogs(current);
    },
  };
}
