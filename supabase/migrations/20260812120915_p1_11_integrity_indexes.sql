-- P1-11: integrity and index review.
--
-- No new entity, no new value set, no new column. This is the pass across what
-- P1-06 to P1-10 built, and it changes only indexes — the audit found the
-- foreign keys, delete actions and NOT NULL policy already correct.
--
-- Audited and left alone:
--
--   * Every foreign key already deletes with RESTRICT. That is the schema-wide
--     policy, not five independent coincidences: Memory is the user's history
--     and evidence, and deleting a parent must never quietly take a subtree of
--     it. A hard delete stays an explicit, ordered operation for a later phase.
--   * Owner existence is guaranteed transitively along the composite chain, so
--     no redundant owner foreign keys are added.
--   * client_event_id is NOT NULL and unique per (owner_id, client_event_id)
--     within each of events and verifications. The namespaces stay separate:
--     an Event append and a Verification append are different writes.
--   * Required and nullable columns already match the intended policy. Nothing
--     is tightened just because it looks safe — a nullable column is nullable
--     because the value can genuinely be unknown.
--
-- Vector, embedding and full-text indexes belong to the retrieval phase.

-- Listing a problem's events reads
--   where owner_id = ? and problem_id = ? order by created_at, event_id
-- so one index covers the filter and the sort together. Its left prefix still
-- serves the foreign key and the delete-time RESTRICT check, which is why the
-- shorter index is dropped rather than kept alongside: two indexes with the
-- same leading columns cost writes and space for nothing.
drop index public.events_owner_id_problem_id_idx;

create index events_owner_problem_created_at_event_id_idx
  on public.events (owner_id, problem_id, created_at, event_id);

-- Verifications list the same way.
drop index public.verifications_owner_id_problem_id_idx;

create index verifications_owner_problem_created_at_verification_id_idx
  on public.verifications (owner_id, problem_id, created_at, verification_id);

-- Listing a project's problems newest-or-oldest first. This is a different
-- access path from the existing (owner_id, project_id, environment_id) index,
-- which exists for the environment foreign key and its RESTRICT check, so both
-- are kept.
create index problems_owner_project_created_at_problem_id_idx
  on public.problems (owner_id, project_id, created_at, problem_id);

-- Redundant: `projects_owner_id_project_id_key` is a unique index on
-- (owner_id, project_id), and its left prefix already serves every lookup by
-- owner alone.
drop index public.projects_owner_id_idx;

-- Redundant for the same reason: `environments_owner_project_environment_key`
-- is unique on (owner_id, project_id, environment_id), whose left prefix
-- covers (owner_id, project_id).
drop index public.environments_owner_id_project_id_idx;
