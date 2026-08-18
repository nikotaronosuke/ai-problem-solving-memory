/**
 * What to do about a Project resolution, once somebody has read one.
 *
 * The resolver answers which Project a session is in, or that the answer is not
 * obvious. Neither of its uncertain answers is actionable on its own: an
 * unregistered repository needs a Project created, an ambiguous one needs a
 * choice made. This module is where those become operations — and it is
 * deliberately separate from the resolver, which stays a read.
 *
 * ## Everything is decided against a fresh resolution
 *
 * Both functions here re-resolve at the moment they are called, and neither
 * accepts an earlier answer as authority. That is not caution about staleness
 * in general; it is the one thing that closes a real race. Between a session
 * reading "nothing records this repository" and acting on it, another session
 * may have registered it — and creating a second Project for one repository is
 * a mistake nobody sees until the Memory is split across two records. Reading
 * again immediately before the write makes every *sequential* version of that
 * impossible.
 *
 * What it cannot do is make two simultaneous writers see each other. That race
 * is left open deliberately and recorded honestly: it is rare for one person,
 * it is visible afterwards as an ambiguity rather than silent, and the
 * alternatives — uniqueness on a repository, a name, a lock — each assert an
 * identity the domain does not have. One repository legitimately holds several
 * Projects; that is the whole point of a boundary.
 *
 * ## Nothing here asks anybody anything
 *
 * Where a decision belongs to a person, these functions return the material for
 * making it and stop. How that reaches somebody — a question, a prompt, a tool
 * result — belongs to the composition that has a conversation to put it in.
 *
 * ## What a detected subpath is worth
 *
 * Evidence, and not a decision. A session launched in `apps/web` says nothing
 * about whether the owner wants a Project for `apps/web` or for the repository
 * as a whole, and persisting the detected value because it happened to be there
 * would make every subdirectory a Project by accident. So a repository with a
 * subpath is never registered without a choice.
 */

import type { MemoryApiClient } from '@ai-problem-solving-memory/api-client';

import {
  resolveProject,
  type ProjectAmbiguityReason,
  type ProjectCandidate,
  type ProjectResolution,
  type ProjectSuggestion,
} from './project-resolution.js';
import type { ProjectSignals } from './project-signals.js';

/** Only the two calls registration needs. Nothing here reads a Problem. */
export type ProjectRegistrationClient = Pick<MemoryApiClient, 'listProjects' | 'createProject'>;

/** Only the read selection needs. */
export type ProjectSelectionClient = Pick<MemoryApiClient, 'listProjects'>;

/**
 * A decision only the owner can make, in the smallest form that carries it.
 *
 * Not a Project id: these are answers to "what should be registered", asked
 * before anything exists to point at. And not a path from this machine — the
 * one value that is a path is repository-relative, which is a location anybody
 * with the repository can see.
 */
export type ProjectRegistrationChoice =
  | {
      /** One Project for the whole repository, whatever directory this is. */
      readonly kind: 'REPOSITORY_ROOT';
    }
  | {
      /** This part of the repository is its own Project. */
      readonly kind: 'REPOSITORY_BOUNDARY';
      readonly repoSubpath: string;
    }
  | {
      /** Register what has no repository, knowing what that costs. */
      readonly kind: 'REGISTER_WITHOUT_REPOSITORY';
    };

/**
 * What registration concluded.
 *
 * Three of these are answers and three are questions. The questions carry
 * exactly the material somebody needs to answer them and nothing else — the
 * same candidate and suggestion shapes the resolver already builds, which are
 * where the rules about what may travel are written.
 */
export type ProjectRegistrationResult =
  | { readonly kind: 'CREATED'; readonly projectId: string }
  | { readonly kind: 'RESOLVED'; readonly projectId: string }
  | {
      readonly kind: 'AMBIGUOUS';
      readonly reason: ProjectAmbiguityReason;
      readonly candidates: readonly ProjectCandidate[];
    }
  | { readonly kind: 'BOUNDARY_REQUIRED'; readonly suggestion: ProjectSuggestion }
  | { readonly kind: 'EXPLICIT_REGISTRATION_REQUIRED'; readonly suggestion: ProjectSuggestion }
  | { readonly kind: 'NO_PROJECT_SIGNAL' };

/** What selecting a Project concluded. */
export type ProjectSelectionResult =
  | { readonly kind: 'SELECTED'; readonly projectId: string }
  | { readonly kind: 'SELECTION_STALE'; readonly resolution: ProjectResolution };

/**
 * Raised when a choice cannot describe anything this session is in.
 *
 * A programming or composition mistake rather than a condition to handle: a
 * caller reaching this has offered a boundary that does not cover where the
 * session is, or asked for a repository-less registration in a repository. It
 * names the argument and never the value — a rejected boundary is still a
 * directory in somebody's work.
 */
export class ProjectRegistrationArgumentError extends Error {
  readonly argument: string;

  constructor(argument: string) {
    super(`${argument} is not usable.`);
    this.name = 'ProjectRegistrationArgumentError';
    this.argument = argument;
  }
}

/**
 * Raised when a created Project cannot be found by the resolver afterwards.
 *
 * Not an ordinary outcome and not something to retry. A repository-anchored
 * Project that was created and then does not resolve means the server and this
 * resolver disagree about identity, and continuing under an id the resolver
 * would not select is worse than stopping. Carries nothing of the response.
 */
export class ProjectRegistrationInvariantError extends Error {
  constructor() {
    super('A created project did not resolve for the session that created it.');
    this.name = 'ProjectRegistrationInvariantError';
  }
}

/**
 * The boundaries an owner may legitimately choose for this session.
 *
 * Derived from the detected location by taking its ancestors, so the set is
 * finite, already canonical, and cannot contain anything the session is not
 * inside. `apps/web/client` yields `apps`, `apps/web`, `apps/web/client`.
 *
 * Deriving rather than parsing is the point. The rule for what a boundary may
 * look like lives on the server, and a second copy here would be a second thing
 * to keep in step; building the allowed set out of a value the detector already
 * produced means this module never has to know that rule at all.
 */
function choosableBoundaries(location: string): readonly string[] {
  const segments = location.split('/');
  return segments.map((_segment, index) => segments.slice(0, index + 1).join('/'));
}

/**
 * Registers the Project a session is in, when that is unambiguous and needed.
 *
 * Resolves first, every time, and creates nothing unless that fresh answer says
 * this repository is unrecorded. Where the owner has a decision to make, it is
 * returned rather than guessed.
 */
export async function registerProject(
  client: ProjectRegistrationClient,
  signals: ProjectSignals | null,
  choice?: ProjectRegistrationChoice,
): Promise<ProjectRegistrationResult> {
  const resolution = await resolveProject(client, signals);

  if (resolution.kind === 'RESOLVED') {
    return { kind: 'RESOLVED', projectId: resolution.projectId };
  }
  if (resolution.kind === 'AMBIGUOUS') {
    return {
      kind: 'AMBIGUOUS',
      reason: resolution.reason,
      candidates: resolution.candidates,
    };
  }
  if (resolution.kind === 'NO_PROJECT_SIGNAL') {
    return { kind: 'NO_PROJECT_SIGNAL' };
  }

  const suggestion = resolution.suggestion;

  if (suggestion.repo === null) {
    // A name is a label somebody chose, not an identity: two directories called
    // `api` are not one Project. So this never registers on its own, and the
    // caller has to mean it.
    if (choice?.kind !== 'REGISTER_WITHOUT_REPOSITORY') {
      if (choice !== undefined) {
        throw new ProjectRegistrationArgumentError('registration choice');
      }
      return { kind: 'EXPLICIT_REGISTRATION_REQUIRED', suggestion };
    }

    const created = await client.createProject({
      project_name: suggestion.projectName,
      repo: null,
      repo_subpath: null,
    });

    // No re-resolution here, and that is not an oversight. A Project with no
    // repository resolves by name, which is ambiguity by design — asking the
    // resolver to confirm this one would be asking it to do the thing it
    // correctly refuses.
    return { kind: 'CREATED', projectId: created.project_id };
  }

  if (choice?.kind === 'REGISTER_WITHOUT_REPOSITORY') {
    // The session has a repository. Registering as though it did not would
    // throw away the only durable identity available.
    throw new ProjectRegistrationArgumentError('registration choice');
  }

  const repoSubpath = boundaryFor(suggestion, choice);
  if (repoSubpath === UNDECIDED) {
    return { kind: 'BOUNDARY_REQUIRED', suggestion };
  }

  return createAnchoredProject(client, signals, suggestion, repoSubpath);
}

/** Separates a boundary nobody has chosen yet from a deliberate root choice. */
const UNDECIDED = Symbol('undecided');

/**
 * The boundary to store, or `UNDECIDED` when the owner has not said.
 *
 * At the repository root there is nothing to decide — one Project for the
 * repository is the only thing a root session could mean — so registration
 * proceeds without a bespoke question. Inside a subdirectory it is a real
 * question, and the detected location answers it only if somebody says so.
 */
function boundaryFor(
  suggestion: ProjectSuggestion,
  choice: ProjectRegistrationChoice | undefined,
): string | null | typeof UNDECIDED {
  const location = suggestion.monorepoSubpath;

  if (choice?.kind === 'REPOSITORY_BOUNDARY') {
    if (location === null || !choosableBoundaries(location).includes(choice.repoSubpath)) {
      // Either the session is at the root, where a subdirectory boundary would
      // not cover it, or the boundary names somewhere this session is not
      // inside — a sibling, a neighbour with a similar name, a path from
      // another machine. Registering any of those would create a Project that
      // does not cover the work about to happen in it.
      throw new ProjectRegistrationArgumentError('repository boundary');
    }
    return choice.repoSubpath;
  }

  if (choice?.kind === 'REPOSITORY_ROOT') {
    return null;
  }

  return location === null ? null : UNDECIDED;
}

/**
 * Creates a repository-anchored Project and confirms the resolver agrees.
 *
 * The confirmation is the point. A created Project that the resolver would not
 * select is an identity this session cannot use, and a duplicate created a
 * moment ago by somebody else shows up here as ambiguity rather than later as
 * a split Memory.
 */
async function createAnchoredProject(
  client: ProjectRegistrationClient,
  signals: ProjectSignals | null,
  suggestion: ProjectSuggestion,
  repoSubpath: string | null,
): Promise<ProjectRegistrationResult> {
  let createdId: string;
  try {
    const created = await client.createProject({
      project_name: suggestion.projectName,
      repo: suggestion.repo,
      repo_subpath: repoSubpath,
      // `platform` is left out entirely. Nothing here knows one, and inventing
      // a label would record a guess as a fact.
    });
    createdId = created.project_id;
  } catch (error) {
    return recoverFromUnknownCreate(client, signals, error);
  }

  const after = await resolveProject(client, signals);

  if (after.kind === 'RESOLVED') {
    // Either the Project just created, or one that arrived alongside it and
    // that the boundaries say is the better answer. Both are usable identities
    // and neither is a guess.
    return after.projectId === createdId
      ? { kind: 'CREATED', projectId: createdId }
      : { kind: 'RESOLVED', projectId: after.projectId };
  }

  if (after.kind === 'AMBIGUOUS') {
    return { kind: 'AMBIGUOUS', reason: after.reason, candidates: after.candidates };
  }

  // A repository-anchored Project was created and the resolver does not see it.
  // Nothing sensible follows from that, and a second create would make it
  // worse.
  throw new ProjectRegistrationInvariantError();
}

/**
 * Works out what an unanswered create actually did, where that is provable.
 *
 * An unreachable Memory means the request may or may not have committed. That
 * is genuinely unknown — but it is not *unknowable*: reading again can show a
 * Project now resolving, which is proof enough that one exists to work in,
 * whether this session created it or another did. Where the read shows nothing,
 * the original failure travels unchanged, still meaning exactly what it meant.
 *
 * Nothing is re-sent. A second create is as likely to make a duplicate as to
 * recover.
 */
async function recoverFromUnknownCreate(
  client: ProjectRegistrationClient,
  signals: ProjectSignals | null,
  error: unknown,
): Promise<ProjectRegistrationResult> {
  if (!isUnreachable(error)) {
    throw error;
  }

  const after = await resolveProject(client, signals);

  if (after.kind === 'RESOLVED') {
    return { kind: 'RESOLVED', projectId: after.projectId };
  }
  if (after.kind === 'AMBIGUOUS') {
    return { kind: 'AMBIGUOUS', reason: after.reason, candidates: after.candidates };
  }

  throw error;
}

/**
 * Whether a failure means nothing came back.
 *
 * Read by name rather than by importing the class, because this module has no
 * other reason to depend on the client's error types and the name is the
 * contract's own. A refusal, by contrast, is not unknown at all — the server
 * answered — and travels untouched.
 */
function isUnreachable(error: unknown): boolean {
  return error instanceof Error && error.name === 'MemoryApiUnreachableError';
}

/**
 * Accepts somebody's choice between ambiguous Projects, if it still holds.
 *
 * The id is checked against a resolution taken **now**, never against the list
 * it was offered from. Between the offer and the answer a Project may have been
 * created, merged or given a boundary that settles the question, and an id
 * accepted on the strength of an old list would attach this session's work to a
 * Project the current evidence no longer points at.
 *
 * A convergence is not a failure: an ambiguity that resolved itself to the same
 * Project somebody was going to choose is that choice, confirmed.
 */
export async function selectProject(
  client: ProjectSelectionClient,
  signals: ProjectSignals | null,
  selectedProjectId: string,
): Promise<ProjectSelectionResult> {
  const resolution = await resolveProject(client, signals);

  if (resolution.kind === 'RESOLVED') {
    return resolution.projectId === selectedProjectId
      ? { kind: 'SELECTED', projectId: selectedProjectId }
      : { kind: 'SELECTION_STALE', resolution };
  }

  if (
    resolution.kind === 'AMBIGUOUS' &&
    resolution.candidates.some((candidate) => candidate.projectId === selectedProjectId)
  ) {
    return { kind: 'SELECTED', projectId: selectedProjectId };
  }

  return { kind: 'SELECTION_STALE', resolution };
}
