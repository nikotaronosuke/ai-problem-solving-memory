/**
 * Asking the Memory what it already knows about the Problem in front of us.
 *
 * Every rule this needs exists somewhere else: which Project a session is in,
 * which Problem it is on, and what a search request looks like. What this
 * module owns is the order between them, one refusal apiece, and the decision
 * *not* to ask the same question twice.
 *
 * ## It reads a Project; it never registers one
 *
 * `current_problem` may register a Project deterministically, because being
 * asked "which Problem am I on" in an unrecorded repository is a reason to
 * settle the question. Recall is not that. Somebody looking things up has not
 * asked for a Project to come into existence, and creating one as a side effect
 * of a lookup would put a durable record in the Memory that nobody chose. So a
 * Project that does not already resolve stops the call.
 *
 * ## It searches only from a Problem that is authoritative
 *
 * Not from a candidate — one candidate is still a candidate, and picking it
 * would attach this search, and the usage recorded against it, to a Problem
 * nobody selected. Not from a paused one either: a paused Problem is not the
 * work in front of somebody, and searching about it automatically would be
 * answering a question that was put down.
 *
 * ## What the model says, and what the runtime says
 *
 * The two texts and the seven feature lists are the *model's* current
 * understanding, in its own words. Nothing here composes them out of stored
 * fields: a query assembled by joining columns describes what was written down
 * once, not what somebody has just realised. What the runtime owns instead is
 * everything the model must not be able to choose — which Problem this attaches
 * to, which assistant is asking, and which feature vocabulary is in use.
 *
 * ## Asking twice is worse than not asking
 *
 * A trigger that fires on every failing test would search the same Problem
 * against the same understanding over and over: provider calls paid for twice,
 * usage recorded twice, and the same answer arriving each time. So the last
 * settled question is remembered as a digest, and an identical one is declined
 * without a request. The store is advisory: if it cannot be read, the search
 * happens, because a de-duplication optimisation must never be the reason a
 * Memory goes unread.
 *
 * ## What comes back
 *
 * How the search went, and nothing about what it found. A count and the two
 * stage statuses are enough to tell "ran and found nothing" from "ran and found
 * something" from "a provider was degraded" — which is what a caller needs in
 * order to decide what to do next. The candidates themselves belong to whoever
 * presents them, and that is a later task with its own decisions.
 */

import { createHash } from 'node:crypto';

import type {
  MemoryApiClient,
  MemorySearchRequest,
  MemorySearchSemanticStatus,
  MemorySearchStructuralStatus,
  ProblemResource,
} from '@ai-problem-solving-memory/api-client';
import {
  MemoryApiError,
  MEMORY_SEARCH_STRUCTURAL_FEATURE_SCHEMA_VERSION,
} from '@ai-problem-solving-memory/api-client';

import { detectProjectSignals, type DetectProjectSignalsInput } from './project-signals.js';
import { resolveProject } from './project-resolution.js';
import { isWorkingProblemStatus } from './problem-resolution.js';
import { resolveProblemForSession, type ProblemBindingWriter } from './problem-lifecycle.js';
import type { CurrentProblemReader } from './problem-resolution.js';
import { CLAUDE_CODE_SOURCE_AI } from './source-ai.js';

/**
 * What the model contributes: its current understanding, in its own words.
 *
 * Deliberately not `MemorySearchStructuralFeatures`. That type carries a
 * `schema_version`, and the vocabulary in use is not something a caller of this
 * composition — least of all a model — gets to name.
 */
export interface RecallQueryFeatures {
  readonly problemDomain: string | null;
  readonly symptomPatterns: readonly string[];
  readonly suspectedBoundaries: readonly string[];
  readonly occurrenceConditions: readonly string[];
  readonly successfulDirections: readonly string[];
  readonly deadEndDirections: readonly string[];
  readonly environmentFacts: readonly string[];
}

/** The whole question, as the model put it. */
export interface RecallQuery {
  readonly lexicalText: string;
  readonly semanticText: string;
  readonly features: RecallQueryFeatures;
}

/**
 * What the composition needs to remember what it has already asked.
 *
 * An interface rather than a filesystem, because where this lives is the host
 * runtime's business and this module has no idea there is a plugin. Local
 * unavailability comes back as an outcome rather than as an exception: it is an
 * ordinary state of a cache, not an error in a search.
 */
export interface RecallFingerprintStore {
  readFingerprint(problemId: string): Promise<RecallFingerprintRead>;
  writeFingerprint(problemId: string, fingerprint: string): Promise<RecallFingerprintWrite>;
}

export type RecallFingerprintRead =
  | { readonly kind: 'FOUND'; readonly fingerprint: string }
  | { readonly kind: 'MISSING' }
  | { readonly kind: 'UNAVAILABLE' };

export type RecallFingerprintWrite =
  { readonly kind: 'PERSISTED' } | { readonly kind: 'NOT_PERSISTED' };

/** Everything one recall needs, and nothing about how it was asked for. */
export interface RecallSimilarExperienceInput {
  readonly client: MemoryApiClient;
  readonly bindingStore: ProblemBindingWriter;
  readonly fingerprintStore: RecallFingerprintStore;
  readonly sessionId: string;
  readonly projectDir: string;
  readonly query: RecallQuery;
  /** How git is invoked while detecting. Production omits it. */
  readonly runGit?: DetectProjectSignalsInput['runGit'];
  /** How the request is digested. Production omits it. */
  readonly digest?: (canonical: string) => string;
}

/**
 * What a recall concluded.
 *
 * `RECALLED` says how the search went and not what it found. The rest are the
 * ordinary reasons a search did not happen or could not be attached to
 * anything — each one a fact about the situation rather than a failure.
 */
export type RecallSimilarExperienceOutcome =
  | {
      readonly kind: 'RECALLED';
      readonly candidateCount: number;
      readonly semanticStatus: MemorySearchSemanticStatus;
      readonly structuralStatus: MemorySearchStructuralStatus;
    }
  | { readonly kind: 'ALREADY_RECALLED' }
  | { readonly kind: 'NO_CURRENT_PROBLEM' }
  | { readonly kind: 'MEMORY_READ_DISABLED' }
  | { readonly kind: 'CURRENT_SOURCE_CHANGED' }
  | { readonly kind: 'CURRENT_PROBLEM_NOT_AVAILABLE' };

/** Only the reads this needs from a client, so a test supplies exactly them. */
type RecallReader = CurrentProblemReader & Pick<MemoryApiClient, 'listProjects' | 'search'>;

/**
 * The digest of one exact question about one exact Problem.
 *
 * Domain-separated, because a hash with no label is a hash that will one day be
 * compared against one of a different kind. What goes in is the Problem, the
 * version it was at when this was asked, and the request that would be sent —
 * so a changed understanding, a changed vocabulary or a Problem that moved
 * underneath all produce a different question. What stays out is everything
 * about *this* asking: no session, no path, no clock, nothing random. A session
 * restarting is not a new question.
 */
export function recallFingerprintOf(
  problemId: string,
  problemVersion: number,
  request: MemorySearchRequest,
  digest: (canonical: string) => string,
): string {
  const features = request.current_features;
  const canonical = JSON.stringify([
    'recall-fingerprint/1',
    problemId,
    problemVersion,
    request.source_ai,
    request.lexical_text,
    request.semantic_text,
    [
      features.schema_version,
      features.problem_domain,
      features.symptom_patterns,
      features.suspected_boundaries,
      features.occurrence_conditions,
      features.successful_directions,
      features.dead_end_directions,
      features.environment_facts,
    ],
  ]);

  return digest(canonical);
}

/** The request as it will be sent, with the runtime's two fields filled in. */
function requestOf(query: RecallQuery): MemorySearchRequest {
  return {
    // Neither of these is the model's to choose. One says which assistant is
    // asking, and the other which vocabulary the features are written in.
    source_ai: CLAUDE_CODE_SOURCE_AI,
    lexical_text: query.lexicalText,
    semantic_text: query.semanticText,
    current_features: {
      schema_version: MEMORY_SEARCH_STRUCTURAL_FEATURE_SCHEMA_VERSION,
      problem_domain: query.features.problemDomain,
      symptom_patterns: query.features.symptomPatterns,
      suspected_boundaries: query.features.suspectedBoundaries,
      occurrence_conditions: query.features.occurrenceConditions,
      successful_directions: query.features.successfulDirections,
      dead_end_directions: query.features.deadEndDirections,
      environment_facts: query.features.environmentFacts,
    },
  };
}

/**
 * Whether this Problem is one a recall may be attached to, read fresh.
 *
 * The binding said which Problem; this says whether that is still true, and
 * still the work in front of somebody. Reading again is not caution for its own
 * sake — the version is part of the question's identity, so a stale one would
 * let a Problem change without the next recall noticing.
 */
async function freshWorkingProblem(
  client: RecallReader,
  projectId: string,
  problemId: string,
): Promise<ProblemResource | undefined> {
  const problem = await client.getProblem(problemId);

  // Belonging to another Project is not a stale read, it is a contradiction:
  // the binding named a Problem in one place and the server put it in another.
  return problem.project_id === projectId && isWorkingProblemStatus(problem.status)
    ? problem
    : undefined;
}

/**
 * Looks up what has been learned before about the Problem this session is on.
 *
 * One search at most, and only when there is something authoritative to attach
 * it to. Nothing here retries: a search that did not answer is a fact the
 * caller decides about, and asking again would spend a second provider call and
 * record a second usage that nobody asked for.
 */
export async function recallSimilarExperience(
  input: RecallSimilarExperienceInput,
): Promise<RecallSimilarExperienceOutcome> {
  const client = input.client as RecallReader;
  const digest = input.digest ?? defaultDigest;

  const signals = await detectProjectSignals({
    projectDir: input.projectDir,
    ...(input.runGit === undefined ? {} : { runGit: input.runGit }),
  });

  // Read only. A Project that is not already recorded is a question for the
  // operation that asks questions, not something a lookup settles by writing.
  const project = await resolveProject(client, signals);
  if (project.kind !== 'RESOLVED') {
    return { kind: 'NO_CURRENT_PROBLEM' };
  }

  const resolution = await resolveProblemForSession(
    client,
    input.bindingStore,
    input.sessionId,
    project.projectId,
  );
  // `CANDIDATES` included, and deliberately: choosing one of them here would be
  // this module deciding which Problem somebody is working on.
  if (resolution.kind !== 'RESOLVED') {
    return { kind: 'NO_CURRENT_PROBLEM' };
  }

  let problem: ProblemResource | undefined;
  try {
    problem = await freshWorkingProblem(client, project.projectId, resolution.problemId);
  } catch (error) {
    // Only a Problem the server says is gone becomes this. An unreachable
    // Memory or an unreadable answer is not a statement about the Problem, and
    // reporting it as one would tell a session its work no longer exists.
    if (isProblemNotFound(error)) {
      return { kind: 'CURRENT_PROBLEM_NOT_AVAILABLE' };
    }
    throw error;
  }
  if (problem === undefined) {
    return { kind: 'NO_CURRENT_PROBLEM' };
  }

  const request = requestOf(input.query);
  const fingerprint = recallFingerprintOf(problem.problem_id, problem.version, request, digest);

  const remembered = await input.fingerprintStore.readFingerprint(problem.problem_id);
  if (remembered.kind === 'FOUND' && remembered.fingerprint === fingerprint) {
    return { kind: 'ALREADY_RECALLED' };
  }

  const outcome = await client.search(problem.problem_id, request);

  switch (outcome.kind) {
    case 'SEARCHED':
      // Settled: this question was asked and answered. Whether the answer had
      // anything in it makes no difference to whether it was asked.
      await input.fingerprintStore.writeFingerprint(problem.problem_id, fingerprint);
      return {
        kind: 'RECALLED',
        candidateCount: outcome.candidates.length,
        semanticStatus: outcome.semantic_status,
        structuralStatus: outcome.structural_status,
      };
    case 'MEMORY_READ_DISABLED':
      // Also settled. Asking again while nothing has changed would be asking
      // the server to repeat a refusal it has already given; when the control
      // is turned back on the Problem's version moves, and the question is new.
      await input.fingerprintStore.writeFingerprint(problem.problem_id, fingerprint);
      return { kind: 'MEMORY_READ_DISABLED' };
    case 'CURRENT_SOURCE_CHANGED':
      // Not settled: the Problem moved while the search ran, so this question
      // was never answered as asked.
      return { kind: 'CURRENT_SOURCE_CHANGED' };
    case 'CURRENT_PROBLEM_NOT_AVAILABLE':
      return { kind: 'CURRENT_PROBLEM_NOT_AVAILABLE' };
  }
}

/** The default digest. SHA-256 from Node, because nothing else is needed. */
function defaultDigest(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** Whether an error is the server saying this Problem is not there. */
function isProblemNotFound(error: unknown): boolean {
  return error instanceof MemoryApiError && error.status === 404 && error.code === 'NOT_FOUND';
}
