/**
 * Verification routes.
 *
 * Registered inside the authenticated `/v1` scope, so every handler is reached
 * only after an owner has been established.
 *
 * Both routes are nested under the problem, as Event routes are. A Verification
 * attaches to the Problem and never to an Event: there is no `event_id` in the
 * request or the response, and no route reaches one through the other. A FIX
 * Event says what was changed; a Verification says that something actually
 * checked whether it worked. Collapsing them would let the first pass as the
 * second.
 *
 * `result` is a boolean and nothing else. True means a check was carried out
 * and confirmed the state, false means it was carried out and did not. "Not
 * checked yet" is the absence of a Verification, not a Verification saying no,
 * so the schema accepts neither null nor a string nor 0/1 — and type coercion
 * is off application-wide, so `"true"` stays a string and is refused.
 *
 * Append answers 201 whether it wrote a new verification or returned the one
 * an earlier attempt wrote, exactly as the Event route does.
 *
 * There is no update, no delete and no single-verification read. A later or
 * corrected check is another Verification with its own key.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import type {
  AppendVerificationCommand,
  AuthenticatedRequestContext,
  VerificationService,
} from '../app/index.js';
import { VERIFICATION_TYPES } from '../domain/enums.js';
import { ERROR_RESPONSE_SCHEMA } from './errors.js';
import {
  NON_BLANK_STRING_SCHEMA,
  NULLABLE_TEXT_SCHEMA,
  PROBLEM_ID_PARAMS_SCHEMA,
  toVerificationResource,
  VERIFICATION_RESOURCE_SCHEMA,
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

interface AppendVerificationBody {
  verification_type: (typeof VERIFICATION_TYPES)[number];
  result: boolean;
  summary: string;
  client_event_id: string;
  evidence_ref?: string | null;
  verified_by?: string | null;
}

export function registerVerificationRoutes(
  scope: FastifyInstance,
  service: VerificationService,
): void {
  scope.post<{ Params: { problem_id: string }; Body: AppendVerificationBody }>(
    '/problems/:problem_id/verifications',
    {
      schema: {
        params: PROBLEM_ID_PARAMS_SCHEMA,
        body: {
          type: 'object',
          properties: {
            verification_type: { type: 'string', enum: [...VERIFICATION_TYPES] },
            // Required and strictly boolean. A check that was carried out has
            // an outcome; recording one without it would produce evidence that
            // cannot be judged.
            result: { type: 'boolean' },
            summary: NON_BLANK_STRING_SCHEMA,
            // Required, and the caller's to mint before its first attempt. One
            // generated here would differ on every retry and protect nothing.
            client_event_id: { type: 'string', format: 'uuid' },
            evidence_ref: NULLABLE_TEXT_SCHEMA,
            verified_by: NULLABLE_TEXT_SCHEMA,
          },
          required: ['verification_type', 'result', 'summary', 'client_event_id'],
          // Refuses everything not listed: problem_id, owner_id,
          // verification_id, created_at and event_id among them. The problem
          // comes from the path, the rest are not a caller's to assert, and a
          // Verification does not attach to an Event.
          additionalProperties: false,
        },
        response: { 201: VERIFICATION_RESOURCE_SCHEMA, ...COMMON_ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const command: AppendVerificationCommand = {
        verificationType: body.verification_type,
        result: body.result,
        summary: body.summary,
        clientEventId: body.client_event_id,
        ...(body.evidence_ref !== undefined ? { evidenceRef: body.evidence_ref } : {}),
        ...(body.verified_by !== undefined ? { verifiedBy: body.verified_by } : {}),
      };

      const verification = await service.appendVerification(
        contextOf(request),
        request.params.problem_id,
        command,
      );

      // 201 for a replay too. The status describes the logical write, not
      // whether this particular request was the one that reached the table.
      return reply.code(201).send(toVerificationResource(verification));
    },
  );

  scope.get<{ Params: { problem_id: string } }>(
    '/problems/:problem_id/verifications',
    {
      schema: {
        params: PROBLEM_ID_PARAMS_SCHEMA,
        response: {
          200: {
            type: 'object',
            properties: {
              verifications: { type: 'array', items: VERIFICATION_RESOURCE_SCHEMA },
            },
            required: ['verifications'],
            additionalProperties: false,
          },
          ...COMMON_ERROR_RESPONSES,
        },
      },
    },
    async (request) => {
      // Ordered by the database, oldest first with the verification id
      // breaking ties. Re-sorting here would put the guarantee in two places.
      const verifications = await service.listVerifications(
        contextOf(request),
        request.params.problem_id,
      );
      return { verifications: verifications.map(toVerificationResource) };
    },
  );
}
