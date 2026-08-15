/**
 * Asking the Memory for candidates, and what an answer means.
 *
 * This is the lexical half of retrieval: it finds artifacts whose text contains
 * the words that were asked for. That is a smaller claim than it sounds, and
 * the smallness is the point — a candidate is somewhere worth looking, not an
 * answer, and the specification is explicit that search results are candidates
 * rather than conclusions.
 *
 * Three things follow from that and shape everything here.
 *
 * **The score is about words.** `lexicalScore` says how well the text matched,
 * and nothing else. It is not confidence, not verification strength, not
 * freshness, and not a probability that the Memory is useful. Those are
 * separate axes the specification keeps separate, and they are read live from
 * the Problem by the layer that ranks. Naming this field `relevance` or
 * `confidence` would invite exactly the collapse this system exists to avoid.
 *
 * **All words are required.** The query is parsed by PostgreSQL's web-search
 * grammar, which joins ordinary terms with AND. Handing it a whole paragraph
 * therefore finds nothing unless every word appears — which is a real
 * limitation, and it belongs to whatever assembles queries rather than being
 * papered over here with silent term dropping.
 *
 * **What is filtered and what is merely ranked are different questions.** Only
 * two things remove a candidate: it is not this owner's, or its Problem has
 * automatic reading turned off. Suppressed, stale, superseded, invalid and
 * low-confidence Memories are all returned, because "surface this less" and
 * "this is not current" are judgements for the layer that presents results, not
 * reasons to make a Memory unfindable.
 */

import type { ProblemId } from './problem.js';
import type { ProjectId } from './project.js';
import { isBlankText } from './text.js';

/**
 * The text search configuration, named in full.
 *
 * Never left to `default_text_search_config`, which is `english` on the server
 * this runs against. Two reasons, and either alone would settle it. A session
 * that changed the setting would build queries that disagree with the stored
 * document, so the same search would return different results depending on how
 * the connection was configured. And `english` stemming damages exactly the
 * words this corpus is made of: `Fastify` becomes `fastifi`, `PostgreSQL`
 * survives but `memory_read_enabled` becomes `memori read enabl`.
 *
 * The cost of `simple` is stated plainly: `deployment` does not match
 * `deployed`. Finding a Memory that used different words for the same idea is
 * what the semantic half of retrieval is for; the lexical half should be the
 * one that is exact.
 */
export const RETRIEVAL_TEXT_SEARCH_CONFIG = 'pg_catalog.simple';

/** Raised when a search could not be accepted as asked. */
export class InvalidFullTextSearchError extends Error {
  readonly field: string;

  constructor(field: string, reason: string) {
    // The field and a reason from this file. Never the query: a search is
    // somebody looking for something, an error travels, and neither the words
    // they used nor anything shaped like them belongs in a log.
    super(`Full-text search ${field} is unusable: ${reason}.`);
    this.name = 'InvalidFullTextSearchError';
    this.field = field;
  }
}

/**
 * How many candidates a search returns when it does not say.
 *
 * Twenty because the stage after this one narrows to a handful, and a lexical
 * pass is one of several sources feeding it. Large enough that a reranker has
 * something to work with; small enough that nothing here becomes a way to read
 * a whole Memory in one call.
 */
export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 50;

/**
 * The longest query this accepts.
 *
 * A bound rather than a judgement about what a good query looks like. The
 * grammar requires every term to appear, so a very long query finds nothing
 * long before it finds too much — the limit is here so an unbounded string
 * cannot be handed to the parser, not to express an opinion.
 */
export const MAX_SEARCH_TEXT_LENGTH = 1000;

/** What a caller is asking for. */
export interface FullTextSearchQuery {
  readonly text: string;
  /**
   * Restricts the search to one Project.
   *
   * Absent searches every Project this owner has, which is the default the
   * specification asks for: the point of the Memory is that experience from one
   * project is available to another. A Project belonging to somebody else
   * simply matches nothing — there is no separate existence check, so this
   * cannot be used to find out whether an identifier is in use.
   */
  readonly projectId?: ProjectId;
  /**
   * Leaves one Problem out.
   *
   * For the case that motivates it: searching while working on a Problem, whose
   * own artifact would otherwise match its own words better than anything else
   * and take the top place. Not the default, because "find memories like this
   * one" and "find memories other than this one" are both real questions and
   * only the caller knows which it is asking.
   */
  readonly excludeProblemId?: ProblemId;
  readonly limit?: number;
}

/** A validated query, with the defaults filled in. */
export interface ResolvedFullTextSearchQuery {
  readonly text: string;
  readonly projectId: ProjectId | null;
  readonly excludeProblemId: ProblemId | null;
  readonly limit: number;
}

/**
 * One candidate.
 *
 * Deliberately three fields. The summary, the keywords and the structural
 * features are all in the artifact and none of them are here, because carrying
 * them through every layer would mean the stage that only needs to order things
 * is handling the text as well. Whatever needs the content can read it by
 * identifier once the field has narrowed.
 *
 * No owner id. Every candidate belongs to the owner the reader was built for,
 * and returning it would be repeating a fact that was settled before the query
 * ran.
 */
export interface FullTextCandidate {
  readonly problemId: ProblemId;
  readonly projectId: ProjectId;
  /**
   * How well the text matched, and nothing more.
   *
   * Comparable between candidates of one search. Not comparable with a
   * similarity from a vector search, and not a measure of whether the Memory is
   * any good — combining signals is a later decision that has to be made
   * deliberately rather than inherited from whatever scale this happens to be
   * on.
   */
  readonly lexicalScore: number;
}

function requireInteger(value: number, field: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value)) {
    throw new InvalidFullTextSearchError(field, 'it is not a whole number');
  }
  if (value < minimum || value > maximum) {
    throw new InvalidFullTextSearchError(
      field,
      `it is outside ${String(minimum)} to ${String(maximum)}`,
    );
  }
  return value;
}

/**
 * Checks a query and fills in what was not said.
 *
 * A blank search is refused rather than answered. PostgreSQL would parse it
 * into an empty query that matches nothing, so returning an empty list would
 * also be defensible — but "you asked for nothing" and "nothing matched what
 * you asked for" are different answers, and a caller that sent an empty string
 * by accident should find out.
 */
export function resolveFullTextSearchQuery(
  query: FullTextSearchQuery,
): ResolvedFullTextSearchQuery {
  return resolveSearchQuery(query, MAX_SEARCH_TEXT_LENGTH);
}

/**
 * The shared resolution both kinds of search use.
 *
 * One implementation because the filters mean the same thing in both: the
 * hybrid stage will run the two searches side by side over one intent, and two
 * validators for one meaning is how the meanings drift. Only the text bound
 * differs, so it is the one parameter.
 */
function resolveSearchQuery(
  query: FullTextSearchQuery | VectorSearchQuery,
  maximumTextLength: number,
): ResolvedFullTextSearchQuery {
  if (typeof query.text !== 'string' || isBlankText(query.text)) {
    throw new InvalidFullTextSearchError('text', 'it is blank');
  }
  if (query.text.length > maximumTextLength) {
    throw new InvalidFullTextSearchError(
      'text',
      `it is longer than ${String(maximumTextLength)} characters`,
    );
  }

  return {
    text: query.text,
    projectId: query.projectId ?? null,
    excludeProblemId: query.excludeProblemId ?? null,
    limit:
      query.limit === undefined
        ? DEFAULT_SEARCH_LIMIT
        : requireInteger(query.limit, 'limit', 1, MAX_SEARCH_LIMIT),
  };
}

/**
 * The longest semantic query this accepts.
 *
 * Larger than the lexical bound, and the difference is principled rather than
 * arbitrary. A lexical query is a handful of terms joined with AND, and a long
 * one finds nothing. A semantic query's canonical case is the opposite: a
 * whole normalized summary — "find memories like this Problem" — and a
 * summary may legitimately be up to its own bound of 4000. The lexical limit
 * stays where it is; neither bound leaks into the other's search.
 */
export const MAX_VECTOR_SEARCH_TEXT_LENGTH = 4000;

/**
 * What a caller asks a semantic search for.
 *
 * Text, never a vector. The embedding is produced inside the service by the
 * same provider the artifacts were embedded with, which is what keeps the
 * query and the stored vectors in one space — a caller-supplied vector could
 * be from any model at any dimension, and accepting one would turn the
 * compatibility contract into a convention.
 *
 * The filters mean exactly what they mean for the lexical search.
 */
export interface VectorSearchQuery {
  readonly text: string;
  readonly projectId?: ProjectId;
  readonly excludeProblemId?: ProblemId;
  readonly limit?: number;
}

/** A validated semantic query. The same resolved shape as the lexical one. */
export type ResolvedVectorSearchQuery = ResolvedFullTextSearchQuery;

export function resolveVectorSearchQuery(query: VectorSearchQuery): ResolvedVectorSearchQuery {
  return resolveSearchQuery(query, MAX_VECTOR_SEARCH_TEXT_LENGTH);
}

/**
 * One semantic candidate.
 *
 * The mirror of `FullTextCandidate`, so the hybrid stage can union the two
 * without reshaping either. No owner id, no artifact text, and no model
 * metadata — every candidate already passed the exact model, version and
 * dimension filter, so per-candidate model fields would repeat one fact the
 * whole result shares.
 */
export interface VectorCandidate {
  readonly problemId: ProblemId;
  readonly projectId: ProjectId;
  /**
   * Raw cosine distance: 0 is identical direction, 1 orthogonal, 2 opposite.
   * LOWER is better, which is the opposite direction from `lexicalScore`, and
   * the name says the metric so it cannot read as a general goodness number.
   * Not comparable with, and never to be summed with, a lexical score —
   * combining the two signals is the hybrid stage's decision.
   */
  readonly cosineDistance: number;
}
