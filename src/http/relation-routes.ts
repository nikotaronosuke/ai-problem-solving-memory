/**
 * Relation routes.
 *
 * Registered inside the authenticated `/v1` scope, so every handler is reached
 * only after an owner has been established.
 *
 * Both routes hang off the Problem the caller is working from. On create that
 * Problem is the `from` end, and it is taken from the path only — accepting
 * `from_id` in the body as well would give it two sources that could disagree.
 *
 * The list returns links in both directions. A Problem that only ever appeared
 * as the target of a link still needs to see it, and rows come back as stored
 * rather than flipped to suit whose list is being read: a link recorded as A
 * supersedes B says the same thing from B's side.
 *
 * Create and list only. There is no single-relation read, no update and no
 * delete — how a mistaken link is corrected or withdrawn is not decided in
 * this phase, and adding a route now would decide it by accident.
 *
 * A Relation is a link, not a write to either Problem. Neither one's status,
 * version or `updated_at` moves, so there is no `expected_version` here.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import type {
  AuthenticatedRequestContext,
  CreateRelationCommand,
  RelationService,
} from '../app/index.js';
import { RELATION_TYPES } from '../domain/enums.js';
import { ERROR_RESPONSE_SCHEMA } from './errors.js';
import {
  NON_BLANK_STRING_SCHEMA,
  PROBLEM_ID_PARAMS_SCHEMA,
  RELATION_RESOURCE_SCHEMA,
  toRelationResource,
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

interface CreateRelationBody {
  to_id: string;
  relation_type: (typeof RELATION_TYPES)[number];
  reason: string;
}

export function registerRelationRoutes(scope: FastifyInstance, service: RelationService): void {
  scope.post<{ Params: { problem_id: string }; Body: CreateRelationBody }>(
    '/problems/:problem_id/relations',
    {
      schema: {
        params: PROBLEM_ID_PARAMS_SCHEMA,
        body: {
          type: 'object',
          properties: {
            // The other end. The `from` end is the path, and is not accepted
            // here: one source, so the two cannot disagree.
            to_id: { type: 'string', format: 'uuid' },
            relation_type: { type: 'string', enum: [...RELATION_TYPES] },
            // Why these two are linked. Required and non-blank: a link nobody
            // can account for later is a link nobody can act on.
            reason: NON_BLANK_STRING_SCHEMA,
          },
          required: ['to_id', 'relation_type', 'reason'],
          // Refuses everything else, including `from_id`, `relation_id`,
          // `owner_id`, `created_at` and `expected_version`. The last of those
          // because a relation is not a write to either Problem, so there is
          // no version for it to guard.
          additionalProperties: false,
        },
        response: { 201: RELATION_RESOURCE_SCHEMA, ...COMMON_ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const command: CreateRelationCommand = {
        toId: body.to_id,
        relationType: body.relation_type,
        reason: body.reason,
      };

      const relation = await service.createRelation(
        contextOf(request),
        request.params.problem_id,
        command,
      );

      return reply.code(201).send(toRelationResource(relation));
    },
  );

  scope.get<{ Params: { problem_id: string } }>(
    '/problems/:problem_id/relations',
    {
      schema: {
        params: PROBLEM_ID_PARAMS_SCHEMA,
        response: {
          200: {
            type: 'object',
            properties: { relations: { type: 'array', items: RELATION_RESOURCE_SCHEMA } },
            required: ['relations'],
            additionalProperties: false,
          },
          ...COMMON_ERROR_RESPONSES,
        },
      },
    },
    async (request) => {
      // Ordered by the database, oldest first with the relation id breaking
      // ties. Re-sorting here would put the guarantee in two places.
      const relations = await service.listRelations(contextOf(request), request.params.problem_id);
      return { relations: relations.map(toRelationResource) };
    },
  );
}
