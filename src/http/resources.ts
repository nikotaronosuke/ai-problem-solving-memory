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

import type {
  ChangeLogRecord,
  EnvironmentRecord,
  EventRecord,
  ProblemRecord,
  ProjectRecord,
  RelationRecord,
  UsageLogRecord,
  VerificationRecord,
} from '../app/index.js';
import {
  CONFIDENCES,
  EVENT_TYPES,
  FIX_KINDS,
  FRESHNESSES,
  PROBLEM_STATUSES,
  RELATION_TYPES,
  USAGE_ACTIONS,
  VERIFICATION_TYPES,
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

export interface VerificationResource {
  readonly verification_id: string;
  readonly owner_id: string;
  readonly problem_id: string;
  readonly verification_type: string;
  readonly result: boolean;
  readonly summary: string;
  readonly evidence_ref: string | null;
  readonly verified_by: string | null;
  readonly client_event_id: string;
  readonly created_at: string;
}

/**
 * Maps a Verification for the wire.
 *
 * `result` is a boolean and stays one. True means a check was carried out and
 * confirmed the state; false means it was carried out and did not. Neither
 * means "not checked yet" — that is the absence of a Verification. Widening
 * this to a string or a nullable would let the third meaning in through the
 * back door, and P2-06 has to be able to find a successful check
 * mechanically.
 *
 * There is no `updated_at`, because there is nothing to update.
 */
export function toVerificationResource(record: VerificationRecord): VerificationResource {
  return {
    verification_id: record.verificationId,
    owner_id: record.ownerId,
    problem_id: record.problemId,
    verification_type: record.verificationType,
    result: record.result,
    summary: record.summary,
    evidence_ref: record.evidenceRef,
    verified_by: record.verifiedBy,
    client_event_id: record.clientEventId,
    created_at: record.createdAt.toISOString(),
  };
}

export const VERIFICATION_RESOURCE_SCHEMA = {
  type: 'object',
  properties: {
    verification_id: { type: 'string', format: 'uuid' },
    owner_id: { type: 'string', format: 'uuid' },
    problem_id: { type: 'string', format: 'uuid' },
    verification_type: { type: 'string', enum: [...VERIFICATION_TYPES] },
    result: { type: 'boolean' },
    summary: { type: 'string' },
    evidence_ref: { type: ['string', 'null'] },
    verified_by: { type: ['string', 'null'] },
    client_event_id: { type: 'string', format: 'uuid' },
    created_at: { type: 'string', format: 'date-time' },
  },
  required: [
    'verification_id',
    'owner_id',
    'problem_id',
    'verification_type',
    'result',
    'summary',
    'evidence_ref',
    'verified_by',
    'client_event_id',
    'created_at',
  ],
  additionalProperties: false,
} as const;

export interface RelationResource {
  readonly relation_id: string;
  readonly owner_id: string;
  readonly from_id: string;
  readonly to_id: string;
  readonly relation_type: string;
  readonly reason: string;
  readonly created_at: string;
}

/**
 * Maps a Relation for the wire.
 *
 * `from_id` and `to_id` are reported as stored, never flipped to suit whose
 * list is being read. A link recorded as A supersedes B reads that way from
 * B's relations too — reversing it would state the opposite of what someone
 * recorded.
 *
 * There is no `updated_at` and no `version`, because there is no update path.
 */
export function toRelationResource(record: RelationRecord): RelationResource {
  return {
    relation_id: record.relationId,
    owner_id: record.ownerId,
    from_id: record.fromId,
    to_id: record.toId,
    relation_type: record.relationType,
    reason: record.reason,
    created_at: record.createdAt.toISOString(),
  };
}

export const RELATION_RESOURCE_SCHEMA = {
  type: 'object',
  properties: {
    relation_id: { type: 'string', format: 'uuid' },
    owner_id: { type: 'string', format: 'uuid' },
    from_id: { type: 'string', format: 'uuid' },
    to_id: { type: 'string', format: 'uuid' },
    relation_type: { type: 'string', enum: [...RELATION_TYPES] },
    reason: { type: 'string' },
    created_at: { type: 'string', format: 'date-time' },
  },
  required: [
    'relation_id',
    'owner_id',
    'from_id',
    'to_id',
    'relation_type',
    'reason',
    'created_at',
  ],
  additionalProperties: false,
} as const;

export interface UsageLogResource {
  readonly usage_log_id: string;
  readonly owner_id: string;
  readonly problem_id: string;
  readonly source_ai: string;
  readonly action: string;
  readonly memory_id: string;
  readonly reason: string;
  readonly result: string | null;
  readonly created_at: string;
}

/**
 * Maps a UsageLog for the wire.
 *
 * `problem_id` is the problem being worked on; `memory_id` is the past problem
 * that was used. They are allowed to be equal — continuing an investigation
 * under a different AI is a real case.
 *
 * `result` is null when the outcome is not known yet, which is the ordinary
 * state for a memory that was merely found or read.
 *
 * There is no `updated_at` and no `version`, because there is no update path.
 */
export function toUsageLogResource(record: UsageLogRecord): UsageLogResource {
  return {
    usage_log_id: record.usageLogId,
    owner_id: record.ownerId,
    problem_id: record.problemId,
    source_ai: record.sourceAi,
    action: record.action,
    memory_id: record.memoryId,
    reason: record.reason,
    result: record.result,
    created_at: record.createdAt.toISOString(),
  };
}

export const USAGE_LOG_RESOURCE_SCHEMA = {
  type: 'object',
  properties: {
    usage_log_id: { type: 'string', format: 'uuid' },
    owner_id: { type: 'string', format: 'uuid' },
    problem_id: { type: 'string', format: 'uuid' },
    source_ai: { type: 'string' },
    action: { type: 'string', enum: [...USAGE_ACTIONS] },
    memory_id: { type: 'string', format: 'uuid' },
    reason: { type: 'string' },
    result: { type: ['string', 'null'] },
    created_at: { type: 'string', format: 'date-time' },
  },
  required: [
    'usage_log_id',
    'owner_id',
    'problem_id',
    'source_ai',
    'action',
    'memory_id',
    'reason',
    'result',
    'created_at',
  ],
  additionalProperties: false,
} as const;

export interface ChangeLogResource {
  readonly change_log_id: string;
  readonly owner_id: string;
  readonly problem_id: string;
  readonly changed_by: string;
  readonly from_version: number;
  readonly to_version: number;
  readonly changes: Record<string, unknown>;
  readonly created_at: string;
}

/**
 * Maps a ChangeLog entry for the wire.
 *
 * `changes` passes through as stored. Its shape is decided in
 * `src/domain/change-log.ts` — controlled values exact, free text described
 * rather than copied — and reshaping it here would put that rule in two
 * places.
 *
 * There is no `updated_at` and no `version`: an entry is a statement about a
 * moment, and there is no path that edits one.
 */
export function toChangeLogResource(record: ChangeLogRecord): ChangeLogResource {
  return {
    change_log_id: record.changeLogId,
    owner_id: record.ownerId,
    problem_id: record.problemId,
    changed_by: record.changedBy,
    from_version: record.fromVersion,
    to_version: record.toVersion,
    changes: record.changes,
    created_at: record.createdAt.toISOString(),
  };
}

export const CHANGE_LOG_RESOURCE_SCHEMA = {
  type: 'object',
  properties: {
    change_log_id: { type: 'string', format: 'uuid' },
    owner_id: { type: 'string', format: 'uuid' },
    problem_id: { type: 'string', format: 'uuid' },
    changed_by: { type: 'string' },
    from_version: { type: 'integer', minimum: 1 },
    to_version: { type: 'integer', minimum: 2 },
    // Keys are field names and values describe how each moved. Left
    // unconstrained here for the same reason a snapshot is: the shape belongs
    // to the layer that decides it.
    changes: { type: 'object', additionalProperties: true },
    created_at: { type: 'string', format: 'date-time' },
  },
  required: [
    'change_log_id',
    'owner_id',
    'problem_id',
    'changed_by',
    'from_version',
    'to_version',
    'changes',
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

/**
 * The version a caller believes it is acting on.
 *
 * A whole number from 1, matching `version` on the way out. `integer` rather
 * than `number` and no coercion, so `"2"`, `2.5`, `true` and null are refused
 * rather than quietly reinterpreted — a concurrency token that can be
 * misread is not one.
 */
export const EXPECTED_VERSION_SCHEMA = { type: 'integer', minimum: 1 } as const;
