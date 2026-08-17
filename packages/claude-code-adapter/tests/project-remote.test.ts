/**
 * What a remote URL becomes, and what it must never still be.
 *
 * The load-bearing tests here are the ones about a credential. A remote URL is
 * allowed to carry one, and `git remote get-url` returns it verbatim, so the
 * canonical form is the boundary that value dies at. Those assertions compare
 * **booleans**, not strings: a failing equality assertion prints both sides, and
 * one of the sides would be the credential.
 *
 * Every credential-shaped value in this file is synthetic.
 */

import { describe, expect, it } from 'vitest';

import { canonicaliseGitRemote } from '../src/index.js';

/** Synthetic. Distinctive enough that finding it anywhere proves a copy. */
const FAKE_TOKEN = 'ghp-fake-token-marker-Zx9Q7Ck2V';
const FAKE_USER = 'fake-user-marker-Kf2W';

describe('one repository, written many ways', () => {
  it.each([
    ['https', 'https://github.com/acme/widget.git'],
    ['https without .git', 'https://github.com/acme/widget'],
    ['https with a trailing slash', 'https://github.com/acme/widget/'],
    ['http', 'http://github.com/acme/widget.git'],
    ['scp-like', 'git@github.com:acme/widget.git'],
    ['scp-like without .git', 'git@github.com:acme/widget'],
    ['scp-like with a leading slash', 'git@github.com:/acme/widget.git'],
    ['ssh scheme', 'ssh://git@github.com/acme/widget.git'],
    ['git+ssh scheme', 'git+ssh://git@github.com/acme/widget.git'],
    ['git protocol', 'git://github.com/acme/widget.git'],
    ['an uppercase host', 'https://GitHub.com/acme/widget.git'],
    ['an explicit default port', 'https://github.com:443/acme/widget.git'],
    // These two matter more than the https one: `URL` strips a default port for
    // http and https itself, and keeps it for ssh and git. So dropping the
    // default-port rule would change nothing for https and would silently make
    // `ssh://host:22/x` a different repository from `ssh://host/x`.
    ['an explicit default ssh port', 'ssh://git@github.com:22/acme/widget.git'],
    ['an explicit default git port', 'git://github.com:9418/acme/widget.git'],
    ['a query nobody asked for', 'https://github.com/acme/widget.git?ref=main'],
    ['a fragment', 'https://github.com/acme/widget.git#readme'],
    ['surrounding whitespace', '  https://github.com/acme/widget.git\n'],
  ])('reads %s as the same repository', (_case, remote) => {
    expect(canonicaliseGitRemote(remote)).toBe('github.com/acme/widget');
  });

  it('keeps a port that is not the scheme’s default', () => {
    // A different port is a different server until proven otherwise.
    expect(canonicaliseGitRemote('ssh://git@git.example.com:2222/acme/widget.git')).toBe(
      'git.example.com:2222/acme/widget',
    );
  });

  it('follows git rather than correcting it on the scp-like form', () => {
    // git has no port in the scp-like form: everything after the colon is the
    // path. A canonical form that invented a port here would describe a
    // repository nobody can clone.
    expect(canonicaliseGitRemote('git@git.example.com:2222/acme/widget.git')).toBe(
      'git.example.com/2222/acme/widget',
    );
  });

  it('keeps a deep path intact', () => {
    expect(canonicaliseGitRemote('https://git.example.com/group/sub/team/widget.git')).toBe(
      'git.example.com/group/sub/team/widget',
    );
  });
});

describe('a credential in a remote', () => {
  it.each([
    ['a user and a password', `https://${FAKE_USER}:${FAKE_TOKEN}@github.com/acme/widget.git`],
    ['a token as the whole userinfo', `https://${FAKE_TOKEN}@github.com/acme/widget.git`],
    ['an x-access-token pair', `https://x-access-token:${FAKE_TOKEN}@github.com/acme/widget.git`],
    ['userinfo over ssh', `ssh://${FAKE_USER}:${FAKE_TOKEN}@github.com/acme/widget.git`],
    ['a token-shaped scp user', `${FAKE_TOKEN}@github.com:acme/widget.git`],
  ])('is not in the canonical form for %s', (_case, remote) => {
    const canonical = canonicaliseGitRemote(remote);

    // Booleans, so a failure does not print what it found.
    expect(`token leaked:${String(canonical ?? '').includes(FAKE_TOKEN)}`).toBe(
      'token leaked:false',
    );
    expect(`user leaked:${String(canonical ?? '').includes(FAKE_USER)}`).toBe('user leaked:false');
    // And the repository is still identified, which is the point of dropping the
    // credential rather than rejecting the remote.
    expect(canonical).toBe('github.com/acme/widget');
  });

  it('makes an authenticated remote equal to its clean twin', () => {
    // The case this exists for: a CI checkout and a developer's checkout are the
    // same repository, and only one of them has a token in its remote.
    expect(
      canonicaliseGitRemote(`https://x-access-token:${FAKE_TOKEN}@github.com/acme/widget`),
    ).toBe(canonicaliseGitRemote('git@github.com:acme/widget.git'));
  });

  it('never throws, whatever it is handed', () => {
    // An exception would be an exception carrying a raw remote URL, which is the
    // one thing this module exists to prevent.
    for (const remote of [
      `https://:${FAKE_TOKEN}@`,
      `https://${FAKE_TOKEN}@`,
      '://',
      'https://',
      '@',
      ':',
      '\u0000',
    ]) {
      expect(() => canonicaliseGitRemote(remote)).not.toThrow();
      expect(`leaked:${String(canonicaliseGitRemote(remote) ?? '').includes(FAKE_TOKEN)}`).toBe(
        'leaked:false',
      );
    }
  });
});

describe('the host is folded and the path is not', () => {
  it('treats hosts differing only in case as one host', () => {
    expect(canonicaliseGitRemote('https://GITHUB.COM/acme/widget')).toBe(
      canonicaliseGitRemote('https://github.com/acme/widget'),
    );
  });

  it('keeps the path exactly as written', () => {
    // Some hosts are case-sensitive about paths and this module cannot tell
    // which one it is talking to. Folding would merge two repositories that a
    // case-sensitive host keeps apart; not folding costs a comparison, which
    // surfaces as a question rather than as a wrong answer.
    expect(canonicaliseGitRemote('https://github.com/Acme/Widget')).toBe('github.com/Acme/Widget');
    expect(canonicaliseGitRemote('https://github.com/Acme/Widget')).not.toBe(
      canonicaliseGitRemote('https://github.com/acme/widget'),
    );
  });

  it('leaves percent-encoding alone', () => {
    // Decoding would make two spellings compare equal, and equality meaning
    // something is this module's whole job.
    expect(canonicaliseGitRemote('https://github.com/acme/my%20repo')).toBe(
      'github.com/acme/my%20repo',
    );
  });

  it('strips only an exact .git suffix', () => {
    expect(canonicaliseGitRemote('https://github.com/acme/widget.GIT')).toBe(
      'github.com/acme/widget.GIT',
    );
    expect(canonicaliseGitRemote('https://github.com/acme/gitwidget')).toBe(
      'github.com/acme/gitwidget',
    );
  });
});

describe('a canonical form put back through', () => {
  it.each([
    ['github.com/acme/widget'],
    ['github.com/Acme/Widget'],
    ['git.example.com/group/sub/team/widget'],
    ['git.example.com:2222/acme/widget'],
    ['localhost/acme/widget'],
    ['1.2.3.4/acme/widget'],
    ['github.com/acme/my%20repo'],
  ])('comes out unchanged for %s', (canonical) => {
    // This is the round trip the whole design rests on: a Project is suggested
    // with a canonical `repo`, somebody stores it, and the next session compares
    // the stored value against a freshly read remote by canonicalising both. A
    // form that did not survive that would make the feature work exactly once
    // per repository — and a test is what found it.
    expect(canonicaliseGitRemote(canonical)).toBe(canonical);
  });

  it('folds a bare host that was written in the wrong case', () => {
    expect(canonicaliseGitRemote('GitHub.com/acme/widget')).toBe('github.com/acme/widget');
  });

  it('reads a bare form the same as the URL it came from', () => {
    expect(canonicaliseGitRemote('github.com/acme/widget')).toBe(
      canonicaliseGitRemote('https://github.com/acme/widget.git'),
    );
  });

  it('still reads a user-bearing scp form as scp rather than as a port', () => {
    // The one overlap between the two formats, resolved towards the round trip.
    // A user is what says "this is scp-like", and git writes one in practice.
    expect(canonicaliseGitRemote('git@git.example.com:2222/acme/widget.git')).toBe(
      'git.example.com/2222/acme/widget',
    );
  });
});

describe('remotes that identify nothing', () => {
  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['a bare word', 'widget'],
    ['a relative path', './vendor/widget'],
    ['a parent-relative path', '../sibling/widget'],
    ['a bare host with no path', 'github.com'],
    ['a bare host with an empty path', 'github.com/'],
    ['a hyphen where a host should be', '-/acme/widget'],
    ['a user with no colon', 'git@github.com/acme/widget'],
    ['a POSIX absolute path', '/srv/git/widget.git'],
    ['a file URL', 'file:///srv/git/widget.git'],
    ['a Windows path', 'C:\\dev\\widget'],
    ['a Windows path with forward slashes', 'C:/dev/widget'],
    ['a host with no repository', 'https://github.com/'],
    ['a scp-like form with no path', 'git@github.com:'],
    ['a single-label host', 'https://intranet/acme/widget'],
    ['an unsupported scheme', 'ftp://github.com/acme/widget.git'],
  ])('reports %s as not usable', (_case, remote) => {
    // `undefined` rather than an error: a repository is allowed to have remotes
    // that identify nothing, and a local path remote is a legitimate one.
    expect(canonicaliseGitRemote(remote)).toBeUndefined();
  });

  it('does not mistake a Windows path for a scp-like remote', () => {
    // `C:\dev\repo` splits at its colon exactly like `git@host:path` does. A
    // canonical remote of `c/dev/repo` would present a local directory as a
    // repository identity, and two machines with the same layout would then
    // look like the same repository.
    expect(canonicaliseGitRemote('C:\\Users\\someone\\dev\\widget')).toBeUndefined();
  });
});
