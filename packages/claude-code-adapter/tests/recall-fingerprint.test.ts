/**
 * Not asking the same question twice — and asking again when it is a new one.
 *
 * The digest is what decides that, so what goes into it is the whole design:
 * the Problem, the version it was at, and the request that would be sent. What
 * stays out matters as much. A session restarting is not a new question; a
 * different directory is not a new question; time passing is not a new
 * question. A changed understanding is.
 */

import { describe, expect, it } from 'vitest';

import {
  MEMORY_SEARCH_STRUCTURAL_FEATURE_SCHEMA_VERSION,
  MemoryApiUnreachableError,
  type MemoryApiClient,
  type MemorySearchOutcome,
  type MemorySearchRequest,
  type ProblemResource,
  type ProjectResource,
} from '@ai-problem-solving-memory/api-client';

import {
  recallFingerprintOf,
  recallSimilarExperience,
  type RecallFingerprintRead,
  type RecallFingerprintStore,
  type RecallQuery,
} from '../src/similar-experience-recall.js';
import type { GitRunner } from '../src/project-signals.js';
import type { ProblemBindingWriter } from '../src/problem-lifecycle.js';

const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_SESSION_ID = '77777777-6666-4555-8444-333333333333';
const PROJECT_ID = '22222222-3333-4444-8555-666666666666';
const PROBLEM_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
const REPO = 'github.com/acme/widget';

const gitFor =
  (toplevel: string): GitRunner =>
  (args) => {
    const answers: Record<string, string> = {
      'rev-parse --show-toplevel': toplevel,
      remote: 'origin',
      'remote get-url origin': REPO,
    };
    const stdout = answers[args.join(' ')];
    return Promise.resolve(stdout === undefined ? { ok: false, stdout: '' } : { ok: true, stdout });
  };

const project = (): ProjectResource => ({
  project_id: PROJECT_ID,
  owner_id: '99999999-8888-4777-8666-555555555555',
  project_name: 'widget',
  repo: REPO,
  platform: null,
  repo_subpath: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
});

const problem = (version = 4): ProblemResource => ({
  problem_id: PROBLEM_ID,
  owner_id: '99999999-8888-4777-8666-555555555555',
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
  version,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
});

const query = (
  overrides: Partial<RecallQuery['features']> = {},
  texts: Partial<Pick<RecallQuery, 'lexicalText' | 'semanticText'>> = {},
): RecallQuery => ({
  lexicalText: texts.lexicalText ?? 'export empty scheduled',
  semanticText:
    texts.semanticText ?? 'the scheduled export reports success and writes an empty file',
  features: {
    problemDomain: 'batch export',
    symptomPatterns: ['empty output file'],
    suspectedBoundaries: ['scheduler'],
    occurrenceConditions: ['only on the scheduled run'],
    successfulDirections: ['checked the writer'],
    deadEndDirections: ['blamed the filesystem'],
    environmentFacts: ['runs under the nightly job'],
    ...overrides,
  },
});

/** A store that actually remembers, so two calls can be compared. */
function rememberingStore(): RecallFingerprintStore & {
  readonly records: Map<string, string>;
  writable: boolean;
  readable: boolean;
} {
  const records = new Map<string, string>();
  const store = {
    records,
    writable: true,
    readable: true,
    readFingerprint: (problemId: string): Promise<RecallFingerprintRead> => {
      if (!store.readable) return Promise.resolve({ kind: 'UNAVAILABLE' });
      const fingerprint = records.get(problemId);
      return Promise.resolve(
        fingerprint === undefined ? { kind: 'MISSING' } : { kind: 'FOUND', fingerprint },
      );
    },
    writeFingerprint: (problemId: string, fingerprint: string) => {
      if (!store.writable) return Promise.resolve({ kind: 'NOT_PERSISTED' as const });
      records.set(problemId, fingerprint);
      return Promise.resolve({ kind: 'PERSISTED' as const });
    },
  };
  return store;
}

function memory(options: { version?: number; search?: MemorySearchOutcome } = {}): {
  client: MemoryApiClient;
  searches: MemorySearchRequest[];
} {
  const searches: MemorySearchRequest[] = [];
  const client = {
    listProjects: () => Promise.resolve([project()]),
    listProblems: () => Promise.resolve([]),
    getProblem: () => Promise.resolve(problem(options.version)),
    search: (_problemId: string, request: MemorySearchRequest) => {
      searches.push(request);
      return Promise.resolve(
        options.search ?? {
          kind: 'SEARCHED' as const,
          candidates: [],
          semantic_status: 'USED' as const,
          structural_status: 'USED' as const,
        },
      );
    },
  } as unknown as MemoryApiClient;
  return { client, searches };
}

const bindingStore: ProblemBindingWriter = {
  readBinding: () =>
    Promise.resolve({
      kind: 'VALID',
      binding: { projectId: PROJECT_ID, problemId: PROBLEM_ID },
    } as const),
  writeBinding: () => Promise.reject(new Error('a lookup must never write a binding')),
};

interface RecallOptions {
  readonly store: RecallFingerprintStore;
  readonly client: MemoryApiClient;
  readonly query?: RecallQuery;
  readonly sessionId?: string;
  readonly projectDir?: string;
}

const recall = (options: RecallOptions): ReturnType<typeof recallSimilarExperience> =>
  recallSimilarExperience({
    client: options.client,
    bindingStore,
    fingerprintStore: options.store,
    sessionId: options.sessionId ?? SESSION_ID,
    projectDir: options.projectDir ?? '/work/widget',
    query: options.query ?? query(),
    runGit: gitFor(options.projectDir ?? '/work/widget'),
  });

describe('asking the same question twice', () => {
  it('searches once, then declines without a request', async () => {
    const store = rememberingStore();
    const { client, searches } = memory();

    await expect(recall({ store, client })).resolves.toMatchObject({ kind: 'RECALLED' });
    await expect(recall({ store, client })).resolves.toEqual({ kind: 'ALREADY_RECALLED' });

    expect(searches).toHaveLength(1);
  });

  it('declines across sessions, because the question is about the Problem', async () => {
    // A session restarting is not new understanding. The whole reason the
    // digest holds no session is so that resuming does not re-ask everything.
    const store = rememberingStore();
    const { client, searches } = memory();

    await recall({ store, client, sessionId: SESSION_ID });
    await expect(recall({ store, client, sessionId: OTHER_SESSION_ID })).resolves.toEqual({
      kind: 'ALREADY_RECALLED',
    });

    expect(searches).toHaveLength(1);
  });

  it('declines from another checkout of the same repository', async () => {
    // The path is not part of the question either — the same work, opened
    // somewhere else, is still the same work.
    const store = rememberingStore();
    const { client, searches } = memory();

    await recall({ store, client, projectDir: '/work/widget' });
    await expect(recall({ store, client, projectDir: '/elsewhere/widget' })).resolves.toEqual({
      kind: 'ALREADY_RECALLED',
    });

    expect(searches).toHaveLength(1);
  });
});

describe('asking a new question', () => {
  it.each([
    ['different search terms', () => query({}, { lexicalText: 'scheduler writes nothing' })],
    [
      'a different description',
      () => query({}, { semanticText: 'the batch writes a header and no rows' }),
    ],
    ['a different domain', () => query({ problemDomain: 'scheduling' })],
    ['a new symptom', () => query({ symptomPatterns: ['empty output file', 'no error logged'] })],
    ['a new suspected boundary', () => query({ suspectedBoundaries: ['writer'] })],
    ['a new occurrence condition', () => query({ occurrenceConditions: ['after a redeploy'] })],
    ['a direction that worked', () => query({ successfulDirections: ['read the scheduler log'] })],
    [
      'a direction that did not',
      () => query({ deadEndDirections: ['blamed the filesystem', 'blamed the disk'] }),
    ],
    ['a changed environment fact', () => query({ environmentFacts: ['runs hourly now'] })],
  ])('searches again after %s', async (_label, next) => {
    const store = rememberingStore();
    const { client, searches } = memory();

    await recall({ store, client });
    await expect(recall({ store, client, query: next() })).resolves.toMatchObject({
      kind: 'RECALLED',
    });

    expect(searches).toHaveLength(2);
  });

  it('searches again when the Problem itself has moved', async () => {
    // The version is in the digest precisely so that work recorded against the
    // Problem — including a control being switched — makes the question new.
    const store = rememberingStore();
    const first = memory({ version: 4 });
    await recall({ store, client: first.client });

    const second = memory({ version: 5 });
    await expect(recall({ store, client: second.client })).resolves.toMatchObject({
      kind: 'RECALLED',
    });
    expect(second.searches).toHaveLength(1);
  });
});

describe('which answers settle a question', () => {
  it('remembers a search that ran, even with nothing to show for it', async () => {
    const store = rememberingStore();
    const { client, searches } = memory();

    await recall({ store, client });
    await recall({ store, client });

    expect(searches).toHaveLength(1);
    expect(store.records.size).toBe(1);
  });

  it('remembers a Problem whose owner has reading turned off', async () => {
    // Asking again while nothing has changed would be asking the server to
    // repeat a refusal. Turning the control back on moves the version, and the
    // question becomes new by itself.
    const store = rememberingStore();
    const { client, searches } = memory({ search: { kind: 'MEMORY_READ_DISABLED' } });

    await expect(recall({ store, client })).resolves.toEqual({ kind: 'MEMORY_READ_DISABLED' });
    await expect(recall({ store, client })).resolves.toEqual({ kind: 'ALREADY_RECALLED' });
    expect(searches).toHaveLength(1);
  });

  it.each([['CURRENT_SOURCE_CHANGED'], ['CURRENT_PROBLEM_NOT_AVAILABLE']] as const)(
    'does not remember %s, because the question was never answered',
    async (kind) => {
      const store = rememberingStore();
      const { client, searches } = memory({ search: { kind } as never });

      await expect(recall({ store, client })).resolves.toEqual({ kind });
      expect(store.records.size).toBe(0);

      await recall({ store, client });
      expect(searches).toHaveLength(2);
    },
  );

  it('does not remember a search that failed', async () => {
    const store = rememberingStore();
    const client = {
      listProjects: () => Promise.resolve([project()]),
      listProblems: () => Promise.resolve([]),
      getProblem: () => Promise.resolve(problem()),
      search: () => Promise.reject(new MemoryApiUnreachableError('TRANSPORT')),
    } as unknown as MemoryApiClient;

    await expect(recall({ store, client })).rejects.toBeInstanceOf(MemoryApiUnreachableError);
    expect(store.records.size).toBe(0);
  });
});

describe('when the local store is no help', () => {
  it('searches anyway when it cannot be read', async () => {
    // A cache must never be the reason a Memory goes unread.
    const store = rememberingStore();
    const { client, searches } = memory();

    await recall({ store, client });
    store.readable = false;
    await expect(recall({ store, client })).resolves.toMatchObject({ kind: 'RECALLED' });

    expect(searches).toHaveLength(2);
  });

  it('keeps a successful search successful when it cannot be written', async () => {
    const store = rememberingStore();
    store.writable = false;
    const { client, searches } = memory();

    await expect(recall({ store, client })).resolves.toMatchObject({ kind: 'RECALLED' });
    // The cost of the failure is one repeated search later, and nothing else.
    await expect(recall({ store, client })).resolves.toMatchObject({ kind: 'RECALLED' });
    expect(searches).toHaveLength(2);
  });
});

describe('what the digest itself holds', () => {
  it('is a digest and not the question', async () => {
    const store = rememberingStore();
    const { client } = memory();
    const asked = query();

    await recall({ store, client, query: asked });
    const [stored] = [...store.records.values()];

    expect(stored).toMatch(/^[0-9a-f]{64}$/u);
    for (const forbidden of [
      asked.lexicalText,
      asked.semanticText,
      'batch export',
      'scheduler',
      PROBLEM_ID,
      PROJECT_ID,
      SESSION_ID,
      '/work/widget',
    ]) {
      expect(`the digest reveals ${forbidden}:${String(stored).includes(forbidden)}`).toBe(
        `the digest reveals ${forbidden}:false`,
      );
    }
  });
});

describe('two identical first recalls at the same time', () => {
  /**
   * What this records is a measurement, not a guarantee.
   *
   * The record is a suppression cache and deliberately not a lock. Two calls
   * that both find nothing written will both search, because neither can know
   * the other exists without a lock that would have to be held across a network
   * request. That is the trade being made here, and the reason it is acceptable
   * is that the cost of losing is one extra read of the Memory, while the cost
   * of holding a lock across a search is a recall that hangs on another
   * session's stalled request.
   */
  it('both search, because a cache is not a lock', async () => {
    const store = rememberingStore();
    const { client, searches } = memory();

    const [first, second] = await Promise.all([
      recall({ store, client }),
      recall({ store, client }),
    ]);

    expect(first).toMatchObject({ kind: 'RECALLED' });
    expect(second).toMatchObject({ kind: 'RECALLED' });
    expect(`searches issued by two simultaneous first recalls:${String(searches.length)}`).toBe(
      'searches issued by two simultaneous first recalls:2',
    );
  });

  it('settles on one record, and suppresses everything after', async () => {
    // Both write, and they write the same digest, so which one lands last is
    // not a question worth answering. What matters is that the pair converges
    // rather than leaving the cache in a state that keeps searching forever.
    const store = rememberingStore();
    const { client, searches } = memory();

    await Promise.all([recall({ store, client }), recall({ store, client })]);

    expect(store.records.size).toBe(1);
    await expect(recall({ store, client })).resolves.toEqual({ kind: 'ALREADY_RECALLED' });
    expect(searches).toHaveLength(2);
  });

  it('leaves exactly one of two racing questions on record, not both and not neither', async () => {
    // Two different questions racing is the case worth measuring, because only
    // one digest fits. The measured behaviour is that the later write wins and
    // the question that lost is simply not on record — so it searches again
    // when asked, which is the safe direction to lose in. What must not happen
    // is the loser being treated as already answered.
    const store = rememberingStore();
    const { client, searches } = memory();
    const asAsked = query();
    const different = query({ problemDomain: 'scheduling' });

    await Promise.all([
      recall({ store, client, query: asAsked }),
      recall({ store, client, query: different }),
    ]);
    expect(searches).toHaveLength(2);
    expect(store.records.size).toBe(1);

    const again = await Promise.all([
      recall({ store, client, query: asAsked }),
      recall({ store, client, query: different }),
    ]);

    // One of the two is on record and one is not. Which one is the race's to
    // decide; that exactly one is, is not.
    const suppressed = again.filter((outcome) => outcome.kind === 'ALREADY_RECALLED');
    expect(`questions suppressed after the race:${String(suppressed.length)}`).toBe(
      'questions suppressed after the race:1',
    );
  });
});

describe('the string that is actually hashed', () => {
  /** Captures the canonical form instead of hashing it. */
  function canonicalOf(request: MemorySearchRequest, version = 4): string {
    let seen = '';
    recallFingerprintOf(PROBLEM_ID, version, request, (canonical) => {
      seen = canonical;
      return 'a'.repeat(64);
    });
    return seen;
  }

  const requestFor = (overrides: Partial<MemorySearchRequest> = {}): MemorySearchRequest => ({
    source_ai: 'claude-code',
    lexical_text: 'export empty scheduled',
    semantic_text: 'the scheduled export reports success and writes an empty file',
    current_features: {
      schema_version: MEMORY_SEARCH_STRUCTURAL_FEATURE_SCHEMA_VERSION,
      problem_domain: 'batch export',
      symptom_patterns: ['empty output file'],
      suspected_boundaries: ['scheduler'],
      occurrence_conditions: ['only on the scheduled run'],
      successful_directions: ['checked the writer'],
      dead_end_directions: ['blamed the filesystem'],
      environment_facts: ['runs under the nightly job'],
    },
    ...overrides,
  });

  it('says what kind of hash it is before anything else', () => {
    // Domain separation is invisible from the outside — every digest still
    // differs from every other one — so it can only be checked by looking at
    // what is hashed. Without the label this value could one day be compared
    // against a digest of something else entirely that happened to be built
    // from the same parts.
    const canonical = canonicalOf(requestFor());

    expect(canonical.startsWith('["recall-fingerprint/1"')).toBe(true);
  });

  it('carries which AI is asking', () => {
    // Two assistants asking the same words are not asking the same question:
    // the Memory weighs its own record differently depending on who is asking,
    // so an answer to one is not an answer already given to the other.
    const mine = canonicalOf(requestFor());
    const theirs = canonicalOf(requestFor({ source_ai: 'another-assistant' }));

    expect(mine).not.toBe(theirs);
    expect(canonicalOf(requestFor())).toBe(mine);
  });

  it('carries the vocabulary the features are written in', () => {
    // Only one vocabulary exists, and the request type says so on purpose, so
    // the second one has to be reached for past the type. That is the whole
    // point of the check: when a second vocabulary does arrive, the same words
    // written in it must not be mistaken for a question already asked.
    const first = canonicalOf(requestFor());
    const second = canonicalOf(
      requestFor({
        current_features: {
          ...requestFor().current_features,
          schema_version: '2' as typeof MEMORY_SEARCH_STRUCTURAL_FEATURE_SCHEMA_VERSION,
        },
      }),
    );

    expect(first).not.toBe(second);
  });

  it('carries every one of the seven feature lists', () => {
    const base = requestFor();
    const fields = [
      'problem_domain',
      'symptom_patterns',
      'suspected_boundaries',
      'occurrence_conditions',
      'successful_directions',
      'dead_end_directions',
      'environment_facts',
    ] as const;

    for (const field of fields) {
      const changed = canonicalOf(
        requestFor({
          current_features: {
            ...base.current_features,
            [field]: field === 'problem_domain' ? 'something else' : ['something else'],
          },
        }),
      );

      expect(
        `changing ${field} changes the question:${String(changed !== canonicalOf(base))}`,
      ).toBe(`changing ${field} changes the question:true`);
    }
  });

  it('holds nothing about this particular asking', () => {
    const canonical = canonicalOf(requestFor());

    // Not the session, not where the work is checked out, not the time. Each
    // of those would make resuming look like a question nobody had asked.
    for (const forbidden of [SESSION_ID, OTHER_SESSION_ID, '/work/widget', 'Z']) {
      expect(`the canonical form holds ${forbidden}:${String(canonical.includes(forbidden))}`).toBe(
        `the canonical form holds ${forbidden}:false`,
      );
    }
  });
});
