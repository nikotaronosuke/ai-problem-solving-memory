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
    // No declared boundary: the Project covers the whole repository, which is
    // what every Project meant before boundaries existed.
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

  it('carries exactly four fields, and no path among them', async () => {
    // The boundary joined them because choosing between two Projects on one
    // repository *is* choosing between boundaries — a list showing only names
    // would be asking somebody to decide without the thing they decide by. It
    // is repository-relative, which an absolute path is not.
    const client = reader([project({ project_id: 'first' }), project({ project_id: 'second' })]);

    const resolution = await resolveProject(client, signals());

    if (resolution.kind === 'AMBIGUOUS') {
      expect(Object.keys(resolution.candidates[0] ?? {}).sort()).toEqual([
        'canonicalRepo',
        'projectId',
        'projectName',
        'repoSubpath',
      ]);
    }
  });
});

describe('a repository whose parts the owner has split', () => {
  /** A Project on the shared repository with a declared boundary. */
  function part(projectId: string, repoSubpath: string | null): ProjectResource {
    return project({ project_id: projectId, repo_subpath: repoSubpath });
  }

  /** A session launched somewhere inside that repository. */
  function at(location: string | null): ProjectSignals {
    return signals({ monorepoSubpath: location });
  }

  it('resolves the whole repository when no boundary is declared', async () => {
    const client = reader([part('root', null)]);

    await expect(resolveProject(client, at(null))).resolves.toEqual({
      kind: 'RESOLVED',
      projectId: 'root',
    });
  });

  it('resolves a nested session to the Project covering the whole repository', async () => {
    // A null boundary is the repository root, and the root contains everything
    // in it.
    const client = reader([part('root', null)]);

    await expect(resolveProject(client, at('apps/web/client'))).resolves.toEqual({
      kind: 'RESOLVED',
      projectId: 'root',
    });
  });

  it('resolves a session inside a declared boundary', async () => {
    const client = reader([part('web', 'apps/web')]);

    await expect(resolveProject(client, at('apps/web'))).resolves.toEqual({
      kind: 'RESOLVED',
      projectId: 'web',
    });
  });

  it('resolves a session below a declared boundary', async () => {
    const client = reader([part('web', 'apps/web')]);

    await expect(resolveProject(client, at('apps/web/client'))).resolves.toEqual({
      kind: 'RESOLVED',
      projectId: 'web',
    });
  });

  it('does not treat a boundary as a raw string prefix', async () => {
    // `apps/web-old` is a different directory from `apps/web`, and only a
    // comparison that stops at a separator can tell. A prefix test would file
    // one Project's work under another's.
    const client = reader([part('web', 'apps/web')]);

    await expect(resolveProject(client, at('apps/web-old'))).resolves.toMatchObject({
      kind: 'AMBIGUOUS',
      reason: 'NO_MATCHING_REPO_BOUNDARY',
    });
  });

  it('prefers the most specific boundary that covers the session', async () => {
    const client = reader([part('root', null), part('web', 'apps/web')]);

    await expect(resolveProject(client, at('apps/web'))).resolves.toEqual({
      kind: 'RESOLVED',
      projectId: 'web',
    });
    await expect(resolveProject(client, at('apps/web/client'))).resolves.toEqual({
      kind: 'RESOLVED',
      projectId: 'web',
    });
  });

  it('falls back to the repository-wide Project where no narrower one covers', async () => {
    const client = reader([part('root', null), part('web', 'apps/web')]);

    await expect(resolveProject(client, at('apps/api'))).resolves.toEqual({
      kind: 'RESOLVED',
      projectId: 'root',
    });
    await expect(resolveProject(client, at(null))).resolves.toEqual({
      kind: 'RESOLVED',
      projectId: 'root',
    });
  });

  it('chooses the deepest of several nested boundaries', async () => {
    const client = reader([part('root', null), part('apps', 'apps'), part('web', 'apps/web')]);

    await expect(resolveProject(client, at('apps/web/client'))).resolves.toEqual({
      kind: 'RESOLVED',
      projectId: 'web',
    });
    await expect(resolveProject(client, at('apps/api'))).resolves.toEqual({
      kind: 'RESOLVED',
      projectId: 'apps',
    });
  });

  it('orders by path depth rather than by string length', async () => {
    // `a/b` is deeper than `averylongdirectoryname`, and shorter.
    const client = reader([part('long', 'averylongdirectoryname'), part('deep', 'a/b')]);

    await expect(resolveProject(client, at('a/b/c'))).resolves.toEqual({
      kind: 'RESOLVED',
      projectId: 'deep',
    });
  });

  it('refuses to choose between two Projects declaring the same boundary', async () => {
    const client = reader([part('first', 'apps/web'), part('second', 'apps/web')]);

    await expect(resolveProject(client, at('apps/web'))).resolves.toMatchObject({
      kind: 'AMBIGUOUS',
      reason: 'MULTIPLE_PROJECTS_FOR_REMOTE',
    });
  });

  it('offers only the tied Projects, not the ones a boundary shadowed', async () => {
    // The repository-wide Project lost to a decision the owner made, not to a
    // coin flip. Offering it beside the tied pair would reopen a settled
    // question alongside an unsettled one.
    const client = reader([
      part('root', null),
      part('first', 'apps/web'),
      part('second', 'apps/web'),
    ]);

    const resolution = await resolveProject(client, at('apps/web'));

    expect(resolution).toMatchObject({ kind: 'AMBIGUOUS' });
    if (resolution.kind === 'AMBIGUOUS') {
      expect(resolution.candidates.map((candidate) => candidate.projectId).sort()).toEqual([
        'first',
        'second',
      ]);
    }
  });

  it.each([
    ['at the repository root', null],
    ['beside the declared parts', 'apps/api'],
    ['somewhere else entirely', 'packages/shared'],
  ])('asks rather than answering when the session sits %s', async (_name, location) => {
    const client = reader([part('web', 'apps/web')]);

    // Deliberately not UNREGISTERED. Three different things could be true —
    // this location wants its own Project, it belongs to an existing one, or
    // the owner wants a repository-wide Project — and answering "unregistered"
    // would invite the next step to create a Project out of a directory
    // layout.
    await expect(resolveProject(client, at(location))).resolves.toMatchObject({
      kind: 'AMBIGUOUS',
      reason: 'NO_MATCHING_REPO_BOUNDARY',
    });
  });

  it('asks even when the repository has exactly one Project', async () => {
    // A single Project claiming `apps/web` says nothing about a session in
    // `apps/api`. One candidate is not evidence.
    const client = reader([part('web', 'apps/web')]);

    await expect(resolveProject(client, at('apps/api'))).resolves.toMatchObject({
      kind: 'AMBIGUOUS',
      reason: 'NO_MATCHING_REPO_BOUNDARY',
    });
  });

  it('offers every Project on the repository when none of them covers the session', async () => {
    const client = reader([part('web', 'apps/web'), part('api', 'apps/api')]);

    const resolution = await resolveProject(client, at('packages/shared'));

    if (resolution.kind === 'AMBIGUOUS') {
      expect(resolution.candidates.map((candidate) => candidate.projectId).sort()).toEqual([
        'api',
        'web',
      ]);
    }
  });

  it('shows the boundary on each candidate', async () => {
    const client = reader([part('web', 'apps/web'), part('api', 'apps/api')]);

    const resolution = await resolveProject(client, at('packages/shared'));

    if (resolution.kind === 'AMBIGUOUS') {
      expect(resolution.candidates.map((candidate) => candidate.repoSubpath).sort()).toEqual([
        'apps/api',
        'apps/web',
      ]);
    }
  });

  it('still reports an unrecorded repository as unregistered', async () => {
    // Nothing records this repository at all, which is a different situation
    // from a recorded repository whose parts do not cover the session.
    const client = reader([project({ repo: 'github.com/acme/other' })]);

    await expect(resolveProject(client, at('apps/web'))).resolves.toMatchObject({
      kind: 'UNREGISTERED',
    });
  });

  it('does not let a boundary promote a secondary remote into identity', async () => {
    // The fork-and-upstream case is unchanged: a secondary match is a question
    // however precisely its boundary lines up.
    const client = reader([
      project({
        project_id: 'upstream',
        repo: 'github.com/acme/upstream',
        repo_subpath: 'apps/web',
      }),
    ]);

    await expect(
      resolveProject(
        client,
        signals({
          primaryRemote: 'github.com/acme/fork',
          secondaryRemotes: ['github.com/acme/upstream'],
          monorepoSubpath: 'apps/web',
        }),
      ),
    ).resolves.toMatchObject({
      kind: 'AMBIGUOUS',
      reason: 'ONLY_SECONDARY_REMOTE_MATCHED',
    });
  });

  it('does not consult a boundary when a name is the only evidence', async () => {
    const client = reader([project({ project_id: 'named', repo: null, repo_subpath: 'apps/web' })]);

    await expect(
      resolveProject(client, signals({ primaryRemote: null, monorepoSubpath: 'apps/web' })),
    ).resolves.toMatchObject({ kind: 'AMBIGUOUS', reason: 'NAME_ONLY_MATCH' });
  });

  it('decides from boundaries alone, never from the order they arrived in', async () => {
    const forwards = reader([part('first', 'apps/web'), part('second', null)]);
    const backwards = reader([part('second', null), part('first', 'apps/web')]);

    await expect(resolveProject(forwards, at('apps/web'))).resolves.toEqual({
      kind: 'RESOLVED',
      projectId: 'first',
    });
    await expect(resolveProject(backwards, at('apps/web'))).resolves.toEqual({
      kind: 'RESOLVED',
      projectId: 'first',
    });
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
