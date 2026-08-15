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

export interface RetrievalArtifactContent {
  readonly normalizedSummary: string;
  readonly keywords: readonly string[];
  readonly structuralFeatures: Record<string, unknown>;
  readonly embedding: Embedding;
  readonly embeddingModel: string;
  readonly embeddingModelVersion: string;
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

/**
 * The characters the database's own blank checks treat as nothing.
 *
 * Spelled out rather than left to `\s`, which also matches a non-breaking
 * space: a value this refused but the column accepted would be a disagreement
 * about what blank means, and the column is the one that decides.
 */
const BLANK_CHARACTERS: ReadonlySet<string> = new Set([' ', '\t', '\r', '\n', '\f', '\v']);

function isBlank(value: string): boolean {
  for (const character of value) {
    if (!BLANK_CHARACTERS.has(character)) {
      return false;
    }
  }
  return true;
}

function requireText(value: string, field: string): string {
  if (isBlank(value)) {
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
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new InvalidRetrievalArtifactError('embedding', 'it holds a value that is not a number');
    }
  }
  return [...values];
}

/**
 * Normalises what a caller supplied, or refuses it.
 *
 * Completeness is checked rather than assumed: a half-built artifact — a
 * summary with no embedding, an embedding with no model — is not a stage this
 * system has. Either a Problem has an artifact that a search can use, or it has
 * none, and none is an ordinary state that every Problem starts in.
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
    embedding: toEmbedding(input.embedding),
    embeddingModel: requireText(input.embeddingModel, 'embedding model'),
    embeddingModelVersion: requireText(input.embeddingModelVersion, 'embedding model version'),
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
