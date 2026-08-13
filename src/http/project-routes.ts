/**
 * Project and Environment routes.
 *
 * Registered inside the authenticated `/v1` scope, so every handler here is
 * reached only after an owner has been established and can rely on the
 * context being present.
 *
 * Handlers do three things: read the request, call the application service,
 * and shape the response. They do not decide what "not found" means, do not
 * touch a repository, and do not know what a database is.
 *
 * Environment creation and listing are nested under a project because the
 * project id then has exactly one source. Accepting it in both a path and a
 * body would create a state where the two disagree, and someone would have to
 * decide which wins.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import type {
  AuthenticatedRequestContext,
  ProjectEnvironmentService,
  UpdateProjectCommand,
} from '../app/index.js';
import { ERROR_RESPONSE_SCHEMA } from './errors.js';
import {
  ENVIRONMENT_ID_PARAMS_SCHEMA,
  ENVIRONMENT_RESOURCE_SCHEMA,
  NON_BLANK_STRING_SCHEMA,
  NULLABLE_TEXT_SCHEMA,
  PROJECT_ID_PARAMS_SCHEMA,
  PROJECT_RESOURCE_SCHEMA,
  toEnvironmentResource,
  toProjectResource,
} from './resources.js';

/** The failure shapes every route here can produce. */
const COMMON_ERROR_RESPONSES = {
  400: ERROR_RESPONSE_SCHEMA,
  401: ERROR_RESPONSE_SCHEMA,
  404: ERROR_RESPONSE_SCHEMA,
  500: ERROR_RESPONSE_SCHEMA,
} as const;

/**
 * Reads the context the authentication hook established.
 *
 * The hook guarantees it. Failing loudly here keeps that guarantee local
 * rather than resting on a type assertion.
 */
function contextOf(request: FastifyRequest): AuthenticatedRequestContext {
  const context = request.memoryContext;
  if (context === undefined) {
    throw new Error('Route reached without an authenticated context.');
  }
  return context;
}

export function registerProjectRoutes(
  scope: FastifyInstance,
  service: ProjectEnvironmentService,
): void {
  scope.post<{ Body: { project_name: string; repo?: string | null; platform?: string | null } }>(
    '/projects',
    {
      schema: {
        operationId: 'createProject',
        summary: 'Create a project',
        tags: ['Projects'],
        body: {
          type: 'object',
          properties: {
            project_name: NON_BLANK_STRING_SCHEMA,
            repo: NULLABLE_TEXT_SCHEMA,
            platform: NULLABLE_TEXT_SCHEMA,
          },
          required: ['project_name'],
          // Ownership, identity and timestamps are not the caller's to set.
          // Refusing an unexpected field also means a typo is reported rather
          // than silently ignored.
          additionalProperties: false,
        },
        response: { 201: PROJECT_RESOURCE_SCHEMA, ...COMMON_ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const project = await service.createProject(contextOf(request), {
        projectName: request.body.project_name,
        ...(request.body.repo !== undefined ? { repo: request.body.repo } : {}),
        ...(request.body.platform !== undefined ? { platform: request.body.platform } : {}),
      });

      return reply.code(201).send(toProjectResource(project));
    },
  );

  scope.get(
    '/projects',
    {
      schema: {
        operationId: 'listProjects',
        summary: 'List your projects',
        tags: ['Projects'],
        response: {
          200: {
            type: 'object',
            properties: { projects: { type: 'array', items: PROJECT_RESOURCE_SCHEMA } },
            required: ['projects'],
            additionalProperties: false,
          },
          ...COMMON_ERROR_RESPONSES,
        },
      },
    },
    async (request) => {
      const projects = await service.listProjects(contextOf(request));
      return { projects: projects.map(toProjectResource) };
    },
  );

  scope.get<{ Params: { project_id: string } }>(
    '/projects/:project_id',
    {
      schema: {
        operationId: 'getProject',
        summary: 'Read a project',
        tags: ['Projects'],
        params: PROJECT_ID_PARAMS_SCHEMA,
        response: { 200: PROJECT_RESOURCE_SCHEMA, ...COMMON_ERROR_RESPONSES },
      },
    },
    async (request) => {
      const project = await service.getProject(contextOf(request), request.params.project_id);
      return toProjectResource(project);
    },
  );

  scope.patch<{
    Params: { project_id: string };
    Body: { project_name?: string; repo?: string | null; platform?: string | null };
  }>(
    '/projects/:project_id',
    {
      schema: {
        operationId: 'updateProject',
        summary: 'Update a project',
        description:
          'Changes only the fields it names. An empty patch is refused rather than treated as a no-op.',
        tags: ['Projects'],
        params: PROJECT_ID_PARAMS_SCHEMA,
        body: {
          type: 'object',
          properties: {
            project_name: NON_BLANK_STRING_SCHEMA,
            repo: NULLABLE_TEXT_SCHEMA,
            platform: NULLABLE_TEXT_SCHEMA,
          },
          // A patch that changes nothing is a mistake worth reporting: it
          // would still move `updated_at`, recording a change that never
          // happened.
          minProperties: 1,
          additionalProperties: false,
        },
        response: { 200: PROJECT_RESOURCE_SCHEMA, ...COMMON_ERROR_RESPONSES },
      },
    },
    async (request) => {
      // Absent means "leave alone"; null means "clear". Forwarding a key that
      // was not sent would collapse the two.
      const command: UpdateProjectCommand = {
        ...(request.body.project_name !== undefined
          ? { projectName: request.body.project_name }
          : {}),
        ...(request.body.repo !== undefined ? { repo: request.body.repo } : {}),
        ...(request.body.platform !== undefined ? { platform: request.body.platform } : {}),
      };

      const project = await service.updateProject(
        contextOf(request),
        request.params.project_id,
        command,
      );
      return toProjectResource(project);
    },
  );

  scope.post<{ Params: { project_id: string }; Body: { snapshot: Record<string, unknown> } }>(
    '/projects/:project_id/environments',
    {
      schema: {
        operationId: 'createEnvironment',
        summary: 'Record an environment snapshot',
        description: 'A point in time. There is no update or delete for one.',
        tags: ['Environments'],
        params: PROJECT_ID_PARAMS_SCHEMA,
        body: {
          type: 'object',
          properties: {
            // `type: 'object'` refuses an array, string, number, boolean or
            // null at the top level, while leaving the keys inside free —
            // which conditions matter differs by project and by problem.
            snapshot: { type: 'object', additionalProperties: true },
          },
          required: ['snapshot'],
          additionalProperties: false,
        },
        response: { 201: ENVIRONMENT_RESOURCE_SCHEMA, ...COMMON_ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const environment = await service.createEnvironment(
        contextOf(request),
        request.params.project_id,
        { snapshot: request.body.snapshot },
      );

      return reply.code(201).send(toEnvironmentResource(environment));
    },
  );

  scope.get<{ Params: { project_id: string } }>(
    '/projects/:project_id/environments',
    {
      schema: {
        operationId: 'listEnvironments',
        summary: 'List a project\u2019s environments',
        tags: ['Environments'],
        params: PROJECT_ID_PARAMS_SCHEMA,
        response: {
          200: {
            type: 'object',
            properties: { environments: { type: 'array', items: ENVIRONMENT_RESOURCE_SCHEMA } },
            required: ['environments'],
            additionalProperties: false,
          },
          ...COMMON_ERROR_RESPONSES,
        },
      },
    },
    async (request) => {
      const environments = await service.listEnvironments(
        contextOf(request),
        request.params.project_id,
      );
      return { environments: environments.map(toEnvironmentResource) };
    },
  );

  // Fetched by its own id rather than through a project, since an environment
  // id already identifies exactly one record. There is no update or delete:
  // an Environment is a point in time, and changed conditions are a new one.
  scope.get<{ Params: { environment_id: string } }>(
    '/environments/:environment_id',
    {
      schema: {
        operationId: 'getEnvironment',
        summary: 'Read an environment',
        tags: ['Environments'],
        params: ENVIRONMENT_ID_PARAMS_SCHEMA,
        response: { 200: ENVIRONMENT_RESOURCE_SCHEMA, ...COMMON_ERROR_RESPONSES },
      },
    },
    async (request) => {
      const environment = await service.getEnvironment(
        contextOf(request),
        request.params.environment_id,
      );
      return toEnvironmentResource(environment);
    },
  );
}
