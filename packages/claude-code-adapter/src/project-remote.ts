/**
 * Turning a git remote URL into something safe to compare and safe to keep.
 *
 * ## Why a raw remote may not leave this file
 *
 * A remote URL is allowed to carry a credential, and in practice it does:
 * `https://x-access-token:TOKEN@github.com/org/repo.git` is what several CI
 * systems write into a checkout, and `git remote get-url` hands it back
 * verbatim. Anything downstream of this file — a comparison, a suggestion, a
 * candidate shown to somebody, a Memory record, a log line, an error — is a
 * place that value must never reach.
 *
 * So the credential is not redacted, filtered or masked later: it is dropped
 * here, as part of the only conversion this module performs, and the raw string
 * has no path out. Everything above deals in canonical forms, which cannot
 * carry one because the userinfo component is not part of a canonical form.
 *
 * ## What a canonical form is
 *
 * `host/path`, plus a port when it is not the scheme's default:
 *
 * | remote | canonical |
 * | --- | --- |
 * | `https://github.com/acme/widget.git` | `github.com/acme/widget` |
 * | `git@github.com:acme/widget.git` | `github.com/acme/widget` |
 * | `ssh://git@github.com/acme/widget` | `github.com/acme/widget` |
 * | `https://user:token@github.com/acme/widget.git` | `github.com/acme/widget` |
 * | `ssh://git@git.example.com:2222/acme/widget.git` | `git.example.com:2222/acme/widget` |
 *
 * The parts that are dropped are the parts that vary without the repository
 * varying: the scheme, the userinfo, a default port, a trailing `.git`, a
 * trailing slash, a query and a fragment. What is kept is what identifies the
 * repository to the host that serves it.
 *
 * ## The host is folded and the path is not
 *
 * Hostnames are case-insensitive by specification, so `GitHub.com` and
 * `github.com` are one host and the canonical form lowercases them.
 *
 * Paths are left exactly as they came. Some hosts treat `Acme/Widget` and
 * `acme/widget` as the same repository and some do not, and this module cannot
 * tell which it is talking to. Folding the case would merge two repositories
 * that a case-sensitive host keeps apart, and the cost of *not* folding it is
 * that one repository written two ways compares unequal — which surfaces as a
 * question rather than as a wrong answer. That is the same trade the project
 * already made for technology labels: a missed match costs a comparison, an
 * invented one asserts something nobody claimed.
 *
 * ## Canonicalising is idempotent
 *
 * A canonical form put back through this function comes out unchanged. That is
 * not tidiness: a Project's stored `repo` *is* a canonical form when this design
 * created it, and every later session compares that stored value against a
 * freshly read remote by canonicalising both. Without idempotency the comparison
 * fails for exactly the Projects this design is meant to recognise.
 *
 * ## What is not a canonical form
 *
 * A remote this module cannot read is not guessed at. A local path or `file://`
 * remote, a remote with no host, an unparseable string: each returns
 * `undefined`, which the caller treats as "this remote is not usable as an
 * identity" rather than as an error. A repository is allowed to have remotes
 * that identify nothing.
 */

/** Ports that are implied by their scheme and therefore carry no information. */
const DEFAULT_PORTS = new Map<string, string>([
  ['http:', '80'],
  ['https:', '443'],
  ['ssh:', '22'],
  ['git+ssh:', '22'],
  ['git:', '9418'],
]);

/** The schemes a remote can use to name something on another host. */
const REMOTE_SCHEMES = new Set(DEFAULT_PORTS.keys());

/**
 * A dotted name: labels of letters, digits and hyphens, not starting or ending
 * with one, joined by dots. Matches `github.com` and `1.2.3.4`; does not match
 * `.`, `-`, `C` or the `.` of `./vendor`.
 */
const DOTTED_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * Whether a string is plausibly a hostname rather than something else.
 *
 * This is what keeps the other two forms from swallowing a local path.
 * `C:\dev\repo` splits at its colon exactly like `git@host:path` does, and
 * `./vendor/widget` splits at its slash exactly like `host/path` does — either
 * one read as a repository identity would make two machines with the same
 * directory layout look like the same repository.
 *
 * Requiring a dotted name or `localhost` is crude and it is enough. Anything it
 * rejects becomes "not usable as an identity", which is the safe direction: a
 * repository with no comparable identity produces a question, and a wrong
 * identity produces a wrong answer nobody sees.
 */
function isPlausibleHost(host: string): boolean {
  return host === 'localhost' || DOTTED_HOST.test(host);
}

/**
 * Normalises the path part: no leading or trailing slash, no trailing `.git`.
 *
 * Only the exact lowercase `.git` suffix is removed. A directory genuinely
 * named `.GIT` is vanishingly unlikely and stripping it would be this module
 * guessing about a filesystem it cannot see, so the narrow rule is the one that
 * cannot be wrong in the expensive direction.
 */
function normalisePath(rawPath: string): string | undefined {
  let path = rawPath;
  while (path.startsWith('/')) {
    path = path.slice(1);
  }
  while (path.endsWith('/')) {
    path = path.slice(0, -1);
  }
  if (path.endsWith('.git')) {
    path = path.slice(0, -'.git'.length);
  }
  // A remote naming a host and no repository identifies a server, not a
  // repository, and comparing two of those would merge every repository on it.
  return path === '' ? undefined : path;
}

function withPort(host: string, port: string, scheme: string): string {
  if (port === '' || DEFAULT_PORTS.get(scheme) === port) {
    return host;
  }
  return `${host}:${port}`;
}

/**
 * Reads a remote written with a scheme.
 *
 * `URL` does the parsing, which is deliberate: it already lowercases the host,
 * separates userinfo, handles IPv6 literals and leaves percent-encoding alone.
 * Percent-encoded paths are kept encoded — decoding them would create two
 * spellings that compare equal, and this module's whole job is to make equality
 * mean something.
 */
function canonicaliseWithScheme(remote: string): string | undefined {
  let url: URL;
  try {
    url = new URL(remote);
  } catch {
    return undefined;
  }

  if (!REMOTE_SCHEMES.has(url.protocol)) {
    // `file:`, a Windows drive letter parsed as a scheme, or anything else that
    // does not name a host somewhere else.
    return undefined;
  }

  // `URL` already folds a hostname's case, so this fold changes nothing today.
  // It is kept because the property is the contract rather than an implementation
  // detail of the parser, and because the bare-form reader below has to do its
  // own folding — leaving one of the two branches relying on somebody else's
  // normalisation is how the two branches start disagreeing.
  const host = url.hostname.toLowerCase();
  if (!isPlausibleHost(host)) {
    return undefined;
  }

  const path = normalisePath(url.pathname);
  if (path === undefined) {
    return undefined;
  }

  // `url.username` and `url.password` are read by nothing and travel nowhere.
  // The query and the fragment are dropped for the same reason a scheme is:
  // they vary without the repository varying.
  return `${withPort(host, url.port, url.protocol)}/${path}`;
}

/**
 * Reads the bare form this module itself produces: `host[:port]/path`.
 *
 * ## Why this form is read at all
 *
 * Because canonicalising has to be idempotent, and the round trip that makes it
 * matter is the one this whole module exists for: a Project is suggested with a
 * canonical `repo`, somebody stores it, and the next session canonicalises the
 * stored value to compare it against a freshly read remote. Without this branch
 * that comparison fails for every Project created the way this design creates
 * them — the feature would work exactly once per repository. A test caught that,
 * which is the only reason this branch exists rather than being discovered later.
 *
 * ## The one ambiguity, and which way it is resolved
 *
 * `host:2222/a/b` is both this form with a port and the scp-like form with a
 * path beginning `2222`. This branch runs first, so it is read as a port.
 *
 * That costs almost nothing and buys the round trip. The scp-like form is
 * written with a user in practice — `git@host:path` — and a user makes the
 * authority contain `@`, which this branch refuses, sending it to the scp-like
 * branch where it belongs. What is left is a remote written as `host:digits/…`
 * with no user at all, which git would not read as a port either. A known and
 * deliberate limit.
 */
function canonicaliseBareHostPath(remote: string): string | undefined {
  const slash = remote.indexOf('/');
  if (slash <= 0) {
    return undefined;
  }

  const authority = remote.slice(0, slash);
  // A user means this is the scp-like form, whatever else it looks like.
  if (authority.includes('@')) {
    return undefined;
  }

  const colon = authority.indexOf(':');
  const host = (colon === -1 ? authority : authority.slice(0, colon)).toLowerCase();
  const port = colon === -1 ? '' : authority.slice(colon + 1);

  if (!isPlausibleHost(host) || (colon !== -1 && !/^\d+$/.test(port))) {
    return undefined;
  }

  const path = normalisePath(remote.slice(slash));
  if (path === undefined) {
    return undefined;
  }

  // No scheme, so there is no default port to compare against: a port written
  // in this form was written deliberately and is kept.
  return `${port === '' ? host : `${host}:${port}`}/${path}`;
}

/**
 * Reads the scp-like form: `[user@]host:path`.
 *
 * Note what git itself does with a port here: it does not support one. In
 * `host:2222/acme/widget` the `2222/acme/widget` *is* the path, and a caller
 * who meant a port has to write `ssh://`. This follows git rather than
 * correcting it — a canonical form that disagreed with what git would clone is
 * a canonical form describing a repository nobody has.
 */
function canonicaliseScpLike(remote: string): string | undefined {
  const colon = remote.indexOf(':');
  if (colon === -1) {
    return undefined;
  }

  const authority = remote.slice(0, colon);
  const rawPath = remote.slice(colon + 1);

  // The scp-like form has no slash before its colon. `./a:b` and `/tmp/a:b` are
  // paths, not remotes.
  if (authority.includes('/') || authority.includes('\\')) {
    return undefined;
  }

  const at = authority.lastIndexOf('@');
  const host = (at === -1 ? authority : authority.slice(at + 1)).toLowerCase();
  if (!isPlausibleHost(host)) {
    return undefined;
  }

  const path = normalisePath(rawPath);
  if (path === undefined) {
    return undefined;
  }

  return `${host}/${path}`;
}

/**
 * The canonical identity of a git remote, or `undefined` if it has none.
 *
 * Total: every input returns a canonical form or `undefined`, and none throws.
 * A remote that cannot be read is a fact about that remote, not a failure of
 * the caller — and an exception here would be an exception carrying a raw
 * remote URL, which is the one thing this module exists to prevent.
 */
export function canonicaliseGitRemote(remote: string): string | undefined {
  const trimmed = remote.trim();
  if (trimmed === '') {
    return undefined;
  }

  if (trimmed.includes('://')) {
    return canonicaliseWithScheme(trimmed);
  }

  // Order matters, and the bare-form reader explains why: a canonical form has
  // to survive being canonicalised again, and the two forms overlap in exactly
  // one unlikely spelling.
  return canonicaliseBareHostPath(trimmed) ?? canonicaliseScpLike(trimmed);
}
