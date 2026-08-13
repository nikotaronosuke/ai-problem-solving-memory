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

import type { EnvironmentRecord, ProjectRecord } from '../app/index.js';

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
