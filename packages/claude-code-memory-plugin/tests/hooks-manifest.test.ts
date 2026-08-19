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

import { HOST_TOOL_NAMES, MEMORY_TOOLS, hostToolName } from '../src/runtime-constants.js';

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
  it('matches the four tools by their exact names and nothing else', async () => {
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

    for (const entry of entries) {
      expect(entry.hooks).toHaveLength(1);
      // One implementation, so the four cannot come to disagree about what a
      // call context is.
      expect(entry.hooks[0]).toEqual({
        type: 'command',
        command: 'node "${CLAUDE_PLUGIN_ROOT}/dist/pre-tool-use.js"',
        timeout: 15,
      });
    }
  });

  it('leaves no tool of ours unhooked', async () => {
    const matchers = new Set((await manifest()).hooks.PreToolUse.map((entry) => entry.matcher));

    for (const tool of MEMORY_TOOLS) {
      expect(`${tool} is hooked:${matchers.has(hostToolName(tool))}`).toBe(
        `${tool} is hooked:true`,
      );
    }
  });
});
