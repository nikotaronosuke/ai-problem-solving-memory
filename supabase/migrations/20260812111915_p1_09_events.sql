-- P1-09: events.
--
-- The append-only record of what happened while solving a Problem. Dead ends
-- are kept alongside successes: knowing which direction did not work is half
-- of what makes past experience reusable.
--
-- There is no update path and no `updated_at`. An Event states what was true
-- at the moment it was recorded; a later correction is another Event, which is
-- what USER_CORRECTION is for.
--
-- This is not a place for raw conversations, raw logs or code dumps. The
-- columns hold what was tried and what was learned, and `evidence_ref` points
-- at the material rather than containing it.

-- The composite foreign key below needs a matching unique key to reference.
-- `problem_id` is already unique on its own, so this adds no new restriction —
-- it only makes the (owner, problem) pair addressable as a reference target.
-- The P1-08 migration is not modified.
alter table public.problems
  add constraint problems_owner_id_problem_id_key unique (owner_id, problem_id);

create table public.events (
  event_id uuid primary key,
  owner_id uuid not null,
  problem_id uuid not null,

  event_type public.event_type not null,

  -- What happened. Required: an Event with nothing to say records that
  -- something occurred without recording what.
  summary text not null
    constraint events_summary_not_blank check (btrim(summary) <> ''),

  -- What came of it, and why. Not every kind of Event has both — a hypothesis
  -- has no result yet, and an attempt may have no reason beyond the attempt.
  result text,
  reason text,

  -- Which AI recorded this, when one did. Nullable and free-form: manual
  -- entries, imports and user corrections exist too.
  source_ai text,

  -- A pointer to the material, not the material: a repo path, a commit, an
  -- issue or PR, a test name, where a log was kept, an official document, a
  -- note about a device check. Free-form text in the MVP — no URL type, no
  -- provider format, no structure for multiple references until there is
  -- evidence for what that structure should be.
  evidence_ref text,

  -- Issued by the client before its first attempt and reused on retry, so a
  -- retry after an ambiguous failure cannot register the same write twice.
  -- Required: anything that can record a write can generate a UUID first.
  client_event_id uuid not null,

  created_at timestamptz not null default now(),

  -- Owner and problem are checked as one pair, so an Event cannot be appended
  -- to another owner's Problem. The Problem's existence transitively
  -- guarantees the owner's, so no further foreign key is needed.
  constraint events_owner_id_problem_id_fkey
    foreign key (owner_id, problem_id)
    references public.problems (owner_id, problem_id)
    -- A Problem with history cannot be deleted out from under it.
    -- The full delete lifecycle is settled in P1-11.
    on delete restrict,

  -- Scoped to the owner rather than to the Problem: the same client write must
  -- not land twice even if it is retried against a different Problem. Not
  -- global, which would needlessly couple separate owners' namespaces.
  --
  -- P1-09 only refuses the duplicate. Turning a duplicate into a replay of the
  -- original result is P2-04.
  constraint events_owner_id_client_event_id_key unique (owner_id, client_event_id)
);

-- PostgreSQL does not index a foreign key automatically. Listing a Problem's
-- events and the delete-time RESTRICT check both depend on this one. The
-- unique constraint above provides its own index. Ordering and retrieval
-- indexes are reviewed in P1-11.
create index events_owner_id_problem_id_idx on public.events (owner_id, problem_id);

comment on table public.events is
  'Append-only record of meaningful changes while solving a problem.';

comment on column public.events.event_id is
  'Supplied by the application, never defaulted by the database.';

comment on column public.events.client_event_id is
  'Issued by the client before its first attempt and reused on retry.';

comment on column public.events.evidence_ref is
  'Reference to supporting material, not the material itself.';
