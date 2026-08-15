-- P4-04: which generator wrote the words.
--
-- An artifact already records which model produced its embedding, because the
-- specification requires artifacts to be regenerable when the model changes —
-- and telling the old rows from the new ones is what makes that possible. The
-- same reasoning applies to the other generator in the pipeline: the normalized
-- summary is written by a summariser with an identity and a version of its own,
-- and a summariser change leaves the source fingerprint untouched, because the
-- fingerprint describes what was read rather than who did the writing. Without
-- these two columns, an artifact whose text was produced by a superseded
-- generator is indistinguishable from a current one, permanently.
--
-- Four provenance axes, kept deliberately separate: `source_fingerprint` is the
-- state of the Memory the summary was built from; `summary_generator_id` and
-- `summary_generator_version` are who turned that state into text;
-- `embedding_model` and `embedding_model_version` are what turned the text into
-- a vector; `generated_at` is when the complete content first existed. Folding
-- any of these into another would make one value answer two questions badly.

-- Existing rows are removed rather than backfilled.
--
-- This deletes DERIVED DATA ONLY, and doing it is more honest than the
-- alternatives. These rows have no recorded summary generator, because nothing
-- that generated summaries has ever written a row — every row that exists was
-- seeded by hand or by a test. Inventing a provenance ("unknown", "legacy")
-- would put a permanent lie in a column whose whole purpose is to be believed
-- later, and nullable columns would carry the gap forward forever for the sake
-- of rows that a regeneration reproduces in full. A retrieval artifact is
-- rebuildable by definition: losing every row costs the time to regenerate and
-- nothing else.
--
-- Nothing here touches a Memory table. Problems, Events, Verifications,
-- Environments, Projects and every log remain exactly as they were.
delete from public.retrieval_artifacts;

alter table public.retrieval_artifacts
  add column summary_generator_id text not null
    constraint retrieval_artifacts_summary_generator_id_not_blank
      check (btrim(summary_generator_id, E' \t\r\n\f\v') <> ''),
  add column summary_generator_version text not null
    constraint retrieval_artifacts_summary_generator_version_not_blank
      check (btrim(summary_generator_version, E' \t\r\n\f\v') <> '');

comment on column public.retrieval_artifacts.summary_generator_id is
  'Which summary generator wrote normalized_summary, keywords and structural_features. Free text, never a vendor vocabulary. Separate from source_fingerprint (what was read) and embedding_model (what vectorised the text).';

comment on column public.retrieval_artifacts.summary_generator_version is
  'The version of that generator. A generator change does not move the source fingerprint, so this is the only way an artifact written by a superseded summariser can be identified for regeneration.';
