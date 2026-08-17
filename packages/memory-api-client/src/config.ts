/**
 * Deciding whether a client can be built at all, before anything is sent.
 *
 * Both checks here are about the same thing: a request must go where the
 * caller meant, carrying a credential the caller meant to present. A base URL
 * that silently means something else, or a credential that is a leftover empty
 * string, both end with a request somewhere unintended — and the second one
 * ends with an `Authorization: Bearer ` header that a server has to decide
 * about, which is a decision no client should force on it.
 *
 * Everything is refused at construction rather than at the first call. A
 * misconfiguration is a fact about the process, not about one request, and
 * finding out at startup is the difference between a message and an outage.
 */

/**
 * Where a Memory Server listens when nobody says otherwise.
 *
 * Loopback, and only loopback. The Memory is one person's, the MVP runs it on
 * the same machine, and a default that reached a network address would be a
 * default that occasionally sends somebody's problem descriptions somewhere
 * they did not choose. Anything else has to be said out loud.
 */
export const DEFAULT_MEMORY_API_BASE_URL = 'http://127.0.0.1:3000';

/**
 * Why a client could not be built.
 *
 * A closed set, because the alternative is a message built from the value that
 * was rejected — and the values being rejected here are a URL that may carry a
 * password and a credential that is a credential.
 */
export const MEMORY_API_CONFIGURATION_FAILURES = [
  /** Not a URL at all, or not absolute. */
  'BASE_URL_UNPARSEABLE',
  /** Parsed, but not `http:` or `https:`. */
  'BASE_URL_SCHEME_UNSUPPORTED',
  /** Carries a username or password in the URL itself. */
  'BASE_URL_HAS_CREDENTIALS',
  /** Carries a query string, which a base URL has no use for. */
  'BASE_URL_HAS_QUERY',
  /** Carries a fragment, which never reaches a server. */
  'BASE_URL_HAS_FRAGMENT',
  /** Absent, empty, or nothing but whitespace. */
  'CREDENTIAL_BLANK',
] as const;

export type MemoryApiConfigurationFailure = (typeof MEMORY_API_CONFIGURATION_FAILURES)[number];

/** Raised when a client cannot be built from what it was given. */
export class MemoryApiConfigurationError extends Error {
  readonly failure: MemoryApiConfigurationFailure;

  constructor(failure: MemoryApiConfigurationFailure) {
    super(`The Memory API client could not be configured: ${failure}.`);
    this.name = 'MemoryApiConfigurationError';
    this.failure = failure;
  }
}

/**
 * Turns a base URL into the exact prefix every path is appended to.
 *
 * The result never ends in `/`, so joining is one rule — `${base}${path}`
 * where every path starts with `/` — rather than two spellings that produce
 * `//v1/...` half the time.
 *
 * Credentials in the URL are refused rather than stripped. `http://user:pw@host`
 * is a request to authenticate a particular way, and quietly dropping half of
 * it would send the request anyway, unauthenticated in the way the caller
 * asked for and authenticated in a way they did not mention. This client
 * presents exactly one credential and it arrives through the factory.
 *
 * A query or fragment is refused for a plainer reason: neither survives being
 * concatenated with a path. `http://host/?x=1` + `/v1/problems/…` is not a URL
 * anybody meant to write.
 */
export function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // The value is not in the message, here or anywhere below. A base URL is
    // the one configuration value most likely to have a secret pasted into it.
    throw new MemoryApiConfigurationError('BASE_URL_UNPARSEABLE');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new MemoryApiConfigurationError('BASE_URL_SCHEME_UNSUPPORTED');
  }
  if (url.username !== '' || url.password !== '') {
    throw new MemoryApiConfigurationError('BASE_URL_HAS_CREDENTIALS');
  }
  if (url.search !== '') {
    throw new MemoryApiConfigurationError('BASE_URL_HAS_QUERY');
  }
  if (url.hash !== '') {
    throw new MemoryApiConfigurationError('BASE_URL_HAS_FRAGMENT');
  }

  // `URL` normalises `http://host` to a pathname of `/`, so a trailing slash
  // is always present to remove and the two spellings collapse to one.
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

/**
 * Checks that a credential is something rather than nothing.
 *
 * Length and shape are not checked, and that is deliberate: what a Memory
 * credential looks like is the server's rule, it has changed once already, and
 * a client enforcing a copy of it would start refusing valid credentials the
 * day the format grows. Presenting one and being told no is the correct way to
 * find out — `UNAUTHENTICATED` is a real answer.
 *
 * Blank is different. A blank credential is not a credential the server can
 * refuse meaningfully; it is a configuration mistake wearing an authentication
 * failure's clothes, and it is the exact shape an unset environment variable
 * arrives in.
 */
export function requireCredential(value: string | undefined): string {
  if (value === undefined || value.trim() === '') {
    throw new MemoryApiConfigurationError('CREDENTIAL_BLANK');
  }
  return value;
}
