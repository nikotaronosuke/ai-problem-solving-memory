/**
 * Problem status transitions.
 *
 * A route of its own rather than a field on the Problem PATCH. Status is not
 * an attribute a caller may assert; it is the outcome of a move that either
 * is or is not allowed from where the Problem currently stands, and
 * `VERIFIED` additionally requires a check that actually passed. Expressing
 * that as `PATCH {"status": ...}` would make an ordinary field assignment out
 * of a rule, so the PATCH schema keeps refusing `status` and this is the only
 * way it changes.
 *
 * Modelled as posting a transition rather than putting a status: what the
 * caller is asking for is the move, and the move is the thing that can be
 * refused.
 *
 * The response is the whole updated Problem, in the same shape every other
 * Problem response uses, so a client does not have to reconcile two
 * representations.
 *
 * Which moves are legal is not decided here. Transport validates that the
 * target is one of the canonical statuses and hands the rest to the
 * application service, which asks the domain rule. A route that knew the
 * matrix would be a second copy of it.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { AuthenticatedRequestContext, ProblemStatusService } from '../app/index.js';
import { PROBLEM_STATUSES } from '../domain/enums.js';
import { ERROR_RESPONSE_SCHEMA } from './errors.js';
import {
  EXPECTED_VERSION_SCHEMA,
  NON_BLANK_STRING_SCHEMA,
  PROBLEM_ID_PARAMS_SCHEMA,
  PROBLEM_RESOURCE_SCHEMA,
  toProblemResource,
} from './resources.js';

const COMMON_ERROR_RESPONSES = {
  400: ERROR_RESPONSE_SCHEMA,
  401: ERROR_RESPONSE_SCHEMA,
  404: ERROR_RESPONSE_SCHEMA,
  409: ERROR_RESPONSE_SCHEMA,
  500: ERROR_RESPONSE_SCHEMA,
} as const;

function contextOf(request: FastifyRequest): AuthenticatedRequestContext {
  const context = request.memoryContext;
  if (context === undefined) {
    throw new Error('Route reached without an authenticated context.');
  }
  return context;
}

interface TransitionBody {
  target_status: (typeof PROBLEM_STATUSES)[number];
  expected_version: number;
  changed_by: string;
}

export function registerProblemStatusRoutes(
  scope: FastifyInstance,
  service: ProblemStatusService,
): void {
  scope.post<{ Params: { problem_id: string }; Body: TransitionBody }>(
    '/problems/:problem_id/status-transitions',
    {
      schema: {
        params: PROBLEM_ID_PARAMS_SCHEMA,
        body: {
          type: 'object',
          properties: {
            // Only where the Problem should end up. The status it is in now
            // comes from the record, not from the caller: accepting both
            // would let them disagree.
            target_status: { type: 'string', enum: [...PROBLEM_STATUSES] },
            // A transition is a write to the Problem like any other, so it
            // carries the same concurrency token and shares the same version.
            // Two separate locks would let an edit and a transition pass each
            // other unnoticed.
            expected_version: EXPECTED_VERSION_SCHEMA,
            // Who is making the change, for the change log. Descriptive only.
            changed_by: NON_BLANK_STRING_SCHEMA,
          },
          required: ['target_status', 'expected_version', 'changed_by'],
          // Refuses everything else, including `status`, `current_status`,
          // `problem_id`, `owner_id`, `fix_kind` and `version`. A transition
          // changes status and nothing else; `version` in particular is the
          // server's to move, and is never assigned from a caller's value.
          additionalProperties: false,
        },
        // 200 rather than 201: nothing was created, an existing Problem moved.
        response: { 200: PROBLEM_RESOURCE_SCHEMA, ...COMMON_ERROR_RESPONSES },
      },
    },
    async (request) => {
      const problem = await service.transition(contextOf(request), request.params.problem_id, {
        targetStatus: request.body.target_status,
        expectedVersion: request.body.expected_version,
        changedBy: request.body.changed_by,
      });
      return toProblemResource(problem);
    },
  );
}
