/**
 * What this adapter reads from the environment, and what it refuses to say.
 *
 * The package is small and so is this file, deliberately: there is one job
 * here — turn this host's configuration into a common Memory client — and the
 * tests that matter are about the credential never coming back out and about
 * the package not having quietly grown a second job.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MemoryApiConfigurationError, type FetchLike } from '@ai-problem-solving-memory/api-client';

import {
  createClaudeCodeMemoryClient,
  CLAUDE_CODE_SOURCE_AI,
  MEMORY_API_TOKEN_ENV,
  MEMORY_API_URL_ENV,
  MissingMemoryCredentialError,
} from '../src/index.js';

/** A synthetic value in the shape of a credential. Not one. */
const TOKEN = 'memory_test_1111111111111111111111111111';

const PACKAGE_ROOT = join(process.cwd(), 'packages', 'claude-code-adapter');

/** The URL a request was aimed at, whichever form `fetch` was handed. */
function urlOf(input: Parameters<FetchLike>[0]): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

async function packageSources(): Promise<{ path: string; source: string }[]> {
  const directory = join(PACKAGE_ROOT, 'src');
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });

  return Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map(async (entry) => {
        const path = join(entry.parentPath, entry.name);
        return { path: path.slice(PACKAGE_ROOT.length + 1), source: await readFile(path, 'utf8') };
      }),
  );
}

describe('reading the environment', () => {
  it('names the variables it reads', () => {
    expect(MEMORY_API_TOKEN_ENV).toBe('MEMORY_API_TOKEN');
    expect(MEMORY_API_URL_ENV).toBe('MEMORY_API_URL');
  });

  it('fails safely when the credential variable is not set', () => {
    try {
      createClaudeCodeMemoryClient({});
      expect.unreachable('an unset credential must not produce a client');
    } catch (error) {
      expect(error).toBeInstanceOf(MissingMemoryCredentialError);
      // It says which variable, because that is what somebody has to go and
      // set. It cannot say a value, because there is not one.
      expect((error as Error).message).toContain(MEMORY_API_TOKEN_ENV);
    }
  });

  it('refuses a blank credential through the client rule rather than a second copy of it', () => {
    for (const value of ['', '  ']) {
      try {
        createClaudeCodeMemoryClient({ [MEMORY_API_TOKEN_ENV]: value });
        expect.unreachable('a blank credential must not produce a client');
      } catch (error) {
        // Not `MissingMemoryCredentialError`: the variable is set. What is
        // wrong with the value is the client's rule, applied where it lives.
        expect(error).toBeInstanceOf(MemoryApiConfigurationError);
        expect((error as MemoryApiConfigurationError).failure).toBe('CREDENTIAL_BLANK');
      }
    }
  });

  it('reaches loopback when no base URL is set', async () => {
    const calls: string[] = [];
    const client = createClaudeCodeMemoryClient({ [MEMORY_API_TOKEN_ENV]: TOKEN }, (input) => {
      calls.push(urlOf(input));
      return Promise.resolve(new Response('{}', { status: 500 }));
    });

    await client.getProblem('11111111-2222-4333-8444-555555555555').catch(() => undefined);

    expect(calls[0]?.startsWith('http://127.0.0.1:3000/')).toBe(true);
  });

  it('uses an explicit base URL when one is set', async () => {
    const calls: string[] = [];
    const client = createClaudeCodeMemoryClient(
      { [MEMORY_API_TOKEN_ENV]: TOKEN, [MEMORY_API_URL_ENV]: 'https://memory.example' },
      (input) => {
        calls.push(urlOf(input));
        return Promise.resolve(new Response('{}', { status: 500 }));
      },
    );

    await client.getProblem('11111111-2222-4333-8444-555555555555').catch(() => undefined);

    expect(calls[0]?.startsWith('https://memory.example/')).toBe(true);
  });

  it('refuses an unusable base URL with the client rule, not one of its own', () => {
    try {
      createClaudeCodeMemoryClient({
        [MEMORY_API_TOKEN_ENV]: TOKEN,
        [MEMORY_API_URL_ENV]: 'http://user:pw@host',
      });
      expect.unreachable('a base URL carrying credentials must be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(MemoryApiConfigurationError);
      expect((error as MemoryApiConfigurationError).failure).toBe('BASE_URL_HAS_CREDENTIALS');
    }
  });

  it('builds a Memory client and nothing else', () => {
    const client = createClaudeCodeMemoryClient({ [MEMORY_API_TOKEN_ENV]: TOKEN });

    // Exactly the common client's surface. No configuration object beside it,
    // and so nowhere for the credential to be read back from.
    //
    // It has grown several times now — `search`, `listProblems`, the writes a
    // start needs, and now `createProject` — and this adapter did not change
    // once: it returns the client it built, so a method the client gains
    // arrives here for free. What the adapter must *not* have
    // gained is policy about when to search or what to call itself, which a
    // guard in the server's suite checks.
    expect(Object.keys(client)).toEqual([
      'getProblem',
      'listProjects',
      'listProblems',
      'createProject',
      'createEnvironment',
      'createProblem',
      'transitionProblemStatus',
      'search',
    ]);
    expect(JSON.stringify(client).includes(TOKEN)).toBe(false);
  });

  it('keeps the credential out of every failure it can produce', () => {
    const attempts: (() => unknown)[] = [
      () => createClaudeCodeMemoryClient({ [MEMORY_API_TOKEN_ENV]: '  ' }),
      () =>
        createClaudeCodeMemoryClient({
          [MEMORY_API_TOKEN_ENV]: TOKEN,
          [MEMORY_API_URL_ENV]: 'nonsense',
        }),
      () =>
        createClaudeCodeMemoryClient({
          [MEMORY_API_TOKEN_ENV]: TOKEN,
          [MEMORY_API_URL_ENV]: `http://host/?t=${TOKEN}`,
        }),
    ];

    for (const attempt of attempts) {
      try {
        attempt();
      } catch (error) {
        const rendered = `${String(error)}${JSON.stringify(error)}${(error as Error).stack ?? ''}`;
        expect(rendered.includes(TOKEN)).toBe(false);
      }
    }
  });
});

describe('what this adapter calls itself', () => {
  it('is a stable descriptive name', () => {
    expect(CLAUDE_CODE_SOURCE_AI).toBe('claude-code');
  });

  it('carries no version, session or path', async () => {
    // A value that varied per build would be repeated into every row it ever
    // wrote, and would already be stale there.
    expect(CLAUDE_CODE_SOURCE_AI).not.toMatch(/\d/);

    const sources = await packageSources();
    const declaration = sources.find((file) => file.path.endsWith('source-ai.ts'));
    expect(declaration).toBeDefined();

    // Nothing computes it: not from the environment, not from a version, not
    // from anything that could differ between two runs.
    const code = (declaration?.source ?? '').replace(/\/\*\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/process\.|env|version|session/i);
  });
});

describe('what this package is not, yet', () => {
  it('has no protocol, transport or host integration in it', async () => {
    const sources = await packageSources();
    expect(sources.length).toBeGreaterThan(0);

    for (const { path, source } of sources) {
      // Comments describe what later tasks will add; code must not have added
      // it already. Stripping them is what keeps this guard about the code.
      const code = source.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

      for (const forbidden of [
        'modelcontextprotocol',
        'McpServer',
        'StdioServerTransport',
        'registerTool',
        'CLAUDE_PROJECT_DIR',
        'roots/list',
        'hookSpecificOutput',
      ]) {
        expect(`${path}:${code.includes(forbidden)}`).toBe(`${path}:false`);
      }

      // `session_id` is the one term that stopped being package-wide. The
      // binding store persists it as a record field, which is the whole of
      // what that module is for; everywhere else it would still mean this
      // package had started handling host session payloads. Narrowed by name
      // rather than dropped, and the store carries its own tighter guard.
      if (!path.endsWith('problem-binding-store.ts')) {
        expect(`${path}:${code.includes('session_id')}`).toBe(`${path}:false`);
      }
    }
  });

  it('writes nothing to stdout', async () => {
    // This package becomes a stdio server later, and on that transport stdout
    // is the protocol. The habit is cheaper to keep than to acquire.
    for (const { path, source } of await packageSources()) {
      const code = source.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(`${path}:${/console\.(log|info|debug|dir|table)\s*\(/.test(code)}`).toBe(
        `${path}:false`,
      );
      expect(`${path}:${/process\.stdout/.test(code)}`).toBe(`${path}:false`);
    }
  });

  it('ships no executable yet', async () => {
    const manifest = JSON.parse(
      await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8'),
    ) as Record<string, unknown>;

    // An empty server that starts and answers nothing is worse than no server:
    // it is something to configure, misconfigure and debug for no capability.
    expect('bin' in manifest).toBe(false);
  });
});
