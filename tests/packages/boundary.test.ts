/**
 * The workspace boundaries, checked where they are declared rather than where
 * they are described.
 *
 * P5-01 fixed a dependency direction: an assistant reaches the Memory through
 * the common JSON API, an adapter holds everything host-specific, and the
 * Memory Server knows about neither. A comment saying so is worth nothing the
 * first time somebody adds a convenient import, so the direction is read back
 * out of the manifests and the sources.
 *
 * **The strongest check here is not a string search.** A package that does not
 * declare a dependency cannot import it, whatever its source says — so the
 * manifest assertions are the load-bearing ones, and the source scans exist to
 * catch the case where a dependency arrives by accident through the workspace
 * root's `node_modules`, which npm hoists and Node will happily resolve.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const PACKAGES = join(ROOT, 'packages');

const API_CLIENT = '@ai-problem-solving-memory/api-client';
const CLAUDE_ADAPTER = '@ai-problem-solving-memory/claude-code-adapter';

interface Manifest {
  readonly name?: string;
  readonly private?: boolean;
  readonly type?: string;
  readonly workspaces?: readonly string[];
  readonly main?: string;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly scripts?: Record<string, string>;
  readonly engines?: Record<string, string>;
  readonly bin?: unknown;
}

/**
 * Reads a `tsconfig`, which is JSON with comments.
 *
 * Only whole-line comments are removed, which is all these files have and all
 * that can be removed without a parser: a `//` inside a string is left alone
 * because this never looks at one.
 */
function readTsconfig(source: string): {
  compilerOptions?: Record<string, unknown>;
  include?: string[];
} {
  const withoutComments = source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');

  return JSON.parse(withoutComments) as {
    compilerOptions?: Record<string, unknown>;
    include?: string[];
  };
}

async function manifest(...segments: string[]): Promise<Manifest> {
  return JSON.parse(await readFile(join(...segments, 'package.json'), 'utf8')) as Manifest;
}

async function sourcesOf(packageDirectory: string): Promise<{ path: string; source: string }[]> {
  const root = join(PACKAGES, packageDirectory);
  const entries = await readdir(root, { recursive: true, withFileTypes: true });

  return Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith('.ts') &&
          !entry.parentPath.includes(`${join(root, 'dist')}`),
      )
      .map(async (entry) => {
        const path = join(entry.parentPath, entry.name);
        return {
          path: path.slice(root.length + 1).replace(/\\/g, '/'),
          source: await readFile(path, 'utf8'),
        };
      }),
  );
}

/**
 * Module specifiers a file imports, however they are written.
 *
 * The same three forms the layering guard understands, for the same reason: a
 * detector that only sees one spelling reports a clean result for a violation
 * written in another.
 */
function importsOf(source: string): string[] {
  const statik = [...source.matchAll(/from\s+["']([^"']+)["']/g)];
  const dynamic = [...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)];
  const sideEffect = [...source.matchAll(/^\s*import\s+["']([^"']+)["']/gm)];

  return [...statik, ...dynamic, ...sideEffect].map((match) => match[1] ?? '');
}

/** Source with block and line comments removed, so a guard reads the code. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/**
 * Whether a relative import leaves the package it was written in.
 *
 * Resolved against the importing file rather than matched as text, because
 * `../../../src/app/x.js` and a longer walk to the same file are one
 * violation and only the short spelling looks like one.
 */
function escapesPackage(packageDirectory: string, filePath: string, specifier: string): boolean {
  const root = join(PACKAGES, packageDirectory);
  const resolved = resolve(join(root, filePath), '..', specifier);
  return !resolved.startsWith(root);
}

describe('the workspace', () => {
  it('keeps the Memory Server exactly where it was', async () => {
    const root = await manifest(ROOT);

    expect(root.workspaces).toEqual(['packages/*']);
    // The server's own sources did not move into a package. Phase 1 through 4
    // import each other by relative path several hundred times, and moving
    // them to make room for two new packages would have been a rewrite of
    // everything to introduce something that needed none of it.
    expect(root.main).toBe('dist/index.js');
    await expect(readFile(join(ROOT, 'src', 'index.ts'), 'utf8')).resolves.toContain(
      'async function main',
    );
  });

  it('leaves the runtime dependencies of the server at the three it had', async () => {
    const root = await manifest(ROOT);

    expect(Object.keys(root.dependencies ?? {}).sort()).toEqual([
      '@fastify/swagger',
      'fastify',
      'pg',
    ]);
  });

  it('runs every package from the root commands', async () => {
    const root = await manifest(ROOT);
    const scripts = root.scripts ?? {};

    // A package that no root command names is a package that is quietly not
    // checked — the failure mode this assertion exists for, because nothing
    // else would fail if a third package were added and forgotten.
    const packages = (await readdir(PACKAGES, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    for (const directory of packages) {
      const packageManifest = await manifest(PACKAGES, directory);
      const name = packageManifest.name ?? '';

      expect(Object.keys(packageManifest.scripts ?? {})).toEqual(
        expect.arrayContaining(['build', 'typecheck']),
      );
      expect(`${directory} in build:${(scripts['build'] ?? '').includes(name)}`).toBe(
        `${directory} in build:true`,
      );
      expect(`${directory} in typecheck:${(scripts['typecheck'] ?? '').includes(name)}`).toBe(
        `${directory} in typecheck:true`,
      );
    }

    // `check` is the one command a person runs; it must still reach all of it.
    expect(scripts['check']).toContain('typecheck');
    expect(scripts['check']).toContain('test');
  });

  it('collects every package test into the one test command', async () => {
    const config = await readFile(join(ROOT, 'vitest.config.ts'), 'utf8');

    expect(config).toContain("'packages/*/tests/**/*.test.ts'");
  });

  it('builds each package into its own dist, from its own sources only', async () => {
    for (const directory of ['memory-api-client', 'claude-code-adapter']) {
      const packageManifest = await manifest(PACKAGES, directory);
      const build = readTsconfig(
        await readFile(join(PACKAGES, directory, 'tsconfig.build.json'), 'utf8'),
      );

      expect(packageManifest.main).toBe('./dist/index.js');
      expect(build.compilerOptions?.['outDir']).toBe('dist');
      expect(build.compilerOptions?.['rootDir']).toBe('src');
      expect(build.include).toEqual(['src']);

      // The source-tree mapping that makes a clean checkout typecheck is
      // cleared for the build. Left in place, a built adapter would carry its
      // own copy of the client instead of depending on the built one.
      expect(build.compilerOptions?.['paths']).toEqual({});
    }
  });

  it('declares both packages private, ESM and on the same Node floor', async () => {
    for (const directory of ['memory-api-client', 'claude-code-adapter']) {
      const packageManifest = await manifest(PACKAGES, directory);

      expect(packageManifest.private).toBe(true);
      expect(packageManifest.type).toBe('module');
      expect(packageManifest.engines?.['node']).toBe('>=22.12.0');
    }
  });
});

describe('the common client', () => {
  it('has no external runtime dependencies at all', async () => {
    const packageManifest = await manifest(PACKAGES, 'memory-api-client');

    // Zero, and the zero is the point: this package is what a second assistant
    // reuses, and every dependency here is one that assistant's environment
    // would have to accept.
    expect(packageManifest.dependencies ?? {}).toEqual({});
    expect(packageManifest.devDependencies ?? {}).toEqual({});
  });

  it('imports nothing but its own modules', async () => {
    for (const { path, source } of await sourcesOf('memory-api-client')) {
      for (const specifier of importsOf(source)) {
        const local = specifier.startsWith('.');
        const nodeBuiltin = specifier.startsWith('node:');
        // Test files reach for vitest; nothing else may reach for anything.
        const testTool = path.startsWith('tests/') && specifier === 'vitest';

        expect(`${path} imports ${specifier}`).toBe(
          local || nodeBuiltin || testTool ? `${path} imports ${specifier}` : 'a forbidden import',
        );
      }
    }
  });

  it('does not know the search route yet', async () => {
    const shipped = (await sourcesOf('memory-api-client')).filter((file) =>
      file.path.startsWith('src/'),
    );
    expect(shipped.length).toBeGreaterThan(0);

    // P5-02c published `POST /v1/problems/:problem_id/search` on the server.
    // The client method that calls it is the next task, deliberately: a search
    // request has four fields and a three-branch answer, and the client's
    // ten-second default is shorter than the provider ceiling behind that
    // route — so the method needs a timeout decision, not a copy of `getProblem`.
    //
    // Until then nothing here may half-know the route. A half-written method is
    // worse than none, because a caller cannot tell which it has.
    for (const { path, source } of shipped) {
      expect(`${path} knows /search:${source.includes('/search')}`).toBe(
        `${path} knows /search:false`,
      );
      expect(`${path} knows searchProblemMemory:${source.includes('searchProblemMemory')}`).toBe(
        `${path} knows searchProblemMemory:false`,
      );
    }
  });

  it('knows about no assistant, host or protocol', async () => {
    // Shipped code only. A test fixture legitimately contains values a server
    // would send — `source_ai` is free-form text and `claude-code` is exactly
    // what will be in it — and a guard that could not tell a dependency from a
    // sample would be one nobody could keep.
    const shipped = (await sourcesOf('memory-api-client')).filter((file) =>
      file.path.startsWith('src/'),
    );
    expect(shipped.length).toBeGreaterThan(0);

    for (const { path, source } of shipped) {
      const code = codeOnly(source);

      for (const forbidden of [
        'claude',
        'Claude',
        'codex',
        'Codex',
        'anthropic',
        'modelcontextprotocol',
        'McpServer',
        'CLAUDE_PROJECT_DIR',
      ]) {
        // A vendor-neutral client with a vendor's name in it is a client that
        // has started making decisions for one caller.
        expect(`${path}:${code.includes(forbidden)}`).toBe(`${path}:false`);
      }
    }
  });

  it('reaches neither the server nor the adapter', async () => {
    for (const { path, source } of await sourcesOf('memory-api-client')) {
      for (const specifier of importsOf(source)) {
        expect(`${path}:${specifier.includes(CLAUDE_ADAPTER)}`).toBe(`${path}:false`);

        // Resolved rather than matched. `../../../src/...` and a longer walk
        // to the same place are the same violation, and only one of them
        // looks like one.
        if (specifier.startsWith('.')) {
          expect(`${path}:${escapesPackage('memory-api-client', path, specifier)}`).toBe(
            `${path}:false`,
          );
        }
      }
    }
  });
});

describe('the Claude adapter', () => {
  it('depends on the common client and on nothing else', async () => {
    const packageManifest = await manifest(PACKAGES, 'claude-code-adapter');

    expect(packageManifest.dependencies ?? {}).toEqual({ [API_CLIENT]: '*' });
    expect(packageManifest.devDependencies ?? {}).toEqual({});
  });

  it('has no MCP dependency yet, because it has no protocol code yet', async () => {
    const packageManifest = await manifest(PACKAGES, 'claude-code-adapter');
    const declared = Object.keys({
      ...packageManifest.dependencies,
      ...packageManifest.devDependencies,
    });

    for (const name of declared) {
      expect(`${name}:${name.startsWith('@modelcontextprotocol/')}`).toBe(`${name}:false`);
      expect(`${name}:${name === 'zod'}`).toBe(`${name}:false`);
    }
  });

  it('reaches the Memory only through the common client', async () => {
    for (const { path, source } of await sourcesOf('claude-code-adapter')) {
      for (const specifier of importsOf(source)) {
        // A relative specifier is allowed only while it stays inside this
        // package. `../../../src/app/index.js` is relative too, and it is the
        // exact violation this guard exists for: an adapter that imports an
        // internal Memory service works only in a process that also hosts the
        // server, which is the one thing the whole boundary prevents.
        const allowed = specifier.startsWith('.')
          ? !escapesPackage('claude-code-adapter', path, specifier)
          : specifier.startsWith('node:') ||
            specifier === API_CLIENT ||
            (path.startsWith('tests/') && specifier === 'vitest');

        expect(`${path} imports ${specifier}`).toBe(
          allowed ? `${path} imports ${specifier}` : 'a forbidden import',
        );
      }
    }
  });
});

describe('the Memory Server', () => {
  it('imports neither package, and no protocol SDK', async () => {
    const src = join(ROOT, 'src');
    const entries = await readdir(src, { recursive: true, withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.ts'));

    for (const entry of files) {
      const path = join(entry.parentPath, entry.name);
      const source = await readFile(path, 'utf8');
      const relative = path.slice(src.length + 1).replace(/\\/g, '/');

      for (const specifier of importsOf(source)) {
        for (const forbidden of [API_CLIENT, CLAUDE_ADAPTER, '@modelcontextprotocol/']) {
          // The Memory does not know which assistant is asking. That is what
          // makes it the same Memory for the next one.
          expect(`${relative}:${specifier.includes(forbidden)}`).toBe(`${relative}:false`);
        }
      }
    }
  });
});
