/**
 * What a retrieval artifact is, and what it is not.
 *
 * It is derived data: a rendering of a Problem built so that a search can find
 * it. The Problem, its Events and its Verifications are the record; this is a
 * convenience rebuilt from them. Nothing here is ever the reason a Memory
 * changes, and losing every artifact costs the time to regenerate and nothing
 * else.
 *
 * That shapes the rules below more than any of them would suggest on their
 * own. There is no artifact identity — a Problem has one current artifact or
 * none — and no version, because a regeneration replaces rather than adds. The
 * embedding model is not named here, and the shape of the structural features
 * is not decided here, because both belong to the tasks that produce them and
 * fixing either now would fix it before anyone knows what it should be.
 *
 * What this module does own is the small set of facts that make a stored
 * artifact meaningful at all: that it is complete, that its numbers are
 * numbers, and that the text describing where it came from actually says
 * something.
 */

import type { OwnerId } from './owner.js';
import type { ProblemId } from './problem.js';
import { isBlankText } from './text.js';

/** Raised when an artifact could not be accepted as written. */
export class InvalidRetrievalArtifactError extends Error {
  readonly field: string;

  constructor(field: string, reason: string) {
    // The field and a reason this codebase chose. Never the value: an artifact
    // holds a rendering of somebody's Memory, and an error is a place that
    // travels.
    super(`Retrieval artifact ${field} is unusable: ${reason}.`);
    this.name = 'InvalidRetrievalArtifactError';
    this.field = field;
  }
}

/**
 * An embedding, as this system holds one.
 *
 * A list of numbers with no fixed length. The length is a property of whichever
 * model produced it, and models change — the specification says so directly —
 * so a dimension is something an artifact reports rather than something the
 * type demands.
 */
export type Embedding = readonly number[];

/**
 * The semantic half of an artifact: the vector and the identity of what made
 * it.
 *
 * One value on purpose. An embedding without its model is a vector nobody can
 * compare, and a model without its vector is a claim about nothing — so the
 * three travel together or not at all, and "not at all" is `null` on the
 * content rather than three fields that could disagree. The deterministic
 * rendering stores `null`; nothing about its searchable text is diminished by
 * that, because the full-text channel never reads these fields.
 */
export interface RetrievalArtifactSemanticRendering {
  readonly embedding: Embedding;
  readonly embeddingModel: string;
  readonly embeddingModelVersion: string;
}

export interface RetrievalArtifactContent {
  readonly normalizedSummary: string;
  readonly keywords: readonly string[];
  readonly structuralFeatures: Record<string, unknown>;
  /**
   * Which summariser wrote the text above, and which version of it.
   *
   * Separate from the fingerprint on purpose: a generator change does not move
   * the source fingerprint — the fingerprint describes what was read, not who
   * wrote — so this pair is the only way an artifact written by a superseded
   * summariser can be identified for regeneration. The same reason the
   * embedding model is recorded, applied to the pipeline's other generator.
   */
  readonly summaryGeneratorId: string;
  readonly summaryGeneratorVersion: string;
  /** The semantic rendering, whole — or `null` for a deterministic artifact. */
  readonly semantic: RetrievalArtifactSemanticRendering | null;
  /**
   * The source state this was built from, opaque to everything here.
   *
   * Stored and compared for equality. What it is computed from is P4-02's,
   * which is the only thing that reads the source.
   */
  readonly sourceFingerprint: string;
  /**
   * When the content was generated, according to whatever generated it.
   *
   * Not evidence that the artifact is current. A generation that read the
   * source, then took a second while an Event was appended, produces a later
   * timestamp for an earlier state — which is why the fingerprint exists.
   */
  readonly generatedAt: Date;
}

export interface RetrievalArtifactRecord extends RetrievalArtifactContent {
  readonly ownerId: OwnerId;
  readonly problemId: ProblemId;
}

/** What a caller supplies. The owner comes from the context, never from here. */
export interface UpsertRetrievalArtifactInput extends RetrievalArtifactContent {
  readonly problemId: ProblemId;
}

function requireText(value: string, field: string): string {
  if (isBlankText(value)) {
    throw new InvalidRetrievalArtifactError(field, 'it is blank');
  }
  return value;
}

/**
 * Checks an embedding is one.
 *
 * Deliberately narrow. That every entry is a finite number is a property of
 * *any* embedding, whoever made it, so it belongs here; that there are 1536 of
 * them is a property of one model, so it does not. `NaN` and `Infinity` are
 * refused because PostgreSQL will take them and no distance function will
 * survive them — a row that stores cleanly and breaks every later search is the
 * worst of the available outcomes.
 */
export function toEmbedding(values: readonly number[]): Embedding {
  if (values.length === 0) {
    throw new InvalidRetrievalArtifactError('embedding', 'it has no dimensions');
  }
  let magnitude = 0;
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new InvalidRetrievalArtifactError('embedding', 'it holds a value that is not a number');
    }
    magnitude += Math.abs(value);
  }
  if (magnitude === 0) {
    // All zero. PostgreSQL stores it and cosine distance against it is NULL —
    // measured, not assumed — so the row would save cleanly and then vanish
    // from, or corrupt the ordering of, every similarity query. No real model
    // emits a zero vector for real text; one arriving here means something
    // upstream is broken, and the honest response is refusal rather than a row
    // that fails later and elsewhere.
    throw new InvalidRetrievalArtifactError('embedding', 'every dimension is zero');
  }
  return [...values];
}

/**
 * Normalises what a caller supplied, or refuses it.
 *
 * Completeness is checked rather than assumed: a half-built semantic
 * rendering — an embedding with no model, a model with no vector — is not a
 * stage this system has. The whole rendering may be absent, and that is an
 * ordinary state: the deterministic artifact carries searchable text and no
 * vector, and either a Problem has an artifact a search can use or it has
 * none.
 */
export function toRetrievalArtifactContent(
  input: RetrievalArtifactContent,
): RetrievalArtifactContent {
  return {
    normalizedSummary: requireText(input.normalizedSummary, 'normalized summary'),
    // Order is kept as given. Whether it means anything is the generator's to
    // say; storage does not get to reorder somebody's output.
    keywords: input.keywords.map((keyword, index) =>
      requireText(keyword, `keyword at ${String(index)}`),
    ),
    structuralFeatures: input.structuralFeatures,
    summaryGeneratorId: requireText(input.summaryGeneratorId, 'summary generator id'),
    summaryGeneratorVersion: requireText(
      input.summaryGeneratorVersion,
      'summary generator version',
    ),
    semantic:
      input.semantic === null
        ? null
        : {
            embedding: toEmbedding(input.semantic.embedding),
            embeddingModel: requireText(input.semantic.embeddingModel, 'embedding model'),
            embeddingModelVersion: requireText(
              input.semantic.embeddingModelVersion,
              'embedding model version',
            ),
          },
    sourceFingerprint: requireText(input.sourceFingerprint, 'source fingerprint'),
    generatedAt: input.generatedAt,
  };
}

/**
 * The wire form of a vector, for the driver.
 *
 * `pg` has no vector type, so the value crosses as text and is cast in the
 * statement. Built here rather than at the call site so there is one place
 * where a number becomes part of a query, and it is a bound parameter either
 * way — nothing is interpolated into SQL.
 */
export function formatEmbedding(embedding: Embedding): string {
  return `[${embedding.join(',')}]`;
}

/** Reads back what `formatEmbedding` wrote. */
export function parseEmbedding(text: string): Embedding {
  const inner = text.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (inner === '') {
    return [];
  }
  return inner.split(',').map((part) => Number(part));
}
