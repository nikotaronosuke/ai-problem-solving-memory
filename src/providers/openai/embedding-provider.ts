/**
 * The production embedding provider: one Embeddings call, one vector.
 *
 * ## Identity, and its honest limitation
 *
 * `modelId` and `modelVersion` are both `text-embedding-3-large`, because
 * that is everything OpenAI publishes: the model has no dated snapshot, and a
 * version invented here would claim a precision the upstream does not offer.
 * The consequence is recorded rather than hidden — if the provider ever
 * changed the embedding space behind the same identifier, this system could
 * not detect it from the identity columns. Should dated snapshots appear,
 * moving to them is an ordinary identity change that reconciliation turns
 * into regeneration.
 *
 * `dimensions` is 1024 by explicit request. The model's native width is
 * larger; the `dimensions` parameter asks the API for the shortened
 * representation, and the declared identity is what makes stored vectors and
 * query vectors provably the same space — the vector search already refuses
 * to compare across model, version or width.
 *
 * ## What travels
 *
 * The normalized summary, verbatim, and nothing else — the same bytes stored
 * as `normalized_summary`, so an embedding is always reproducible from the
 * row it sits in. No keywords, no features, no identifiers.
 */

import type {
  EmbeddingProvider,
  EmbeddingProviderInput,
} from '../../domain/retrieval-embedding.js';
import { withClassifiedOpenAiFailures } from './failure.js';
import { OpenAiRequestError, type OpenAiTransport } from './transport.js';

/** The model behind the initial production embeddings. A constant, not a knob. */
export const OPENAI_EMBEDDING_MODEL = 'text-embedding-3-large';

/**
 * The width every stored and query vector has.
 *
 * Chosen once for the initial stack; changing it is an identity change that
 * regenerates every artifact, which is exactly what it should be.
 */
export const OPENAI_EMBEDDING_DIMENSIONS = 1024;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Builds the provider over a transport.
 *
 * The response is read down to the one vector and checked against what was
 * asked: the echoed model must be the configured one, the data must hold
 * exactly one embedding, and the vector must be entirely finite numbers of
 * exactly the declared width. `toProviderEmbedding` applies the same rules
 * again at the domain boundary — deliberately, since this adapter being
 * upstream of it is a fact about today's call graph.
 *
 * Every failure leaves classified, in the vendor-neutral words of
 * `RetrievalProviderCallError`: a rate limit or a server error as `UNAVAILABLE`,
 * which degrades the semantic channel; a refused request and every check below
 * as an integration failure, which does not. Before P5-02c-impl-1's formal
 * review all of them left as one transport error and the stage above read the
 * lot as unreachability — so an echo from another model, or a vector of the
 * wrong width, silently produced a lexical-only search result.
 */
export function createOpenAiEmbeddingProvider(transport: OpenAiTransport): EmbeddingProvider {
  return {
    modelId: OPENAI_EMBEDDING_MODEL,
    modelVersion: OPENAI_EMBEDDING_MODEL,
    dimensions: OPENAI_EMBEDDING_DIMENSIONS,

    embed(input: EmbeddingProviderInput): Promise<unknown> {
      return withClassifiedOpenAiFailures(async () => {
        const body = await transport.postJson('/embeddings', {
          model: OPENAI_EMBEDDING_MODEL,
          input: input.text,
          dimensions: OPENAI_EMBEDDING_DIMENSIONS,
          encoding_format: 'float',
        });

        if (!isPlainObject(body)) {
          throw new OpenAiRequestError('MALFORMED_RESPONSE');
        }

        // The echo is a cheap integrity check the API documents: a response
        // produced by some other model must not become a stored vector under
        // this identity, because the identity is what similarity search trusts.
        // Exact equality, deliberately: a prefix test would quietly accept
        // `text-embedding-3-large-something-else` as this identity, which is
        // precisely the invented compatibility the honest-identity rule
        // forbids. If OpenAI ever echoes a different identifier, the identity
        // contract changes on purpose, against fresh official docs — never by
        // an implicit match.
        const model = body['model'];
        if (model !== OPENAI_EMBEDDING_MODEL) {
          throw new OpenAiRequestError('MALFORMED_RESPONSE');
        }

        const data = body['data'];
        if (!Array.isArray(data) || data.length !== 1) {
          // One input went in, so anything but one vector is a broken answer —
          // and quietly taking the first of several would hide the break.
          throw new OpenAiRequestError('MALFORMED_RESPONSE');
        }

        const entry: unknown = data[0];
        if (!isPlainObject(entry) || !Array.isArray(entry['embedding'])) {
          throw new OpenAiRequestError('MALFORMED_RESPONSE');
        }
        const embedding = entry['embedding'] as unknown[];
        if (embedding.length !== OPENAI_EMBEDDING_DIMENSIONS) {
          throw new OpenAiRequestError('MALFORMED_RESPONSE');
        }
        for (const value of embedding) {
          if (typeof value !== 'number' || !Number.isFinite(value)) {
            throw new OpenAiRequestError('MALFORMED_RESPONSE');
          }
        }

        return embedding;
      });
    },
  };
}
