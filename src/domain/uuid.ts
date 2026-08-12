/**
 * UUID handling shared by the identifier types.
 *
 * Every entity id in this service is a UUID the application issues, so the
 * layout check lives in one place rather than being restated per entity where
 * the copies could drift.
 */

/**
 * RFC 4122 layout, versions 1–8 with a valid variant nibble.
 *
 * The all-zero nil UUID fails this, which is intended: it is a placeholder,
 * not an identity.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Whether a value is already a well-formed, normalised UUID. */
export function isNormalisedUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * Trims and lowercases a UUID, or returns undefined if it is not one.
 *
 * UUIDs are case-insensitive and PostgreSQL returns them lowercase, so values
 * are normalised on the way in. Otherwise the same identity could compare
 * unequal depending on which side it came from.
 */
export function normaliseUuid(value: string): string | undefined {
  const normalised = value.trim().toLowerCase();
  return UUID_PATTERN.test(normalised) ? normalised : undefined;
}
