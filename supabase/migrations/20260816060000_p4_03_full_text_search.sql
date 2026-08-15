-- P4-03: lexical search over retrieval artifacts.
--
-- What a search matches on is the artifact, never the Problem. P4-02 exists to
-- turn an investigation into a form that can be compared — a normalized summary
-- and a set of keywords — and searching the Problem's own title and symptoms
-- alongside it would route around that translation and put two different
-- notions of "the searchable text" in the system at once. So the document below
-- is built from exactly two columns, and the Problem's text, its Events, its
-- Verifications and the structural features are all deliberately absent.
--
-- `structural_features` is absent for a second reason: comparing structure is
-- P4-07's, and it compares meaning rather than words. Feeding those labels to a
-- lexical index would make them look like they were already being used, and
-- badly.
--
-- Nothing here is a search *policy*. Which candidates outrank which, whether a
-- suppressed Memory should sink, what a stale artifact means and how a lexical
-- score combines with a vector one are all later tasks. This produces
-- candidates that contain the words, in a defined order, and stops.

-- The document, as a function of its inputs and nothing else.
--
-- It exists because the obvious one-liner cannot be indexed. The natural way to
-- write this is `to_tsvector('simple', array_to_string(keywords, ' '))`, and
-- PostgreSQL refuses it in an index or a generated column: `array_to_string`
-- over `anyarray` is STABLE, because for some element types the output depends
-- on session settings. The documented workaround is to wrap it in a function
-- declared IMMUTABLE — which would be a false declaration, since the wrapper
-- would still be calling a STABLE function and the label would be a promise
-- this code cannot keep.
--
-- So the array is walked instead. Every primitive used below is IMMUTABLE in
-- its own right: `to_tsvector(regconfig, text)`, `setweight`, and tsvector
-- concatenation. The result depends on the arguments and on nothing else — no
-- table is read, no session setting is consulted, no clock, no dynamic SQL —
-- which makes IMMUTABLE true rather than convenient.
--
-- The configuration is named in full and is never left to
-- `default_text_search_config`, which is `english` on this server. That default
-- would stem `Fastify` to `fastifi` and `memory_read_enabled` to `memori read
-- enabl`, and a session that changed the setting would silently disagree with
-- the stored column. `simple` keeps `postgresql`, `node.js`, `v5.1.2` and
-- `@fastify/swagger` intact, which is what a search over technical writing
-- needs. The cost is real and accepted: `deployment` no longer matches
-- `deployed`. Recall across different words for the same idea is what the
-- semantic half of the search is for, and lexical matching should be the half
-- that is precise.
create function public.retrieval_fts_document(
  normalized_summary text,
  keywords text[]
) returns tsvector
language plpgsql
immutable
parallel safe
as $$
declare
  document tsvector;
  keyword text;
begin
  -- The summary is the body of the document: everything the artifact says,
  -- weighted below the terms that were chosen deliberately.
  document := setweight(to_tsvector('pg_catalog.simple', normalized_summary), 'B');

  -- Each keyword becomes its own weighted vector rather than being joined into
  -- one string. Joining would need `array_to_string`, and a keyword containing
  -- a space would become two terms with no way to tell they belonged together.
  foreach keyword in array keywords loop
    document := document || setweight(to_tsvector('pg_catalog.simple', keyword), 'A');
  end loop;

  return document;
end;
$$;

comment on function public.retrieval_fts_document(text, text[]) is
  'The lexical document for a retrieval artifact: keywords at weight A, normalized summary at weight B, always under pg_catalog.simple. Genuinely immutable — it walks the keyword array rather than calling the STABLE array_to_string.';

-- The document, stored and kept in step by the database.
--
-- A generated column rather than an expression index, and the reason is a
-- measurement rather than a preference. With an expression index, the query has
-- to repeat the indexed expression exactly; anything that drifts — a different
-- weight letter, the configuration spelled another way, the arguments in
-- another order — does not raise an error. It stops using the index. Measured
-- on twenty thousand rows, that turned a 0.1 ms lookup into a 218 ms sequential
-- scan, silently. A column is referred to by name, so the failure mode of
-- getting it wrong is a missing column rather than a search that still works
-- and is two thousand times slower.
--
-- No trigger. A generated column is recomputed by the database whenever the row
-- is written, including through the artifact upsert, so there is nothing to
-- keep in step and nothing that can fall out of step. The trigger count in this
-- schema stays at zero.
--
-- This is storage support, not part of what an artifact *is*. It is derived
-- from two columns that are already here, it is not in the domain record, and
-- it is not selected by the repository.
-- `not null` because it genuinely cannot be unknown. Both inputs are `not
-- null` and the helper always returns a vector — an artifact with no keywords
-- and a summary of stop words produces an empty tsvector, which is a real
-- answer rather than a missing one. Leaving it nullable would put it among the
-- columns that are nullable because the value can truly be absent, and it is
-- not one of those.
alter table public.retrieval_artifacts
  add column search_document tsvector not null
    generated always as (public.retrieval_fts_document(normalized_summary, keywords)) stored;

comment on column public.retrieval_artifacts.search_document is
  'Derived lexical document for full-text search. Maintained by the database, not part of the artifact contract, and never written by the application.';

-- GIN, which is the index type for containment queries over a tsvector.
create index retrieval_artifacts_search_document_gin
  on public.retrieval_artifacts using gin (search_document);
