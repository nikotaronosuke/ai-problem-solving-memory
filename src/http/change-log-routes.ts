/**
 * Change log routes.
 *
 * Reading only, and deliberately so. Entries are written by the services that
 * mutate a Problem, inside the same transaction as the change — there is no
 * POST, no PATCH and no DELETE, because a history a caller can author is not a
 * history and one it can edit afterwards is worth less than none.
 *
 * That also means no field of an entry is ever taken from a request. The
 * versions come from the mutation, the owner from the established context, the
 * time from the database, and `changed_by` from the mutation request rather
 * than from anything here.
 *
 * What an entry may contain is decided in `src/domain/change-log.ts`:
 * controlled values exactly, free text described rather than copied, so that
 * removing something from a Problem later is not quietly undone by a copy of
 * it in the history.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { AuthenticatedRequestContext, ChangeLogService } from '../app/index.js';
import { ERROR_RESPONSE_SCHEMA } from './errors.js';
import {
  CHANGE_LOG_RESOURCE_SCHEMA,
  PROBLEM_ID_PARAMS_SCHEMA,
  toChangeLogResource,
} from './resources.js';

const COMMON_ERROR_RESPONSES = {
  400: ERROR_RESPONSE_SCHEMA,
  401: ERROR_RESPONSE_SCHEMA,
  404: ERROR_RESPONSE_SCHEMA,
  500: ERROR_RESPONSE_SCHEMA,
} as const;

function contextOf(request: FastifyRequest): AuthenticatedRequestContext {
  const context = request.memoryContext;
  if (context === undefined) {
    throw new Error('Route reached without an authenticated context.');
  }
  return context;
}

export function registerChangeLogRoutes(scope: FastifyInstance, service: ChangeLogService): void {
  scope.get<{ Params: { problem_id: string } }>(
    '/problems/:problem_id/change-logs',
    {
      schema: {
        params: PROBLEM_ID_PARAMS_SCHEMA,
        response: {
          200: {
            type: 'object',
            properties: { change_logs: { type: 'array', items: CHANGE_LOG_RESOURCE_SCHEMA } },
            required: ['change_logs'],
            additionalProperties: false,
          },
          ...COMMON_ERROR_RESPONSES,
        },
      },
    },
    async (request) => {
      // Ordered by the database, oldest first with the entry id breaking ties.
      // Re-sorting here would put the guarantee in two places.
      const changeLogs = await service.listChangeLogs(
        contextOf(request),
        request.params.problem_id,
      );
      return { change_logs: changeLogs.map(toChangeLogResource) };
    },
  );
}
