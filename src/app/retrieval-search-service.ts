/**
 * One search, from a Problem being worked on to Memories worth reading.
 *
 * The three retrieval stages existed and nothing joined them. This is the
 * join, and the place the specification's rule about not repeating a search
 * lives: the same search, for the same Problem, in the same state, inside a
 * short window, should not run twice.
 *
 * **What gets reused, and what does not.** The cache holds the rerank stage's
 * result — the output of the two expensive things, an embedding provider and a
 * model asked to compare structure. Ranking is never cached and runs on every
 * call, hit or miss. That division is the whole design: it skips exactly the
 * work that is costly and stable, and repeats exactly the work that reads
 * things a person can change. Suppress a Memory, lower its confidence, mark it
 * invalid, relabel its Project, turn its reading off or delete it, and the
 * next search reflects it immediately, because the stage that reads all of
 * that never sees the cache.
 *
 * **What state means.** A key is built over the Problem's canonical source —
 * its semantic fields, its Environment, every Event and every Verification —
 * so appending a Verification or correcting a symptom description misses,
 * while marking the Problem important does not. `version` is deliberately not
 * used: appending an Event does not move it.
 *
 * **The Problem is read twice on a miss.** Between the first read and the
 * result there is a network call to an embedding provider and another to a
 * reranker, which is a long time in a system where an assistant is appending
 * Events while it works. If the Problem has changed underneath, the answer
 * describes a question that is no longer being asked, so it is reported as
 * such and not cached. Nothing is retried here — what to do about it is the
 * caller's decision, and looping would hide a Problem changing faster than a
 * search completes.
 *
 * **What a caller may say.** The Problem, the two texts, the structural
 * profile, an optional Project filter and the two limits. Not the owner, not
 * the current Project, not which Problem to exclude, and nothing about trust
 * or currency. The current Project is read from the Problem's own row, so
 * naming one Problem and a different Project's neighbourhood is unstateable;
 * the excluded Problem is the current one by construction, so the two cannot
 * drift apart.
 */

import type { OwnerId } from '../domain/owner.js';
import type { ProblemId } from '../domain/problem.js';
import type { ProjectId } from '../domain/project.js';
import {
  computeRetrievalSearchCacheKey,
  type RetrievalSearchCacheEntry,
} from '../domain/retrieval-search-cache.js';
import {
  resolveFullTextSearchQuery,
  resolveVectorSearchQuery,
} from '../domain/retrieval-search.js';
import {
  resolveStructuralRerankLimit,
  type StructuralRerankResult,
  type StructuralRerankStatus,
} from '../domain/retrieval-structural-rerank.js';
import {
  fingerprintRetrievalSource,
  parseStructuralFeatures,
  type StructuralFeatures,
} from '../domain/retrieval-summary.js';
import { toUsageSourceAi } from '../domain/usage-log.js';
import type {
  RetrievalUsageLogFailureReporter,
  RetrievalUsageLogWriter,
} from './retrieval-usage-log-writer.js';
import type { RetrievalMemoryCandidate } from '../domain/retrieval-result.js';
import type { RetrievalSummarySourceReader } from '../repository/index.js';
import type { RetrievalConflictService } from './retrieval-conflict-service.js';
import type { RetrievalDeadEndService } from './retrieval-dead-end-service.js';
import type { RetrievalSuccessfulDirectionService } from './retrieval-successful-direction-service.js';
import type { RetrievalRevalidationService } from './retrieval-revalidation-service.js';
import type { RetrievalSearchCache } from './retrieval-search-cache.js';
import {
  resolveHybridSearchLimit,
  type RetrievalHybridSearchService,
  type SemanticChannelStatus,
} from './retrieval-hybrid-search-service.js';
import type { RetrievalRankingService } from './retrieval-ranking-service.js';
import type { RetrievalStructuralRerankService } from './retrieval-structural-rerank-service.js';

/** Raised when a search cannot be accepted as asked. */
export class InvalidRetrievalSearchError extends Error {
  readonly field: string;

  constructor(field: string, reason: string) {
    // A field and a fixed reason. Never a value: a search request carries the
    // words somebody typed and a description of their own Problem.
    super(`Retrieval search ${field} is unusable: ${reason}.`);
    this.name = 'InvalidRetrievalSearchError';
    this.field = field;
  }
}

export interface RetrievalSearchRequest {
  /**
   * The Problem being worked on now.
   *
   * Both the subject of the search and the thing excluded from it: a Problem
   * is not a memory of itself.
   */
  readonly currentProblemId: ProblemId;
  readonly lexicalText: string;
  readonly semanticText: string;
  readonly currentFeatures: StructuralFeatures;
  readonly projectId?: ProjectId;
  readonly hybridLimit?: number;
  readonly rerankLimit?: number;
}

/**
 * How a search ended.
 *
 * Four outcomes, three of which are ordinary rather than exceptional. A
 * Problem that cannot be read is not an error — it is a Problem somebody
 * deleted, or never had, or turned automatic reading off for — and raising
 * would make a caller handle a user's own setting as a fault.
 *
 * There is no cache status. Whether an answer was recomputed is not something
 * a caller acts on, and a field saying so would be a product promise made for
 * the convenience of tests.
 */
export type RetrievalSearchOutcome =
  | {
      readonly kind: 'SEARCHED';
      /**
       * The Memories offered, best first.
       *
       * Each carries why it is here and in this position, and what has to be
       * re-established before it is acted on. A search result is a candidate
       * rather than an answer, and the second half is how that is said.
       */
      readonly candidates: readonly RetrievalMemoryCandidate[];
      readonly semanticStatus: SemanticChannelStatus;
      readonly structuralStatus: StructuralRerankStatus;
    }
  | {
      /** Unknown, deleted, or another owner's. One answer for all three. */
      readonly kind: 'CURRENT_PROBLEM_NOT_AVAILABLE';
    }
  | {
      /** Automatic reading is off for the Problem being worked on. */
      readonly kind: 'MEMORY_READ_DISABLED';
    }
  | {
      /** The Problem changed while the search was running. */
      readonly kind: 'CURRENT_SOURCE_CHANGED';
    };

/**
 * Who is running this search.
 *
 * Separate from the request because it answers a different question. The
 * request says what to look for; this says who is looking, which changes
 * nothing about what comes back and everything about what the usage record
 * means. Keeping them apart is also what lets one search be reused across two
 * assistants while each is recorded under its own name.
 */
export interface RetrievalSearchInvocation {
  /**
   * The assistant, tool or person searching.
   *
   * Free-form, as everywhere else `source_ai` appears: provider and model
   * names change, and manual entries exist alongside them. Descriptive only —
   * it never affects which owner's Memory is reachable.
   */
  readonly sourceAi: string;
}

export interface RetrievalSearchService {
  /** The owner every stage of this search is scoped to. */
  readonly ownerId: OwnerId;

  /**
   * Finds past Memories worth reading for the Problem being worked on.
   *
   * Changes no Memory. It does record, in the usage log, that each Memory it
   * surfaced was surfaced — which is an observation about the search rather
   * than a change to anything it found.
   */
  search(
    request: RetrievalSearchRequest,
    invocation: RetrievalSearchInvocation,
  ): Promise<RetrievalSearchOutcome>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Builds the search service.
 *
 * The cache is a parameter because it must outlive a request. Everything else
 * here is owner-scoped and rebuilt per request, so a cache constructed inside
 * would start empty every time and never answer anything — which would look
 * like a working cache and be a slow one.
 *
 * All seven collaborators must be scoped to the same owner, and it is checked
 * once here. Each is owner-safe alone and none can see the others, so a
 * composition pairing one owner's reader with another's search would produce a
 * result mixing two people's Memory with every part behaving correctly. Only
 * the pairing can be wrong, so only the pairing is checked — and a wrongly
 * built service should not exist rather than fail later on somebody's search.
 * The usage log writer is in that check for the same reason as the rest: a row
 * recorded against the wrong owner is a false statement about who searched
 * what.
 *
 * The failure reporter has no default, deliberately. See its own
 * documentation: a default would make silence the easiest thing to get.
 */
export function createRetrievalSearchService(
  sourceReader: RetrievalSummarySourceReader,
  hybridService: RetrievalHybridSearchService,
  rerankService: RetrievalStructuralRerankService,
  rankingService: RetrievalRankingService,
  revalidationService: RetrievalRevalidationService,
  deadEndService: RetrievalDeadEndService,
  successfulDirectionService: RetrievalSuccessfulDirectionService,
  conflictService: RetrievalConflictService,
  cache: RetrievalSearchCache,
  usageLogWriter: RetrievalUsageLogWriter,
  usageLogFailureReporter: RetrievalUsageLogFailureReporter,
): RetrievalSearchService {
  const ownerId = sourceReader.ownerId;
  if (
    hybridService.ownerId !== ownerId ||
    rerankService.ownerId !== ownerId ||
    rankingService.ownerId !== ownerId ||
    revalidationService.ownerId !== ownerId ||
    deadEndService.ownerId !== ownerId ||
    successfulDirectionService.ownerId !== ownerId ||
    conflictService.ownerId !== ownerId ||
    usageLogWriter.ownerId !== ownerId
  ) {
    // Naming the owners would put two identifiers wherever this error goes.
    throw new Error('The retrieval stages belong to different owners.');
  }

  /**
   * Ranks a rerank result against the database as it is right now, then
   * attaches what each surviving Memory was recorded under.
   *
   * Reached identically from a hit and a miss, which is what makes "a cached
   * search still respects every control" true by construction rather than by
   * two code paths agreeing with each other — and what makes the historical
   * context as fresh on a reused search as on a new one. A Verification added
   * since the cache was filled shows up on the next search, because none of
   * this is cached.
   */
  async function rankAndReport(
    currentProjectId: ProjectId,
    reranked: StructuralRerankResult,
    semanticStatus: SemanticChannelStatus,
  ): Promise<RetrievalSearchOutcome> {
    const ranked = await rankingService.rank({ currentProjectId, structuralResult: reranked });
    // Each stage adds one thing and may drop a Memory that has gone since the
    // one before it read. All three enrichments run on every search — a
    // Verification, a dead end or a contradiction recorded against a
    // *candidate* moves nothing the cache key watches, which is built from the
    // Problem being worked on, so anything remembered here would go stale with
    // nothing to notice.
    const revalidated = await revalidationService.enrich(ranked.candidates);
    const withDeadEnds = await deadEndService.enrich(revalidated);
    // Directions the record supports come from the stored search profile
    // rather than from an Event, and are gated again on the Problem's status
    // and checks as they are now — so a record that does not pass the gate is
    // never offered them, whatever its artifact still names.
    const withDirections = await successfulDirectionService.enrich(withDeadEnds);
    return {
      kind: 'SEARCHED',
      candidates: await conflictService.enrich(withDirections),
      semanticStatus,
      structuralStatus: ranked.structuralStatus,
    };
  }

  /**
   * Records that each surfaced Memory was surfaced.
   *
   * Best effort, and the asymmetry is deliberate. The search has already
   * succeeded and the caller is holding its answer; losing the record of it is
   * a real loss, but it is a smaller one than throwing away work somebody is
   * waiting on because a side observation could not be written. That is the
   * standing rule that a Memory failure must not stop ordinary work, applied
   * to the one write on the retrieval path.
   *
   * What is not done is swallowing it. The failure goes to a reporter that
   * cannot be defaulted away, carrying a kind and a count and nothing else.
   */
  async function recordSurfaced(
    currentProblemId: ProblemId,
    sourceAi: string,
    outcome: RetrievalSearchOutcome,
  ): Promise<void> {
    // Only a search that surfaced something. The three other outcomes returned
    // no candidates at all, and a row claiming otherwise would be a false
    // record of a Memory having been offered.
    if (outcome.kind !== 'SEARCHED' || outcome.candidates.length === 0) {
      return;
    }

    try {
      await usageLogWriter.recordSearched({
        currentProblemId,
        sourceAi,
        // The candidates as ranked and enriched just now — never the cached
        // rerank. A Memory deleted or switched off since the cache was filled
        // is absent from these, and must stay absent from the log too. The
        // ranking view is what the log records; a Memory's historical
        // conditions and its evidence are not what a usage record is about.
        candidates: outcome.candidates.map((candidate) => candidate.ranking),
        semanticStatus: outcome.semanticStatus,
        structuralStatus: outcome.structuralStatus,
      });
    } catch {
      // Whatever it threw stops here. The count is a number this code chose;
      // everything the failure knew — the driver's message, the Problem, the
      // Memories, who was searching — stays out of a report that travels.
      usageLogFailureReporter.report({
        kind: 'SEARCH_USAGE_LOG_WRITE_FAILED',
        attemptedRows: outcome.candidates.length,
      });
    }
  }

  return {
    ownerId,

    async search(request, invocation): Promise<RetrievalSearchOutcome> {
      // Everything a caller controls, before the database is touched. The
      // stage resolvers are reused rather than reimplemented, so a request
      // this accepts is one they accept, and the effective limits below are
      // the ones the stages will actually apply.
      if (
        typeof request.currentProblemId !== 'string' ||
        !UUID_PATTERN.test(request.currentProblemId)
      ) {
        throw new InvalidRetrievalSearchError('current problem', 'it is not an identifier');
      }
      // The same rule the usage log itself applies, borrowed rather than
      // rewritten, and applied here so a search that could never be attributed
      // does not reach a database or a provider first. Re-raised as this
      // surface's own error: a caller of a search should not have to catch a
      // usage log's.
      let sourceAi: string;
      try {
        sourceAi = toUsageSourceAi(invocation.sourceAi);
      } catch {
        throw new InvalidRetrievalSearchError('source ai', 'it does not name who is searching');
      }
      const filters = request.projectId === undefined ? {} : { projectId: request.projectId };
      resolveFullTextSearchQuery({ text: request.lexicalText, ...filters });
      resolveVectorSearchQuery({ text: request.semanticText, ...filters });
      const effectiveHybridLimit = resolveHybridSearchLimit(request.hybridLimit);
      const effectiveRerankLimit = resolveStructuralRerankLimit(request.rerankLimit);
      // Parsed rather than trusted: the annotation is a claim about a value
      // that came from outside, and the key is built from the parsed form so
      // that two spellings of the same profile cannot key differently.
      const currentFeatures = parseStructuralFeatures(request.currentFeatures);

      const before = await sourceReader.readSource(request.currentProblemId);
      if (before === undefined) {
        return { kind: 'CURRENT_PROBLEM_NOT_AVAILABLE' };
      }
      if (!before.memoryReadEnabled) {
        // Their setting, on the Problem they are working on. Not an error, and
        // not something a cached answer may route around.
        return { kind: 'MEMORY_READ_DISABLED' };
      }

      const understandingFingerprint = fingerprintRetrievalSource(before.canonicalSource);
      const key = computeRetrievalSearchCacheKey({
        ownerId,
        currentProblemId: request.currentProblemId,
        understandingFingerprint,
        lexicalText: request.lexicalText,
        semanticText: request.semanticText,
        projectId: request.projectId ?? null,
        effectiveHybridLimit,
        effectiveRerankLimit,
        currentFeatures,
      });

      const cached = cache.get(key);
      if (cached !== undefined) {
        // Everything expensive skipped, and everything editable re-read. The
        // semantic status is known without being stored: only a search whose
        // semantic half ran normally was ever eligible to be here.
        const reused = await rankAndReport(before.projectId, cached, 'USED');
        // A reused search is still a search. The same Memories were offered
        // again, to whoever is searching now, and that is a second observation
        // rather than a repeat of the first.
        await recordSurfaced(request.currentProblemId, sourceAi, reused);
        return reused;
      }

      const hybrid = await hybridService.search({
        lexicalText: request.lexicalText,
        semanticText: request.semanticText,
        ...filters,
        // Always the Problem being worked on. There is no caller field for
        // this, so it cannot disagree with the Problem named above.
        excludeProblemId: request.currentProblemId,
        limit: effectiveHybridLimit,
      });

      const reranked = await rerankService.rerank({
        currentFeatures,
        candidates: hybrid.candidates,
        excludeProblemId: request.currentProblemId,
        limit: effectiveRerankLimit,
      });

      // The Problem again, after the two long calls. A rerank against a
      // description of the Problem as it was several seconds ago is an answer
      // to a question that has moved.
      const after = await sourceReader.readSource(request.currentProblemId);
      if (after === undefined) {
        return { kind: 'CURRENT_PROBLEM_NOT_AVAILABLE' };
      }
      if (!after.memoryReadEnabled) {
        return { kind: 'MEMORY_READ_DISABLED' };
      }
      if (fingerprintRetrievalSource(after.canonicalSource) !== understandingFingerprint) {
        // Not retried. Retrying would loop for as long as the Problem keeps
        // changing, and whether to search again now or carry on is a decision
        // for whoever is doing the work.
        return { kind: 'CURRENT_SOURCE_CHANGED' };
      }
      if (after.projectId !== before.projectId) {
        // A Problem cannot move between Projects, so this is not a race — it
        // is two reads of one row disagreeing, and ranking on either answer
        // would rest on a contradiction.
        throw new Error('The current Problem was reported under two Projects.');
      }

      // Ranking first, then the cache. A ranking failure means the search did
      // not complete, and a result stored before the last stage succeeded
      // would be a partial answer with a five-minute life.
      const outcome = await rankAndReport(after.projectId, reranked, hybrid.semanticStatus);

      // Only now, and only for a search that ran cleanly end to end. A
      // degraded outcome cached here would keep a provider outage or a skipped
      // credential frozen in place for five minutes after the cause was gone.
      if (isCacheable(hybrid.semanticStatus, reranked.status)) {
        cache.set(key, reranked);
      }

      // After the cache, and independent of it. Reuse is a performance
      // question and this is an observation: a lost log line must not discard
      // a result worth reusing, and a stored result must not depend on the log
      // line having been written. A degraded search that still surfaced
      // Memories is recorded here even though it was not worth caching —
      // those Memories really were offered.
      await recordSurfaced(request.currentProblemId, sourceAi, outcome);

      return outcome;
    },
  };
}

/**
 * Whether a completed search is one worth remembering.
 *
 * Only a clean one. Every degraded outcome is a statement about a moment — a
 * provider that did not answer, a credential recognised in the text, features
 * that could not be read — and none is a statement about the search. Storing
 * one would answer the next five minutes of searching with the consequences of
 * a failure that may already be over.
 *
 * `NOT_NEEDED` is cacheable and is not a degradation: it means the rerank
 * stage found nothing to reorder, which is a complete and correct answer.
 */
function isCacheable(
  semanticStatus: SemanticChannelStatus,
  structuralStatus: StructuralRerankStatus,
): boolean {
  return (
    semanticStatus === 'USED' && (structuralStatus === 'USED' || structuralStatus === 'NOT_NEEDED')
  );
}

export type { RetrievalSearchCacheEntry };
