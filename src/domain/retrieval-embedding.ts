/**
 * The seam an embedding model sits behind, and what its output must look like.
 *
 * An embedding turns the artifact's summary into a vector so that similarity
 * can be computed later. Which model does that is deliberately not a fact this
 * codebase contains: the specification says the model is not part of the
 * contract, that artifacts must be regenerable when it changes, and that the
 * provider is an adapter. So what is defined here is the shape of the seam —
 * an identity, a version, a dimension count and one call — and no vendor's
 * name appears anywhere.
 *
 * The identity that matters is the *model's*, not the provider's. Two
 * providers serving the same model produce vectors in the same space, and a
 * schema that recorded the provider would treat those as different when the
 * one thing similarity search cares about is that they are the same. That is
 * why the artifact stores `embedding_model` and `embedding_model_version` and
 * nothing about who served it.
 *
 * `dimensions` is declared up front because it is the one property of a
 * model's output that can be checked without understanding the output. A
 * provider that declares 1536 and returns 1535 numbers is broken in a way that
 * would otherwise be discovered by a distance query failing much later — and
 * vectors of different lengths cannot even be compared, so a stored wrong-size
 * vector is unfindable rather than merely wrong.
 */

import { InvalidRetrievalArtifactError } from './retrieval-artifact.js';
import { isBlankText } from './text.js';

/** What a provider is given: the artifact's normalized summary, verbatim. */
export interface EmbeddingProviderInput {
  /**
   * The text to embed.
   *
   * Data, not instruction — it is derived from somebody's Memory and can say
   * anything at all, including something shaped like a command. An
   * implementation must never treat it as direction about what to do, must
   * perform no action beyond the embedding call itself, and must not be handed
   * anything else: no identifiers, no flags, nothing the fingerprint does not
   * cover.
   */
  readonly text: string;
}

/**
 * A source of embeddings, behind which any model can sit.
 *
 * `embed` returns `unknown` on purpose: whatever is on the other side is
 * outside this process, and a return type would be an assertion about
 * something this code cannot see. The output is read once, by
 * `toProviderEmbedding`, and believed only after that.
 *
 * The identity fields are fixed at construction and checked when the service
 * is built — a provider with a blank identity would produce artifacts that
 * cannot be told apart from any other's later, which defeats the reason the
 * identity is stored at all.
 */
export interface EmbeddingProvider {
  /** Which model this produces vectors from. Free text, never blank. */
  readonly modelId: string;
  /** Which version of it. Free text, never blank. */
  readonly modelVersion: string;
  /** How many dimensions every output has. A positive integer. */
  readonly dimensions: number;

  embed(input: EmbeddingProviderInput): Promise<unknown>;
}

/**
 * Raised when a provider's output cannot be accepted.
 *
 * Names what kind of wrongness, never the value: the output came from outside
 * the process and its size is unbounded, and an error travels. The artifact
 * error type is reused deliberately — a bad embedding is an artifact-content
 * problem, and inventing a parallel hierarchy would give callers two names for
 * one situation.
 */
export class InvalidEmbeddingProviderOutputError extends InvalidRetrievalArtifactError {
  constructor(reason: string) {
    super('provider embedding', reason);
    this.name = 'InvalidEmbeddingProviderOutputError';
  }
}

/**
 * Checks a provider's identity at service construction.
 *
 * Once, when the service is built, rather than at every result — the identity
 * cannot change between calls, and a failure at construction points at the
 * configuration rather than at whichever Problem happened to be first.
 *
 * The pgvector storage maximum (16000 dimensions, measured) is deliberately
 * not enforced here. The database refuses it with a clear error of its own,
 * and repeating storage limits in TypeScript is how the two drift.
 */
export function requireEmbeddingProviderIdentity(provider: EmbeddingProvider): void {
  if (isBlankText(provider.modelId)) {
    throw new Error('An embedding provider must name its model.');
  }
  if (isBlankText(provider.modelVersion)) {
    throw new Error('An embedding provider must name its model version.');
  }
  if (!Number.isInteger(provider.dimensions) || provider.dimensions <= 0) {
    throw new Error('An embedding provider must declare a positive whole number of dimensions.');
  }
}

/**
 * Reads what a provider returned, or refuses it.
 *
 * Everything is checked because nothing is known: the value crossed a process
 * boundary. It must be an array, of exactly the declared length, of finite
 * numbers, not all of them zero. Nothing is coerced, truncated, padded or
 * normalised to fit — a provider that returns the wrong thing is broken, and
 * every silent repair would store a vector the model never produced.
 *
 * The all-zero check earns its place with a measurement: PostgreSQL stores a
 * zero vector without complaint, and cosine distance against one is NULL — so
 * the row would save cleanly and then vanish from, or corrupt the ordering
 * of, every similarity query that later exists. The finite and zero rules are
 * also enforced by the artifact domain itself, so this boundary is the first
 * check rather than the only one.
 */
export function toProviderEmbedding(
  output: unknown,
  provider: EmbeddingProvider,
): readonly number[] {
  if (!Array.isArray(output)) {
    throw new InvalidEmbeddingProviderOutputError('it is not an array');
  }
  if (output.length !== provider.dimensions) {
    throw new InvalidEmbeddingProviderOutputError(
      'it does not have the number of dimensions the provider declared',
    );
  }

  const embedding: number[] = [];
  let magnitude = 0;
  for (const value of output as unknown[]) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new InvalidEmbeddingProviderOutputError('it holds a value that is not a number');
    }
    magnitude += Math.abs(value);
    embedding.push(value);
  }
  if (magnitude === 0) {
    throw new InvalidEmbeddingProviderOutputError('every dimension is zero');
  }

  return embedding;
}
