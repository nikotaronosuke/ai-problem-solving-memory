/**
 * Event routes.
 *
 * Registered inside the authenticated `/v1` scope, so every handler is reached
 * only after an owner has been established.
 *
 * Both routes are nested under the problem they belong to, which gives the
 * problem id one source. It is not accepted in the body — neither is the
 * owner, the event id or the timestamp. What a caller supplies is what
 * happened; who it happened to, which event it is and when it was recorded are
 * the server's to decide.
 *
 * Append answers 201 whether it wrote a new event or returned the one an
 * earlier attempt wrote. A retry is the same logical write, so it gets the
 * same status and the same representation — a client that cannot tell which
 * of its attempts succeeded does not have to care, which is the entire point
 * of `client_event_id`.
 *
 * There is no update, no delete and no single-event read. Events are
 * append-only; a later correction is a `USER_CORRECTION` event.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import type {
  AppendEventCommand,
  AuthenticatedRequestContext,
  EventService,
} from '../app/index.js';
import { EVENT_TYPES } from '../domain/enums.js';
import { ERROR_RESPONSE_SCHEMA } from './errors.js';
import {
  EVENT_RESOURCE_SCHEMA,
  NON_BLANK_STRING_SCHEMA,
  NULLABLE_TEXT_SCHEMA,
  PROBLEM_ID_PARAMS_SCHEMA,
  toEventResource,
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

interface AppendEventBody {
  event_type: (typeof EVENT_TYPES)[number];
  summary: string;
  client_event_id: string;
  result?: string | null;
  reason?: string | null;
  source_ai?: string | null;
  evidence_ref?: string | null;
}

export function registerEventRoutes(scope: FastifyInstance, service: EventService): void {
  scope.post<{ Params: { problem_id: string }; Body: AppendEventBody }>(
    '/problems/:problem_id/events',
    {
      schema: {
        operationId: 'appendEvent',
        summary: 'Record what happened',
        description:
          '`client_event_id` is an idempotency key. A retry returns the event the first attempt wrote.',
        tags: ['Events'],
        params: PROBLEM_ID_PARAMS_SCHEMA,
        body: {
          type: 'object',
          properties: {
            event_type: { type: 'string', enum: [...EVENT_TYPES] },
            // An event with nothing to say records that something happened
            // without recording what, which is not reusable later.
            summary: NON_BLANK_STRING_SCHEMA,
            // Required, and the caller's to mint before its first attempt. One
            // generated here would differ on every retry and protect nothing.
            client_event_id: { type: 'string', format: 'uuid' },
            result: NULLABLE_TEXT_SCHEMA,
            reason: NULLABLE_TEXT_SCHEMA,
            source_ai: NULLABLE_TEXT_SCHEMA,
            evidence_ref: NULLABLE_TEXT_SCHEMA,
          },
          required: ['event_type', 'summary', 'client_event_id'],
          // Refuses everything not listed, which includes problem_id, owner_id,
          // event_id and created_at. The problem comes from the path, and the
          // other three are not a caller's to assert.
          additionalProperties: false,
        },
        response: { 201: EVENT_RESOURCE_SCHEMA, ...COMMON_ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const command: AppendEventCommand = {
        eventType: body.event_type,
        summary: body.summary,
        clientEventId: body.client_event_id,
        ...(body.result !== undefined ? { result: body.result } : {}),
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
        ...(body.source_ai !== undefined ? { sourceAi: body.source_ai } : {}),
        ...(body.evidence_ref !== undefined ? { evidenceRef: body.evidence_ref } : {}),
      };

      const event = await service.appendEvent(
        contextOf(request),
        request.params.problem_id,
        command,
      );

      // 201 for a replay too. The status describes the logical write, not
      // whether this particular request was the one that reached the table.
      return reply.code(201).send(toEventResource(event));
    },
  );

  scope.get<{ Params: { problem_id: string } }>(
    '/problems/:problem_id/events',
    {
      schema: {
        operationId: 'listEvents',
        summary: 'List a problem\u2019s events',
        tags: ['Events'],
        params: PROBLEM_ID_PARAMS_SCHEMA,
        response: {
          200: {
            type: 'object',
            properties: { events: { type: 'array', items: EVENT_RESOURCE_SCHEMA } },
            required: ['events'],
            additionalProperties: false,
          },
          ...COMMON_ERROR_RESPONSES,
        },
      },
    },
    async (request) => {
      // Ordered by the database, oldest first with the event id breaking ties.
      // Re-sorting here would put the guarantee in two places.
      const events = await service.listEvents(contextOf(request), request.params.problem_id);
      return { events: events.map(toEventResource) };
    },
  );
}
