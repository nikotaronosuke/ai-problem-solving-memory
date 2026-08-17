/**
 * Which existing Project a session is working in — or that the answer is not
 * obvious.
 *
 * ## Four answers, and the useful one is not always the first
 *
 * `RESOLVED` when one Project is identified beyond doubt. `UNREGISTERED` when
 * nothing matches and the signals say this is somewhere new. `AMBIGUOUS` when
 * more than one answer is defensible. `NO_PROJECT_SIGNAL` when there was no
 * project root to work from.
 *
 * `AMBIGUOUS` is the one that earns this module its shape. The specification
 * asks for a Project to be worked out silently and for a question to be possible
 * *only* when things are genuinely ambiguous — which means the interesting
 * design work is deciding what counts as genuine, and refusing to guess the rest
 * of the time.
 *
 * ## Why a secondary remote never resolves on its own
 *
 * A checkout of a fork has the fork and the upstream as remotes. If a Memory
 * Project records the upstream, matching on any remote would silently file this
 * session's Problems under the upstream's Project — and the failure is invisible,
 * because everything continues to work and the Memory is simply attached to the
 * wrong long-term unit of work.
 *
 * So identity comes from the primary remote alone. A match on a secondary remote
 * is real evidence and it produces `AMBIGUOUS`: somebody who can see both
 * repositories decides, once, instead of this code deciding wrongly every time.
 *
 * ## Why nothing picks the first or the newest candidate
 *
 * Both are stable, both look reasonable, and both are a coin flip wearing a
 * rule's clothes. Two Projects recording the same repository means the owner
 * split that repository deliberately — a monorepo whose apps are separate units
 * of work — or that a duplicate exists and wants merging. Which of those is true
 * is not visible from here, and the cost of getting it wrong is Memory filed
 * under the wrong Project for as long as nobody notices.
 *
 * ## What a candidate may say
 *
 * A candidate is material for somebody to choose from, so it is built rather
 * than passed through. The stored `repo` is **canonicalised before it is shown**:
 * it is free-form text a person may have typed, and a person may have typed a
 * URL with a token in it. The absolute path of the session is not in a candidate
 * either — it is not in `ProjectSignals` to begin with.
 *
 * ## What this module does not do
 *
 * It does not ask anybody anything, and it does not create a Project. Both are
 * decisions with their own consequences — a question interrupts somebody, and a
 * created Project is a long-lived record — and both belong to whatever consumes
 * these outcomes. There is no `createProject` on the client for the same reason:
 * nothing here calls one.
 */

import type { MemoryApiClient, ProjectResource } from '@ai-problem-solving-memory/api-client';

import { canonicaliseGitRemote } from './project-remote.js';
import type { ProjectSignals } from './project-signals.js';

/** Why more than one answer was defensible. A closed set, safe to log. */
export const PROJECT_AMBIGUITY_REASONS = [
  /**
   * The primary remote matched more than one Project.
   *
   * The owner has split this repository into several Projects, or a duplicate
   * exists. Both are real situations and only the owner can say which.
   */
  'MULTIPLE_PROJECTS_FOR_REMOTE',
  /**
   * Nothing matched the primary remote, and a secondary one matched.
   *
   * The fork-and-upstream case. Resolving it would file this work under a
   * neighbouring repository's Project.
   */
  'ONLY_SECONDARY_REMOTE_MATCHED',
  /**
   * There was no usable remote, and the project's name matched.
   *
   * A name is a label somebody chose, not an identity. Two unrelated
   * directories called `api` are not one Project.
   */
  'NAME_ONLY_MATCH',
] as const;

export type ProjectAmbiguityReason = (typeof PROJECT_AMBIGUITY_REASONS)[number];

/**
 * One Project somebody could choose, with nothing in it that should not travel.
 *
 * `canonicalRepo` rather than the stored string: what is stored is free-form and
 * may be anything a person typed, including a URL with a credential in it.
 */
export interface ProjectCandidate {
  readonly projectId: string;
  readonly projectName: string;
  readonly canonicalRepo: string | null;
}

/** What to call a Project that does not exist yet, and what to record on it. */
export interface ProjectSuggestion {
  /** A display name. Never identity, and never a path. */
  readonly projectName: string;
  /**
   * The canonical primary remote, or null when there is none.
   *
   * Canonical by construction, so this cannot carry a credential — which matters
   * because it is the value a later task would store on a real Project.
   */
  readonly repo: string | null;
  /** Repository-relative, for a person deciding how to split a monorepo. */
  readonly monorepoSubpath: string | null;
}

/**
 * What a Project resolution concluded.
 *
 * `RESOLVED` carries the server's own record unchanged — the caller needs its
 * `project_id`, and editing what the server said would make this a second
 * description of a Project. Every other outcome carries material built here.
 */
export type ProjectResolution =
  | { readonly kind: 'RESOLVED'; readonly project: ProjectResource }
  | { readonly kind: 'UNREGISTERED'; readonly suggestion: ProjectSuggestion }
  | {
      readonly kind: 'AMBIGUOUS';
      readonly reason: ProjectAmbiguityReason;
      readonly candidates: readonly ProjectCandidate[];
    }
  | { readonly kind: 'NO_PROJECT_SIGNAL' };

/** Only the part of the client this needs. Nothing here creates or updates. */
export type ProjectReader = Pick<MemoryApiClient, 'listProjects'>;

function toCandidate(project: ProjectResource): ProjectCandidate {
  return {
    projectId: project.project_id,
    projectName: project.project_name,
    canonicalRepo: project.repo === null ? null : (canonicaliseGitRemote(project.repo) ?? null),
  };
}

/** Projects whose stored repo canonicalises to one of these identities. */
function matchingRemote(
  projects: readonly ProjectResource[],
  remotes: readonly string[],
): ProjectResource[] {
  if (remotes.length === 0) {
    return [];
  }
  const wanted = new Set(remotes);
  return projects.filter((project) => {
    if (project.repo === null) {
      return false;
    }
    const canonical = canonicaliseGitRemote(project.repo);
    return canonical !== undefined && wanted.has(canonical);
  });
}

function suggestionFor(signals: ProjectSignals): ProjectSuggestion {
  return {
    projectName: signals.projectNameHint,
    repo: signals.primaryRemote,
    monorepoSubpath: signals.monorepoSubpath,
  };
}

/**
 * Works out which existing Project a session belongs to.
 *
 * Reads the owner's Projects once and decides deterministically from the signals
 * it was given. Nothing about the answer depends on time, on ordering beyond
 * what the server sent, or on anything this process remembers — the same signals
 * and the same Projects produce the same outcome.
 *
 * Failures from the client are not caught. An unreachable Memory is not "no
 * Project"; it is a caller that does not yet know, and deciding what to do about
 * that is the fallback path's job rather than something to paper over with an
 * outcome that looks like an answer.
 */
export async function resolveProject(
  client: ProjectReader,
  signals: ProjectSignals | null,
): Promise<ProjectResolution> {
  if (signals === null) {
    return { kind: 'NO_PROJECT_SIGNAL' };
  }

  const projects = await client.listProjects();

  if (signals.primaryRemote !== null) {
    const onPrimary = matchingRemote(projects, [signals.primaryRemote]);

    if (onPrimary.length === 1) {
      const project = onPrimary[0];
      if (project !== undefined) {
        return { kind: 'RESOLVED', project };
      }
    }

    if (onPrimary.length > 1) {
      return {
        kind: 'AMBIGUOUS',
        reason: 'MULTIPLE_PROJECTS_FOR_REMOTE',
        candidates: onPrimary.map(toCandidate),
      };
    }

    // Nothing recorded this repository. A neighbouring one may be recorded, and
    // that is a question rather than an answer.
    const onSecondary = matchingRemote(projects, signals.secondaryRemotes);
    if (onSecondary.length > 0) {
      return {
        kind: 'AMBIGUOUS',
        reason: 'ONLY_SECONDARY_REMOTE_MATCHED',
        candidates: onSecondary.map(toCandidate),
      };
    }

    // A strong signal that said nothing matched. The name is deliberately not
    // consulted here: with a repository in hand, a name collision is a wrong
    // answer rather than a hint.
    return { kind: 'UNREGISTERED', suggestion: suggestionFor(signals) };
  }

  // No remote speaks for this checkout. Secondary remotes are still evidence.
  const onSecondary = matchingRemote(projects, signals.secondaryRemotes);
  if (onSecondary.length > 0) {
    return {
      kind: 'AMBIGUOUS',
      reason: 'ONLY_SECONDARY_REMOTE_MATCHED',
      candidates: onSecondary.map(toCandidate),
    };
  }

  // Exact, because a partial name match would be a similarity judgement, and
  // this module is the deterministic half of the design. Still only ever
  // ambiguity: one name match is not identity, however tempting a single hit is.
  const byName = projects.filter((project) => project.project_name === signals.projectNameHint);
  if (byName.length > 0) {
    return {
      kind: 'AMBIGUOUS',
      reason: 'NAME_ONLY_MATCH',
      candidates: byName.map(toCandidate),
    };
  }

  return { kind: 'UNREGISTERED', suggestion: suggestionFor(signals) };
}
