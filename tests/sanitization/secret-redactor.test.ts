/**
 * Removing the credential and leaving the sentence.
 *
 * The point of redaction over refusal is that "the deploy failed because
 * `API_KEY=abc123` was stale" is worth keeping. So most of this suite checks
 * the *surroundings*: that the words either side survive intact, that a second
 * credential in the same string is not overlooked because the first was found,
 * and that a cookie's name and a `Set-Cookie`'s attributes come through.
 *
 * The other half is the refusals. `null` means "this cannot be removed
 * safely", and the caller must treat it as a refusal — a redactor that did its
 * best and returned something would produce the worst available outcome: a
 * write that succeeds, looks clean and still holds a credential.
 *
 * Nothing here is a real credential.
 */

import { describe, expect, it } from 'vitest';

import {
  createSecretRedactor,
  REDACTION_MARKER,
  type FieldPath,
  type SanitizationSite,
} from '../../src/sanitization/index.js';

const redactor = createSecretRedactor();

/** A value with no structural context: the content rules alone. */
const BARE: SanitizationSite = {
  path: [
    { kind: 'operation', name: 'appendEvent' },
    { kind: 'argument', index: 0 },
    { kind: 'key', name: 'summary' },
  ],
  kind: 'value',
};

function under(...keys: string[]): SanitizationSite {
  const path: FieldPath = [
    { kind: 'operation', name: 'createEnvironment' },
    { kind: 'argument', index: 0 },
    ...keys.map((name) => ({ kind: 'key' as const, name })),
  ];
  return { path, kind: 'value' };
}

const redact = (text: string, at: SanitizationSite = BARE): string | null =>
  redactor.redact(text, at);

const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';

describe('the sentence around a credential survives', () => {
  it('removes only the value from an assignment in prose', () => {
    expect(redact('failed because API_KEY=abc123def was stale')).toBe(
      'failed because API_KEY=[REDACTED] was stale',
    );
  });

  it('keeps the variable name, which is the part worth reading', () => {
    // `API_KEY` is what makes the note useful later. Removing it too would
    // leave a sentence that says something went wrong with something.
    expect(redact('set CLIENT_SECRET=abc123def in the deploy environment')).toContain(
      'CLIENT_SECRET=',
    );
  });

  it.each([
    [
      'a leading sentence',
      'We fixed it by setting token=abc123def yesterday.',
      'We fixed it by setting token=[REDACTED] yesterday.',
    ],
    // The comma goes with the value: an unquoted token runs to the next space,
    // and erring toward removing one character too many is the right bias for
    // a control whose other failure mode is storing a credential.
    [
      'a trailing clause',
      'token=abc123def, which had expired.',
      'token=[REDACTED] which had expired.',
    ],
    [
      'parentheses',
      'the config (PASSWORD=letmein) was wrong',
      'the config (PASSWORD=[REDACTED] was wrong',
    ],
    // A quoted value is taken whole, quotes included, so a passphrase with
    // spaces in it goes entirely.
    [
      'a quoted value',
      'PASSWORD="correct horse battery staple" in the file',
      'PASSWORD=[REDACTED] in the file',
    ],
  ])('leaves the words around %s', (_label, text, expected) => {
    expect(redact(text)).toBe(expected);
  });

  it('removes every credential, not just the first', () => {
    // A `.env` paste holds several. Removing one is barely better than
    // removing none, and would read as though the string had been cleaned.
    expect(redact('API_KEY=abc123def and PASSWORD=letmein and token=xyz789abc')).toBe(
      'API_KEY=[REDACTED] and PASSWORD=[REDACTED] and token=[REDACTED]',
    );
  });

  it('removes credentials from a multi-line .env paste and keeps the rest', () => {
    const result = redact(
      ['# staging', 'NODE_ENV=production', 'ACCESS_TOKEN=abc123def', 'PORT=3000'].join('\n'),
    );

    expect(result).toBe(
      ['# staging', 'NODE_ENV=production', 'ACCESS_TOKEN=[REDACTED]', 'PORT=3000'].join('\n'),
    );
  });

  it('removes two credentials of different kinds from one string', () => {
    const result = redact(`sent ${JWT} with API_KEY=abc123def`);

    expect(result).toBe(`sent ${REDACTION_MARKER} with API_KEY=${REDACTION_MARKER}`);
  });
});

describe('a whole value that is nothing but a credential', () => {
  it.each([
    ['api_key', 'abc123def'],
    ['password', 'letmein'],
    ['client_secret', 'supersecret'],
    ['access_token', 'correct horse battery staple'],
  ])('replaces the whole value under %s', (key, value) => {
    // The field name is the context, so there is nothing around the credential
    // to preserve — the value *is* the credential however it is written.
    expect(redact(value, under('snapshot', key))).toBe(REDACTION_MARKER);
  });

  it('replaces the whole value even when it also parses as something else', () => {
    expect(redact(`API_KEY=abc123def`, under('snapshot', 'api_key'))).toBe(REDACTION_MARKER);
  });
});

describe('headers keep their shape', () => {
  it('removes the credential from an authorization header', () => {
    expect(redact('Authorization: Bearer abc123def456')).toBe('Authorization: Bearer [REDACTED]');
  });

  it('removes a bare scheme credential', () => {
    expect(redact('Bearer sk-fake-0123456789abcdefghij')).toBe('Bearer [REDACTED]');
  });

  it('removes every value from a cookie header and keeps the names', () => {
    expect(redact('Cookie: sid=abc123def; auth=xyz789ghi')).toBe(
      'Cookie: sid=[REDACTED]; auth=[REDACTED]',
    );
  });

  it('removes only the cookie from a set-cookie, not its attributes', () => {
    // `Path`, `Max-Age` and `SameSite` describe how the browser should treat
    // the cookie. An earlier version read `Path=/` as a second cookie value
    // and refused the whole string.
    expect(redact('Set-Cookie: sid=abc123def; Path=/; Max-Age=3600; SameSite=Lax')).toBe(
      'Set-Cookie: sid=[REDACTED]; Path=/; Max-Age=3600; SameSite=Lax',
    );
  });

  it('finds nothing to remove in a set-cookie that is already redacted', () => {
    // Both halves matter: the marker is recognised as a placeholder, and
    // `Path=/` is an attribute rather than a second cookie. An earlier version
    // read the path as a value and refused the whole string.
    expect(redact('Set-Cookie: sid=[REDACTED]; Path=/')).toBeNull();
  });
});

describe('tokens and keys', () => {
  it('removes only the token span of a JWT in prose', () => {
    expect(redact(`the call sent ${JWT} and failed`)).toBe(
      `the call sent ${REDACTION_MARKER} and failed`,
    );
  });

  it.each([
    ['a plain key', 'PRIVATE KEY'],
    ['an RSA key', 'RSA PRIVATE KEY'],
    ['an EC key', 'EC PRIVATE KEY'],
  ])('removes a complete PEM block for %s', (_label, label) => {
    const text = `before\n-----BEGIN ${label}-----\nMIIEvQIBADANBg\n-----END ${label}-----\nafter`;

    expect(redact(text)).toBe(`before\n${REDACTION_MARKER}\nafter`);
  });

  it.each([
    ['a block with no end', 'oops -----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg'],
    ['a truncated block', '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQ'],
    [
      'a second block left open',
      [
        '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----',
        '-----BEGIN PRIVATE KEY-----\nBBBB',
      ].join('\n'),
    ],
  ])('refuses %s, because the end is not knowable', (_label, text) => {
    // Guessing where key material stops would leave part of it stored, so
    // there is no honest span and the write has to be refused instead.
    expect(redact(text)).toBeNull();
  });

  it('does not touch a public key', () => {
    const text = '-----BEGIN PUBLIC KEY-----\nMIIBIjANBg\n-----END PUBLIC KEY-----';

    // Publishing a public key is the point of having one. Nothing to remove,
    // so nothing is located and the redactor declines rather than rewriting.
    expect(redact(text)).toBeNull();
  });
});

describe('redaction is idempotent', () => {
  it.each([
    ['failed because API_KEY=abc123def was stale'],
    ['API_KEY=abc123def and PASSWORD=letmein'],
    ['Authorization: Bearer abc123def456'],
    ['Cookie: sid=abc123def; auth=xyz789ghi'],
    ['Set-Cookie: sid=abc123def; Path=/'],
    [`the call sent ${JWT} and failed`],
  ])('running it twice changes nothing more for %s', (text) => {
    const once = redact(text);
    expect(once).not.toBeNull();

    // The marker is itself a recognised placeholder, so a second pass finds
    // nothing left to remove. Anything else would mean redacted records could
    // not be re-processed — by an export, a migration, or a retry.
    expect(redact(once ?? '')).toBeNull();
  });

  it('leaves text that is already redacted untouched', () => {
    for (const text of [
      'failed because API_KEY=[REDACTED] was stale',
      'Authorization: Bearer [REDACTED]',
      'Cookie: sid=[REDACTED]',
    ]) {
      expect(redact(text), text).toBeNull();
    }
  });
});

describe('nothing to remove', () => {
  it.each([
    ['ordinary prose', 'The access token had expired, so the callback returned 401.'],
    ['a UUID', '550e8400-e29b-41d4-a716-446655440000'],
    ['a commit SHA', 'a9c298878e015b0b64a7d040e42229f53069b0e9'],
    ['a URL', 'https://example.com/docs/oauth/redirect-uris'],
    ['a status note', 'password: unknown'],
    ['an ambiguous word', 'morning'],
  ])('declines %s rather than rewriting it', (_label, text) => {
    // `null` is not "nothing found is fine" — the policy reads it as a refusal
    // and only asks after the detector already said there was a credential.
    expect(redact(text)).toBeNull();
  });

  it('declines an ordinary word under an ambiguous name', () => {
    // A `suspected` finding is kept, never redacted: rewriting a
    // documentation example would be worse than storing it.
    expect(redact('morning', under('snapshot', 'session'))).toBeNull();
  });
});

/**
 * Removing a credential that sits inside another assignment's value.
 *
 * Every expectation here is the whole string, not a search for `[REDACTED]`.
 * The offsets are the point: an off-by-one eats the `=` before the value, the
 * last character of the name, or — for a quoted value — the quote that closes
 * it. `toContain` would pass through all of those.
 */
describe('a credential nested inside another assignment', () => {
  it.each([
    ['x=AWS_SECRET_ACCESS_KEY=fake-9f2c4d8a1b6e3057', 'x=AWS_SECRET_ACCESS_KEY=[REDACTED]'],
    [
      'config=AWS_SECRET_ACCESS_KEY=fake-9f2c4d8a1b6e3057',
      'config=AWS_SECRET_ACCESS_KEY=[REDACTED]',
    ],
    [
      'ran x=AWS_SECRET_ACCESS_KEY=fake-9f2c4d8a1b6e3057 then failed',
      'ran x=AWS_SECRET_ACCESS_KEY=[REDACTED] then failed',
    ],
    ['x=foo=AWS_SECRET_ACCESS_KEY=fake-9f2c4d8a1b6e3057', 'x=foo=AWS_SECRET_ACCESS_KEY=[REDACTED]'],
    ['x=y=z=PASSWORD=fake-9f2c4d8a1b6e3057', 'x=y=z=PASSWORD=[REDACTED]'],
    ['foo=client_secret=fake-9f2c4d8a1b6e3057', 'foo=client_secret=[REDACTED]'],
  ])('removes the value and nothing else from %s', (text, expected) => {
    expect(redact(text)).toBe(expected);
  });

  it.each([
    ['x="AWS_SECRET_ACCESS_KEY=fake-9f2c4d8a1b6e3057"', 'x="AWS_SECRET_ACCESS_KEY=[REDACTED]"'],
    ["x='PASSWORD=fake-9f2c4d8a1b6e3057'", "x='PASSWORD=[REDACTED]'"],
    ['config="foo=CLIENT_SECRET=fake-9f2c4d8a1b6e3057"', 'config="foo=CLIENT_SECRET=[REDACTED]"'],
  ])('keeps the quotes that close the value in %s', (text, expected) => {
    // The pattern that locates a nested value would run past a closing quote
    // if it were allowed to; the value it is reading inside ends first.
    expect(redact(text)).toBe(expected);
  });

  it('keeps the surrounding sentence when the nesting is deep', () => {
    const text = `before ${'a='.repeat(40)}PASSWORD=fake-9f2c4d8a1b6e3057 after`;

    expect(redact(text)).toBe(`before ${'a='.repeat(40)}PASSWORD=[REDACTED] after`);
  });

  it('removes both when two assignments follow one ordinary name', () => {
    expect(redact('x=API_KEY=fake-9f2c4d8a1b6e3057 and PASSWORD=fake-1a2b3c4d5e6f')).toBe(
      'x=API_KEY=[REDACTED] and PASSWORD=[REDACTED]',
    );
  });

  it('is idempotent on a nested credential', () => {
    const once = redact('x=AWS_SECRET_ACCESS_KEY=fake-9f2c4d8a1b6e3057');

    expect(once).toBe('x=AWS_SECRET_ACCESS_KEY=[REDACTED]');
    // The marker is a recognised placeholder, so a second pass finds nothing
    // left to remove — the same answer this module gives for any text it has
    // no span in, and what lets a redacted record be re-processed later.
    expect(redact(once ?? '')).toBeNull();
  });

  it('finds nothing to remove behind a nested placeholder', () => {
    // Reading further inside a value does not lower the bar: `CHANGE_ME` under
    // a credential name is still a placeholder, so there is no span and this
    // refuses rather than rewriting something nobody identified.
    expect(redact('x=API_KEY=CHANGE_ME')).toBeNull();
  });
});
