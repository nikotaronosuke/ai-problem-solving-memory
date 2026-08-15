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

/**
 * The characters the database's own blank checks treat as nothing.
 *
 * Spelled out rather than left to `\s`, which also matches a non-breaking
 * space: a value this refused but the column accepted would be a disagreement
 * about what blank means, and the column is the one that decides.
 *
 * Deliberately not the same rule as `normaliseOptionalText` above, which uses
 * `String.prototype.trim` and so treats a non-breaking space as absence. That
 * one normalises a field on its way in and answers to nothing but itself; this
 * one has to agree with a `CHECK` constraint, and agreeing is the whole point.
 */
const BLANK_CHARACTERS: ReadonlySet<string> = new Set([' ', '\t', '\r', '\n', '\f', '\v']);

/** Whether a string holds nothing the database would consider content. */
export function isBlankText(value: string): boolean {
  for (const character of value) {
    if (!BLANK_CHARACTERS.has(character)) {
      return false;
    }
  }
  return true;
}
