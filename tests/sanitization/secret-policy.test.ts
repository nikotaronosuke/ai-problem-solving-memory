/**
 * The seam between finding a credential and doing something about it.
 *
 * P3-02 answers "what is this?". P3-03 answers "what now?". This suite pins
 * the seam so the second question can be answered later without reopening the
 * first: the policy consults a detector it does not implement, and turns a
 * finding into an outcome by one rule that is visible here and nowhere else.
 *
 * What that rule is today is deliberately minimal. A confirmed credential is
 * refused, because P3-02's own completion condition is that a representative
 * secret is not stored in plaintext and refusing is the least-invented way to
 * hold that line. It is not the reject policy — it is fail-closed until there
 * is one.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  createSecretDetectionPolicy,
  sanitizeValue,
  SanitizationRejectedError,
  type FieldPath,
  type SanitizationSite,
  type SecretDetector,
  type SecretFinding,
} from '../../src/sanitization/index.js';

const AT_ROOT: FieldPath = [
  { kind: 'operation', name: 'appendEvent' },
  { kind: 'argument', index: 0 },
];

const SITE: SanitizationSite = { path: AT_ROOT, kind: 'value' };

/** A detector that answers the same thing however it is asked. */
function alwaysFinds(finding: SecretFinding | null): SecretDetector {
  return { detect: () => finding };
}

describe('the policy asks a detector and acts on the answer', () => {
  it('refuses a confirmed credential', () => {
    const policy = createSecretDetectionPolicy(
      alwaysFinds({ category: 'CREDENTIAL_ASSIGNMENT', certainty: 'confirmed' }),
    );

    expect(policy.inspect('anything', SITE)).toEqual({ kind: 'reject' });
  });

  it.each([
    'PRIVATE_KEY',
    'JWT',
    'AUTHORIZATION',
    'COOKIE',
    'CREDENTIAL_ASSIGNMENT',
    'CREDENTIAL_FIELD',
  ] as const)('refuses a confirmed %s whatever its category', (category) => {
    // The action follows the certainty, not the category. P3-03 may well want
    // to treat categories differently; nothing here has decided that it does.
    const policy = createSecretDetectionPolicy(alwaysFinds({ category, certainty: 'confirmed' }));

    expect(policy.inspect('anything', SITE)).toEqual({ kind: 'reject' });
  });

  it('keeps a suspected one', () => {
    const policy = createSecretDetectionPolicy(
      alwaysFinds({ category: 'CREDENTIAL_FIELD', certainty: 'suspected' }),
    );

    // Widening refusal to cover these would refuse configuration templates and
    // documentation examples, and a caller who cannot record what happened is
    // the failure this record exists to prevent. P3-03 decides.
    expect(policy.inspect('anything', SITE)).toEqual({ kind: 'keep' });
  });

  it('keeps what the detector did not find', () => {
    const policy = createSecretDetectionPolicy(alwaysFinds(null));

    expect(policy.inspect('anything', SITE)).toEqual({ kind: 'keep' });
  });

  it('never redacts, replaces or summarises', () => {
    // All of that is P3-03's. Doing any of it here would be inventing a policy
    // nobody has designed, and a half-redaction is harder to undo than a
    // refusal.
    for (const certainty of ['confirmed', 'suspected'] as const) {
      const policy = createSecretDetectionPolicy(alwaysFinds({ category: 'JWT', certainty }));

      expect(policy.inspect('anything', SITE).kind).not.toBe('replace');
    }
  });

  it('shows the detector the text and the site it was given', () => {
    const detect = vi.fn(() => null);
    const policy = createSecretDetectionPolicy({ detect });

    policy.inspect('some text', SITE);

    // Context-aware detection depends on this: the structured path is how
    // `{"api_key": "..."}` is recognisable at all.
    expect(detect).toHaveBeenCalledWith('some text', SITE);
  });

  it('inspects keys as well as values', () => {
    const seen: SanitizationSite[] = [];
    const policy = createSecretDetectionPolicy({
      detect: (_text, at) => {
        seen.push(at);
        return null;
      },
    });

    sanitizeValue({ snapshot: { api_key: 'value' } }, policy, AT_ROOT);

    expect(seen.filter((at) => at.kind === 'key')).toHaveLength(2);
    expect(seen.filter((at) => at.kind === 'value')).toHaveLength(1);
  });
});

describe('the policy carries nothing outward', () => {
  const secret = 'sk-fake-0123456789abcdefghijklmnop';

  it('has no name', () => {
    const policy = createSecretDetectionPolicy();

    // A name is free text fixed at configuration time, which is how a
    // credential reached the operational log twice during P3-01 review.
    expect(Object.keys(policy)).toEqual(['inspect']);
  });

  it('returns a refusal with nothing attached to it', () => {
    const policy = createSecretDetectionPolicy();

    const outcome = policy.inspect(`API_KEY=${secret}`, SITE);

    expect(outcome).toEqual({ kind: 'reject' });
    expect(JSON.stringify(outcome)).not.toContain(secret);
  });

  it('raises a refusal that names neither the secret nor the category', () => {
    const policy = createSecretDetectionPolicy();

    try {
      sanitizeValue({ snapshot: { api_key: secret } }, policy, AT_ROOT);
      expect.unreachable('the policy should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(SanitizationRejectedError);
      const rejected = error as SanitizationRejectedError;

      expect(rejected.locator).toBe('appendEvent[0].<key>.<key>');
      for (const rendered of [
        rejected.message,
        JSON.stringify(rejected),
        JSON.stringify({ ...rejected }),
        rejected.stack ?? '',
      ]) {
        expect(rendered).not.toContain(secret);
        // The category is not published either. P3-02 has no need to say
        // which rule fired, and every string that has escaped this boundary
        // escaped through a field someone added for debugging.
        expect(rendered).not.toContain('CREDENTIAL');
        expect(rendered).not.toContain('api_key');
      }
    }
  });
});
