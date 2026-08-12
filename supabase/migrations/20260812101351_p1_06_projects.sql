-- P1-06: projects.
--
-- A project is the long-lived unit development happens in. Environment is a
-- separate concern — the conditions at the moment a problem occurred — and is
-- not folded in here.
--
-- `project_id` carries no database default, matching `owners.owner_id`: the
-- application issues the id, so identity is always an explicit decision. It is
-- not derived from a repository or a hosting provider.
--
-- `repo` and `platform` are nullable free-form text on purpose. A project may
-- have no repository, its platform may be undetermined, and detecting either
-- from the working directory is not part of this phase. Constraining them to a
-- provider's shape, an enum or a URL format now would bake in an assumption
-- that the retrieval work has not yet justified.

create table public.projects (
  project_id uuid primary key,
  owner_id uuid not null
    references public.owners (owner_id)
    -- Deleting an owner with projects must fail rather than silently take the
    -- Memory with it. The full delete lifecycle is settled in P1-11.
    on delete restrict,
  project_name text not null
    constraint projects_project_name_not_blank check (btrim(project_name) <> ''),
  repo text,
  platform text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- PostgreSQL does not index a foreign key automatically. Owner-scoped reads
-- and the delete-time RESTRICT check both depend on this one. Wider index
-- policy is settled in P1-11.
create index projects_owner_id_idx on public.projects (owner_id);

comment on table public.projects is
  'Long-lived development unit, owned by exactly one owner.';

comment on column public.projects.project_id is
  'Supplied by the application, never defaulted by the database.';

comment on column public.projects.repo is
  'Free-form repository reference. Null when the project has none or it is unknown.';

comment on column public.projects.platform is
  'Free-form platform label. Null when undetermined.';
