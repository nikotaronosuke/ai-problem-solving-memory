/**
 * Pairs each application value set with the PostgreSQL DOMAIN that enforces it.
 *
 * This lives in the database boundary rather than in `src/domain/`, because the
 * domain layer should not know persistence names. It is the one place stating
 * which SQL object backs which TypeScript set, so tests and later column
 * definitions do not each restate the mapping.
 *
 * The DOMAINs are created in `supabase/migrations/`.
 */

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

export interface EnumDomainBinding {
  /** Unqualified name of the PostgreSQL DOMAIN. */
  readonly domainName: string;
  /** Name of its CHECK constraint, as declared in the migration. */
  readonly constraintName: string;
  /** The values the application considers valid. */
  readonly values: readonly string[];
}

export const ENUM_DOMAIN_SCHEMA = 'public';

export const ENUM_DOMAIN_BINDINGS: readonly EnumDomainBinding[] = [
  {
    domainName: 'problem_status',
    constraintName: 'problem_status_allowed_values',
    values: PROBLEM_STATUSES,
  },
  {
    domainName: 'fix_kind',
    constraintName: 'fix_kind_allowed_values',
    values: FIX_KINDS,
  },
  {
    domainName: 'event_type',
    constraintName: 'event_type_allowed_values',
    values: EVENT_TYPES,
  },
  {
    domainName: 'verification_type',
    constraintName: 'verification_type_allowed_values',
    values: VERIFICATION_TYPES,
  },
  {
    domainName: 'relation_type',
    constraintName: 'relation_type_allowed_values',
    values: RELATION_TYPES,
  },
  {
    domainName: 'usage_action',
    constraintName: 'usage_action_allowed_values',
    values: USAGE_ACTIONS,
  },
  {
    domainName: 'confidence',
    constraintName: 'confidence_allowed_values',
    values: CONFIDENCES,
  },
  {
    domainName: 'freshness',
    constraintName: 'freshness_allowed_values',
    values: FRESHNESSES,
  },
];
