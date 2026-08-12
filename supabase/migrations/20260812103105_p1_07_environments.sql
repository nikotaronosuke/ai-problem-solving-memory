-- P1-07: environments.
--
-- An Environment is the conditions in place when a problem occurred. It is a
-- point in time: there is no `updated_at` and no update path, because changed
-- conditions are a new snapshot rather than an edit to an old one.
--
-- `environment_id` carries no database default, matching the other entities:
-- the application issues the id, so identity is an explicit decision.

-- The composite foreign key below needs a matching unique key to reference.
-- `project_id` is already unique on its own, so this adds no new restriction —
-- it only makes the (owner, project) pair addressable as a reference target.
-- The P1-06 migration is not modified.
alter table public.projects
  add constraint projects_owner_id_project_id_key unique (owner_id, project_id);

create table public.environments (
  environment_id uuid primary key,
  owner_id uuid not null,
  project_id uuid not null,

  -- One JSON object rather than a column per condition. Which conditions
  -- matter differs by project and by problem, so columns would mean either
  -- demanding values nobody has or migrating whenever a new one appears.
  --
  -- The object holds what is relevant to the problem. It is not a dependency
  -- dump, a log store or a place for secrets. Search-oriented derivatives are
  -- built separately in a later phase rather than by widening this.
  snapshot jsonb not null
    constraint environments_snapshot_is_object check (jsonb_typeof(snapshot) = 'object'),

  created_at timestamptz not null default now(),

  -- Owner and project are checked together, so an environment cannot pair one
  -- owner with another owner's project. Carrying owner_id directly also lets
  -- owner-scoped reads be enforced without a join.
  --
  -- This transitively guarantees the owner exists, since projects.owner_id
  -- already references owners. A separate owner foreign key would add nothing.
  constraint environments_owner_id_project_id_fkey
    foreign key (owner_id, project_id)
    references public.projects (owner_id, project_id)
    -- Deleting a project that still has environments must fail rather than
    -- silently discard them. The full delete lifecycle is settled in P1-11.
    on delete restrict
);

-- PostgreSQL does not index a foreign key automatically. Owner-scoped reads
-- and the delete-time RESTRICT check both depend on this one. Wider index
-- policy is settled in P1-11.
create index environments_owner_id_project_id_idx
  on public.environments (owner_id, project_id);

comment on table public.environments is
  'Point-in-time snapshot of the conditions relevant to a problem. Immutable.';

comment on column public.environments.environment_id is
  'Supplied by the application, never defaulted by the database.';

comment on column public.environments.snapshot is
  'JSON object of relevant conditions. Not a full dependency listing, log store or secret store.';
