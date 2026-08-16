/**
 * Recording that past Memory was surfaced by a search.
 *
 * The specification asks that it be possible to tell later which AI searched,
 * referenced and adopted which Memory. Of those, a search can honestly observe
 * exactly one: that a Memory came back as a candidate. Whether anybody then
 * read it, took its direction, set it aside, or changed course because of it
 * happens somewhere this code cannot see, and an adapter reports those when it
 * observes them. So this writer produces `SEARCHED` and nothing else — the
 * existing actions are observations rather than stages, and inventing three of
 * them from a fourth would turn the log into a workflow it was deliberately
 * not made into.
 *
 * **What is written is server-composed.** The reason is built here from a
 * closed vocabulary: a rank, a Project relation, two channel outcomes and a
 * list of comparison dimensions. No caller supplies text. The alternative — a
 * free-form reason from whoever called the search — would put the query, the
 * caller's own description of their Problem, and whatever a model returned
 * into a permanent row, and a search query is allowed to contain
 * credential-shaped text precisely because it is used and thrown away.
 *
 * **The type is the boundary.** There is no field on this writer's input that
 * could carry a query, a structural profile or a candidate's summary. A rule
 * about what must not be logged is only as good as the next person who reads
 * it; a shape with nowhere to put the text is checked by the compiler.
 */

import type { UsageAction } from '../domain/enums.js';
import type { OwnerId } from '../domain/owner.js';
import type { ProblemId } from '../domain/problem.js';
import type { RankedMemoryCandidate } from '../domain/retrieval-ranking.js';
import type { StructuralRerankStatus } from '../domain/retrieval-structural-rerank.js';
import { toUsageSourceAi } from '../domain/usage-log.js';
import type { AuthenticatedRequestContext } from './request-context.js';
import type { SemanticChannelStatus } from './retrieval-hybrid-search-service.js';

/** The one action a search can observe for itself. */
const SEARCHED: UsageAction = 'SEARCHED';

/**
 * Everything a search knows about one candidate it surfaced.
 *
 * Deliberately not the candidate itself. What a ranking produces carries a
 * structural score, a trust level, a currency and a suppression flag; those
 * decide an order and are not an account of what looked similar, so they are
 * not part of what is written down.
 */
export interface RecordSearchedInput {
  /** The Problem being worked on when the Memory surfaced. */
  readonly currentProblemId: ProblemId;
  readonly sourceAi: string;
  readonly candidates: readonly RankedMemoryCandidate[];
  readonly semanticStatus: SemanticChannelStatus;
  readonly structuralStatus: StructuralRerankStatus;
}

export interface RetrievalUsageLogWriter {
  /** The owner every row written through this writer belongs to. */
  readonly ownerId: OwnerId;

  /**
   * Records one `SEARCHED` row per candidate, all together or not at all.
   *
   * Nothing is written for an empty list. A row needs a Memory to point at,
   * and a search that surfaced nothing has none — inventing one, or pointing
   * the row at the Problem being worked on, would record a use that did not
   * happen. That a search ran at all is a different question, for a wider
   * audit than this table was built to be.
   */
  recordSearched(input: RecordSearchedInput): Promise<void>;
}

/**
 * What went wrong, in the only terms that are safe to pass on.
 *
 * One kind and a count. Not the driver's error, not its message, not the
 * Problem or the Memory or who was searching — a failure report travels to
 * wherever an operator looks, and the same reasoning that keeps a query out of
 * an operational log keeps all of it out of here. `attemptedRows` is a number
 * this code chose, between one and five, and it is enough to tell a lost
 * observation from a lost pile of them.
 */
export interface RetrievalUsageLogFailure {
  readonly kind: 'SEARCH_USAGE_LOG_WRITE_FAILED';
  readonly attemptedRows: number;
}

/**
 * Where a lost observation is reported.
 *
 * Required, with no default. A default that printed would choose an output
 * nobody asked for, and a default that did nothing would make silence the
 * easiest thing to get — which is exactly the failure this port exists to
 * prevent. Whoever composes a search has to say where the report goes.
 *
 * `report` must not throw. It is called on a path that has already decided
 * not to fail, and a reporter that raised would turn a lost log line into a
 * lost search result.
 */
export interface RetrievalUsageLogFailureReporter {
  report(failure: RetrievalUsageLogFailure): void;
}

/**
 * The fixed shape of a `SEARCHED` reason.
 *
 * Five facts, all from closed sets, in one order. Fixed rather than prose
 * because this text is permanent and will be read by something later — a
 * format that varied by case would be a parsing problem handed to whoever
 * wants to know what a search actually found.
 */
export const SEARCHED_REASON_PREFIX = 'Surfaced by retrieval search';

/** What a reason says when the rerank named no dimensions. */
export const NO_COMPARISON_DIMENSIONS = 'none';

/**
 * Composes the reason for one surfaced candidate.
 *
 * On `comparison_dimensions`, the wording is careful on purpose. The rerank
 * stage guarantees that a dimension it named had content on both sides; it
 * does not guarantee, and this code never checked, that the two contents mean
 * the same thing. Calling them "matched" would claim a verification nobody
 * performed, so they are recorded as what they are — the respects in which
 * the two Problems were compared.
 *
 * A degraded rerank names nothing, so the list reads `none` and the reason
 * makes no claim about structure at all.
 */
export function composeSearchedReason(
  candidate: RankedMemoryCandidate,
  semanticStatus: SemanticChannelStatus,
  structuralStatus: StructuralRerankStatus,
): string {
  const dimensions =
    candidate.matchedDimensions.length === 0
      ? NO_COMPARISON_DIMENSIONS
      : candidate.matchedDimensions.join(',');

  return (
    `${SEARCHED_REASON_PREFIX}; ` +
    `ranking_rank=${String(candidate.rankingRank)}; ` +
    `project_relation=${candidate.projectRelation}; ` +
    `semantic_status=${semanticStatus}; ` +
    `structural_status=${structuralStatus}; ` +
    `comparison_dimensions=${dimensions}.`
  );
}

/**
 * Builds the writer for one authenticated request.
 *
 * The owner comes from the repository the context already established, so
 * there is no owner parameter here and no way for a caller to name one.
 *
 * Writes go through the context's transactional repository, which is the
 * sanitized one. Reaching past it to the database directly would be quicker
 * and would skip the boundary every other write in this system passes — and
 * `source_ai` is caller-derived text, so that boundary is doing real work on
 * this path rather than standing by.
 */
export function createRetrievalUsageLogWriter(
  context: AuthenticatedRequestContext,
): RetrievalUsageLogWriter {
  return {
    ownerId: context.repository.ownerId,

    async recordSearched(input): Promise<void> {
      if (input.candidates.length === 0) {
        return;
      }

      // Validated before anything is opened, and with the rule the rest of the
      // system already uses rather than a second one written here.
      const sourceAi = toUsageSourceAi(input.sourceAi);

      // One transaction around the rows and nothing else. Two of five would
      // record a search that never happened — a shorter list of Memories than
      // the one that was actually offered. The search itself, its provider
      // call and its model call are long finished; holding a connection across
      // any of them would be a transaction spanning somebody else's network.
      await context.runInTransaction(async (repository) => {
        for (const candidate of input.candidates) {
          await repository.createUsageLog({
            problemId: input.currentProblemId,
            sourceAi,
            action: SEARCHED,
            memoryId: candidate.problemId,
            reason: composeSearchedReason(candidate, input.semanticStatus, input.structuralStatus),
            // A memory that has just been found has no outcome yet, and
            // "searched successfully" is not one — it would record the
            // search's own success as though it were the Memory's.
            result: null,
          });
        }
      });
    },
  };
}
