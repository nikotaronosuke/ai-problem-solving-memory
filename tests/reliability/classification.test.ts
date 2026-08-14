/**
 * Which failures are worth trying again.
 *
 * A table, pinned literally, because this is the decision that determines
 * whether somebody's Event survives a bad afternoon or is discarded. Every
 * status this server can produce is here, plus the ones something in front of
 * it can produce, and each entry is a claim about what the server meant.
 *
 * The input shape is closed on purpose. A retry policy that reads
 * `error.message` has its behaviour chosen by whatever wrote the message, and
 * a proxy rewording a timeout would silently start dropping writes.
 */

import { describe, expect, it } from 'vitest';

import {
  classifyDeliveryOutcome,
  RETRY_DECISIONS,
  type DeliveryOutcome,
  type RetryDecision,
} from '../../src/reliability/index.js';

type Failure = Exclude<DeliveryOutcome, { kind: 'SUCCESS' }>;

const http = (status: number): Failure => ({ kind: 'HTTP_FAILURE', status });

describe('what a failed delivery means', () => {
  it('treats an unanswered request as worth repeating', () => {
    // The case the queue exists for: the server is down, or the network is.
    // Nothing refused anything, so nothing has been decided.
    expect(classifyDeliveryOutcome({ kind: 'TRANSPORT_FAILURE' })).toBe('RETRYABLE');
  });

  it.each<[number, string, RetryDecision]>([
    [408, 'a request timeout', 'RETRYABLE'],
    [429, 'a rate limit', 'RETRYABLE'],
    // Ambiguous by construction: this server answers 500 both for a database
    // that is briefly gone and for a bug in its own code, and the response
    // does not say which. Retrying spends a bounded number of attempts on a
    // bug; refusing discards a write whenever the database blinks.
    [500, 'an internal error', 'RETRYABLE'],
    [502, 'a bad gateway', 'RETRYABLE'],
    [503, 'an unavailable service', 'RETRYABLE'],
    [504, 'a gateway timeout', 'RETRYABLE'],

    // The credential is the obstacle, and waiting does not fix it — but
    // neither does giving up. A revoked credential is replaced, and the Event
    // queued before that happened is still worth saving.
    [401, 'an unauthenticated request', 'AUTH_REQUIRED'],

    [400, 'a refused payload', 'PERMANENT'],
    [403, 'a forbidden request', 'PERMANENT'],
    // The Problem was deleted. P3-05 leaves nothing to bring back, and a
    // retry would ask for the same absent row forever.
    [404, 'a Problem that is gone', 'PERMANENT'],
    [409, 'a conflict', 'PERMANENT'],
    [422, 'an unprocessable request', 'PERMANENT'],
    // An unrecognised 5xx. Refused rather than retried: something in the path
    // said a number nobody here has reasoned about, and that is not evidence
    // that waiting helps. The item is kept either way.
    [507, 'an unrecognised server error', 'PERMANENT'],
  ])('reads %i, %s, as %s', (status, _label, expected) => {
    expect(classifyDeliveryOutcome(http(status))).toBe(expected);
  });

  it.each([
    ['UNAUTHENTICATED' as const, 401, 'AUTH_REQUIRED' as const],
    ['INVALID_REQUEST' as const, 400, 'PERMANENT' as const],
    ['NOT_FOUND' as const, 404, 'PERMANENT' as const],
    ['VERSION_CONFLICT' as const, 409, 'PERMANENT' as const],
    // Reachable only if something queued an export, which nothing can. Listed
    // so the table covers the whole error contract rather than most of it.
    ['EXPORT_BLOCKED' as const, 409, 'PERMANENT' as const],
  ])('reads the %s code the same way as its status', (errorCode, status, expected) => {
    expect(classifyDeliveryOutcome({ kind: 'HTTP_FAILURE', status, errorCode })).toBe(expected);
  });

  it('offers exactly three decisions', () => {
    // Three, because there are three situations: nobody said no, the
    // credential is wrong, and the server refused. A fourth would have to
    // describe a fourth.
    expect([...RETRY_DECISIONS].sort()).toEqual(['AUTH_REQUIRED', 'PERMANENT', 'RETRYABLE']);
  });
});
