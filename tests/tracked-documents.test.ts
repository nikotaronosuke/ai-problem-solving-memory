/**
 * Which documents this repository is allowed to publish.
 *
 * This repository holds the implementation and the documentation somebody
 * outside the project needs in order to use or contribute to it. Development
 * state — what is being worked on, what was decided and why, what was rejected,
 * research notes — belongs elsewhere, and the failure mode is quiet: a new
 * internal document arrives during an ordinary task, nothing breaks, and it is
 * published from then on.
 *
 * So the check is a **positive allowlist**. Tracked Markdown must be exactly
 * this set. Adding a public document means adding it here first, deliberately,
 * rather than discovering afterwards that something went out.
 *
 * The list names only what is permitted. It deliberately does not describe what
 * to keep out — a guard written as a denylist would publish, in this file, the
 * names it existed to keep unpublished.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const run = promisify(execFile);

const ALLOWED_MARKDOWN = [
  'CLAUDE.md',
  'README.md',
  'db/README.md',
  'docs/api-contract.md',
  'docs/development.md',
  'docs/retrieval.md',
] as const;

/** The file a contributor keeps their own machine-specific instructions in. */
const LOCAL_INSTRUCTIONS = 'CLAUDE.local.md';

async function git(...args: readonly string[]): Promise<string> {
  const { stdout } = await run('git', [...args], { cwd: process.cwd() });
  return stdout;
}

async function trackedMarkdown(): Promise<string[]> {
  const stdout = await git('ls-files', '-z', '--', '*.md');

  return stdout
    .split('\0')
    .filter((path) => path.length > 0)
    .sort();
}

describe('tracked documents', () => {
  it('publishes exactly the documents on the allowlist', async () => {
    expect(await trackedMarkdown()).toEqual([...ALLOWED_MARKDOWN].sort());
  });

  it('ignores local instructions rather than tracking them', async () => {
    // `check-ignore` exits non-zero when a path is *not* ignored, so the exit
    // status is the assertion and stdout only says which rule matched.
    await expect(git('check-ignore', '--', LOCAL_INSTRUCTIONS)).resolves.toContain(
      LOCAL_INSTRUCTIONS,
    );

    const tracked = await git('ls-files', '-z', '--', LOCAL_INSTRUCTIONS);
    expect(tracked).toBe('');
  });
});
