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
  type SecretRedactor,
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

/**
 * A detector shaped like a real one: it finds a credential, and once the
 * redactor has been through it finds nothing left.
 */
function findsUntilRedacted(finding: SecretFinding): SecretDetector {
  let asked = 0;
  return {
    detect: () => {
      asked += 1;
      return asked === 1 ? finding : null;
    },
  };
}

function alwaysRedactsTo(value: string | null): SecretRedactor {
  return { redact: () => value };
}

const CONFIRMED: SecretFinding = { category: 'CREDENTIAL_ASSIGNMENT', certainty: 'confirmed' };

describe('the policy asks a detector and acts on the answer', () => {
  it('redacts a confirmed credential the redactor could remove', () => {
    const policy = createSecretDetectionPolicy(
      findsUntilRedacted(CONFIRMED),
      alwaysRedactsTo('cleaned'),
    );

    expect(policy.inspect('anything', SITE)).toEqual({ kind: 'replace', value: 'cleaned' });
  });

  it.each([
    'PRIVATE_KEY',
    'JWT',
    'AUTHORIZATION',
    'COOKIE',
    'CREDENTIAL_ASSIGNMENT',
    'CREDENTIAL_FIELD',
  ] as const)('treats a confirmed %s the same as any other category', (category) => {
    // The action follows the certainty and what the redactor could do, never
    // the category. There is no category-to-action table, because nothing has
    // asked for one.
    const policy = createSecretDetectionPolicy(
      findsUntilRedacted({ category, certainty: 'confirmed' }),
      alwaysRedactsTo('cleaned'),
    );

    expect(policy.inspect('anything', SITE)).toEqual({ kind: 'replace', value: 'cleaned' });
  });

  it('refuses when the redactor cannot remove it safely', () => {
    // `null` is a refusal, never a shrug. A redactor that did its best and
    // returned something would produce a write that succeeds, looks clean and
    // still holds a credential.
    const policy = createSecretDetectionPolicy(alwaysFinds(CONFIRMED), alwaysRedactsTo(null));

    expect(policy.inspect('anything', SITE)).toEqual({ kind: 'reject' });
  });

  it('refuses when a confirmed credential survives the redaction', () => {
    // The fail-closed post-check, and the case it exists for: partial removal
    // is worse than none, because the record then reads as sanitised.
    const policy = createSecretDetectionPolicy(
      alwaysFinds(CONFIRMED),
      alwaysRedactsTo('still bad'),
    );

    expect(policy.inspect('anything', SITE)).toEqual({ kind: 'reject' });
  });

  it('refuses a confirmed credential written into an object key', () => {
    // Replacing a key can collide with one already present and silently merge
    // two fields, so the caller loses data without being told.
    const policy = createSecretDetectionPolicy(
      findsUntilRedacted(CONFIRMED),
      alwaysRedactsTo('cleaned'),
    );

    expect(policy.inspect('anything', { path: AT_ROOT, kind: 'key' })).toEqual({ kind: 'reject' });
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

  it('never asks the redactor about something it is keeping', () => {
    let asked = false;
    const policy = createSecretDetectionPolicy(
      alwaysFinds({ category: 'CREDENTIAL_FIELD', certainty: 'suspected' }),
      {
        redact: () => {
          asked = true;
          return 'cleaned';
        },
      },
    );

    expect(policy.inspect('anything', SITE)).toEqual({ kind: 'keep' });
    // Rewriting a documentation example would be worse than storing it.
    expect(asked).toBe(false);
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

    // A key block with no end: detected, impossible to bound, so refused.
    const outcome = policy.inspect(`-----BEGIN PRIVATE KEY-----\n${secret}`, SITE);

    expect(outcome).toEqual({ kind: 'reject' });
    expect(JSON.stringify(outcome)).not.toContain(secret);
  });

  it('redacts a suspected-looking value under a strong field name', () => {
    // The third review's regression, at the policy level: the inline
    // suspicion must not shadow the structure's confirmation into a keep.
    const policy = createSecretDetectionPolicy();
    const site = (key: string): SanitizationSite => ({
      path: [...AT_ROOT, { kind: 'key', name: 'snapshot' }, { kind: 'key', name: key }],
      kind: 'value',
    });

    expect(policy.inspect('token=morning', site('api_key'))).toEqual({
      kind: 'replace',
      value: '[REDACTED]',
    });
    expect(policy.inspect('session=morning', site('password'))).toEqual({
      kind: 'replace',
      value: '[REDACTED]',
    });
    expect(policy.inspect('token=letmein', site('client_secret'))).toEqual({
      kind: 'replace',
      value: '[REDACTED]',
    });
    // And without the strong name, suspicion alone still keeps.
    expect(policy.inspect('token=morning', site('note'))).toEqual({ kind: 'keep' });
  });

  it('returns a replacement holding no part of what it removed', () => {
    const policy = createSecretDetectionPolicy();

    const outcome = policy.inspect(`failed because API_KEY=${secret} was stale`, SITE);

    expect(outcome).toEqual({
      kind: 'replace',
      value: 'failed because API_KEY=[REDACTED] was stale',
    });
    expect(JSON.stringify(outcome)).not.toContain(secret);
  });

  it('raises a refusal that names neither the secret nor the category', () => {
    const policy = createSecretDetectionPolicy();

    try {
      // A credential written into an object key. Keys are never redacted, so
      // this is the path that still refuses.
      sanitizeValue({ snapshot: { [`Bearer ${secret}`]: 1 } }, policy, AT_ROOT);
      expect.unreachable('the policy should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(SanitizationRejectedError);
      const rejected = error as SanitizationRejectedError;

      expect(rejected.locator).toBe('appendEvent[0].<key>.<redacted>');
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
