/**
 * Usage log routes.
 *
 * Registered inside the authenticated `/v1` scope, so every handler is reached
 * only after an owner has been established.
 *
 * Both routes hang off the Problem being worked on, which comes from the path
 * only. The past Problem used as memory comes from the body, and the two may
 * be in different projects or be the same Problem.
 *
 * Recording usage is something a caller does deliberately. No read logs
 * anything: fetching a Problem or listing its Events, Verifications or
 * Relations writes nothing here. A read that quietly writes can fail for
 * reasons the caller did not ask about — and it would record that a memory was
 * *used* when all that happened was a look. The adapter is the only thing that
 * knows it referenced, adopted or set aside a memory, so the adapter says so.
 *
 * This is Memory-specific history and nothing wider. Tool calls, deploys,
 * model invocations and approvals are not logged here; those belong to a
 * Global Audit Layer above this service, and this endpoint has to stay
 * something that layer could read from rather than something already trying to
 * be it.
 *
 * Create and list only. There is no single-log read, update or delete, and no
 * `expected_version`: writing one changes neither Problem.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import type {
  AuthenticatedRequestContext,
  CreateUsageLogCommand,
  UsageLogService,
} from '../app/index.js';
import { USAGE_ACTIONS } from '../domain/enums.js';
import { ERROR_RESPONSE_SCHEMA } from './errors.js';
import {
  NON_BLANK_STRING_SCHEMA,
  PROBLEM_ID_PARAMS_SCHEMA,
  toUsageLogResource,
  USAGE_LOG_RESOURCE_SCHEMA,
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

interface CreateUsageLogBody {
  source_ai: string;
  action: (typeof USAGE_ACTIONS)[number];
  memory_id: string;
  reason: string;
  result?: string | null;
}

export function registerUsageLogRoutes(scope: FastifyInstance, service: UsageLogService): void {
  scope.post<{ Params: { problem_id: string }; Body: CreateUsageLogBody }>(
    '/problems/:problem_id/usage-logs',
    {
      schema: {
        operationId: 'createUsageLog',
        summary: 'Record that past memory was used',
        description:
          'Explicit only. No read writes one, and recording a use changes neither problem.',
        tags: ['Usage'],
        params: PROBLEM_ID_PARAMS_SCHEMA,
        body: {
          type: 'object',
          properties: {
            // Who used it. Descriptive, and never consulted for authorisation:
            // the owner comes from the request context, so naming a different
            // AI here reaches exactly the same data.
            source_ai: NON_BLANK_STRING_SCHEMA,
            // No order is required between the actions. An adapter reports
            // what it can tell, and requiring SEARCHED before ADOPTED would
            // make this a workflow rather than an observation.
            action: { type: 'string', enum: [...USAGE_ACTIONS] },
            // The past problem used as memory.
            memory_id: { type: 'string', format: 'uuid' },
            // Why it was used, or set aside, and what looked similar. Without
            // it the log is a hit counter.
            reason: NON_BLANK_STRING_SCHEMA,
            // Optional, and null is the ordinary state: a memory that was
            // found or read has no outcome yet. Non-blank when present, so
            // "unknown" cannot arrive dressed as an empty answer.
            result: { type: ['string', 'null'], pattern: '\\S' },
          },
          required: ['source_ai', 'action', 'memory_id', 'reason'],
          // Refuses everything else, including `usage_log_id`, `owner_id`,
          // `problem_id`, `created_at` and `expected_version` — the last
          // because writing a usage log is not a write to either Problem.
          additionalProperties: false,
        },
        response: { 201: USAGE_LOG_RESOURCE_SCHEMA, ...COMMON_ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const command: CreateUsageLogCommand = {
        sourceAi: body.source_ai,
        action: body.action,
        memoryId: body.memory_id,
        reason: body.reason,
        ...(body.result !== undefined ? { result: body.result } : {}),
      };

      const usageLog = await service.createUsageLog(
        contextOf(request),
        request.params.problem_id,
        command,
      );

      return reply.code(201).send(toUsageLogResource(usageLog));
    },
  );

  scope.get<{ Params: { problem_id: string } }>(
    '/problems/:problem_id/usage-logs',
    {
      schema: {
        operationId: 'listUsageLogs',
        summary: 'List memory used on a problem',
        tags: ['Usage'],
        params: PROBLEM_ID_PARAMS_SCHEMA,
        response: {
          200: {
            type: 'object',
            properties: { usage_logs: { type: 'array', items: USAGE_LOG_RESOURCE_SCHEMA } },
            required: ['usage_logs'],
            additionalProperties: false,
          },
          ...COMMON_ERROR_RESPONSES,
        },
      },
    },
    async (request) => {
      // Ordered by the database, oldest first with the log id breaking ties.
      // Re-sorting here would put the guarantee in two places.
      const usageLogs = await service.listUsageLogs(contextOf(request), request.params.problem_id);
      return { usage_logs: usageLogs.map(toUsageLogResource) };
    },
  );
}
