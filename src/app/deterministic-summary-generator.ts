/**
 * The deterministic renderer, presented as the summary-generator port.
 *
 * The pipeline neither knows nor cares whether a generator is a model behind
 * a network or a rule behind a function: it hands over the canonical source
 * bytes and validates whatever comes back. This adapter is the whole of the
 * difference — the renderer is synchronous and infallible-by-construction on
 * well-formed documents, and the port speaks promises and `unknown`.
 *
 * Everything the summary service does around a generator still applies
 * unchanged: the race re-read, the read-control checks, the output
 * validation, the credential inspection. A deterministic generator earns no
 * shortcuts through the boundary built for the untrusted one; sharing the
 * boundary is what keeps "a valid summary" one definition.
 */

import {
  DETERMINISTIC_RENDERER_ID,
  DETERMINISTIC_RENDERER_VERSION,
  renderDeterministicRetrievalSummary,
} from '../domain/deterministic-retrieval-renderer.js';
import type { RetrievalSummaryGenerator } from './retrieval-summary-service.js';

/**
 * The Tier-0 generator: always constructible, never configured, no provider.
 *
 * A function rather than a constant so each composition gets its own object —
 * the port is stateless either way, but a shared mutable-looking singleton
 * would invite identity comparisons nothing should depend on.
 */
export function createDeterministicSummaryGenerator(): RetrievalSummaryGenerator {
  return {
    generatorId: DETERMINISTIC_RENDERER_ID,
    generatorVersion: DETERMINISTIC_RENDERER_VERSION,
    generate: (input) => Promise.resolve(renderDeterministicRetrievalSummary(input.source)),
  };
}
