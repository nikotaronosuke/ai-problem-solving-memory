-- P1-10: verifications.
--
-- A Verification is not the fix. It is the record of something actually
-- checking whether the state holds: a test run, a build, a real device, an API
-- or database result, a person confirming it. Keeping the fix and the
-- confirmation as separate records is the point — an assistant reporting "it
-- works" is not evidence that it does.
--
-- A Verification belongs to the Problem directly, never to an Event. A Problem
-- may have a Verification and no Events at all, and the record still means
-- exactly what it says.
--
-- Append-only, like events: no `updated_at`, no trigger, no update path. A
-- later check is another Verification.
--
-- The (owner_id, problem_id) unique key this references already exists from
-- P1-09. No new key is added to `problems`, and no earlier migration changes.

create table public.verifications (
  verification_id uuid primary key,
  owner_id uuid not null,
  problem_id uuid not null,

  -- How the check was carried out.
  verification_type public.verification_type not null,

  -- Whether the check confirmed the state. A boolean rather than free text
  -- because P2-06 has to answer "is there at least one successful
  -- Verification?" mechanically, and prose cannot be judged that way.
  --
  -- true  = carried out, and the state was confirmed
  -- false = carried out, and the state was not confirmed
  --
  -- The account of what happened goes in `summary`.
  result boolean not null,

  -- What was checked and what came of it. Short: raw logs and full responses
  -- belong at the other end of `evidence_ref`.
  summary text not null
    constraint verifications_summary_not_blank check (btrim(summary) <> ''),

  -- A pointer to the material, not the material itself. Same shape as events:
  -- free-form text, no URL type, no provider format, no structure until there
  -- is evidence for what structure it needs.
  evidence_ref text,

  -- Who or what actually performed the check — a person, a test runner, CI, a
  -- build, a device operator, an assistant. Free-form and nullable: an unknown
  -- verifier should be absent rather than filled with a plausible-looking
  -- placeholder that would misrepresent the evidence.
  --
  -- Distinct from verification_type, which is how, and evidence_ref, which is
  -- where to look.
  verified_by text,

  -- Issued by the client before its first attempt and reused on retry.
  client_event_id uuid not null,

  created_at timestamptz not null default now(),

  constraint verifications_owner_id_problem_id_fkey
    foreign key (owner_id, problem_id)
    references public.problems (owner_id, problem_id)
    -- A Problem with evidence cannot be deleted out from under it.
    -- The full delete lifecycle is settled in P1-11.
    on delete restrict,

  -- Scoped to this table, not shared with events. An Event append and a
  -- Verification append are separate writes, so the same value may appear once
  -- in each. A single identifier spanning every kind of write would be a
  -- different concept, and would be added as one rather than by overloading
  -- this column.
  constraint verifications_owner_id_client_event_id_key unique (owner_id, client_event_id)
);

-- PostgreSQL does not index a foreign key automatically. Listing a Problem's
-- verifications and the delete-time RESTRICT check both depend on this one.
-- The unique constraint above provides its own index.
create index verifications_owner_id_problem_id_idx
  on public.verifications (owner_id, problem_id);

comment on table public.verifications is
  'Append-only evidence that a problem state was actually checked. Independent of events.';

comment on column public.verifications.verification_id is
  'Supplied by the application, never defaulted by the database.';

comment on column public.verifications.result is
  'Whether the check confirmed the state. Machine-judgeable, unlike prose.';

comment on column public.verifications.verified_by is
  'Who or what performed the check. Null when unknown, never a placeholder.';
