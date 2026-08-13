/**
 * Memory control routes.
 *
 * Registered inside the authenticated `/v1` scope, so every handler is reached
 * only after an owner has been established.
 *
 * A surface of its own because these are deliberate decisions about how a
 * memory should be used, not incidental edits to a record. The ordinary
 * `PATCH /v1/problems/:problem_id` remains the way to modify a Problem's
 * content, and it still accepts these fields — clients written against it keep
 * working, and nothing was taken away to make room for this.
 *
 * The controls are independent axes and stay that way. Turning off reads does
 * not suppress, suppressing does not invalidate, and invalidating disables
 * nothing: "do not surface this", "do not read this automatically" and "this
 * turned out to be wrong" are different facts, and a retrieval layer will want
 * to treat them differently.
 *
 * `invalidate` is the one verb here rather than a field, and it only accepts
 * `true`. There is no un-invalidate, because it could not know what to
 * restore — a Problem that became `INVALID` may have been `CURRENT` before, or
 * `STALE_UNKNOWN`, or `SUPERSEDED`. Saying a memory holds again means saying
 * which of those it is, through the ordinary update.
 *
 * A change here is a Problem write like any other: same version, same
 * compare-and-swap, same transaction, same history. `expected_version` and
 * `changed_by` are required for exactly that reason.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import type {
  AuthenticatedRequestContext,
  MemoryControlCommand,
  MemoryControlService,
} from '../app/index.js';
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

interface MemoryControlBody {
  expected_version: number;
  changed_by: string;
  memory_read_enabled?: boolean;
  memory_write_enabled?: boolean;
  suppressed?: boolean;
  invalidate?: true;
}

export function registerMemoryControlRoutes(
  scope: FastifyInstance,
  service: MemoryControlService,
): void {
  scope.patch<{ Params: { problem_id: string }; Body: MemoryControlBody }>(
    '/problems/:problem_id/memory-control',
    {
      schema: {
        operationId: 'updateMemoryControl',
        summary: 'Set how a problem is used as memory',
        description:
          'Not authorisation, and not enforced yet. `invalidate` accepts only true and sets freshness to INVALID.',
        tags: ['Memory Controls'],
        params: PROBLEM_ID_PARAMS_SCHEMA,
        body: {
          type: 'object',
          properties: {
            expected_version: EXPECTED_VERSION_SCHEMA,
            changed_by: NON_BLANK_STRING_SCHEMA,
            // Whether this Problem should be drawn on when memory is
            // consulted automatically. Not authorisation: its owner can still
            // read it, and can still reach these controls.
            memory_read_enabled: { type: 'boolean' },
            // Whether an assistant should add to it on its own.
            memory_write_enabled: { type: 'boolean' },
            // Surface this less. Says nothing about whether it is still true.
            suppressed: { type: 'boolean' },
            // `true` only. See the module comment: there is nothing sensible
            // for `false` to mean here.
            invalidate: { type: 'boolean', enum: [true] },
          },
          required: ['expected_version', 'changed_by'],
          // The token, the signature, and at least one actual control. A
          // request that changes nothing would still move the version and
          // `updated_at`.
          minProperties: 3,
          // Refuses everything else, `freshness` included: this route reaches
          // freshness only through `invalidate`, so that invalidating and
          // editing freshness in general stay distinguishable. `status`,
          // `fix_kind` and `version` are refused as they are everywhere.
          additionalProperties: false,
        },
        // 200: an existing Problem changed, and the whole Problem comes back
        // in the shape every other Problem response uses.
        response: { 200: PROBLEM_RESOURCE_SCHEMA, ...COMMON_ERROR_RESPONSES },
      },
    },
    async (request) => {
      const body = request.body;
      const command: MemoryControlCommand = {
        expectedVersion: body.expected_version,
        changedBy: body.changed_by,
        ...(body.memory_read_enabled !== undefined
          ? { memoryReadEnabled: body.memory_read_enabled }
          : {}),
        ...(body.memory_write_enabled !== undefined
          ? { memoryWriteEnabled: body.memory_write_enabled }
          : {}),
        ...(body.suppressed !== undefined ? { suppressed: body.suppressed } : {}),
        ...(body.invalidate === true ? { invalidate: true as const } : {}),
      };

      const problem = await service.updateControls(
        contextOf(request),
        request.params.problem_id,
        command,
      );
      return toProblemResource(problem);
    },
  );
}
