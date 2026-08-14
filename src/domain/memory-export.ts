/**
 * What an export of one owner's Memory is, as a format.
 *
 * The Memory is the user's, and an export is the form it takes when it leaves
 * this server — for a backup, for moving to another install, for reading with
 * something that is not this API. So the format is a thing in its own right,
 * with its own version, rather than a view of the current endpoints.
 *
 * That version is deliberately not the API contract version. The two move for
 * different reasons: P3-05 added a route and took the contract from 0.2.0 to
 * 0.3.0 while changing nothing about what an export contains. Sharing the
 * constant would tell whoever holds an artifact that its format had changed
 * when it had not, and the only safe response to that is to re-read the whole
 * file.
 *
 * A plain counter rather than semantic versioning. Semver promises three axes
 * of compatibility; the only question a reader of an artifact has is whether it
 * can read this one, which is one axis. A string rather than a number so that a
 * future `"2-draft"` needs no type change.
 */

/** The version of the export format itself. Not the API contract version. */
export const MEMORY_EXPORT_SCHEMA_VERSION = '1';

/**
 * An export, as JSON text.
 *
 * Deliberately not a parsed object, and the wrapper exists to make that hard to
 * forget. The artifact is assembled by PostgreSQL and carries two things
 * JavaScript cannot hold without losing them:
 *
 * Timestamps to the microsecond. `timestamptz` keeps six fractional digits; a
 * JS `Date` keeps three. Anything that passes through one has silently dropped
 * the rest.
 *
 * Numbers beyond `Number.MAX_SAFE_INTEGER`. An environment snapshot is
 * whatever the conditions were — a build number, a nanosecond clock — and
 * `JSON.parse` turns 12345678901234567890 into 12345678901234567000 without
 * complaining.
 *
 * So the text is what is real, and `JSON.parse(...)` followed by
 * `JSON.stringify(...)` is not a round trip. Inspecting a parsed copy is fine;
 * sending one is not.
 */
export interface MemoryExportArtifact {
  /** The complete export document, exactly as the database produced it. */
  readonly json: string;
}
