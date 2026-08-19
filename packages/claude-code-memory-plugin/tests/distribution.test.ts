/**
 * The plugin as somebody else receives it.
 *
 * An install copies this directory and nothing around it. So every proof here
 * is run against a *copy* placed somewhere with no `node_modules`, no sibling
 * packages and no repository above it, from a working directory outside the
 * checkout. A test that ran in the monorepo could pass through workspace
 * resolution alone and would say nothing at all about distribution — which is
 * exactly the failure this task exists to prevent.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';

import { CALL_CONTEXT_DIRECTORY, hostToolName, MEMORY_TOOLS } from '../src/runtime-constants.js';
import { buildMemoryMcpServer } from '../src/server.js';

const run = promisify(execFile);

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const CALL_ID = 'toolu_01DISTRIBUTIONAAAAAAAAAA';

/** Everything that must arrive with the copy for it to run at all. */
const REQUIRED = [
  '.claude-plugin/plugin.json',
  '.mcp.json',
  'hooks/hooks.json',
  'bundle/server.js',
  'bundle/pre-tool-use.js',
];

let installed: string;
let elsewhere: string;

/** A copy of only the plugin directory, the way an install makes one. */
beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'installed-plugin-'));
  installed = join(root, 'problem-solving-memory');
  elsewhere = await mkdtemp(join(tmpdir(), 'unrelated-cwd-'));

  await cp(PACKAGE_ROOT, installed, {
    recursive: true,
    // What an install would not carry: dependencies, development build output,
    // and the sources and tests that are not part of what runs.
    filter: (source) => {
      const relative = source
        .slice(PACKAGE_ROOT.length + 1)
        .split(sep)
        .join('/');
      return !(
        relative.startsWith('node_modules') ||
        relative.startsWith('dist') ||
        relative.startsWith('tests')
      );
    },
  });
}, 120_000);

afterAll(async () => {
  await rm(join(installed, '..'), { recursive: true, force: true });
  await rm(elsewhere, { recursive: true, force: true });
});

describe('a plugin directory copied away from the repository', () => {
  it('carries everything the host needs to load it', async () => {
    for (const path of REQUIRED) {
      const present = await stat(join(installed, ...path.split('/')))
        .then(() => true)
        .catch(() => false);
      expect(`${path} arrived with the copy:${present}`).toBe(`${path} arrived with the copy:true`);
    }
  });

  it('brings no dependencies with it, and needs none', async () => {
    for (const absent of ['node_modules', 'dist']) {
      const present = await stat(join(installed, absent))
        .then(() => true)
        .catch(() => false);
      expect(`${absent} was copied:${present}`).toBe(`${absent} was copied:false`);
    }
  });

  it('points its runtime only at paths inside itself', async () => {
    const mcp = await readFile(join(installed, '.mcp.json'), 'utf8');
    const hooks = await readFile(join(installed, 'hooks/hooks.json'), 'utf8');

    for (const configuration of [mcp, hooks]) {
      expect(configuration).toContain('${CLAUDE_PLUGIN_ROOT}/bundle/');
      // `dist/` is development build output and is not part of a release; a
      // path leaving the plugin root cannot survive the copy at all.
      expect(`reaches for dist:${configuration.includes('/dist/')}`).toBe('reaches for dist:false');
      expect(`climbs out of the plugin:${configuration.includes('..')}`).toBe(
        'climbs out of the plugin:false',
      );
    }
  });

  it('asks nobody to install anything before it will run', async () => {
    const manifests = await Promise.all(
      ['.mcp.json', 'hooks/hooks.json', '.claude-plugin/plugin.json'].map((path) =>
        readFile(join(installed, ...path.split('/')), 'utf8'),
      ),
    );

    // An install step would be a second chance to fail on somebody else's
    // machine, in a place they cannot see. The bundle exists so there is none.
    for (const forbidden of ['npm install', 'npm ci', 'yarn', 'pnpm', 'tsc', 'node_modules']) {
      const named = manifests.some((text) => text.includes(forbidden));
      expect(`the install asks for ${forbidden}:${named}`).toBe(
        `the install asks for ${forbidden}:false`,
      );
    }
  });
});

/** Drives the copied server over stdio, from a directory that is not ours. */
async function driveInstalledServer(requests: readonly unknown[]): Promise<{
  replies: Record<string, unknown>[];
  stderr: string;
  nonProtocol: string[];
}> {
  const { spawn } = await import('node:child_process');
  const data = await mkdtemp(join(tmpdir(), 'installed-data-'));
  const projectDir = await mkdtemp(join(tmpdir(), 'installed-root-'));

  const child = spawn('node', [join(installed, 'bundle', 'server.js')], {
    // Deliberately outside the repository: resolution must not be able to
    // find the workspace by walking up from here.
    cwd: elsewhere,
    env: {
      ...process.env,
      MEMORY_CLAUDE_PROJECT_DIR: projectDir,
      MEMORY_CLAUDE_PLUGIN_DATA: data,
      MEMORY_API_TOKEN: undefined,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const replies: Record<string, unknown>[] = [];
  const nonProtocol: string[] = [];
  let stderr = '';
  let buffer = '';

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => (stderr += chunk));

  const settled = new Promise<void>((resolve) => {
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line === '') continue;
        try {
          replies.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          nonProtocol.push(line);
        }
      }
      if (replies.length >= requests.length) resolve();
    });
  });

  for (const request of requests) {
    child.stdin.write(`${JSON.stringify(request)}\n`);
  }

  await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, 30_000))]);
  child.kill();
  await rm(data, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });

  return { replies, stderr, nonProtocol };
}

describe('the server, run from the installed copy', () => {
  it('starts, lists exactly the four tools, and resolves every import', async () => {
    const { replies, stderr, nonProtocol } = await driveInstalledServer([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2026-07-28',
          capabilities: {},
          clientInfo: { name: 'installed', version: '0' },
        },
      },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ]);

    // A missing package would be a start-up crash, so this assertion is the
    // dependency-closure proof at the only place it matters: somebody else's
    // machine, with nothing installed.
    expect(`the server wrote to stderr:${stderr.length > 0}`).toBe(
      'the server wrote to stderr:false',
    );
    expect(nonProtocol).toEqual([]);

    const listed = replies.find((reply) => reply['id'] === 2);
    const tools = (listed?.['result'] as { tools?: { name: string }[] } | undefined)?.tools ?? [];
    expect(tools.map((tool) => tool.name)).toEqual([...MEMORY_TOOLS]);
  }, 60_000);

  it('refuses all four without host context, exactly as the source runtime does', async () => {
    const calls = [
      { name: 'current_problem', arguments: {} },
      { name: 'continue_problem', arguments: { project_id: 'p', problem_id: 'q' } },
      {
        name: 'resume_problem',
        arguments: { project_id: 'p', problem_id: 'q', target_status: 'INVESTIGATING' },
      },
      { name: 'start_problem', arguments: { project_id: 'p', title: 't', symptoms: 's' } },
    ];

    const { replies } = await driveInstalledServer([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2026-07-28',
          capabilities: {},
          clientInfo: { name: 'installed', version: '0' },
        },
      },
      ...calls.map((params, index) => ({
        jsonrpc: '2.0',
        id: index + 2,
        method: 'tools/call',
        params,
      })),
    ]);

    for (const [index, call] of calls.entries()) {
      const reply = replies.find((one) => one['id'] === index + 2);
      const structured = (reply?.['result'] as { structuredContent?: unknown } | undefined)
        ?.structuredContent;
      expect(`${call.name}:${JSON.stringify(structured)}`).toBe(
        `${call.name}:{"kind":"ERROR","code":"HOST_CONTEXT_UNAVAILABLE"}`,
      );
    }
  }, 60_000);
});

describe('the hook, run from the installed copy', () => {
  /** Runs the copied hook on one event, from a directory that is not ours. */
  async function runInstalledHook(event: Record<string, unknown>): Promise<{
    stdout: string;
    stderr: string;
    data: string;
  }> {
    const data = await mkdtemp(join(tmpdir(), 'installed-hook-data-'));
    const projectDir = await mkdtemp(join(tmpdir(), 'installed-hook-root-'));
    const { spawn } = await import('node:child_process');

    const child = spawn('node', [join(installed, 'bundle', 'pre-tool-use.js')], {
      cwd: elsewhere,
      env: {
        ...process.env,
        // The hook is launched by the host itself, so it reads the host's own
        // variable rather than the one .mcp.json maps for the server.
        CLAUDE_PLUGIN_DATA: data,
        CLAUDE_PROJECT_DIR: projectDir,
        MEMORY_API_TOKEN: undefined,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.stdin.end(JSON.stringify(event));

    await new Promise<void>((resolve) => child.on('close', () => resolve()));
    await rm(projectDir, { recursive: true, force: true });

    return { stdout, stderr, data };
  }

  it('mints one context for a main-session call, naming that exact tool', async () => {
    const toolName = hostToolName('continue_problem');
    const { stdout, stderr, data } = await runInstalledHook({
      session_id: SESSION_ID,
      tool_name: toolName,
      tool_use_id: CALL_ID,
      hook_event_name: 'PreToolUse',
      tool_input: {},
    });

    expect(`the hook wrote to stderr:${stderr.length > 0}`).toBe('the hook wrote to stderr:false');

    const decision = JSON.parse(stdout) as Record<string, unknown>;
    expect(
      (decision['hookSpecificOutput'] as { permissionDecision?: string } | undefined)
        ?.permissionDecision,
    ).toBe('allow');

    // Nothing is rewritten, and nothing secret is printed.
    for (const forbidden of ['updatedInput', '_memory_host_proof', SESSION_ID, CALL_ID, data]) {
      expect(`the decision carries ${forbidden}:${stdout.includes(forbidden)}`).toBe(
        `the decision carries ${forbidden}:false`,
      );
    }

    const minted = await readdir(join(data, CALL_CONTEXT_DIRECTORY));
    expect(minted).toHaveLength(1);
    const record = JSON.parse(
      await readFile(join(data, CALL_CONTEXT_DIRECTORY, minted[0] as string), 'utf8'),
    ) as { tool_name?: string };
    expect(record.tool_name).toBe(toolName);

    await rm(data, { recursive: true, force: true });
  }, 60_000);

  it('mints nothing inside a subagent, and says so', async () => {
    const { stdout, stderr, data } = await runInstalledHook({
      session_id: SESSION_ID,
      tool_name: hostToolName('current_problem'),
      tool_use_id: CALL_ID,
      hook_event_name: 'PreToolUse',
      tool_input: {},
      agent_id: 'a5e40755',
      agent_type: 'general-purpose',
    });

    expect(`the hook wrote to stderr:${stderr.length > 0}`).toBe('the hook wrote to stderr:false');
    const decision = JSON.parse(stdout) as Record<string, unknown>;
    expect(
      (decision['hookSpecificOutput'] as { permissionDecision?: string } | undefined)
        ?.permissionDecision,
    ).toBe('deny');

    const minted = await readdir(join(data, CALL_CONTEXT_DIRECTORY)).catch(() => []);
    expect(minted).toEqual([]);

    await rm(data, { recursive: true, force: true });
  }, 60_000);
});

describe('the committed artifact itself', () => {
  it('holds nothing from the machine that built it', async () => {
    const artifacts = await Promise.all(
      ['bundle/server.js', 'bundle/pre-tool-use.js', 'THIRD_PARTY_NOTICES.txt'].map((path) =>
        readFile(join(PACKAGE_ROOT, ...path.split('/')), 'utf8'),
      ),
    );
    const text = artifacts.join('\n');

    // Configuration *names* belong in a runtime. Values, paths and identities
    // from whoever ran the build do not, and a committed file is forever. The
    // machine's own names are read from this machine rather than written down:
    // a literal username in a tracked file is the very thing being guarded
    // against, and one written here would only ever catch one person.
    for (const forbidden of [
      homedir(),
      basename(homedir()),
      tmpdir(),
      PACKAGE_ROOT,
      '/Users/',
      '/home/',
      'AppData',
      SESSION_ID,
      'toolu_01',
      'memory_test_',
      'postgres://',
      'postgresql://',
      'mem_',
    ]) {
      expect(`the artifact carries ${forbidden}:${text.includes(forbidden)}`).toBe(
        `the artifact carries ${forbidden}:false`,
      );
    }

    // The names themselves are the configuration contract and do belong.
    expect(artifacts[0]).toContain('MEMORY_API_TOKEN');
  });

  it('says in its own first line that it is generated', async () => {
    for (const path of ['bundle/server.js', 'bundle/pre-tool-use.js']) {
      const text = await readFile(join(PACKAGE_ROOT, ...path.split('/')), 'utf8');
      expect(text.startsWith('// Generated file — do not edit directly.')).toBe(true);
      expect(text).toContain('scripts/build-bundle.mjs');
    }
  });

  it('contains exactly the two entrypoints and nothing else', async () => {
    expect((await readdir(join(PACKAGE_ROOT, 'bundle'))).sort()).toEqual([
      'pre-tool-use.js',
      'server.js',
    ]);
  });

  it('is what the source builds today, byte for byte', async () => {
    // The one check that makes a committed runtime trustworthy: it fails when
    // source, a dependency or a build option moved and the artifact did not.
    const built = await run(
      process.execPath,
      [join(PACKAGE_ROOT, 'scripts', 'build-bundle.mjs'), '--check'],
      {
        cwd: PACKAGE_ROOT,
      },
    );

    expect(built.stderr).toBe('');
    expect(built.stdout).toContain('up to date');
  }, 180_000);

  it('builds the same bytes twice running, resolving only Node built-ins', async () => {
    // Two independent builds, each into its own temporary directory, each
    // compared against the committed artifact. If a timestamp, a path or a
    // machine name had reached the bytes, the two would differ; if a package
    // import had survived, neither would be a plugin anybody else could run.
    const rounds: string[] = [];
    while (rounds.length < 2) {
      const built = await run(
        process.execPath,
        [join(PACKAGE_ROOT, 'scripts', 'build-bundle.mjs'), '--check'],
        { cwd: PACKAGE_ROOT },
      );
      expect(built.stderr).toBe('');
      rounds.push(built.stdout);
    }

    expect(rounds[0]).toBe(rounds[1]);

    // Every unresolved import the build graph reported, from both rounds.
    const external = (rounds[0] ?? '')
      .split('\n')
      .filter((line) => line.startsWith('  external: '))
      .flatMap((line) => line.slice('  external: '.length).split(', '))
      .filter((name) => name !== '(none)');

    expect(external.length).toBeGreaterThan(0);
    for (const name of external) {
      expect(`${name} is a Node built-in:${name.startsWith('node:')}`).toBe(
        `${name} is a Node built-in:true`,
      );
    }

    // And the digests the check reported are the committed files' own.
    const digests = (rounds[0] ?? '')
      .split('\n')
      .filter((line) => line.includes('\tup to date\t'))
      .map((line) => line.split('\t'))
      .map(([name, , digest]) => [name ?? '', digest ?? ''] as const);

    expect(digests).toHaveLength(3);

    for (const [name, digest] of digests) {
      const path =
        name === 'THIRD_PARTY_NOTICES.txt'
          ? join(PACKAGE_ROOT, name)
          : join(PACKAGE_ROOT, 'bundle', name);
      const committed = createHash('sha256')
        .update(await readFile(path))
        .digest('hex');
      expect(`${name}:${committed}`).toBe(`${name}:${digest}`);
    }
  }, 300_000);
});

describe('the distribution catalog', () => {
  const marketplacePath = join(PACKAGE_ROOT, '..', '..', '.claude-plugin', 'marketplace.json');

  it('offers exactly this one plugin, from exactly its own directory', async () => {
    const catalog = JSON.parse(await readFile(marketplacePath, 'utf8')) as {
      name?: string;
      owner?: unknown;
      plugins?: { name?: string; source?: unknown; version?: unknown }[];
    };

    expect(catalog.name).toBe('ai-problem-solving-memory');
    expect(catalog.owner).toBeDefined();
    expect(catalog.plugins).toHaveLength(1);
    expect(catalog.plugins?.[0]?.name).toBe('problem-solving-memory');
    expect(catalog.plugins?.[0]?.source).toBe('./packages/claude-code-memory-plugin');
  });

  it('pins no version anywhere, so each commit can be an update', async () => {
    // A version in either manifest takes precedence over the git commit SHA the
    // host would otherwise use. Left at a fixed number while the work is still
    // moving, every later commit would install as the same version and nobody
    // would receive a change.
    const catalog = JSON.parse(await readFile(marketplacePath, 'utf8')) as {
      plugins?: Record<string, unknown>[];
    };
    const manifest = JSON.parse(
      await readFile(join(PACKAGE_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'),
    ) as Record<string, unknown>;

    expect(`the plugin manifest pins a version:${'version' in manifest}`).toBe(
      'the plugin manifest pins a version:false',
    );
    expect(`the catalog entry pins a version:${'version' in (catalog.plugins?.[0] ?? {})}`).toBe(
      'the catalog entry pins a version:false',
    );
  });

  it('keeps the npm package version out of it entirely', async () => {
    // The workspace package number is private build metadata and is not what
    // Claude Code resolves a plugin version from.
    const npmManifest = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      version?: string;
      private?: boolean;
    };

    expect(npmManifest.version).toBe('0.0.0');
    expect(npmManifest.private).toBe(true);
  });
});

describe('the bundle is the source runtime, not another one', () => {
  /** The tools as the SOURCE server publishes them, in this process. */
  async function sourceTools(): Promise<unknown[]> {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const data = await mkdtemp(join(tmpdir(), 'source-data-'));
    const projectDir = await mkdtemp(join(tmpdir(), 'source-root-'));

    const server = buildMemoryMcpServer({
      environment: {
        MEMORY_CLAUDE_PROJECT_DIR: projectDir,
        MEMORY_CLAUDE_PLUGIN_DATA: data,
      },
      now: () => 1_800_000_000_000,
    });
    await server.connect(serverSide);

    const replies = new Map<number, (message: unknown) => void>();
    clientSide.onmessage = (message): void => {
      const id = (message as { id?: number }).id;
      const waiting = id === undefined ? undefined : replies.get(id);
      if (id !== undefined && waiting !== undefined) {
        replies.delete(id);
        waiting(message);
      }
    };
    await clientSide.start();

    let nextId = 1;
    const request = async (method: string, params: unknown): Promise<Record<string, unknown>> => {
      const id = nextId++;
      const answered = new Promise<Record<string, unknown>>((resolve) =>
        replies.set(id, (message) => resolve(message as Record<string, unknown>)),
      );
      await clientSide.send({ jsonrpc: '2.0', id, method, params } as never);
      return answered;
    };

    await request('initialize', {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'source', version: '0' },
    });
    await clientSide.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as never);

    const listed = await request('tools/list', {});
    await clientSide.close();
    await rm(data, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });

    return (listed['result'] as { tools: unknown[] }).tools;
  }

  it('publishes the same names, descriptions and input schemas', async () => {
    const { replies } = await driveInstalledServer([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2026-07-28',
          capabilities: {},
          clientInfo: { name: 'installed', version: '0' },
        },
      },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ]);

    const bundled = (replies.find((one) => one['id'] === 2)?.['result'] as { tools: unknown[] })
      .tools;

    // The comparison that catches a stale artifact, a wrong entrypoint and a
    // tree-shaking accident in one assertion: whatever the source says today,
    // the thing a user actually runs has to say the same.
    expect(bundled).toEqual(await sourceTools());
  }, 60_000);
});
