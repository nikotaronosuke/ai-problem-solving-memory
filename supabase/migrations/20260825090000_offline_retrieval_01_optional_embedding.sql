-- Offline-capable retrieval, step 1: the semantic rendering becomes optional.
--
-- An artifact's searchable text — summary, keywords, structural features —
-- can be produced deterministically from the canonical source, with no
-- provider involved. The embedding cannot. Requiring one for the row to
-- exist is what made an unfunded provider erase the free full-text channel:
-- no embedding, no row; no row, nothing for FTS to search.
--
-- So the three columns that describe the semantic rendering may now be
-- absent — together, or not at all. Half a rendering is not a state: an
-- embedding without its model is a vector nobody can compare, and a model
-- without its vector is a claim about nothing. The check constraint makes
-- the halves unstatable rather than discouraged.
--
-- What this deliberately does not do:
--   * No sentinel vectors. A row with no semantic rendering says so with
--     NULL, never with a fake embedding under a fake model name — the schema
--     keeps meaning "this is the embedding" when a value is present.
--   * No change to populated rows. Every existing artifact keeps all three
--     values and satisfies the new constraint as the all-present half.
--   * No change to vector search semantics. That statement already compares
--     only rows whose model, version and measured dimensions equal the
--     query's; a NULL rendering fails those equalities and is naturally
--     never scored.
--
-- The existing not-blank checks on embedding_model and embedding_model_version
-- stay: a CHECK passes on NULL, so they now read "absent, or non-blank",
-- which is exactly the rule.

alter table public.retrieval_artifacts
  alter column embedding drop not null,
  alter column embedding_model drop not null,
  alter column embedding_model_version drop not null,
  add constraint retrieval_artifacts_semantic_rendering_all_or_none check (
    ((embedding is null) = (embedding_model is null))
    and ((embedding is null) = (embedding_model_version is null))
  );

comment on constraint retrieval_artifacts_semantic_rendering_all_or_none
  on public.retrieval_artifacts is
  'The semantic rendering is one thing: its vector, its model and its model version are stored together or not at all. A deterministic artifact stores none of them; a provider-generated artifact stores all three.';
