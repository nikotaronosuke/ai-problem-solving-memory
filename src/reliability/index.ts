/**
 * A client-side reliability library, not part of the Memory Server.
 *
 * Everything else in `src/` is the server. This is the one thing that is not,
 * and the distinction is load-bearing rather than organisational: a queue that
 * holds writes the server could not accept has to keep running when the server
 * is not, so it belongs beside whoever is calling. Nothing in `src/http`,
 * `src/app`, `src/db` or `src/index.ts` imports from here, and an architecture
 * test fails if that changes.
 *
 * It lives in this repository because the adapters that will use it are Phase
 * 5 and Phase 6, and the knowledge it encodes is this project's: which writes
 * the server deduplicates, what it says when it refuses one, and what a
 * credential may never be written into. Publishing it here now means those
 * answers are written down once, with tests, rather than reconstructed twice
 * by two adapters.
 *
 * What it deliberately does not contain: an HTTP client, a scheduler, a
 * credential, or a default location on disk. Each of those is an installation
 * decision, and guessing one on behalf of an adapter that does not exist is
 * how a library ends up with a behaviour nobody chose.
 */

export { nextDelayMs, type RetryPolicy } from './backoff.js';
export {
  classifyDeliveryOutcome,
  RETRY_DECISIONS,
  type DeliveryOutcome,
  type RetryDecision,
} from './classify.js';
export type { DeliveryContext, RetryDelivery } from './delivery.js';
export {
  generateQueueItemId,
  parseQueueItem,
  QUEUEABLE_OPERATIONS,
  RETRY_QUEUE_SCHEMA_VERSION,
  serialiseQueueItem,
  TERMINAL_FAILURES,
  type EventIntentPayload,
  type QueueableOperation,
  type QueueItem,
  type QueuedWrite,
  type TerminalFailure,
  type VerificationIntentPayload,
} from './item.js';
export {
  createRetryQueue,
  DRAIN_OUTCOMES,
  type DrainOutcome,
  type DrainReport,
  type RetryQueue,
  type RetryQueueOptions,
} from './queue.js';
export { QueueCapacityError, type QueueLimits } from './store.js';
