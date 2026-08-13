/**
 * The HTTP surface of the Memory Server.
 *
 * Building the app and running it are separate. Importing this module starts
 * nothing: no listener, no database connection, no signal handler. It returns
 * a Fastify instance, which is what lets tests drive the real application
 * through `inject()` instead of a port, and what keeps the composition root —
 * where pools and signals actually belong — in one place.
 *
 * Transport talks to application services and to nothing below them. There is
 * no `pg` import here, no SQL, and no reach into `src/db/`.
 *
 * Two conventions the whole surface follows:
 *
 * JSON fields are snake_case. The internal records are camelCase, and letting
 * them serialise straight out would make an implementation detail into a
 * public contract by accident. Every response is shaped deliberately.
 *
 * Failures share one envelope. A client branches on `error.code`, never on
 * prose or on a framework's error format.
 */

import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify';

import type {
  AuthenticatedRequestContext,
  ChangeLogService,
  MemoryControlService,
  ProblemCloseService,
  EventService,
  HealthService,
  ProblemService,
  ProblemStatusService,
  ProjectEnvironmentService,
  RelationService,
  RequestContextService,
  UsageLogService,
  VerificationService,
} from '../app/index.js';
import {
  InvalidApplicationInputError,
  ProblemVersionConflictError,
  RequestContextUnavailableError,
  ResourceNotFoundError,
} from '../app/index.js';
import { buildErrorEnvelope, ERROR_RESPONSE_SCHEMA, ERROR_STATUS } from './errors.js';
import { registerChangeLogRoutes } from './change-log-routes.js';
import { registerEventRoutes } from './event-routes.js';
import { registerMemoryControlRoutes } from './memory-control-routes.js';
import { registerProblemCloseRoutes } from './problem-close-routes.js';
import { registerProblemRoutes } from './problem-routes.js';
import { registerProblemStatusRoutes } from './problem-status-routes.js';
import { registerProjectRoutes } from './project-routes.js';
import { registerRelationRoutes } from './relation-routes.js';
import { registerUsageLogRoutes } from './usage-log-routes.js';
import { registerVerificationRoutes } from './verification-routes.js';

/** Version prefix for the Memory JSON API. Operational routes sit outside it. */
export const API_PREFIX = '/v1';

export interface MemoryHttpAppDependencies {
  readonly healthService: HealthService;
  readonly requestContextService: RequestContextService;
  readonly projectEnvironmentService: ProjectEnvironmentService;
  readonly problemService: ProblemService;
  readonly problemStatusService: ProblemStatusService;
  readonly eventService: EventService;
  readonly verificationService: VerificationService;
  readonly relationService: RelationService;
  readonly usageLogService: UsageLogService;
  readonly changeLogService: ChangeLogService;
  readonly memoryControlService: MemoryControlService;
  readonly problemCloseService: ProblemCloseService;
  /**
   * Fastify logger configuration. Pass `false` in tests.
   *
   * Defaults are set by the caller rather than here so that the composition
   * root owns the log level, and a test can silence output entirely.
   */
  readonly logger?: FastifyServerOptions['logger'];
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the authentication hook on protected routes only. */
    memoryContext?: AuthenticatedRequestContext;
  }
}

/**
 * Headers that must never reach a log line.
 *
 * Redaction is configured on the logger rather than left to call sites,
 * because the failure mode is silent: a credential logged once is a credential
 * in a file nobody thinks to check.
 */
export const REDACTED_LOG_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["proxy-authorization"]',
  'res.headers["set-cookie"]',
] as const;

/**
 * Builds the application.
 *
 * Returns a Fastify instance that has not been listened on. The caller decides
 * whether to `listen` or to `inject`.
 */
export function buildMemoryHttpApp(dependencies: MemoryHttpAppDependencies): FastifyInstance {
  const app = Fastify({
    logger: dependencies.logger ?? false,
    ajv: {
      customOptions: {
        // An unexpected field is a mistake worth reporting, not something to
        // quietly drop. Silent removal lets a client believe a field was
        // honoured when it was discarded.
        removeAdditional: false,
        coerceTypes: false,
        allErrors: false,
      },
    },
  });

  // ---- failure handling ---------------------------------------------------

  app.setNotFoundHandler((request, reply) => {
    void reply.code(ERROR_STATUS.NOT_FOUND).send(buildErrorEnvelope('NOT_FOUND', request.id));
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    // Schema validation failed. Fastify's own error object describes Ajv, not
    // this API, so only the code crosses the boundary.
    if (error.validation !== undefined) {
      request.log.info({ err: error }, 'request failed validation');
      void reply
        .code(ERROR_STATUS.INVALID_REQUEST)
        .send(buildErrorEnvelope('INVALID_REQUEST', request.id));
      return;
    }

    // Malformed JSON and similar transport-level client mistakes.
    const statusCode = error.statusCode ?? 500;
    if (statusCode === 400) {
      request.log.info({ err: error }, 'request could not be parsed');
      void reply
        .code(ERROR_STATUS.INVALID_REQUEST)
        .send(buildErrorEnvelope('INVALID_REQUEST', request.id));
      return;
    }

    // Application-level failures. Transport maps them by type and never by
    // inspecting a driver error, so PostgreSQL stays out of the HTTP contract.
    if (error instanceof ResourceNotFoundError) {
      void reply.code(ERROR_STATUS.NOT_FOUND).send(buildErrorEnvelope('NOT_FOUND', request.id));
      return;
    }

    if (error instanceof ProblemVersionConflictError) {
      // The client can act on this: re-read the problem and decide again. It
      // is reached only for a problem already established as the caller's, so
      // it reveals nothing a 404 was protecting.
      void reply
        .code(ERROR_STATUS.VERSION_CONFLICT)
        .send(buildErrorEnvelope('VERSION_CONFLICT', request.id));
      return;
    }

    if (error instanceof InvalidApplicationInputError) {
      request.log.info({ err: error }, 'request rejected by the application layer');
      void reply
        .code(ERROR_STATUS.INVALID_REQUEST)
        .send(buildErrorEnvelope('INVALID_REQUEST', request.id));
      return;
    }

    if (error instanceof RequestContextUnavailableError) {
      // The internal reason is logged and discarded from the response, so the
      // client cannot tell an unknown owner from a malformed one.
      request.log.warn({ reason: error.internalReason }, 'owner context unavailable');
      void reply
        .code(ERROR_STATUS.UNAUTHENTICATED)
        .send(buildErrorEnvelope('UNAUTHENTICATED', request.id));
      return;
    }

    // Anything else is ours, not the client's. The full error goes to the log;
    // the response says only that something failed. A stack trace, a driver
    // message or a connection string in a response body is a leak.
    request.log.error({ err: error }, 'unhandled error while serving request');
    void reply
      .code(ERROR_STATUS.INTERNAL_ERROR)
      .send(buildErrorEnvelope('INTERNAL_ERROR', request.id));
  });

  // ---- operational --------------------------------------------------------

  // Outside the version prefix: whether the process is serving is not part of
  // the Memory API contract and should not move when that contract does.
  app.get(
    '/health',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: { status: { type: 'string', enum: ['ok'] } },
            required: ['status'],
            additionalProperties: false,
          },
          503: {
            type: 'object',
            properties: { status: { type: 'string', enum: ['unavailable'] } },
            required: ['status'],
            additionalProperties: false,
          },
        },
      },
    },
    async (request, reply) => {
      const report = await dependencies.healthService.check();

      if (report.status === 'ok') {
        return reply.code(200).send({ status: 'ok' });
      }

      // The reason stays in the log. A health probe that explains itself to
      // the network describes the deployment to anyone who asks.
      request.log.warn({ detail: report.detail }, 'health check reported unavailable');
      return reply.code(503).send({ status: 'unavailable' });
    },
  );

  // ---- owner-scoped API ---------------------------------------------------

  // Registered as a plugin so the authentication hook applies to this scope
  // and cannot leak onto operational routes. Everything owner-scoped from
  // P2-02 onward is added inside here and inherits the hook unchanged.
  void app.register(
    (scope, _options, done) => {
      scope.addHook('preHandler', async (request) => {
        // Establishing an owner needs the database, so it belongs in the
        // request lifecycle rather than in schema validation.
        request.memoryContext = await dependencies.requestContextService.authenticate();
      });

      scope.get(
        '/me',
        {
          schema: {
            response: {
              200: {
                type: 'object',
                properties: { owner_id: { type: 'string', format: 'uuid' } },
                required: ['owner_id'],
                additionalProperties: false,
              },
              401: ERROR_RESPONSE_SCHEMA,
              500: ERROR_RESPONSE_SCHEMA,
            },
          },
        },
        (request) => {
          // The hook guarantees this; the check keeps the guarantee local
          // rather than relying on a type assertion.
          const context = request.memoryContext;
          if (context === undefined) {
            throw new RequestContextUnavailableError('preHandler did not establish a context');
          }

          // Read from the owner-scoped repository, never from a table.
          return { owner_id: context.repository.ownerId };
        },
      );

      registerProjectRoutes(scope, dependencies.projectEnvironmentService);
      registerProblemRoutes(scope, dependencies.problemService);
      registerProblemStatusRoutes(scope, dependencies.problemStatusService);
      registerEventRoutes(scope, dependencies.eventService);
      registerVerificationRoutes(scope, dependencies.verificationService);
      registerRelationRoutes(scope, dependencies.relationService);
      registerUsageLogRoutes(scope, dependencies.usageLogService);
      registerChangeLogRoutes(scope, dependencies.changeLogService);
      registerMemoryControlRoutes(scope, dependencies.memoryControlService);
      registerProblemCloseRoutes(scope, dependencies.problemCloseService);

      done();
    },
    { prefix: API_PREFIX },
  );

  return app;
}
