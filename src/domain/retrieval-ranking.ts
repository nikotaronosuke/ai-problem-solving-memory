/**
 * Putting a handful of judged candidates in the order they should be offered.
 *
 * The structural stage answered "is this the same kind of problem?". This one
 * answers a different question: given several that are, which should a person
 * see first? The inputs are all stored controls somebody set deliberately —
 * how much a Memory is trusted, whether it still describes current conditions,
 * whether they asked to see less of it — plus where it came from and how
 * strongly the reranker judged it.
 *
 * **This stage is arithmetic, and that is the point.** P4-07 needed a model
 * because "same kind of problem" cannot be computed from words. Nothing here
 * needs one: every input is an enum, a boolean, an identifier or a number that
 * already exists. The boundary the specification draws puts routine
 * deterministic work in code, and this is routine deterministic work. So there
 * is no port, no network call, no provider outage to degrade around and no new
 * place a credential could leave the process.
 *
 * **A lexicographic tuple, not a weighted sum.** The temptation is to score:
 * `HIGH` is worth 0.3, same technology is worth 0.1, add them to the
 * structural score and sort. That was simulated against the fixtures before it
 * was rejected. Two problems with it. The first is that the weights are
 * invented — there is no exchange rate between "verified twice" and "0.3 more
 * structurally similar", and picking one silently declares that there is. The
 * second is that the answer moves when the invented number moves: with a
 * same-technology bonus of 0.86 the ordering is one thing and at 0.9 it is
 * another, so the policy is whatever the constant happened to be. A tuple has
 * no constants to pick, and each comparison is one sentence long.
 *
 * **Why structure comes before where a Memory is from.** The specification's
 * search order is current Project, then the same technology elsewhere, then a
 * different technology with similar structure — and in the same breath it says
 * a matching technology name must not be the deciding factor on its own. Those
 * pull in opposite directions when a same-technology Memory has almost nothing
 * structurally in common and a cross-technology one has everything. Every
 * arrangement that put proximity above structure was tried against the
 * fixtures, and each one let a same-technology candidate scoring 0.05 beat a
 * cross-technology candidate scoring 0.95 — which is the acceptance condition
 * for the entire system, failing. Reading the search order as the order in
 * which the search *widens*, rather than as an absolute tier, is what the
 * earlier phase documents say too, and it keeps both halves of the
 * specification true. The order still appears: it decides between candidates
 * of equal trust and equal structural similarity, and it comes to the front
 * whenever the structural stage did not run.
 */

import type { Confidence, Freshness } from './enums.js';
import type { ProblemId } from './problem.js';
import type { ProjectId } from './project.js';
import {
  MAX_STRUCTURAL_RERANK_LIMIT,
  type StructuralCandidate,
  type StructuralComparisonDimension,
  type StructuralRerankResult,
  type StructuralRerankStatus,
} from './retrieval-structural-rerank.js';

/**
 * How a candidate's Project stands to the one being worked in.
 *
 * Four values, exclusive by construction. A candidate in the current Project
 * is `CURRENT_PROJECT` and nothing else, so being nearby cannot be counted
 * twice — once for the Project and again for sharing its technology.
 *
 * `OTHER_TECH` and `UNKNOWN_TECH` are separate words for genuinely different
 * situations: one Project says it is built on something else, the other has
 * not said what it is built on. They rank identically, because not knowing is
 * not evidence of difference, but a caller reading the result can tell them
 * apart — and a later stage that wants to ask for the missing label needs to
 * know which one it is looking at.
 */
export const PROJECT_RELATIONS = [
  'CURRENT_PROJECT',
  'SAME_TECH_OTHER_PROJECT',
  'OTHER_TECH',
  'UNKNOWN_TECH',
] as const;

export type ProjectRelation = (typeof PROJECT_RELATIONS)[number];

/** The most candidates a ranking accepts — one structural rerank's output. */
export const MAX_RANKED_CANDIDATES = MAX_STRUCTURAL_RERANK_LIMIT;

/** Raised when a ranking cannot be accepted as asked. */
export class InvalidRetrievalRankingError extends Error {
  readonly field: string;

  constructor(field: string, reason: string) {
    // A field and a fixed reason, never a value. The request carries
    // identifiers and somebody's structural judgement of their own Problem.
    super(`Retrieval ranking ${field} is unusable: ${reason}.`);
    this.name = 'InvalidRetrievalRankingError';
    this.field = field;
  }
}

/**
 * Trust order, most trusted first.
 *
 * `CONFLICTED` sits last. It does not mean "weak evidence" — it means the
 * record holds evidence pointing both ways — but of the four it is the one a
 * reader can least safely act on, so it is offered last. Nothing else about a
 * conflict is looked at here: which Memories disagree, and why, is a separate
 * question with its own task.
 */
const CONFIDENCE_ORDER: readonly Confidence[] = ['HIGH', 'MEDIUM', 'LOW', 'CONFLICTED'];

/**
 * Currency order, most current first.
 *
 * `STALE_UNKNOWN` outranks `SUPERSEDED` because "nobody has checked" leaves
 * open that it still holds, while "something replaced this" says a better
 * answer exists. `INVALID` is last and is still returned: the specification
 * distinguishes marking a Memory invalid from deleting it, and dropping it
 * from a result would collapse that distinction. Ranking it last is the whole
 * of the demotion.
 */
const FRESHNESS_ORDER: readonly Freshness[] = ['CURRENT', 'STALE_UNKNOWN', 'SUPERSEDED', 'INVALID'];

/**
 * Proximity order.
 *
 * `OTHER_TECH` and `UNKNOWN_TECH` share a rank deliberately — see
 * `PROJECT_RELATIONS`.
 */
const RELATION_ORDER: Readonly<Record<ProjectRelation, number>> = {
  CURRENT_PROJECT: 0,
  SAME_TECH_OTHER_PROJECT: 1,
  OTHER_TECH: 2,
  UNKNOWN_TECH: 2,
};

function ordinalOf<T>(order: readonly T[], value: T, field: string): number {
  const index = order.indexOf(value);
  if (index < 0) {
    throw new InvalidRetrievalRankingError(field, 'it is not a known value');
  }
  return index;
}

/**
 * Whether two Projects are built on the same thing, as far as this can tell.
 *
 * `platform` is a free-form label somebody typed, and it is the only field in
 * the model that claims to name a Project's technology. It is compared by
 * case-insensitive equality after the trimming that storage already applied,
 * and by nothing else.
 *
 * That is a coarse instrument and the limits are real: `React` matches
 * `react`, but `Node.js` does not match `node` and `React` does not match
 * `React Native`. Fixing those means punctuation rules, version stripping,
 * synonym tables or token overlap — a technology-identity model invented
 * inside a ranking function, tuned against nothing. A missed match costs a
 * tie-break, which the structural score has usually already decided; an
 * invented match would silently assert that two Projects share a stack when
 * nobody said so. When a better technology identity is needed it should arrive
 * as its own piece of work, with somewhere to store it.
 *
 * A null on either side is not a mismatch. It means one Project has not said,
 * and treating silence as difference would quietly downgrade every Project
 * nobody has labelled.
 */
export function classifyProjectRelation(
  currentProjectId: ProjectId,
  currentPlatform: string | null,
  candidateProjectId: ProjectId,
  candidatePlatform: string | null,
): ProjectRelation {
  if (candidateProjectId === currentProjectId) {
    return 'CURRENT_PROJECT';
  }
  if (currentPlatform === null || candidatePlatform === null) {
    return 'UNKNOWN_TECH';
  }
  return currentPlatform.toLowerCase() === candidatePlatform.toLowerCase()
    ? 'SAME_TECH_OTHER_PROJECT'
    : 'OTHER_TECH';
}

/** A candidate with everything the ordering reads, before it is ordered. */
export interface RankableCandidate {
  readonly problemId: ProblemId;
  readonly projectId: ProjectId;
  readonly confidence: Confidence;
  readonly freshness: Freshness;
  readonly suppressed: boolean;
  readonly projectRelation: ProjectRelation;
  /** 0 to 1 when the structural stage ran, null when it did not. */
  readonly structuralScore: number | null;
  readonly hybridRank: number;
  readonly matchedDimensions: readonly StructuralComparisonDimension[];
}

/** One ranked candidate, in the order it should be offered. */
export interface RankedMemoryCandidate extends RankableCandidate {
  /**
   * This stage's final position: 1-based and contiguous.
   *
   * Distinct from `hybridRank`, which is where the first retrieval stage put
   * the candidate and keeps its gaps. Two different facts, so two fields; one
   * standing in for the other would lose whichever it replaced.
   */
  readonly rankingRank: number;
}

export interface RetrievalRankingResult {
  readonly candidates: readonly RankedMemoryCandidate[];
  /**
   * How the structural stage ended, carried through unchanged.
   *
   * Without it a null `structuralScore` is unreadable: a later stage could not
   * tell "no reranker was available" from anything else, and might take the
   * absence of a score for a low one.
   */
  readonly structuralStatus: StructuralRerankStatus;
}

export interface RetrievalRankingRequest {
  /**
   * The Project the work is happening in.
   *
   * Required. Proximity is measured against it, and a ranking without it would
   * silently drop the first of the specification's three preference steps
   * rather than say it could not apply it.
   */
  readonly currentProjectId: ProjectId;
  readonly structuralResult: StructuralRerankResult;
}

/** A validated request. */
export interface ResolvedRetrievalRankingRequest {
  readonly currentProjectId: ProjectId;
  readonly candidates: readonly StructuralCandidate[];
  readonly structuralStatus: StructuralRerankStatus;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const KNOWN_STATUSES: readonly StructuralRerankStatus[] = [
  'USED',
  'NOT_NEEDED',
  'SKIPPED_SENSITIVE_INPUT',
  'RERANKER_UNAVAILABLE',
  'STRUCTURAL_DATA_UNAVAILABLE',
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Checks a ranking request before anything runs.
 *
 * Everything up front, so an unusable request never reaches the database.
 *
 * The check worth naming is the one on scores. The structural stage either ran
 * or it did not, and it says which: on `USED` every candidate carries a score,
 * and on any other status every candidate carries null. A mixture cannot be
 * produced by that stage, so a mixture arriving here means the input is not
 * what it claims — and it is refused rather than patched, because patching it
 * would mean deciding whether the nulls are zeros, which is the one thing this
 * stage must never decide.
 */
export function resolveRetrievalRankingRequest(
  request: RetrievalRankingRequest,
): ResolvedRetrievalRankingRequest {
  const currentProjectId = request.currentProjectId;
  if (typeof currentProjectId !== 'string' || !UUID_PATTERN.test(currentProjectId)) {
    throw new InvalidRetrievalRankingError('current project', 'it is not an identifier');
  }

  const result: unknown = request.structuralResult;
  if (!isPlainObject(result)) {
    throw new InvalidRetrievalRankingError('structural result', 'it is not an object');
  }

  const status = result['status'];
  if (typeof status !== 'string' || !(KNOWN_STATUSES as readonly string[]).includes(status)) {
    throw new InvalidRetrievalRankingError('structural status', 'it is not a known outcome');
  }
  const structuralStatus = status as StructuralRerankStatus;

  if (!Array.isArray(result['candidates'])) {
    throw new InvalidRetrievalRankingError('candidates', 'they are not a list');
  }
  // Held under its declared type: `Array.isArray` widens a readonly array to
  // `any[]`, and every field below is read from it.
  const candidates: readonly StructuralCandidate[] = request.structuralResult.candidates;

  if (candidates.length > MAX_RANKED_CANDIDATES) {
    throw new InvalidRetrievalRankingError(
      'candidates',
      `there are more than ${String(MAX_RANKED_CANDIDATES)} of them`,
    );
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (typeof candidate.problemId !== 'string' || !UUID_PATTERN.test(candidate.problemId)) {
      throw new InvalidRetrievalRankingError('candidates', 'a Problem identifier is unusable');
    }
    if (seen.has(candidate.problemId)) {
      throw new InvalidRetrievalRankingError('candidates', 'one Problem appears twice');
    }
    seen.add(candidate.problemId);

    if (typeof candidate.projectId !== 'string' || !UUID_PATTERN.test(candidate.projectId)) {
      throw new InvalidRetrievalRankingError('candidates', 'a Project identifier is unusable');
    }

    // Gaps are ordinary and expected — the first stage's positions survive a
    // candidate disappearing — but a position is still a position.
    if (!Number.isInteger(candidate.hybridRank) || candidate.hybridRank < 1) {
      throw new InvalidRetrievalRankingError('candidates', 'a hybrid rank is not a position');
    }

    const score = candidate.structuralScore;
    if (structuralStatus === 'USED') {
      if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) {
        throw new InvalidRetrievalRankingError(
          'candidates',
          'a structural score is missing or out of range',
        );
      }
    } else if (score !== null) {
      // A score without a structural judgement behind it.
      throw new InvalidRetrievalRankingError(
        'candidates',
        'a structural score is present although no judgement was made',
      );
    }
  }

  return { currentProjectId, candidates, structuralStatus };
}

/**
 * Orders candidates and numbers them.
 *
 * The comparison, in order, each step reached only when the one before it ties:
 *
 *   1. **Not suppressed first.** Somebody asked to see less of a suppressed
 *      Memory, so it goes below everything they did not — but it is still
 *      here, because "show this less" is not "delete this".
 *   2. **Currency.** A Memory that still describes current conditions before
 *      one that may not, before one that has been replaced, before one known
 *      to be wrong.
 *   3. **Trust.**
 *   4. **Structural similarity**, when there is any — see below.
 *   5. **Proximity**: the current Project, then the same technology, then
 *      anywhere else.
 *   6. **The first retrieval stage's position**, gaps and all.
 *   7. **The Problem's identifier**, so the order is total and the same twice.
 *
 * Trust and currency come before structure because a Memory that is known to
 * be wrong, or that somebody asked to see less of, should not lead on being a
 * good structural match — that is the "do not blindly trust an old Memory"
 * requirement, and it is what the demotions are for. Structure comes before
 * proximity for the reason in this file's header.
 *
 * Step 4 is skipped entirely when the structural stage did not run. Not
 * treated as zero, not filled in from the hybrid position — removed, so the
 * comparison falls through to proximity and the specification's basic search
 * order surfaces on its own. Substituting a number would be inventing a
 * judgement that was never made.
 */
export function rankCandidates(
  candidates: readonly RankableCandidate[],
  structuralStatus: StructuralRerankStatus,
): RankedMemoryCandidate[] {
  const structureCounts = structuralStatus === 'USED';

  return [...candidates]
    .sort((a, b) => {
      if (a.suppressed !== b.suppressed) {
        return a.suppressed ? 1 : -1;
      }

      const freshness =
        ordinalOf(FRESHNESS_ORDER, a.freshness, 'freshness') -
        ordinalOf(FRESHNESS_ORDER, b.freshness, 'freshness');
      if (freshness !== 0) {
        return freshness;
      }

      const confidence =
        ordinalOf(CONFIDENCE_ORDER, a.confidence, 'confidence') -
        ordinalOf(CONFIDENCE_ORDER, b.confidence, 'confidence');
      if (confidence !== 0) {
        return confidence;
      }

      if (structureCounts) {
        // Read only when a judgement exists. There is no `?? 0` anywhere on
        // this path, and none is reachable: the request check guarantees every
        // score is a number whenever this branch runs.
        const structural = (b.structuralScore ?? 0) - (a.structuralScore ?? 0);
        if (structural !== 0) {
          return structural;
        }
      }

      const relation = RELATION_ORDER[a.projectRelation] - RELATION_ORDER[b.projectRelation];
      if (relation !== 0) {
        return relation;
      }

      const hybrid = a.hybridRank - b.hybridRank;
      if (hybrid !== 0) {
        return hybrid;
      }

      return a.problemId < b.problemId ? -1 : a.problemId > b.problemId ? 1 : 0;
    })
    .map((candidate, index) => ({ ...candidate, rankingRank: index + 1 }));
}
