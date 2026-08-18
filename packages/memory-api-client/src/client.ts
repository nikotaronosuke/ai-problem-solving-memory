/**
 * The client for the Memory JSON API.
 *
 * ## What this is for
 *
 * The Memory Server's JSON API is the contract every assistant reaches the
 * Memory through. This package is the one place that knows how to speak it —
 * how a path is built, where the credential goes, what a refusal looks like —
 * so that an adapter for a particular assistant contains only what is
 * particular to that assistant.
 *
 * Nothing here knows which assistant is calling. No host, no protocol, no
 * model, no session: those belong to an adapter, and a guard in the server's
 * test suite fails if one of them appears in this package.
 *
 * ## No generic escape hatch
 *
 * There is no public `request(path, init)`. It would be one line to add and it
 * would end this package's usefulness: every caller that reached for it would
 * be building paths, choosing methods, reading status codes and deciding what
 * `snake_case` means — which is exactly the knowledge this package exists to
 * hold in one place. Adding a method costs a few lines and keeps that true.
 *
 * ## One call, one request
 *
 * No retries, of any kind, for any reason. Not on a network failure, not on a
 * 5xx, not on a timeout. A hidden retry turns one recorded Event into two, and
 * the caller that could have decided whether resending was safe never found
 * out that anything was resent. Retrying is a policy about the caller's work
 * rather than about HTTP, and it belongs to the task that owns the retry queue.
 */

import { DEFAULT_MEMORY_API_BASE_URL, normalizeBaseUrl, requireCredential } from './config.js';
import {
  isMemoryApiErrorCode,
  MemoryApiError,
  MemoryApiProtocolError,
  MemoryApiUnreachableError,
} from './errors.js';
import {
  isCreateEnvironmentRequest,
  isEnvironmentResource,
  type CreateEnvironmentRequest,
  type EnvironmentResource,
} from './environment.js';
import {
  isCreateProblemRequest,
  isProblemListBody,
  isProblemResource,
  isTransitionProblemStatusRequest,
  type CreateProblemRequest,
  type ProblemResource,
  type TransitionProblemStatusRequest,
} from './problem.js';
import {
  isCreateProjectRequest,
  isProjectListBody,
  isProjectResource,
  type CreateProjectRequest,
  type ProjectResource,
} from './project.js';
import {
  isMemorySearchRequest,
  isMemorySearchResponse,
  type MemorySearchOutcome,
  type MemorySearchRequest,
} from './search.js';

/**
 * How long a single request may take before it is abandoned.
 *
 * A number that exists so no call can hang forever, and not a promise about
 * how fast the Memory is. It is a constant here rather than a recorded
 * invariant because the right value depends on what the server ends up doing
 * on the slowest path — and when that changes, this should change with it
 * rather than be defended.
 */
export const MEMORY_API_REQUEST_TIMEOUT_MS = 10_000;

/**
 * How long a search may take before it is abandoned.
 *
 * Longer than an ordinary read, and it has to be. A cold search embeds the
 * query, searches, asks a model to compare structure, then reads five kinds of
 * material for every candidate — two provider calls in series, each with its own
 * ceiling on the server side. A client that gave up after the ordinary timeout
 * would abandon searches the server was about to answer, every time, and the
 * caller would learn nothing except that the Memory is unreachable, which would
 * not be true.
 *
 * Still finite, and deliberately: an unbounded request is a hung caller, and
 * there is no version of "wait forever" that a person watching an assistant
 * work would prefer.
 *
 * The number is an implementation constant, like its ordinary counterpart. What
 * is worth recording is that a search has its own longer default; the value
 * belongs to whatever the slowest configured stack actually does, and should
 * move when that moves rather than be defended.
 */
export const MEMORY_API_SEARCH_TIMEOUT_MS = 300_000;

/**
 * The shape of `fetch`, so a test can supply one.
 *
 * Taken from the platform's own type rather than restated, so an injected
 * double cannot drift from what production actually calls.
 */
export type FetchLike = typeof globalThis.fetch;

export interface MemoryApiClientOptions {
  /** Where the Memory Server is. Defaults to loopback. */
  readonly baseUrl?: string;

  /** The Memory credential. Required, and never optional. */
  readonly credential: string;

  /** Substitute transport. Production uses the platform's `fetch`. */
  readonly fetch?: FetchLike;

  /**
   * Per-request ceiling, for every operation.
   *
   * Left unset, each operation uses its own default:
   * `MEMORY_API_REQUEST_TIMEOUT_MS` for an ordinary read and
   * `MEMORY_API_SEARCH_TIMEOUT_MS` for a search. Set, it applies to all of them
   * — one knob rather than one per method, because a caller that wants a ceiling
   * wants a ceiling, and a second option would only create a precedence
   * question for somebody to get wrong.
   */
  readonly timeoutMs?: number;
}

export interface MemoryApiClient {
  /**
   * Reads one Problem.
   *
   * Returns exactly what the API returned. A Problem that does not exist, or
   * belongs to somebody else, is a `MemoryApiError` with `NOT_FOUND` — the
   * server answers both the same way on purpose, and this client does not try
   * to tell them apart.
   */
  getProblem(problemId: string): Promise<ProblemResource>;

  /**
   * Lists every Project this owner has.
   *
   * Returns them in the order the server sent, which is deterministic and is
   * the server's — nothing here sorts, filters or de-duplicates. The list
   * envelope's single field is unwrapped and nothing else about the answer
   * changes; every element is validated, and one malformed Project makes the
   * whole answer a protocol failure rather than being skipped, because a list
   * quietly missing a Project reads as an owner who does not have it.
   *
   * An owner with no Projects gets an empty array, which is an answer rather
   * than a fault.
   */
  listProjects(): Promise<readonly ProjectResource[]>;

  /**
   * Lists every Problem recorded under one Project, in every state.
   *
   * The same rules as `listProjects`: the server's order, unchanged, with
   * nothing sorted, filtered, de-duplicated or renumbered here. Which of these
   * Problems is worth anything to a caller — whether a state can still be
   * worked on, whether one of them is the thing being discussed right now — is
   * the caller's question, and answering part of it here would make this method
   * a policy with a list attached.
   *
   * A Project with no Problems gets an empty array. A Project that does not
   * exist, or is not this owner's, is a `MemoryApiError` with `NOT_FOUND`, and
   * it stays one: turning it into an empty list would say "no Problems here"
   * about a Project the caller cannot see, which is the same sentence with a
   * different meaning.
   *
   * Every element is validated and one malformed Problem fails the whole
   * answer. So does a Problem belonging to a different Project than the one
   * asked about — the request named the Project in its path, and a body that
   * disagrees with its own route is not an answer this contract describes.
   */
  listProblems(projectId: string): Promise<readonly ProblemResource[]>;

  /**
   * Creates a Project.
   *
   * A Project is a long-lived record and there is no delete for one, so this
   * is the write in this client that is hardest to take back. It happens once
   * per call and is not retried: if no answer comes, the caller does not know
   * whether it committed, and only the caller knows how to find out.
   *
   * The answer is checked for being a Project, and for carrying back the
   * repository boundary that was asked for — but **not** for echoing the name,
   * repository or platform verbatim. The server normalises those: it trims a
   * name, and turns blank text into null. A client demanding raw equality
   * would call a correct server malformed.
   */
  createProject(request: CreateProjectRequest): Promise<ProjectResource>;

  /**
   * Records the conditions a Problem was found under.
   *
   * An Environment is a point in time: there is no update and no delete for
   * one, so what is sent is what is stored. The snapshot's keys are the
   * caller's — which conditions mattered is a question about the problem —
   * but every value in it is checked before the request, because a snapshot
   * that serialised into something the caller did not write would be a
   * permanent record of the wrong conditions.
   */
  createEnvironment(
    projectId: string,
    request: CreateEnvironmentRequest,
  ): Promise<EnvironmentResource>;

  /**
   * Starts a Problem under a Project, against an Environment already recorded.
   *
   * Three things are required and three are optional; everything else about a
   * new Problem is the server's. It begins `INVESTIGATING` at version 1 with no
   * fix kind, and no caller can declare otherwise — which is why none of those
   * fields exists in the request.
   *
   * Whether a Problem *should* be started is not a question this method asks.
   * It is a mutation, it happens once per call, and it is not retried: if no
   * answer comes back, the caller does not know whether it committed, and only
   * the caller knows how to find out.
   */
  createProblem(projectId: string, request: CreateProblemRequest): Promise<ProblemResource>;

  /**
   * Moves a Problem to another status.
   *
   * The only way a status changes. The request says where the Problem should
   * end up and which version it was read at; the server compares that against
   * the record, and a `409` with `VERSION_CONFLICT` means somebody else wrote
   * to the Problem in between. That is an answer, not a failure of this call —
   * it is raised as an ordinary refusal and is emphatically not retried, because
   * retrying it would mean re-deciding, against a record that has changed, a
   * question the caller answered against the one it read.
   *
   * Whether a particular move is *legal* is the server's to say. This client
   * will ask for any canonical status, because the rule depends on the record's
   * current state and lives in one place.
   *
   * The answer is checked for being the Problem that was asked about and for
   * being in the status that was asked for. Nothing else is compared: the
   * server owns every other field of a transitioned Problem, including how far
   * the version moved.
   */
  transitionProblemStatus(
    problemId: string,
    request: TransitionProblemStatusRequest,
  ): Promise<ProblemResource>;

  /**
   * Finds past memory worth reading for the Problem being worked on.
   *
   * Searches every Project this owner has and returns candidates with the
   * material to judge them — what each was true of, where it did and did not
   * lead, and what contradicts it. Never a recommendation: what the material
   * means for the situation in front of the caller is the caller's to decide,
   * and nothing here reads it.
   *
   * Four outcomes, all returned rather than raised. Three are the server's:
   * candidates (possibly none), reading turned off for this Problem, and a
   * Problem that changed while the search ran. The fourth is this client's
   * naming of a `404` — for a search the Problem is the *context*, and losing
   * the context is something a caller handles rather than an exception to its
   * plan.
   *
   * Everything else raises, unchanged in meaning: a refusal is a
   * `MemoryApiError` — including a `500`, which may mean the server's provider
   * integration is broken and never means the request was wrong — an
   * unanswerable request is a `MemoryApiUnreachableError`, and an answer this
   * contract cannot read is a `MemoryApiProtocolError`.
   *
   * Nothing is retried, nothing is judged, nothing is transformed. The body that
   * passes validation is the body that is returned.
   */
  search(problemId: string, request: MemorySearchRequest): Promise<MemorySearchOutcome>;
}

/**
 * A value that is safe to put in a path segment and is shaped like an id.
 *
 * This is a check about path construction, not a second opinion on what the
 * server accepts: anything matching this needs no escaping, and anything that
 * does not is refused before a request is built rather than encoded into one.
 * The server remains the authority on whether a well-formed id exists.
 */
const PATH_SAFE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Raised for an argument that could not be part of a request. */
export class MemoryApiArgumentError extends Error {
  readonly argument: string;

  constructor(argument: string) {
    // The argument's *name*, never its value. A malformed id is often a
    // mistyped variable holding something else entirely.
    super(`The Memory API client was given an unusable ${argument}.`);
    this.name = 'MemoryApiArgumentError';
    this.argument = argument;
  }
}

/** Whether a thrown value is the platform's way of saying "abandoned". */
function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/**
 * Builds a client.
 *
 * Everything that can be wrong with the configuration is wrong here, before a
 * request exists. The credential is closed over and is not readable from the
 * returned object: a client is something you use, not something you read a
 * secret back out of.
 */
export function createMemoryApiClient(options: MemoryApiClientOptions): MemoryApiClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_MEMORY_API_BASE_URL);
  const credential = requireCredential(options.credential);
  const transport = options.fetch ?? globalThis.fetch;
  // Left as the caller gave it — `undefined` included — because "no ceiling was
  // asked for" is what selects the per-operation default below. Collapsing it to
  // one number here is what made a search inherit an ordinary read's ten
  // seconds.
  const timeoutMs = options.timeoutMs;

  /**
   * One request, one response, and every failure turned into one of the three
   * kinds before it leaves.
   *
   * The credential goes in exactly one place: the `Authorization` header. Not
   * the query string, where it would reach every access log between here and
   * the server; not the body, where it would be echoed by anything that logs
   * requests; not the URL, which is printed by every HTTP client's own error.
   */
  async function send(
    path: string,
    options: {
      readonly method: 'GET' | 'POST';
      readonly body?: string;
      readonly timeoutMs: number;
    },
  ): Promise<{ status: number; body: unknown }> {
    let response: Response;
    try {
      response = await transport(`${baseUrl}${path}`, {
        method: options.method,
        headers: {
          authorization: `Bearer ${credential}`,
          accept: 'application/json',
          // Only when there is one. A `Content-Type` on a request with no body
          // describes something that is not there.
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(options.body === undefined ? {} : { body: options.body }),
        // Built-in, so nothing is added to make a request finite.
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (error) {
      // Deliberately not inspected further. Whatever this is, no answer came
      // back, and the original is not attached — see the note in `errors.ts`.
      throw new MemoryApiUnreachableError(isAbort(error) ? 'ABORTED' : 'TRANSPORT');
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      // A status line arrived and the body did not. There is no answer to
      // read, so this is the same situation as never hearing back.
      throw new MemoryApiUnreachableError('TRANSPORT');
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new MemoryApiProtocolError('BODY_NOT_JSON', response.status);
    }

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new MemoryApiProtocolError('BODY_NOT_AN_OBJECT', response.status);
    }

    return { status: response.status, body };
  }

  /**
   * Reads a non-2xx answer as the refusal it claims to be.
   *
   * Returns the error rather than throwing it, because one caller needs to look
   * at it first: a search turns a `NOT_FOUND` into a typed outcome, and it can
   * only do that by knowing the code. Everything that is *not* a refusal this
   * contract describes still leaves from here — an envelope with no `error`, a
   * code nobody has heard of, a proxy's own JSON — because none of that came
   * from a server implementing this contract, and reporting it as though it had
   * would tell a caller the Memory refused something it never saw.
   *
   * One copy, deliberately. Envelope validation duplicated per method is
   * envelope validation that drifts per method.
   */
  function readApiError(status: number, body: unknown): MemoryApiError {
    const envelope = body as Record<string, unknown>;
    const error = envelope['error'];
    const requestId = envelope['request_id'];

    if (
      typeof error !== 'object' ||
      error === null ||
      Array.isArray(error) ||
      typeof requestId !== 'string'
    ) {
      throw new MemoryApiProtocolError('ERROR_ENVELOPE_MALFORMED', status);
    }

    const code = (error as Record<string, unknown>)['code'];
    if (!isMemoryApiErrorCode(code)) {
      // Including the unknown code in the message would be the obvious thing
      // and would put a value chosen by whatever answered into a log line.
      throw new MemoryApiProtocolError('ERROR_CODE_UNKNOWN', status);
    }

    return new MemoryApiError(status, code, requestId);
  }

  return {
    async getProblem(problemId): Promise<ProblemResource> {
      if (!PATH_SAFE_ID.test(problemId)) {
        // Before the request, so a malformed id never becomes a URL — and so
        // no request is spent finding out what could be known here.
        throw new MemoryApiArgumentError('problem id');
      }

      const { status, body } = await send(`/v1/problems/${problemId}`, {
        method: 'GET',
        timeoutMs: timeoutMs ?? MEMORY_API_REQUEST_TIMEOUT_MS,
      });

      if (status < 200 || status >= 300) {
        throw readApiError(status, body);
      }

      if (!isProblemResource(body) || body.problem_id !== problemId) {
        // The route named a Problem, and a body describing a different one is
        // not an answer to that request — the same rule the list already
        // applies to every element it returns.
        //
        // It reads like pedantry on a GET and is not, because of what is done
        // with the answer. A caller reads a Problem in order to act on it: to
        // decide a binding still holds, or to take the version it will send
        // back on a transition. A response about Problem B accepted under
        // Problem A's URL would let a mutation to A be decided from B's state,
        // and nothing downstream could notice, because by then there is only
        // one Problem in hand and it looks entirely well formed.
        //
        // Neither id is quoted. Which two Problems disagreed is the request
        // id's to lead to.
        throw new MemoryApiProtocolError('RESOURCE_MALFORMED', status);
      }

      return body;
    },

    async listProjects(): Promise<readonly ProjectResource[]> {
      const { status, body } = await send('/v1/projects', {
        method: 'GET',
        timeoutMs: timeoutMs ?? MEMORY_API_REQUEST_TIMEOUT_MS,
      });

      if (status < 200 || status >= 300) {
        throw readApiError(status, body);
      }

      if (!isProjectListBody(body)) {
        throw new MemoryApiProtocolError('RESOURCE_MALFORMED', status);
      }

      return body.projects;
    },

    async listProblems(projectId): Promise<readonly ProblemResource[]> {
      if (!PATH_SAFE_ID.test(projectId)) {
        throw new MemoryApiArgumentError('project id');
      }

      const { status, body } = await send(`/v1/projects/${projectId}/problems`, {
        method: 'GET',
        timeoutMs: timeoutMs ?? MEMORY_API_REQUEST_TIMEOUT_MS,
      });

      if (status < 200 || status >= 300) {
        throw readApiError(status, body);
      }

      if (!isProblemListBody(body)) {
        throw new MemoryApiProtocolError('RESOURCE_MALFORMED', status);
      }

      // The route named the Project and the body has to agree with it. A
      // Problem from somewhere else is not a Problem this caller asked about,
      // and passing it on would put another Project's work into whatever is
      // deciding what is being worked on here. Same failure as any other body
      // this contract cannot read: nothing about it is a refusal, and there is
      // no useful third answer between "the list" and "not the list".
      if (body.problems.some((problem) => problem.project_id !== projectId)) {
        throw new MemoryApiProtocolError('RESOURCE_MALFORMED', status);
      }

      return body.problems;
    },

    async createProject(request): Promise<ProjectResource> {
      if (!isCreateProjectRequest(request)) {
        // Named as one argument and carrying none of it: a project name is
        // somebody's own word for their own work.
        throw new MemoryApiArgumentError('project');
      }

      // Field by field, so an extra property on the caller's object cannot
      // travel, and `undefined` is never written — absent stays absent and an
      // explicit `null` stays null.
      const payload: Record<string, unknown> = { project_name: request.project_name };
      if ('repo' in request) {
        payload['repo'] = request.repo;
      }
      if ('platform' in request) {
        payload['platform'] = request.platform;
      }
      if ('repo_subpath' in request) {
        payload['repo_subpath'] = request.repo_subpath;
      }

      const { status, body } = await send('/v1/projects', {
        method: 'POST',
        body: JSON.stringify(payload),
        timeoutMs: timeoutMs ?? MEMORY_API_REQUEST_TIMEOUT_MS,
      });

      if (status < 200 || status >= 300) {
        throw readApiError(status, body);
      }

      if (!isProjectResource(body)) {
        throw new MemoryApiProtocolError('RESOURCE_MALFORMED', status);
      }

      // The one field worth comparing. A boundary is identity material and the
      // server never normalises it — it validates and stores it exactly — so a
      // Project that came back covering a different part of the repository than
      // the one asked for is not an answer to this request.
      //
      // The name, the repository and the platform are deliberately *not*
      // compared: those the server does normalise, and demanding equality would
      // make a correct response look like a broken one.
      if (body.repo_subpath !== (request.repo_subpath ?? null)) {
        throw new MemoryApiProtocolError('RESOURCE_MALFORMED', status);
      }

      return body;
    },

    async createEnvironment(projectId, request): Promise<EnvironmentResource> {
      if (!PATH_SAFE_ID.test(projectId)) {
        throw new MemoryApiArgumentError('project id');
      }
      if (!isCreateEnvironmentRequest(request)) {
        // Before the request, and without the snapshot in the message. What is
        // wrong with it is a shape, and the values are the caller's own.
        throw new MemoryApiArgumentError('environment snapshot');
      }

      const { status, body } = await send(`/v1/projects/${projectId}/environments`, {
        method: 'POST',
        // Rebuilt from the one field this contract has, so nothing a caller
        // attached beside it travels.
        body: JSON.stringify({ snapshot: request.snapshot }),
        timeoutMs: timeoutMs ?? MEMORY_API_REQUEST_TIMEOUT_MS,
      });

      if (status < 200 || status >= 300) {
        throw readApiError(status, body);
      }

      if (!isEnvironmentResource(body) || body.project_id !== projectId) {
        // The route named the Project; an answer describing another one is not
        // an answer to this request.
        throw new MemoryApiProtocolError('RESOURCE_MALFORMED', status);
      }

      return body;
    },

    async createProblem(projectId, request): Promise<ProblemResource> {
      if (!PATH_SAFE_ID.test(projectId)) {
        throw new MemoryApiArgumentError('project id');
      }
      if (!isCreateProblemRequest(request)) {
        // Named as one argument rather than field by field, and carrying none
        // of it: a title and symptoms are somebody's own words about their own
        // problem.
        throw new MemoryApiArgumentError('problem');
      }

      // Field by field, so an extra property on the caller's object cannot
      // travel — and `undefined` is never written, so absent stays absent and
      // an explicit `null` stays null. The two mean different things to the
      // server and this is where they would otherwise collapse.
      const body: Record<string, unknown> = {
        environment_id: request.environment_id,
        title: request.title,
        symptoms: request.symptoms,
      };
      if ('problem_domain' in request) {
        body['problem_domain'] = request.problem_domain;
      }
      if ('suspected_boundary' in request) {
        body['suspected_boundary'] = request.suspected_boundary;
      }
      if ('source_ai' in request) {
        body['source_ai'] = request.source_ai;
      }

      const { status, body: answer } = await send(`/v1/projects/${projectId}/problems`, {
        method: 'POST',
        body: JSON.stringify(body),
        timeoutMs: timeoutMs ?? MEMORY_API_REQUEST_TIMEOUT_MS,
      });

      if (status < 200 || status >= 300) {
        throw readApiError(status, answer);
      }

      if (
        !isProblemResource(answer) ||
        answer.project_id !== projectId ||
        answer.environment_id !== request.environment_id
      ) {
        // Both halves of what was asked for. A Problem attached to a different
        // Environment than the one just recorded describes conditions nobody
        // captured.
        throw new MemoryApiProtocolError('RESOURCE_MALFORMED', status);
      }

      return answer;
    },

    async transitionProblemStatus(problemId, request): Promise<ProblemResource> {
      if (!PATH_SAFE_ID.test(problemId)) {
        throw new MemoryApiArgumentError('problem id');
      }
      if (!isTransitionProblemStatusRequest(request)) {
        // Before the request, and named as one argument. What is wrong is a
        // shape, and `changed_by` is somebody's own name for themselves.
        throw new MemoryApiArgumentError('status transition');
      }

      // Written out field by field rather than serialising the caller's object,
      // so an extra property cannot travel to a route that refuses extras.
      const payload = {
        target_status: request.target_status,
        expected_version: request.expected_version,
        changed_by: request.changed_by,
      };

      const { status, body } = await send(`/v1/problems/${problemId}/status-transitions`, {
        method: 'POST',
        body: JSON.stringify(payload),
        timeoutMs: timeoutMs ?? MEMORY_API_REQUEST_TIMEOUT_MS,
      });

      if (status < 200 || status >= 300) {
        throw readApiError(status, body);
      }

      if (
        !isProblemResource(body) ||
        body.problem_id !== problemId ||
        body.status !== request.target_status
      ) {
        // Both halves of what was asked. A Problem that came back in a
        // different status than the one requested has not answered this
        // request, whatever else is true of it — and a caller about to record
        // "resumed" would otherwise record it about a Problem that did not
        // move.
        //
        // The version is deliberately not checked against any arithmetic. How
        // far a version moves is the server's, the published contract does not
        // promise a step of one, and a client asserting one would break the
        // first time a transition wrote anything else alongside the status.
        throw new MemoryApiProtocolError('RESOURCE_MALFORMED', status);
      }

      return body;
    },

    async search(problemId, request): Promise<MemorySearchOutcome> {
      if (!PATH_SAFE_ID.test(problemId)) {
        throw new MemoryApiArgumentError('problem id');
      }
      if (!isMemorySearchRequest(request)) {
        // Before the request, and without the request in the message. A search
        // is made of somebody's own words about their own problem, and the
        // argument's name is the whole of what is safe to say.
        throw new MemoryApiArgumentError('search request');
      }

      const { status, body } = await send(`/v1/problems/${problemId}/search`, {
        method: 'POST',
        // Written out field by field rather than serialising the caller's
        // object, so an extra property on it cannot travel even if validation
        // one day stopped noticing.
        body: JSON.stringify({
          source_ai: request.source_ai,
          lexical_text: request.lexical_text,
          semantic_text: request.semantic_text,
          current_features: request.current_features,
        }),
        timeoutMs: timeoutMs ?? MEMORY_API_SEARCH_TIMEOUT_MS,
      });

      if (status < 200 || status >= 300) {
        const error = readApiError(status, body);

        // Only this exact pairing. A `404` whose envelope is malformed, or whose
        // code is something else, has already left through `readApiError` or
        // falls through to be raised — because deciding from the status alone
        // would turn any 404-shaped answer, including a proxy's, into "your
        // Problem is gone".
        if (status === 404 && error.code === 'NOT_FOUND') {
          return { kind: 'CURRENT_PROBLEM_NOT_AVAILABLE' };
        }

        throw error;
      }

      if (!isMemorySearchResponse(body)) {
        throw new MemoryApiProtocolError('SEARCH_RESPONSE_MALFORMED', status);
      }

      return body;
    },
  };
}
