/**
 * The one translation from a vendor's failure vocabulary to the shared one.
 *
 * This is where P5-02c-impl-1's formal-review finding is pinned. Before it,
 * every provider failure left the adapters as one transport error and the stage
 * services read all of them as "could not be reached" — so a provider echoing
 * another model's name, or a rejected API key, degraded the semantic channel and
 * the search answered with its lexical half as though that were the shape asked
 * for. A broken integration was indistinguishable from a deployment that
 * configured no provider at all.
 *
 * The mapping is asserted case by case rather than by shape, because the whole
 * value of the classification is in which side of the line each case lands on.
 */

import { describe, expect, it } from 'vitest';

import {
  isRetrievalProviderIntegrationFailure,
  RETRIEVAL_PROVIDER_CALL_FAILURES,
  RetrievalProviderCallError,
} from '../../src/domain/retrieval-provider-failure.js';
import {
  classifyOpenAiFailure,
  OpenAiRequestError,
  OpenAiResponseError,
  withClassifiedOpenAiFailures,
} from '../../src/providers/openai/index.js';

describe('the shared failure vocabulary', () => {
  it('has exactly three words, and they do not overlap', () => {
    // Three, because there are three answers to "what should happen next":
    // wait and degrade, fail because the answer is unusable, fail because the
    // request was refused. A fourth would need a fourth answer.
    expect([...RETRIEVAL_PROVIDER_CALL_FAILURES]).toEqual([
      'UNAVAILABLE',
      'INVALID_RESPONSE',
      'UPSTREAM_REJECTED_REQUEST',
    ]);
    expect(new Set(RETRIEVAL_PROVIDER_CALL_FAILURES).size).toBe(3);
  });

  it('carries a fixed sentence and nothing else', () => {
    const error = new RetrievalProviderCallError('UPSTREAM_REJECTED_REQUEST');

    expect(error.message).toBe('A retrieval provider call failed: UPSTREAM_REJECTED_REQUEST.');
    // No status, no URL, no body, no cause. Every one of those is something a
    // provider chose, and this error travels into logs. `name` is the class's
    // own; `failure` is the only thing carried.
    expect(Object.keys(error).sort()).toEqual(['failure', 'name']);
    expect((error as { cause?: unknown }).cause).toBeUndefined();
  });

  it('names exactly the two kinds that must not be degraded', () => {
    expect(
      isRetrievalProviderIntegrationFailure(new RetrievalProviderCallError('UNAVAILABLE')),
    ).toBe(false);
    expect(
      isRetrievalProviderIntegrationFailure(new RetrievalProviderCallError('INVALID_RESPONSE')),
    ).toBe(true);
    expect(
      isRetrievalProviderIntegrationFailure(
        new RetrievalProviderCallError('UPSTREAM_REJECTED_REQUEST'),
      ),
    ).toBe(true);
  });

  it('says no to anything that is not one of these failures', () => {
    // The P4 contract: a port may throw whatever it likes, and a plain throw
    // has always meant an outage. That is what keeps this addition from
    // breaking ports written before it existed.
    for (const other of [
      new Error('anything'),
      'a string',
      undefined,
      null,
      { failure: 'INVALID_RESPONSE' },
    ]) {
      expect(isRetrievalProviderIntegrationFailure(other)).toBe(false);
    }
  });
});

describe('classifying an OpenAI failure', () => {
  it.each([
    // Temporarily unable to answer. Nothing is wrong with the integration.
    ['UNREACHABLE, no status', new OpenAiRequestError('UNREACHABLE'), 'UNAVAILABLE'],
    ['HTTP 429', new OpenAiRequestError('HTTP_ERROR', 429), 'UNAVAILABLE'],
    ['HTTP 500', new OpenAiRequestError('HTTP_ERROR', 500), 'UNAVAILABLE'],
    ['HTTP 502', new OpenAiRequestError('HTTP_ERROR', 502), 'UNAVAILABLE'],
    ['HTTP 503', new OpenAiRequestError('HTTP_ERROR', 503), 'UNAVAILABLE'],
    // The request itself refused. No waiting fixes any of these.
    ['HTTP 400', new OpenAiRequestError('HTTP_ERROR', 400), 'UPSTREAM_REJECTED_REQUEST'],
    ['HTTP 401', new OpenAiRequestError('HTTP_ERROR', 401), 'UPSTREAM_REJECTED_REQUEST'],
    ['HTTP 403', new OpenAiRequestError('HTTP_ERROR', 403), 'UPSTREAM_REJECTED_REQUEST'],
    ['HTTP 404', new OpenAiRequestError('HTTP_ERROR', 404), 'UPSTREAM_REJECTED_REQUEST'],
    ['HTTP 422', new OpenAiRequestError('HTTP_ERROR', 422), 'UPSTREAM_REJECTED_REQUEST'],
    // An HTTP error whose status somehow did not arrive is not guessed at.
    [
      'HTTP error with no status',
      new OpenAiRequestError('HTTP_ERROR'),
      'UPSTREAM_REJECTED_REQUEST',
    ],
    // The provider answered, and the answer is not usable.
    [
      'a body that was not JSON',
      new OpenAiRequestError('MALFORMED_RESPONSE', 200),
      'INVALID_RESPONSE',
    ],
    ['a refusal', new OpenAiResponseError('REFUSED'), 'INVALID_RESPONSE'],
    ['an incomplete answer', new OpenAiResponseError('INCOMPLETE'), 'INVALID_RESPONSE'],
    ['no structured output', new OpenAiResponseError('NO_STRUCTURED_OUTPUT'), 'INVALID_RESPONSE'],
  ])('classifies %s as %s', (_case, raised, expected) => {
    const classified = classifyOpenAiFailure(raised);

    expect(classified).toBeInstanceOf(RetrievalProviderCallError);
    expect(classified?.failure).toBe(expected);
  });

  it('leaves a status out of what it produces', () => {
    const classified = classifyOpenAiFailure(new OpenAiRequestError('HTTP_ERROR', 401));

    // The status is the last thing the boundary uses and the first thing it
    // drops: it is the provider's answer about this request, and a number in a
    // log is a number somebody will pair with a timestamp and a Problem id.
    expect(JSON.stringify(classified)).not.toContain('401');
    expect(classified?.message).not.toContain('401');
  });

  it('does not dress an unexpected error as a provider failure', () => {
    // A `TypeError` from the code that reads an answer is a bug here, not a
    // provider saying anything. Classifying it as `UNAVAILABLE` would degrade a
    // channel because of a mistake in this directory — the exact confusion the
    // classification exists to remove.
    expect(
      classifyOpenAiFailure(new TypeError('cannot read properties of undefined')),
    ).toBeUndefined();
    expect(classifyOpenAiFailure('a string')).toBeUndefined();
  });
});

describe('running a call with its failures classified', () => {
  it('returns the value when nothing fails', async () => {
    await expect(withClassifiedOpenAiFailures(() => Promise.resolve(7))).resolves.toBe(7);
  });

  it('classifies whatever the call raised', async () => {
    const call = withClassifiedOpenAiFailures(() =>
      Promise.reject(new OpenAiRequestError('HTTP_ERROR', 429)),
    );

    await expect(call).rejects.toBeInstanceOf(RetrievalProviderCallError);
    await expect(call).rejects.toMatchObject({ failure: 'UNAVAILABLE' });
  });

  it('lets an unexpected error through unchanged', async () => {
    const raised = new TypeError('a bug in the adapter');

    await expect(withClassifiedOpenAiFailures(() => Promise.reject(raised))).rejects.toBe(raised);
  });
});
