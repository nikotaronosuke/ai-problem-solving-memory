/**
 * Event operations.
 *
 * Between transport and the repository, like the services before it. Its own
 * job is to settle ownership before anything is written or read: both append
 * and list confirm the problem is the caller's, and both answer with the same
 * `ResourceNotFoundError` whether it does not exist or belongs to someone
 * else.
 *
 * That check is not redundant with the storage layer. Listing another owner's
 * problem would otherwise return an empty list, which reads as "it exists and
 * has no events" — an answer nobody is entitled to. And appending is
 * idempotent on `client_event_id`, so an unchecked append against an unknown
 * problem could replay an event the caller never had a right to see. Owner
 * scope is decided here, before the key is ever consulted.
 *
 * Events are append-only. There is no update or delete, here or anywhere
 * below; a later correction is a `USER_CORRECTION` event.
 */

import { ResourceNotFoundError } from './errors.js';
import type { AuthenticatedRequestContext } from './request-context.js';
import { toClientEventId } from '../domain/client-event-id.js';
import type { EventType } from '../domain/enums.js';
import { toProblemId, type ProblemId } from '../domain/problem.js';
import type { EventRecord } from '../repository/index.js';

export interface AppendEventCommand {
  readonly eventType: EventType;
  readonly summary: string;
  readonly clientEventId: string;
  readonly result?: string | null;
  readonly reason?: string | null;
  readonly sourceAi?: string | null;
  readonly evidenceRef?: string | null;
}

export interface EventService {
  appendEvent(
    context: AuthenticatedRequestContext,
    problemId: string,
    command: AppendEventCommand,
  ): Promise<EventRecord>;
  listEvents(context: AuthenticatedRequestContext, problemId: string): Promise<EventRecord[]>;
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

export function createEventService(): EventService {
  async function requireProblem(
    context: AuthenticatedRequestContext,
    problemId: ProblemId,
  ): Promise<void> {
    if ((await context.repository.getProblem(problemId)) === undefined) {
      throw new ResourceNotFoundError();
    }
  }

  return {
    async appendEvent(context, problemId, command) {
      const problem = asProblemId(problemId);
      // Before the client event id is looked at, so idempotency can never be
      // the route by which someone reaches a problem that is not theirs.
      await requireProblem(context, problem);

      let clientEventId;
      try {
        clientEventId = toClientEventId(command.clientEventId);
      } catch {
        // Transport rejects a malformed one first. Reaching here means the
        // caller is not going through HTTP, and it is still bad input rather
        // than a missing resource.
        throw new ResourceNotFoundError();
      }

      // The event id and the timestamp are the server's. A caller supplies
      // what happened, never when or under which identity.
      return context.repository.appendEvent({
        problemId: problem,
        eventType: command.eventType,
        summary: command.summary,
        clientEventId,
        ...(command.result !== undefined ? { result: command.result } : {}),
        ...(command.reason !== undefined ? { reason: command.reason } : {}),
        ...(command.sourceAi !== undefined ? { sourceAi: command.sourceAi } : {}),
        ...(command.evidenceRef !== undefined ? { evidenceRef: command.evidenceRef } : {}),
      });
    },

    async listEvents(context, problemId) {
      const problem = asProblemId(problemId);
      await requireProblem(context, problem);

      return context.repository.listEvents(problem);
    },
  };
}
