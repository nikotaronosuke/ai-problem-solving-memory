-- P1-04: shared value sets, enforced by the database.
--
-- These are text-backed DOMAINs with named CHECK constraints, not PostgreSQL
-- native ENUM types. A domain can be defined before any table exists, changing
-- the allowed set is an ordinary migration rather than an enum type surgery,
-- and columns from P1-06 onward reuse the domain by name.
--
-- The same values are declared in `src/domain/enums.ts`. They must match
-- exactly; `tests/db/enums.integration.test.ts` drives every TypeScript value
-- through these domains to keep the two from drifting.
--
-- Nullability is deliberately not constrained here. Whether a particular
-- column may be null belongs to that column, not to the value set.
--
-- No table is created by this migration.

-- Lifecycle of a Problem.
create domain public.problem_status as text
  constraint problem_status_allowed_values check (
    value in (
      'INVESTIGATING',
      'FIX_CANDIDATE',
      'VERIFIED',
      'PAUSED',
      'CLOSED_UNRESOLVED'
    )
  );

comment on domain public.problem_status is
  'Problem lifecycle. Mirrors ProblemStatus in src/domain/enums.ts.';

-- Whether a fix addressed the cause or worked around it.
create domain public.fix_kind as text
  constraint fix_kind_allowed_values check (
    value in (
      'ROOT_FIX',
      'WORKAROUND'
    )
  );

comment on domain public.fix_kind is
  'Fix classification. Mirrors FixKind in src/domain/enums.ts.';

-- Meaningful state changes while solving a Problem.
create domain public.event_type as text
  constraint event_type_allowed_values check (
    value in (
      'HYPOTHESIS',
      'ATTEMPT',
      'DEAD_END',
      'DISCOVERY',
      'FIX',
      'USER_CORRECTION'
    )
  );

comment on domain public.event_type is
  'Event classification. Mirrors EventType in src/domain/enums.ts.';

-- How a fix was confirmed.
create domain public.verification_type as text
  constraint verification_type_allowed_values check (
    value in (
      'TEST',
      'REAL_DEVICE',
      'BUILD',
      'API_RESULT',
      'DB_RESULT',
      'USER_CONFIRMATION'
    )
  );

comment on domain public.verification_type is
  'Verification method. Mirrors VerificationType in src/domain/enums.ts.';

-- How much the recorded conclusion can be relied on.
create domain public.confidence as text
  constraint confidence_allowed_values check (
    value in (
      'HIGH',
      'MEDIUM',
      'LOW',
      'CONFLICTED'
    )
  );

comment on domain public.confidence is
  'Confidence level. Mirrors Confidence in src/domain/enums.ts.';

-- Whether the Memory still describes current conditions.
create domain public.freshness as text
  constraint freshness_allowed_values check (
    value in (
      'CURRENT',
      'STALE_UNKNOWN',
      'SUPERSEDED',
      'INVALID'
    )
  );

comment on domain public.freshness is
  'Freshness of the Memory relative to current conditions. '
  'Mirrors Freshness in src/domain/enums.ts.';
