/**
 * The state-directory bridge, exercised end to end in one place: what the
 * pointer module writes and refuses, what the server's fallback does with it,
 * and when the hook records one. The bridge exists because the measured Codex
 * MCP child receives no host environment; everything here holds the reader to
 * fail-closed behaviour on every malformed shape.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runPreToolUse } from '../src/pre-tool-use.js';
import { hostToolName } from '../src/runtime-constants.js';
import { runtimeStatePathsOf } from '../src/server.js';
import {
  readStateDirPointer,
  STATE_DIR_POINTER_FORMAT,
  stateDirPointerDirectory,
  stateDirPointerPathFor,
  writeStateDirPointer,
} from '../src/state-dir-pointer.js';

let home: string;
let pluginRoot: string;
let stateDirectory: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'psm-pointer-home-'));
  pluginRoot = join(home, 'cache', 'marketplace', 'plugin', '0.0.0');
  mkdirSync(pluginRoot, { recursive: true });
  stateDirectory = join(home, 'data', 'plugin-state');
  mkdirSync(stateDirectory, { recursive: true });
});

afterEach(() => {
  // The hook tests below run the production write, whose pointer home is the
  // real one; the key is this test's unique temporary root, so removing that
  // one record removes everything those tests created.
  const real = stateDirPointerPathFor(pluginRoot);
  if (real !== undefined) {
    rmSync(real, { force: true });
  }
  rmSync(home, { recursive: true, force: true });
});

describe('the state-directory pointer', () => {
  it('round-trips the directory the host handed the hook', () => {
    expect(writeStateDirPointer({ pluginRoot, stateDirectory, home })).toBe(true);
    expect(readStateDirPointer(pluginRoot, home)).toBe(stateDirectory);
  });

  it('keys by the real directory, not by its spelling', () => {
    expect(writeStateDirPointer({ pluginRoot, stateDirectory, home })).toBe(true);
    // A differently-spelled path to the same real directory reads the same
    // record: trailing separator, and — on the case-preserving filesystems
    // the hosts run on — letter case.
    expect(readStateDirPointer(pluginRoot + sep, home)).toBe(stateDirectory);
    if (process.platform === 'win32') {
      expect(readStateDirPointer(pluginRoot.toUpperCase(), home)).toBe(stateDirectory);
    }
  });

  it('carries no secret and no credential-shaped field', () => {
    writeStateDirPointer({ pluginRoot, stateDirectory, home });
    const files = readdirSync(stateDirPointerDirectory(home));
    expect(files).toHaveLength(1);
    const body = readFileSync(join(stateDirPointerDirectory(home), files[0]!), 'utf8');
    const record = JSON.parse(body) as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual([
      'plugin_root',
      'state_dir_pointer_format',
      'state_directory',
    ]);
    expect(body).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD|mem_/i);
  });

  it('refuses to write a relative state directory or a relative root', () => {
    expect(writeStateDirPointer({ pluginRoot, stateDirectory: 'relative/state', home })).toBe(
      false,
    );
    expect(writeStateDirPointer({ pluginRoot: 'relative/root', stateDirectory, home })).toBe(false);
    expect(readStateDirPointer(pluginRoot, home)).toBeUndefined();
  });

  it('fails closed on every malformed record', () => {
    writeStateDirPointer({ pluginRoot, stateDirectory, home });
    const directory = stateDirPointerDirectory(home);
    const file = join(directory, readdirSync(directory)[0]!);
    const valid = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;

    const rewrite = (record: unknown): void => {
      writeFileSync(file, typeof record === 'string' ? record : JSON.stringify(record), 'utf8');
    };

    rewrite('not json at all');
    expect(readStateDirPointer(pluginRoot, home)).toBeUndefined();

    rewrite([1, 2, 3]);
    expect(readStateDirPointer(pluginRoot, home)).toBeUndefined();

    rewrite({ ...valid, state_dir_pointer_format: STATE_DIR_POINTER_FORMAT + 1 });
    expect(readStateDirPointer(pluginRoot, home)).toBeUndefined();

    rewrite({ ...valid, plugin_root: `${String(valid['plugin_root'])}-other` });
    expect(readStateDirPointer(pluginRoot, home)).toBeUndefined();

    rewrite({ ...valid, state_directory: 'relative/state' });
    expect(readStateDirPointer(pluginRoot, home)).toBeUndefined();

    rewrite({ ...valid, state_directory: '' });
    expect(readStateDirPointer(pluginRoot, home)).toBeUndefined();

    // And the untouched record still reads, so none of the refusals above was
    // the reader being broken.
    rewrite(valid);
    expect(readStateDirPointer(pluginRoot, home)).toBe(stateDirectory);
  });

  it('answers nothing for a root that has no record or does not exist', () => {
    expect(readStateDirPointer(pluginRoot, home)).toBeUndefined();
    expect(readStateDirPointer(join(home, 'no-such-root'), home)).toBeUndefined();
  });

  it('separates two installations by their roots', () => {
    const otherRoot = join(home, 'cache', 'marketplace', 'plugin', '0.0.1');
    mkdirSync(otherRoot, { recursive: true });
    const otherState = join(home, 'data', 'other-state');
    mkdirSync(otherState, { recursive: true });

    writeStateDirPointer({ pluginRoot, stateDirectory, home });
    writeStateDirPointer({ pluginRoot: otherRoot, stateDirectory: otherState, home });

    expect(readStateDirPointer(pluginRoot, home)).toBe(stateDirectory);
    expect(readStateDirPointer(otherRoot, home)).toBe(otherState);
  });
});

describe('the server fallback over the pointer', () => {
  const io = (root: string) => () => readStateDirPointer(root, home);

  it('prefers the trusted environment and never consults the pointer beside it', () => {
    writeStateDirPointer({ pluginRoot, stateDirectory: join(home, 'wrong'), home });
    const fromEnvironment = join(home, 'from-env');
    expect(
      runtimeStatePathsOf({ MEMORY_CLAUDE_PLUGIN_DATA: fromEnvironment }, io(pluginRoot)),
    ).toEqual({ pluginData: fromEnvironment });
  });

  it('refuses a present-but-relative environment value without falling back', () => {
    writeStateDirPointer({ pluginRoot, stateDirectory, home });
    expect(
      runtimeStatePathsOf({ MEMORY_CLAUDE_PLUGIN_DATA: 'relative/path' }, io(pluginRoot)),
    ).toBeUndefined();
  });

  it('uses the pointer only when the environment says nothing at all', () => {
    writeStateDirPointer({ pluginRoot, stateDirectory, home });
    expect(runtimeStatePathsOf({}, io(pluginRoot))).toEqual({ pluginData: stateDirectory });
  });

  it('fails closed when no pointer exists for this root', () => {
    expect(runtimeStatePathsOf({}, io(pluginRoot))).toBeUndefined();
  });
});

describe('the hook writing the pointer', () => {
  const event = (toolName: string) => ({
    session_id: randomUUID(),
    tool_use_id: `exec-${randomUUID()}`,
    cwd: home,
    tool_name: toolName,
    tool_input: {},
  });

  const environment = (overrides: Record<string, string | undefined> = {}) => ({
    CLAUDE_PLUGIN_DATA: stateDirectory,
    CLAUDE_PLUGIN_ROOT: pluginRoot,
    HOME: home,
    ...overrides,
  });

  it('records the host-supplied state directory while allowing the call', async () => {
    expect(isAbsolute(stateDirectory)).toBe(true);
    const decision = await runPreToolUse(
      event(hostToolName('current_problem')),
      environment(),
      Date.now(),
    );
    expect(decision.hookSpecificOutput.permissionDecision).toBe('allow');
    // The record now bridges this installation to its state directory. The
    // pointer home is the process's real home in production; the module's
    // `home` parameter exists for exactly this test isolation.
    expect(readStateDirPointer(pluginRoot, undefined)).toBe(stateDirectory);
  });

  it('still decides the call when the root is absent, and writes nothing', async () => {
    const decision = await runPreToolUse(
      event(hostToolName('current_problem')),
      environment({ CLAUDE_PLUGIN_ROOT: undefined }),
      Date.now(),
    );
    expect(decision.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(readStateDirPointer(pluginRoot, undefined)).toBeUndefined();
  });
});
