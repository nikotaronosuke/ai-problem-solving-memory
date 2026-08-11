/**
 * Environment loading for the Memory service.
 *
 * This is deliberately plain, deterministic code: reading and validating
 * configuration must never depend on model inference.
 *
 * Only values the current code actually uses are read here. Connection
 * settings for PostgreSQL / Supabase arrive with P1-03.
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
