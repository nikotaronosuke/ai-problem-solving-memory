/**
 * The Environment as the JSON API returns one, and what may be sent to make it.
 *
 * An Environment is a point in time: the conditions a Problem was found under,
 * recorded once and never updated or deleted. That is why the snapshot is the
 * only free-form thing in this contract — which conditions mattered is a
 * question about the problem, not about the schema — and why what may go inside
 * it is checked strictly all the same. Free-form is not the same as unchecked,
 * and the difference is whether a stored snapshot says what somebody meant.
 *
 * Same rules as the other resources here: the wire shape rather than a domain
 * model, `snake_case` kept, timestamps left as strings, and every value checked
 * because it arrived from a process this one does not control.
 */

import { isJsonObject, type JsonObject } from './json.js';

/** An Environment, exactly as the API sends one. */
export interface EnvironmentResource {
  readonly environment_id: string;
  readonly owner_id: string;
  readonly project_id: string;
  readonly snapshot: JsonObject;
  readonly created_at: string;
}

/** The fields an Environment response must carry, in the contract's order. */
export const ENVIRONMENT_RESOURCE_FIELDS = [
  'environment_id',
  'owner_id',
  'project_id',
  'snapshot',
  'created_at',
] as const;

/** What creating an Environment sends. One field, and it is the snapshot. */
export interface CreateEnvironmentRequest {
  readonly snapshot: JsonObject;
}

/** The fields a create request may carry. Exactly one. */
export const CREATE_ENVIRONMENT_REQUEST_FIELDS = ['snapshot'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a parsed body is an Environment this contract describes.
 *
 * Exact key set, because the server declares the resource closed. The snapshot
 * is checked with the same predicate an outbound one is: this type declares it
 * a `JsonObject`, and a value that does not satisfy that is not one whatever
 * direction it arrived from.
 *
 * "It was parsed from JSON, so it is JSON" is nearly true and not true enough.
 * `JSON.parse` reads `1e999` as `Infinity`, so a body from a proxy, a
 * rewriting intermediary or a server this contract does not describe can hand
 * back a number JavaScript has and JSON does not — and it would then be
 * returned as a `JsonObject` that cannot be serialised back into one.
 */
export function isEnvironmentResource(value: unknown): value is EnvironmentResource {
  if (!isRecord(value)) {
    return false;
  }

  const actual = Object.keys(value);
  if (
    actual.length !== ENVIRONMENT_RESOURCE_FIELDS.length ||
    !ENVIRONMENT_RESOURCE_FIELDS.every((field) => field in value)
  ) {
    return false;
  }

  return (
    typeof value['environment_id'] === 'string' &&
    typeof value['owner_id'] === 'string' &&
    typeof value['project_id'] === 'string' &&
    isJsonObject(value['snapshot']) &&
    typeof value['created_at'] === 'string'
  );
}

/**
 * Whether a request is one this client will send.
 *
 * Checked before anything is serialised, so a snapshot carrying something JSON
 * cannot express is reported rather than silently rewritten on the way out.
 */
export function isCreateEnvironmentRequest(value: unknown): value is CreateEnvironmentRequest {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length !== CREATE_ENVIRONMENT_REQUEST_FIELDS.length || !('snapshot' in value)) {
    return false;
  }
  return isJsonObject(value['snapshot']);
}
