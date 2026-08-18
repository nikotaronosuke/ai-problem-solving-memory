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
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';

import type {
  AuthenticatedRequestContext,
  ChangeLogService,
  MemoryControlService,
  ProblemCloseService,
  ExportService,
  ProblemDeleteService,
  EventService,
  HealthService,
  ProblemService,
  ProblemStatusService,
  ProjectEnvironmentService,
  RelationService,
  RequestContextService,
  RetrievalSearchServiceResolver,
  UsageLogService,
  VerificationService,
} from '../app/index.js';
import {
  InvalidApplicationInputError,
  InvalidRetrievalSearchError,
  ExportBlockedError,
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
import { registerExportRoutes } from './export-routes.js';
import { registerProblemDeleteRoutes } from './problem-delete-routes.js';
import { registerProblemRoutes } from './problem-routes.js';
import { registerProblemStatusRoutes } from './problem-status-routes.js';
import { registerProjectRoutes } from './project-routes.js';
import { registerRelationRoutes } from './relation-routes.js';
import { registerSearchRoutes } from './search-routes.js';
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
  readonly problemDeleteService: ProblemDeleteService;
  readonly exportService: ExportService;
  /**
   * How a search request reaches the retrieval pipeline.
   *
   * Required, like every other service here. The search operation is part of
   * the API, not part of a deployment's configuration: a server whose semantic
   * and structural providers are unconfigured still answers searches from the
   * lexical channel, and making this optional would turn a missing provider
   * into a missing route — the one thing the contract promises it is not.
   *
   * Transport asks for a service and never assembles one, so `src/http/` still
   * holds no pool and no repository — see `RetrievalSearchServiceResolver`.
   */
  readonly retrievalSearchResolver: RetrievalSearchServiceResolver;
  /**
   * Fastify logger configuration. Pass `false` in tests.
   *
   * Defaults are set by the caller rather than here so that the composition
   * root owns the log level, and a test can silence output entirely.
   */
  readonly logger?: MemoryHttpLogger;
}

/**
 * What may be passed as the logger: Fastify's own options, or this module's.
 *
 * The two are listed separately because they are not compatible, and the
 * incompatibility is deliberate — see `OperationalLoggerOptions`.
 */
export type MemoryHttpLogger =
  | FastifyServerOptions['logger']
  | (OperationalLoggerOptions & { stream?: { write(line: string): void } });

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the authentication hook on protected routes only. */
    memoryContext?: AuthenticatedRequestContext;
  }
}

/**
 * ===========================================================================
 * Operational logging policy (P3-10)
 * ===========================================================================
 *
 * One rule, and everything below is a consequence of it:
 *
 *     the operational log carries what the server decided,
 *     never what anybody sent it.
 *
 * The version of this that does not work is a list of dangerous things to
 * remove. P3-10 began by measuring the previous configuration, and the leaks
 * were not in a list anybody had thought to write: the raw URL — so a
 * credential in a 404 path or a query string was logged verbatim — the `Host`
 * header, which the caller also chooses, the remote address, the driver's
 * message behind a failed health probe, which carried a database host, a port
 * and an account name, and every `Error` handed to the logger, which Pino
 * expands into its message, its stack, its `cause` and every enumerable
 * property it happens to have. A `pg` unique or check violation carries the
 * offending row in `detail` — `Failing row contains (…)` — which is Memory
 * content, arriving in the log through the driver rather than through anything
 * this codebase wrote.
 *
 * So the direction is inverted. Nothing reaches a log line unless a serializer
 * or a call site names it, and both are closed sets written here. Adding a
 * field is an edit to this file, which is where somebody will be thinking
 * about the question.
 *
 * Fastify's automatic request lifecycle logging is kept. It is the thing that
 * pairs a start with a completion under one request id, and turning it off
 * would mean rebuilding that by hand — and `disableRequestLogging` is
 * deprecated in Fastify 5 besides. What is replaced is its serializers.
 */

/**
 * Headers that must never reach a log line.
 *
 * Redaction is configured on the logger rather than left to call sites,
 * because the failure mode is silent: a credential logged once is a credential
 * in a file nobody thinks to check.
 *
 * Second line of defence, and honestly so: the request serializer below emits
 * no headers at all, so in normal operation this removes nothing. It is here
 * for the moment somebody widens that serializer — which is exactly when
 * nobody re-derives which headers are credentials. It is deliberately not a
 * growing dictionary of every header a vendor might use for a secret; that
 * list has no end, and the serializer is what makes its length stop mattering.
 *
 * `remove: true` deletes the field rather than replacing it with a marker. A
 * marker says a credential was there, and the shape of the log then depends on
 * whether a request carried one.
 */
export const REDACTED_LOG_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["proxy-authorization"]',
  'res.headers["set-cookie"]',
] as const;

/**
 * What the server says happened.
 *
 * A small closed set, one member per place that logs deliberately. Not a
 * logging framework and not a taxonomy with room to grow into one — the value
 * of naming these at all is that a reader can grep for the name and find the
 * single line that emits it.
 */
export const OPERATIONAL_LOG_EVENTS = [
  'REQUEST_VALIDATION_FAILED',
  'REQUEST_PARSE_FAILED',
  'REQUEST_APPLICATION_REJECTED',
  'SANITIZATION_REJECTED',
  'AUTH_CONTEXT_UNAVAILABLE',
  'EXPORT_BLOCKED',
  'HEALTH_UNAVAILABLE',
  'UNHANDLED_REQUEST_FAILURE',
  /**
   * A search answered, and the record of what it surfaced did not get written.
   *
   * The only event here that is not about a request failing. It reports a
   * partial success, which is why it exists at all: the caller received its
   * candidates and has no reason to know anything was lost, so if this were not
   * logged the loss would be invisible to everyone.
   */
  'SEARCH_USAGE_LOG_WRITE_FAILED',
  'SERVER_SHUTDOWN',
  'SERVER_SHUTDOWN_FAILURE',
  'SERVER_START_FAILURE',
] as const;

export type OperationalLogEvent = (typeof OPERATIONAL_LOG_EVENTS)[number];

/**
 * How much a failure is allowed to say about itself.
 *
 * Two values, and the asymmetry between them is the point.
 * `INVALID_APPLICATION_INPUT` names a decision this codebase made about a
 * request. `UNEXPECTED` names the absence of one — something failed and the
 * server has nothing safe to say about what. An operator finds the rest by
 * request id, from a stack trace nobody put in a file.
 */
export const OPERATIONAL_FAILURES = ['UNEXPECTED', 'INVALID_APPLICATION_INPUT'] as const;

export type OperationalFailure = (typeof OPERATIONAL_FAILURES)[number];

/** What a request that matched no route is called in a log line. */
export const UNMATCHED_ROUTE = 'UNMATCHED';

/** Exactly what a request is allowed to look like in a log line. */
export type LoggedRequest = {
  /** The HTTP method. Chosen from a fixed set by the protocol, not by text. */
  method: string;
  /**
   * The route template the request matched — `/v1/problems/:problem_id/events`
   * — or `UNMATCHED`.
   *
   * The template is written in this repository and the parameters are not, so
   * this identifies the endpoint without repeating anything the caller typed.
   * That is the whole trade P3-10 makes: an operator loses the ability to see
   * which problem id was involved, and gains a log that cannot carry one.
   */
  route: string;
  /** The OpenAPI `operationId`, or `null` for a request that matched nothing. */
  operation: string | null;
};

/** Exactly what a response is allowed to look like in a log line. */
export type LoggedReply = {
  statusCode: number;
};

/** Exactly what a failure is allowed to look like in a log line. */
export type LoggedFailure = {
  failure: OperationalFailure;
};

/**
 * The request serializer.
 *
 * Builds a new object from three named fields rather than removing anything
 * from Fastify's. A serializer that started with the real request and deleted
 * the dangerous parts would inherit whatever Fastify adds next.
 */
function serializeRequest(request: FastifyRequest): LoggedRequest {
  return {
    method: request.method,
    // `undefined` when nothing matched — Fastify's own types say so.
    route: request.routeOptions.url ?? UNMATCHED_ROUTE,
    // Absent for a 404, and `null` rather than an omitted key so that every
    // logged request has the same three fields and an inventory test can say
    // so exactly.
    operation: request.routeOptions.schema?.operationId ?? null,
  };
}

/** The response serializer. A status code is the whole of it. */
function serializeReply(reply: FastifyReply): LoggedReply {
  return { statusCode: reply.statusCode };
}

/**
 * The error serializer.
 *
 * It takes no argument. That is not a stylistic choice: a serializer that
 * received the error could be edited into one that reports a field of it,
 * whereas this one has nothing to report from. Pino passes the error and this
 * function ignores it, at the level of the function signature.
 *
 * It should also never run. Nothing in this codebase hands an `Error` to the
 * logger any more — an architecture test enforces that — so this exists for
 * the paths that are not this codebase's: a Fastify internal, a plugin, a
 * future version that decides to log the error it just handled.
 */
function serializeFailure(): LoggedFailure {
  return { failure: 'UNEXPECTED' };
}

/**
 * The logging configuration the server runs with.
 *
 * Deliberately not assignable to Fastify's own logger type. Fastify declares
 * that an error serializer returns `{ type, message, stack }` — all three
 * required — and this one returns none of them. That is the difference P3-10
 * exists to make, so it is stated here as a type of its own rather than bent
 * into the shape of the thing it is replacing. `buildMemoryHttpApp` converts
 * it in one place, which is the only cast in this module.
 */
export interface OperationalLoggerOptions {
  level: string;
  redact: { paths: string[]; remove: true };
  serializers: {
    req: (request: FastifyRequest) => LoggedRequest;
    res: (reply: FastifyReply) => LoggedReply;
    err: () => LoggedFailure;
  };
}

/**
 * The logging options the server runs with.
 *
 * Assembled here rather than at the one call site so a test can run the real
 * configuration instead of rebuilding an equivalent one and proving only that
 * its own copy behaves. Nothing about this is worth asserting against a
 * configuration the assertion wrote itself, which is why the leak tests take
 * this function and replace only the stream.
 */
export function createLoggerOptions(level: string): OperationalLoggerOptions {
  return {
    level,
    redact: { paths: [...REDACTED_LOG_PATHS], remove: true },
    serializers: {
      req: serializeRequest,
      res: serializeReply,
      err: serializeFailure,
    },
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
    // The one cast. Fastify's type requires an error serializer to return a
    // message and a stack; this configuration's returns neither, on purpose,
    // and Pino does not care at runtime. Narrowing it here keeps the assertion
    // beside the reason for it instead of at every call site.
    logger: (dependencies.logger ?? false) as NonNullable<FastifyServerOptions['logger']>,
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
        {
          event: 'REQUEST_VALIDATION_FAILED',
          validationContext: error.validationContext,
          validationProblemCount: error.validation.length,
        },
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
      request.log.info(
        { event: 'REQUEST_PARSE_FAILED', statusCode },
        'request could not be parsed',
      );
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

    if (error instanceof ExportBlockedError) {
      // The request was right and the server is working; what is wrong is the
      // state of the Memory. Its own code rather than a borrowed one: a client
      // that read `VERSION_CONFLICT` here would look for a version to re-read,
      // and `INVALID_REQUEST` would send it looking at a request that was
      // fine. Nothing about what was found is logged or returned — where the
      // credential sits is a map to it.
      request.log.warn(
        { event: 'EXPORT_BLOCKED' },
        'export refused: the memory holds a credential',
      );
      void reply
        .code(ERROR_STATUS.EXPORT_BLOCKED)
        .send(buildErrorEnvelope('EXPORT_BLOCKED', request.id));
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

    if (
      error instanceof InvalidApplicationInputError ||
      error instanceof InvalidRetrievalSearchError
    ) {
      // The error itself is not logged, and neither is its message. Every call
      // site that raises one writes a fixed sentence today, but the
      // constructor takes a `string` and a future one need not — and Pino
      // writes a message and a stack for any `Error` it is handed. What an
      // operator gets is the decision: the application layer refused this.
      //
      // A refused search joins the same branch rather than getting an event of
      // its own. It is the same fact — the application would not accept this
      // request — and the same 400, and the reasoning above applies with more
      // force there: a search request is made of somebody's own words about
      // their own problem, and `InvalidRetrievalSearchError` builds its message
      // out of them being unusable.
      //
      // What does *not* land here matters as much. A malformed provider answer,
      // an unusable rerank output or a broken storage invariant are internal
      // failures; folding them in would tell a caller its request was wrong
      // about something that was not, and leave a broken provider looking like
      // a bad query indefinitely.
      request.log.info(
        { event: 'REQUEST_APPLICATION_REJECTED', failure: 'INVALID_APPLICATION_INPUT' },
        'request rejected by the application layer',
      );
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
        { event: 'SANITIZATION_REJECTED', locator: error.locator, kind: error.kind },
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
      request.log.warn(
        { event: 'AUTH_CONTEXT_UNAVAILABLE', reason: error.internalReason },
        'owner context unavailable',
      );
      void reply
        .code(ERROR_STATUS.UNAUTHENTICATED)
        .send(buildErrorEnvelope('UNAUTHENTICATED', request.id));
      return;
    }

    // Anything else is ours, not the client's — and since P3-10 it does not go
    // to the log either. This branch receives whatever was thrown: a `pg`
    // error whose `detail` is the offending row, a filesystem error whose
    // message is an absolute path, a library error nobody here wrote. All of
    // it was measured being written out in full. What is recorded is that a
    // request failed unexpectedly, at this request id, on this route.
    request.log.error(
      { event: 'UNHANDLED_REQUEST_FAILURE', failure: 'UNEXPECTED' },
      'unhandled error while serving request',
    );
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
        // the network describes the deployment to anyone who asks — and the
        // reason itself is now one of four identifiers rather than the
        // driver's message, which was measured naming a host, a port and a
        // database account.
        request.log.warn(
          {
            event: 'HEALTH_UNAVAILABLE',
            healthReason: report.reason ?? 'UNKNOWN',
            latencyMs: report.latencyMs,
          },
          'health check reported unavailable',
        );
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
            throw new RequestContextUnavailableError('CONTEXT_NOT_ESTABLISHED');
          }

          // Read from the owner-scoped repository, never from a table.
          return { owner_id: context.repository.ownerId };
        },
      );

      registerProjectRoutes(scope, dependencies.projectEnvironmentService);
      registerProblemRoutes(scope, dependencies.problemService);
      registerProblemDeleteRoutes(scope, dependencies.problemDeleteService);
      registerExportRoutes(scope, dependencies.exportService);
      registerProblemStatusRoutes(scope, dependencies.problemStatusService);
      registerEventRoutes(scope, dependencies.eventService);
      registerVerificationRoutes(scope, dependencies.verificationService);
      registerRelationRoutes(scope, dependencies.relationService);
      registerUsageLogRoutes(scope, dependencies.usageLogService);
      registerChangeLogRoutes(scope, dependencies.changeLogService);
      registerMemoryControlRoutes(scope, dependencies.memoryControlService);
      registerProblemCloseRoutes(scope, dependencies.problemCloseService);
      registerSearchRoutes(scope, dependencies.retrievalSearchResolver);

      done();
    },
    { prefix: API_PREFIX },
  );

  return app;
}
