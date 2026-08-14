/**
 * What the process says when it cannot start (P3-10 §26).
 *
 * This one runs the real entrypoint in a real child process, because the thing
 * being tested is what happens *outside* everything else the logging policy
 * covers. Configuration is read and the pool is opened before a logger exists,
 * so a failure there is not a Pino record at all — it is an uncaught exception,
 * printed by Node with its message and its stack. No serializer sees it and no
 * redaction path applies.
 *
 * That mattered because two of the errors reachable there quote their input.
 * `EnvValidationError` reports the offending value, so a mistyped `LOG_LEVEL`
 * printed it; `UnsafeDatabaseTargetError` reports the database host. Measured
 * before the change, an invalid `LOG_LEVEL` produced:
 *
 *     EnvValidationError: Invalid value for LOG_LEVEL: "<the value>".
 *         at readEnum (…/config/env.js:36:15)
 *         at loadEnv (…/config/env.js:76:19)
 *         …
 *
 * A source-level guard cannot prove this is closed — there is no call to look
 * for, only an absence of a boundary — so it is proved by starting the thing.
 */

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

// From `service.ts`, not from the entrypoint — importing the entrypoint is
// starting the server.
import { STARTUP_FAILURE_MESSAGE } from '../../src/service.js';

const run = promisify(execFile);

const ENTRYPOINT = join(process.cwd(), 'src', 'index.ts');
const TSX = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');

interface Outcome {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Starts the real entrypoint with a broken environment and waits for it to give
 * up.
 *
 * `env` replaces the process environment rather than extending it, so a `.env`
 * loaded into this test run cannot accidentally make the child succeed.
 */
async function startWith(env: Record<string, string>): Promise<Outcome> {
  try {
    const { stdout, stderr } = await run(process.execPath, [TSX, ENTRYPOINT], {
      env: {
        PATH: process.env['PATH'] ?? '',
        SystemRoot: process.env['SystemRoot'] ?? '',
        ...env,
      },
      timeout: 60_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: failure.code ?? null,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

const MARKER = 'p310-startup-secret-marker';

describe('a server that cannot start', () => {
  it('reports that it did not start, and nothing about why', async () => {
    // The value is the thing that used to be printed.
    const outcome = await startWith({
      LOG_LEVEL: MARKER,
      DATABASE_URL: `postgresql://memory:${MARKER}@127.0.0.1:5432/memorydb`,
    });

    const output = `${outcome.stdout}\n${outcome.stderr}`;

    expect(outcome.code).not.toBe(0);
    expect(output).toContain(STARTUP_FAILURE_MESSAGE);

    // Nothing of the value, the variable's contents, or the shape a stack
    // trace has.
    expect(output).not.toContain(MARKER);
    expect(output).not.toContain('EnvValidationError');
    expect(output).not.toContain('Invalid value for');
    expect(output).not.toContain('Allowed values');
    expect(output).not.toContain('at loadEnv');
    expect(output).not.toMatch(/\n\s+at\s/);
    expect(output).not.toContain('config/env');
  }, 90_000);

  it('names no database host when it refuses the target', async () => {
    const outcome = await startWith({
      NODE_ENV: 'test',
      DATABASE_URL: `postgresql://memory:pw@${MARKER}.example.invalid:5432/memorydb`,
    });

    const output = `${outcome.stdout}\n${outcome.stderr}`;

    expect(outcome.code).not.toBe(0);
    expect(output).toContain(STARTUP_FAILURE_MESSAGE);
    expect(output).not.toContain(MARKER);
    expect(output).not.toContain('UnsafeDatabaseTargetError');
    expect(output).not.toContain('Refusing to connect');
    expect(output).not.toMatch(/\n\s+at\s/);
  }, 90_000);

  it('says the same thing when the connection string is missing entirely', async () => {
    const outcome = await startWith({});

    const output = `${outcome.stdout}\n${outcome.stderr}`;

    expect(outcome.code).not.toBe(0);
    expect(output).toContain(STARTUP_FAILURE_MESSAGE);
    expect(output).not.toContain('MissingEnvError');
    expect(output).not.toMatch(/\n\s+at\s/);
  }, 90_000);
});
