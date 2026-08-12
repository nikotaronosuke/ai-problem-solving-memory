/**
 * Text handling shared by the entities.
 *
 * Several entities carry optional free-form fields, and they all need "absent"
 * to have one representation rather than several that compare unequal.
 */

/**
 * Normalises an optional free-form field.
 *
 * Absent, empty and whitespace-only all collapse to null, so a field that was
 * never filled in and one filled in with spaces are the same absence.
 */
export function normaliseOptionalText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const normalised = value.trim();
  return normalised === '' ? null : normalised;
}
