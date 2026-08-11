/**
 * Environment loading for the Memory service.
 *
 * This is deliberately plain, deterministic code: reading and validating
 * configuration must never depend on model inference.
 *
 * `DATABASE_URL` is read separately from `loadEnv`, because it is required only
 * by code that actually opens a database connection. Configuration that does
 * not touch the database must stay usable without it.
 *
 * A connection string carries credentials. Nothing in this module may put its
 * value into an error message, a log line or a test snapshot.
 */

export const NODE_ENVS = ['development', 'test', 'production'] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface AppEnv {
  readonly nodeEnv: NodeEnv;
  readonly logLevel: LogLevel;
}

export type EnvSource = Readonly<Record<string, string | undefined>>;

/** Raised when an environment variable is present but not an allowed value. */
export class EnvValidationError extends Error {
  readonly variable: string;

  constructor(variable: string, value: string, allowed: readonly string[]) {
    super(
      `Invalid value for ${variable}: ${JSON.stringify(value)}. ` +
        `Allowed values: ${allowed.join(', ')}.`,
    );
    this.name = 'EnvValidationError';
    this.variable = variable;
  }
}

function readEnum<T extends string>(
  variable: string,
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  if (raw === undefined) {
    return fallback;
  }

  const value = raw.trim().toLowerCase();
  if (value === '') {
    return fallback;
  }

  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) {
    throw new EnvValidationError(variable, raw, allowed);
  }

  return match;
}

/**
 * Reads the supported environment variables, applying defaults.
 *
 * Absent variables fall back to defaults; present-but-invalid variables fail
 * loudly rather than being silently coerced.
 */
export function loadEnv(source: EnvSource = process.env): AppEnv {
  return {
    nodeEnv: readEnum('NODE_ENV', source['NODE_ENV'], NODE_ENVS, 'development'),
    logLevel: readEnum('LOG_LEVEL', source['LOG_LEVEL'], LOG_LEVELS, 'info'),
  };
}

/** Name of the variable holding the PostgreSQL connection string. */
export const DATABASE_URL_VAR = 'DATABASE_URL';

const POSTGRES_PROTOCOLS = new Set(['postgres:', 'postgresql:']);

/** Raised when a required environment variable is absent. */
export class MissingEnvError extends Error {
  readonly variable: string;

  constructor(variable: string) {
    super(`${variable} is not set. See .env.example.`);
    this.name = 'MissingEnvError';
    this.variable = variable;
  }
}

/**
 * Raised when a connection string is present but unusable.
 *
 * The offending value is never included: it holds credentials.
 */
export class InvalidConnectionStringError extends Error {
  readonly variable: string;

  constructor(variable: string, reason: string) {
    super(`${variable} is not a usable PostgreSQL connection string: ${reason}.`);
    this.name = 'InvalidConnectionStringError';
    this.variable = variable;
  }
}

/**
 * Reads `DATABASE_URL` if it is set, without requiring it.
 *
 * Use this where a missing database is an acceptable state — for example
 * deciding whether an integration test can run.
 */
export function readDatabaseUrl(source: EnvSource = process.env): string | undefined {
  const raw = source[DATABASE_URL_VAR];
  if (raw === undefined) {
    return undefined;
  }

  const value = raw.trim();
  return value === '' ? undefined : value;
}

/**
 * Reads `DATABASE_URL` and validates its shape.
 *
 * Use this at the point a database connection is actually opened. Throws when
 * the variable is absent or malformed; neither error exposes the value.
 */
export function requireDatabaseUrl(source: EnvSource = process.env): string {
  const value = readDatabaseUrl(source);
  if (value === undefined) {
    throw new MissingEnvError(DATABASE_URL_VAR);
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new InvalidConnectionStringError(DATABASE_URL_VAR, 'it is not a valid URL');
  }

  if (!POSTGRES_PROTOCOLS.has(parsed.protocol)) {
    throw new InvalidConnectionStringError(
      DATABASE_URL_VAR,
      'the scheme must be postgres:// or postgresql://',
    );
  }

  if (parsed.hostname === '') {
    throw new InvalidConnectionStringError(DATABASE_URL_VAR, 'it has no host');
  }

  return value;
}
