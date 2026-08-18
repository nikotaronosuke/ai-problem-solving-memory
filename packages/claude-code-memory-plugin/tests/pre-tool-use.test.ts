/**
 * What the trusted hook does, and the far longer list of what it refuses.
 *
 * A hook that mints on doubt is worse than one that mints on nothing: the
 * first hands a call somebody else's session, the second costs a person one
 * unavailable tool. So almost everything here asserts a refusal, and asserts
 * that nothing was written when it refused.
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runPreToolUse } from '../src/pre-tool-use.js';
import { CALL_CONTEXT_DIRECTORY, HOST_TOOL_NAME } from '../src/runtime-constants.js';

const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const CALL_ID = 'toolu_01AAAAAAAAAAAAAAAAAAAAAA';
const NOW = 1_800_000_000_000;

let pluginData: string;

beforeEach(async () => {
  pluginData = await mkdtemp(join(tmpdir(), 'plugin-data-'));
});

afterEach(async () => {
  await rm(pluginData, { recursive: true, force: true });
});

/** A pre-tool event as the host delivers one for this tool. */
function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hook_event_name: 'PreToolUse',
    session_id: SESSION_ID,
    tool_use_id: CALL_ID,
    tool_name: HOST_TOOL_NAME,
    tool_input: {},
    ...overrides,
  };
}

const environment = () => ({ CLAUDE_PLUGIN_DATA: pluginData });

async function records(): Promise<string[]> {
  try {
    return await readdir(join(pluginData, CALL_CONTEXT_DIRECTORY));
  } catch {
    return [];
  }
}

describe('a main-session call for this tool', () => {
  it('is allowed, and one record is written', async () => {
    const decision = await runPreToolUse(event(), environment(), NOW);

    expect(decision.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(await records()).toHaveLength(1);
  });

  it('rewrites nothing about the call', async () => {
    // The whole reason this design has no reserved input field. Nothing is
    // injected, so nothing travels through the model and nothing lands in a
    // transcript — and this plugin cannot lose an input-rewriting race with
    // another hook, because it does not enter one.
    const decision = await runPreToolUse(event(), environment(), NOW);

    expect(Object.keys(decision.hookSpecificOutput).sort()).toEqual([
      'hookEventName',
      'permissionDecision',
      'permissionDecisionReason',
    ]);
    expect(JSON.stringify(decision).includes('updatedInput')).toBe(false);
  });

  it('says nothing about who or where', async () => {
    const decision = await runPreToolUse(event(), environment(), NOW);
    const printed = JSON.stringify(decision);

    for (const secret of [SESSION_ID, CALL_ID, pluginData]) {
      expect(printed.includes(secret)).toBe(false);
    }
  });
});

describe('what it refuses', () => {
  it('mints nothing for a subagent, and denies', async () => {
    // Delegated work is not the owner's Problem lifecycle. The main session's
    // id travels with a subagent call, which is exactly why presence of the
    // agent marker has to be the test rather than the session.
    const decision = await runPreToolUse(
      event({ agent_id: 'a5e407559c30577b3', agent_type: 'general-purpose' }),
      environment(),
      NOW,
    );

    expect(decision.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(await records()).toEqual([]);
  });

  it.each([
    ['no session', { session_id: undefined }],
    ['a blank session', { session_id: '   ' }],
    ['no call identifier', { tool_use_id: undefined }],
    ['a blank call identifier', { tool_use_id: '' }],
    ['another tool', { tool_name: 'mcp__plugin_other_memory__current_problem' }],
    ['no tool name at all', { tool_name: undefined }],
  ])('mints nothing when the event has %s', async (_name, overrides) => {
    const decision = await runPreToolUse(event(overrides), environment(), NOW);

    expect(decision.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(await records()).toEqual([]);
  });

  it.each([
    ['not an object', 'a string'],
    ['null', null],
    ['nothing', undefined],
  ])('mints nothing when the event is %s', async (_name, malformed) => {
    const decision = await runPreToolUse(malformed, environment(), NOW);

    expect(decision.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(await records()).toEqual([]);
  });

  it('denies when the host said nowhere to keep state', async () => {
    const decision = await runPreToolUse(event(), {}, NOW);

    expect(decision.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('denies rather than replacing a record already there', async () => {
    const first = await runPreToolUse(event(), environment(), NOW);
    const second = await runPreToolUse(event(), environment(), NOW);

    expect(first.hookSpecificOutput.permissionDecision).toBe('allow');
    expect(second.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(await records()).toHaveLength(1);
  });

  it('explains a refusal without describing it', async () => {
    const decision = await runPreToolUse(event({ session_id: '' }), environment(), NOW);
    const reason = decision.hookSpecificOutput.permissionDecisionReason;

    // Fixed prose from a closed set. A reason is shown to a person and to the
    // model, so it says what happened and never to what.
    expect(reason).toBe('Memory could not establish the session context for this call.');
    expect(reason.includes(pluginData)).toBe(false);
  });
});

describe('tidying up after calls that never ran', () => {
  it('sweeps records nobody will claim while minting the next one', async () => {
    const stale = event({ tool_use_id: 'toolu_stale' });
    await runPreToolUse(stale, environment(), NOW - 7_200_000);
    expect(await records()).toHaveLength(1);

    await runPreToolUse(event(), environment(), NOW);

    // The stale one is gone and only the current call's record remains.
    expect(await records()).toHaveLength(1);
  });

  it('still mints when there is nothing to sweep', async () => {
    const decision = await runPreToolUse(event(), environment(), NOW);

    expect(decision.hookSpecificOutput.permissionDecision).toBe('allow');
  });
});
