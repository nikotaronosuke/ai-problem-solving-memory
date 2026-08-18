/**
 * Starting a Problem: the order, and the things the caller does not get to say.
 *
 * Two properties carry this file. The Environment is recorded first and its id
 * is what the Problem is attached to — a Problem pointing at conditions
 * captured afterwards would describe a different moment, and the way that bug
 * arrives is somebody reordering two awaits.
 *
 * And `source_ai` is the adapter's, not the caller's. It is provenance — which
 * assistant recorded this — so a value a caller could set is a value worth
 * setting wrongly, and the test for it is that passing one changes nothing.
 */

import { describe, expect, it } from 'vitest';

import type {
  CreateEnvironmentRequest,
  CreateProblemRequest,
  EnvironmentResource,
  ProblemResource,
} from '@ai-problem-solving-memory/api-client';
import { MemoryApiError, MemoryApiUnreachableError } from '@ai-problem-solving-memory/api-client';

import {
  CLAUDE_CODE_SOURCE_AI,
  startProblem,
  type GitCommandResult,
  type GitRunner,
  type StartProblemClient,
} from '../src/index.js';

const PROJECT_ID = '11111111-2222-4333-8444-555555555555';
const PROJECT_DIR = '/tmp/some-checkout';
const ENVIRONMENT_ID = 'bbbbbbbb-1111-4222-8333-444444444444';
const PROBLEM_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
const COMMIT = '0f1e2d3c4b5a69788796a5b4c3d2e1f009182736';

/** Stands in for something nobody should find in a minimal result. */
const PLANTED = 'a-symptom-nobody-should-see-downstream';

const GIT: GitRunner = (args) => {
  const answers: Record<string, GitCommandResult> = {
    'branch --show-current': { ok: true, stdout: 'main' },
    'rev-parse HEAD': { ok: true, stdout: COMMIT },
  };
  return Promise.resolve(answers[args.join(' ')] ?? { ok: false, stdout: '' });
};

function environment(): EnvironmentResource {
  return {
    environment_id: ENVIRONMENT_ID,
    owner_id: '99999999-8888-4777-8666-555555555555',
    project_id: PROJECT_ID,
    snapshot: { branch: 'main', commit: COMMIT },
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

function problem(overrides: Partial<ProblemResource> = {}): ProblemResource {
  return {
    problem_id: PROBLEM_ID,
    owner_id: '99999999-8888-4777-8666-555555555555',
    project_id: PROJECT_ID,
    environment_id: ENVIRONMENT_ID,
    title: 'the build fails only on the second run',
    symptoms: PLANTED,
    problem_domain: null,
    suspected_boundary: null,
    source_ai: CLAUDE_CODE_SOURCE_AI,
    status: 'INVESTIGATING',
    fix_kind: null,
    importance: false,
    confidence: 'LOW',
    freshness: 'CURRENT',
    memory_read_enabled: true,
    memory_write_enabled: true,
    suppressed: false,
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

interface Log {
  readonly order: string[];
  readonly environments: { projectId: string; request: CreateEnvironmentRequest }[];
  readonly problems: { projectId: string; request: CreateProblemRequest }[];
}

function client(answers: {
  environment?: EnvironmentResource | Error;
  problem?: ProblemResource | Error;
}): { client: StartProblemClient; log: Log } {
  const log: Log = { order: [], environments: [], problems: [] };

  return {
    log,
    client: {
      createEnvironment(projectId, request) {
        log.order.push('createEnvironment');
        log.environments.push({ projectId, request });
        const answer = answers.environment ?? environment();
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      },
      createProblem(projectId, request) {
        log.order.push('createProblem');
        log.problems.push({ projectId, request });
        const answer = answers.problem ?? problem();
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      },
    },
  };
}

const INPUT = {
  projectId: PROJECT_ID,
  projectDir: PROJECT_DIR,
  title: 'the build fails only on the second run',
  symptoms: 'a cached artifact is reused after it should have been invalidated',
  runGit: GIT,
};

describe('the order it does things in', () => {
  it('records the Environment before starting the Problem', async () => {
    const { client: memory, log } = client({});

    await startProblem(memory, INPUT);

    expect(log.order).toEqual(['createEnvironment', 'createProblem']);
  });

  it('attaches the Problem to the Environment it just recorded', async () => {
    const { client: memory, log } = client({});

    await startProblem(memory, INPUT);

    expect(log.problems[0]?.request.environment_id).toBe(ENVIRONMENT_ID);
  });

  it('sends the captured conditions as the snapshot', async () => {
    const { client: memory, log } = client({});

    await startProblem(memory, INPUT);

    expect(log.environments[0]?.request).toEqual({
      snapshot: { branch: 'main', commit: COMMIT },
    });
  });

  it('uses the same Project for both writes', async () => {
    const { client: memory, log } = client({});

    await startProblem(memory, INPUT);

    expect(log.environments[0]?.projectId).toBe(PROJECT_ID);
    expect(log.problems[0]?.projectId).toBe(PROJECT_ID);
  });
});

describe('what it sends', () => {
  it('passes the title and symptoms through unchanged', async () => {
    const { client: memory, log } = client({});

    await startProblem(memory, INPUT);

    expect(log.problems[0]?.request.title).toBe(INPUT.title);
    expect(log.problems[0]?.request.symptoms).toBe(INPUT.symptoms);
  });

  it('leaves an optional field absent when the caller did not mention it', async () => {
    const { client: memory, log } = client({});

    await startProblem(memory, INPUT);

    const request = log.problems[0]?.request ?? ({} as CreateProblemRequest);
    expect('problem_domain' in request).toBe(false);
    expect('suspected_boundary' in request).toBe(false);
  });

  it('keeps an explicit null as a null', async () => {
    const { client: memory, log } = client({});

    await startProblem(memory, { ...INPUT, problemDomain: null, suspectedBoundary: 'cache' });

    const request = log.problems[0]?.request ?? ({} as CreateProblemRequest);
    expect('problem_domain' in request).toBe(true);
    expect(request.problem_domain).toBeNull();
    expect(request.suspected_boundary).toBe('cache');
  });

  it('says which assistant recorded this, from its own constant', async () => {
    const { client: memory, log } = client({});

    await startProblem(memory, INPUT);

    expect(log.problems[0]?.request.source_ai).toBe(CLAUDE_CODE_SOURCE_AI);
  });

  it('does not let a caller claim to be a different assistant', async () => {
    // `source_ai` is provenance, so a value a caller could set is a value worth
    // setting wrongly. The input type has no field for it and an object
    // carrying one changes nothing.
    const { client: memory, log } = client({});

    await startProblem(memory, {
      ...INPUT,
      source_ai: 'some-other-assistant',
      sourceAi: 'some-other-assistant',
    } as never);

    expect(log.problems[0]?.request.source_ai).toBe(CLAUDE_CODE_SOURCE_AI);
    expect(JSON.stringify(log.problems[0]?.request).includes('some-other-assistant')).toBe(false);
  });
});

describe('what it returns', () => {
  it('answers with an identity and a state', async () => {
    const { client: memory } = client({});

    await expect(startProblem(memory, INPUT)).resolves.toEqual({
      problemId: PROBLEM_ID,
      status: 'INVESTIGATING',
    });
  });

  it('carries nothing else the server said', async () => {
    const { client: memory } = client({});

    const result = await startProblem(memory, INPUT);
    const serialised = JSON.stringify(result);

    expect(Object.keys(result).sort()).toEqual(['problemId', 'status']);
    for (const forbidden of [
      'owner_id',
      'environment_id',
      'project_id',
      'symptoms',
      'source_ai',
      'created_at',
      'updated_at',
      'confidence',
      'freshness',
    ]) {
      expect(`${forbidden}:${serialised.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
    expect(serialised.includes(PLANTED)).toBe(false);
    expect(serialised.includes(PROJECT_DIR)).toBe(false);
  });

  it('reports whatever status the server started it in', async () => {
    const { client: memory } = client({ problem: problem({ status: 'FIX_CANDIDATE' }) });

    await expect(startProblem(memory, INPUT)).resolves.toMatchObject({ status: 'FIX_CANDIDATE' });
  });
});

describe('when something fails', () => {
  it('does not start a Problem when the Environment was refused', async () => {
    const { client: memory, log } = client({
      environment: new MemoryApiError(400, 'INVALID_REQUEST', 'req-0'),
    });

    await expect(startProblem(memory, INPUT)).rejects.toBeInstanceOf(MemoryApiError);
    // A Problem needs an Environment. Carrying on would mean attaching it to
    // one that was never recorded.
    expect(log.order).toEqual(['createEnvironment']);
  });

  it('does not start a Problem when the Environment call went unanswered', async () => {
    const { client: memory, log } = client({
      environment: new MemoryApiUnreachableError('TRANSPORT'),
    });

    await expect(startProblem(memory, INPUT)).rejects.toBeInstanceOf(MemoryApiUnreachableError);
    expect(log.order).toEqual(['createEnvironment']);
  });

  it('propagates a refused Problem without trying again', async () => {
    const { client: memory, log } = client({
      problem: new MemoryApiError(400, 'INVALID_REQUEST', 'req-0'),
    });

    await expect(startProblem(memory, INPUT)).rejects.toBeInstanceOf(MemoryApiError);
    expect(log.order).toEqual(['createEnvironment', 'createProblem']);
  });

  it('propagates an unanswered Problem without trying again', async () => {
    // The caller does not know whether it committed, and a second attempt is as
    // likely to create a duplicate as to recover. Whoever called can list.
    const { client: memory, log } = client({
      problem: new MemoryApiUnreachableError('TRANSPORT'),
    });

    await expect(startProblem(memory, INPUT)).rejects.toBeInstanceOf(MemoryApiUnreachableError);
    expect(log.order).toEqual(['createEnvironment', 'createProblem']);
  });

  it('fails before touching the Memory when the directory cannot describe anywhere', async () => {
    const { client: memory, log } = client({});

    await expect(startProblem(memory, { ...INPUT, projectDir: 'relative' })).rejects.toMatchObject({
      name: 'EnvironmentCaptureArgumentError',
    });
    expect(log.order).toEqual([]);
  });
});
