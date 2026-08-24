/**
 * The state-directory pointer: one record that bridges a host-supplied state
 * directory from the PreToolUse hook process to the MCP server process.
 *
 * ## Why it exists
 *
 * On Claude Code the MCP server learns its state directory from the trusted
 * `MEMORY_CLAUDE_PLUGIN_DATA` environment mapping. Measured on the real Codex
 * host (0.149.0-alpha.4.1), no equivalent channel reaches a plugin's MCP
 * child: `${VAR}` placeholders are never expanded in args or env values, the
 * parent environment is not inherited, and the host injects
 * `CLAUDE_PLUGIN_DATA` into hook processes only. The hook therefore relays
 * the one value the server cannot otherwise learn — where the host put this
 * installation's state — and relays nothing else.
 *
 * ## What it is not
 *
 * Not an authority and not a configuration system. The pointer carries no
 * credential, no URL, no session, no Problem material, and no behaviour
 * switch; every authority rule stays where it was. A reader that finds the
 * record missing, malformed, foreign or non-absolute treats it as absent and
 * fails closed. Nothing here guesses a directory or reconstructs a host's
 * internal layout: the only value ever written is the one the host itself
 * handed the hook.
 *
 * ## How the two processes meet
 *
 * Both sides derive the same key from the one fact they independently hold:
 * the installed plugin root. The hook holds it as `CLAUDE_PLUGIN_ROOT`
 * (measured present under both hosts); the server holds it as its working
 * directory on the host that needs the fallback, because that host resolves
 * `cwd: "."` to the installed plugin root. The key is a digest of the
 * resolved, separator- and case-normalised real path, so the two spellings of
 * one directory cannot produce two records, and two installations cannot
 * share one.
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** Refused rather than read when a future format arrives. */
export const STATE_DIR_POINTER_FORMAT = 1;

/**
 * Where the pointers live: user-local, product-specific, and independent of
 * both hosts. Nothing else is stored under this directory by this module.
 */
export function stateDirPointerDirectory(home: string = homedir()): string {
  return join(home, '.ai-problem-solving-memory', 'state-dir-pointers');
}

/**
 * One directory, one spelling. `realpathSync` resolves links and canonicalises
 * the case Windows preserves but does not distinguish; the explicit lowering
 * and forward slashes make the derived key independent of which spelling a
 * host happened to use. The normalised value is also what identity compares
 * against, so the comparison and the key cannot drift apart.
 */
function normalisedRootOf(pluginRoot: string): string | undefined {
  if (typeof pluginRoot !== 'string' || pluginRoot.length === 0 || !isAbsolute(pluginRoot)) {
    return undefined;
  }
  try {
    return realpathSync(pluginRoot).replaceAll('\\', '/').toLowerCase();
  } catch {
    return undefined;
  }
}

/** The pointer's filename for one installation, or nothing. */
export function stateDirPointerPathFor(pluginRoot: string, home?: string): string | undefined {
  const normalised = normalisedRootOf(pluginRoot);
  if (normalised === undefined) {
    return undefined;
  }
  const key = createHash('sha256').update(normalised, 'utf8').digest('hex');
  return join(stateDirPointerDirectory(home), `${key}.json`);
}

/**
 * Records where the host put this installation's state. Atomic: the record is
 * written beside its final name and renamed into place, so a reader sees the
 * previous complete record or the new complete record and never a partial
 * one. Returns whether a record was written; it throws nothing, because the
 * hook's decision must not depend on this bridge and a host that needs it
 * will fail closed at the reader instead.
 */
export function writeStateDirPointer(options: {
  readonly pluginRoot: string;
  readonly stateDirectory: string;
  readonly home?: string;
}): boolean {
  const normalised = normalisedRootOf(options.pluginRoot);
  const target = stateDirPointerPathFor(options.pluginRoot, options.home);
  if (normalised === undefined || target === undefined) {
    return false;
  }
  if (
    typeof options.stateDirectory !== 'string' ||
    options.stateDirectory.length === 0 ||
    !isAbsolute(options.stateDirectory)
  ) {
    return false;
  }
  const record = {
    state_dir_pointer_format: STATE_DIR_POINTER_FORMAT,
    plugin_root: normalised,
    state_directory: options.stateDirectory,
  };
  const temporary = `${target}.tmp-${randomUUID()}`;
  try {
    mkdirSync(stateDirPointerDirectory(options.home), { recursive: true });
    writeFileSync(temporary, JSON.stringify(record), 'utf8');
    renameSync(temporary, target);
    return true;
  } catch {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Leaving a temporary behind is untidy, never unsafe: no reader ever
      // looks at a name that is not the final one.
    }
    return false;
  }
}

/**
 * The pointer for the installation this process was started in, or nothing.
 *
 * This is the single place the plugin runtime reads `process.cwd()`, and it
 * is not a session location: on the host that needs this fallback the MCP
 * child is launched with `cwd: "."`, which that host resolves to the
 * installed plugin root — an installation identity, fixed at spawn, that
 * never feeds Project detection, Environment capture or any other
 * location-shaped decision. Where a session is still comes exclusively from
 * the hook-minted record for each call.
 */
export function readStateDirPointerForInstalledRoot(): string | undefined {
  return readStateDirPointer(process.cwd());
}

/**
 * The state directory the host recorded for this installation, or nothing.
 *
 * Every failure is the same answer. A missing file, unreadable bytes,
 * non-JSON, a future or past format, a record for a different installation
 * and a non-absolute directory all return `undefined`, because the caller's
 * correct response to each is identical: behave as if no bridge exists.
 */
export function readStateDirPointer(pluginRoot: string, home?: string): string | undefined {
  const normalised = normalisedRootOf(pluginRoot);
  const target = stateDirPointerPathFor(pluginRoot, home);
  if (normalised === undefined || target === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(target, 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (record['state_dir_pointer_format'] !== STATE_DIR_POINTER_FORMAT) {
    return undefined;
  }
  if (record['plugin_root'] !== normalised) {
    return undefined;
  }
  const stateDirectory = record['state_directory'];
  if (
    typeof stateDirectory !== 'string' ||
    stateDirectory.length === 0 ||
    !isAbsolute(stateDirectory)
  ) {
    return undefined;
  }
  return stateDirectory;
}
