/**
 * The Project as the JSON API returns it, and the check that it really is one.
 *
 * The same rules as `problem.ts`, for the same reasons: the wire shape rather
 * than a domain model, `snake_case` kept, timestamps left as strings, values
 * checked rather than trusted because they arrived over a network from a
 * process this one does not control.
 *
 * `repo` and `platform` are nullable free-form text on the server and are
 * mirrored that way here. Nothing in this package interprets either of them —
 * `repo` is a string the server stored, not a URL this package parses, and
 * whether two strings mean the same repository is a question for whoever is
 * comparing them.
 */

/**
 * A Project, exactly as the API sends one.
 *
 * No fields beyond these. The server declares the resource closed, so a body
 * carrying something else is a server this client does not understand rather
 * than a Project with an extra field.
 */
export interface ProjectResource {
  readonly project_id: string;
  readonly owner_id: string;
  readonly project_name: string;
  readonly repo: string | null;
  readonly platform: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** The fields a Project response must carry, in the contract's order. */
export const PROJECT_RESOURCE_FIELDS = [
  'project_id',
  'owner_id',
  'project_name',
  'repo',
  'platform',
  'created_at',
  'updated_at',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a parsed body is a Project this contract describes.
 *
 * A predicate rather than a parser: nothing is coerced, defaulted or dropped.
 * The key set is exact, because the server's schema says it is closed — a field
 * nobody here knows about means the two ends disagree about the contract, and
 * passing it through would let the disagreement travel.
 */
export function isProjectResource(value: unknown): value is ProjectResource {
  if (!isRecord(value)) {
    return false;
  }

  const actual = Object.keys(value);
  if (
    actual.length !== PROJECT_RESOURCE_FIELDS.length ||
    !PROJECT_RESOURCE_FIELDS.every((field) => field in value)
  ) {
    return false;
  }

  return (
    typeof value['project_id'] === 'string' &&
    typeof value['owner_id'] === 'string' &&
    typeof value['project_name'] === 'string' &&
    (value['repo'] === null || typeof value['repo'] === 'string') &&
    (value['platform'] === null || typeof value['platform'] === 'string') &&
    typeof value['created_at'] === 'string' &&
    typeof value['updated_at'] === 'string'
  );
}

/**
 * Whether a parsed body is the Project list envelope.
 *
 * The envelope has exactly one field. It is checked as closed like everything
 * else, and every element is checked — one malformed Project makes the whole
 * answer unreadable rather than being quietly skipped, because a list missing
 * a Project reads as an owner who does not have it.
 */
export function isProjectListBody(value: unknown): value is { projects: ProjectResource[] } {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || !('projects' in value)) {
    return false;
  }
  const projects = value['projects'];
  return Array.isArray(projects) && projects.every((entry) => isProjectResource(entry));
}
