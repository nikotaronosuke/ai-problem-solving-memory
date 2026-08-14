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
  SanitizationRejectedError,
} from '../app/index.js';
import { buildErrorEnvelope, ERROR_RESPONSE_SCHEMA, ERROR_STATUS } from './errors.js';
import { registerChangeLogRoutes } from './change-log-routes.js';
import { registerEventRoutes } from './event-routes.js';
import { registerMemoryControlRoutes } from './memory-control-routes.js';
import { registerOpenApi } from './openapi.js';
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
 * The logging options the server runs with.
 *
 * Assembled here rather than at the one call site so a test can run the real
 * configuration instead of rebuilding an equivalent one and proving only that
 * its own copy behaves. Nothing about redaction is worth asserting against a
 * list the assertion wrote itself.
 *
 * `remove: true` deletes the field rather than replacing it with a marker. A
 * marker says a credential was there, and the shape of the log then depends on
 * whether a request carried one.
 *
 * Worth being plain about the limit: today no serializer writes request
 * headers, so this removes nothing in practice. It is here for the moment one
 * does — a debug serializer added under pressure, an error path that dumps a
 * request — because that is exactly when nobody re-derives which headers are
 * credentials.
 */
export function createLoggerOptions(level: string): {
  level: string;
  redact: { paths: string[]; remove: true };
} {
  return {
    level,
    redact: { paths: [...REDACTED_LOG_PATHS], remove: true },
  };
}

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

  // ---- machine-readable contract ------------------------------------------

  // First, and before any route. The generator collects routes as they are
  // registered, so anything added earlier would be missing from the document
  // without anything failing.
  registerOpenApi(app);

  // ---- failure handling ---------------------------------------------------

  app.setNotFoundHandler((request, reply) => {
    void reply.code(ERROR_STATUS.NOT_FOUND).send(buildErrorEnvelope('NOT_FOUND', request.id));
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    // Schema validation failed. Fastify's own error object describes Ajv, not
    // this API, so only the code crosses the boundary.
    //
    // Nothing from the error itself is logged, and that is deliberate rather
    // than cautious. Ajv reports an `additionalProperties` failure by naming
    // the offending property, so logging the error object writes a
    // caller-chosen key into the operational log — before sanitization has run
    // at all, since validation happens first. A caller who puts a credential
    // in a field name would have it refused and then recorded. What is logged
    // instead is which part of the request failed and how many problems there
    // were, both of which the server produced.
    if (error.validation !== undefined) {
      request.log.info(
        { validationContext: error.validationContext, problems: error.validation.length },
        'request failed validation',
      );
      void reply
        .code(ERROR_STATUS.INVALID_REQUEST)
        .send(buildErrorEnvelope('INVALID_REQUEST', request.id));
      return;
    }

    // Malformed JSON and similar transport-level client mistakes.
    //
    // Same treatment, for the same reason and one that is easier to miss: a
    // JSON parse error quotes the bytes it choked on. `Unexpected token 's',
    // "{"a": sk9x}" is not valid JSON` puts a fragment of the request body in
    // the message, so the message cannot be logged either.
    const statusCode = error.statusCode ?? 500;
    if (statusCode === 400) {
      request.log.info({ statusCode }, 'request could not be parsed');
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

    if (error instanceof SanitizationRejectedError) {
      // The request carried something that may not be stored. It is a bad
      // request, not a server fault, so it reuses `INVALID_REQUEST` rather
      // than adding a code — what a client is told about a refused value is
      // P3-03's to settle, and inventing a contract for it now would fix that
      // answer before the question has been decided.
      //
      // Everything logged here is the boundary's own: where it happened, and
      // whether it was a key or a value. The locator has had every
      // caller-written key stripped out of it, and a policy has no field it
      // could have attached text to — so nothing available to log here is
      // something a caller sent or a policy wrote.
      request.log.warn(
        { locator: error.locator, kind: error.kind },
        'request rejected by the sanitization boundary',
      );
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
  //
  // Registered through a plugin rather than directly on the instance so that
  // it is queued behind the OpenAPI generator and appears in the document.
  // Fastify defers plugins, so a route added straight to the instance here
  // would be registered before the generator's hook exists and would be
  // missing from the contract with nothing failing.
  void app.register((scope, _options, done) => {
    scope.get(
      '/health',
      {
        schema: {
          operationId: 'healthCheck',
          summary: 'Report whether the service is serving',
          tags: ['Operational'],
          // Opts out of the document's default. Whether the process is
          // serving is not owned by anyone, and a probe that needed a
          // credential could not answer during the failure it exists to
          // report.
          security: [],
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

    done();
  });

  // ---- owner-scoped API ---------------------------------------------------

  // Registered as a plugin so the authentication hook applies to this scope
  // and cannot leak onto operational routes. Everything owner-scoped from
  // P2-02 onward is added inside here and inherits the hook unchanged.
  void app.register(
    (scope, _options, done) => {
      scope.addHook('preHandler', async (request) => {
        // Verifying a credential needs the database, so it belongs in the
        // request lifecycle rather than in schema validation.
        //
        // This is the only place the `Authorization` header is read. What the
        // handler below receives is a context; the header itself goes no
        // further, so no route and no service ever holds a credential.
        request.memoryContext = await dependencies.requestContextService.authenticate(
          request.headers.authorization,
        );
      });

      scope.get(
        '/me',
        {
          schema: {
            operationId: 'getCurrentOwner',
            summary: 'Return the owner this request is acting as',
            description:
              'The owner is established server-side. This reports which one, and is not a credential.',
            tags: ['Owner'],
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
