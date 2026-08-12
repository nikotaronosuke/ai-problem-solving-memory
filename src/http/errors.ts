/**
 * The one shape every failure takes.
 *
 * A client should be able to branch on `error.code` and never on a message or
 * a status code alone. Codes are added when a caller genuinely needs to act
 * differently, not in advance — a taxonomy invented before its callers exist
 * ends up describing the framework rather than the product.
 *
 * Nothing framework-specific reaches a client. Fastify and Ajv both produce
 * useful error objects; both stay on this side of the boundary, because
 * shipping them would make an internal library part of the public contract.
 */

/** Machine-readable failure codes. Clients branch on these. */
export const ERROR_CODES = [
  /** The request could not be parsed or failed validation. */
  'INVALID_REQUEST',
  /** No owner context could be established. */
  'UNAUTHENTICATED',
  /** No such route or resource. */
  'NOT_FOUND',
  /** Something went wrong that the client cannot act on. */
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorEnvelope {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
  };
  readonly request_id: string;
}

/**
 * Messages sent to clients.
 *
 * Fixed text, chosen so that no failure reveals more than the code already
 * does. In particular the unauthenticated message is identical whether the
 * owner was unset, malformed or simply does not exist — otherwise the response
 * answers "does this owner exist?" for anyone who asks.
 */
const MESSAGES: Record<ErrorCode, string> = {
  INVALID_REQUEST: 'Request validation failed.',
  UNAUTHENTICATED: 'No owner context could be established for this request.',
  NOT_FOUND: 'Not found.',
  INTERNAL_ERROR: 'Internal server error.',
};

export const ERROR_STATUS: Record<ErrorCode, number> = {
  INVALID_REQUEST: 400,
  UNAUTHENTICATED: 401,
  NOT_FOUND: 404,
  INTERNAL_ERROR: 500,
};

export function buildErrorEnvelope(code: ErrorCode, requestId: string): ErrorEnvelope {
  return { error: { code, message: MESSAGES[code] }, request_id: requestId };
}

/**
 * JSON Schema for the envelope, shared by every route's error responses.
 *
 * Declared once so a route cannot accidentally document a different shape
 * from the one the error handler actually sends.
 */
export const ERROR_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: { type: 'string', enum: [...ERROR_CODES] },
        message: { type: 'string' },
      },
      required: ['code', 'message'],
      additionalProperties: false,
    },
    request_id: { type: 'string' },
  },
  required: ['error', 'request_id'],
  additionalProperties: false,
} as const;
