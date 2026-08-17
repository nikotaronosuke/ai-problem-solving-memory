/**
 * Reading a Responses API answer down to the one JSON document it should hold.
 *
 * Both generative adapters — the summary generator and the structural
 * reranker — ask the Responses API for exactly one structured document and
 * nothing else, so what a response can legitimately be is narrow: completed,
 * carrying a message whose content is output text. Everything else is refused
 * by kind rather than papered over:
 *
 * - a **refusal** is the model declining, and treating its refusal text as a
 *   summary would store an apology as somebody's Memory rendering;
 * - an **incomplete** response stopped before the document was finished, and
 *   a truncated JSON document that happens to parse would be a silently
 *   partial answer;
 * - a missing or empty output is a provider contract change, not a value.
 *
 * There is deliberately no fallback to model prose. Structured output was
 * requested with a strict schema; an answer that is not that document is a
 * failure, whatever else it contains.
 */

import { OpenAiRequestError } from './transport.js';

/** The refusal-shaped failures a Responses call can end in. */
export const OPENAI_RESPONSE_FAILURES = [
  /** The model refused to answer. */
  'REFUSED',
  /** The response stopped before the document was complete. */
  'INCOMPLETE',
  /** No structured document where one was required. */
  'NO_STRUCTURED_OUTPUT',
] as const;

export type OpenAiResponseFailure = (typeof OPENAI_RESPONSE_FAILURES)[number];

/**
 * Raised when a well-formed HTTP response does not hold a usable document.
 *
 * The kind and nothing else — no refusal text, no partial document, no
 * provider identifiers.
 */
export class OpenAiResponseError extends Error {
  readonly failure: OpenAiResponseFailure;

  constructor(failure: OpenAiResponseFailure) {
    super(`The OpenAI response held no usable document: ${failure}.`);
    this.name = 'OpenAiResponseError';
    this.failure = failure;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Extracts and parses the structured document, or refuses the response.
 *
 * The walk mirrors the documented response shape: a `status`, an `output`
 * array, message items whose `content` holds `output_text` or `refusal`
 * items. Anything outside that shape is a malformed response — the transport
 * error type is reused because it is the same situation seen one layer up:
 * the thing on the other side did not answer in the contract's language.
 */
export function readStructuredDocument(body: unknown): unknown {
  if (!isPlainObject(body)) {
    throw new OpenAiRequestError('MALFORMED_RESPONSE');
  }

  const status = body['status'];
  if (status === 'incomplete') {
    throw new OpenAiResponseError('INCOMPLETE');
  }
  if (status !== 'completed') {
    // In-progress, failed, queued: none of them carries the finished
    // document this caller asked to wait for.
    throw new OpenAiResponseError('NO_STRUCTURED_OUTPUT');
  }

  const output = body['output'];
  if (!Array.isArray(output)) {
    throw new OpenAiRequestError('MALFORMED_RESPONSE');
  }

  const texts: string[] = [];
  for (const item of output as unknown[]) {
    if (!isPlainObject(item) || item['type'] !== 'message') {
      // Reasoning items and anything future ride alongside the message;
      // they are not the document and are not read.
      continue;
    }
    const content = item['content'];
    if (!Array.isArray(content)) {
      throw new OpenAiRequestError('MALFORMED_RESPONSE');
    }
    for (const part of content as unknown[]) {
      if (!isPlainObject(part)) {
        throw new OpenAiRequestError('MALFORMED_RESPONSE');
      }
      if (part['type'] === 'refusal') {
        // Before any text is considered: a message carrying both a refusal
        // and text is still a refusal.
        throw new OpenAiResponseError('REFUSED');
      }
      if (part['type'] === 'output_text' && typeof part['text'] === 'string') {
        texts.push(part['text']);
      }
    }
  }

  const document = texts.join('');
  if (document === '') {
    throw new OpenAiResponseError('NO_STRUCTURED_OUTPUT');
  }

  try {
    return JSON.parse(document) as unknown;
  } catch {
    // Strict structured output should make this unreachable; when it happens
    // anyway, the provider broke its contract and the document is not shown.
    throw new OpenAiRequestError('MALFORMED_RESPONSE');
  }
}
