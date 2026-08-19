/**
 * What the model is told about these tools, taken from the server itself.
 *
 * A description is not documentation. It is the only thing a model has when it
 * decides whether an operation accepts an answer, so a description that has
 * fallen behind the schema is a live defect: it can tell a model not to use a
 * path that exists. That happened here — the asking tool gained an optional
 * decision and went on advertising that it took no arguments — so the contract
 * is now read from the published listing rather than from a source string, and
 * the two halves are asserted against each other.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MEMORY_TOOLS } from '../src/runtime-constants.js';
import { buildMemoryMcpServer } from '../src/server.js';

const NOW = 1_800_000_000_000;

/** Synthetic. Shaped like a credential and not one. */
const FAKE_TOKEN = 'memory_test_0000000000000000000000000000';

interface PublishedTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: {
    readonly properties?: Record<string, unknown>;
    readonly required?: readonly string[];
    readonly additionalProperties?: boolean;
  };
}

let pluginData: string;
let projectDir: string;

beforeEach(async () => {
  pluginData = await mkdtemp(join(tmpdir(), 'contract-data-'));
  projectDir = await mkdtemp(join(tmpdir(), 'contract-root-'));
});

afterEach(async () => {
  await rm(pluginData, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

/**
 * The tools as a client actually receives them.
 *
 * Driven over the SDK's own linked transports, so what is asserted is the
 * published listing and not a re-reading of the registration call.
 */
async function publishedTools(): Promise<readonly PublishedTool[]> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = buildMemoryMcpServer({
    environment: {
      MEMORY_CLAUDE_PROJECT_DIR: projectDir,
      MEMORY_CLAUDE_PLUGIN_DATA: pluginData,
      MEMORY_API_TOKEN: FAKE_TOKEN,
    },
    now: () => NOW,
  });

  await server.connect(serverSide);

  const replies = new Map<number, (message: unknown) => void>();
  clientSide.onmessage = (message): void => {
    const body = message as { id?: number };
    const id = body.id;
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
    clientInfo: { name: 'contract', version: '0' },
  });
  await clientSide.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as never);

  const listed = await request('tools/list', {});
  await clientSide.close();

  return (listed['result'] as { tools: readonly PublishedTool[] }).tools;
}

/** The published entry for one tool, or a failure that names it. */
function toolNamed(tools: readonly PublishedTool[], name: string): PublishedTool {
  const found = tools.find((tool) => tool.name === name);
  expect(`${name} is published:${found !== undefined}`).toBe(`${name} is published:true`);
  return found as PublishedTool;
}

describe('what the model is told these tools take', () => {
  it('publishes the four, and no others', async () => {
    const tools = await publishedTools();

    expect(tools.map((tool) => tool.name)).toEqual([...MEMORY_TOOLS]);
  });

  it('no longer tells the model that asking takes nothing', async () => {
    const description = toolNamed(await publishedTools(), 'current_problem').description ?? '';

    // Each of these says, in one wording or another, that there is nothing to
    // pass. Any of them would talk a model out of answering the question this
    // very tool asked.
    for (const denial of [
      'Takes no arguments',
      'takes no arguments',
      'no arguments',
      'accepts no input',
      'takes nothing',
      'no input',
    ]) {
      expect(`the description says "${denial}":${description.includes(denial)}`).toBe(
        `the description says "${denial}":false`,
      );
    }
  });

  it('tells the model an earlier Project question can be answered here', async () => {
    const description = toolNamed(await publishedTools(), 'current_problem').description ?? '';

    // Named, so a model can find the field; tied to a previous result, so it is
    // clear this is a follow-up rather than something to fill in speculatively;
    // and described as re-checked, so it is not mistaken for authority.
    expect(description).toContain('project_decision');
    expect(`points at an earlier result:${/earlier|previous/u.test(description)}`).toBe(
      'points at an earlier result:true',
    );
    expect(`says the answer is re-checked:${/revalidat|re-check/u.test(description)}`).toBe(
      'says the answer is re-checked:true',
    );
    expect(`still refuses to choose:${/[Nn]ever picks/u.test(description)}`).toBe(
      'still refuses to choose:true',
    );
  });

  it('keeps saying that the session and the project root are the host’s', async () => {
    const description = toolNamed(await publishedTools(), 'current_problem').description ?? '';

    // The correction must not turn into an invitation. A model supplying a
    // session or a root would be describing a machine it cannot see.
    expect(`credits the host:${/come from the host/u.test(description)}`).toBe(
      'credits the host:true',
    );
    for (const invented of ['repository URL', 'absolute path', 'platform', 'owner']) {
      expect(`asks the model for a ${invented}:${description.includes(invented)}`).toBe(
        `asks the model for a ${invented}:false`,
      );
    }
  });

  it('asks for exactly one optional field, and only on the asking tool', async () => {
    const tools = await publishedTools();
    const asking = toolNamed(tools, 'current_problem');

    expect(Object.keys(asking.inputSchema?.properties ?? {})).toEqual(['project_decision']);
    expect(asking.inputSchema?.required ?? []).toEqual([]);
    expect(asking.inputSchema?.additionalProperties).toBe(false);

    for (const tool of tools.filter((entry) => entry.name !== 'current_problem')) {
      const fields = Object.keys(tool.inputSchema?.properties ?? {});
      expect(`${tool.name} takes a decision:${fields.includes('project_decision')}`).toBe(
        `${tool.name} takes a decision:false`,
      );
    }
  });

  it('describes nothing the host or the adapter owns', async () => {
    const published = JSON.stringify(
      (await publishedTools()).map((tool) => tool.inputSchema ?? {}),
    );

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
    ]) {
      expect(`a published input takes ${forbidden}:${published.includes(forbidden)}`).toBe(
        `a published input takes ${forbidden}:false`,
      );
    }
  });

  it('never says a tool takes nothing while its schema takes something', async () => {
    // The drift this test exists to catch, stated once for all four rather
    // than for the one that drifted: whatever a tool accepts, its own words
    // must not deny it.
    for (const tool of await publishedTools()) {
      const fields = Object.keys(tool.inputSchema?.properties ?? {});
      const denies = /takes no (arguments|input)|accepts no input|takes nothing/u.test(
        tool.description ?? '',
      );

      expect(`${tool.name} denies its own ${fields.length} field(s):${denies}`).toBe(
        `${tool.name} denies its own ${fields.length} field(s):false`,
      );
    }
  });
});
