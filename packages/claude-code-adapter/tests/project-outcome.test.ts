/**
 * Registering and selecting a Project, and everything that must be read again
 * before either happens.
 *
 * The assertions that carry this file are about writes that do *not* happen. A
 * second Project for one repository, a boundary the owner never chose, a
 * repository-less Project created because nobody said not to — each is easy to
 * produce, none of them fails visibly, and all of them split a Memory across
 * records that should have been one.
 *
 * The recheck is the load-bearing part: both functions resolve at the moment
 * they are called, and neither will act on an answer from an earlier turn.
 */

import { describe, expect, it } from 'vitest';

import type { CreateProjectRequest, ProjectResource } from '@ai-problem-solving-memory/api-client';
import { MemoryApiError, MemoryApiUnreachableError } from '@ai-problem-solving-memory/api-client';

import {
  registerProject,
  selectProject,
  ProjectRegistrationArgumentError,
  ProjectRegistrationInvariantError,
  type ProjectRegistrationClient,
  type ProjectSignals,
} from '../src/index.js';

const REPO = 'github.com/acme/widget';

/** Synthetic. Stands in for a token somebody once typed into a remote. */
const FAKE_TOKEN = 'ghp-fake-token-marker-Zx9Q7Ck2V';

function project(overrides: Partial<ProjectResource> = {}): ProjectResource {
  return {
    project_id: 'existing',
    owner_id: '99999999-8888-4777-8666-555555555555',
    project_name: 'widget',
    repo: REPO,
    platform: null,
    repo_subpath: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function signals(overrides: Partial<ProjectSignals> = {}): ProjectSignals {
  return {
    projectNameHint: 'widget',
    insideGit: true,
    primaryRemote: REPO,
    secondaryRemotes: [],
    monorepoSubpath: null,
    ...overrides,
  };
}

interface Recorded {
  readonly creates: CreateProjectRequest[];
  lists: number;
}

/**
 * A client whose list answer may change between reads.
 *
 * `listings` is consumed one entry per call, so a test can say what the world
 * looked like before a write and what it looks like after — which is the only
 * way to drive the recheck.
 */
function client(options: {
  listings: readonly (readonly ProjectResource[])[];
  onCreate?: (request: CreateProjectRequest) => ProjectResource | Error;
}): { client: ProjectRegistrationClient; recorded: Recorded } {
  const state = { creates: [] as CreateProjectRequest[], lists: 0 };

  const api: ProjectRegistrationClient = {
    listProjects: () => {
      const index = Math.min(state.lists, options.listings.length - 1);
      state.lists += 1;
      return Promise.resolve(options.listings[index] ?? []);
    },
    createProject: (request) => {
      state.creates.push(request);
      const answer = options.onCreate?.(request) ?? project({ project_id: 'created', ...request });
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };

  // Returned as the live object rather than a snapshot: destructuring a getter
  // would freeze the counters at zero, which is exactly the kind of test bug
  // that reports "no calls were made" for code that made them.
  return { client: api, recorded: state };
}

/** A created Project the resolver will then find. */
function createdMatching(request: CreateProjectRequest): ProjectResource {
  return project({
    project_id: 'created',
    project_name: request.project_name,
    repo: request.repo ?? null,
    repo_subpath: request.repo_subpath ?? null,
  });
}

describe('what registration refuses to do', () => {
  it('does not create when the repository already resolves', async () => {
    const { client: api, recorded } = client({ listings: [[project()]] });

    await expect(registerProject(api, signals())).resolves.toEqual({
      kind: 'RESOLVED',
      projectId: 'existing',
    });
    expect(recorded.creates).toEqual([]);
  });

  it('does not create when the answer is ambiguous', async () => {
    const { client: api, recorded } = client({
      listings: [[project({ project_id: 'a' }), project({ project_id: 'b' })]],
    });

    const result = await registerProject(api, signals());

    expect(result).toMatchObject({ kind: 'AMBIGUOUS', reason: 'MULTIPLE_PROJECTS_FOR_REMOTE' });
    expect(recorded.creates).toEqual([]);
  });

  it('does not create when there is no project signal at all', async () => {
    const { client: api, recorded } = client({ listings: [[]] });

    await expect(registerProject(api, null)).resolves.toEqual({ kind: 'NO_PROJECT_SIGNAL' });
    expect(recorded.creates).toEqual([]);
  });
});

describe('a repository nothing records yet, at its root', () => {
  it('registers it without asking', async () => {
    // The strongest ordinary case: a canonical remote, the session at the root,
    // nothing recorded. There is no question to put to anybody.
    const { client: api, recorded } = client({
      listings: [[], [createdMatching({ project_name: 'widget', repo: REPO })]],
      onCreate: createdMatching,
    });

    await expect(registerProject(api, signals())).resolves.toEqual({
      kind: 'CREATED',
      projectId: 'created',
    });
    expect(recorded.creates).toEqual([{ project_name: 'widget', repo: REPO, repo_subpath: null }]);
  });

  it('invents no platform', async () => {
    const { client: api, recorded } = client({
      listings: [[], [createdMatching({ project_name: 'widget', repo: REPO })]],
      onCreate: createdMatching,
    });

    await registerProject(api, signals());

    // Nothing here knows a platform, and a label recorded as a fact would be a
    // guess stored permanently.
    expect('platform' in (recorded.creates[0] ?? {})).toBe(false);
  });

  it('treats an explicit root choice the same way', async () => {
    const { client: api, recorded } = client({
      listings: [[], [createdMatching({ project_name: 'widget', repo: REPO })]],
      onCreate: createdMatching,
    });

    await expect(
      registerProject(api, signals(), { kind: 'REPOSITORY_ROOT' }),
    ).resolves.toMatchObject({ kind: 'CREATED' });
    expect(recorded.creates[0]?.repo_subpath).toBeNull();
  });

  it('refuses a boundary choice from a session at the root', async () => {
    // A subdirectory boundary would not cover a session sitting above it.
    const { client: api, recorded } = client({ listings: [[]] });

    await expect(
      registerProject(api, signals(), { kind: 'REPOSITORY_BOUNDARY', repoSubpath: 'apps/web' }),
    ).rejects.toBeInstanceOf(ProjectRegistrationArgumentError);
    expect(recorded.creates).toEqual([]);
  });
});

describe('a repository nothing records yet, inside a subdirectory', () => {
  const inside = signals({ monorepoSubpath: 'apps/web/client' });

  it('asks which part of the repository this is', async () => {
    const { client: api, recorded } = client({ listings: [[]] });

    const result = await registerProject(api, inside);

    // The detected location is evidence, not an answer: whether `apps/web` is
    // its own Project is the owner's decision, and persisting the detected
    // value because it happened to be there would make every subdirectory a
    // Project by accident.
    expect(result).toMatchObject({ kind: 'BOUNDARY_REQUIRED' });
    expect(recorded.creates).toEqual([]);
  });

  it('offers the material for answering, and nothing else', async () => {
    const { client: api } = client({ listings: [[]] });

    const result = await registerProject(api, inside);

    if (result.kind === 'BOUNDARY_REQUIRED') {
      expect(Object.keys(result.suggestion).sort()).toEqual([
        'monorepoSubpath',
        'projectName',
        'repo',
      ]);
      expect(result.suggestion.monorepoSubpath).toBe('apps/web/client');
    }
  });

  it('registers the whole repository when that is the choice', async () => {
    const { client: api, recorded } = client({
      listings: [[], [createdMatching({ project_name: 'widget', repo: REPO })]],
      onCreate: createdMatching,
    });

    await expect(registerProject(api, inside, { kind: 'REPOSITORY_ROOT' })).resolves.toMatchObject({
      kind: 'CREATED',
    });
    expect(recorded.creates[0]?.repo_subpath).toBeNull();
  });

  it.each([
    ['the exact location', 'apps/web/client'],
    ['a parent of it', 'apps/web'],
    ['the outermost ancestor', 'apps'],
  ])('accepts %s as a boundary', async (_name, repoSubpath) => {
    const { client: api, recorded } = client({
      listings: [
        [],
        [createdMatching({ project_name: 'widget', repo: REPO, repo_subpath: repoSubpath })],
      ],
      onCreate: createdMatching,
    });

    await expect(
      registerProject(api, inside, { kind: 'REPOSITORY_BOUNDARY', repoSubpath }),
    ).resolves.toMatchObject({ kind: 'CREATED' });
    expect(recorded.creates[0]?.repo_subpath).toBe(repoSubpath);
  });

  it.each([
    ['a sibling', 'apps/api'],
    ['a lookalike neighbour', 'apps/web-old'],
    ['somewhere deeper than the session', 'apps/web/client/inner'],
    ['a traversal', '../apps'],
    ['an absolute path', '/apps'],
    ['a Windows path', 'apps\\web'],
    ['nothing at all', ''],
    ['a trailing separator', 'apps/web/'],
  ])('refuses %s, and creates nothing', async (_name, repoSubpath) => {
    // Each of these would register a Project that does not cover the session
    // about to work in it.
    const { client: api, recorded } = client({ listings: [[]] });

    await expect(
      registerProject(api, inside, { kind: 'REPOSITORY_BOUNDARY', repoSubpath }),
    ).rejects.toBeInstanceOf(ProjectRegistrationArgumentError);
    expect(recorded.creates).toEqual([]);
  });

  it('does not normalise a boundary into a valid one', async () => {
    // `apps/web/` is not tidied into `apps/web`. A rewritten boundary is one
    // the owner did not choose.
    const { client: api, recorded } = client({ listings: [[]] });

    await expect(
      registerProject(api, inside, { kind: 'REPOSITORY_BOUNDARY', repoSubpath: 'apps/web/' }),
    ).rejects.toBeInstanceOf(ProjectRegistrationArgumentError);
    expect(recorded.creates).toEqual([]);
  });

  it('names the argument and never the boundary it refused', async () => {
    const planted = 'clients/acme-private/secret-app';
    const { client: api } = client({ listings: [[]] });

    const raised = await registerProject(api, inside, {
      kind: 'REPOSITORY_BOUNDARY',
      repoSubpath: planted,
    }).catch((error: unknown) => error);

    expect((raised as ProjectRegistrationArgumentError).argument).toBe('repository boundary');
    expect((raised as Error).message.includes(planted)).toBe(false);
    expect((raised as Error).message.includes('acme-private')).toBe(false);
  });
});

describe('somewhere with no repository', () => {
  const nameOnly = signals({ primaryRemote: null, insideGit: false });

  it('asks for explicit intent rather than registering a name', async () => {
    // A name is a label somebody chose, not an identity: two directories called
    // `api` are not one Project.
    const { client: api, recorded } = client({ listings: [[]] });

    const result = await registerProject(api, nameOnly);

    expect(result).toMatchObject({ kind: 'EXPLICIT_REGISTRATION_REQUIRED' });
    expect(recorded.creates).toEqual([]);
  });

  it('registers when somebody says so, with no repository and no boundary', async () => {
    const { client: api, recorded } = client({
      listings: [[], []],
      onCreate: createdMatching,
    });

    await expect(
      registerProject(api, nameOnly, { kind: 'REGISTER_WITHOUT_REPOSITORY' }),
    ).resolves.toEqual({ kind: 'CREATED', projectId: 'created' });
    expect(recorded.creates).toEqual([{ project_name: 'widget', repo: null, repo_subpath: null }]);
  });

  it('does not ask the resolver to confirm what it cannot resolve', async () => {
    // A Project with no repository resolves by name, which is ambiguity by
    // design. Requiring the resolver to select it would be requiring it to do
    // the thing it correctly refuses.
    const created = project({ project_id: 'created', repo: null, project_name: 'widget' });
    const { client: api } = client({
      listings: [[], [created]],
      onCreate: () => created,
    });

    await expect(
      registerProject(api, nameOnly, { kind: 'REGISTER_WITHOUT_REPOSITORY' }),
    ).resolves.toEqual({ kind: 'CREATED', projectId: 'created' });
  });

  it('refuses a repository-less choice where a repository exists', async () => {
    // Registering without the repository would throw away the only durable
    // identity this session has.
    const { client: api, recorded } = client({ listings: [[]] });

    await expect(
      registerProject(api, signals(), { kind: 'REGISTER_WITHOUT_REPOSITORY' }),
    ).rejects.toBeInstanceOf(ProjectRegistrationArgumentError);
    expect(recorded.creates).toEqual([]);
  });

  it('refuses a boundary choice where there is no repository', async () => {
    const { client: api, recorded } = client({ listings: [[]] });

    await expect(
      registerProject(api, nameOnly, { kind: 'REPOSITORY_BOUNDARY', repoSubpath: 'apps/web' }),
    ).rejects.toBeInstanceOf(ProjectRegistrationArgumentError);
    expect(recorded.creates).toEqual([]);
  });
});

describe('reading again immediately before writing', () => {
  it('uses a Project that appeared between the decision and the call', async () => {
    // Somebody else registered this repository a moment ago. Creating a second
    // one would split the Memory across two records, and nothing would look
    // broken afterwards.
    const { client: api, recorded } = client({ listings: [[project()]] });

    await expect(registerProject(api, signals())).resolves.toEqual({
      kind: 'RESOLVED',
      projectId: 'existing',
    });
    expect(recorded.creates).toEqual([]);
  });

  it('reports an ambiguity that appeared between the decision and the call', async () => {
    const { client: api, recorded } = client({
      listings: [[project({ project_id: 'a' }), project({ project_id: 'b' })]],
    });

    await expect(registerProject(api, signals())).resolves.toMatchObject({ kind: 'AMBIGUOUS' });
    expect(recorded.creates).toEqual([]);
  });

  it('confirms the created Project is the one the resolver now selects', async () => {
    const { client: api, recorded } = client({
      listings: [[], [createdMatching({ project_name: 'widget', repo: REPO })]],
      onCreate: createdMatching,
    });

    await expect(registerProject(api, signals())).resolves.toEqual({
      kind: 'CREATED',
      projectId: 'created',
    });
    // Read, created, read again.
    expect(recorded.lists).toBe(2);
  });

  it('answers with the Project the resolver selects when another arrived alongside', async () => {
    // A simultaneous create that the boundaries say is the better answer. Both
    // are usable identities; the resolver's is the one to work under.
    const { client: api } = client({
      listings: [[], [project({ project_id: 'theirs' })]],
      onCreate: createdMatching,
    });

    await expect(registerProject(api, signals())).resolves.toEqual({
      kind: 'RESOLVED',
      projectId: 'theirs',
    });
  });

  it('surfaces a simultaneous duplicate as the ambiguity it is', async () => {
    const { client: api } = client({
      listings: [[], [project({ project_id: 'a' }), project({ project_id: 'b' })]],
      onCreate: createdMatching,
    });

    await expect(registerProject(api, signals())).resolves.toMatchObject({
      kind: 'AMBIGUOUS',
      reason: 'MULTIPLE_PROJECTS_FOR_REMOTE',
    });
  });

  it('stops when a created Project does not resolve at all', async () => {
    // The server and this resolver disagree about identity. Continuing under an
    // id the resolver would not select is worse than stopping, and a second
    // create would make it worse still.
    const { client: api, recorded } = client({
      listings: [[], []],
      onCreate: createdMatching,
    });

    await expect(registerProject(api, signals())).rejects.toBeInstanceOf(
      ProjectRegistrationInvariantError,
    );
    expect(recorded.creates).toHaveLength(1);
  });
});

describe('when a create goes unanswered', () => {
  it('reports a Project that is now resolvable', async () => {
    // The request may or may not have committed. Reading again cannot say which
    // — and does not need to: a Project that resolves is one to work in,
    // whoever created it.
    const { client: api, recorded } = client({
      listings: [[], [project()]],
      onCreate: () => new MemoryApiUnreachableError('TRANSPORT'),
    });

    await expect(registerProject(api, signals())).resolves.toEqual({
      kind: 'RESOLVED',
      projectId: 'existing',
    });
    expect(recorded.creates).toHaveLength(1);
  });

  it('reports an ambiguity that is now visible', async () => {
    const { client: api } = client({
      listings: [[], [project({ project_id: 'a' }), project({ project_id: 'b' })]],
      onCreate: () => new MemoryApiUnreachableError('TRANSPORT'),
    });

    await expect(registerProject(api, signals())).resolves.toMatchObject({ kind: 'AMBIGUOUS' });
  });

  it('propagates the original failure when nothing can be proven', async () => {
    // Still unknown, and saying anything else would be inventing an answer.
    const unreachable = new MemoryApiUnreachableError('TRANSPORT');
    const { client: api, recorded } = client({
      listings: [[], []],
      onCreate: () => unreachable,
    });

    await expect(registerProject(api, signals())).rejects.toBe(unreachable);
    expect(recorded.creates).toHaveLength(1);
  });

  it('propagates it for a repository-less registration without pretending to check', async () => {
    // A name-only ambiguity could not prove which record was ours anyway.
    const unreachable = new MemoryApiUnreachableError('TRANSPORT');
    const { client: api, recorded } = client({
      listings: [[], [project({ repo: null })]],
      onCreate: () => unreachable,
    });

    await expect(
      registerProject(api, signals({ primaryRemote: null }), {
        kind: 'REGISTER_WITHOUT_REPOSITORY',
      }),
    ).rejects.toBe(unreachable);
    expect(recorded.creates).toHaveLength(1);
  });

  it('propagates a refusal untouched, because the server answered', async () => {
    const refused = new MemoryApiError(400, 'INVALID_REQUEST', 'req-0');
    const { client: api, recorded } = client({ listings: [[], []], onCreate: () => refused });

    await expect(registerProject(api, signals())).rejects.toBe(refused);
    // No recovery read: there is nothing unknown to discover.
    expect(recorded.lists).toBe(1);
  });

  it('never sends a second create', async () => {
    const { client: api, recorded } = client({
      listings: [[], [project()]],
      onCreate: () => new MemoryApiUnreachableError('TRANSPORT'),
    });

    await registerProject(api, signals());

    expect(recorded.creates).toHaveLength(1);
  });
});

describe('what a registration result may carry', () => {
  it('answers a creation with an identity and nothing else', async () => {
    const { client: api } = client({
      listings: [[], [createdMatching({ project_name: 'widget', repo: REPO })]],
      onCreate: createdMatching,
    });

    const result = await registerProject(api, signals());

    expect(Object.keys(result).sort()).toEqual(['kind', 'projectId']);
  });

  it('carries no stored repository out, credential-bearing or otherwise', async () => {
    const { client: api } = client({
      listings: [
        [
          project({
            project_id: 'a',
            repo: `https://x-access-token:${FAKE_TOKEN}@github.com/acme/widget`,
          }),
          project({ project_id: 'b' }),
        ],
      ],
    });

    const result = await registerProject(api, signals());
    const serialised = JSON.stringify(result);

    expect(serialised.includes(FAKE_TOKEN)).toBe(false);
    for (const forbidden of ['owner_id', 'created_at', 'updated_at', 'platform']) {
      expect(`${forbidden} travelled:${serialised.includes(forbidden)}`).toBe(
        `${forbidden} travelled:false`,
      );
    }
  });
});

describe('accepting a choice between ambiguous Projects', () => {
  it('accepts an id the current evidence still offers', async () => {
    const { client: api } = client({
      listings: [[project({ project_id: 'a' }), project({ project_id: 'b' })]],
    });

    await expect(selectProject(api, signals(), 'b')).resolves.toEqual({
      kind: 'SELECTED',
      projectId: 'b',
    });
  });

  it('refuses an id the current evidence no longer offers', async () => {
    // The list it came from is gone. Accepting it would attach this work to a
    // Project nothing currently points at.
    const { client: api } = client({
      listings: [[project({ project_id: 'a' }), project({ project_id: 'b' })]],
    });

    const result = await selectProject(api, signals(), 'vanished');

    expect(result).toMatchObject({ kind: 'SELECTION_STALE' });
    if (result.kind === 'SELECTION_STALE') {
      expect(result.resolution).toMatchObject({ kind: 'AMBIGUOUS' });
    }
  });

  it('accepts a choice an ambiguity resolved itself into', async () => {
    // Somebody merged the duplicate between the offer and the answer. That is
    // the choice, confirmed.
    const { client: api } = client({ listings: [[project({ project_id: 'a' })]] });

    await expect(selectProject(api, signals(), 'a')).resolves.toEqual({
      kind: 'SELECTED',
      projectId: 'a',
    });
  });

  it('refuses a choice the resolution now contradicts', async () => {
    const { client: api } = client({ listings: [[project({ project_id: 'a' })]] });

    const result = await selectProject(api, signals(), 'b');

    expect(result).toMatchObject({ kind: 'SELECTION_STALE' });
    if (result.kind === 'SELECTION_STALE') {
      expect(result.resolution).toEqual({ kind: 'RESOLVED', projectId: 'a' });
    }
  });

  it.each([['nothing records the repository', [] as ProjectResource[]]])(
    'refuses a choice when %s',
    async (_name, listing) => {
      const { client: api } = client({ listings: [listing] });

      await expect(selectProject(api, signals(), 'a')).resolves.toMatchObject({
        kind: 'SELECTION_STALE',
      });
    },
  );

  it('refuses a choice when there is no project signal', async () => {
    const { client: api } = client({ listings: [[]] });

    const result = await selectProject(api, null, 'a');

    expect(result).toEqual({
      kind: 'SELECTION_STALE',
      resolution: { kind: 'NO_PROJECT_SIGNAL' },
    });
  });

  it('does not choose the first candidate for somebody', async () => {
    const { client: api } = client({
      listings: [[project({ project_id: 'first' }), project({ project_id: 'second' })]],
    });

    await expect(selectProject(api, signals(), 'neither')).resolves.toMatchObject({
      kind: 'SELECTION_STALE',
    });
  });

  it('decides the same way whichever order the candidates arrived in', async () => {
    const forwards = client({
      listings: [[project({ project_id: 'a' }), project({ project_id: 'b' })]],
    });
    const backwards = client({
      listings: [[project({ project_id: 'b' }), project({ project_id: 'a' })]],
    });

    await expect(selectProject(forwards.client, signals(), 'b')).resolves.toMatchObject({
      kind: 'SELECTED',
    });
    await expect(selectProject(backwards.client, signals(), 'b')).resolves.toMatchObject({
      kind: 'SELECTED',
    });
  });

  it('reads the Projects fresh rather than taking a list on trust', async () => {
    const { client: api, recorded } = client({
      listings: [[project({ project_id: 'a' }), project({ project_id: 'b' })]],
    });

    await selectProject(api, signals(), 'a');

    expect(recorded.lists).toBe(1);
  });

  it('lets a Memory failure travel', async () => {
    const unreachable = new MemoryApiUnreachableError('TRANSPORT');
    const api = { listProjects: () => Promise.reject(unreachable) };

    await expect(selectProject(api, signals(), 'a')).rejects.toBe(unreachable);
  });

  it('carries an identity out and nothing else', async () => {
    const { client: api } = client({ listings: [[project({ project_id: 'a' })]] });

    const result = await selectProject(api, signals(), 'a');

    expect(Object.keys(result).sort()).toEqual(['kind', 'projectId']);
  });

  it('keeps a refused id out of the answer it gives back', async () => {
    const planted = 'a-project-id-nobody-should-echo';
    const { client: api } = client({ listings: [[project({ project_id: 'a' })]] });

    const result = await selectProject(api, signals(), planted);
    const serialised = JSON.stringify(result);

    expect(serialised.includes(planted)).toBe(false);
  });
});
