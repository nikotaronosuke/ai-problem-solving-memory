/**
 * The search route.
 *
 * One operation, registered inside the authenticated `/v1` scope. It hangs off
 * the Problem being worked on because that Problem *is* the search context:
 * the subject the candidates are compared against, the source of the current
 * Project, and the one thing excluded from its own results. A collection route
 * would have to take the Problem in the body, which is the same fact with two
 * possible sources.
 *
 * ## What the handler does, and what it refuses to do
 *
 * It maps four fields, calls one service, and maps the answer. It does not
 * write a usage record — the search service records that a Memory was surfaced,
 * once per candidate, and a second write here would double every row. It does
 * not retry a search whose Problem moved underneath it: that outcome is
 * returned as it is, because whether to look again depends on what the caller
 * is doing. It does not pass a limit, a Project, or anything else the service
 * would accept but the API does not publish.
 *
 * ## The outcome mapping
 *
 * Three of the four outcomes are 200. A Problem whose owner turned automatic
 * reading off, and a Problem that changed mid-search, are ordinary answers
 * rather than faults — an error envelope would tell a caller something went
 * wrong when nothing did. The fourth, `CURRENT_PROBLEM_NOT_AVAILABLE`, is the
 * 404 every missing resource gets: the service already treats unknown, deleted
 * and another owner's as one answer, and this keeps them one answer at the
 * boundary too.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import type {
  AuthenticatedRequestContext,
  RetrievalSearchServiceResolver,
  RetrievalUsageLogFailure,
  RetrievalUsageLogFailureReporter,
} from '../app/index.js';
import { ResourceNotFoundError } from '../app/index.js';
import type { StructuralFeatures } from '../domain/retrieval-summary.js';
import { ERROR_RESPONSE_SCHEMA } from './errors.js';
import { PROBLEM_ID_PARAMS_SCHEMA } from './resources.js';
import {
  SEARCH_REQUEST_SCHEMA,
  SEARCH_RESPONSE_SCHEMA,
  toSearchResponseBody,
  type SearchRequestBody,
} from './search-resources.js';

/**
 * No 409. A search takes no `expected_version` — it writes nothing to the
 * Problem — so there is no conflict for it to report, and documenting one
 * would send a client looking for a version to re-read.
 */
const SEARCH_ERROR_RESPONSES = {
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

/**
 * Where a lost usage record is reported: the request's own logger, with the
 * closed report and nothing else.
 *
 * The failure carries a kind and a count, both chosen by this codebase. No
 * owner, no Problem, no Memory, no `source_ai`, no query, no features, no
 * driver message — a report travels to wherever an operator looks, and a
 * search request is made of somebody's own words about their own problem.
 *
 * It must not throw, and cannot: `log.warn` with a closed object is the whole
 * of it, and the surrounding `try` is what keeps a broken logger from turning
 * a lost log line into a lost search result.
 */
function usageLogFailureReporter(request: FastifyRequest): RetrievalUsageLogFailureReporter {
  return {
    report(failure: RetrievalUsageLogFailure): void {
      try {
        request.log.warn(
          {
            event: 'SEARCH_USAGE_LOG_WRITE_FAILED',
            kind: failure.kind,
            attemptedRows: failure.attemptedRows,
          },
          'a search result was not recorded in the usage log',
        );
      } catch {
        // Deliberately empty. The search succeeded; the report did not.
      }
    },
  };
}

export function registerSearchRoutes(
  scope: FastifyInstance,
  resolver: RetrievalSearchServiceResolver,
): void {
  scope.post<{ Params: { problem_id: string }; Body: SearchRequestBody }>(
    '/problems/:problem_id/search',
    {
      schema: {
        operationId: 'searchProblemMemory',
        summary: 'Find past memory worth reading for this problem',
        description:
          'Searches every Project this owner has. Returns candidates with the material to judge them — what each was true of, where it did and did not lead, and what contradicts it — never a recommendation. An empty list is an ordinary answer, and so are the two typed non-search outcomes.',
        tags: ['Search'],
        params: PROBLEM_ID_PARAMS_SCHEMA,
        body: SEARCH_REQUEST_SCHEMA,
        response: { 200: SEARCH_RESPONSE_SCHEMA, ...SEARCH_ERROR_RESPONSES },
      },
    },
    async (request) => {
      const context = contextOf(request);
      const body = request.body;

      const service = await resolver.resolve(context, usageLogFailureReporter(request));

      // Four fields in, four fields through. No Project, no limits: a search
      // is cross-project by default, the current Project is derived from the
      // Problem, and the stage bounds are the server's.
      //
      // `current_features` is cast to the domain type here and validated for
      // real inside the service — the schema above says what the API accepts,
      // and `parseStructuralFeatures` remains the authority on what the
      // application will act on.
      const outcome = await service.search(
        {
          currentProblemId: request.params.problem_id as never,
          lexicalText: body.lexical_text,
          semanticText: body.semantic_text,
          currentFeatures: body.current_features as unknown as StructuralFeatures,
        },
        { sourceAi: body.source_ai },
      );

      if (outcome.kind === 'CURRENT_PROBLEM_NOT_AVAILABLE') {
        // Unknown, deleted, or another owner's — one answer, as everywhere
        // else. Distinguishing them would confirm what the sameness hides.
        throw new ResourceNotFoundError();
      }

      return toSearchResponseBody(outcome);
    },
  );
}
