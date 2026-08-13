-- P2-09: usage logs.
--
-- A record of an AI actually using past memory while working on a problem:
-- what it found, what it read, what it took, what it set aside, and where a
-- memory changed the direction of the work.
--
-- Separate from the Memory itself, deliberately. A Problem records what was
-- learned; this records that someone consulted it. Mixing the two would make
-- the record of an investigation depend on who has been reading it.
--
-- Memory-specific, and only that. It does not log tool calls, deploys, model
-- invocations or approvals: a Global Audit Layer for those belongs to the
-- wider system, and this table must stay something it can read from rather
-- than something that has already tried to be it.
--
-- No `updated_at`, no `version`, no `client_event_id`. Rows are added, not
-- edited; and whether a resent log needs an idempotency key is a question for
-- whenever adapter retry behaviour is designed, not one to answer by copying
-- the append paths.

-- How the memory was used. Text-backed DOMAIN with a named CHECK, like the
-- seven value sets before it — see the P1-04 migration for why not a native
-- enum. Mirrors USAGE_ACTIONS in src/domain/enums.ts, and
-- tests/db/enums.integration.test.ts drives every value through this domain
-- so the two cannot drift.
--
-- No order is implied or enforced between them. An adapter that only ever
-- reports ADOPTED is recording something true; requiring SEARCHED first would
-- make the log a workflow rather than an observation.
create domain public.usage_action as text
  constraint usage_action_allowed_values check (
    value in (
      'SEARCHED',
      'REFERENCED',
      'ADOPTED',
      'EXCLUDED',
      'CHANGED_STRATEGY'
    )
  );

comment on domain public.usage_action is
  'How past memory was used while solving a problem. Mirrors UsageAction in src/domain/enums.ts.';

create table public.usage_logs (
  usage_log_id uuid primary key,
  owner_id uuid not null,

  -- The problem being worked on when the memory was used.
  problem_id uuid not null,

  -- Which AI, assistant or person did the using. Free-form text, because
  -- provider and model names change and an enum would be wrong within the
  -- year. Descriptive only: it is not a credential and has no bearing on
  -- which owner's data a request can reach.
  source_ai text not null
    constraint usage_logs_source_ai_not_blank
      check (btrim(source_ai, E' \t\r\n\f\v') <> ''),

  action public.usage_action not null,

  -- The past memory that was used. A Problem: in the MVP a Case Memory *is* a
  -- Problem, so this is a plain reference rather than a polymorphic one.
  -- Patterns and Skills do not exist yet, and `memory_type` columns added
  -- before they do would fix their shape in advance.
  --
  -- Deliberately allowed to equal `problem_id`. Continuing the same problem
  -- under a different AI, reading back its own history, is a real case and
  -- nothing is gained by refusing it.
  memory_id uuid not null,

  -- Why this memory was used, or set aside, and what looked similar. Required
  -- and non-blank: a usage record with no account of the judgement is a hit
  -- counter, and the point is to be able to tell later whether the memory
  -- actually helped.
  reason text not null
    constraint usage_logs_reason_not_blank
      check (btrim(reason, E' \t\r\n\f\v') <> ''),

  -- What came of it, when that is already known. Null for a memory that was
  -- merely found or read, since the outcome has not happened yet — inventing
  -- one would be worse than leaving it open. Non-blank when present, so
  -- "unknown" cannot arrive disguised as an empty answer.
  result text
    constraint usage_logs_result_not_blank
      check (result is null or btrim(result, E' \t\r\n\f\v') <> ''),

  created_at timestamptz not null default now(),

  -- Both the problem and the memory are checked as an (owner, problem) pair,
  -- so neither can reach another owner's Problem. Each Problem's existence
  -- transitively guarantees the owner's, so no separate owner foreign key is
  -- needed — the same reasoning the Event, Verification and Relation tables
  -- follow.
  --
  -- Both RESTRICT, schema-wide policy: a Problem that has been used, or used
  -- something, cannot be removed out from under the record of it.
  constraint usage_logs_owner_id_problem_id_fkey
    foreign key (owner_id, problem_id)
    references public.problems (owner_id, problem_id)
    on delete restrict,

  constraint usage_logs_owner_id_memory_id_fkey
    foreign key (owner_id, memory_id)
    references public.problems (owner_id, problem_id)
    on delete restrict
);

comment on table public.usage_logs is
  'Memory-specific record of past problems being used while solving another. Create and list only.';

comment on column public.usage_logs.memory_id is
  'The past Problem used as memory. May equal problem_id when continuing the same investigation.';

comment on column public.usage_logs.source_ai is
  'Descriptive name of the AI or person that used the memory. Never used for authorisation.';

-- The list path: one problem's usage, oldest first.
create index usage_logs_owner_problem_created_idx
  on public.usage_logs (owner_id, problem_id, created_at, usage_log_id);

-- The other direction — which problems used a given memory. Not exposed as an
-- endpoint yet, but it is what makes the memory foreign key's RESTRICT check
-- cheap, and it is the access path any later "where has this been used?"
-- question needs.
create index usage_logs_owner_memory_created_idx
  on public.usage_logs (owner_id, memory_id, created_at, usage_log_id);
