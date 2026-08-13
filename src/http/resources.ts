/**
 * How resources appear on the wire.
 *
 * Internal records are camelCase with `Date` objects; the API is snake_case
 * with ISO 8601 strings. Every field is mapped by hand rather than serialised
 * automatically, so a change to a record cannot silently change the public
 * contract — the two are allowed to differ, and this is where they are kept
 * deliberately apart.
 *
 * Each mapper has a schema beside it, so a response cannot document one shape
 * and send another.
 */

import type { EnvironmentRecord, EventRecord, ProblemRecord, ProjectRecord } from '../app/index.js';
import {
  CONFIDENCES,
  EVENT_TYPES,
  FIX_KINDS,
  FRESHNESSES,
  PROBLEM_STATUSES,
} from '../domain/enums.js';

export interface ProjectResource {
  readonly project_id: string;
  readonly owner_id: string;
  readonly project_name: string;
  readonly repo: string | null;
  readonly platform: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export function toProjectResource(record: ProjectRecord): ProjectResource {
  return {
    project_id: record.projectId,
    owner_id: record.ownerId,
    project_name: record.projectName,
    repo: record.repo,
    platform: record.platform,
    created_at: record.createdAt.toISOString(),
    updated_at: record.updatedAt.toISOString(),
  };
}

export const PROJECT_RESOURCE_SCHEMA = {
  type: 'object',
  properties: {
    project_id: { type: 'string', format: 'uuid' },
    owner_id: { type: 'string', format: 'uuid' },
    project_name: { type: 'string' },
    repo: { type: ['string', 'null'] },
    platform: { type: ['string', 'null'] },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
  required: [
    'project_id',
    'owner_id',
    'project_name',
    'repo',
    'platform',
    'created_at',
    'updated_at',
  ],
  additionalProperties: false,
} as const;

export interface EnvironmentResource {
  readonly environment_id: string;
  readonly owner_id: string;
  readonly project_id: string;
  readonly snapshot: Record<string, unknown>;
  readonly created_at: string;
}

export function toEnvironmentResource(record: EnvironmentRecord): EnvironmentResource {
  return {
    environment_id: record.environmentId,
    owner_id: record.ownerId,
    project_id: record.projectId,
    snapshot: record.snapshot,
    created_at: record.createdAt.toISOString(),
  };
}

export const ENVIRONMENT_RESOURCE_SCHEMA = {
  type: 'object',
  properties: {
    environment_id: { type: 'string', format: 'uuid' },
    owner_id: { type: 'string', format: 'uuid' },
    project_id: { type: 'string', format: 'uuid' },
    // The keys inside a snapshot are whatever the conditions were, so the
    // object is not constrained further. What it may not be — an array, a
    // string, a number — is enforced on the request side.
    snapshot: { type: 'object', additionalProperties: true },
    created_at: { type: 'string', format: 'date-time' },
  },
  required: ['environment_id', 'owner_id', 'project_id', 'snapshot', 'created_at'],
  additionalProperties: false,
} as const;

export interface ProblemResource {
  readonly problem_id: string;
  readonly owner_id: string;
  readonly project_id: string;
  readonly environment_id: string;
  readonly title: string;
  readonly symptoms: string;
  readonly problem_domain: string | null;
  readonly suspected_boundary: string | null;
  readonly source_ai: string | null;
  readonly status: string;
  readonly fix_kind: string | null;
  readonly importance: boolean;
  readonly confidence: string;
  readonly freshness: string;
  readonly memory_read_enabled: boolean;
  readonly memory_write_enabled: boolean;
  readonly suppressed: boolean;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * Maps a Problem for the wire.
 *
 * Every field is listed, including the ones a caller cannot set. `status`,
 * `fix_kind` and `version` are readable precisely because they are not
 * writable here: a client needs to see the state without being able to assert
 * it.
 */
export function toProblemResource(record: ProblemRecord): ProblemResource {
  return {
    problem_id: record.problemId,
    owner_id: record.ownerId,
    project_id: record.projectId,
    environment_id: record.environmentId,
    title: record.title,
    symptoms: record.symptoms,
    problem_domain: record.problemDomain,
    suspected_boundary: record.suspectedBoundary,
    source_ai: record.sourceAi,
    status: record.status,
    fix_kind: record.fixKind,
    importance: record.importance,
    confidence: record.confidence,
    freshness: record.freshness,
    memory_read_enabled: record.memoryReadEnabled,
    memory_write_enabled: record.memoryWriteEnabled,
    suppressed: record.suppressed,
    version: record.version,
    created_at: record.createdAt.toISOString(),
    updated_at: record.updatedAt.toISOString(),
  };
}

export const PROBLEM_RESOURCE_SCHEMA = {
  type: 'object',
  properties: {
    problem_id: { type: 'string', format: 'uuid' },
    owner_id: { type: 'string', format: 'uuid' },
    project_id: { type: 'string', format: 'uuid' },
    environment_id: { type: 'string', format: 'uuid' },
    title: { type: 'string' },
    symptoms: { type: 'string' },
    problem_domain: { type: ['string', 'null'] },
    suspected_boundary: { type: ['string', 'null'] },
    source_ai: { type: ['string', 'null'] },
    // The canonical value sets, pinned on the way out as well as the way in,
    // so a response cannot carry a value the contract does not name.
    status: { type: 'string', enum: [...PROBLEM_STATUSES] },
    fix_kind: { type: ['string', 'null'], enum: [...FIX_KINDS, null] },
    importance: { type: 'boolean' },
    confidence: { type: 'string', enum: [...CONFIDENCES] },
    freshness: { type: 'string', enum: [...FRESHNESSES] },
    memory_read_enabled: { type: 'boolean' },
    memory_write_enabled: { type: 'boolean' },
    suppressed: { type: 'boolean' },
    version: { type: 'integer', minimum: 1 },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
  required: [
    'problem_id',
    'owner_id',
    'project_id',
    'environment_id',
    'title',
    'symptoms',
    'problem_domain',
    'suspected_boundary',
    'source_ai',
    'status',
    'fix_kind',
    'importance',
    'confidence',
    'freshness',
    'memory_read_enabled',
    'memory_write_enabled',
    'suppressed',
    'version',
    'created_at',
    'updated_at',
  ],
  additionalProperties: false,
} as const;

export interface EventResource {
  readonly event_id: string;
  readonly owner_id: string;
  readonly problem_id: string;
  readonly event_type: string;
  readonly summary: string;
  readonly result: string | null;
  readonly reason: string | null;
  readonly source_ai: string | null;
  readonly evidence_ref: string | null;
  readonly client_event_id: string;
  readonly created_at: string;
}

/**
 * Maps an Event for the wire.
 *
 * `client_event_id` is echoed back deliberately. A client that retried needs
 * to see which of its writes it is holding, and the value was its own to begin
 * with.
 *
 * There is no `updated_at`, because there is nothing to update.
 */
export function toEventResource(record: EventRecord): EventResource {
  return {
    event_id: record.eventId,
    owner_id: record.ownerId,
    problem_id: record.problemId,
    event_type: record.eventType,
    summary: record.summary,
    result: record.result,
    reason: record.reason,
    source_ai: record.sourceAi,
    evidence_ref: record.evidenceRef,
    client_event_id: record.clientEventId,
    created_at: record.createdAt.toISOString(),
  };
}

export const EVENT_RESOURCE_SCHEMA = {
  type: 'object',
  properties: {
    event_id: { type: 'string', format: 'uuid' },
    owner_id: { type: 'string', format: 'uuid' },
    problem_id: { type: 'string', format: 'uuid' },
    event_type: { type: 'string', enum: [...EVENT_TYPES] },
    summary: { type: 'string' },
    result: { type: ['string', 'null'] },
    reason: { type: ['string', 'null'] },
    source_ai: { type: ['string', 'null'] },
    evidence_ref: { type: ['string', 'null'] },
    client_event_id: { type: 'string', format: 'uuid' },
    created_at: { type: 'string', format: 'date-time' },
  },
  required: [
    'event_id',
    'owner_id',
    'problem_id',
    'event_type',
    'summary',
    'result',
    'reason',
    'source_ai',
    'evidence_ref',
    'client_event_id',
    'created_at',
  ],
  additionalProperties: false,
} as const;

/** Path parameter shape for a problem id. */
export const PROBLEM_ID_PARAMS_SCHEMA = {
  type: 'object',
  properties: { problem_id: { type: 'string', format: 'uuid' } },
  required: ['problem_id'],
  additionalProperties: false,
} as const;

/** Path parameter shape for a project id. */
export const PROJECT_ID_PARAMS_SCHEMA = {
  type: 'object',
  properties: { project_id: { type: 'string', format: 'uuid' } },
  required: ['project_id'],
  additionalProperties: false,
} as const;

/** Path parameter shape for an environment id. */
export const ENVIRONMENT_ID_PARAMS_SCHEMA = {
  type: 'object',
  properties: { environment_id: { type: 'string', format: 'uuid' } },
  required: ['environment_id'],
  additionalProperties: false,
} as const;

/**
 * A non-blank string.
 *
 * `minLength: 1` would accept a single space. Names that are only whitespace
 * are refused here rather than left to the domain, so the client gets a 400
 * that says the request was invalid instead of a 500 from further in.
 */
export const NON_BLANK_STRING_SCHEMA = { type: 'string', pattern: '\\S' } as const;

/** An optional free-form field: a string, or null to clear it. */
export const NULLABLE_TEXT_SCHEMA = { type: ['string', 'null'] } as const;
