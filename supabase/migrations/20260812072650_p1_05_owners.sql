-- P1-05: the ownership boundary.
--
-- `owner_id` is an identity the Memory Server manages itself. It is never an
-- AI vendor's account id, a GitHub user id, or anything derived from an
-- external provider — Memory must stay usable when the AI or the account
-- behind it changes.
--
-- The column has no default on purpose. The application supplies the id, so
-- ownership is always an explicit decision rather than something the database
-- invents on insert.
--
-- Nothing else belongs here yet: no email, username, provider, role or team.
-- Credentials and their lifecycle are a separate concern (P3-04), and HTTP
-- request auth context arrives with P2-01.
--
-- Supabase Auth is not involved, and no RLS policy is defined. Owner scoping
-- is enforced by the application boundary in this phase.

create table public.owners (
  owner_id uuid primary key,
  created_at timestamptz not null default now()
);

comment on table public.owners is
  'Ownership boundary for all Memory data. Identity is managed by the Memory '
  'Server and independent of any AI vendor or external provider account.';

comment on column public.owners.owner_id is
  'Supplied by the application, never defaulted by the database.';
