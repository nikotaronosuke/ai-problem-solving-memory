/**
 * Judging which candidates are the *same kind of problem*, rather than which
 * ones used the same words.
 *
 * This is the second of the specification's two retrieval stages. The first
 * narrowed to ten or twenty Problems by matching text and by comparing
 * embeddings; this one asks a different question of those survivors — is the
 * shape of what went wrong the same? — and answers with a handful.
 *
 * **Why a model, and not arithmetic.** The obvious implementation is to
 * compare the structural labels directly, and it was tried before it was
 * rejected. Measured against realistic fixtures, exact label overlap, token
 * Jaccard and character-bigram similarity all ranked *same technology,
 * different cause* above *different technology, same structure* — the precise
 * inversion of what this stage exists to do. Removing the technology-bearing
 * fields and weighting the boundary field flipped the order, but only because
 * two words happened to coincide; rewriting the same structure in different
 * vocabulary put the cross-technology candidate back at zero. The acceptance
 * condition for the whole system is that a React ordering bug can surface a
 * Fastify one, and word overlap cannot see that, because the words are exactly
 * what differ. The OS boundary already places structural rerank on the model
 * side of the line; the measurement is why this file agrees.
 *
 * **What that does not mean.** A scripted reranker in a test proves the
 * orchestration around the model — that the right data reaches it, that
 * nothing else does, that its answer is checked, that failure degrades
 * honestly. It proves nothing about whether a real model judges structure
 * well. That is measured against evaluation fixtures, later, and no test here
 * is written as though it had been settled.
 *
 * Nothing in this file weighs a Memory's trustworthiness, currency or
 * proximity. Those belong to ranking, and a stage that quietly did some of
 * them would leave the ranking stage unable to do its job properly.
 */

import type { ProblemId } from './problem.js';
import type { ProjectId } from './project.js';
import type { HybridCandidate } from './retrieval-hybrid-search.js';
import { STRUCTURAL_FEATURE_LISTS, type StructuralFeatures } from './retrieval-summary.js';

/**
 * The seven things compared, which are the specification's own similarity
 * factors and not a taxonomy invented here.
 *
 * `schema_version` is absent on purpose: it says which shape the object is in,
 * which is a fact for the parser rather than something two Problems can be
 * alike in.
 */
export const STRUCTURAL_COMPARISON_DIMENSIONS = [
  'problem_domain',
  ...STRUCTURAL_FEATURE_LISTS,
] as const;

export type StructuralComparisonDimension = (typeof STRUCTURAL_COMPARISON_DIMENSIONS)[number];

/**
 * How many candidates a rerank returns.
 *
 * One to five, from the specification. The default is the ceiling rather than
 * the three a person usually sees: how many to show is a presentation
 * decision, and a ranking stage still sits between this and a reader — cutting
 * to three here would throw away candidates that stage can no longer recover.
 */
export const DEFAULT_STRUCTURAL_RERANK_LIMIT = 5;
export const MIN_STRUCTURAL_RERANK_LIMIT = 1;
export const MAX_STRUCTURAL_RERANK_LIMIT = 5;

/** The most candidates a rerank will consider — one stage-one window. */
export const MAX_STRUCTURAL_RERANK_CANDIDATES = 20;

/** Raised when a rerank cannot be accepted as asked. */
export class InvalidStructuralRerankError extends Error {
  readonly field: string;

  constructor(field: string, reason: string) {
    // A field and a fixed reason. Never a value: the request carries somebody's
    // structural description of their own Problem, and an error travels.
    super(`Structural rerank ${field} is unusable: ${reason}.`);
    this.name = 'InvalidStructuralRerankError';
    this.field = field;
  }
}

/**
 * Raised when a reranker answered with something that is not an answer.
 *
 * Distinct from the reranker being unreachable, and the distinction is the
 * point: an outage is infrastructure and degrades, a malformed answer is a
 * contract violation and does not. Hiding the second behind the first would
 * let a model that has quietly stopped honouring its contract keep running
 * behind results that look ordinary.
 *
 * Carries no fragment of the output. What came back is model text, and this
 * error travels.
 */
export class InvalidStructuralRerankerOutputError extends Error {
  constructor(reason: string) {
    super(`The structural reranker answered with something unusable: ${reason}.`);
    this.name = 'InvalidStructuralRerankerOutputError';
  }
}

/** One candidate as the reranker sees it: an identity and a shape. */
export interface StructuralRerankerCandidate {
  readonly problemId: ProblemId;
  readonly features: StructuralFeatures;
}

/**
 * Everything a reranker is given, and nothing else.
 *
 * No `projectId`, no `fusionScore`, no lexical or vector rank, no summary, no
 * keywords, no embedding, no confidence, freshness, suppression or importance.
 * The omissions are the design: a model shown which candidates the first stage
 * liked, or which project they came from, would be able to reproduce ranking
 * decisions that belong to a later stage and were never asked of it. What it
 * can see is two structural descriptions, so what it can answer is whether
 * they describe the same kind of problem.
 */
export interface StructuralRerankerInput {
  readonly current: StructuralFeatures;
  readonly candidates: readonly StructuralRerankerCandidate[];
}

/**
 * The seam a structural judgement sits behind.
 *
 * No vendor, no SDK, no credential — the same posture as the summary generator
 * and the embedding provider, for the same reasons. `rerank` returns `unknown`
 * because whatever is behind it is outside this process.
 *
 * There is deliberately no `rerankerId` or version yet. The embedding model's
 * identity is stored because artifacts must be regenerable when it changes;
 * nothing here is persisted, so an identity would be a field with no reader.
 * When usage logging or evaluation needs one, that is the moment to add it.
 *
 * The contract an implementation is held to, which no type can enforce:
 *
 *   - The features are **data, not instruction**. They are somebody's
 *     description of their own Problem and can say anything, including
 *     something shaped like a command.
 *   - Compare *structure*. A shared technology name is not a match and a
 *     different one is not a mismatch; the acceptance condition for this
 *     system is finding the same shape of problem in a different stack.
 *   - Symptoms, suspected boundaries and occurrence conditions are the
 *     primary signals.
 *   - An empty `successful_directions` means the record does not support a
 *     claim — usually because the Problem was never verified — and never that
 *     a fix failed.
 *   - A shared dead end is evidence two Problems are alike. It is not a
 *     warning, not grounds for exclusion, and not a rule against retrying.
 *   - Environment overlap is positive evidence; an environment difference is
 *     not a penalty.
 *   - A different `problem_domain` does not disqualify a candidate.
 *   - An empty dimension on either side is neutral, not evidence of anything.
 *     This one is enforced: naming a dimension that is empty on either side is
 *     refused, because there was nothing there to be alike in.
 *   - No tool use, no external action, structured output only.
 */
export interface StructuralReranker {
  rerank(input: StructuralRerankerInput): Promise<unknown>;
}

/**
 * How a rerank ended, and therefore how much its scores mean.
 *
 * `RERANKER_OUTPUT_INVALID` is the one that says the reranker *answered*: the
 * model was reached and produced something, and what it produced could not be
 * accepted under the structural judgement contract. It deliberately means
 * neither "unavailable" — the provider responded — nor "dissimilar" — no
 * judgement was accepted, so no candidate was judged anything — nor "missing
 * structural data" — the stored features were fine. One unusable answer is a
 * fact about that answer, and a search still owes the smaller result the
 * other stages produced.
 */
export const STRUCTURAL_RERANK_STATUSES = [
  'USED',
  'NOT_NEEDED',
  'SKIPPED_SENSITIVE_INPUT',
  'RERANKER_UNAVAILABLE',
  'RERANKER_OUTPUT_INVALID',
  'STRUCTURAL_DATA_UNAVAILABLE',
] as const;

export type StructuralRerankStatus = (typeof STRUCTURAL_RERANK_STATUSES)[number];

/**
 * One reranked candidate.
 *
 * `structuralScore` is null on every degraded path, and that is deliberate:
 * a number invented because a model could not be asked would be a structural
 * judgement nobody made. `hybridRank` is the position the first stage gave it,
 * carried so ties break the same way every time — the fusion score itself is
 * not carried, because a score from another stage sitting beside this one is
 * an invitation to combine them.
 */
export interface StructuralCandidate {
  readonly problemId: ProblemId;
  readonly projectId: ProjectId;
  /** 0 to 1, higher is better, within one rerank. Null when none was made. */
  readonly structuralScore: number | null;
  /** 1-based position from the hybrid stage. */
  readonly hybridRank: number;
  readonly matchedDimensions: readonly StructuralComparisonDimension[];
}

export interface StructuralRerankResult {
  readonly candidates: readonly StructuralCandidate[];
  readonly status: StructuralRerankStatus;
}

/** What a caller asks for. */
export interface StructuralRerankRequest {
  /**
   * The shape of the Problem being worked on now.
   *
   * Supplied by the caller rather than read from storage, because the Problem
   * being worked on is exactly the one least likely to have a stored artifact
   * — and if it has one, it is the one most likely to be out of date. Reading
   * it here would either use a stale description or make a search regenerate
   * one, and a search must not write.
   */
  readonly currentFeatures: StructuralFeatures;
  readonly candidates: readonly HybridCandidate[];
  readonly excludeProblemId?: ProblemId;
  readonly limit?: number;
}

/** A validated request, defaults filled in. */
export interface ResolvedStructuralRerankRequest {
  readonly currentFeatures: StructuralFeatures;
  readonly candidates: readonly HybridCandidate[];
  readonly limit: number;
}

/**
 * Checks a request before anything runs.
 *
 * Everything, up front: an invalid request must reach neither the database nor
 * a model. The current profile is parsed rather than trusted — it arrived from
 * a caller, and a `StructuralFeatures` annotation is a claim about a value
 * this code has not seen.
 */
export function resolveStructuralRerankRequest(
  request: StructuralRerankRequest,
  parse: (value: unknown) => StructuralFeatures,
): ResolvedStructuralRerankRequest {
  let currentFeatures: StructuralFeatures;
  try {
    currentFeatures = parse(request.currentFeatures);
  } catch {
    // The parser's own message names the offending field, but it was written
    // for a generator's output; re-raised here so a caller sees one error type
    // from this surface, and so nothing of the value travels.
    throw new InvalidStructuralRerankError('current features', 'they are not a valid v1 profile');
  }

  if (!Array.isArray(request.candidates)) {
    throw new InvalidStructuralRerankError('candidates', 'they are not a list');
  }
  // Held under its declared type: `Array.isArray` widens a readonly array to
  // `any[]`, and every field below is read from it.
  const candidateList: readonly HybridCandidate[] = request.candidates;

  if (candidateList.length > MAX_STRUCTURAL_RERANK_CANDIDATES) {
    throw new InvalidStructuralRerankError(
      'candidates',
      `there are more than ${String(MAX_STRUCTURAL_RERANK_CANDIDATES)} of them`,
    );
  }

  const seen = new Set<string>();
  for (const candidate of candidateList) {
    if (seen.has(candidate.problemId)) {
      throw new InvalidStructuralRerankError('candidates', 'one Problem appears twice');
    }
    seen.add(candidate.problemId);
    if (!Number.isFinite(candidate.fusionScore)) {
      throw new InvalidStructuralRerankError('candidates', 'a fusion score is not a number');
    }
    for (const rank of [candidate.lexicalRank, candidate.vectorRank]) {
      if (rank !== null && (!Number.isInteger(rank) || rank < 1)) {
        throw new InvalidStructuralRerankError('candidates', 'a source rank is not a position');
      }
    }
  }

  const limit = resolveStructuralRerankLimit(request.limit);

  // The Problem being worked on is not a memory of a past problem.
  const candidates =
    request.excludeProblemId === undefined
      ? candidateList
      : candidateList.filter((candidate) => candidate.problemId !== request.excludeProblemId);

  return { currentFeatures, candidates, limit };
}

/**
 * The cut this stage will actually apply.
 *
 * Exported because a caller composing the stages needs the *effective* value
 * rather than the one that was typed: asking for five and not asking at all
 * are the same search. Pure, and unchanged in behaviour from when it was
 * inlined above.
 */
export function resolveStructuralRerankLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_STRUCTURAL_RERANK_LIMIT;
  }
  if (!Number.isInteger(limit)) {
    throw new InvalidStructuralRerankError('limit', 'it is not a whole number');
  }
  if (limit < MIN_STRUCTURAL_RERANK_LIMIT || limit > MAX_STRUCTURAL_RERANK_LIMIT) {
    throw new InvalidStructuralRerankError(
      'limit',
      `it is outside ${String(MIN_STRUCTURAL_RERANK_LIMIT)} to ${String(MAX_STRUCTURAL_RERANK_LIMIT)}`,
    );
  }
  return limit;
}

interface RerankedEntry {
  readonly problemId: ProblemId;
  readonly structuralScore: number;
  readonly matchedDimensions: readonly StructuralComparisonDimension[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a dimension had anything on both sides to compare.
 *
 * A machine check on availability, not on agreement. Whether two symptom
 * descriptions really describe the same symptom is the judgement this stage
 * asks a model for; re-deciding it here with string comparison would be the
 * arithmetic that was measured and rejected, arriving through the back door as
 * a validation rule. So no text is compared and no overlap is required — only
 * that the dimension was not empty on one side or the other.
 *
 * That distinction is worth being precise about because the failure it
 * prevents is specific. An empty `successful_directions` means the record does
 * not support a claim, usually because the Problem was never carried to
 * VERIFIED. A model naming it as evidence of similarity would be reporting
 * that two Problems are alike in a respect where at least one of them says
 * nothing at all — and a reader would have no way to tell that from a real
 * match. The same holds for every other list, and for a null `problem_domain`.
 */
function comparisonMaterialExists(
  dimension: StructuralComparisonDimension,
  current: StructuralFeatures,
  candidate: StructuralFeatures,
): boolean {
  if (dimension === 'problem_domain') {
    return current.problem_domain !== null && candidate.problem_domain !== null;
  }
  return current[dimension].length > 0 && candidate[dimension].length > 0;
}

/**
 * The dimensions in which two Problems *could* be alike: material on both
 * sides, per the rule above.
 *
 * Exported because two places need the same answer and must never disagree.
 * The parser refuses a matched dimension outside this set, and a provider
 * adapter may narrow its structured-output schema to it so an impossible
 * dimension cannot even be named. The adapter's use is prevention; the
 * parser remains the authority, and both read this one function.
 *
 * Pure and provider-neutral: features in, dimension names out, in the fixed
 * declaration order of `STRUCTURAL_COMPARISON_DIMENSIONS`.
 */
export function comparableStructuralDimensions(
  current: StructuralFeatures,
  candidate: StructuralFeatures,
): readonly StructuralComparisonDimension[] {
  return STRUCTURAL_COMPARISON_DIMENSIONS.filter((dimension) =>
    comparisonMaterialExists(dimension, current, candidate),
  );
}

/**
 * Reads a reranker's answer, or refuses it.
 *
 * The coverage rule is the one worth explaining. Every candidate that went in
 * must come back, exactly once — no invented identifiers, no duplicates, and
 * no omissions. Allowing a model to leave candidates out would put a hidden
 * threshold inside it: this stage deliberately has none, so that a candidate
 * with no structural similarity is ranked last rather than disappeared, and a
 * model quietly dropping candidates would take that decision back without
 * anyone being able to see it. Cutting the list to one to five is this code's
 * job.
 *
 * Scores are bounded to 0..1 so the range means the same thing in every
 * answer, and a score above zero must name at least one dimension it came
 * from — a model that can rate a pair but not say in what respect they are
 * alike has not produced a structural judgement.
 *
 * A named dimension must also have had something on both sides to compare. See
 * `comparisonMaterialExists`: availability is checked, agreement is not.
 *
 * It takes the input that was sent rather than a list of identifiers, so the
 * answer is checked against exactly what the model was shown — the features
 * are needed for the availability check, and deriving the expected identifiers
 * from the same object removes the chance of validating against a set that has
 * drifted from the one that went out.
 */
export function parseStructuralRerankerOutput(
  output: unknown,
  input: StructuralRerankerInput,
): readonly RerankedEntry[] {
  if (!isPlainObject(output)) {
    throw new InvalidStructuralRerankerOutputError('it is not an object');
  }
  const keys = Object.keys(output);
  if (keys.length !== 1 || keys[0] !== 'candidates') {
    throw new InvalidStructuralRerankerOutputError('it does not hold exactly a candidate list');
  }
  if (!Array.isArray(output['candidates'])) {
    throw new InvalidStructuralRerankerOutputError('its candidates are not a list');
  }
  // Re-typed rather than used as inferred: `Array.isArray` narrows to `any[]`,
  // and every element here came from outside the process.
  const raw = output['candidates'] as unknown[];

  const sent = new Map<string, StructuralFeatures>(
    input.candidates.map((candidate) => [candidate.problemId, candidate.features]),
  );
  const wanted = new Set<string>(sent.keys());
  const seen = new Set<string>();
  const entries: RerankedEntry[] = [];

  for (const item of raw) {
    if (!isPlainObject(item)) {
      throw new InvalidStructuralRerankerOutputError('a candidate is not an object');
    }
    const itemKeys = Object.keys(item).sort();
    if (
      itemKeys.length !== 3 ||
      itemKeys[0] !== 'matchedDimensions' ||
      itemKeys[1] !== 'problemId' ||
      itemKeys[2] !== 'structuralScore'
    ) {
      throw new InvalidStructuralRerankerOutputError('a candidate has unexpected fields');
    }

    const problemId = item['problemId'];
    if (typeof problemId !== 'string' || !wanted.has(problemId)) {
      // Covers both an identifier that was never sent and one that is not a
      // string at all. Naming it would echo model output.
      throw new InvalidStructuralRerankerOutputError('a candidate was not one of the inputs');
    }
    if (seen.has(problemId)) {
      throw new InvalidStructuralRerankerOutputError('a candidate appears twice');
    }
    seen.add(problemId);

    const score = item['structuralScore'];
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) {
      throw new InvalidStructuralRerankerOutputError('a score is not between zero and one');
    }

    if (!Array.isArray(item['matchedDimensions'])) {
      throw new InvalidStructuralRerankerOutputError('matched dimensions are not a list');
    }
    const dimensions = item['matchedDimensions'] as unknown[];
    const named = new Set<string>();
    for (const dimension of dimensions) {
      if (
        typeof dimension !== 'string' ||
        !(STRUCTURAL_COMPARISON_DIMENSIONS as readonly string[]).includes(dimension)
      ) {
        throw new InvalidStructuralRerankerOutputError('a matched dimension is not a known one');
      }
      if (named.has(dimension)) {
        throw new InvalidStructuralRerankerOutputError('a matched dimension appears twice');
      }
      const features = sent.get(problemId);
      if (
        features === undefined ||
        !comparisonMaterialExists(
          dimension as StructuralComparisonDimension,
          input.current,
          features,
        )
      ) {
        // Empty on one side or the other, so there was nothing there to be
        // alike in. The dimension is not named: it is this system's own
        // vocabulary rather than model text, but an error travels and the
        // shape of somebody's Problem is not something to put in one.
        throw new InvalidStructuralRerankerOutputError(
          'a matched dimension has nothing to compare',
        );
      }
      named.add(dimension);
    }

    if (score > 0 && named.size === 0) {
      throw new InvalidStructuralRerankerOutputError('a scored candidate names no dimension');
    }
    if (score === 0 && named.size > 0) {
      throw new InvalidStructuralRerankerOutputError('an unscored candidate names a dimension');
    }

    entries.push({
      problemId: problemId as ProblemId,
      structuralScore: score,
      matchedDimensions: [...named] as StructuralComparisonDimension[],
    });
  }

  if (seen.size !== wanted.size) {
    throw new InvalidStructuralRerankerOutputError(
      'it does not cover every candidate exactly once',
    );
  }

  return entries;
}

/**
 * Orders judged candidates and cuts to the limit.
 *
 * Structural similarity decides; the hybrid position breaks ties, and the
 * problem id breaks what is left, so the answer is total and repeatable for a
 * given set of scores. The hybrid stage's score is never added to this one —
 * two scales measuring different things, and this stage is a rerank rather
 * than a second opinion averaged with the first.
 */
export function orderStructuralCandidates(
  candidates: readonly StructuralCandidate[],
  limit: number,
): StructuralCandidate[] {
  return [...candidates]
    .sort(
      (a, b) =>
        (b.structuralScore ?? 0) - (a.structuralScore ?? 0) ||
        a.hybridRank - b.hybridRank ||
        (a.problemId < b.problemId ? -1 : a.problemId > b.problemId ? 1 : 0),
    )
    .slice(0, limit);
}
