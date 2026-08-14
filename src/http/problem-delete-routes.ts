/**
 * The one destructive route.
 *
 * `DELETE /v1/problems/{problem_id}` removes the Problem and everything that
 * refers to it. There is no undo and nothing left to read afterwards.
 *
 * The concurrency guard travels as a query parameter rather than a body.
 * `expected_version` is a single integer that says which version the caller
 * last saw, and a DELETE whose body carried meaning would be the first request
 * in this API where the method's own semantics and the payload had to be read
 * together. A query parameter states the same thing in the place a
 * conditional delete belongs, and generated clients handle it without
 * argument.
 *
 * Nothing else is accepted. Not `changed_by`: the change log for this Problem
 * is itself being deleted, so there is nowhere for a name to go, and a free
 * string that exists only to be logged is the kind of egress P3-01 through
 * P3-03 spent three tasks closing. Not `confirm`: a client that can send the
 * request can send the flag, so it would record that the client knew about the
 * flag and nothing about a person's intent. And not an owner or client id —
 * those come from the credential, as everywhere.
 *
 * Success is 204 with no body. The Problem that was removed is deliberately
 * not echoed back: a caller deleting a mis-saved credential would receive it
 * one more time, in a response that may well be logged by whatever sent the
 * request.
 *
 * Deleting twice is 404 the second time. That is not idempotent in the letter
 * of the word — the status differs — but the state it reports is the same one
 * either call leaves behind, and answering 204 for a Problem that is not there
 * would mean answering 204 for a Problem that never existed or belongs to
 * someone else.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AuthenticatedRequestContext, ProblemDeleteService } from '../app/index.js';
import { ERROR_RESPONSE_SCHEMA } from './errors.js';
import { EXPECTED_VERSION_QUERY_SCHEMA, PROBLEM_ID_PARAMS_SCHEMA } from './resources.js';

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

export function registerProblemDeleteRoutes(
  scope: FastifyInstance,
  service: ProblemDeleteService,
): void {
  scope.delete<{ Params: { problem_id: string }; Querystring: { expected_version: string } }>(
    '/problems/:problem_id',
    {
      schema: {
        operationId: 'deleteProblem',
        summary: 'Permanently delete a problem',
        description:
          'Removes the Problem with its events, verifications, change log, and every relation and usage log referring to it — including those recorded from another Problem. Not reversible, and not the same as invalidating or suppressing, which keep the record. Requires `expected_version`, which detects a change to the Problem itself but not an event appended since it was read. A caller acting for a person must have that person’s explicit intent before calling this.',
        tags: ['Problems'],
        params: PROBLEM_ID_PARAMS_SCHEMA,
        querystring: {
          type: 'object',
          properties: {
            expected_version: EXPECTED_VERSION_QUERY_SCHEMA,
          },
          required: ['expected_version'],
          // As everywhere else on this API: an unexpected parameter is a
          // mistake worth reporting rather than something to ignore. On a
          // delete in particular, a caller who misspells a guard should hear
          // about it before the row is gone rather than after.
          additionalProperties: false,
        },
        response: {
          // Nothing to describe. An empty 204 is the whole of what success
          // looks like, and a schema here could only invite a body.
          204: { type: 'null', description: 'Deleted. No content.' },
          ...COMMON_ERROR_RESPONSES,
        },
      },
    },
    async (request, reply: FastifyReply) => {
      await service.delete(contextOf(request), {
        problemId: request.params.problem_id,
        // Safe by the schema above, which has already refused anything that is
        // not a whole number of at most ten digits.
        expectedVersion: Number(request.query.expected_version),
      });

      await reply.code(204).send();
    },
  );
}
