-- P4-01: the retrieval artifact.
--
-- The first derived store in this system, and the distinction it draws is the
-- point of the table rather than a detail of it. Problems, Events and
-- Verifications are what somebody recorded; this is what a search engine needs
-- in order to find them. One is the truth and the other is a convenience
-- rebuilt from it, so nothing here may ever be the reason a Memory changes,
-- and losing all of it must cost nothing but the time to regenerate.
--
-- That is why there is no artifact identity of its own. A row *is* a Problem's
-- current artifact — `(owner_id, problem_id)` is the whole of it — so there is
-- no version history, no generation log, and no second row per model. A new
-- generation replaces the old one. Keeping history would mean deciding which
-- of several rows a search should read, which is a question a derived store
-- should never make anyone ask.
--
-- The foreign key is composite and RESTRICT, like every other reference into
-- `problems`. Composite because it makes a cross-owner artifact unstorable
-- rather than merely unwritten by the code above; RESTRICT because a Problem
-- delete removes this row explicitly, in the delete path, where somebody
-- reading it can see that it happens.
--
-- Deliberately absent: `project_id` (denormalising it would duplicate a fact
-- that already has one home), `confidence` and `freshness` (a search reads the
-- Problem's current values, and a copy would go stale), `created_at` and
-- `updated_at` (there is one row and `generated_at` says when its content was
-- made), any status restriction, and any index beyond the primary key. Text
-- search and vector indexes belong to P4-03 and P4-05, which know what they
-- are searching for.

-- Vector storage, enabled here because this is the migration that first needs
-- it. Deliberately not `vector(N)`: fixing a dimension now would fix an
-- embedding model now, and the specification is explicit that the model is not
-- part of the contract and that artifacts must be regenerable when it changes.
-- An untyped `vector` column stores different dimensions in different rows,
-- which is exactly what a provider change produces while it is rolling
-- through. P4-05 decides what to index and may cast to a fixed dimension then.
create extension if not exists vector;

create table public.retrieval_artifacts (
  owner_id uuid not null,

  -- The Problem this describes. Also half the primary key: a Problem has one
  -- current artifact or none.
  problem_id uuid not null,

  -- The searchable rendering of the Problem, produced by P4-02. Not a copy of
  -- the Problem's own text — a summary written for retrieval — and never a
  -- place to park the raw record.
  normalized_summary text not null
    constraint retrieval_artifacts_normalized_summary_not_blank
      check (btrim(normalized_summary, E' \t\r\n\f\v') <> ''),

  -- Terms the retrieval layer matches on. Empty is allowed and meaningful: a
  -- Problem may have nothing worth indexing as a keyword while still having a
  -- summary and an embedding. How many, in what order, and how duplicates are
  -- treated belong to whatever generates them, not to storage.
  keywords text[] not null,

  -- The structural reading of the problem — shape rather than words, which is
  -- what makes a match across different technologies possible. An object, and
  -- that is the only thing this migration says about it: the vocabulary is
  -- P4-02's and P4-07's, and pinning it here would freeze it before either has
  -- been written. An object rather than any JSON so that this cannot quietly
  -- become somewhere a raw snapshot is dumped whole.
  structural_features jsonb not null
    constraint retrieval_artifacts_structural_features_is_object
      check (jsonb_typeof(structural_features) = 'object'),

  embedding vector not null,

  -- Which model produced that embedding, as free text. No enum and no vendor
  -- vocabulary: model names change faster than schemas, and naming providers
  -- here would make this table a place model identity is decided rather than
  -- recorded.
  embedding_model text not null
    constraint retrieval_artifacts_embedding_model_not_blank
      check (btrim(embedding_model, E' \t\r\n\f\v') <> ''),
  embedding_model_version text not null
    constraint retrieval_artifacts_embedding_model_version_not_blank
      check (btrim(embedding_model_version, E' \t\r\n\f\v') <> ''),

  -- Which state of the source Memory this was built from, as an opaque token.
  -- Storage keeps it and compares it for equality; what it is computed from
  -- and how belongs to P4-02, which reads the source. Deliberately not a hash
  -- of anything this migration names, because naming it would make the
  -- algorithm a contract that a better one could not replace.
  --
  -- It exists because `generated_at` cannot answer the question it looks like
  -- it answers. An artifact generated after an Event was appended may still
  -- have been built from the source as it stood before it — the read happens
  -- first and the write happens last — so a timestamp comparison would call a
  -- stale artifact fresh.
  source_fingerprint text not null
    constraint retrieval_artifacts_source_fingerprint_not_blank
      check (btrim(source_fingerprint, E' \t\r\n\f\v') <> ''),

  -- When the content was generated, supplied by whatever generated it rather
  -- than defaulted here: the moment a row reached the database is not the
  -- moment its content was made, and provenance is about the latter. Not a
  -- freshness proof — see `source_fingerprint`.
  generated_at timestamptz not null,

  constraint retrieval_artifacts_pkey primary key (owner_id, problem_id),

  -- Composite, so an artifact cannot name one owner and a Problem belonging to
  -- another. RESTRICT, so a Problem cannot be removed while its artifact is
  -- still here — the delete path removes this first, in the open.
  constraint retrieval_artifacts_owner_id_problem_id_fkey
    foreign key (owner_id, problem_id)
    references public.problems (owner_id, problem_id)
    on delete restrict
);

comment on table public.retrieval_artifacts is
  'Derived, regenerable search data for a Problem. Never a source of truth: the Problem, its Events and its Verifications are. One current row per Problem, replaced on regeneration, and removed with the Problem.';

comment on column public.retrieval_artifacts.embedding is
  'Untyped vector: the dimension is not fixed, so an embedding model change does not require a schema change. P4-05 owns indexing.';

comment on column public.retrieval_artifacts.source_fingerprint is
  'Opaque token for the source state this was built from. P4-02 owns how it is computed. Compared for equality only.';

comment on column public.retrieval_artifacts.generated_at is
  'When the content was generated, supplied by the generator. Not evidence that the artifact is current.';
