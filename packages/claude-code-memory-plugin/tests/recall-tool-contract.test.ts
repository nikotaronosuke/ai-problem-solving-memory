/**
 * What the recall tool will and will not accept, taken from the server itself.
 *
 * This tool is the first whose input is written by the model rather than chosen
 * from a fixed set, which makes its schema the boundary deciding what a model is
 * able to claim. Two things are asserted here and they pull in opposite
 * directions: the model may describe the problem in any words it likes, and the
 * model may not name the Project, the Problem, the AI it is, or the vocabulary
 * it is speaking. Those four are established from the call's own host context,
 * and a schema that merely ignored them would still be one accidental spread
 * away from honouring them.
 *
 * Everything runs over the SDK's own transports, so what is checked is the
 * schema a client actually receives and the rejection a client actually gets.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MEMORY_SEARCH_MAX_LEXICAL_TEXT_LENGTH,
  MEMORY_SEARCH_MAX_SEMANTIC_TEXT_LENGTH,
  MEMORY_SEARCH_MAX_STRUCTURAL_FEATURE_ITEMS,
  MEMORY_SEARCH_MAX_STRUCTURAL_FEATURE_LENGTH,
} from '@ai-problem-solving-memory/api-client';
import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RECALL_SIMILAR_EXPERIENCE_TOOL } from '../src/runtime-constants.js';
import { buildMemoryMcpServer } from '../src/server.js';

const NOW = 1_800_000_000_000;

/** Synthetic. Shaped like a credential and not one. */
const FAKE_TOKEN = 'memory_test_0000000000000000000000000000';

const FEATURES = {
  problem_domain: null,
  symptom_patterns: [],
  suspected_boundaries: [],
  occurrence_conditions: [],
  successful_directions: [],
  dead_end_directions: [],
  environment_facts: [],
} as const;

/** A request that is valid in every respect the schema can see. */
const WELL_FORMED = {
  lexical_text: 'export empty file',
  semantic_text: 'the scheduled export writes an empty file while reporting success',
  current_features: FEATURES,
} as const;

const FEATURE_LISTS = [
  'symptom_patterns',
  'suspected_boundaries',
  'occurrence_conditions',
  'successful_directions',
  'dead_end_directions',
  'environment_facts',
] as const;

interface PublishedTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
}

interface CallOutcome {
  readonly isError: boolean;
  readonly text: string;
  readonly hasStructuredContent: boolean;
}

interface Session {
  readonly tools: readonly PublishedTool[];
  call(args: unknown): Promise<CallOutcome>;
  close(): Promise<void>;
}

let pluginData: string;
let session: Session;

/** Opens a live server over linked transports and lists its tools once. */
async function openSession(): Promise<Session> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = buildMemoryMcpServer({
    environment: { MEMORY_CLAUDE_PLUGIN_DATA: pluginData, MEMORY_API_TOKEN: FAKE_TOKEN },
    now: () => NOW,
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
    clientInfo: { name: 'recall-contract', version: '0' },
  });
  await clientSide.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as never);

  const listed = await request('tools/list', {});

  return {
    tools: (listed['result'] as { tools: readonly PublishedTool[] }).tools,
    call: async (args: unknown): Promise<CallOutcome> => {
      const answered = await request('tools/call', {
        name: RECALL_SIMILAR_EXPERIENCE_TOOL,
        arguments: args,
      });
      const result = answered['result'] as
        | { isError?: boolean; structuredContent?: unknown; content?: readonly { text?: string }[] }
        | undefined;
      return {
        isError: result?.isError === true,
        text: result?.content?.[0]?.text ?? '',
        hasStructuredContent: result !== undefined && 'structuredContent' in result,
      };
    },
    close: async (): Promise<void> => {
      await clientSide.close();
    },
  };
}

/** The recall tool as a client receives it. */
function recallTool(): PublishedTool {
  const found = session.tools.find((tool) => tool.name === RECALL_SIMILAR_EXPERIENCE_TOOL);
  expect(`the recall tool is published:${String(found !== undefined)}`).toBe(
    'the recall tool is published:true',
  );
  return found as PublishedTool;
}

/**
 * Whether the schema turned a request away, as opposed to the handler doing so.
 *
 * The difference matters: a schema rejection happens before any of this
 * runtime's own code sees the arguments, which is the only kind of refusal that
 * holds regardless of what the handler would have gone on to do with them.
 */
function refusedBySchema(outcome: CallOutcome): string {
  const refused =
    outcome.isError &&
    !outcome.hasStructuredContent &&
    outcome.text.startsWith('Input validation error');
  return `refused by the schema:${String(refused)}`;
}

/** One request with a single feature field replaced. */
function withFeature(field: string, value: unknown): unknown {
  return { ...WELL_FORMED, current_features: { ...FEATURES, [field]: value } };
}

beforeEach(async () => {
  pluginData = await mkdtemp(join(tmpdir(), 'recall-contract-'));
  session = await openSession();
});

afterEach(async () => {
  await session.close();
  await rm(pluginData, { recursive: true, force: true });
});

describe('what the model is asked for', () => {
  it('takes three things, all of them required', () => {
    const schema = recallTool().inputSchema ?? {};

    expect(Object.keys(schema['properties'] ?? {}).sort()).toEqual([
      'current_features',
      'lexical_text',
      'semantic_text',
    ]);
    expect([...((schema['required'] ?? []) as readonly string[])].sort()).toEqual([
      'current_features',
      'lexical_text',
      'semantic_text',
    ]);
  });

  it('closes both objects to anything else', () => {
    const schema = recallTool().inputSchema ?? {};
    const features = ((schema['properties'] ?? {}) as Record<string, Record<string, unknown>>)[
      'current_features'
    ];

    expect(schema['additionalProperties']).toBe(false);
    expect(features?.['additionalProperties']).toBe(false);
  });

  it('has nowhere at all for an identity to be written', () => {
    // Asserted against the whole published schema rather than field by field. A
    // nested object added later is caught by this and not by a list of
    // top-level property names.
    const printed = JSON.stringify(recallTool().inputSchema);

    for (const forbidden of ['project_id', 'problem_id', 'source_ai', 'schema_version']) {
      expect(`the schema mentions ${forbidden}:${String(printed.includes(forbidden))}`).toBe(
        `the schema mentions ${forbidden}:false`,
      );
    }
  });

  it('asks for seven structural fields and no eighth', () => {
    const schema = recallTool().inputSchema ?? {};
    const features = ((schema['properties'] ?? {}) as Record<string, Record<string, unknown>>)[
      'current_features'
    ];

    expect(Object.keys(features?.['properties'] ?? {}).sort()).toEqual([
      'dead_end_directions',
      'environment_facts',
      'occurrence_conditions',
      'problem_domain',
      'successful_directions',
      'suspected_boundaries',
      'symptom_patterns',
    ]);
  });

  it('tells the model to summarize rather than paste', () => {
    const description = (recallTool().description ?? '').toLowerCase();

    // The model is the only thing standing between a terminal buffer and a
    // durable record, so the instruction has to live in the one string it
    // always has in front of it.
    expect(description.length > 0).toBe(true);
    for (const warned of ['credential', 'absolute path']) {
      expect(`the description warns about ${warned}:${String(description.includes(warned))}`).toBe(
        `the description warns about ${warned}:true`,
      );
    }
  });

  it('does not promise the model that this happens by itself', () => {
    const description = (recallTool().description ?? '').toLowerCase();

    // Nothing calls this tool on the model's behalf yet. A description hinting
    // otherwise would leave a model waiting for a prompt that never arrives.
    for (const overclaim of ['automatic', 'is called for you', 'without being asked']) {
      expect(
        `the description claims "${overclaim}":${String(description.includes(overclaim))}`,
      ).toBe(`the description claims "${overclaim}":false`);
    }
  });
});

describe('identities the model may not claim', () => {
  it.each(['project_id', 'problem_id', 'source_ai', 'schema_version'])(
    'refuses a request carrying %s',
    async (field) => {
      const outcome = await session.call({ ...WELL_FORMED, [field]: 'anything at all' });

      // Not ignored, not stripped. Silently dropping it would let a model
      // believe it had aimed a search somewhere it had not.
      expect(refusedBySchema(outcome)).toBe('refused by the schema:true');
    },
  );

  it.each(['project_id', 'problem_id', 'source_ai', 'schema_version'])(
    'refuses %s hidden among the features',
    async (field) => {
      const outcome = await session.call(withFeature(field, 'anything at all'));

      expect(refusedBySchema(outcome)).toBe('refused by the schema:true');
    },
  );

  it('refuses any root field it was not asked about', async () => {
    const outcome = await session.call({ ...WELL_FORMED, note: 'a helpful aside' });

    expect(refusedBySchema(outcome)).toBe('refused by the schema:true');
  });

  it('refuses a second copy of the features under another name', async () => {
    const outcome = await session.call({ ...WELL_FORMED, features: FEATURES });

    expect(refusedBySchema(outcome)).toBe('refused by the schema:true');
  });
});

describe('texts it will not accept', () => {
  it.each([
    [
      'a missing lexical_text',
      { semantic_text: WELL_FORMED.semantic_text, current_features: FEATURES },
    ],
    [
      'a missing semantic_text',
      { lexical_text: WELL_FORMED.lexical_text, current_features: FEATURES },
    ],
    ['missing features', { lexical_text: 'a', semantic_text: 'b' }],
    ['a blank lexical_text', { ...WELL_FORMED, lexical_text: '' }],
    ['a blank semantic_text', { ...WELL_FORMED, semantic_text: '' }],
    ['a lexical_text of nothing but spaces', { ...WELL_FORMED, lexical_text: '     ' }],
    ['a semantic_text of nothing but spaces', { ...WELL_FORMED, semantic_text: '   ' }],
    ['a lexical_text that is not a string', { ...WELL_FORMED, lexical_text: 7 }],
    ['a semantic_text that is not a string', { ...WELL_FORMED, semantic_text: ['a', 'b'] }],
    ['features that are not an object', { ...WELL_FORMED, current_features: 'none' }],
    ['a null where the features go', { ...WELL_FORMED, current_features: null }],
    [
      'a lexical_text one character past what the Memory accepts',
      { ...WELL_FORMED, lexical_text: 'x'.repeat(MEMORY_SEARCH_MAX_LEXICAL_TEXT_LENGTH + 1) },
    ],
    [
      'a semantic_text one character past what the Memory accepts',
      { ...WELL_FORMED, semantic_text: 'x'.repeat(MEMORY_SEARCH_MAX_SEMANTIC_TEXT_LENGTH + 1) },
    ],
  ])('refuses %s', async (_label, args) => {
    const outcome = await session.call(args);

    expect(refusedBySchema(outcome)).toBe('refused by the schema:true');
  });

  it('turns an over-long text away rather than shortening it', async () => {
    // The distinction being drawn is between a request the Memory would reject
    // and a request the model never wrote. Truncating produces the second while
    // looking like the first.
    const tooLong = {
      ...WELL_FORMED,
      lexical_text: 'x'.repeat(MEMORY_SEARCH_MAX_LEXICAL_TEXT_LENGTH + 1),
    };
    const atTheLimit = {
      ...WELL_FORMED,
      lexical_text: 'x'.repeat(MEMORY_SEARCH_MAX_LEXICAL_TEXT_LENGTH),
    };

    expect(refusedBySchema(await session.call(tooLong))).toBe('refused by the schema:true');
    // The one at the limit is somebody else's to answer, and it gets that far.
    expect(refusedBySchema(await session.call(atTheLimit))).toBe('refused by the schema:false');
  });
});

describe('features it will not accept', () => {
  it.each(FEATURE_LISTS)('refuses a blank entry in %s', async (field) => {
    expect(refusedBySchema(await session.call(withFeature(field, ['a real one', '  '])))).toBe(
      'refused by the schema:true',
    );
  });

  it.each(FEATURE_LISTS)('refuses an over-long entry in %s', async (field) => {
    const entry = 'x'.repeat(MEMORY_SEARCH_MAX_STRUCTURAL_FEATURE_LENGTH + 1);

    expect(refusedBySchema(await session.call(withFeature(field, [entry])))).toBe(
      'refused by the schema:true',
    );
  });

  it.each(FEATURE_LISTS)('refuses more entries in %s than the Memory takes', async (field) => {
    const tooMany = Array.from(
      { length: MEMORY_SEARCH_MAX_STRUCTURAL_FEATURE_ITEMS + 1 },
      (_unused, index) => `feature ${String(index)}`,
    );

    expect(refusedBySchema(await session.call(withFeature(field, tooMany)))).toBe(
      'refused by the schema:true',
    );
  });

  it.each(FEATURE_LISTS)('refuses %s given as a bare string', async (field) => {
    expect(refusedBySchema(await session.call(withFeature(field, 'one feature')))).toBe(
      'refused by the schema:true',
    );
  });

  it.each(FEATURE_LISTS)('refuses a non-string entry in %s', async (field) => {
    expect(refusedBySchema(await session.call(withFeature(field, [7])))).toBe(
      'refused by the schema:true',
    );
  });

  it('takes a domain that is absent, and refuses one that is blank', async () => {
    // Absent is a real answer here: the model may genuinely not know yet, and an
    // empty string is a different claim from that.
    expect(refusedBySchema(await session.call(withFeature('problem_domain', null)))).toBe(
      'refused by the schema:false',
    );
    expect(refusedBySchema(await session.call(withFeature('problem_domain', '   ')))).toBe(
      'refused by the schema:true',
    );
    expect(
      refusedBySchema(
        await session.call(
          withFeature(
            'problem_domain',
            'x'.repeat(MEMORY_SEARCH_MAX_STRUCTURAL_FEATURE_LENGTH + 1),
          ),
        ),
      ),
    ).toBe('refused by the schema:true');
  });

  it('takes a full set of features at every limit', async () => {
    const full = Object.fromEntries(
      FEATURE_LISTS.map((field) => [
        field,
        Array.from({ length: MEMORY_SEARCH_MAX_STRUCTURAL_FEATURE_ITEMS }, () =>
          'x'.repeat(MEMORY_SEARCH_MAX_STRUCTURAL_FEATURE_LENGTH),
        ),
      ]),
    );

    const outcome = await session.call({
      ...WELL_FORMED,
      current_features: {
        ...full,
        problem_domain: 'x'.repeat(MEMORY_SEARCH_MAX_STRUCTURAL_FEATURE_LENGTH),
      },
    });

    expect(refusedBySchema(outcome)).toBe('refused by the schema:false');
  });
});
