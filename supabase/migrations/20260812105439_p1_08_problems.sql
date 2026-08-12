-- P1-08: problems.
--
-- The centre of the Memory model. This migration establishes storage only.
-- The rule that VERIFIED requires a successful Verification, the wider state
-- transition rules, and optimistic locking on `version` are Phase 2. The
-- schema leaves room for them without pretending to enforce them here.
--
-- `problem_id` carries no database default, matching the other entities.

-- The composite foreign key below needs a matching unique key to reference.
-- `environment_id` is already unique on its own, so this adds no new
-- restriction — it only makes the (owner, project, environment) triple
-- addressable as a reference target. The P1-07 migration is not modified.
alter table public.environments
  add constraint environments_owner_project_environment_key
  unique (owner_id, project_id, environment_id);

create table public.problems (
  problem_id uuid primary key,
  owner_id uuid not null,
  project_id uuid not null,

  -- Required. A Problem always occurred under some set of conditions. When
  -- those conditions have not been captured, the Environment carries an empty
  -- snapshot rather than the Problem carrying no environment at all — one
  -- representation of "not known yet", not two.
  environment_id uuid not null,

  title text not null
    constraint problems_title_not_blank check (btrim(title) <> ''),

  -- Free-form text rather than an array or a structured shape. Several
  -- symptoms read perfectly well in prose, and fixing a symptom taxonomy now
  -- would commit to categories the retrieval work has not justified.
  symptoms text not null
    constraint problems_symptoms_not_blank check (btrim(symptoms) <> ''),

  -- Unknown at the start of an investigation is normal, so these are nullable
  -- and unconstrained. Blank is normalised to null by the application.
  problem_domain text,
  suspected_boundary text,

  -- Which AI recorded this, when one did. Nullable and free-form: manual and
  -- imported entries exist too, and no vendor's identifier shape is baked in.
  source_ai text,

  -- A new Problem starts under investigation.
  status public.problem_status not null default 'INVESTIGATING',

  -- Null until a fix direction is known. ROOT_FIX and WORKAROUND are a
  -- separate axis from status, not a later stage of it.
  fix_kind public.fix_kind,

  -- "This matters", set by the user. Completely independent of confidence:
  -- important does not mean correct, and correct does not mean important.
  -- A boolean because the specification gives no basis for a score or scale.
  importance boolean not null default false,

  -- A new Problem has not been verified, so it starts at the lowest
  -- confidence rather than being assumed sound.
  confidence public.confidence not null default 'LOW',
  freshness public.freshness not null default 'CURRENT',

  -- Three independent controls. Suppression means "surface this less", which
  -- is not the same as switching reads off, and neither is deletion.
  memory_read_enabled boolean not null default true,
  memory_write_enabled boolean not null default true,
  suppressed boolean not null default false,

  -- Present from the start so Phase 2 can add optimistic locking without a
  -- backfill. Nothing increments it yet.
  version integer not null default 1
    constraint problems_version_positive check (version >= 1),

  created_at timestamptz not null default now(),
  -- No trigger. Phase 2's update path sets this and `version` explicitly, so
  -- that a write which forgets to is a visible bug rather than a hidden fix.
  updated_at timestamptz not null default now(),

  -- Owner, project and environment are checked as one triple, so a Problem
  -- cannot reference another owner's environment, or an environment belonging
  -- to a different project than the one named here.
  --
  -- The environment's existence transitively guarantees the project's and the
  -- owner's, so no further foreign key is needed.
  constraint problems_owner_project_environment_fkey
    foreign key (owner_id, project_id, environment_id)
    references public.environments (owner_id, project_id, environment_id)
    -- An environment a Problem depends on cannot be deleted out from under it.
    -- The full delete lifecycle is settled in P1-11.
    on delete restrict
);

-- PostgreSQL does not index a foreign key automatically. Owner-scoped reads
-- and the delete-time RESTRICT check both depend on this one. Retrieval
-- indexes belong to the search phase, not here.
create index problems_owner_id_project_id_environment_id_idx
  on public.problems (owner_id, project_id, environment_id);

comment on table public.problems is
  'A problem being solved, or already solved, within one project environment.';

comment on column public.problems.problem_id is
  'Supplied by the application, never defaulted by the database.';

comment on column public.problems.importance is
  'User-facing "this matters" flag. Independent of confidence.';

comment on column public.problems.version is
  'Reserved for optimistic locking in Phase 2. Not incremented yet.';
