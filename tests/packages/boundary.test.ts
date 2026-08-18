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

  it('exposes two methods and no way around them', async () => {
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
    expect(code).toContain('search(problemId: string, request: MemorySearchRequest)');

    // Four, and no fifth by accident. The writes are absent on purpose: nothing
    // creates a Project, a Problem or an Environment yet, and nothing moves a
    // Problem between statuses, so a method for any of them would be a guess
    // about how it will be called.
    for (const absent of [
      'createProject',
      'getProject',
      'updateProject',
      'createProblem',
      'updateProblem',
      'createEnvironment',
      'transitionProblemStatus',
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

describe('the Claude adapter, still', () => {
  it('has not started searching, or injecting itself into a search', async () => {
    const shipped = (await sourcesOf('claude-code-adapter')).filter((file) =>
      file.path.startsWith('src/'),
    );
    expect(shipped.length).toBeGreaterThan(0);

    // The adapter returns the client it built, so `search()` reached it for free
    // the moment the client grew one. What it must not have grown is *policy*:
    // when to search, what `source_ai` to send, how to present a result. Each of
    // those is a later task with its own decisions, and doing any of them here
    // would settle them by accident.
    for (const { path, source } of shipped) {
      const code = codeOnly(source);
      for (const forbidden of ['.search(', 'autoSearch', 'sourceAi:', 'source_ai']) {
        expect(`${path} does ${forbidden}:${code.includes(forbidden)}`).toBe(
          `${path} does ${forbidden}:false`,
        );
      }
    }
  });

  it('resolves a current Problem without keeping anything between calls', async () => {
    const shipped = (await sourcesOf('claude-code-adapter')).filter((file) =>
      file.path.startsWith('src/'),
    );

    // A binding arrives as an argument and leaves with the call. Where one is
    // stored, how long it lives, and what a session identifier has to do with
    // it are a later task's questions — and a resolver that reached for a file
    // or a session id would settle them here, quietly, in the module least
    // suited to owning them.
    for (const { path, source } of shipped) {
      const code = codeOnly(source);
      for (const forbidden of [
        'node:fs',
        'writeFile',
        'readFile',
        'sessionId',
        'session_id',
        'CLAUDE_SESSION',
      ]) {
        expect(`${path} reaches for ${forbidden}:${code.includes(forbidden)}`).toBe(
          `${path} reaches for ${forbidden}:false`,
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

    // P5-03 resolves and reports. Creating a Project is a long-lived record and
    // asking a question interrupts somebody; both belong to whatever consumes
    // these outcomes, and neither is settled here by accident.
    for (const { path, source } of shipped) {
      const code = codeOnly(source);
      for (const forbidden of ['createProject', 'prompt', 'readline', 'confirm(']) {
        expect(`${path} does ${forbidden}:${code.includes(forbidden)}`).toBe(
          `${path} does ${forbidden}:false`,
        );
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
