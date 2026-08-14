/**
 * What counts as a credential, and — at least as important — what does not.
 *
 * Two halves. The first is that representative secrets are recognised: this is
 * the phase's completion condition, and each category has a fixture written in
 * the form it actually arrives in.
 *
 * The second half is the one that decides whether any of this survives contact
 * with use. A detector that refuses a UUID, a commit SHA or an evidence
 * reference makes the record unusable, and the response to a tool that cries
 * wolf is to stop sending it things — which is a worse outcome than the
 * detector not existing. So the false-positive fixtures are treated as
 * requirements, not as courtesy checks.
 *
 * Nothing here is a real credential. Every fixture is invented, and the values
 * are shaped like the thing rather than being one.
 */

import { describe, expect, it } from 'vitest';

import {
  createSecretDetector,
  SECRET_CATEGORIES,
  SECRET_CERTAINTIES,
  type SecretFinding,
} from '../../src/sanitization/index.js';
import type { FieldPath, SanitizationSite } from '../../src/sanitization/index.js';

const detector = createSecretDetector();

/** A value with no surrounding structure: the content rules alone. */
const BARE: SanitizationSite = {
  path: [
    { kind: 'operation', name: 'appendEvent' },
    { kind: 'argument', index: 0 },
    { kind: 'key', name: 'summary' },
  ],
  kind: 'value',
};

/** A value sitting under a caller-chosen field name. */
function under(...keys: string[]): SanitizationSite {
  const path: FieldPath = [
    { kind: 'operation', name: 'createEnvironment' },
    { kind: 'argument', index: 0 },
    ...keys.map((name) => ({ kind: 'key' as const, name })),
  ];
  return { path, kind: 'value' };
}

/** A key, inspected as the boundary inspects one. */
const AS_KEY: SanitizationSite = {
  path: [
    { kind: 'operation', name: 'createEnvironment' },
    { kind: 'argument', index: 0 },
    { kind: 'key', name: 'snapshot' },
  ],
  kind: 'key',
};

const detect = (text: string, at: SanitizationSite = BARE): SecretFinding | null =>
  detector.detect(text, at);

/** A JWT header that really decodes: `{"alg":"HS256","typ":"JWT"}`. */
const JWT_HEADER = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
const JWT = `${JWT_HEADER}.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk`;

describe('credentials are recognised', () => {
  it.each([
    [
      'a bearer credential in a header line',
      'Authorization: Bearer abcdef0123456789abcdef',
      'AUTHORIZATION',
    ],
    ['a bare bearer credential', 'Bearer sk-fake-0123456789abcdefghij', 'AUTHORIZATION'],
    ['basic authentication', 'Authorization: Basic dXNlcjpwYXNzd29yZA==', 'AUTHORIZATION'],
    ['a JSON web token', JWT, 'JWT'],
    ['a JSON web token inside prose', `the call sent ${JWT} and failed`, 'JWT'],
    [
      'a PEM private key',
      '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----',
      'PRIVATE_KEY',
    ],
    [
      'an RSA private key',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQ\n-----END RSA PRIVATE KEY-----',
      'PRIVATE_KEY',
    ],
    [
      'an EC private key',
      '-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIBvQ\n-----END EC PRIVATE KEY-----',
      'PRIVATE_KEY',
    ],
    ['an api key assignment', 'API_KEY=fake-9f2c4d8a1b6e3057', 'CREDENTIAL_ASSIGNMENT'],
    ['a camel-case api key', 'apiKey: fake-9f2c4d8a1b6e3057', 'CREDENTIAL_ASSIGNMENT'],
    ['an access token', 'access_token=fake-atk-84726194055', 'CREDENTIAL_ASSIGNMENT'],
    ['a refresh token', 'refresh_token=fake-rtk-91827364550', 'CREDENTIAL_ASSIGNMENT'],
    ['a bare token assignment', 'token=fake-tok-5647382910abc', 'CREDENTIAL_ASSIGNMENT'],
    ['an auth token', 'auth_token: fake-auth-5647382910', 'CREDENTIAL_ASSIGNMENT'],
    ['a session token', 'session_token=fake-sess-5647382910', 'CREDENTIAL_ASSIGNMENT'],
    ['a password', 'PASSWORD=hunter2', 'CREDENTIAL_ASSIGNMENT'],
    ['a lowercase password', 'password: p4ssw0rd-not-real', 'CREDENTIAL_ASSIGNMENT'],
    ['a passwd variant', 'passwd=p4ssw0rd-not-real', 'CREDENTIAL_ASSIGNMENT'],
    ['an oauth client secret', 'client_secret=fake-cs-0192837465abc', 'CREDENTIAL_ASSIGNMENT'],
    [
      'an oauth client secret with a vendor prefix',
      'oauth_client_secret=fake-cs-0192837465abc',
      'CREDENTIAL_ASSIGNMENT',
    ],
    ['a quoted value', 'API_KEY="fake-9f2c4d8a1b6e3057"', 'CREDENTIAL_ASSIGNMENT'],
    ['a cookie header', 'Cookie: sid=fake-8a7b6c5d4e3f2a1b; theme=dark', 'COOKIE'],
    ['a set-cookie header', 'Set-Cookie: session=fake-8a7b6c5d4e; HttpOnly', 'COOKIE'],
    ['a session assignment', 'session=fake-8a7b6c5d4e3f2a1b', 'CREDENTIAL_ASSIGNMENT'],
    ['a session id assignment', 'session_id=fake-8a7b6c5d4e3f2a1b', 'CREDENTIAL_ASSIGNMENT'],
  ])('recognises %s', (_label, text, category) => {
    expect(detect(text)).toEqual({ category, certainty: 'confirmed' });
  });

  it('recognises a credential anywhere in a multi-line .env paste', () => {
    // The form these actually arrive in: pasted wholesale into a summary,
    // with ordinary configuration around the part that matters.
    const env = [
      '# staging',
      'NODE_ENV=production',
      'PORT=3000',
      'DATABASE_HOST=db.internal',
      'API_KEY=fake-9f2c4d8a1b6e3057',
      'LOG_LEVEL=info',
    ].join('\n');

    expect(detect(env)).toEqual({
      category: 'CREDENTIAL_ASSIGNMENT',
      certainty: 'confirmed',
    });
  });

  it.each([
    ['ACCESS_TOKEN=fake-atk-84726194055'],
    ['CLIENT_SECRET=fake-cs-0192837465abc'],
    ['PASSWORD=p4ssw0rd-not-real'],
  ])('recognises %s among ordinary settings', (line) => {
    const env = `NODE_ENV=production\n${line}\nPORT=3000`;

    expect(detect(env)?.certainty).toBe('confirmed');
  });

  it('recognises a credential assignment embedded in prose', () => {
    const prose =
      'The deploy failed until we set API_KEY=fake-9f2c4d8a1b6e3057 in the environment, then it worked.';

    expect(detect(prose)?.category).toBe('CREDENTIAL_ASSIGNMENT');
  });
});

describe('the caller’s own structure is the context', () => {
  it.each([
    ['api_key', 'fake-9f2c4d8a1b6e3057'],
    ['apiKey', 'fake-9f2c4d8a1b6e3057'],
    ['API-KEY', 'fake-9f2c4d8a1b6e3057'],
    ['client_secret', 'fake-cs-0192837465abc'],
    ['access_token', 'fake-atk-84726194055'],
    ['password', 'p4ssw0rd-not-real'],
    ['session_token', 'fake-sess-5647382910'],
    ['authorization', 'fake-auth-5647382910'],
    ['db_password', 'p4ssw0rd-not-real'],
    ['github_token', 'fake-ghp-5647382910abc'],
    ['stripe_api_key', 'fake-sk-5647382910abc'],
  ])('recognises a value under %s', (key, value) => {
    // The value has no recognisable form of its own. The field name is the
    // entire signal, which is the case a content-only detector cannot reach.
    expect(detect(value, under('snapshot', key))).toEqual({
      category: 'CREDENTIAL_FIELD',
      certainty: 'confirmed',
    });
  });

  it('recognises one nested several levels down', () => {
    expect(detect('fake-cs-0192837465abc', under('snapshot', 'auth', 'client_secret'))).toEqual({
      category: 'CREDENTIAL_FIELD',
      certainty: 'confirmed',
    });
  });

  it('keeps the association through an array', () => {
    const path: FieldPath = [
      { kind: 'operation', name: 'createEnvironment' },
      { kind: 'argument', index: 0 },
      { kind: 'key', name: 'api_keys' },
      { kind: 'element', index: 2 },
    ];

    expect(detector.detect('fake-9f2c4d8a1b6e3057', { path, kind: 'value' })?.certainty).toBe(
      'confirmed',
    );
  });

  it('does not carry a credential name down past an unrelated field', () => {
    // `snapshot.api_key.note` is a note, not a key. Only the nearest name
    // speaks for a value.
    expect(detect('an ordinary note about rotation', under('api_key', 'note'))).toBeNull();
  });

  it('recognises a credential written into an object key', () => {
    // The boundary inspects keys, and a caller can put the credential there
    // just as easily as in the value.
    expect(detector.detect(JWT, AS_KEY)?.category).toBe('JWT');
    expect(detector.detect('Bearer sk-fake-0123456789abcdefghij', AS_KEY)?.category).toBe(
      'AUTHORIZATION',
    );
    expect(
      detector.detect('-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----', AS_KEY)
        ?.category,
    ).toBe('PRIVATE_KEY');
  });

  it('does not judge a key by the field above it', () => {
    // Asking whether a key's parent named a credential says nothing about the
    // key's own text, and would refuse `{"api_key": {"rotated_at": "..."}}`.
    expect(detector.detect('rotated_at', { path: under('api_key').path, kind: 'key' })).toBeNull();
  });
});

describe('ordinary content is not a credential', () => {
  it.each([
    ['a UUID', '550e8400-e29b-41d4-a716-446655440000'],
    ['a client event id', '9b2f1c4e-6d3a-4b8e-9f10-2c5d7e8a1b34'],
    ['a git commit SHA', 'a9c298878e015b0b64a7d040e42229f53069b0e9'],
    ['a short SHA', 'a9c2988'],
    ['a SHA-256 digest', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['a database id', '01HQ8XJ7Z9K4M2N6P8R0T3V5W7'],
    ['an evidence reference', 'provider console, OAuth application settings'],
    ['a repository reference', 'example/storefront-web@a9c2988 src/auth/callback.ts'],
    ['a test name', 'auth.spec.ts > sign-in redirects to the provider'],
    ['a localhost URL', 'http://127.0.0.1:3000/v1/problems'],
    ['an ordinary https URL', 'https://example.com/docs/oauth/redirect-uris'],
    ['a file path', '/var/log/deploy/2026-08-13.log'],
    ['a windows path', 'C:\\dev\\ai-problem-solving-memory\\src\\auth'],
    ['a package name and version', '@fastify/swagger@9.8.1'],
    ['a runtime version', 'node 22.12.0'],
    ['a framework version', 'next 15.1.0'],
    ['a semver range', '^5.11.3'],
    ['a dotted identifier', '1.2.3-alpha.build.7'],
    ['an email address', 'customer@example.com'],
    ['an internal hostname', 'db.internal.example.com'],
    ['a PUBLIC key', '-----BEGIN PUBLIC KEY-----\nMIIBIjANBg\n-----END PUBLIC KEY-----'],
    ['an SSH public key line', 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQ user@host'],
    ['prose about a token', 'The access token had expired, so the callback returned 401.'],
    ['prose about a password', 'The user said they had forgotten their password.'],
    ['prose about a secret', 'The client secret is managed by the platform team, not by us.'],
    ['prose about a cookie', 'The cookie was missing because the domain did not match.'],
    ['prose about a private key', 'The private key never leaves the hardware module.'],
    ['a token word with a colon and a word', 'token: expired'],
    ['a password with a colon and a word', 'password: unknown'],
    ['a secret with a colon and a word', 'secret: rotated'],
    ['a bearer word in prose', 'Send a Bearer token on every request.'],
    ['an already-redacted marker', '[REDACTED]'],
    ['asterisks', '***'],
    ['an angle-bracket placeholder', '<token>'],
    ['a secret placeholder', '<secret>'],
    ['a configuration template', 'API_KEY=REPLACE_WITH_YOUR_KEY'],
    ['an empty string', ''],
  ])('keeps %s', (_label, text) => {
    expect(detect(text)).toBeNull();
  });

  it.each([['[REDACTED]'], ['***'], ['<token>'], ['<secret>'], ['CHANGE_ME'], [''], ['   ']])(
    'keeps %s even under a credential-named field',
    (placeholder) => {
      // Someone else already redacted this, or it is a template. Refusing it
      // would refuse the act of writing down that a credential was involved.
      expect(detect(placeholder, under('snapshot', 'api_key'))).toBeNull();
    },
  );

  it('keeps a word that describes the state of a credential', () => {
    // `{"password": "rotated"}` is a note about a credential, not one. The
    // status word is what says so — not the fact that it looks like a word,
    // which under `password` proves nothing at all.
    for (const [name, word] of [
      ['password', 'rotated'],
      ['api_key', 'expired'],
      ['client_secret', 'unknown'],
      ['token', 'revoked'],
      ['session', 'disabled'],
    ] as const) {
      expect(detect(word, under('snapshot', name)), `${name}: ${word}`).toBeNull();
    }
  });

  it('is unsure about an ordinary word under an ambiguous name', () => {
    // `session` has an everyday reading, so the value gets a say and the
    // answer is a shrug rather than a refusal. This is the one place value
    // shape decides anything.
    expect(detect('morning', under('snapshot', 'session'))).toEqual({
      category: 'CREDENTIAL_FIELD',
      certainty: 'suspected',
    });
    expect(detect('sauce', under('snapshot', 'secret'))?.certainty).toBe('suspected');
  });

  it('does not treat length or randomness as evidence on its own', () => {
    // The rule this file is built to avoid. Every one of these is longer and
    // more random-looking than `hunter2`.
    for (const text of [
      'a9c298878e015b0b64a7d040e42229f53069b0e9',
      '550e8400-e29b-41d4-a716-446655440000',
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      'Zm9vYmFyYmF6cXV4Y29ycmdlZ3JhdWx0Z2FycGx5',
    ]) {
      expect(detect(text)).toBeNull();
    }
  });
});

describe('a credential named after who issued it', () => {
  // Real credential variables are almost never bare. They carry the name of
  // the provider in front — `AWS_SECRET_ACCESS_KEY`, not `secret_access_key` —
  // and a vocabulary of exact names recognises the word while missing every
  // use of it. A review found that `AWS_SECRET_ACCESS_KEY=…` was read as
  // ordinary prose, which meant an export carried it out in full.
  const AWS_SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

  it.each([
    ['an assignment on its own', `AWS_SECRET_ACCESS_KEY=${AWS_SECRET}`],
    ['an assignment inside prose', `deploy failed until I set AWS_SECRET_ACCESS_KEY=${AWS_SECRET}`],
    ['an exported shell variable', `export AWS_SECRET_ACCESS_KEY=${AWS_SECRET}`],
    ['lowercase', `aws_secret_access_key=${AWS_SECRET}`],
    ['hyphenated', `aws-secret-access-key=${AWS_SECRET}`],
    ['a colon, as in yaml', `aws_secret_access_key: ${AWS_SECRET}`],
  ])('reads %s as a confirmed credential', (_shape, text) => {
    expect(detect(text)).toEqual({ category: 'CREDENTIAL_ASSIGNMENT', certainty: 'confirmed' });
  });

  it.each([
    ['AWS_SECRET_ACCESS_KEY'],
    ['aws_secret_access_key'],
    ['MY_SECRET_KEY'],
    ['hmac_secret_key'],
    ['AWS_SECURITY_TOKEN'],
    ['provider_security_token'],
  ])('reads a value under %s as a confirmed credential', (field) => {
    expect(detect(AWS_SECRET, under('snapshot', field))).toEqual({
      category: 'CREDENTIAL_FIELD',
      certainty: 'confirmed',
    });
  });

  it('does not read a name written with spaces as an assignment', () => {
    // Not part of this correction, and worth being explicit about rather than
    // leaving as an apparent oversight. The assignment parser takes an
    // identifier — letters, digits, underscore, dot, hyphen — because a rule
    // that accepted spaces around `=` would read "the access key = whatever we
    // agreed" out of ordinary prose. `AWS SECRET ACCESS KEY = …` is therefore
    // not an assignment here, and the structured-field rule is what covers the
    // same credential when it sits under a name.
    expect(detect(`AWS SECRET ACCESS KEY = ${AWS_SECRET}`)).toBeNull();
  });

  it('refuses the name itself when it is written as a key', () => {
    // A caller can put anything in a key, including the credential. The name
    // is not the secret, so this is about the value under it — but the key
    // path is inspected too, and the field rule is what sees it.
    expect(detect(AWS_SECRET, under('snapshot', 'AWS_SECRET_ACCESS_KEY'))).not.toBeNull();
  });

  it.each([['REDACTED'], ['[REDACTED]'], ['rotated'], ['expired'], ['unknown']])(
    'still reads AWS_SECRET_ACCESS_KEY=%s as not holding one',
    (value) => {
      // A stronger name does not change what the content rules say. Someone who
      // already removed the value, or who is describing the state of a
      // credential rather than holding one, is recording something worth
      // keeping.
      expect(detect(`AWS_SECRET_ACCESS_KEY=${value}`)).toBeNull();
    },
  );

  it('leaves the public half of an AWS pair alone', () => {
    // An access key id is the identifier, not the secret — AWS publishes it in
    // its own examples. Treating it as a credential would refuse a perfectly
    // ordinary note about which account something ran under.
    expect(detect('AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE')).toBeNull();
    expect(detect('AKIAIOSFODNN7EXAMPLE', under('snapshot', 'AWS_ACCESS_KEY_ID'))).toBeNull();
  });

  it.each([
    ['menuAccessKey', 'S'],
    ['buttonAccessKey', 'Enter'],
    ['element_access_key', 'x'],
    ['OLDPWD', '/home/someone/work'],
    ['keyboardShortcut', 'ctrl+k'],
  ])('does not turn ordinary %s into a credential', (field, value) => {
    // The reason `accesskey` was not made a suffix. HTML gives every element
    // an `accessKey`, menus and shortcuts use the word the same way, and
    // `OLDPWD` is a directory. A rule that caught the AWS variable by
    // suffixing `accesskey` or `pwd` would refuse all of these.
    expect(detect(value, under('snapshot', field))).toBeNull();
  });

  it('does not widen what a bare ambiguous name means', () => {
    // `secret` on its own still gets a say from the value, because a field
    // called `secret` may hold a boolean. Only the compounds moved.
    expect(detect('true', under('snapshot', 'secret'))).toBeNull();
    expect(detect('false', under('snapshot', 'isSecret'))).toBeNull();
    expect(detect('300', under('snapshot', 'sessionLength'))).toBeNull();
  });
});

describe('the strongest evidence wins, whatever order the parsers run in', () => {
  // The regression from the third review. A value like `token=morning` under
  // `api_key` contains a suspected-looking inline assignment, and an earlier
  // version returned that suspicion immediately — never consulting the
  // structure, which says `api_key` and confirms it. The certainty is the
  // strongest evidence available for the string at its site, not whichever
  // parser happened to answer first.
  it.each([
    ['api_key', 'token=morning'],
    ['password', 'session=morning'],
    ['client_secret', 'token=letmein'],
    ['access_token', 'session=whatever'],
    ['db_password', 'token=opensesame'],
  ])('confirms %s even when the value looks like a suspected assignment', (key, value) => {
    expect(detect(value, under('snapshot', key))).toEqual({
      category: 'CREDENTIAL_FIELD',
      certainty: 'confirmed',
    });
  });

  it('still reports a confirmed inline assignment as an assignment', () => {
    // Both signals are confirmed; the content rule keeps its more specific
    // category. What must never happen is a downgrade.
    expect(detect('API_KEY=abc123def', under('snapshot', 'api_key'))).toEqual({
      category: 'CREDENTIAL_ASSIGNMENT',
      certainty: 'confirmed',
    });
  });

  it('still says suspected when suspicion really is the strongest evidence', () => {
    // No structure to consult, or structure that says nothing stronger.
    expect(detect('token=morning')).toEqual({
      category: 'CREDENTIAL_ASSIGNMENT',
      certainty: 'suspected',
    });
    expect(detect('token=morning', under('snapshot', 'note'))).toEqual({
      category: 'CREDENTIAL_ASSIGNMENT',
      certainty: 'suspected',
    });
  });

  it('keeps a placeholder or status word under a strong name, unchanged', () => {
    // The priority fix must not widen detection: nothing-to-protect is still
    // nothing-to-protect.
    expect(detect('[REDACTED]', under('snapshot', 'api_key'))).toBeNull();
    expect(detect('rotated', under('snapshot', 'password'))).toBeNull();
  });
});

describe('a weak-looking credential is still a credential', () => {
  // The correction from the second review. An earlier version required a
  // digit or punctuation before believing an explicit `PASSWORD=`, which meant
  // the weakest real passwords were exactly the ones it stored. People choose
  // credentials that read like words; that is a fact about people, not
  // evidence about the string.
  it.each([
    ['PASSWORD=letmein'],
    ['PASSWORD=hunter2'],
    ['password: letmein'],
    ['API_KEY=abcdef'],
    ['api_key=abcdef'],
    ['CLIENT_SECRET=supersecret'],
    ['client_secret=supersecret'],
    ['access_token=letmein'],
    ['refresh_token=opensesame'],
    ['auth_token=letmein'],
    ['session_token=letmein'],
    ['db_password=letmein'],
  ])('recognises %s despite the value reading like a word', (text) => {
    expect(detect(text)).toEqual({
      category: 'CREDENTIAL_ASSIGNMENT',
      certainty: 'confirmed',
    });
  });

  it.each([
    ['password', 'letmein'],
    ['api_key', 'abcdef'],
    ['client_secret', 'supersecret'],
    ['access_token', 'letmein'],
    ['private_key', 'notreallyakey'],
    ['db_password', 'letmein'],
  ])('recognises a word under the strong name %s', (key, value) => {
    expect(detect(value, under('snapshot', key))).toEqual({
      category: 'CREDENTIAL_FIELD',
      certainty: 'confirmed',
    });
  });

  it('recognises a passphrase containing spaces', () => {
    // A password is allowed to have spaces in it, and the ones that do are
    // the ones least likely to look like credentials.
    expect(detect('PASSWORD="correct horse battery staple"')?.certainty).toBe('confirmed');
    expect(detect("password='correct horse battery staple'")?.certainty).toBe('confirmed');
    expect(detect('correct horse battery staple', under('snapshot', 'password'))).toEqual({
      category: 'CREDENTIAL_FIELD',
      certainty: 'confirmed',
    });
  });

  it('still keeps an explicit placeholder under a strong name', () => {
    // The strong name does not override the one signal that says there is
    // nothing here to protect.
    for (const placeholder of ['[REDACTED]', '***', '<secret>', 'CHANGE_ME', 'REPLACE_WITH_KEY']) {
      expect(detect(`PASSWORD=${placeholder}`), placeholder).toBeNull();
      expect(detect(placeholder, under('snapshot', 'password')), placeholder).toBeNull();
    }
  });

  it('does not let value shape decide anything under a strong name', () => {
    // Same value, two names. Under `password` it is a credential; under an
    // unrelated name it is a word. The name is doing all the work.
    expect(detect('letmein', under('snapshot', 'password'))?.certainty).toBe('confirmed');
    expect(detect('letmein', under('snapshot', 'note'))).toBeNull();
  });
});

describe('an authorization header is parsed, not pattern-matched', () => {
  it.each([
    ['a header with no scheme at all', 'Authorization: disabled'],
    ['a header with a scheme and nothing else', 'Authorization: Bearer'],
    ['a header with a scheme and trailing space', 'Authorization: Bearer   '],
    ['a header carrying an already-redacted credential', 'Authorization: Bearer [REDACTED]'],
    ['a header carrying a placeholder', 'Authorization: Bearer <token>'],
    ['a header carrying asterisks', 'Authorization: Basic ***'],
    ['a sentence about basic authentication', 'Use Basic authentication for this endpoint.'],
    ['a sentence about bearer authentication', 'Bearer authentication'],
    ['a sentence naming the scheme', 'The endpoint expects Bearer tokens.'],
  ])('keeps %s', (_label, text) => {
    // "The line exists" is not the same claim as "a credential is present",
    // and an earlier version confirmed every one of these — which is how a
    // detector teaches people to ignore it.
    expect(detect(text)).toBeNull();
  });

  it.each([
    ['Authorization: Bearer abcdef0123456789abcdef'],
    ['Authorization: Basic dXNlcjpwYXNzd29yZA=='],
    ['authorization: bearer abcdef0123456789abcdef'],
    ['Bearer sk-fake-0123456789abcdefghij'],
  ])('still recognises %s', (text) => {
    expect(detect(text)).toEqual({ category: 'AUTHORIZATION', certainty: 'confirmed' });
  });

  it('trusts an explicit header more than a bare scheme', () => {
    // With `Authorization:` present the context is explicit, so a word-shaped
    // credential is still a credential. Bare, `Bearer` is an English word and
    // the token has to look like one.
    expect(detect('Authorization: Bearer letmein')?.category).toBe('AUTHORIZATION');
    expect(detect('Bearer letmein')).toBeNull();
  });
});

describe('a cookie header is parsed the same way', () => {
  it.each([
    ['an already-redacted cookie', 'Cookie: sid=[REDACTED]'],
    ['a placeholder cookie', 'Set-Cookie: session=<token>; HttpOnly'],
    ['an asterisked cookie', 'Cookie: sid=***'],
    ['a cookie header with no pair', 'Cookie: disabled'],
    ['prose about cookies', 'The cookie was missing because the domain did not match.'],
  ])('keeps %s', (_label, text) => {
    // Placeholder treatment is the same here as in an assignment or a field,
    // so a caller does not have to learn which rule saw their string.
    expect(detect(text)).toBeNull();
  });

  it.each([
    ['Cookie: sid=fake-8a7b6c5d4e3f2a1b; theme=dark'],
    ['Set-Cookie: session=fake-8a7b6c5d4e; HttpOnly'],
  ])('still recognises %s', (text) => {
    expect(detect(text)).toEqual({ category: 'COOKIE', certainty: 'confirmed' });
  });
});

describe('a finding says nothing about what it found', () => {
  const secret = 'sk-fake-0123456789abcdefghijklmnop';

  it('carries a category and a certainty and nothing else', () => {
    const finding = detect(`API_KEY=${secret}`);

    expect(finding).not.toBeNull();
    expect(Object.keys(finding ?? {}).sort()).toEqual(['category', 'certainty']);
  });

  it.each([
    ['a value', `API_KEY=${secret}`, BARE],
    ['a JWT', JWT, BARE],
    ['a private key', `-----BEGIN PRIVATE KEY-----\n${secret}\n-----END PRIVATE KEY-----`, BARE],
    ['a field value', secret, under('snapshot', 'api_key')],
    ['a key', `Bearer ${secret}`, AS_KEY],
  ])('leaves no trace of %s in the finding', (_label, text, at) => {
    const finding = detector.detect(text, at);

    // Serialised, spread, or read property by property: two short identifiers.
    expect(JSON.stringify(finding)).not.toContain(secret);
    expect(JSON.stringify({ ...finding })).not.toContain(secret);
    expect(Object.values(finding ?? {}).join(' ')).not.toContain(secret);
    expect(JSON.stringify(finding).length).toBeLessThan(80);
  });

  it('reports only categories and certainties this module names', () => {
    const finding = detect(`API_KEY=${secret}`);

    expect(SECRET_CATEGORIES).toContain(finding?.category);
    expect(SECRET_CERTAINTIES).toContain(finding?.certainty);
    // Closed sets, so nothing can arrive that a later phase has not seen.
    expect(SECRET_CATEGORIES).toHaveLength(6);
    expect(SECRET_CERTAINTIES).toEqual(['confirmed', 'suspected']);
  });
});

describe('the detector is a function of its input', () => {
  it('answers the same way every time', () => {
    const text = 'API_KEY=fake-9f2c4d8a1b6e3057';

    // No clock, no counter, no state carried between calls — which is what
    // makes a refusal explicable and this suite meaningful.
    expect([detect(text), detect(text), detect(text)]).toEqual([
      { category: 'CREDENTIAL_ASSIGNMENT', certainty: 'confirmed' },
      { category: 'CREDENTIAL_ASSIGNMENT', certainty: 'confirmed' },
      { category: 'CREDENTIAL_ASSIGNMENT', certainty: 'confirmed' },
    ]);
  });

  it('does not depend on which detector instance is asked', () => {
    const text = 'Authorization: Bearer abcdef0123456789abcdef';

    expect(createSecretDetector().detect(text, BARE)).toEqual(
      createSecretDetector().detect(text, BARE),
    );
  });
});
