/**
 * The shipped hook manifest.
 *
 * This file is configuration, not code: nothing typechecks it and nothing
 * imports it. It is also the only thing that decides whether host identity is
 * minted for a call at all — so a matcher lost to a rename leaves that tool
 * unable to authenticate anything, and a matcher widened to a pattern mints
 * identity for names nobody exposes. Both are silent. Hence this.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { HOST_TOOL_NAMES, MEMORY_TOOLS, hostToolNames } from '../src/runtime-constants.js';

interface HookCommand {
  readonly type: string;
  readonly command: string;
  readonly timeout?: number;
}

interface HookEntry {
  readonly matcher: string;
  readonly hooks: readonly HookCommand[];
}

async function manifest(): Promise<{ hooks: { PreToolUse: readonly HookEntry[] } }> {
  const path = fileURLToPath(new URL('../hooks/hooks.json', import.meta.url));
  return JSON.parse(await readFile(path, 'utf8')) as {
    hooks: { PreToolUse: readonly HookEntry[] };
  };
}

describe('the shipped hook manifest', () => {
  it('matches every tool by its exact name and nothing else', async () => {
    const entries = (await manifest()).hooks.PreToolUse;

    expect(entries.map((entry) => entry.matcher)).toEqual(HOST_TOOL_NAMES);
  });

  it('names each tool literally, so no pattern can widen what mints identity', async () => {
    const entries = (await manifest()).hooks.PreToolUse;

    for (const entry of entries) {
      // A matcher is read as a pattern. Anything here that is not a literal
      // name would match tools this plugin never registered.
      expect(`${entry.matcher} is a literal:${/^[a-z0-9_-]+$/iu.test(entry.matcher)}`).toBe(
        `${entry.matcher} is a literal:true`,
      );
    }
  });

  it('runs the same hook for every one of them', async () => {
    const entries = (await manifest()).hooks.PreToolUse;

    const first = entries[0]?.hooks[0];
    expect(first).toBeDefined();
    for (const entry of entries) {
      expect(entry.hooks).toHaveLength(1);
      // One implementation, so the tools cannot come to disagree about what a
      // call context is.
      expect(entry.hooks[0]).toEqual(first);
    }

    // The command is an environment-reading launcher, because neither host
    // expands a placeholder in a hook command line (measured on the real
    // Codex host; see D-479). It must read the installed root from the
    // host-supplied variable, run the committed distribution bundle — not the
    // workspace build output, which an installed copy does not have — through
    // its exported process entry, and fail closed as a deny rather than as a
    // spawn error.
    const command = first!.command;
    expect(first!.type).toBe('command');
    expect(first!.timeout).toBe(15);
    expect(command.startsWith('node -e "')).toBe(true);
    expect(command).toContain('process.env.CLAUDE_PLUGIN_ROOT');
    expect(command).toContain("join(root,'bundle','pre-tool-use.js')");
    expect(command).toContain('runHookProcess()');
    expect(command).toContain("permissionDecision:'deny'");
    // No placeholder of any spelling: expansion is exactly what real hosts
    // were measured not to do.
    expect(command).not.toContain('${');
    // The program is shell-safe on both hosts: the only double quotes are the
    // two wrapping the -e argument itself.
    expect(command.split('"')).toHaveLength(3);
  });

  it('leaves no tool of ours unhooked', async () => {
    const matchers = new Set((await manifest()).hooks.PreToolUse.map((entry) => entry.matcher));

    for (const tool of MEMORY_TOOLS) {
      for (const name of hostToolNames(tool)) {
        expect(`${name} is hooked:${matchers.has(name)}`).toBe(`${name} is hooked:true`);
      }
    }
  });
});
