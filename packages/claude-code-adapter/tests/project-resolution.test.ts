/**
 * Which Project a session belongs to, and when the honest answer is "ask".
 *
 * The interesting assertions here are the negative ones. It is easy to write a
 * resolver that always produces a Project, and every one of the cases below is a
 * place where producing one would file somebody's Memory under the wrong
 * long-term unit of work — silently, and for as long as nobody noticed.
 *
 * So: a secondary remote never resolves, one name match never resolves, and two
 * Projects on one repository never resolve to whichever came first.
 */

import { describe, expect, it } from 'vitest';

import type { ProjectResource } from '@ai-problem-solving-memory/api-client';

import { resolveProject, type ProjectReader, type ProjectSignals } from '../src/index.js';

/** Synthetic. Stands in for a token somebody once typed into a remote. */
const FAKE_TOKEN = 'ghp-fake-token-marker-Zx9Q7Ck2V';

function project(overrides: Partial<ProjectResource> = {}): ProjectResource {
  return {
    project_id: '11111111-2222-4333-8444-555555555555',
    owner_id: '99999999-8888-4777-8666-555555555555',
    project_name: 'widget',
    repo: 'github.com/acme/widget',
    platform: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function signals(overrides: Partial<ProjectSignals> = {}): ProjectSignals {
  return {
    projectNameHint: 'widget',
    insideGit: true,
    primaryRemote: 'github.com/acme/widget',
    secondaryRemotes: [],
    monorepoSubpath: null,
    ...overrides,
  };
}

/** A reader that answers with a fixed list, and counts. */
function reader(projects: ProjectResource[]): ProjectReader & { calls: number } {
  const state = {
    calls: 0,
    listProjects: () => {
      state.calls += 1;
      return Promise.resolve(projects as readonly ProjectResource[]);
    },
  };
  return state;
}

describe('when there is nothing to go on', () => {
  it('reports no project signal without asking the Memory anything', async () => {
    const client = reader([project()]);

    const resolution = await resolveProject(client, null);

    expect(resolution).toEqual({ kind: 'NO_PROJECT_SIGNAL' });
    // No signal is knowable here; spending a request to confirm it would be a
    // request that could only ever return the same answer.
    expect(client.calls).toBe(0);
  });
});

describe('a repository the Memory already knows', () => {
  it('resolves when exactly one Project records it', async () => {
    const known = project({ repo: 'git@github.com:acme/widget.git' });
    const client = reader([project({ project_id: 'other', repo: 'github.com/acme/other' }), known]);

    const resolution = await resolveProject(client, signals());

    // The stored value and the detected one are different spellings of one
    // repository, which is exactly what canonicalisation is for.
    expect(resolution).toEqual({ kind: 'RESOLVED', projectId: known.project_id });
  });

  it('answers with an identity and nothing else', async () => {
    const known = project({ platform: 'typescript', repo: 'https://github.com/acme/widget.git' });
    const client = reader([known]);

    const resolution = await resolveProject(client, signals());

    // Exact, so a field added here has to be a deliberate edit somebody makes
    // while thinking about whether it should travel. The first version passed
    // the server's whole record through on the grounds that a caller might want
    // it; formal review rejected that, because "might want" is not a requirement
    // and a passthrough is the widest possible answer to a narrow question.
    expect(Object.keys(resolution).sort()).toEqual(['kind', 'projectId']);
    expect(resolution).toEqual({ kind: 'RESOLVED', projectId: known.project_id });
  });

  it.each([
    ['a name', 'project_name', 'widget'],
    ['an owner', 'owner_id', '99999999-8888-4777-8666-555555555555'],
    ['a platform', 'platform', 'typescript'],
    ['a creation time', 'created_at', '2026-01-01T00:00:00.000Z'],
  ])('does not carry %s out of the Project it matched', async (_case, field, value) => {
    const known = project({ [field]: value, project_id: 'the-one' });
    const client = reader([known]);

    const resolution = await resolveProject(client, signals());

    // The whole resolution, serialised: a field that reached the output through
    // any route at all shows up here, not only one added to the type.
    const serialised = JSON.stringify(resolution);
    expect(`${field} travelled:${serialised.includes(value)}`).toBe(`${field} travelled:false`);
    expect(serialised.includes('the-one')).toBe(true);
  });

  it('ignores Projects with no repository recorded', async () => {
    const client = reader([project({ repo: null }), project({ project_id: 'second' })]);

    const resolution = await resolveProject(client, signals());

    expect(resolution).toEqual({ kind: 'RESOLVED', projectId: 'second' });
  });

  it('carries no repository out, credential-bearing or otherwise', async () => {
    const stored = `https://x-access-token:${FAKE_TOKEN}@github.com/acme/widget.git`;
    const client = reader([project({ project_id: 'the-one', repo: stored })]);

    const resolution = await resolveProject(client, signals());

    expect(resolution).toEqual({ kind: 'RESOLVED', projectId: 'the-one' });
    // Booleans, so a failure does not print what it found. A stored `repo` is
    // free-form text somebody may have typed a token into, and a resolution has
    // no reason to carry it in any form — canonical or otherwise.
    const serialised = JSON.stringify(resolution);
    expect(`token travelled:${serialised.includes(FAKE_TOKEN)}`).toBe('token travelled:false');
    expect(`repo travelled:${serialised.includes('github.com')}`).toBe('repo travelled:false');
  });
});

describe('a repository more than one Project claims', () => {
  it('refuses to choose between them', async () => {
    const first = project({
      project_id: 'first',
      project_name: 'web',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    const second = project({
      project_id: 'second',
      project_name: 'mobile',
      created_at: '2026-06-01T00:00:00.000Z',
      repo: 'git@github.com:acme/widget.git',
    });
    const client = reader([first, second]);

    const resolution = await resolveProject(client, signals());

    // The owner split one repository into two Projects, or a duplicate exists.
    // Both are real, and only the owner knows which.
    expect(resolution).toMatchObject({
      kind: 'AMBIGUOUS',
      reason: 'MULTIPLE_PROJECTS_FOR_REMOTE',
    });
    if (resolution.kind === 'AMBIGUOUS') {
      expect(resolution.candidates.map((candidate) => candidate.projectId)).toEqual([
        'first',
        'second',
      ]);
    }
  });

  it('does not quietly take the first or the newest', async () => {
    const older = project({ project_id: 'older', created_at: '2020-01-01T00:00:00.000Z' });
    const newer = project({ project_id: 'newer', created_at: '2026-08-01T00:00:00.000Z' });

    for (const order of [
      [older, newer],
      [newer, older],
    ]) {
      const resolution = await resolveProject(reader(order), signals());

      // Both rules are stable and both are a coin flip wearing a rule's clothes.
      expect(resolution.kind).toBe('AMBIGUOUS');
    }
  });
});

describe('a fork whose upstream the Memory knows', () => {
  it('asks rather than filing the work under the upstream', async () => {
    const upstreamProject = project({ project_id: 'upstream', repo: 'github.com/acme/base' });
    const client = reader([upstreamProject]);

    const resolution = await resolveProject(
      client,
      signals({
        primaryRemote: 'github.com/me/widget',
        secondaryRemotes: ['github.com/acme/base'],
      }),
    );

    // The silent-false-merge case this rule exists for: everything would keep
    // working, with the Memory attached to a neighbouring repository's Project.
    expect(resolution).toMatchObject({
      kind: 'AMBIGUOUS',
      reason: 'ONLY_SECONDARY_REMOTE_MATCHED',
    });
    if (resolution.kind === 'AMBIGUOUS') {
      expect(resolution.candidates.map((candidate) => candidate.projectId)).toEqual(['upstream']);
    }
  });

  it('asks when no remote speaks for the checkout and a secondary matches', async () => {
    const client = reader([project({ project_id: 'known', repo: 'github.com/acme/base' })]);

    const resolution = await resolveProject(
      client,
      signals({
        primaryRemote: null,
        secondaryRemotes: ['github.com/me/widget', 'github.com/acme/base'],
      }),
    );

    expect(resolution).toMatchObject({
      kind: 'AMBIGUOUS',
      reason: 'ONLY_SECONDARY_REMOTE_MATCHED',
    });
  });

  it('prefers the primary match when both a primary and a secondary match', async () => {
    const mine = project({ project_id: 'mine', repo: 'github.com/me/widget' });
    const theirs = project({ project_id: 'theirs', repo: 'github.com/acme/base' });
    const client = reader([theirs, mine]);

    const resolution = await resolveProject(
      client,
      signals({
        primaryRemote: 'github.com/me/widget',
        secondaryRemotes: ['github.com/acme/base'],
      }),
    );

    // A secondary match is only interesting when the primary found nothing.
    expect(resolution).toEqual({ kind: 'RESOLVED', projectId: 'mine' });
  });
});

describe('a project with no usable remote', () => {
  it('asks when a Project shares its name', async () => {
    const client = reader([project({ project_id: 'named', repo: null, project_name: 'widget' })]);

    const resolution = await resolveProject(
      client,
      signals({ insideGit: false, primaryRemote: null, projectNameHint: 'widget' }),
    );

    // One name match is not identity. Two unrelated directories called `api` are
    // not one Project, and a single hit is the most tempting version of that
    // mistake.
    expect(resolution).toMatchObject({ kind: 'AMBIGUOUS', reason: 'NAME_ONLY_MATCH' });
  });

  it('matches a name exactly rather than loosely', async () => {
    const client = reader([project({ repo: null, project_name: 'widget-api' })]);

    const resolution = await resolveProject(
      client,
      signals({ insideGit: false, primaryRemote: null, projectNameHint: 'widget' }),
    );

    // A partial match would be a similarity judgement, and this module is the
    // deterministic half of the design.
    expect(resolution.kind).toBe('UNREGISTERED');
  });

  it('reports it as unregistered when no name matches', async () => {
    const client = reader([project({ project_name: 'other', repo: 'github.com/acme/other' })]);

    const resolution = await resolveProject(
      client,
      signals({ insideGit: false, primaryRemote: null, projectNameHint: 'widget' }),
    );

    expect(resolution).toEqual({
      kind: 'UNREGISTERED',
      suggestion: { projectName: 'widget', repo: null, monorepoSubpath: null },
    });
  });
});

describe('a repository the Memory has never seen', () => {
  it('reports it as unregistered with a suggestion', async () => {
    const client = reader([project({ project_id: 'other', repo: 'github.com/acme/other' })]);

    const resolution = await resolveProject(
      client,
      signals({ projectNameHint: 'widget', monorepoSubpath: 'apps/web' }),
    );

    expect(resolution).toEqual({
      kind: 'UNREGISTERED',
      suggestion: {
        projectName: 'widget',
        repo: 'github.com/acme/widget',
        monorepoSubpath: 'apps/web',
      },
    });
  });

  it('does not fall back to a name match when it has a repository', async () => {
    const sameName = project({ project_id: 'same-name', project_name: 'widget', repo: null });
    const client = reader([sameName]);

    const resolution = await resolveProject(client, signals());

    // With a repository in hand, a name collision is a wrong answer rather than
    // a hint: this checkout demonstrably is not the Project that recorded no
    // repository at all.
    expect(resolution.kind).toBe('UNREGISTERED');
  });

  it('creates nothing', async () => {
    const client = reader([]);

    const resolution = await resolveProject(client, signals());

    // The whole surface this module has is `listProjects`. A created Project is a
    // long-lived record and belongs to whoever consumes this outcome.
    expect(Object.keys(client).sort()).toEqual(['calls', 'listProjects']);
    expect(resolution.kind).toBe('UNREGISTERED');
  });
});

describe('what a candidate is allowed to say', () => {
  it('shows a canonical repository rather than what was stored', async () => {
    const withCredential = project({
      project_id: 'first',
      repo: `https://x-access-token:${FAKE_TOKEN}@github.com/acme/widget.git`,
    });
    const client = reader([withCredential, project({ project_id: 'second' })]);

    const resolution = await resolveProject(client, signals());

    expect(resolution.kind).toBe('AMBIGUOUS');
    if (resolution.kind === 'AMBIGUOUS') {
      // `repo` is free-form text a person may have typed, and a person may have
      // typed a URL with a token in it. Boolean, so a failure prints nothing.
      const shown = JSON.stringify(resolution.candidates);
      expect(`leaked:${shown.includes(FAKE_TOKEN)}`).toBe('leaked:false');
      expect(resolution.candidates[0]?.canonicalRepo).toBe('github.com/acme/widget');
    }
  });

  it('reports a repository it cannot read as absent rather than as text', async () => {
    const odd = project({ project_id: 'first', repo: '/srv/git/widget.git' });
    const client = reader([odd, project({ project_id: 'second', repo: null })]);

    const resolution = await resolveProject(
      client,
      signals({ insideGit: false, primaryRemote: null }),
    );

    expect(resolution).toMatchObject({ kind: 'AMBIGUOUS', reason: 'NAME_ONLY_MATCH' });
    if (resolution.kind === 'AMBIGUOUS') {
      expect(resolution.candidates.map((candidate) => candidate.canonicalRepo)).toEqual([
        null,
        null,
      ]);
    }
  });

  it('carries exactly three fields, and no path among them', async () => {
    const client = reader([project({ project_id: 'first' }), project({ project_id: 'second' })]);

    const resolution = await resolveProject(client, signals());

    if (resolution.kind === 'AMBIGUOUS') {
      expect(Object.keys(resolution.candidates[0] ?? {}).sort()).toEqual([
        'canonicalRepo',
        'projectId',
        'projectName',
      ]);
    }
  });
});

describe('what the resolution costs', () => {
  it('reads the Project list once', async () => {
    const client = reader([project()]);

    await resolveProject(client, signals());

    expect(client.calls).toBe(1);
  });

  it('lets a failure from the Memory travel', async () => {
    const failing: ProjectReader = { listProjects: () => Promise.reject(new Error('unreachable')) };

    // An unreachable Memory is not "no Project". It is a caller that does not
    // yet know, and answering with an outcome that looks like knowledge would be
    // the worst possible version of a fallback.
    await expect(resolveProject(failing, signals())).rejects.toThrow();
  });
});
