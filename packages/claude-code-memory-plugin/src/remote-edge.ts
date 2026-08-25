/**
 * The remote Streamable HTTP entry point over the one MCP core (D-482).
 *
 * ## What this is
 *
 * A second way in to exactly the same nine tools `buildMemoryMcpServer`
 * registers — same names, same input and output contracts, same adapter, same
 * Memory API underneath. Nothing here is a second Memory model, a remote
 * Problem store, a handoff payload or a gateway; the only new knowledge in
 * this file is transport knowledge: HTTP, one endpoint, and how a remote
 * caller proves who they are.
 *
 * ## How a remote call is authenticated
 *
 * Not by imitating the local hook. The local PreToolUse mint-and-claim path
 * exists because a local host announces every call out of band; no remote
 * host does, and a fabricated imitation would be a forgeable copy of an
 * unforgeable thing. Instead the transport itself authenticates: the caller
 * presents the owner's existing Memory credential as a bearer token, the edge
 * verifies it against the Memory Server's own `/v1/me` — the one system that
 * actually knows credentials — and only then is a call established. What the
 * edge fixes server-side, outside every model-reachable schema: the
 * provenance (`remote-mcp` — the transport's honest name for itself, since it
 * cannot verify which assistant is calling), the owner (from the verified
 * credential, never from any input), and the session identity (derived from
 * the owner, so binding hints stay hints and stay per owner).
 *
 * ## What a remote session does not have
 *
 * No hook, no per-call working directory, no repository signals from the
 * caller's machine. The one directory project detection may look at is the
 * one the *operator* declared when starting this edge — an explicit
 * deployment-time statement about where remote work happens, detected fresh
 * on every call like any local directory, never a value a model chose and
 * never a guess. Everything downstream is unchanged: Project resolution,
 * current-Problem revalidation, the Verification gate, optimistic locking and
 * idempotency all stay in the core and the server, which this edge calls like
 * any other caller.
 *
 * ## Exposure posture
 *
 * Loopback only, by construction — the listener binds `127.0.0.1` and there
 * is no option to widen it. Public reachability, when an acceptance needs it,
 * is an outbound-only tunnel in front of this one endpoint (D-482), not a
 * different bind. Origins are an explicit allowlist with no wildcard; a
 * request that carries a disallowed `Origin` is refused before anything else
 * is read. The credential is read from the `Authorization` header only —
 * never from a query string — and is never logged, echoed or stored.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isAbsolute } from 'node:path';
import { realpathSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { createMemoryApiClient, type FetchLike } from '@ai-problem-solving-memory/api-client';
import {
  REMOTE_MCP_RUNTIME_PROVENANCE,
  type ProblemBindingRead,
  type ProblemBindingRemoval,
  type ProblemBindingStore,
  type ProblemBindingWrite,
} from '@ai-problem-solving-memory/claude-code-adapter';
import { createMcpHandler } from '@modelcontextprotocol/server';

import { PLUGIN_DATA_ENV } from './runtime-constants.js';
import { buildMemoryMcpServer, type EstablishCall } from './server.js';

/** Where the Memory Server is. Absent means the client's own loopback default. */
export const REMOTE_EDGE_API_URL_ENV = 'MEMORY_API_URL';

/** The one TCP port the edge listens on, loopback only. */
export const REMOTE_EDGE_PORT_ENV = 'MEMORY_REMOTE_EDGE_PORT';

/** Comma-separated exact origins allowed to reach the endpoint from a browser. */
export const REMOTE_EDGE_ALLOWED_ORIGINS_ENV = 'MEMORY_REMOTE_ALLOWED_ORIGINS';

/** The operator-declared directory remote work happens in. Required, absolute. */
export const REMOTE_EDGE_WORKSPACE_ENV = 'MEMORY_REMOTE_WORKSPACE';

/** The single endpoint path, per the Streamable HTTP transport. */
export const REMOTE_EDGE_ENDPOINT = '/mcp';

const DEFAULT_PORT = 3200;

/**
 * The verification types a remote session cannot honestly claim (P9-03).
 *
 * A remote chat host has no shell, no filesystem and no process on the
 * machine the declared workspace lives on, so a test run, a build, a real
 * device, an API observation against the operator's systems, or a database
 * read are checks its sessions cannot have performed — recording one would
 * be a fabricated Verification, which is exactly what capability
 * degradation exists to refuse. `USER_CONFIRMATION` is deliberately NOT
 * degraded: the human's confirmation arrives through the remote
 * conversation itself, a capability this transport genuinely has. The
 * core's Verification gate is untouched either way — a remotely-worked
 * Problem reaches VERIFIED only on evidence somebody could actually
 * produce (the user confirming, or a local session running the check).
 */
export const REMOTE_UNAVAILABLE_VERIFICATION_TYPES = [
  'TEST',
  'REAL_DEVICE',
  'BUILD',
  'API_RESULT',
  'DB_RESULT',
] as const;

/** Bounded request bodies: a tool call is small, and a stream of gigabytes is not one. */
const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

/**
 * Raised when the edge cannot be configured. Names the variable and never a
 * value: a rejected value is still somebody's value.
 */
export class RemoteEdgeConfigError extends Error {
  readonly variable: string;

  constructor(variable: string) {
    super(`${variable} is missing or not usable, so the remote edge cannot start.`);
    this.name = 'RemoteEdgeConfigError';
    this.variable = variable;
  }
}

export interface RemoteEdgeConfig {
  /** Passed through to the Memory client; absent keeps its loopback default. */
  readonly apiUrl: string | undefined;
  readonly port: number;
  /** Exact matches only. Empty means no browser origin is ever accepted. */
  readonly allowedOrigins: readonly string[];
  readonly workspaceDirectory: string;
  readonly stateDirectory: string;
}

/**
 * Reads and validates the edge's configuration, refusing rather than guessing.
 *
 * A wildcard origin is refused at configuration time: an allowlist with `*`
 * in it is not an allowlist, and failing at startup is the one moment the
 * operator is certainly watching.
 */
export function resolveRemoteEdgeConfig(
  environment: Readonly<Record<string, string | undefined>>,
): RemoteEdgeConfig {
  const portRaw = environment[REMOTE_EDGE_PORT_ENV];
  let port = DEFAULT_PORT;
  if (portRaw !== undefined) {
    if (!/^\d+$/.test(portRaw)) {
      throw new RemoteEdgeConfigError(REMOTE_EDGE_PORT_ENV);
    }
    port = Number(portRaw);
    if (port < 1 || port > 65535) {
      throw new RemoteEdgeConfigError(REMOTE_EDGE_PORT_ENV);
    }
  }

  const originsRaw = environment[REMOTE_EDGE_ALLOWED_ORIGINS_ENV];
  const allowedOrigins =
    originsRaw === undefined
      ? []
      : originsRaw
          .split(',')
          .map((one) => one.trim())
          .filter((one) => one.length > 0);
  if (allowedOrigins.some((one) => one === '*' || one.includes('*'))) {
    throw new RemoteEdgeConfigError(REMOTE_EDGE_ALLOWED_ORIGINS_ENV);
  }

  const workspaceDirectory = environment[REMOTE_EDGE_WORKSPACE_ENV];
  if (
    workspaceDirectory === undefined ||
    workspaceDirectory.length === 0 ||
    !isAbsolute(workspaceDirectory)
  ) {
    throw new RemoteEdgeConfigError(REMOTE_EDGE_WORKSPACE_ENV);
  }

  const stateDirectory = environment[PLUGIN_DATA_ENV];
  if (stateDirectory === undefined || stateDirectory.length === 0 || !isAbsolute(stateDirectory)) {
    throw new RemoteEdgeConfigError(PLUGIN_DATA_ENV);
  }

  return {
    apiUrl: environment[REMOTE_EDGE_API_URL_ENV],
    port,
    allowedOrigins,
    workspaceDirectory,
    stateDirectory,
  };
}

/**
 * Binding hints for remote sessions, held in memory.
 *
 * A binding is a hint revalidated on every use, never authority, so losing
 * every hint on restart costs one fresh question to the server and nothing
 * else. Keeping them off disk keeps the edge stateless where it can be.
 */
export function createInMemoryBindingStore(): ProblemBindingStore {
  const bindings = new Map<string, string>();

  const keyOf = (sessionId: string, projectId: string): string | undefined => {
    if (sessionId.trim().length === 0 || projectId.trim().length === 0) {
      return undefined;
    }
    return `${sessionId}\u0000${projectId}`;
  };

  return {
    readBinding(sessionId, projectId): Promise<ProblemBindingRead> {
      const key = keyOf(sessionId, projectId);
      if (key === undefined) {
        return Promise.resolve({ kind: 'MISSING' });
      }
      const problemId = bindings.get(key);
      return Promise.resolve(
        problemId === undefined
          ? { kind: 'MISSING' }
          : { kind: 'VALID', binding: { projectId, problemId } },
      );
    },
    writeBinding(sessionId, projectId, problemId): Promise<ProblemBindingWrite> {
      const key = keyOf(sessionId, projectId);
      if (key === undefined || problemId.trim().length === 0) {
        return Promise.resolve({ kind: 'IO_FAILURE' });
      }
      bindings.set(key, problemId);
      return Promise.resolve({ kind: 'WRITTEN' });
    },
    removeBinding(sessionId, projectId): Promise<ProblemBindingRemoval> {
      const key = keyOf(sessionId, projectId);
      if (key === undefined || !bindings.has(key)) {
        return Promise.resolve({ kind: 'MISSING' });
      }
      bindings.delete(key);
      return Promise.resolve({ kind: 'REMOVED' });
    },
  };
}

export interface RemoteEdgeHandlerOptions {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly now: () => number;
  /** Test seam for both credential verification and the Memory client. */
  readonly fetch?: FetchLike;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function unauthorised(): Response {
  // One shape for every authentication failure, so the endpoint is not an
  // oracle for which part was wrong.
  return json(
    401,
    { error: { code: 'UNAUTHENTICATED', message: 'A valid Memory credential is required.' } },
    { 'www-authenticate': 'Bearer' },
  );
}

/**
 * The fetch-shaped remote edge: one request in, one response out.
 *
 * The order is the security property. The endpoint and origin are checked
 * before the credential is read; the credential is verified against the
 * Memory Server before any MCP machinery runs; and only a verified owner
 * reaches a server instance — one built fresh for the request, whose every
 * call is established from that verification and nothing else.
 */
export function createRemoteEdgeHandler(
  options: RemoteEdgeHandlerOptions,
): (request: Request) => Promise<Response> {
  const config = resolveRemoteEdgeConfig(options.environment);
  const fetchLike: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const bindingStore = createInMemoryBindingStore();
  const verificationUrl = `${config.apiUrl ?? 'http://127.0.0.1:3000'}/v1/me`;

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname !== REMOTE_EDGE_ENDPOINT) {
      return json(404, { error: { code: 'NOT_FOUND', message: 'Not found.' } });
    }

    // Origin first, exact matches only. A request without an Origin header is
    // not a browser and carries nothing to validate; one with a header is
    // allowed only what the operator listed. This is the Streamable HTTP
    // spec's DNS-rebinding protection, fail closed.
    const origin = request.headers.get('origin');
    if (origin !== null && !config.allowedOrigins.includes(origin)) {
      return json(403, { error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Origin not allowed.' } });
    }

    // The credential, from the one header it may travel in. Query strings are
    // deliberately never consulted: a URL is logged by everything that sees it.
    const authorization = request.headers.get('authorization');
    const match = authorization === null ? null : /^Bearer\s+(\S+)$/i.exec(authorization);
    if (match === null) {
      return unauthorised();
    }
    const credential = match[1]!;

    // Verified by the one system that knows credentials. The edge holds no
    // copy, applies no grammar, and treats every non-200 the same.
    let ownerId: string;
    try {
      const verified = await fetchLike(verificationUrl, {
        method: 'GET',
        headers: { authorization: `Bearer ${credential}` },
      });
      if (verified.status === 401 || verified.status === 403) {
        return unauthorised();
      }
      if (verified.status !== 200) {
        return json(502, {
          error: { code: 'MEMORY_UNAVAILABLE', message: 'The Memory did not answer.' },
        });
      }
      const body = (await verified.json()) as { owner_id?: unknown };
      if (typeof body.owner_id !== 'string' || body.owner_id.length === 0) {
        return json(502, {
          error: { code: 'MEMORY_UNAVAILABLE', message: 'The Memory did not answer.' },
        });
      }
      ownerId = body.owner_id;
    } catch {
      return json(503, {
        error: { code: 'MEMORY_UNAVAILABLE', message: 'The Memory is unreachable.' },
      });
    }

    // Everything a tool call needs, fixed here and never from any input: the
    // client presents exactly the verified credential, the session identity
    // is the owner's, the directory is the operator's declaration, and the
    // provenance is this edge's own name.
    const establishCall: EstablishCall = () =>
      Promise.resolve({
        client: createMemoryApiClient({
          credential,
          ...(config.apiUrl === undefined ? {} : { baseUrl: config.apiUrl }),
          fetch: fetchLike,
        }),
        bindingStore,
        sessionId: `remote-${ownerId}`,
        projectDir: config.workspaceDirectory,
        runtimeProvenance: REMOTE_MCP_RUNTIME_PROVENANCE,
        pluginData: config.stateDirectory,
        // The declared capability degradation (P9-03): see the constant.
        unavailableVerificationTypes: REMOTE_UNAVAILABLE_VERIFICATION_TYPES,
      });

    // A fresh, per-request server over the same core registry. The empty
    // environment is load-bearing: with the call established above, nothing
    // on this path may fall back to an ambient credential or state path.
    const handler = createMcpHandler(() =>
      buildMemoryMcpServer({ environment: {}, now: options.now, establishCall }),
    );
    return handler.fetch(request);
  };
}

/** Reads one bounded body; `undefined` means it was too large. */
async function bodyOf(incoming: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of incoming) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_REQUEST_BODY_BYTES) {
      return undefined;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function webRequestOf(incoming: IncomingMessage, body: Buffer): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (typeof value === 'string') {
      headers.set(name, value);
    } else if (Array.isArray(value)) {
      for (const one of value) {
        headers.append(name, one);
      }
    }
  }
  return new Request(`http://127.0.0.1${incoming.url ?? '/'}`, {
    method: incoming.method ?? 'GET',
    headers,
    ...(body.length > 0 ? { body: new Uint8Array(body) } : {}),
  });
}

async function respondWith(response: Response, outgoing: ServerResponse): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  outgoing.writeHead(response.status, headers);
  if (response.body === null) {
    outgoing.end();
    return;
  }
  await pipeline(Readable.fromWeb(response.body), outgoing);
}

/**
 * Starts the edge on loopback. The bind address is a constant, not an option:
 * a wider bind is not a configuration of this edge, it is a different
 * deployment decision with its own Decision to carry it.
 */
export function startRemoteEdge(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<{ close: () => Promise<void> }> {
  const config = resolveRemoteEdgeConfig(environment);
  const handle = createRemoteEdgeHandler({ environment, now: () => Date.now() });

  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const body = await bodyOf(incoming);
      if (body === undefined) {
        outgoing.writeHead(413, { 'content-type': 'application/json' });
        outgoing.end(
          JSON.stringify({ error: { code: 'INVALID_REQUEST', message: 'Body too large.' } }),
        );
        return;
      }
      const response = await handle(webRequestOf(incoming, body));
      await respondWith(response, outgoing);
    })().catch(() => {
      // A failure this late has no response channel left worth trusting.
      outgoing.destroy();
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '127.0.0.1', () => {
      // Port only. No path, no origin list, and certainly no credential.
      process.stderr.write(`memory remote edge listening on 127.0.0.1:${String(config.port)}\n`);
      resolve({
        close: () =>
          new Promise<void>((done) => {
            server.close(() => {
              done();
            });
          }),
      });
    });
  });
}

/** Whether Node was asked to run this file, rather than to import it. */
function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  await startRemoteEdge();
}
