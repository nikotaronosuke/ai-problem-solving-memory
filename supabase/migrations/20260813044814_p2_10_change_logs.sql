-- P2-10: change logs.
--
-- Who changed a Problem, when, and what moved. Written by the service as part
-- of the same transaction as the change itself, so a Problem cannot end up
-- edited with no record of it — or recorded as edited when it was not.
--
-- Not a trigger. The rule about what may be written here is a product
-- decision, not a storage one: some values are recorded exactly and some
-- deliberately are not, and a trigger would have neither the context to tell
-- them apart nor anywhere to state why.
--
-- One row per mutation, not per field. A patch that changes five things is one
-- thing that happened, and splitting it would lose that.
--
-- No `updated_at` and no `version`: a change log entry is a statement about a
-- moment, and editing it would defeat the point of having it.

create table public.change_logs (
  change_log_id uuid primary key,
  owner_id uuid not null,
  problem_id uuid not null,

  -- Who made the change. Free-form text, because assistant and tool names
  -- change and manual edits exist too. Descriptive only: it is not a
  -- credential and has no bearing on which owner's data a request can reach.
  changed_by text not null
    constraint change_logs_changed_by_not_blank
      check (btrim(changed_by, E' \t\r\n\f\v') <> ''),

  -- The Problem's version before and after. A successful mutation moves the
  -- version by exactly one, so these bracket the change precisely and let the
  -- history be read as a chain rather than a pile.
  from_version integer not null
    constraint change_logs_from_version_positive check (from_version >= 1),
  to_version integer not null
    constraint change_logs_version_advances check (to_version = from_version + 1),

  -- What moved, as one object per mutation.
  --
  -- Controlled values — status, the flags, confidence, freshness, fix kind —
  -- are recorded exactly, because they come from closed sets and are what a
  -- reader needs to follow how judgement changed.
  --
  -- Free text is deliberately not copied. Titles, symptoms and the rest can
  -- contain anything a person or an assistant wrote, including things that
  -- later have to be removed; a copy here would survive the removal and
  -- quietly defeat it. What is recorded for those is that the field was part
  -- of the change, whether it went from or to absent, and whether the value
  -- actually differed.
  changes jsonb not null
    constraint change_logs_changes_is_object
      check (jsonb_typeof(changes) = 'object'),
  constraint change_logs_changes_not_empty
    check (changes <> '{}'::jsonb),

  created_at timestamptz not null default now(),

  -- Owner and problem are checked as one pair, so an entry cannot be attached
  -- to another owner's Problem. The Problem's existence transitively
  -- guarantees the owner's, as elsewhere. RESTRICT, schema-wide policy: a
  -- Problem with history cannot be removed out from under it.
  constraint change_logs_owner_id_problem_id_fkey
    foreign key (owner_id, problem_id)
    references public.problems (owner_id, problem_id)
    on delete restrict,

  -- Exactly one entry per version a Problem passes through. The compare-and-
  -- swap on `problems.version` already means only one writer can produce a
  -- given version; this states that in the schema, so a second entry claiming
  -- the same version is refused rather than silently accumulating.
  constraint change_logs_owner_problem_to_version_key
    unique (owner_id, problem_id, to_version)
);

comment on table public.change_logs is
  'Automatic history of Problem mutations. Written in the same transaction as the change.';

comment on column public.change_logs.changed_by is
  'Descriptive name of who made the change. Never used for authorisation.';

comment on column public.change_logs.changes is
  'One object per mutation. Controlled values exact; free text recorded as presence and whether it differed, never copied.';

-- The list path: one problem's history, oldest first. Not a left prefix of the
-- unique constraint above, and not a duplicate of it.
create index change_logs_owner_problem_created_idx
  on public.change_logs (owner_id, problem_id, created_at, change_log_id);
