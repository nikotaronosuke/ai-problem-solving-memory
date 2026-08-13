/**
 * Closing a Problem.
 *
 * Registered inside the authenticated `/v1` scope, so every handler is reached
 * only after an owner has been established.
 *
 * One request for one act: the status settles, the fix kind is recorded if
 * there is one, and whatever the person wants to leave behind is written down.
 * All of it commits together, and it moves the version once.
 *
 * Only three targets are accepted — `VERIFIED`, `PAUSED`,
 * `CLOSED_UNRESOLVED`. Moving between working states is still
 * `POST /v1/problems/:problem_id/status-transitions`, which is unchanged; this
 * is the higher-level surface for ending, and it applies exactly the same
 * transition rules underneath. `VERIFIED` still needs a successful
 * Verification of the Problem's own: closing records a conclusion, it does not
 * substitute for earning one.
 *
 * The review summaries become ordinary Events. There is no Review resource
 * and no new event type — a review is a set of statements about the
 * investigation, and putting them anywhere else would leave the same
 * information in two places.
 *
 * `fix_kind` is writable here and nowhere else in this phase. The ordinary
 * Problem update still refuses it, because whether a fix addressed the cause
 * or worked around it is a conclusion rather than an edit.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';

import type {
  AuthenticatedRequestContext,
  CloseProblemCommand,
  ProblemCloseService,
} from '../app/index.js';
import { FIX_KINDS } from '../domain/enums.js';
import { CONCLUSION_PROBLEM_STATUSES } from '../domain/problem-status.js';
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

interface CloseProblemBody {
  expected_version: number;
  changed_by: string;
  target_status: (typeof CONCLUSION_PROBLEM_STATUSES)[number];
  fix_kind?: (typeof FIX_KINDS)[number] | null;
  final_cause_summary?: string;
  effective_direction?: string;
  dead_end_summary?: string;
  unresolved_points?: string;
}

export function registerProblemCloseRoutes(
  scope: FastifyInstance,
  service: ProblemCloseService,
): void {
  scope.post<{ Params: { problem_id: string }; Body: CloseProblemBody }>(
    '/problems/:problem_id/close',
    {
      schema: {
        operationId: 'closeProblem',
        summary: 'Conclude a problem and record the review',
        description:
          'Applies the same transition rules as the status route. Status, fix kind, review events and history commit together.',
        tags: ['Problems'],
        params: PROBLEM_ID_PARAMS_SCHEMA,
        body: {
          type: 'object',
          properties: {
            expected_version: EXPECTED_VERSION_SCHEMA,
            changed_by: NON_BLANK_STRING_SCHEMA,
            // The three ways a Problem stops being actively worked. The
            // working states are refused here rather than quietly accepted:
            // two surfaces doing the same move differently is worse than one
            // of them saying no.
            target_status: { type: 'string', enum: [...CONCLUSION_PROBLEM_STATUSES] },
            // Absent leaves it alone; null clears it. A separate axis from
            // status — a verified Problem may have no fix kind stated.
            fix_kind: { type: ['string', 'null'], enum: [...FIX_KINDS, null] },
            // Each becomes one Event, in the existing vocabulary. Non-blank
            // when present; absent simply means nothing to add, which is
            // reasonable when the history already says it.
            final_cause_summary: NON_BLANK_STRING_SCHEMA,
            effective_direction: NON_BLANK_STRING_SCHEMA,
            dead_end_summary: NON_BLANK_STRING_SCHEMA,
            unresolved_points: NON_BLANK_STRING_SCHEMA,
          },
          required: ['expected_version', 'changed_by', 'target_status'],
          // Refuses everything else: `status` and `version`, the identifiers
          // and timestamps, the flags, confidence and freshness. A conclusion
          // is a statement about how the work ended, not an opportunity to
          // edit the record.
          additionalProperties: false,
        },
        // 200: an existing Problem concluded, returned in the shape every
        // other Problem response uses.
        response: { 200: PROBLEM_RESOURCE_SCHEMA, ...COMMON_ERROR_RESPONSES },
      },
    },
    async (request) => {
      const body = request.body;
      const command: CloseProblemCommand = {
        expectedVersion: body.expected_version,
        changedBy: body.changed_by,
        targetStatus: body.target_status,
        ...(body.fix_kind !== undefined ? { fixKind: body.fix_kind } : {}),
        ...(body.final_cause_summary !== undefined
          ? { finalCauseSummary: body.final_cause_summary }
          : {}),
        ...(body.effective_direction !== undefined
          ? { effectiveDirection: body.effective_direction }
          : {}),
        ...(body.dead_end_summary !== undefined ? { deadEndSummary: body.dead_end_summary } : {}),
        ...(body.unresolved_points !== undefined
          ? { unresolvedPoints: body.unresolved_points }
          : {}),
      };

      const problem = await service.closeProblem(
        contextOf(request),
        request.params.problem_id,
        command,
      );
      return toProblemResource(problem);
    },
  );
}
