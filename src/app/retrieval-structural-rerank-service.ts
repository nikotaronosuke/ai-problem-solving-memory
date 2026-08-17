/**
 * The second retrieval stage: from twenty candidates to a handful, by shape.
 *
 * The first stage found Problems whose words or whose vectors resembled the
 * query. This one asks whether they are the *same kind of problem* — and the
 * answer is a model's, because the measurement said arithmetic cannot give it
 * (see `retrieval-structural-rerank.ts`). What this file owns is everything
 * around that call.
 *
 * Five things it is careful about, each for its own reason:
 *
 * **The current profile comes from the caller.** The Problem being worked on
 * is the one least likely to have a stored artifact, and if it has one it is
 * the one most likely to be out of date. Reading it here would either compare
 * against a stale description or make a search regenerate one. So it is passed
 * in — and parsed, because a type annotation on a value from outside is a
 * claim rather than a fact.
 *
 * **Candidates are re-read, not trusted.** The hybrid stage checked the owner
 * and the read control, and then time passed. A Problem can be deleted, lose
 * its artifact, or have automatic reading turned off in between, so those two
 * filters are applied again — in one statement, so all twenty come from one
 * snapshot.
 *
 * **Unreadable structure degrades the whole stage rather than dropping a
 * candidate.** This is the least obvious decision here. A candidate whose
 * stored features cannot be parsed is not a candidate that compared badly, and
 * silently removing it would make "we could not read this" indistinguishable
 * from "this is not similar". So nothing is sent, the first stage's order
 * stands, and the result says why — while the candidate itself stays in the
 * list, because there is nothing wrong with the Problem.
 *
 * **The model sees structure and nothing else.** Not the project, not the
 * first stage's scores or ranks, not the summary. A model shown which
 * candidates the previous stage liked could reproduce its ordering; one shown
 * the project could prefer the current one. Both are decisions for a later
 * stage that has not been asked for yet.
 *
 * **A credential in the features stops the call.** Two of the three inputs
 * have not been through this system's write checks — the caller's profile, and
 * features read back out of storage — and this is the boundary where they
 * would leave the process.
 *
 * **A hybrid rank is provenance, not an index.** It says where the first stage
 * put a candidate, so it survives the re-read: if the second of three
 * candidates has been deleted, the third is still rank 3. Renumbering what
 * survived would quietly rewrite the earlier stage's answer, and would hide
 * the gap that says something disappeared between the stages.
 */

import type { ProblemId } from '../domain/problem.js';
import type { ProjectId } from '../domain/project.js';
import type { HybridCandidate } from '../domain/retrieval-hybrid-search.js';
import { isRetrievalProviderIntegrationFailure } from '../domain/retrieval-provider-failure.js';
import {
  MAX_STRUCTURAL_RERANK_CANDIDATES,
  orderStructuralCandidates,
  parseStructuralRerankerOutput,
  resolveStructuralRerankRequest,
  type StructuralCandidate,
  type StructuralRerankRequest,
  type StructuralRerankResult,
  type StructuralRerankStatus,
  type StructuralReranker,
  type StructuralRerankerCandidate,
  type StructuralRerankerInput,
} from '../domain/retrieval-structural-rerank.js';
import { parseStructuralFeatures } from '../domain/retrieval-summary.js';
import type { RetrievalStructuralReader } from '../repository/index.js';
import {
  createStructuralRerankInspectionPolicy,
  sanitizeValue,
  SanitizationRejectedError,
} from '../sanitization/index.js';

export interface RetrievalStructuralRerankService {
  /** The owner whose Memory this reranks. */
  readonly ownerId: string;

  /**
   * Narrows stage-one candidates to a handful by structural similarity.
   *
   * Writes nothing, whatever the outcome. On any degraded status the stage-one
   * order stands and every score is null — a number invented because no
   * judgement was made would be a judgement nobody made.
   */
  rerank(request: StructuralRerankRequest): Promise<StructuralRerankResult>;
}

/**
 * Where an inspection of the comparison payload reports from.
 *
 * The operation and an argument position, as at every other inspection site,
 * and carrying no caller text.
 */
const INSPECTION_SITE = [
  { kind: 'operation', name: 'structuralRerank' },
  { kind: 'argument', index: 0 },
] as const;

/**
 * Where the first stage put each Problem, remembered before anything can
 * disappear.
 *
 * `hybridRank` is provenance: it is the position the hybrid stage gave a
 * candidate, not this stage's index into whatever survived the re-read. If a
 * candidate is deleted between the two stages, the ranks of the ones after it
 * stay where they were — A at 1 and C at 3, with no 2 — because renumbering
 * would silently rewrite the earlier stage's answer and make a gap, which is a
 * real event, invisible.
 */
function hybridRanks(candidates: readonly HybridCandidate[]): ReadonlyMap<ProblemId, number> {
  return new Map(candidates.map((candidate, index) => [candidate.problemId, index + 1]));
}

/** Stage-one order, no scores, no claimed evidence. */
function degraded(
  candidates: readonly { problemId: ProblemId; projectId: ProjectId }[],
  ranks: ReadonlyMap<ProblemId, number>,
  limit: number,
  status: StructuralRerankStatus,
): StructuralRerankResult {
  return {
    candidates: candidates
      .map((candidate) => ({
        problemId: candidate.problemId,
        projectId: candidate.projectId,
        structuralScore: null,
        hybridRank: ranks.get(candidate.problemId) ?? 0,
        matchedDimensions: [],
      }))
      .slice(0, limit),
    status,
  };
}

/**
 * Builds the service.
 *
 * The privacy policy is constructed here and is not a parameter: a policy that
 * a caller could replace would make "a credential is never sent to a
 * reranker" a default rather than a rule. It arrives from the sanitization
 * module rather than being assembled from a detector, so what a credential
 * looks like stays inside that boundary.
 *
 * The reranker may be absent, so a server with no configured retrieval stack
 * still answers a search: the stage degrades to `RERANKER_UNAVAILABLE` with
 * null scores and stage-one order — the same answer an outage produces. It is
 * not a licence to skip the stage's own checks, and the code below does not:
 * the candidates are re-read, their visibility re-established and their stored
 * features validated *before* the absence is noticed, because a deleted or
 * switched-off candidate must not survive on the grounds that nothing was
 * going to rank it. A stand-in reranker returning invented scores was rejected
 * for the reason a fake embedding provider was.
 */
export function createRetrievalStructuralRerankService(
  reader: RetrievalStructuralReader,
  reranker: StructuralReranker | undefined,
): RetrievalStructuralRerankService {
  const inspectionPolicy = createStructuralRerankInspectionPolicy();

  return {
    ownerId: reader.ownerId,

    async rerank(request): Promise<StructuralRerankResult> {
      // Everything, before anything runs. An invalid request must reach
      // neither the database nor a model.
      const resolved = resolveStructuralRerankRequest(request, parseStructuralFeatures);

      // Taken from the list as it arrived, before the re-read can remove
      // anything from it. Every rank reported below comes from here.
      const ranks = hybridRanks(request.candidates);

      // One snapshot, owner-scoped, with the read control applied again.
      const rows = await reader.readStructural(
        resolved.candidates.map((candidate) => candidate.problemId),
      );
      const byProblem = new Map(rows.map((row) => [row.problemId, row]));

      // A candidate the reader did not return has been deleted, lost its
      // artifact, been switched off, or was never this owner's. All four are
      // one answer, and all four mean it is simply gone.
      const present = resolved.candidates.filter((candidate) => byProblem.has(candidate.problemId));

      // The Project a candidate belongs to cannot differ between two reads of
      // the same join. If it does, the inputs are not what they claim.
      for (const candidate of present) {
        if (byProblem.get(candidate.problemId)?.projectId !== candidate.projectId) {
          throw new Error('A candidate was reported under two Projects.');
        }
      }

      // Nothing to reorder, so nothing to ask. One candidate has no rival and
      // zero have nothing to compare; either way a model call would buy an
      // ordering that already exists.
      if (present.length <= 1) {
        return degraded(present, ranks, resolved.limit, 'NOT_NEEDED');
      }

      let rerankerCandidates: StructuralRerankerCandidate[];
      try {
        rerankerCandidates = present.map((candidate) => ({
          problemId: candidate.problemId,
          features: parseStructuralFeatures(byProblem.get(candidate.problemId)?.structuralFeatures),
        }));
      } catch {
        // One unreadable feature object stops the stage rather than removing
        // that candidate: dropping it would be indistinguishable from judging
        // it dissimilar, and sending the rest would compare against a set
        // quietly missing a member. The candidates are all still returned —
        // there is nothing wrong with the Problems — in stage-one order.
        return degraded(present, ranks, resolved.limit, 'STRUCTURAL_DATA_UNAVAILABLE');
      }

      // After the re-read, the visibility check and the feature validation
      // above, and before the inspection below. A candidate that is gone must
      // be gone whether or not anything was going to rank it, and unreadable
      // features are still unreadable — those two answers are this stage's
      // regardless of the model. The inspection is skipped only because there
      // is nothing to send: it exists to keep a credential from crossing a
      // boundary that, here, is not going to be crossed.
      if (reranker === undefined) {
        return degraded(present, ranks, resolved.limit, 'RERANKER_UNAVAILABLE');
      }

      // Assembled once and used three times: inspected, sent, and validated
      // against. Rebuilding it for the check would leave room for the thing
      // checked and the thing sent to drift apart.
      const rerankerInput: StructuralRerankerInput = {
        current: resolved.currentFeatures,
        candidates: rerankerCandidates,
      };

      // The exact payload that would cross the boundary, inspected whole:
      // every string and every key, on both sides. A confirmed credential
      // anywhere in it means the model is not called at all.
      try {
        sanitizeValue(rerankerInput, inspectionPolicy, [...INSPECTION_SITE]);
      } catch (error) {
        if (error instanceof SanitizationRejectedError) {
          // Which side, which candidate, which category and which value are
          // all deliberately absent from what comes back.
          return degraded(present, ranks, resolved.limit, 'SKIPPED_SENSITIVE_INPUT');
        }
        throw error;
      }

      let answered: unknown;
      try {
        answered = await reranker.rerank(rerankerInput);
      } catch (error) {
        // An answer this system cannot use, and a request the provider refused,
        // are integration failures rather than infrastructure ones: no waiting
        // fixes either, and reporting them as `RERANKER_UNAVAILABLE` would make
        // a broken integration look exactly like a deployment that configured
        // no reranker on purpose. They leave, and the search fails.
        //
        // Note what this means: a malformed answer is refused twice on this
        // path. Here, when the port classified it, and below at
        // `parseStructuralRerankerOutput` when the port merely returned it. The
        // parser remains the authority on whether a returned judgement is a
        // rerank; this only stops a port that already knew from being misread.
        if (isRetrievalProviderIntegrationFailure(error)) {
          throw error;
        }
        // Unreachable is infrastructure, and a Memory failure must not stop
        // ordinary work. Whatever else it threw stops here — including a plain
        // throw from a port written before there was a way to say more.
        return degraded(present, ranks, resolved.limit, 'RERANKER_UNAVAILABLE');
      }

      // Malformed is a contract violation rather than an outage, so it is
      // raised. Checked against what was actually sent: every candidate back
      // exactly once, so a model cannot apply a threshold this stage does not
      // have, and every dimension it claims had something on both sides.
      const judged = parseStructuralRerankerOutput(answered, rerankerInput);
      const scores = new Map(judged.map((entry) => [entry.problemId, entry]));

      const scored: StructuralCandidate[] = present.map((candidate) => {
        const entry = scores.get(candidate.problemId);
        return {
          problemId: candidate.problemId,
          projectId: candidate.projectId,
          structuralScore: entry?.structuralScore ?? 0,
          hybridRank: ranks.get(candidate.problemId) ?? 0,
          matchedDimensions: entry?.matchedDimensions ?? [],
        };
      });

      // Structure decides; the stage-one position breaks ties. The limit is
      // applied here rather than asked of the model, so the cut is this
      // code's and is the same every time.
      return {
        candidates: orderStructuralCandidates(scored, resolved.limit),
        status: 'USED',
      };
    },
  };
}

export { MAX_STRUCTURAL_RERANK_CANDIDATES };
