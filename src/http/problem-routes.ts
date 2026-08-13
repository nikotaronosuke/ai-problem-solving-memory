/**
 * Problem routes.
 *
 * Registered inside the authenticated `/v1` scope, so every handler is reached
 * only after an owner has been established.
 *
 * Create and list are nested under a project, giving the project id one
 * source. A single problem is read and patched by its own id, which already
 * identifies one record.
 *
 * The request schemas are where the write boundary is enforced. A caller may
 * describe a problem and adjust how it is judged and surfaced; it may not
 * assert what state the problem is in. `status`, `fix_kind` and `version` are
 * not accepted, so sending one is a 400 rather than something the service has
 * to notice — and because `additionalProperties` is false, that holds without
 * naming them at all.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import type {
  AuthenticatedRequestContext,
  ProblemService,
  UpdateProblemCommand,
} from '../app/index.js';
import { CONFIDENCES, FRESHNESSES } from '../domain/enums.js';
import { ERROR_RESPONSE_SCHEMA } from './errors.js';
import {
  NON_BLANK_STRING_SCHEMA,
  NULLABLE_TEXT_SCHEMA,
  PROBLEM_ID_PARAMS_SCHEMA,
  EXPECTED_VERSION_SCHEMA,
  PROBLEM_RESOURCE_SCHEMA,
  PROJECT_ID_PARAMS_SCHEMA,
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

interface CreateProblemBody {
  environment_id: string;
  title: string;
  symptoms: string;
  problem_domain?: string | null;
  suspected_boundary?: string | null;
  source_ai?: string | null;
}

interface UpdateProblemBody {
  expected_version: number;
  title?: string;
  symptoms?: string;
  problem_domain?: string | null;
  suspected_boundary?: string | null;
  source_ai?: string | null;
  importance?: boolean;
  confidence?: (typeof CONFIDENCES)[number];
  freshness?: (typeof FRESHNESSES)[number];
  memory_read_enabled?: boolean;
  memory_write_enabled?: boolean;
  suppressed?: boolean;
}

export function registerProblemRoutes(scope: FastifyInstance, service: ProblemService): void {
  scope.post<{ Params: { project_id: string }; Body: CreateProblemBody }>(
    '/projects/:project_id/problems',
    {
      schema: {
        params: PROJECT_ID_PARAMS_SCHEMA,
        body: {
          type: 'object',
          properties: {
            environment_id: { type: 'string', format: 'uuid' },
            title: NON_BLANK_STRING_SCHEMA,
            symptoms: NON_BLANK_STRING_SCHEMA,
            problem_domain: NULLABLE_TEXT_SCHEMA,
            suspected_boundary: NULLABLE_TEXT_SCHEMA,
            source_ai: NULLABLE_TEXT_SCHEMA,
          },
          required: ['environment_id', 'title', 'symptoms'],
          // A new problem starts under investigation, unverified and
          // untrusted. Those values come from the database, not from whoever
          // is filing it, so none of them appears here.
          additionalProperties: false,
        },
        response: { 201: PROBLEM_RESOURCE_SCHEMA, ...COMMON_ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const problem = await service.createProblem(contextOf(request), request.params.project_id, {
        environmentId: body.environment_id,
        title: body.title,
        symptoms: body.symptoms,
        ...(body.problem_domain !== undefined ? { problemDomain: body.problem_domain } : {}),
        ...(body.suspected_boundary !== undefined
          ? { suspectedBoundary: body.suspected_boundary }
          : {}),
        ...(body.source_ai !== undefined ? { sourceAi: body.source_ai } : {}),
      });

      return reply.code(201).send(toProblemResource(problem));
    },
  );

  scope.get<{ Params: { project_id: string } }>(
    '/projects/:project_id/problems',
    {
      schema: {
        params: PROJECT_ID_PARAMS_SCHEMA,
        response: {
          200: {
            type: 'object',
            properties: { problems: { type: 'array', items: PROBLEM_RESOURCE_SCHEMA } },
            required: ['problems'],
            additionalProperties: false,
          },
          ...COMMON_ERROR_RESPONSES,
        },
      },
    },
    async (request) => {
      const problems = await service.listProblems(contextOf(request), request.params.project_id);
      return { problems: problems.map(toProblemResource) };
    },
  );

  scope.get<{ Params: { problem_id: string } }>(
    '/problems/:problem_id',
    {
      schema: {
        params: PROBLEM_ID_PARAMS_SCHEMA,
        response: { 200: PROBLEM_RESOURCE_SCHEMA, ...COMMON_ERROR_RESPONSES },
      },
    },
    async (request) => {
      const problem = await service.getProblem(contextOf(request), request.params.problem_id);
      return toProblemResource(problem);
    },
  );

  scope.patch<{ Params: { problem_id: string }; Body: UpdateProblemBody }>(
    '/problems/:problem_id',
    {
      schema: {
        params: PROBLEM_ID_PARAMS_SCHEMA,
        body: {
          type: 'object',
          properties: {
            // The version the caller last read. Required: a patch sent without
            // one would overwrite whatever happened since, and losing another
            // person's finding silently is exactly what this record must not
            // do. It is a concurrency token, not a stored field — `version`
            // itself stays unwritable.
            expected_version: EXPECTED_VERSION_SCHEMA,
            title: NON_BLANK_STRING_SCHEMA,
            symptoms: NON_BLANK_STRING_SCHEMA,
            problem_domain: NULLABLE_TEXT_SCHEMA,
            suspected_boundary: NULLABLE_TEXT_SCHEMA,
            source_ai: NULLABLE_TEXT_SCHEMA,
            // Independent axes. Important does not mean correct, suppressed
            // does not mean unreadable, and stale does not mean untrusted —
            // so each is set on its own and never adjusts another.
            importance: { type: 'boolean' },
            confidence: { type: 'string', enum: [...CONFIDENCES] },
            freshness: { type: 'string', enum: [...FRESHNESSES] },
            memory_read_enabled: { type: 'boolean' },
            memory_write_enabled: { type: 'boolean' },
            suppressed: { type: 'boolean' },
          },
          required: ['expected_version'],
          // `expected_version` plus at least one field actually being changed.
          // A patch that changes nothing would still move `updated_at` and the
          // version, recording a change that never happened.
          minProperties: 2,
          // Everything absent from `properties` is refused: status, fix_kind,
          // version, the identifiers and the timestamps. Status in particular
          // must not be reachable here — VERIFIED requires a successful
          // Verification, and a field assignment would step around that.
          additionalProperties: false,
        },
        response: { 200: PROBLEM_RESOURCE_SCHEMA, ...COMMON_ERROR_RESPONSES },
      },
    },
    async (request) => {
      const body = request.body;
      const command: UpdateProblemCommand = {
        expectedVersion: body.expected_version,
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.symptoms !== undefined ? { symptoms: body.symptoms } : {}),
        ...(body.problem_domain !== undefined ? { problemDomain: body.problem_domain } : {}),
        ...(body.suspected_boundary !== undefined
          ? { suspectedBoundary: body.suspected_boundary }
          : {}),
        ...(body.source_ai !== undefined ? { sourceAi: body.source_ai } : {}),
        ...(body.importance !== undefined ? { importance: body.importance } : {}),
        ...(body.confidence !== undefined ? { confidence: body.confidence } : {}),
        ...(body.freshness !== undefined ? { freshness: body.freshness } : {}),
        ...(body.memory_read_enabled !== undefined
          ? { memoryReadEnabled: body.memory_read_enabled }
          : {}),
        ...(body.memory_write_enabled !== undefined
          ? { memoryWriteEnabled: body.memory_write_enabled }
          : {}),
        ...(body.suppressed !== undefined ? { suppressed: body.suppressed } : {}),
      };

      const problem = await service.updateProblem(
        contextOf(request),
        request.params.problem_id,
        command,
      );
      return toProblemResource(problem);
    },
  );
}
