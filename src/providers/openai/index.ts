/**
 * The OpenAI provider family: the initial production retrieval stack.
 *
 * Everything OpenAI-specific in this codebase lives under this directory.
 * The ports it implements are the vendor-neutral ones the domain and
 * application defined long before a vendor was chosen, and nothing above the
 * composition edge imports from here — a guard reads that, rather than
 * trusting it.
 */

export { OPENAI_API_KEY_ENV, resolveOpenAiRetrievalConfig } from './config.js';
export type { OpenAiRetrievalConfig } from './config.js';
export {
  createOpenAiTransport,
  OPENAI_API_BASE_URL,
  OPENAI_REQUEST_TIMEOUT_MS,
  OpenAiRequestError,
  type FetchLike,
  type OpenAiRequestFailure,
  type OpenAiTransport,
} from './transport.js';
export { OpenAiResponseError, type OpenAiResponseFailure } from './responses.js';
export {
  createOpenAiSummaryGenerator,
  OPENAI_SUMMARY_GENERATOR_ID,
  OPENAI_SUMMARY_GENERATOR_VERSION,
  OPENAI_SUMMARY_MODEL,
} from './summary-generator.js';
export {
  createOpenAiEmbeddingProvider,
  OPENAI_EMBEDDING_DIMENSIONS,
  OPENAI_EMBEDDING_MODEL,
} from './embedding-provider.js';
export { createOpenAiStructuralReranker, OPENAI_RERANK_MODEL } from './structural-reranker.js';
export { retrievalGenerationProfileFor } from './generation-profile.js';
