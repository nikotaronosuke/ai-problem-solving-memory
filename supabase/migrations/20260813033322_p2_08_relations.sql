-- P2-08: relations.
--
-- A meaningful link between two Problems. This is what lets experience from
-- one investigation reach another — the same problem seen twice, a cause
-- found elsewhere, a conclusion that replaced an earlier one.
--
-- Deliberately narrow. Problem to Problem only, with no `from_type` /
-- `to_type` columns and no polymorphic target: Patterns and Skills do not
-- exist yet, and a schema built for entities nobody has defined would fix
-- their shape before anyone knows it.
--
-- A Relation is a link, not an inheritance. Nothing here copies status,
-- confidence, freshness or evidence from one Problem to the other, and the
-- rule that VERIFIED needs the Problem's *own* successful Verification is
-- unaffected by any number of relations.
--
-- No `updated_at`, no `version`, no `client_event_id`. There is no update
-- path in P2-08, so there is nothing for a version to guard and nothing for a
-- timestamp to record; and how a mistaken Relation is corrected or removed is
-- a decision this migration deliberately does not pre-empt.

-- The link's meaning. Text-backed DOMAIN with a named CHECK, like the six
-- value sets before it — see the P1-04 migration for why not a native enum.
-- Mirrors RELATION_TYPES in src/domain/enums.ts, and
-- tests/db/enums.integration.test.ts drives every value through this domain
-- so the two cannot drift.
create domain public.relation_type as text
  constraint relation_type_allowed_values check (
    value in (
      'SIMILAR_TO',
      'RELATED_TO',
      'CAUSED_BY',
      'SUPERSEDES',
      'CONTRADICTS',
      'DERIVED_FROM'
    )
  );

comment on domain public.relation_type is
  'Meaning of a link between two Problems. Mirrors RelationType in src/domain/enums.ts.';

create table public.relations (
  relation_id uuid primary key,
  owner_id uuid not null,

  -- Direction is carried by the row itself, and only one row is stored per
  -- link. For CAUSED_BY, SUPERSEDES and DERIVED_FROM the direction is the
  -- meaning: `from` was caused by / supersedes / derives from `to`.
  --
  -- SIMILAR_TO, RELATED_TO and CONTRADICTS read the same both ways, and no
  -- mirror row is written for them. Two rows would have to be kept in step by
  -- something, and nothing would keep them in step.
  from_id uuid not null,
  to_id uuid not null,

  relation_type public.relation_type not null,

  -- Why these two are linked. Required and non-blank: a link nobody can
  -- account for later is a link nobody can act on, and "these look alike" is
  -- exactly the judgement that needs its reasoning attached.
  --
  -- The trim names the whitespace characters explicitly. One-argument
  -- `btrim` removes spaces only, so a tab- or newline-only value would pass a
  -- check written that way — as the earlier tables' checks are. The
  -- application trims all whitespace before writing, so this is the backstop
  -- for anything that does not go through it.
  reason text not null
    constraint relations_reason_not_blank check (btrim(reason, E' \t\r\n\f\v') <> ''),

  created_at timestamptz not null default now(),

  -- A Problem related to itself adds nothing under any of the six meanings,
  -- and produces a self-loop that every future traversal would have to
  -- special-case. Refused at the database as well as the API, so it holds for
  -- any writer.
  constraint relations_not_self check (from_id <> to_id),

  -- Both ends are checked as an (owner, problem) pair, so neither can point
  -- at another owner's Problem. Each Problem's existence transitively
  -- guarantees the owner's, so no separate owner foreign key is needed — the
  -- same reasoning the Event and Verification tables follow.
  --
  -- Both are RESTRICT, schema-wide policy: a Problem with relations still
  -- attached cannot be removed out from under them.
  constraint relations_owner_id_from_id_fkey
    foreign key (owner_id, from_id)
    references public.problems (owner_id, problem_id)
    on delete restrict,

  constraint relations_owner_id_to_id_fkey
    foreign key (owner_id, to_id)
    references public.problems (owner_id, problem_id)
    on delete restrict
);

comment on table public.relations is
  'Meaningful links between two of one owner''s Problems. Create and list only.';

comment on column public.relations.from_id is
  'The Problem the relation is stated from. Direction is meaningful for CAUSED_BY, SUPERSEDES and DERIVED_FROM.';

comment on column public.relations.to_id is
  'The Problem the relation points at. No mirror row is written for symmetric types.';

-- Listing a Problem's relations asks for both directions at once: a Problem
-- that only ever appeared as a target still needs to see the link. One index
-- per side, each ordered so the list query reads straight out of it.
--
-- Neither is a left prefix of the other, and neither duplicates the primary
-- key.
create index relations_owner_from_created_idx
  on public.relations (owner_id, from_id, created_at, relation_id);

create index relations_owner_to_created_idx
  on public.relations (owner_id, to_id, created_at, relation_id);
