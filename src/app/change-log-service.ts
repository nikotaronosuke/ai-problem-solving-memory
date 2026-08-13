/**
 * Reading a Problem's history.
 *
 * Reading only. Entries are written by the services that mutate a Problem, in
 * the same transaction as the change, and there is no path by which a caller
 * writes one: a history someone can author directly is not a history, and one
 * that can be edited afterwards is worth less than none.
 *
 * That is why this service has no create. The two mutating services call the
 * repository themselves, inside their transaction, rather than going through
 * something a route could also reach.
 */

import { ResourceNotFoundError } from './errors.js';
import type { AuthenticatedRequestContext } from './request-context.js';
import { toProblemId, type ProblemId } from '../domain/problem.js';
import type { ChangeLogRecord } from '../repository/index.js';

export interface ChangeLogService {
  listChangeLogs(
    context: AuthenticatedRequestContext,
    problemId: string,
  ): Promise<ChangeLogRecord[]>;
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

export function createChangeLogService(): ChangeLogService {
  return {
    async listChangeLogs(context, problemId) {
      const target = asProblemId(problemId);

      // Checked first, so another owner's problem cannot answer with an empty
      // list — which would read as "it exists and has never changed".
      if ((await context.repository.getProblem(target)) === undefined) {
        throw new ResourceNotFoundError();
      }

      return context.repository.listChangeLogs(target);
    },
  };
}
