/**
 * What a retrieval summary is, and what may be believed about one.
 *
 * A Problem is a record of an investigation: a title, symptoms, a run of
 * Events in the order they happened, whatever was verified. That is the right
 * shape for reading and the wrong shape for finding — a search cannot compare
 * two investigations, and a person hitting the same wall in a different project
 * does not know which words the earlier one used. A retrieval summary is the
 * same experience rewritten so that comparison is possible: what the symptom
 * was, which boundary it sat on, under what conditions it showed up, what
 * worked, what did not.
 *
 * Three things in this module are worth reading before the code.
 *
 * **It is a draft, not an artifact.** A stored artifact is complete — summary,
 * keywords, features, embedding, model, version, fingerprint and time — and
 * there is no half-built state (see `retrieval-artifact.ts`). The embedding
 * belongs to the task that owns an embedding provider, so what is produced here
 * is the part that exists, held in memory, and nothing is written down.
 *
 * **The source fingerprint is the exact bytes.** Not a list of fields hashed in
 * some order this file decided: the hash is taken over the very document handed
 * to the generator. That makes two questions the same question — "what was this
 * built from?" and "what did the generator see?" — and removes the class of bug
 * where the two answers drift apart.
 *
 * **A recorded fix is not a verified one.** Nothing in the data model links a
 * `FIX` Event to a Verification, so "this fix is what worked" cannot be read
 * out of storage; it can only be assumed, and assuming it would put a
 * fabricated causal claim into a summary that later reads as evidence. What can
 * be established is weaker and true: this Problem reached `VERIFIED`, and it
 * has a Verification that succeeded. Only then may a summary speak of a
 * direction as successful, and that gate is mechanical rather than a matter of
 * the generator's judgement.
 */

import { createHash } from 'node:crypto';

import type { ProblemId } from './problem.js';
import { isBlankText } from './text.js';

/**
 * The version of the source document's own shape.
 *
 * Bound into the document and into the fingerprint prefix, so a change to what
 * the generator is shown makes every existing fingerprint stop matching — which
 * is correct, because a summary built from a different document was built from
 * a different thing.
 *
 * Not the generator's version, and not the structural feature schema's. Three
 * separate versions because they change for three separate reasons.
 */
export const RETRIEVAL_SOURCE_SCHEMA_VERSION = '1';

/** Names the source schema the digest was taken under. */
export const RETRIEVAL_SOURCE_FINGERPRINT_PREFIX = 'retrieval-source-v1';

/** The version of the structural feature vocabulary below. */
export const STRUCTURAL_FEATURE_SCHEMA_VERSION = '1';

/**
 * The lists a structural description is made of.
 *
 * Free-form strings rather than a closed taxonomy. A fixed vocabulary would
 * have to be invented now, before a single retrieval has been run, and the
 * failure mode of guessing wrong is worse than the failure mode of being
 * loose: an enum missing the label a problem actually needs forces every such
 * problem into the nearest wrong bucket, permanently and invisibly.
 *
 * What the lists are *for* is comparison across technologies, which is the
 * acceptance condition the whole phase exists to meet. "React" and "Fastify"
 * are not structural descriptions; "state read before the thing that owns it
 * finished writing" is, and it matches in both.
 */
export const STRUCTURAL_FEATURE_LISTS = [
  'symptom_patterns',
  'suspected_boundaries',
  'occurrence_conditions',
  'successful_directions',
  'dead_end_directions',
  'environment_facts',
] as const;

export type StructuralFeatureList = (typeof STRUCTURAL_FEATURE_LISTS)[number];

/**
 * A structural description of one Problem.
 *
 * A `type` rather than an `interface` on purpose: an interface has no implicit
 * index signature, so it would not satisfy the `Record<string, unknown>` an
 * artifact's features are stored as, and the composition step would need a cast
 * to work around a difference that is not real.
 *
 * Keys are snake_case because this object is stored as JSON and read by a
 * search, not by TypeScript.
 */
export type StructuralFeatures = {
  readonly schema_version: string;
  /** The Problem's own domain, or null when it has none recorded. */
  readonly problem_domain: string | null;
  readonly symptom_patterns: readonly string[];
  readonly suspected_boundaries: readonly string[];
  readonly occurrence_conditions: readonly string[];
  /** Empty unless the Problem is verified — see the gate below. */
  readonly successful_directions: readonly string[];
  readonly dead_end_directions: readonly string[];
  readonly environment_facts: readonly string[];
};

/** Every key a structural feature object may have, and must have. */
const STRUCTURAL_FEATURE_KEYS: readonly string[] = [
  'schema_version',
  'problem_domain',
  ...STRUCTURAL_FEATURE_LISTS,
];

/**
 * What one generation produced, before anything is stored.
 *
 * No owner: as everywhere else, that comes from the context rather than from a
 * value that could be set to somebody else's. No embedding and no model, which
 * belong to the provider task. No generation time either — an artifact's
 * `generated_at` describes the moment its complete content existed, and that
 * moment has not arrived while the embedding is still missing.
 */
export interface RetrievalSummaryDraft {
  readonly problemId: ProblemId;
  readonly normalizedSummary: string;
  readonly keywords: readonly string[];
  readonly structuralFeatures: StructuralFeatures;
  /** The digest of the exact document this was generated from. */
  readonly sourceFingerprint: string;
}

/**
 * Bounds, so a generated object cannot be arbitrarily large.
 *
 * Every one of these is enforced by refusing, never by trimming to fit. A
 * summary silently cut at the limit is a summary that stops mid-sentence, and a
 * keyword list silently cut at twenty is a list whose twenty-first entry
 * nobody knows was dropped. A refusal is visible; a truncation is not.
 *
 * The numbers are generous on purpose. They exist to bound what reaches
 * storage and an embedding provider, not to express an opinion about how long
 * a good summary is — a two-line summary of a simple Problem is a good summary.
 */
export const MAX_NORMALIZED_SUMMARY_LENGTH = 4000;
export const MAX_KEYWORDS = 20;
export const MAX_KEYWORD_LENGTH = 120;
export const MAX_STRUCTURAL_FEATURE_ITEMS = 20;
export const MAX_STRUCTURAL_FEATURE_LENGTH = 300;

/**
 * Raised when generated output cannot be accepted.
 *
 * Carries which field and a reason chosen from this file. Never the value: the
 * value is text a generator produced from somebody's Memory, and an error
 * travels — into a caller, into a log, into a report — which is the same
 * argument the artifact and sanitization errors are built on.
 */
export class InvalidRetrievalSummaryError extends Error {
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`Generated retrieval summary ${field} is unusable: ${reason}.`);
    this.name = 'InvalidRetrievalSummaryError';
    this.field = field;
  }
}

/**
 * The digest of a canonical source document.
 *
 * SHA-256 over the exact UTF-8 bytes the generator is given, prefixed with the
 * source schema version. The prefix is not decoration: it means a later change
 * to the document's shape cannot silently produce a colliding-looking value,
 * and an artifact stored under v1 is visibly stored under v1.
 *
 * Deliberately not mixed with the generator's identity. A fingerprint answers
 * "what state was this built from?", and folding the model or the prompt
 * version into it would make it answer two questions at once and neither of
 * them well — the same source read by a newer generator is still the same
 * source.
 */
export function fingerprintRetrievalSource(canonicalSource: string): string {
  const digest = createHash('sha256').update(canonicalSource, 'utf8').digest('hex');
  return `${RETRIEVAL_SOURCE_FINGERPRINT_PREFIX}:${digest}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireBoundedText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string') {
    throw new InvalidRetrievalSummaryError(field, 'it is not a string');
  }
  if (isBlankText(value)) {
    throw new InvalidRetrievalSummaryError(field, 'it is blank');
  }
  if (value.length > maximum) {
    throw new InvalidRetrievalSummaryError(
      field,
      `it is longer than ${String(maximum)} characters`,
    );
  }
  return value;
}

/**
 * Reads one list of structural labels.
 *
 * Absent and null are both refused rather than read as an empty list. "The
 * generator had nothing to say here" and "the generator did not answer this
 * question" look identical afterwards, and only one of them is a summary worth
 * keeping — so the empty list has to be written down deliberately.
 */
function requireLabelList(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new InvalidRetrievalSummaryError(field, 'it is not an array');
  }
  if (value.length > MAX_STRUCTURAL_FEATURE_ITEMS) {
    throw new InvalidRetrievalSummaryError(
      field,
      `it holds more than ${String(MAX_STRUCTURAL_FEATURE_ITEMS)} entries`,
    );
  }
  return value.map((entry, index) =>
    requireBoundedText(entry, `${field} at ${String(index)}`, MAX_STRUCTURAL_FEATURE_LENGTH),
  );
}

/**
 * Normalises the keyword list, or refuses it.
 *
 * The division of labour is the same one that runs through the whole task:
 * which words matter is a semantic judgement and belongs to the generator;
 * trimming, refusing blanks, removing exact repeats and holding a bound are
 * mechanical and belong here.
 *
 * Case is preserved. `PostgreSQL` and `postgresql` are the same word to the
 * full-text search that will consume these, and it normalises them itself —
 * folding case here would throw away the original spelling to duplicate work
 * that is done properly downstream.
 *
 * Repeats are removed before the count is checked, because a generator
 * repeating itself is a generator that produced fewer keywords than it looked
 * like, not one that produced too many.
 */
function toKeywords(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new InvalidRetrievalSummaryError('keywords', 'it is not an array');
  }

  const kept: string[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const keyword = requireBoundedText(
      entry,
      `keyword at ${String(index)}`,
      MAX_KEYWORD_LENGTH,
    ).trim();
    if (keyword === '') {
      throw new InvalidRetrievalSummaryError(`keyword at ${String(index)}`, 'it is blank');
    }
    if (!seen.has(keyword)) {
      seen.add(keyword);
      kept.push(keyword);
    }
  }

  if (kept.length > MAX_KEYWORDS) {
    throw new InvalidRetrievalSummaryError(
      'keywords',
      `there are more than ${String(MAX_KEYWORDS)} of them`,
    );
  }
  return kept;
}

/**
 * Reads a structural feature object, or refuses it.
 *
 * Exactly the known keys: an unknown one is refused rather than dropped,
 * because a generator inventing a field is a generator answering a question
 * nobody asked, and quietly discarding it would hide that. A missing one is
 * refused for the reason above — an unanswered question and an empty answer are
 * not the same.
 */
function toStructuralFeatures(
  value: unknown,
  mayClaimSuccessfulDirection: boolean,
): StructuralFeatures {
  if (!isPlainObject(value)) {
    throw new InvalidRetrievalSummaryError('structural features', 'it is not an object');
  }

  for (const key of Object.keys(value)) {
    if (!STRUCTURAL_FEATURE_KEYS.includes(key)) {
      // Named by position rather than by content: the key is the generator's
      // text, and this error travels.
      throw new InvalidRetrievalSummaryError('structural features', 'it holds an unknown field');
    }
  }
  for (const key of STRUCTURAL_FEATURE_KEYS) {
    if (!Object.hasOwn(value, key)) {
      throw new InvalidRetrievalSummaryError('structural features', 'a field is missing');
    }
  }

  if (value['schema_version'] !== STRUCTURAL_FEATURE_SCHEMA_VERSION) {
    throw new InvalidRetrievalSummaryError(
      'structural features schema version',
      'it is not the version this code produces',
    );
  }

  const domain = value['problem_domain'];
  const problemDomain =
    domain === null
      ? null
      : requireBoundedText(domain, 'problem domain', MAX_STRUCTURAL_FEATURE_LENGTH);

  const lists = Object.fromEntries(
    STRUCTURAL_FEATURE_LISTS.map((name) => [
      name,
      requireLabelList(value[name], name.replace(/_/g, ' ')),
    ]),
  ) as Record<StructuralFeatureList, readonly string[]>;

  if (lists.successful_directions.length > 0 && !mayClaimSuccessfulDirection) {
    // The gate, and it refuses rather than emptying the list. Silently clearing
    // it would leave a summary that had been written around a claim it no
    // longer makes, and would hide that a generator asserted something the
    // record does not support.
    throw new InvalidRetrievalSummaryError(
      'successful directions',
      'the Problem is not verified by a successful Verification',
    );
  }

  return {
    schema_version: STRUCTURAL_FEATURE_SCHEMA_VERSION,
    problem_domain: problemDomain,
    ...lists,
  };
}

/** What a generator returned, before any of it has been believed. */
export interface GeneratedRetrievalSummary {
  readonly normalizedSummary: string;
  readonly keywords: readonly string[];
  readonly structuralFeatures: StructuralFeatures;
}

/**
 * Reads a generator's output, or refuses it.
 *
 * Everything arriving here is `unknown` and is treated that way. A generator is
 * a model behind an interface: it can return a string, an array, an object
 * missing half its fields, or an object with a field nobody defined, and a type
 * annotation asserting otherwise would be a claim about something outside this
 * process. So the shape is established by looking, once, here.
 *
 * What this establishes is structure — that the fields exist, are the right
 * kinds of thing, sit inside their bounds, and that a claim of success is
 * backed by a Verification. It establishes nothing about whether the words are
 * true. A generator can produce a well-formed summary of a version that was
 * never mentioned, and no amount of checking here would catch it; that is
 * measured by the evaluation task, against fixtures, and calling it prevented
 * here would be a claim this code cannot support.
 */
export function toGeneratedRetrievalSummary(
  generated: unknown,
  mayClaimSuccessfulDirection: boolean,
): GeneratedRetrievalSummary {
  if (!isPlainObject(generated)) {
    throw new InvalidRetrievalSummaryError('output', 'it is not an object');
  }

  return {
    normalizedSummary: requireBoundedText(
      generated['normalizedSummary'],
      'normalized summary',
      MAX_NORMALIZED_SUMMARY_LENGTH,
    ),
    keywords: toKeywords(generated['keywords']),
    structuralFeatures: toStructuralFeatures(
      generated['structuralFeatures'],
      mayClaimSuccessfulDirection,
    ),
  };
}

/**
 * Assembles the draft.
 *
 * The identity and the fingerprint are attached here rather than asked of the
 * generator. A generator naming its own Problem could name the wrong one, and a
 * generator reporting its own source state could report a state it did not
 * read — both are facts the caller already holds and neither is a semantic
 * judgement, so neither is the generator's to supply.
 */
export function toRetrievalSummaryDraft(
  problemId: ProblemId,
  sourceFingerprint: string,
  generated: GeneratedRetrievalSummary,
): RetrievalSummaryDraft {
  return {
    problemId,
    normalizedSummary: generated.normalizedSummary,
    keywords: generated.keywords,
    structuralFeatures: generated.structuralFeatures,
    sourceFingerprint,
  };
}
