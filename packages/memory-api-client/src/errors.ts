/**
 * What can go wrong between a caller and the Memory Server, in three kinds.
 *
 * The kinds exist because a caller does different things with each, and a
 * single error type would force it to guess from a message which situation it
 * was in:
 *
 * - **`MemoryApiError`** — the server answered, and the answer was no. The
 *   request reached a running Memory Server which understood it and refused.
 *   Retrying it unchanged will be refused again.
 * - **`MemoryApiUnreachableError`** — there was no answer. Nothing is known
 *   about whether the request arrived. This is the case a fallback path cares
 *   about, and the reason it is not folded into the one above: "the Memory
 *   said no" and "the Memory did not say anything" are different facts, and
 *   an adapter that treats absence as refusal will stop working the moment
 *   the server is restarted.
 * - **`MemoryApiProtocolError`** — something answered, but not with anything
 *   this contract describes. A proxy's HTML error page, a truncated body, an
 *   error envelope with a code this client has never heard of.
 *
 * ## What is deliberately not in any of them
 *
 * The credential, obviously, and also **the values that caused the failure**.
 * A message that quotes the malformed body is a message that will eventually
 * quote a Memory's contents into a log file, and a message that quotes the
 * rejected base URL is one that will quote a URL somebody put a password in.
 * So every message here is fixed prose selected by a closed identifier, and
 * the identifier is the only thing that varies.
 *
 * That costs something real — a failure says what kind it was rather than what
 * the bytes were — and the trade is deliberate. The kind is what a caller
 * branches on; the bytes are what a human wants, and a human can look at the
 * server's own log, where the request id in `MemoryApiError` leads.
 */

/**
 * The error codes the Memory JSON API answers with.
 *
 * A closed set, mirrored from the published contract rather than imported: a
 * client that reached into the server's source would be a client only this
 * repository could run, which is the opposite of the point. A test in the
 * server's own suite compares the two lists, so the mirror cannot drift
 * quietly.
 */
export const MEMORY_API_ERROR_CODES = [
  'INVALID_REQUEST',
  'UNAUTHENTICATED',
  'NOT_FOUND',
  'VERSION_CONFLICT',
  'EXPORT_BLOCKED',
  'INTERNAL_ERROR',
] as const;

export type MemoryApiErrorCode = (typeof MEMORY_API_ERROR_CODES)[number];

/** Whether a value is one of the codes this contract names. */
export function isMemoryApiErrorCode(value: unknown): value is MemoryApiErrorCode {
  return typeof value === 'string' && (MEMORY_API_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * The server understood the request and refused it.
 *
 * `status`, `code` and `requestId` are carried as properties rather than
 * written into the message, so a caller reads them rather than parsing prose,
 * and prose that reaches a log carries nothing that varies with the request.
 *
 * The server's own `message` is not kept. It is fixed prose per code today,
 * but it is the server's to change, and echoing a field whose contents are
 * decided elsewhere is how a value nobody expected ends up in a log line.
 */
export class MemoryApiError extends Error {
  readonly status: number;
  readonly code: MemoryApiErrorCode;
  readonly requestId: string;

  constructor(status: number, code: MemoryApiErrorCode, requestId: string) {
    super(`The Memory API refused the request: ${code}.`);
    this.name = 'MemoryApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

/**
 * Why no response arrived.
 *
 * Closed, and short on purpose: a caller does the same thing for all of them.
 */
export const MEMORY_API_UNREACHABLE_REASONS = [
  /** The request was abandoned — a timeout, or a caller's own signal. */
  'ABORTED',
  /** Nothing could be sent, or nothing came back. */
  'TRANSPORT',
] as const;

export type MemoryApiUnreachableReason = (typeof MEMORY_API_UNREACHABLE_REASONS)[number];

/**
 * No answer came back, so nothing is known about what happened.
 *
 * The underlying failure is not attached, not as a `cause` and not in the
 * message. A driver's error carries the address it tried, sometimes the
 * request, and on some platforms the whole options object — and a `cause` is
 * printed by every ordinary logger, which is exactly the path that puts a
 * credential in a file.
 */
export class MemoryApiUnreachableError extends Error {
  readonly reason: MemoryApiUnreachableReason;

  constructor(reason: MemoryApiUnreachableReason) {
    super('The Memory API could not be reached.');
    this.name = 'MemoryApiUnreachableError';
    this.reason = reason;
  }
}

/**
 * The ways a response can fail to be one this contract describes.
 *
 * Each names a place the answer stopped making sense, and none of them names
 * a value.
 */
export const MEMORY_API_PROTOCOL_FAILURES = [
  /** The body was not JSON at all. */
  'BODY_NOT_JSON',
  /** JSON, but not an object — a bare array, string, number or null. */
  'BODY_NOT_AN_OBJECT',
  /** A refusal whose envelope is missing or misshapen. */
  'ERROR_ENVELOPE_MALFORMED',
  /** A well-formed envelope naming a code this contract does not have. */
  'ERROR_CODE_UNKNOWN',
  /** A success whose body is not the resource it should be. */
  'RESOURCE_MALFORMED',
] as const;

export type MemoryApiProtocolFailure = (typeof MEMORY_API_PROTOCOL_FAILURES)[number];

/**
 * Something answered, but not in this contract's language.
 *
 * Kept apart from `MemoryApiError` because the server did not refuse anything
 * — whatever produced this may not have been the Memory Server at all. A
 * caller that folded the two together would report a proxy outage as a
 * validation failure and would keep the request that caused it.
 *
 * The body is not attached. On a success path it would be Memory content; on
 * a failure path it is whatever the intermediary decided to say.
 */
export class MemoryApiProtocolError extends Error {
  readonly failure: MemoryApiProtocolFailure;
  readonly status: number;

  constructor(failure: MemoryApiProtocolFailure, status: number) {
    super(`The Memory API answered with something this client cannot read: ${failure}.`);
    this.name = 'MemoryApiProtocolError';
    this.failure = failure;
    this.status = status;
  }
}
