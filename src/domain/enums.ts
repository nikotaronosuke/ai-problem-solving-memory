/**
 * Closed value sets shared by the application and the database.
 *
 * Each set is declared once, as a readonly tuple, and its type is derived from
 * that tuple. There is no second hand-written list to drift from — adding a
 * value here is the only place it is written in TypeScript.
 *
 * The database enforces the same values through text-backed DOMAINs with CHECK
 * constraints (see `supabase/migrations/`). `tests/db/enums.integration.test.ts`
 * drives every value in these tuples through the real database, so a change
 * made here without the matching migration fails the test suite.
 *
 * Values are compared exactly: no trimming, no case folding.
 */

/**
 * Lifecycle of a Problem.
 *
 * `VERIFIED` additionally requires at least one successful Verification. That
 * rule is behaviour, not a value constraint, and is enforced from Phase 2.
 */
export const PROBLEM_STATUSES = [
  'INVESTIGATING',
  'FIX_CANDIDATE',
  'VERIFIED',
  'PAUSED',
  'CLOSED_UNRESOLVED',
] as const;
export type ProblemStatus = (typeof PROBLEM_STATUSES)[number];

/** Whether a fix addressed the cause or worked around it. Separate from status. */
export const FIX_KINDS = ['ROOT_FIX', 'WORKAROUND'] as const;
export type FixKind = (typeof FIX_KINDS)[number];

/**
 * Meaningful state changes while solving a Problem.
 *
 * `DISCOVERY` is a fact established by observation, kept distinct from
 * `HYPOTHESIS`. Dead ends are recorded, not discarded.
 */
export const EVENT_TYPES = [
  'HYPOTHESIS',
  'ATTEMPT',
  'DEAD_END',
  'DISCOVERY',
  'FIX',
  'USER_CORRECTION',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** How a fix was confirmed. A model asserting success is not a Verification. */
export const VERIFICATION_TYPES = [
  'TEST',
  'REAL_DEVICE',
  'BUILD',
  'API_RESULT',
  'DB_RESULT',
  'USER_CONFIRMATION',
] as const;
export type VerificationType = (typeof VERIFICATION_TYPES)[number];

/** How much the recorded conclusion can be relied on. */
export const CONFIDENCES = ['HIGH', 'MEDIUM', 'LOW', 'CONFLICTED'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

/**
 * Whether the Memory still describes current conditions.
 *
 * Age alone does not lower confidence; these are separate axes.
 */
export const FRESHNESSES = ['CURRENT', 'STALE_UNKNOWN', 'SUPERSEDED', 'INVALID'] as const;
export type Freshness = (typeof FRESHNESSES)[number];
