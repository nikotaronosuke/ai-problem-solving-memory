-- P1-03 baseline migration.
--
-- Purpose: prove that the migration pipeline is in place and re-appliable to a
-- clean database. This migration deliberately makes no schema change.
--
-- No domain schema is defined here on purpose. Owner, Project, Environment,
-- Problem, Event, Verification and Relation are designed from P1-04 onward, and
-- committing to any of their shapes now would pre-empt that design.
--
-- Applying this file registers it in `supabase_migrations.schema_migrations`,
-- which is what makes migration ordering and re-application observable.

select 1;
