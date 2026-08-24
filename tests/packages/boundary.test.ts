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

  it('keeps its knowledge of the search route in the two modules that own it', async () => {
    const shipped = (await sourcesOf('memory-api-client')).filter((file) =>
      file.path.startsWith('src/'),
    );
    expect(shipped.length).toBeGreaterThan(0);

    // P5-02c-impl-1 published `POST /v1/problems/:problem_id/search`; impl-2
    // added the method that calls it. This guard used to say the client knew
    // nothing about the route at all, which was the right claim while it did.
    //
    // Now the claim is narrower and worth more: the path is built in exactly one
    // place, and the contract is described in exactly one place. A third module
    // that started constructing the URL, or a second copy of the field lists,
    // would be a second description of an operation this package exists to hold
    // in one.
    // Every URL this package builds is built here. Code only, so an import
    // specifier and a doc comment naming the route do not count as building it.
    const buildsPaths = shipped
      .filter((file) => codeOnly(file.source).includes('/v1/problems/'))
      .map((file) => file.path);
    expect(buildsPaths).toEqual(['src/client.ts']);

    // And the contract is described once. A second copy of the field lists is a
    // second answer to "what is a search request", which is the drift this
    // package's mirroring is already one step away from.
    const describesTheContract = shipped
      .filter((file) => codeOnly(file.source).includes('MEMORY_SEARCH_REQUEST_FIELDS ='))
      .map((file) => file.path);
    expect(describesTheContract).toEqual(['src/search.ts']);

    // The operation id is the server's name for the route. The client's method
    // is `search`, deliberately — a client reads like a client, not like an
    // OpenAPI document — so the id has no business here.
    for (const { path, source } of shipped) {
      expect(`${path} names the operation id:${source.includes('searchProblemMemory')}`).toBe(
        `${path} names the operation id:false`,
      );
    }
  });

  it('exposes eleven methods and no way around them', async () => {
    const shipped = await sourcesOf('memory-api-client');
    const client = shipped.find((file) => file.path === 'src/client.ts');
    expect(client).toBeDefined();
    const code = codeOnly(client?.source ?? '');

    // Every method named. The interface is small on purpose: a method that no
    // caller has is a guess about how it will be called, and it grows one task
    // at a time.
    expect(code).toContain('getProblem(problemId: string)');
    expect(code).toContain('listProjects(): Promise<readonly ProjectResource[]>');
    expect(code).toContain('listProblems(projectId: string): Promise<readonly ProblemResource[]>');
    // Multi-line in the source, so matched on the parts that identify it
    // rather than on its exact wrapping.
    expect(code).toContain('createEnvironment(');
    expect(code).toContain('request: CreateEnvironmentRequest,');
    expect(code).toContain('): Promise<EnvironmentResource>;');
    expect(code).toContain(
      'createProblem(projectId: string, request: CreateProblemRequest): Promise<ProblemResource>;',
    );
    expect(code).toContain(
      'createProject(request: CreateProjectRequest): Promise<ProjectResource>;',
    );
    expect(code).toContain('transitionProblemStatus(');
    expect(code).toContain('request: TransitionProblemStatusRequest,');
    expect(code).toContain(
      'appendEvent(problemId: string, request: AppendEventRequest): Promise<EventResource>;',
    );
    expect(code).toContain('appendVerification(');
    expect(code).toContain('request: AppendVerificationRequest,');
    expect(code).toContain('): Promise<VerificationResource>;');
    expect(code).toContain(
      'closeProblem(problemId: string, request: CloseProblemRequest): Promise<ProblemResource>;',
    );
    expect(code).toContain('search(problemId: string, request: MemorySearchRequest)');

    // Eleven, and no twelfth by accident. Each write arrived with the caller
    // that needed it. The
    // ones still absent are absent for the same reason: nothing reads or edits
    // a single Project, and nothing edits or deletes a Problem through this
    // client — so a method for any of them would be a guess about how it will
    // be called, and the guess is what a later task would then have to argue
    // with.
    for (const absent of [
      'getProject',
      'updateProject',
      'deleteProject',
      'updateProblem',
      'deleteProblem',
    ]) {
      expect(`${absent}:${code.includes(absent)}`).toBe(`${absent}:false`);
    }

    // And no escape hatch. A public `request(path, init)` would be one line and
    // would end this package's usefulness: every caller reaching for it would be
    // building paths, choosing methods and reading status codes, which is
    // exactly the knowledge that belongs here.
    for (const forbidden of ['request(path', 'sendRaw', 'fetchJson', 'rawRequest']) {
      expect(`${forbidden}:${code.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it('gives each operation its own default ceiling, and lets one knob beat both', async () => {
    const shipped = await sourcesOf('memory-api-client');
    const client = shipped.find((file) => file.path === 'src/client.ts');
    const code = codeOnly(client?.source ?? '');

    // The finding this pins: a search runs two provider calls in series behind
    // the server, and inheriting an ordinary read's ceiling would abandon
    // searches the server was about to answer — every time, reported as an
    // unreachable Memory, which would not be true.
    //
    // Read positionally rather than by counting occurrences: what matters is
    // which constant each method reaches for, and both appear elsewhere in the
    // file as declarations.
    const getProblemAt = code.indexOf('async getProblem(');
    const searchAt = code.indexOf('async search(');
    expect(getProblemAt).toBeGreaterThan(-1);
    expect(searchAt).toBeGreaterThan(getProblemAt);

    const inGetProblem = code.slice(getProblemAt, searchAt);
    const inSearch = code.slice(searchAt);

    expect(inGetProblem).toContain('MEMORY_API_REQUEST_TIMEOUT_MS');
    expect(
      `getProblem reaches for the search ceiling:${inGetProblem.includes('MEMORY_API_SEARCH_TIMEOUT_MS')}`,
    ).toBe('getProblem reaches for the search ceiling:false');
    expect(inSearch).toContain('MEMORY_API_SEARCH_TIMEOUT_MS');
    expect(
      `search reaches for the ordinary ceiling:${inSearch.includes('MEMORY_API_REQUEST_TIMEOUT_MS')}`,
    ).toBe('search reaches for the ordinary ceiling:false');

    // One knob. A `searchTimeoutMs` beside `timeoutMs` would be a precedence
    // question for somebody to get wrong, and a caller that wants a ceiling
    // wants a ceiling.
    expect(`a second knob:${code.includes('searchTimeoutMs')}`).toBe('a second knob:false');
    // And every request is finite: the ceiling is chosen per operation, never
    // skipped.
    expect(code).toContain('AbortSignal.timeout(');
    expect(`unbounded:${code.includes('Infinity')}`).toBe('unbounded:false');
  });

  it('never reaches the machine it is running on', async () => {
    const shipped = (await sourcesOf('memory-api-client')).filter((file) =>
      file.path.startsWith('src/'),
    );

    // Reading a repository, a path or an environment is host-specific work, and
    // this package is what a second assistant reuses. P5-03 put all of it in the
    // adapter for exactly that reason.
    for (const { path, source } of shipped) {
      const code = codeOnly(source);
      for (const forbidden of [
        'child_process',
        'execFile',
        'spawn',
        'node:fs',
        'node:path',
        'node:os',
        'process.env',
        'git',
      ]) {
        expect(`${path} reaches ${forbidden}:${code.includes(forbidden)}`).toBe(
          `${path} reaches ${forbidden}:false`,
        );
      }
    }
  });

  it('holds no privacy policy of its own', async () => {
    const shipped = (await sourcesOf('memory-api-client')).filter((file) =>
      file.path.startsWith('src/'),
    );

    // The search request carries somebody's own words about their own problem,
    // and whether any of it may be sent to a provider is decided by the Memory
    // Server's sanitization boundary — in one place, once. A second detector
    // here would be a second privacy contract, and two privacy contracts
    // disagree the first time one of them is extended.
    for (const { path, source } of shipped) {
      const code = codeOnly(source);
      for (const forbidden of [
        'secret',
        'Secret',
        'redact',
        'Redact',
        'sanitiz',
        'Sanitiz',
        'credentialPattern',
      ]) {
        expect(`${path} inspects for ${forbidden}:${code.includes(forbidden)}`).toBe(
          `${path} inspects for ${forbidden}:false`,
        );
      }
    }
  });

  it('keeps the credential opaque, in every package that carries one', async () => {
    // What a Memory credential looks like is the server's rule, and it has now
    // changed twice. A package that enforced a copy of the grammar would start
    // refusing valid credentials the day it changed again — which is the
    // failure this guard exists to make impossible rather than merely
    // discouraged, because the copy would look harmless and would pass every
    // test that did not present a newly-shaped token.
    //
    // Non-blank is the one property a client can know: an unset variable is a
    // configuration mistake, and everything else is the server's answer.
    for (const packageDirectory of [
      'memory-api-client',
      'claude-code-adapter',
      'claude-code-memory-plugin',
    ]) {
      const shipped = (await sourcesOf(packageDirectory)).filter((file) =>
        file.path.startsWith('src/'),
      );

      for (const { path, source } of shipped) {
        const code = codeOnly(source);
        for (const forbidden of [
          'mem_',
          'parseCredentialToken',
          'TOKEN_PREFIX',
          'LOOKUP_LENGTH',
          'SECRET_LENGTH',
          '{16}',
          '{43}',
        ]) {
          expect(
            `${path} knows the token grammar via ${forbidden}:${code.includes(forbidden)}`,
          ).toBe(`${path} knows the token grammar via ${forbidden}:false`);
        }
      }
    }
  });

  it('never retries a call on the caller’s behalf', async () => {
    const shipped = (await sourcesOf('memory-api-client')).filter((file) =>
      file.path.startsWith('src/'),
    );

    // A hidden retry turns one search into two provider calls and one recorded
    // usage row into two, and the caller that could have decided whether
    // resending was safe never learns anything was resent.
    for (const { path, source } of shipped) {
      const code = codeOnly(source);
      for (const forbidden of ['retry', 'Retry', 'attempt <', 'backoff', 'setTimeout(']) {
        expect(`${path} retries via ${forbidden}:${code.includes(forbidden)}`).toBe(
          `${path} retries via ${forbidden}:false`,
        );
      }
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

  it('keeps every protocol dependency inside the plugin runtime', async () => {
    // The whole point of a third package. The client speaks one JSON API and
    // the adapter speaks none: a protocol dependency in either would make them
    // unusable anywhere the protocol is not, and would put host knowledge in
    // the two layers that are meant to be testable without a host.
    for (const packageDirectory of ['memory-api-client', 'claude-code-adapter']) {
      const declared = Object.keys((await manifest(PACKAGES, packageDirectory)).dependencies ?? {});

      for (const forbidden of [
        '@modelcontextprotocol/server',
        '@modelcontextprotocol/sdk',
        'zod',
      ]) {
        expect(`${packageDirectory} depends on ${forbidden}:${declared.includes(forbidden)}`).toBe(
          `${packageDirectory} depends on ${forbidden}:false`,
        );
      }

      const shipped = (await sourcesOf(packageDirectory)).filter((file) =>
        file.path.startsWith('src/'),
      );
      for (const { path, source } of shipped) {
        const code = codeOnly(source);
        for (const forbidden of [
          'modelcontextprotocol',
          'McpServer',
          'serveStdio',
          'PreToolUse',
          'claudecode/toolUseId',
          'CLAUDE_PLUGIN_DATA',
          'CLAUDE_PLUGIN_ROOT',
        ]) {
          expect(`${path} reaches for ${forbidden}:${code.includes(forbidden)}`).toBe(
            `${path} reaches for ${forbidden}:false`,
          );
        }
      }
    }
  });

  it('gives the plugin runtime the dependencies it actually uses, and no others', async () => {
    const runtime = await manifest(PACKAGES, 'claude-code-memory-plugin');

    expect(Object.keys(runtime.dependencies ?? {}).sort()).toEqual([
      '@ai-problem-solving-memory/api-client',
      '@ai-problem-solving-memory/claude-code-adapter',
      '@modelcontextprotocol/server',
      'zod',
    ]);
    // Pinned exactly: the host bridge was measured against one version of the
    // protocol library, and a range would let it move underneath a contract
    // that is measured rather than published.
    expect(runtime.dependencies?.['@modelcontextprotocol/server']).toBe('2.0.0');
    expect(runtime.private).toBe(true);
    expect(runtime.type).toBe('module');

    // The bundler is build-time only. A tool that turned up in `dependencies`
    // would be a package an installed copy is expected to have, which is the
    // one thing distribution must not require.
    expect(Object.keys(runtime.devDependencies ?? {})).toEqual(['esbuild']);
    expect(runtime.dependencies?.['esbuild']).toBeUndefined();
  });

  it('takes the current location from the call, never from where it started', async () => {
    const base = join(PACKAGES, 'claude-code-memory-plugin');
    const mcp = await readFile(join(base, '.mcp.json'), 'utf8');
    const shipped = await sourcesOf('claude-code-memory-plugin');
    const sources = shipped
      .filter((file) => file.path.startsWith('src/'))
      .map((file) => `${file.path}\n${codeOnly(file.source)}`)
      .join('\n');

    // The server learns its environment once, when it starts. A session that
    // moves afterwards keeps the process it had, so a project directory read
    // from that environment describes where the session *began* — which is how
    // a moved session came to be answered about the repository it had left.
    // The plugin data directory is the one path that genuinely does not move.
    expect(mcp).toContain('MEMORY_CLAUDE_PLUGIN_DATA');
    for (const forbidden of ['MEMORY_CLAUDE_PROJECT_DIR', 'CLAUDE_PROJECT_DIR']) {
      expect(`the shipped MCP config passes ${forbidden}:${mcp.includes(forbidden)}`).toBe(
        `the shipped MCP config passes ${forbidden}:false`,
      );
      expect(`the runtime source names ${forbidden}:${sources.includes(forbidden)}`).toBe(
        `the runtime source names ${forbidden}:false`,
      );
    }

    // And no second-best source either. `process.cwd()` is where this process
    // happens to be, which is not where the session is; a directory chosen by
    // the model is a claim about a machine it cannot see.
    for (const forbidden of ['process.cwd(', 'tool_input']) {
      expect(`the runtime source reaches for ${forbidden}:${sources.includes(forbidden)}`).toBe(
        `the runtime source reaches for ${forbidden}:false`,
      );
    }

    // What it does read: the host's own directory for this call, carried in
    // the record the hook minted.
    expect(sources).toContain('current_directory');
    expect(sources).toContain('claim.currentDirectory');
  });

  it('ships a runtime that reaches only inside the installed plugin', async () => {
    const base = join(PACKAGES, 'claude-code-memory-plugin');
    const mcp = await readFile(join(base, '.mcp.json'), 'utf8');
    const hooks = await readFile(join(base, 'hooks', 'hooks.json'), 'utf8');

    // An install copies this directory and nothing around it, so a path that
    // leaves it is a plugin that works here and nowhere else. `dist/` is the
    // ordinary TypeScript build output and is not part of a release at all.
    for (const [what, configuration] of [
      ['the MCP configuration', mcp],
      ['the hook configuration', hooks],
    ] as const) {
      expect(configuration).toContain('${CLAUDE_PLUGIN_ROOT}/bundle/');
      expect(`${what} runs from dist:${configuration.includes('/dist/')}`).toBe(
        `${what} runs from dist:false`,
      );
      expect(`${what} climbs out of the plugin:${configuration.includes('..')}`).toBe(
        `${what} climbs out of the plugin:false`,
      );
    }

    // And the persistent data directory stays what it is: state. Installing
    // dependencies into it would put the runtime back outside the copy, one
    // indirection further away.
    for (const forbidden of ['npm', 'install', 'node_modules', 'curl', 'bash', 'sh -c']) {
      expect(`the install runs ${forbidden}:${(mcp + hooks).includes(forbidden)}`).toBe(
        `the install runs ${forbidden}:false`,
      );
    }
  });

  it('keeps the generated artifact out of source review, and only that', async () => {
    const prettierIgnore = await readFile(join(ROOT, '.prettierignore'), 'utf8');
    const eslintConfig = await readFile(join(ROOT, 'eslint.config.js'), 'utf8');

    // Generated bytes are verified by rebuilding them, which is a stronger
    // statement than any formatting rule — but the exemption has to stop at
    // the bundle. The sources beside it stay fully linted and formatted.
    for (const configuration of [prettierIgnore, eslintConfig]) {
      expect(configuration).toContain('packages/claude-code-memory-plugin/bundle/');
      for (const overreach of [
        'packages/claude-code-memory-plugin/src',
        'packages/claude-code-memory-plugin/tests',
        'packages/claude-code-memory-plugin/**',
      ]) {
        expect(`the exemption covers ${overreach}:${configuration.includes(overreach)}`).toBe(
          `the exemption covers ${overreach}:false`,
        );
      }
    }
  });

  it('makes the freshness of the shipped runtime part of the ordinary check', async () => {
    const root = await manifest(ROOT, '.');

    // A committed artifact nobody verifies is a lie waiting to be found by a
    // user. This is the check that catches source moving without it.
    expect(root.scripts?.['check']).toContain('bundle:check');
    expect(root.scripts?.['bundle']).toBeDefined();

    // The check must actually compare rather than regenerate: a mode that
    // rewrote the committed files would pass every time and prove nothing.
    const runtime = await manifest(PACKAGES, 'claude-code-memory-plugin');
    expect(runtime.scripts?.['bundle:check']).toContain('--check');
    expect(runtime.scripts?.['bundle']).toBe('node scripts/build-bundle.mjs');
  });

  it('commits the distribution and nothing else generated', async () => {
    const ignore = await readFile(join(ROOT, '.gitignore'), 'utf8');

    // `dist/` and `node_modules/` stay ignored: the bundle exists precisely so
    // that neither of them has to travel.
    expect(ignore).toContain('node_modules/');
    expect(ignore).toContain('dist/');
    expect(`the bundle is ignored:${ignore.includes('bundle/')}`).toBe(
      'the bundle is ignored:false',
    );

    // Present locally is ordinary; committed is not, and the rules above are
    // what decides that. What must be exactly right is the bundle itself.
    const base = join(PACKAGES, 'claude-code-memory-plugin');
    expect((await readdir(join(base, 'bundle'))).sort()).toEqual(['pre-tool-use.js', 'server.js']);
  });

  it('offers exactly one plugin, from exactly the directory that is one', async () => {
    const catalog = JSON.parse(
      await readFile(join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'),
    ) as { name?: string; plugins?: { name?: string; source?: unknown; version?: unknown }[] };

    expect(catalog.plugins).toHaveLength(1);
    expect(catalog.plugins?.[0]?.source).toBe('./packages/claude-code-memory-plugin');
    // The repository root is a Memory server, a database and three packages.
    // Offering it as a plugin would hand somebody all of that.
    expect(catalog.plugins?.[0]?.source).not.toBe('.');

    const pluginManifest = JSON.parse(
      await readFile(
        join(PACKAGES, 'claude-code-memory-plugin', '.claude-plugin', 'plugin.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;

    // Neither manifest pins a version, so the host falls through to the commit
    // the plugin was built from. A fixed number here, while the work is still
    // moving, would make every later commit install as the same version.
    expect(`the manifest pins a version:${'version' in pluginManifest}`).toBe(
      'the manifest pins a version:false',
    );
    expect(`the catalog entry pins a version:${'version' in (catalog.plugins?.[0] ?? {})}`).toBe(
      'the catalog entry pins a version:false',
    );
  });

  it('leaves every deterministic rule where it already lives', async () => {
    const shipped = (await sourcesOf('claude-code-memory-plugin')).filter((file) =>
      file.path.startsWith('src/'),
    );

    // A runtime that knew any of these would be a second place they are
    // decided — and the one furthest from the tests that prove them. The
    // rejected proof design is named too, so it cannot quietly return.
    for (const { path, source } of shipped) {
      const code = codeOnly(source);
      for (const forbidden of [
        'transitionProblemStatus',
        'canonicaliseGitRemote',
        'CLAUDE_CODE_SESSION_ID',
        'process.cwd',
        'transcript',
        '_memory_host_proof',
        'hostProof',
        'proofToken',
        'createHmac',
        'randomBytes',
        'src/db',
        'node:sqlite',
      ]) {
        expect(`${path} reaches for ${forbidden}:${code.includes(forbidden)}`).toBe(
          `${path} reaches for ${forbidden}:false`,
        );
      }
    }
  });

  it('composes the adapter rather than calling the Memory itself', async () => {
    const shipped = (await sourcesOf('claude-code-memory-plugin')).filter((file) =>
      file.path.startsWith('src/'),
    );

    // The runtime's only business calls are the adapter's compositions. A
    // direct client call here would be a second implementation of a rule that
    // already has one, in the layer with the least context for it.
    for (const { path, source } of shipped) {
      const code = codeOnly(source);
      for (const forbidden of [
        'listProjects(',
        'createProject(',
        'listProblems(',
        'getProblem(',
        'createProblem(',
        'createEnvironment(',
      ]) {
        expect(`${path} calls ${forbidden}:${code.includes(forbidden)}`).toBe(
          `${path} calls ${forbidden}:false`,
        );
      }
    }
  });

  it('reads the host identifier in one place, and writes nothing into the call', async () => {
    const shipped = await sourcesOf('claude-code-memory-plugin');
    expect(shipped.map((file) => file.path)).toContain('src/host-call-context.ts');

    // The key is measured on the installed host rather than published by it,
    // so it is named once and every other module asks this one.
    for (const { path, source } of shipped.filter((file) => file.path.startsWith('src/'))) {
      const mentions = codeOnly(source).split('claudecode/toolUseId').length - 1;
      expect(`${path} names the host key ${String(mentions)} times`).toBe(
        `${path} names the host key ${path === 'src/host-call-context.ts' ? '1' : '0'} times`,
      );
    }

    // And the hook rewrites nothing. No injected field means nothing for the
    // model to carry, nothing in a transcript, and no rewrite race with
    // another hook.
    const hook = shipped.find((file) => file.path === 'src/pre-tool-use.ts');
    expect(codeOnly(hook?.source ?? '').includes('updatedInput')).toBe(false);
  });

  it('tidies by age and name, never by whether a file parses', async () => {
    const shipped = await sourcesOf('claude-code-memory-plugin');
    const context = shipped.find((file) => file.path === 'src/host-call-context.ts');
    const code = codeOnly(context?.source ?? '');
    const sweep = code.slice(code.indexOf('export async function sweepCallContexts'));

    // Housekeeping never reads a record. Two hooks run in parallel, and one of
    // them is briefly mid-write; a sweep that deleted what it could not parse
    // would take exactly that file and leave an already-allowed call with
    // nothing to claim.
    for (const forbidden of ['JSON.parse', 'readFile', 'isHostCallContext', 'isExpired']) {
      expect(`the sweep reaches for ${forbidden}:${sweep.includes(forbidden)}`).toBe(
        `the sweep reaches for ${forbidden}:false`,
      );
    }
    // It asks two questions instead, in this order.
    expect(sweep).toContain('isOwnedCallContextFilename(entry)');
    expect(sweep).toContain('mtimeMs');

    // And the claim checks how big a file is before taking its bytes: measuring
    // a string afterwards is not a bound, because by then it is already read.
    const claim = code.slice(
      code.indexOf('export async function claimCallContext'),
      code.indexOf('export async function sweepCallContexts'),
    );
    expect(claim.indexOf('CALL_CONTEXT_MAX_BYTES')).toBeLessThan(claim.indexOf('readFile'));
  });

  it('claims a call by creating one file that cannot already exist', async () => {
    const shipped = await sourcesOf('claude-code-memory-plugin');
    const context = shipped.find((file) => file.path === 'src/host-call-context.ts');
    const code = codeOnly(context?.source ?? '');
    const claim = code.slice(
      code.indexOf('export async function claimCallContext'),
      code.indexOf('export async function sweepCallContexts'),
    );

    // Exclusive creation is the exclusion. Renaming a record to a unique name
    // and calling a successful rename ownership was measured false on Windows,
    // where several concurrent callers are told they won — so no rename takes
    // part in authentication anywhere in this module.
    expect(claim).toContain("open(marker, 'wx', 0o600)");
    for (const forbidden of ['rename(', 'randomUUID']) {
      expect(`the claim uses ${forbidden}:${code.includes(forbidden)}`).toBe(
        `the claim uses ${forbidden}:false`,
      );
    }

    // The marker is won before anything trusted is opened, so a loser never
    // reads a session it did not win.
    expect(claim.indexOf("open(marker, 'wx'")).toBeLessThan(claim.indexOf('stat(pending)'));
    expect(claim.indexOf("open(marker, 'wx'")).toBeLessThan(claim.indexOf('readFile'));

    // And it is not removed when the call ends: only the record is.
    expect(claim).toContain('unlink(pending)');
    expect(`the claim releases its marker:${claim.includes('unlink(marker)')}`).toBe(
      'the claim releases its marker:false',
    );
  });

  it('offers exactly nine Memory tools, named for goals rather than for calls', async () => {
    const shipped = await sourcesOf('claude-code-memory-plugin');
    const constants = shipped.find((file) => file.path === 'src/runtime-constants.ts');
    const server = shipped.find((file) => file.path === 'src/server.ts');
    const code = codeOnly(server?.source ?? '');
    const declared = codeOnly(constants?.source ?? '');

    for (const tool of [
      'current_problem',
      'continue_problem',
      'resume_problem',
      'start_problem',
      // The fifth is the first that is not about which Problem this session is
      // on. It is still named for a goal — look up what is already known — and
      // not for the call underneath it.
      'recall_similar_experience',
      // The remaining four name the evidence or lifecycle decision the caller means,
      // not the HTTP calls used underneath them.
      'add_event',
      'add_verification',
      'mark_fix_candidate',
      'close_problem',
    ]) {
      expect(`the runtime declares ${tool}:${declared.includes(tool)}`).toBe(
        `the runtime declares ${tool}:true`,
      );
    }
    expect(`tools registered:${(code.match(/server\.registerTool\(/gu) ?? []).length}`).toBe(
      'tools registered:9',
    );

    // No plumbing. A surface made of steps would ask the model to assemble a
    // lifecycle out of API calls, which is the thing every rule in the adapter
    // exists to keep it from doing.
    for (const absent of [
      'resolve_project',
      'register_project',
      'select_project',
      'create_environment',
      'create_problem',
      'transition_problem_status',
      'list_problems',
      'get_problem',
      // Absent deliberately: the deterministic path can register a Project,
      // which is a durable write, so no tool may claim to be read-only.
      'readOnlyHint',
    ]) {
      expect(`the runtime declares ${absent}:${code.includes(absent)}`).toBe(
        `the runtime declares ${absent}:false`,
      );
    }
  });

  it('lets one operation answer Project questions, and the rest only confirm', async () => {
    const shipped = await sourcesOf('claude-code-memory-plugin');
    const server = codeOnly(shipped.find((file) => file.path === 'src/server.ts')?.source ?? '');
    const actions = codeOnly(
      shipped.find((file) => file.path === 'src/problem-actions.ts')?.source ?? '',
    );

    // Deciding a Project should exist is a conversation, and a tool that
    // changes a Problem is not where somebody is having it. So registration
    // lives in exactly one place and the three mutations only ever confirm an
    // identity they were handed.
    for (const forbidden of ['registerProject', 'ProjectRegistrationChoice', 'project_decision']) {
      expect(`the actions reach for ${forbidden}:${actions.includes(forbidden)}`).toBe(
        `the actions reach for ${forbidden}:false`,
      );
    }
    expect(actions).toContain('selectSuppliedProject');

    // And only the asking operation accepts an answer. Counted over the input
    // schemas rather than the whole module, because a tool description names
    // the field on purpose — a model that is not told what to pass cannot
    // answer the question this runtime asked it.
    const inputs = server
      .split('inputSchema:')
      .slice(1)
      .map((part) => part.slice(0, part.indexOf('outputSchema:')))
      .join('\n');

    expect(server).toContain('project_decision: PROJECT_DECISION_SCHEMA.optional()');
    expect(`decision inputs declared:${(inputs.match(/project_decision/gu) ?? []).length}`).toBe(
      'decision inputs declared:1',
    );
  });

  it('accepts no Project material a caller could invent', async () => {
    const shipped = await sourcesOf('claude-code-memory-plugin');
    const server = codeOnly(shipped.find((file) => file.path === 'src/server.ts')?.source ?? '');
    const opens = server.indexOf('const PROJECT_DECISION_SCHEMA');
    const schema = server.slice(opens, server.indexOf(']);', opens));

    // Asserted as the whole field set rather than by searching for words, so a
    // field added later has to appear here. A repository, a remote, a name, a
    // platform or a path from this machine are all things the detector
    // observes; a caller supplying one would be describing somebody's machine
    // from memory.
    const fields = [...schema.matchAll(/([a-z_]+):/gu)].map((match) => match[1]);
    expect([...new Set(fields)].sort()).toEqual(['kind', 'project_id', 'repo_subpath']);
  });

  it('takes nothing from a caller that the host or the adapter owns', async () => {
    const shipped = await sourcesOf('claude-code-memory-plugin');
    const server = codeOnly(shipped.find((file) => file.path === 'src/server.ts')?.source ?? '');
    const inputs = server
      .split('inputSchema:')
      .slice(1)
      .map((part) => part.slice(0, part.indexOf('outputSchema:')))
      .join('\n');

    // The session, the Project root, the provenance, the concurrency token and
    // the local note are each owned somewhere a caller cannot see. A field for
    // any of them would be a way to say something untrue about this machine.
    for (const forbidden of [
      'session',
      'projectDir',
      'project_dir',
      'source_ai',
      'changed_by',
      'expected_version',
      'environment_id',
      'binding',
      '_meta',
      'tool_use_id',
      '_memory_host_proof',
    ]) {
      expect(`a tool accepts ${forbidden}:${inputs.includes(forbidden)}`).toBe(
        `a tool accepts ${forbidden}:false`,
      );
    }
  });

  it('mints host identity for exactly the nine tools', async () => {
    const shipped = await sourcesOf('claude-code-memory-plugin');
    const hook = codeOnly(
      shipped.find((file) => file.path === 'src/pre-tool-use.ts')?.source ?? '',
    );

    // The list is the gate. A matcher is configuration and can be widened by
    // accident; this decides whether a session identity is created at all.
    expect(hook).toContain('HOST_TOOL_NAMES.includes(toolName)');
    // And the record names the operation it was minted for, so one tool's
    // context cannot authenticate another's call.
    expect(hook).toContain('toolName,');
    expect(hook.includes('updatedInput')).toBe(false);
  });

  it('does not describe the asking operation as unable to be answered', async () => {
    const shipped = await sourcesOf('claude-code-memory-plugin');
    const asking = shipped.find((file) => file.path === 'src/current-problem.ts')?.source ?? '';

    // This module's own account of itself outlived the capability it describes
    // once already: it went on saying an answer had to arrive somewhere else
    // after this operation had become the place answers arrive. A comment that
    // contradicts the code is read by whoever changes the code next.
    for (const stale of [
      'not something this tool can yet accept',
      'cannot yet accept',
      'yet accept',
    ]) {
      expect(`the module still says "${stale}":${asking.includes(stale)}`).toBe(
        `the module still says "${stale}":false`,
      );
    }
    expect(asking).toContain('projectDecision');
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
      // Read from the code rather than the whole file. Prose explaining a
      // design routinely contains the words `from "one thing"`, and a guard
      // that reported those as forbidden imports would train somebody to work
      // around it — which is how a guard stops being read at all.
      for (const specifier of importsOf(codeOnly(source))) {
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

describe('the Claude adapter, still', () => {
  it('has not started searching, or injecting itself into a search', async () => {
    const shipped = (await sourcesOf('claude-code-adapter')).filter((file) =>
      file.path.startsWith('src/'),
    );
    expect(shipped.length).toBeGreaterThan(0);

    // The adapter returns the client it built, so `search()` reached it for free
    // the moment the client grew one. What it must not have grown is *policy*:
    // when to search, how to present a result.
    //
    // One module now searches, and it is named here rather than the rule being
    // relaxed. What it composes is deterministic: which Problem, whether that
    // Problem may be read, and whether this exact question was already asked.
    // *When* to ask is still not settled anywhere in this package — no trigger,
    // no schedule, nothing watching a conversation — and `autoSearch` stays
    // forbidden everywhere, this module included, because that decision belongs
    // to a later task and would otherwise be made here by accident.
    const RECALL = 'src/similar-experience-recall.ts';
    expect(shipped.map((file) => file.path)).toContain(RECALL);
    for (const { path, source } of shipped) {
      const code = codeOnly(source);
      const forbids = path === RECALL ? ['autoSearch'] : ['.search(', 'autoSearch'];
      for (const forbidden of forbids) {
        expect(`${path} does ${forbidden}:${code.includes(forbidden)}`).toBe(
          `${path} does ${forbidden}:false`,
        );
      }
    }

    // And it searches once per call. A loop or a retry here would be this
    // package deciding how hard to try, which is the Memory's own answer to
    // give — a degraded provider is already reported as a status rather than
    // as a failure worth repeating.
    const recall = codeOnly(shipped.find((file) => file.path === RECALL)?.source ?? '');
    expect(`searches issued per call:${(recall.match(/\.search\(/gu) ?? []).length}`).toBe(
      'searches issued per call:1',
    );

    // `source_ai` narrowed rather than dropped. Starting a Problem, asking a
    // search and recording current-Problem evidence all stamp the authenticated
    // runtime's name. These modules and the one closed runtime-provenance
    // vocabulary have a reason to say so; model-owned inputs still omit it.
    for (const { path, source } of shipped) {
      if (
        path === 'src/problem-start.ts' ||
        path === RECALL ||
        path === 'src/problem-recording.ts' ||
        path === 'src/source-ai.ts'
      ) {
        continue;
      }
      const code = codeOnly(source);
      for (const forbidden of ['sourceAi:', 'source_ai']) {
        expect(`${path} does ${forbidden}:${code.includes(forbidden)}`).toBe(
          `${path} does ${forbidden}:false`,
        );
      }
    }
  });

  it('resolves a current Problem without keeping anything between calls', async () => {
    const shipped = await sourcesOf('claude-code-adapter');
    const resolver = shipped.find((file) => file.path === 'src/problem-resolution.ts');
    expect(resolver).toBeDefined();
    const code = codeOnly(resolver?.source ?? '');

    // A binding arrives as an argument and leaves with the call. Where one is
    // stored, how long it lives, and what a session identifier has to do with
    // it belong to the store beside it — and a resolver that reached for a file
    // or a session id would take that over quietly, in the module least suited
    // to owning it.
    for (const forbidden of [
      'node:fs',
      'node:path',
      'node:crypto',
      'writeFile',
      'readFile',
      'sessionId',
      'session_id',
      'CLAUDE_SESSION',
    ]) {
      expect(`the resolver reaches for ${forbidden}:${code.includes(forbidden)}`).toBe(
        `the resolver reaches for ${forbidden}:false`,
      );
    }

    // And it writes nothing. A resolver that could move or create a Problem
    // would make "what is true" and "what to do about it" one step, and every
    // recheck built on it would be rechecking its own effect.
    for (const forbidden of [
      'transitionProblemStatus',
      'createProblem',
      'createEnvironment',
      'startProblem',
      'target_status',
    ]) {
      expect(`the resolver reaches for ${forbidden}:${code.includes(forbidden)}`).toBe(
        `the resolver reaches for ${forbidden}:false`,
      );
    }
  });

  it('keeps local persistence and session identity in exactly one module', async () => {
    const shipped = (await sourcesOf('claude-code-adapter')).filter((file) =>
      file.path.startsWith('src/'),
    );
    const STORE = 'src/problem-binding-store.ts';
    expect(shipped.map((file) => file.path)).toContain(STORE);

    // The store owns filesystem persistence, session identity and the path and
    // hash mechanics that go with them. That is a real widening of what this
    // package may do, so it is bounded by name rather than by intention: a
    // second module quietly starting to keep session state is the thing this
    // catches, and it is the version of this mistake nobody would notice.
    //
    // One module now takes a session identifier as an *argument*, because
    // binding a session to a Problem is what it composes. That is a parameter
    // travelling through to the store, not knowledge of what a session is: it
    // is never parsed, never read from the host, and never stored anywhere the
    // store did not put it. So `sessionId` is narrowed to that module by name
    // and everything else — the filesystem, the hashing, the wire spelling —
    // stays forbidden there too.
    // A second module now hashes, and it is named here for the same reason.
    // What it computes is a digest of the question it is about to ask, so that
    // the same question is not asked twice; it never touches a file, and where
    // that digest is kept is somebody else's decision entirely. So `createHash`
    // is narrowed to it by name while the filesystem stays forbidden there —
    // which is what keeps "hashes something" from becoming "keeps state".
    //
    // It takes a session identifier for the same reason the lifecycle module
    // does: it passes one through to resolve which Problem this session is on.
    const LIFECYCLE = 'src/problem-lifecycle.ts';
    const RECALL = 'src/similar-experience-recall.ts';
    const RECORDING = 'src/problem-recording.ts';
    expect(shipped.map((file) => file.path)).toContain(RECALL);
    expect(shipped.map((file) => file.path)).toContain(RECORDING);
    for (const { path, source } of shipped) {
      if (path === STORE) {
        continue;
      }
      const code = codeOnly(source);
      const owns = ['node:fs', 'writeFile', 'readFile', 'mkdir', 'session_id', 'createHash'];
      const persistence = ['node:fs', 'writeFile', 'readFile', 'mkdir', 'session_id'];
      const forbids =
        path === LIFECYCLE
          ? owns
          : path === RECALL || path === RECORDING
            ? persistence
            : [...owns, 'sessionId'];
      for (const forbidden of forbids) {
        expect(`${path} reaches for ${forbidden}:${code.includes(forbidden)}`).toBe(
          `${path} reaches for ${forbidden}:false`,
        );
      }
    }
  });

  it('composes a Problem lifecycle without acquiring anything itself', async () => {
    const shipped = await sourcesOf('claude-code-adapter');
    const lifecycle = shipped.find((file) => file.path === 'src/problem-lifecycle.ts');
    expect(lifecycle).toBeDefined();
    const code = codeOnly(lifecycle?.source ?? '');

    // A session identifier arrives as an argument and is handed to the store.
    // Where it comes from is the host's question and belongs to the task that
    // speaks to the host; a module that read it from the environment would have
    // quietly taken that over, and it is the layer with the least context for
    // deciding what a session is.
    //
    // Which Project a session is in is settled before any of this is called, so
    // detection and registration are absent for the same reason: this composes
    // the Problem half and would otherwise become the place both halves live.
    for (const forbidden of [
      'process.env',
      'process.cwd',
      'CLAUDE_PLUGIN',
      'CLAUDE_PROJECT_DIR',
      'CLAUDE_CODE_SESSION',
      'node:fs',
      'node:path',
      'node:crypto',
      'detectProjectSignals',
      'resolveProject',
      'registerProject',
      'selectProject',
      'listProjects',
      'createProject',
      '/v1/',
      'fetch',
      'credential',
      'Authorization',
      'mcp',
      'plugin',
      'hook',
      'PreToolUse',
      'retry',
    ]) {
      expect(`the lifecycle reaches for ${forbidden}:${code.includes(forbidden)}`).toBe(
        `the lifecycle reaches for ${forbidden}:false`,
      );
    }

    // It also does not read what a Problem says about itself in order to guess
    // which one a conversation is about. A title compared, symptoms hashed or a
    // list sorted would each be this module deciding the one thing it exists to
    // refuse to decide.
    for (const forbidden of [
      '.title',
      'symptoms',
      '.sort(',
      'localeCompare',
      'newest',
      'created_at',
      'similar',
    ]) {
      expect(`the lifecycle reaches for ${forbidden}:${code.includes(forbidden)}`).toBe(
        `the lifecycle reaches for ${forbidden}:false`,
      );
    }
  });

  it('decides what a resume is from the one list that says so', async () => {
    const shipped = await sourcesOf('claude-code-adapter');
    const lifecycle = shipped.find((file) => file.path === 'src/problem-lifecycle.ts');
    const code = codeOnly(lifecycle?.source ?? '');

    // The subset is checked at runtime and not merely declared, because the
    // type does not survive to the boundary where a status arrives as text —
    // and the two states this refuses are *legal* moves from PAUSED, so nothing
    // downstream would have stopped one. Closing a Problem and calling the
    // result a resume is the failure, and it is silent.
    expect(code).toContain('function isResumeProblemTargetStatus');
    expect(code).toContain('RESUME_PROBLEM_TARGET_STATUSES as readonly string[]');

    // Derived from that list rather than written beside it: each name appears
    // exactly once in the module, in the constant, so a second condition
    // listing them again would fail here rather than drift from it.
    for (const status of ['INVESTIGATING', 'FIX_CANDIDATE']) {
      expect(`${status} appears ${String(code.split(status).length - 1)} times`).toBe(
        `${status} appears 1 times`,
      );
    }

    // And it reuses the one definition of what a missing Problem looks like.
    // Two copies of "404 and NOT_FOUND" would be two places to widen it into
    // treating an outage as a Problem that no longer exists.
    expect(code).toContain('isProblemGone(error)');
    for (const forbidden of ['404', 'NOT_FOUND', 'error.status', 'error.code']) {
      expect(`the lifecycle reaches for ${forbidden}:${code.includes(forbidden)}`).toBe(
        `the lifecycle reaches for ${forbidden}:false`,
      );
    }
  });

  it('checks a start-new decision against every continuable Problem', async () => {
    const shipped = await sourcesOf('claude-code-adapter');
    const lifecycle = shipped.find((file) => file.path === 'src/problem-lifecycle.ts');
    const code = codeOnly(lifecycle?.source ?? '');

    // The one that is easy to get wrong and quiet when it is. Resolving with a
    // binding hint short-circuits on the Problem this session is already on and
    // never enumerates the rest — which is right for "which Problem am I on"
    // and precisely wrong for "is my judgement that this is a *new* Problem
    // still safe", because the Problem that would change that judgement is some
    // other Problem.
    expect(code).toContain('await resolveCurrentProblem(client, input.projectId)');

    // And the note is never removed. A stale hint is revalidated per call and
    // replaced by the next write; deleting one would only add a way for a
    // working session to lose its place because a Memory was briefly away.
    for (const forbidden of ['removeBinding', 'unlink', 'ProblemBindingRemoval']) {
      expect(`the lifecycle reaches for ${forbidden}:${code.includes(forbidden)}`).toBe(
        `the lifecycle reaches for ${forbidden}:false`,
      );
    }
  });

  it('never forgets a binding anywhere in the package', async () => {
    const shipped = (await sourcesOf('claude-code-adapter')).filter((file) =>
      file.path.startsWith('src/'),
    );

    // The store offers a removal because forgetting is a thing a store must be
    // able to do. Nothing in this package has decided that it should, and the
    // decision needs the Memory's answer about a Problem — which is knowledge
    // the store deliberately does not have.
    for (const { path, source } of shipped) {
      if (path === 'src/problem-binding-store.ts' || path === 'src/index.ts') {
        continue;
      }
      const code = codeOnly(source);
      expect(`${path} calls removeBinding:${code.includes('removeBinding')}`).toBe(
        `${path} calls removeBinding:false`,
      );
    }
  });

  it('captures an environment without learning where it is sent', async () => {
    const shipped = await sourcesOf('claude-code-adapter');
    const capture = shipped.find((file) => file.path === 'src/environment-capture.ts');
    expect(capture).toBeDefined();
    const code = codeOnly(capture?.source ?? '');

    // It runs git in a directory and returns what it read. Where that goes,
    // and what it is attached to, are questions it has no way to answer and no
    // reason to ask.
    for (const forbidden of [
      'fetch',
      'MemoryApi',
      'credential',
      'Authorization',
      '/v1/',
      'process.env',
      'process.cwd',
      'sessionId',
      'session_id',
      'mcp',
      'plugin',
      'hook',
      'BindingStore',
      'get-url',
      'remote',
      'config',
      'stderr',
    ]) {
      expect(`capture reaches for ${forbidden}:${code.includes(forbidden)}`).toBe(
        `capture reaches for ${forbidden}:false`,
      );
    }
  });

  it('starts a Problem without deciding that one should be started', async () => {
    const shipped = await sourcesOf('claude-code-adapter');
    const start = shipped.find((file) => file.path === 'src/problem-start.ts');
    expect(start).toBeDefined();
    const code = codeOnly(start?.source ?? '');

    // It is the mutation and none of the judgement. Detecting a Project,
    // enumerating candidates, weighing whether this is really a new Problem,
    // remembering the answer — each belongs to the composition above it, and a
    // primitive that did any of them would be deciding with the least context.
    for (const forbidden of [
      'detectProjectSignals',
      'resolveProject',
      'resolveCurrentProblem',
      'listProblems',
      'listProjects',
      'BindingStore',
      'readBinding',
      'writeBinding',
      'sessionId',
      'session_id',
      'process.env',
      'process.cwd',
      'node:fs',
      'mcp',
      'plugin',
      'hook',
      'retry',
      'createProject',
      'transitionProblemStatus',
    ]) {
      expect(`start reaches for ${forbidden}:${code.includes(forbidden)}`).toBe(
        `start reaches for ${forbidden}:false`,
      );
    }

    // And it does not take provenance from the model-owned input. The separate
    // runtime value is established by the authenticated host edge.
    expect(code).toContain('source_ai: runtimeSourceAi(runtimeProvenance)');
    expect(code).not.toContain('source_ai: input.');
  });

  it('registers a Project without learning anything about Problems', async () => {
    const shipped = await sourcesOf('claude-code-adapter');
    const outcome = shipped.find((file) => file.path === 'src/project-outcome.ts');
    expect(outcome).toBeDefined();
    const code = codeOnly(outcome?.source ?? '');

    // It reads Projects and creates one. Which Problem a session is on, where a
    // binding lives, what a session identifier is — none of that is a question
    // it can answer or has any reason to ask, and a module that reached for one
    // would be the place those decisions went to hide.
    for (const forbidden of [
      'Problem',
      'BindingStore',
      'sessionId',
      'session_id',
      'Environment',
      'node:fs',
      'node:path',
      'process.env',
      'process.cwd',
      '/v1/',
      'credential',
      'Authorization',
      'mcp',
      'plugin',
      'hook',
    ]) {
      expect(`registration reaches for ${forbidden}:${code.includes(forbidden)}`).toBe(
        `registration reaches for ${forbidden}:false`,
      );
    }

    // And it never settles an ambiguity itself.
    for (const forbidden of ['.sort(', '[0]', 'created_at', 'localeCompare', 'newest']) {
      expect(`registration uses ${forbidden}:${code.includes(forbidden)}`).toBe(
        `registration uses ${forbidden}:false`,
      );
    }
  });

  it('shares one description of a new Project, and offers it to nobody else', async () => {
    const shipped = await sourcesOf('claude-code-adapter');
    const outcome = shipped.find((file) => file.path === 'src/project-outcome.ts');
    const index = shipped.find((file) => file.path === 'src/index.ts');
    const code = codeOnly(outcome?.source ?? '');

    // Two modules now need the same answer to "what would we call this Project
    // and what would we record on it", so there is one definition and the
    // second module imports it. A copy here would agree until one of them was
    // extended, and then disagree silently.
    expect(code).toContain('suggestionFor(signals)');
    for (const forbidden of ['projectNameHint:', 'primaryRemote:', 'monorepoSubpath:']) {
      expect(`registration rebuilds ${forbidden}:${code.includes(forbidden)}`).toBe(
        `registration rebuilds ${forbidden}:false`,
      );
    }

    // Sharing between two implementation modules is not the same as offering a
    // capability. Nothing outside this package has asked what a suggestion is,
    // and an export is far easier to add than to take back.
    expect(
      `the package exports suggestionFor:${codeOnly(index?.source ?? '').includes('suggestionFor')}`,
    ).toBe('the package exports suggestionFor:false');
  });

  it('creates against exactly one ambiguity, and proves a write by the same rule', async () => {
    const shipped = await sourcesOf('claude-code-adapter');
    const outcome = shipped.find((file) => file.path === 'src/project-outcome.ts');
    const code = codeOnly(outcome?.source ?? '');
    const flattened = code.replace(/\s+/gu, ' ');

    // One ambiguity is a question with a second legitimate answer. A choice
    // does not turn the others into one — a tie is a duplicate to merge, a
    // secondary remote is another repository, a name is not an identity.
    expect(flattened).toContain(
      "resolution.reason === 'NO_MATCHING_REPO_BOUNDARY' && choice !== undefined",
    );

    // And both reads that ask "did a covering Project appear" accept the same
    // proof. An answer that is still NO_MATCHING is the answer from before the
    // request, so reading it as recovery would turn an unknown write into an
    // ordinary outcome.
    expect(
      `ambiguity accepted as proof: ${String(
        (flattened.match(/after\.reason === 'MULTIPLE_PROJECTS_FOR_REMOTE'/gu) ?? []).length,
      )}`,
    ).toBe('ambiguity accepted as proof: 2');
    expect(
      `bare ambiguity accepted: ${flattened.includes("if (after.kind === 'AMBIGUOUS') {")}`,
    ).toBe('bare ambiguity accepted: false');
  });

  it('reads the world again before it writes to it', async () => {
    const shipped = await sourcesOf('claude-code-adapter');
    const outcome = shipped.find((file) => file.path === 'src/project-outcome.ts');
    const code = codeOnly(outcome?.source ?? '');

    // Creating a second Project for one repository is invisible afterwards, so
    // both entry points resolve at the moment they are called. A version that
    // took an earlier resolution as an argument would let a caller act on an
    // answer from a previous turn, which is exactly the race this closes.
    expect(code).toContain('resolveProject(client, signals)');

    // Read against collapsed whitespace so a parameter can be told apart from a
    // field of the same name: `candidates` is a legitimate part of the answer
    // registration returns, and only illegitimate as something it is handed.
    const flattened = code.replace(/\s+/gu, ' ');
    for (const forbidden of [
      'resolution: ProjectResolution,',
      'previousResolution',
      'candidates: readonly ProjectCandidate[], ): Promise',
    ]) {
      expect(`registration accepts ${forbidden}:${flattened.includes(forbidden)}`).toBe(
        `registration accepts ${forbidden}:false`,
      );
    }
  });

  it('tells failures apart by class, never by what they call themselves', async () => {
    const shipped = await sourcesOf('claude-code-adapter');
    const outcome = shipped.find((file) => file.path === 'src/project-outcome.ts');
    const code = codeOnly(outcome?.source ?? '');

    // Exactly one failure may be recovered from, and only the client's own
    // class means it. A name, a message or a constructor name is prose that any
    // error can carry, so a check against one would let an unrelated failure
    // enter recovery and come back out as an ordinary Project outcome.
    expect(code).toContain('error instanceof MemoryApiUnreachableError');
    for (const forbidden of ['.name ===', 'constructor.name', 'error.message', 'error.code']) {
      expect(`registration classifies by ${forbidden}:${code.includes(forbidden)}`).toBe(
        `registration classifies by ${forbidden}:false`,
      );
    }
  });

  it('says only what a caller needs, in a shape that is written down', async () => {
    const shipped = await sourcesOf('claude-code-adapter');
    const outcome = shipped.find((file) => file.path === 'src/project-outcome.ts');
    const flattened = codeOnly(outcome?.source ?? '').replace(/\s+/gu, ' ');

    // These two unions are the whole outward contract, so they are pinned whole
    // rather than sampled. A field is how a leak arrives: `repo` or a raw
    // resource added to an answer would be inert on the day it appeared —
    // nothing populates it, no assertion changes — and would carry repository
    // text out of the adapter the first time somebody filled it in. Pinning the
    // shape makes that a decision somebody has to make here, in the open.
    expect(flattened).toContain(
      'export type ProjectRegistrationResult = ' +
        "| { readonly kind: 'CREATED'; readonly projectId: string } " +
        "| { readonly kind: 'RESOLVED'; readonly projectId: string } " +
        "| { readonly kind: 'AMBIGUOUS'; readonly reason: ProjectAmbiguityReason; " +
        'readonly candidates: readonly ProjectCandidate[]; } ' +
        "| { readonly kind: 'BOUNDARY_REQUIRED'; readonly suggestion: ProjectSuggestion } " +
        "| { readonly kind: 'EXPLICIT_REGISTRATION_REQUIRED'; " +
        'readonly suggestion: ProjectSuggestion } ' +
        "| { readonly kind: 'NO_PROJECT_SIGNAL' };",
    );
    expect(flattened).toContain(
      'export type ProjectSelectionResult = ' +
        "| { readonly kind: 'SELECTED'; readonly projectId: string } " +
        "| { readonly kind: 'SELECTION_STALE'; readonly resolution: ProjectResolution };",
    );
  });

  it('keeps the resolver a read', async () => {
    const shipped = await sourcesOf('claude-code-adapter');
    const resolver = shipped.find((file) => file.path === 'src/project-resolution.ts');
    const code = codeOnly(resolver?.source ?? '');

    // Registration consumes what the resolver decided. The resolver writing
    // anything would make "what is true" and "what to do about it" one step,
    // and the recheck above would have nothing to recheck.
    for (const forbidden of ['createProject', 'updateProject', 'ProjectRegistration']) {
      expect(`the resolver reaches for ${forbidden}:${code.includes(forbidden)}`).toBe(
        `the resolver reaches for ${forbidden}:false`,
      );
    }
  });

  it('keeps the binding store free of everything that is not persistence', async () => {
    const shipped = await sourcesOf('claude-code-adapter');
    const store = shipped.find((file) => file.path === 'src/problem-binding-store.ts');
    expect(store).toBeDefined();
    const code = codeOnly(store?.source ?? '');

    // It holds three identities and a file. Reaching the Memory, reading the
    // host's environment, or deciding whether a binding *should* exist are each
    // somebody else's question, and a store that answered one would be the
    // place those decisions went to hide.
    for (const forbidden of [
      'fetch',
      'MemoryApi',
      'credential',
      'Authorization',
      'process.env',
      'CLAUDE_PLUGIN',
      'CLAUDE_PROJECT_DIR',
      'homedir',
      '.claude',
      'resolveCurrentProblem',
      'ProblemResource',
      'INVESTIGATING',
      'PAUSED',
      'mcp',
      'hook',
    ]) {
      expect(`the store reaches for ${forbidden}:${code.includes(forbidden)}`).toBe(
        `the store reaches for ${forbidden}:false`,
      );
    }

    // And it does not sweep, prune or expire anything. A stale binding is tiny
    // and is revalidated against the server whenever it is used; a store that
    // aged them out would be deleting the state resume continuity depends on.
    for (const forbidden of ['readdir', 'TTL', 'prune', 'expire', 'Date.now', 'maxAge']) {
      expect(`the store reaches for ${forbidden}:${code.includes(forbidden)}`).toBe(
        `the store reaches for ${forbidden}:false`,
      );
    }
  });

  it('decides a repository boundary from what the owner stored, not from a path', async () => {
    const shipped = await sourcesOf('claude-code-adapter');
    const resolver = shipped.find((file) => file.path === 'src/project-resolution.ts');
    expect(resolver).toBeDefined();
    const code = codeOnly(resolver?.source ?? '');

    // The boundary now participates in identity, which makes it exactly the
    // place an absolute path would be tempting. It reads one field the server
    // stored and compares it against one field the detector produced; nothing
    // here touches a filesystem, resolves a path, or reads where the process
    // happens to be.
    for (const forbidden of [
      'node:path',
      'node:fs',
      'process.cwd',
      'process.env',
      'resolve(',
      'normalize(',
      'homedir',
      'projectDir',
      'CLAUDE_PROJECT_DIR',
    ]) {
      expect(`the resolver reaches for ${forbidden}:${code.includes(forbidden)}`).toBe(
        `the resolver reaches for ${forbidden}:false`,
      );
    }

    // And it still refuses to break a tie by anything but the owner's own
    // declaration: no ordering, no age, no name.
    for (const forbidden of ['.sort(', 'created_at', 'updated_at', 'localeCompare']) {
      expect(`the resolver uses ${forbidden}:${code.includes(forbidden)}`).toBe(
        `the resolver uses ${forbidden}:false`,
      );
    }
  });

  it('keeps the boundary a repository-relative value, wherever it is written', async () => {
    const shipped = (await sourcesOf('claude-code-adapter')).filter((file) =>
      file.path.startsWith('src/'),
    );

    // A second place mapping locations to Projects is the thing this feature
    // exists to avoid: the server holds the owner's decision, and a local map
    // beside it would be a rival authority that no other assistant can see.
    for (const { path, source } of shipped) {
      const code = codeOnly(source);
      for (const forbidden of ['monorepoMap', 'projectMap', 'boundaryCache', 'pathToProject']) {
        expect(`${path} builds a ${forbidden}:${code.includes(forbidden)}`).toBe(
          `${path} builds a ${forbidden}:false`,
        );
      }
    }
  });

  it('does not decide which Problem a conversation is about', async () => {
    const shipped = await sourcesOf('claude-code-adapter');
    const resolver = shipped.find((file) => file.path === 'src/problem-resolution.ts');
    expect(resolver).toBeDefined();
    const code = codeOnly(resolver?.source ?? '');

    // The shortcuts that would each turn a list into an answer. Sorting is the
    // visible one; the other three are the ones that look like reasonable code
    // and are the same mistake — a count, a position, or a comparison of what
    // two Problems say about themselves.
    for (const forbidden of [
      '.sort(',
      'length === 1',
      'length == 1',
      '[0]',
      '.at(0)',
      'toLowerCase',
      '.includes(candidate',
      'similar',
    ]) {
      expect(`the resolver uses ${forbidden}:${code.includes(forbidden)}`).toBe(
        `the resolver uses ${forbidden}:false`,
      );
    }
  });

  it('has no protocol code, no hook and no Skill', async () => {
    const shipped = (await sourcesOf('claude-code-adapter')).filter((file) =>
      file.path.startsWith('src/'),
    );

    // P5-03 needed none of them: the project root arrives as an argument, and
    // reading it from the environment is the composition's job in a later task.
    // Adding an SDK now would pin a version against code that does not exist.
    for (const { path, source } of shipped) {
      const code = codeOnly(source);
      for (const forbidden of [
        'modelcontextprotocol',
        'McpServer',
        'StdioServerTransport',
        'SKILL.md',
        'hooks',
        'CLAUDE_PROJECT_DIR',
      ]) {
        expect(`${path} has ${forbidden}:${code.includes(forbidden)}`).toBe(
          `${path} has ${forbidden}:false`,
        );
      }
    }
  });

  it('anchors a Project on the root it was given, never on the working directory', async () => {
    const detector = (await sourcesOf('claude-code-adapter')).find(
      (file) => file.path === 'src/project-signals.ts',
    );
    expect(detector).toBeDefined();
    const code = codeOnly(detector?.source ?? '');

    // The root arrives as an argument and every git invocation runs against it.
    // `process.cwd()` would make a `cd` change which Project a session belongs to
    // — and the Problem being worked on would follow it.
    expect(code).toContain('input.projectDir');
    for (const forbidden of ['process.cwd', 'process.env', "cwd: '.'"]) {
      expect(`detector uses ${forbidden}:${code.includes(forbidden)}`).toBe(
        `detector uses ${forbidden}:false`,
      );
    }
    // No shell anywhere on this path: arguments are an array, and a project root
    // is a value from the environment.
    expect(code).toContain('shell: false');
    expect(`detector builds a command line:${code.includes('exec(')}`).toBe(
      'detector builds a command line:false',
    );
  });

  it('keeps a raw remote inside the one function that converts it', async () => {
    const shipped = (await sourcesOf('claude-code-adapter')).filter((file) =>
      file.path.startsWith('src/'),
    );

    // A remote URL may carry a credential and `git remote get-url` returns it
    // verbatim, so the canonical form is where that value dies. Only the module
    // that performs the conversion may name `get-url`, and nothing anywhere may
    // read git's stderr, which carries remote URLs in its own messages.
    const readers = shipped
      .filter((file) => codeOnly(file.source).includes('get-url'))
      .map((file) => file.path);
    expect(readers).toEqual(['src/project-signals.ts']);

    for (const { path, source } of shipped) {
      const code = codeOnly(source);
      expect(`${path} reads stderr:${code.includes('stderr')}`).toBe(`${path} reads stderr:false`);
    }
  });

  it('creates no Project and asks nobody anything', async () => {
    const shipped = (await sourcesOf('claude-code-adapter')).filter((file) =>
      file.path.startsWith('src/'),
    );

    // Detection resolves and reports; creating a Project is a long-lived record
    // and belongs to whatever consumes those outcomes. That consumer now exists
    // and is exactly one module, so `createProject` is narrowed to it rather
    // than dropped — anywhere else it would still mean detection had started
    // writing.
    //
    // Asking a question stays forbidden everywhere, including there. These
    // primitives return typed material; putting a question to somebody belongs
    // to the composition, and a module that grew a prompt would be settling in
    // code what belongs in a conversation.
    for (const { path, source } of shipped) {
      const code = codeOnly(source);
      const writesProjects = path === 'src/project-outcome.ts';
      const forbidden = writesProjects
        ? ['prompt', 'readline', 'confirm(']
        : ['createProject', 'prompt', 'readline', 'confirm('];
      for (const term of forbidden) {
        expect(`${path} does ${term}:${code.includes(term)}`).toBe(`${path} does ${term}:false`);
      }
    }
  });

  it('never resolves a Project from a secondary remote or a name alone', async () => {
    const resolver = (await sourcesOf('claude-code-adapter')).find(
      (file) => file.path === 'src/project-resolution.ts',
    );
    const code = codeOnly(resolver?.source ?? '');

    // Both are the silent-false-merge cases: a fork whose upstream is recorded,
    // and two unrelated directories with the same name. Each must reach
    // `AMBIGUOUS`, and the ordering that makes that true is read positionally.
    const secondaryAt = code.indexOf('secondaryRemotes');
    const nameAt = code.indexOf('project_name === signals.projectNameHint');
    expect(secondaryAt).toBeGreaterThan(-1);
    expect(nameAt).toBeGreaterThan(-1);
    expect(code.slice(secondaryAt).includes("'ONLY_SECONDARY_REMOTE_MATCHED'")).toBe(true);
    expect(code.slice(nameAt).includes("'NAME_ONLY_MATCH'")).toBe(true);

    // And nothing sorts or slices a candidate list into a single answer.
    for (const forbidden of ['.sort(', 'created_at >', 'candidates[0]', 'at(0)']) {
      expect(`${forbidden}:${code.includes(forbidden)}`).toBe(`${forbidden}:false`);
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
