/**
 * What the model wrote is what the Memory is asked.
 *
 * A schema that cleans its input is not validating it. Two things go wrong at
 * once and both are silent: the search that goes out is no longer the one the
 * model composed, and a string whose real length is over what the Memory
 * accepts slips through because cleaning it made it shorter — so the tool stops
 * enforcing the contract on what was actually sent.
 *
 * The whole path is exercised here rather than the schema alone, because the
 * schema is only the first place a value could be altered. Requests go through
 * the real MCP server, the real schema, the real handler, the real adapter and
 * a real HTTP client, and what is asserted is the bytes that arrived at the
 * other end.
 */

import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MEMORY_SEARCH_MAX_LEXICAL_TEXT_LENGTH,
  MEMORY_SEARCH_MAX_SEMANTIC_TEXT_LENGTH,
  MEMORY_SEARCH_MAX_STRUCTURAL_FEATURE_LENGTH,
} from '@ai-problem-solving-memory/api-client';
import { createProblemBindingStore } from '@ai-problem-solving-memory/claude-code-adapter';
import { InMemoryTransport, LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { callContextFilename } from '../src/host-call-context.js';
import {
  BINDINGS_DIRECTORY,
  CALL_CONTEXT_DIRECTORY,
  hostToolName,
  PLUGIN_DATA_ENV,
  RECALL_SIMILAR_EXPERIENCE_TOOL,
} from '../src/runtime-constants.js';
import { buildMemoryMcpServer } from '../src/server.js';

const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const PROJECT_ID = '22222222-3333-4444-8555-666666666666';
const PROBLEM_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
const OWNER_ID = '99999999-8888-4777-8666-555555555555';
const NOW = 1_800_000_000_000;
const REMOTE = 'https://github.com/acme/widget.git';

/** Synthetic. Shaped like a credential and not one. */
const FAKE_TOKEN = 'memory_test_0000000000000000000000000000';

const project = (): unknown => ({
  project_id: PROJECT_ID,
  owner_id: OWNER_ID,
  project_name: 'widget',
  repo: 'github.com/acme/widget',
  platform: null,
  repo_subpath: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
});

const problem = (): unknown => ({
  problem_id: PROBLEM_ID,
  owner_id: OWNER_ID,
  project_id: PROJECT_ID,
  environment_id: 'cccccccc-1111-4222-8333-444444444444',
  title: 'the nightly export finishes with no rows',
  symptoms: 'an empty file, only on the scheduled run',
  problem_domain: null,
  suspected_boundary: null,
  source_ai: 'claude-code',
  status: 'INVESTIGATING',
  fix_kind: null,
  importance: false,
  confidence: 'LOW',
  freshness: 'CURRENT',
  memory_read_enabled: true,
  memory_write_enabled: true,
  suppressed: false,
  version: 4,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
});

const FEATURES = {
  problem_domain: 'batch export',
  symptom_patterns: ['an output file with no rows'],
  suspected_boundaries: ['the scheduler'],
  occurrence_conditions: ['only on the scheduled run'],
  successful_directions: ['checked the writer'],
  dead_end_directions: ['the filesystem was not the cause'],
  environment_facts: ['runs unattended overnight'],
} as const;

const WELL_FORMED = {
  lexical_text: 'export empty file',
  semantic_text: 'the scheduled export writes an empty file while reporting success',
  current_features: FEATURES,
};

const FEATURE_LISTS = [
  'symptom_patterns',
  'suspected_boundaries',
  'occurrence_conditions',
  'successful_directions',
  'dead_end_directions',
  'environment_facts',
] as const;

interface Outcome {
  readonly kind: string | undefined;
  readonly code?: string | undefined;
  readonly refusedBySchema: boolean;
}

let pluginData: string;
let projectDir: string;
let memory: Server;
let base: string;
/** Every search body the Memory was sent, exactly as it arrived. */
let received: Record<string, unknown>[];
let callCounter = 0;

let request: (method: string, params: unknown) => Promise<Record<string, unknown>>;
let closeSession: () => Promise<void>;

/** A Memory that answers enough to reach a search, and records what it got. */
async function startMemory(): Promise<void> {
  received = [];
  memory = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      const url = incoming.url ?? '';
      const answer = (status: number, body: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      };

      if (url === '/v1/projects' && incoming.method === 'GET') {
        answer(200, { projects: [project()] });
        return;
      }
      if (url === `/v1/problems/${PROBLEM_ID}` && incoming.method === 'GET') {
        // The resource itself, not wrapped: the route already named it.
        answer(200, problem());
        return;
      }
      if (url === `/v1/problems/${PROBLEM_ID}/search` && incoming.method === 'POST') {
        // Parsed from the bytes that actually arrived. Nothing between the
        // model and this point is allowed to have rewritten them.
        received.push(
          JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
        );
        answer(200, {
          kind: 'SEARCHED',
          candidates: [],
          semantic_status: 'USED',
          structural_status: 'USED',
        });
        return;
      }
      answer(404, { error: { code: 'NOT_FOUND', message: 'nothing here' } });
    });
  });

  await new Promise<void>((resolve) => {
    memory.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${String((memory.address() as AddressInfo).port)}`;
}

/** A live server over linked transports, initialized and ready to be called. */
async function openSession(): Promise<void> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = buildMemoryMcpServer({
    environment: {
      [PLUGIN_DATA_ENV]: pluginData,
      MEMORY_API_TOKEN: FAKE_TOKEN,
      MEMORY_API_URL: base,
    },
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
  request = async (method, params) => {
    const id = nextId++;
    const answered = new Promise<Record<string, unknown>>((resolve) =>
      replies.set(id, (message) => resolve(message as Record<string, unknown>)),
    );
    await clientSide.send({ jsonrpc: '2.0', id, method, params } as never);
    return answered;
  };
  closeSession = async () => clientSide.close();

  await request('initialize', {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'preservation', version: '0' },
  });
  await clientSide.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as never);
}

/**
 * One recall, with a fresh call context minted the way the trusted hook would.
 *
 * Each call needs its own host identifier because a context is claimed exactly
 * once, and that rule is not relaxed for a test.
 */
async function recall(args: unknown): Promise<Outcome> {
  callCounter += 1;
  const hostCallId = `toolu_01${String(callCounter).padStart(22, 'A')}`;
  const directory = join(pluginData, CALL_CONTEXT_DIRECTORY);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, callContextFilename(hostCallId)),
    JSON.stringify({
      format_version: 2,
      session_id: SESSION_ID,
      tool_name: hostToolName(RECALL_SIMILAR_EXPERIENCE_TOOL),
      current_directory: projectDir,
      minted_at: NOW,
    }),
    'utf8',
  );

  const answered = await request('tools/call', {
    name: RECALL_SIMILAR_EXPERIENCE_TOOL,
    arguments: args,
    _meta: { 'claudecode/toolUseId': hostCallId },
  });
  const result = answered['result'] as
    | {
        isError?: boolean;
        structuredContent?: { kind?: string; code?: string };
        content?: readonly { text?: string }[];
      }
    | undefined;

  return {
    kind: result?.structuredContent?.kind,
    code: result?.structuredContent?.code,
    refusedBySchema:
      result?.isError === true &&
      result.structuredContent === undefined &&
      (result.content?.[0]?.text ?? '').startsWith('Input validation error'),
  };
}

beforeEach(async () => {
  callCounter = 0;
  pluginData = await mkdtemp(join(tmpdir(), 'preserve-data-'));
  projectDir = await mkdtemp(join(tmpdir(), 'preserve-root-'));

  const git = (...args: string[]): void => {
    spawnSync('git', args, { cwd: projectDir, encoding: 'utf8' });
  };
  await writeFile(join(projectDir, 'README.md'), '# widget\n', 'utf8');
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'nobody@example.invalid');
  git('config', 'user.name', 'Disposable');
  git('config', 'commit.gpgsign', 'false');
  git('remote', 'add', 'origin', REMOTE);
  git('add', '-A');
  git('commit', '-q', '-m', 'first');

  await startMemory();
  await createProblemBindingStore({
    directory: join(pluginData, BINDINGS_DIRECTORY),
  }).writeBinding(SESSION_ID, PROJECT_ID, PROBLEM_ID);
  await openSession();
});

afterEach(async () => {
  await closeSession();
  await new Promise<void>((resolve) => {
    memory.close(() => resolve());
  });
  await rm(pluginData, { recursive: true, force: true });
  await rm(projectDir, { recursive: true, force: true });
});

describe('the request that reaches the Memory', () => {
  it('carries the model’s words with the whitespace still on them', async () => {
    // Asserted against the bytes the Memory received rather than against what
    // the schema returned, because a rewrite could happen anywhere along the way.
    const spaced = '  lexical terms  ';
    const outcome = await recall({ ...WELL_FORMED, lexical_text: spaced });

    expect(outcome.kind).toBe('RECALLED');
    expect(received).toHaveLength(1);
    expect(received[0]?.['lexical_text']).toBe(spaced);
  });

  it('keeps the whitespace on the fuller description', async () => {
    const spaced = '   the scheduled export writes an empty file   ';
    const outcome = await recall({ ...WELL_FORMED, semantic_text: spaced });

    expect(outcome.kind).toBe('RECALLED');
    expect(received[0]?.['semantic_text']).toBe(spaced);
  });

  it('keeps the whitespace on the problem domain', async () => {
    const spaced = '  batch export  ';
    const outcome = await recall({
      ...WELL_FORMED,
      current_features: { ...FEATURES, problem_domain: spaced },
    });

    expect(outcome.kind).toBe('RECALLED');
    expect((received[0]?.['current_features'] as Record<string, unknown>)['problem_domain']).toBe(
      spaced,
    );
  });

  it.each(FEATURE_LISTS)('keeps the whitespace on an entry of %s', async (field) => {
    const spaced = `  ${field} entry  `;
    const outcome = await recall({
      ...WELL_FORMED,
      current_features: { ...FEATURES, [field]: [spaced] },
    });

    expect(outcome.kind).toBe('RECALLED');
    expect((received[0]?.['current_features'] as Record<string, readonly string[]>)[field]).toEqual(
      [spaced],
    );
  });

  it('leaves the lists in the order and multiplicity they arrived in', async () => {
    // No sorting and no removing duplicates either. Two entries that happen to
    // be equal are two things the model chose to say.
    const entries = ['  b  ', 'a', '  b  '];
    const outcome = await recall({
      ...WELL_FORMED,
      current_features: { ...FEATURES, symptom_patterns: entries },
    });

    expect(outcome.kind).toBe('RECALLED');
    expect(
      (received[0]?.['current_features'] as Record<string, readonly string[]>)['symptom_patterns'],
    ).toEqual(entries);
  });
});

describe('strings that are only whitespace', () => {
  it.each([
    ['lexical_text', { ...WELL_FORMED, lexical_text: '     ' }],
    ['semantic_text', { ...WELL_FORMED, semantic_text: '  \t  ' }],
    [
      'a feature entry',
      { ...WELL_FORMED, current_features: { ...FEATURES, symptom_patterns: ['ok', '   '] } },
    ],
    [
      'a non-null problem_domain',
      { ...WELL_FORMED, current_features: { ...FEATURES, problem_domain: '   ' } },
    ],
  ])('refuses %s', async (_label, args) => {
    // Refused rather than emptied. A string with nothing in it is not a
    // question, and turning it into one would be searching on the model's behalf.
    const outcome = await recall(args);

    expect(outcome.refusedBySchema).toBe(true);
    expect(received).toEqual([]);
  });
});

describe('strings longer than the Memory accepts', () => {
  it('refuses a lexical text over the bound, even when trimming would have saved it', async () => {
    // This is the case a cleaning schema got wrong. The visible part fits; the
    // whole string does not. What the Memory would be asked to accept is the
    // whole string, so the whole string is what is measured.
    const padded = ` ${'x'.repeat(MEMORY_SEARCH_MAX_LEXICAL_TEXT_LENGTH)} `;
    expect(padded.length).toBeGreaterThan(MEMORY_SEARCH_MAX_LEXICAL_TEXT_LENGTH);
    expect(padded.trim().length).toBeLessThanOrEqual(MEMORY_SEARCH_MAX_LEXICAL_TEXT_LENGTH);

    const outcome = await recall({ ...WELL_FORMED, lexical_text: padded });

    expect(outcome.refusedBySchema).toBe(true);
    expect(received).toEqual([]);
  });

  it('refuses an over-long fuller description that trimming would have saved', async () => {
    const padded = ` ${'x'.repeat(MEMORY_SEARCH_MAX_SEMANTIC_TEXT_LENGTH)} `;

    const outcome = await recall({ ...WELL_FORMED, semantic_text: padded });

    expect(outcome.refusedBySchema).toBe(true);
    expect(received).toEqual([]);
  });

  it('refuses an over-long feature entry that trimming would have saved', async () => {
    const padded = ` ${'x'.repeat(MEMORY_SEARCH_MAX_STRUCTURAL_FEATURE_LENGTH)} `;

    const outcome = await recall({
      ...WELL_FORMED,
      current_features: { ...FEATURES, symptom_patterns: [padded] },
    });

    expect(outcome.refusedBySchema).toBe(true);
    expect(received).toEqual([]);
  });

  it('refuses an over-long problem domain that trimming would have saved', async () => {
    const padded = ` ${'x'.repeat(MEMORY_SEARCH_MAX_STRUCTURAL_FEATURE_LENGTH)} `;

    const outcome = await recall({
      ...WELL_FORMED,
      current_features: { ...FEATURES, problem_domain: padded },
    });

    expect(outcome.refusedBySchema).toBe(true);
    expect(received).toEqual([]);
  });

  it('still accepts a string whose own length is exactly the bound', async () => {
    // The other half: a bound that refused everything would pass every test
    // above while never letting a question through.
    const exact = 'x'.repeat(MEMORY_SEARCH_MAX_LEXICAL_TEXT_LENGTH);

    const outcome = await recall({ ...WELL_FORMED, lexical_text: exact });

    expect(outcome.kind).toBe('RECALLED');
    expect(received[0]?.['lexical_text']).toBe(exact);
  });
});

describe('a refusal says what was wrong, not what was sent', () => {
  it('never echoes the value it turned away', async () => {
    const planted = '  a-value-nobody-should-see-in-a-transcript-line  ';
    const answered = await request('tools/call', {
      name: RECALL_SIMILAR_EXPERIENCE_TOOL,
      arguments: {
        ...WELL_FORMED,
        lexical_text: '   ',
        semantic_text: planted.repeat(1),
        planted_field: planted,
      },
      _meta: { 'claudecode/toolUseId': 'toolu_01ZZZZZZZZZZZZZZZZZZZZZZ' },
    });

    expect(JSON.stringify(answered).includes('a-value-nobody-should-see')).toBe(false);
  });
});

describe('two askings that differ only in whitespace', () => {
  it('are two different questions, and both are asked', async () => {
    // The record is over the exact effective request, not over a guess at what
    // the model meant. Normalising here so that de-duplication catches more
    // would be this runtime deciding two requests are the same question.
    expect((await recall({ ...WELL_FORMED, lexical_text: 'alpha' })).kind).toBe('RECALLED');
    expect((await recall({ ...WELL_FORMED, lexical_text: 'alpha' })).kind).toBe('ALREADY_RECALLED');
    expect((await recall({ ...WELL_FORMED, lexical_text: ' alpha ' })).kind).toBe('RECALLED');
    expect((await recall({ ...WELL_FORMED, lexical_text: ' alpha ' })).kind).toBe(
      'ALREADY_RECALLED',
    );

    expect(received.map((body) => body['lexical_text'])).toEqual(['alpha', ' alpha ']);
  });
});

describe('where the record was kept', () => {
  it('is the plugin data directory the call was authenticated against', async () => {
    // Not a second reading of the environment, and not a path derived from
    // wherever this process happens to be running.
    await recall(WELL_FORMED);

    const { readdir } = await import('node:fs/promises');
    const records = await readdir(join(pluginData, 'recall-fingerprints'));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatch(/^recall-[0-9a-f]{64}\.json$/u);
  });
});
