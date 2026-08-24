/**
 * How the host tells this runtime which conversation a tool call belongs to.
 *
 * ## Why a call needs telling at all
 *
 * A stdio MCP server is started once and lives across conversations. The
 * session it was started in is not the session it is being called from, so
 * nothing the process remembers can answer "who is this call for" — and the
 * value it was handed at startup is the most convincing wrong answer available.
 * The identity has to arrive with each call, from something the model cannot
 * choose.
 *
 * ## What this is, and what it deliberately is not
 *
 * It is a **rendezvous on the host's own identifier for the current call**. A
 * trusted pre-tool hook, which the host gives both the session and the call
 * identifier, writes one small record under a name derived from that
 * identifier. The handler independently reads the same identifier from the
 * protocol metadata of the call it is serving, derives the same name, and
 * claims that one record.
 *
 * ## What makes the claim exactly once
 *
 * Creating one file that cannot already exist. Each call has a single marker
 * name derived from the same hash as its record, and the claim is the
 * *creation* of that marker with `wx` — the one primitive here that the
 * platform genuinely serialises. Whoever creates it reads the record; everyone
 * else stops without reading anything.
 *
 * This replaced an earlier design in which claiming meant renaming the record
 * to a unique name and treating a successful rename as ownership. Measured on
 * Windows, that is not true: concurrent renames of one source report success to
 * several callers — four of ten in a direct probe — and under load two of them
 * ended up with a real file and the same valid session, twelve times in two
 * thousand rounds. A uniquely-named destination per contender is the tell:
 * nobody was contending for the same object.
 *
 * It is **not** a token the hook passes through the tool's input. That design
 * was built, measured, and rejected: a record minted for a call whose handler
 * never ran — because schema validation refused the input, or another rule
 * denied the call — stays on disk, and a later unrelated call carrying the same
 * value consumed it and was handed the earlier call's session. Measured, not
 * theorised. A value that travels through the model is a value that can be
 * presented again; an identifier the handler reads for itself cannot be, because
 * the next call has a different one.
 *
 * So there is no proof field, no token, no signature, and nothing reserved in
 * the tool's input for a caller to fill in.
 *
 * ## What the identifier is
 *
 * The host publishes it on MCP request metadata. That key is **measured on the
 * installed host and is not part of any published contract** — so its absence
 * is treated as the loss of session identity and nothing else is tried. Failing
 * closed makes a future host change disable this tool; guessing would make the
 * same change attach somebody's work to another conversation.
 */

import { createHash } from 'node:crypto';
import { mkdir, open, readdir, readFile, stat, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import {
  CALL_CONTEXT_FIELDS,
  CALL_CONTEXT_FORMAT_VERSION,
  CALL_CONTEXT_MAX_AGE_MS,
  CALL_CONTEXT_MAX_BYTES,
  CLAIM_MARKER_PREFIX,
  CLAIM_MARKER_SUFFIX,
  PENDING_PREFIX,
  RECORD_SUFFIX,
} from './runtime-constants.js';

/**
 * The host's own identifier for the tool call being served.
 *
 * The one key this runtime reads, named in one place. Measured against the
 * installed host rather than documented by it, which is why every path out of
 * here refuses rather than substitutes.
 */
const HOST_CALL_ID_META_KEYS = ['claudecode/toolUseId', 'callId'] as const;

/**
 * What a pending record holds. Exactly this, and nothing about the work.
 *
 * `current_directory` is where the session was when the host announced this
 * call — an absolute path on this machine, carried because the server process
 * cannot ask: it learned a directory once, at start-up, and a session that
 * has moved since would go on being answered about the place it left. It is
 * transport, not identity: it authenticates nothing by itself, and it is gone
 * before anything the Memory sees.
 */
export interface HostCallContext {
  readonly format_version: typeof CALL_CONTEXT_FORMAT_VERSION;
  readonly session_id: string;
  readonly tool_name: string;
  readonly current_directory: string;
  readonly minted_at: number;
}

/** What claiming a call context concluded. */
export type HostCallContextClaim =
  | {
      readonly kind: 'CLAIMED';
      readonly sessionId: string;
      readonly currentDirectory: string;
      readonly toolName: string;
    }
  | { readonly kind: 'UNAVAILABLE' };

/** Whether text has something in it. */
function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && /\S/.test(value);
}

/** Whether a value is a path that means the same thing wherever it is read. */
function isAbsolutePath(value: unknown): value is string {
  return isNonBlank(value) && isAbsolute(value);
}

/**
 * The host's identifier for this call, or nothing.
 *
 * Reads the two exact host-owned keys this runtime supports. There is no
 * second-best source: the request's own
 * JSON-RPC id is the client's counter and means nothing across calls, a
 * progress token is the client's too, and anything reachable from the tool's
 * arguments is chosen by the model — which is the whole thing this avoids.
 */
export function hostCallIdOf(request: unknown): string | undefined {
  if (typeof request !== 'object' || request === null) {
    return undefined;
  }
  const meta = (request as { _meta?: unknown })._meta;
  if (typeof meta !== 'object' || meta === null) {
    return undefined;
  }
  const record = meta as Record<string, unknown>;
  const values = HOST_CALL_ID_META_KEYS.filter((key) => Object.hasOwn(record, key)).map(
    (key) => record[key],
  );
  if (values.length === 0) {
    return undefined;
  }
  if (!values.every(isNonBlank)) {
    return undefined;
  }
  return values.every((value) => value === values[0]) ? values[0] : undefined;
}

/**
 * The filename a call's record lives under.
 *
 * A hash rather than the identifier itself. The identifier looks path-safe on
 * the installed host and that is a fact about today: it is an undocumented
 * host value, and a value from outside this process should never become a path
 * segment on the strength of how it currently looks. A hex digest has no
 * separator, no dot-dot and no drive letter, so traversal is unreachable
 * rather than filtered.
 */
export function callContextFilename(hostCallId: string, prefix: string = PENDING_PREFIX): string {
  const digest = createHash('sha256').update(hostCallId, 'utf8').digest('hex');
  return `${prefix}${digest}${RECORD_SUFFIX}`;
}

/**
 * The marker whose creation is this call's one chance to be consumed.
 *
 * Derived from the same hash as the record, with nothing random in it: every
 * contender for one call must contend for exactly the same path, or there is
 * no contention to win.
 */
export function claimMarkerFilename(hostCallId: string): string {
  const digest = createHash('sha256').update(hostCallId, 'utf8').digest('hex');
  return `${CLAIM_MARKER_PREFIX}${digest}${CLAIM_MARKER_SUFFIX}`;
}

/**
 * The shapes this component generates, plus one it only cleans up.
 *
 * Written beside the function that builds those names so the two cannot drift:
 * a digest, and a digest followed by the identifier a claim adds. Recognising
 * by prefix and extension alone was too generous — `pending-anything.json` is
 * not a name this code can produce, and sweeping it would mean deleting
 * somebody else's file out of a directory this component merely shares.
 */
const OWNED_FILENAME =
  /^(?:pending-[0-9a-f]{64}\.json|claim-[0-9a-f]{64}\.lock|claimed-[0-9a-f]{64}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json)$/u;

/** Whether a directory entry is one of ours, by name alone. */
export function isOwnedCallContextFilename(entry: string): boolean {
  return OWNED_FILENAME.test(entry);
}

/**
 * Whether a parsed record is one this version wrote.
 *
 * Closed and exact. A record with a field nobody here knows about was written
 * by something else, and the safe reading of that is "no usable context" — the
 * same direction every other doubt takes.
 */
export function isHostCallContext(value: unknown): value is HostCallContext {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== CALL_CONTEXT_FIELDS.length) {
    return false;
  }
  for (const field of CALL_CONTEXT_FIELDS) {
    if (!(field in record)) {
      return false;
    }
  }
  const mintedAt = record['minted_at'];

  return (
    record['format_version'] === CALL_CONTEXT_FORMAT_VERSION &&
    // Opaque on purpose: a session identifier's syntax is the host's to change,
    // and a second copy of that rule here would refuse good identities the day
    // it moved.
    isNonBlank(record['session_id']) &&
    isNonBlank(record['tool_name']) &&
    // Absolute, and taken as written. A relative path would be resolved
    // against whatever process happened to read it, which is exactly the
    // thing a Project must never depend on.
    isAbsolutePath(record['current_directory']) &&
    typeof mintedAt === 'number' &&
    Number.isInteger(mintedAt) &&
    mintedAt > 0
  );
}

/** Whether a record is too old to be anything but litter. */
export function isExpired(context: HostCallContext, now: number): boolean {
  // A record stamped in the future is as unusable as an ancient one: it was
  // not written by a clock this process shares.
  return context.minted_at > now || now - context.minted_at > CALL_CONTEXT_MAX_AGE_MS;
}

/**
 * Records that this host call is for this session, exactly once.
 *
 * Refuses to replace an existing record rather than overwriting it. Two host
 * events claiming one call identifier is a situation nobody has explained, and
 * quietly keeping the second would hand a call whichever session wrote last.
 */
export async function mintCallContext(options: {
  readonly directory: string;
  readonly hostCallId: string;
  readonly sessionId: string;
  readonly toolName: string;
  readonly currentDirectory: string;
  readonly now: number;
}): Promise<boolean> {
  await mkdir(options.directory, { recursive: true });

  const context: HostCallContext = {
    format_version: CALL_CONTEXT_FORMAT_VERSION,
    session_id: options.sessionId,
    tool_name: options.toolName,
    // Written as the host gave it. Nothing here canonicalises a repository or
    // reads git: the hook is transport, and deciding what a directory means
    // is the adapter's, one process later.
    current_directory: options.currentDirectory,
    minted_at: options.now,
  };

  const path = join(options.directory, callContextFilename(options.hostCallId));

  try {
    // `wx` is the whole guarantee: the file is created or the call fails, and
    // no window exists between checking and writing.
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(context), 'utf8');
    } finally {
      await handle.close();
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Claims the record for this call, if there is one, and reads the session from it.
 *
 * The claim happens before anything is read, and it is the creation of one
 * marker that cannot already exist. A loser learns only that it lost: it never
 * opens the record, so trusted session context is read by exactly one caller.
 *
 * ## The marker is not removed when the call finishes
 *
 * It is a tombstone meaning "this call has already had its one attempt", and it
 * outlives the attempt on purpose. Removing it would put correctness back on
 * the record's deletion having succeeded — and a failed unlink, a record that
 * reappeared, or a first attempt that found the record malformed would each
 * reopen an identity that has already been spent. Housekeeping removes the
 * marker later, on age, like any other litter.
 *
 * It holds nothing: no session, no work, not even the identifier it is named
 * after. Its existence is the whole of what it says, and it can say it about no
 * other call, because another call hashes to another name.
 *
 * Nothing about the record is returned except the session. A caller that could
 * see the rest would eventually put some of it somewhere.
 */
export async function claimCallContext(options: {
  readonly directory: string;
  readonly hostCallId: string;
  readonly toolNames: readonly string[];
  readonly now: number;
}): Promise<HostCallContextClaim> {
  const pending = join(options.directory, callContextFilename(options.hostCallId));
  const marker = join(options.directory, claimMarkerFilename(options.hostCallId));

  try {
    // The whole of the exclusion, and it happens first. `wx` creates the file
    // or fails because it is already there; the platform decides that once, for
    // everybody. Nothing about the record is touched until this has been won.
    const handle = await open(marker, 'wx', 0o600);
    await handle.close();
  } catch {
    // Somebody already has this call, or the directory cannot be written to.
    // Both mean the same thing here, and neither is worth describing: there is
    // no second marker to look for and nothing to retry.
    return { kind: 'UNAVAILABLE' };
  }

  try {
    // The size is checked before the bytes are taken, not after. Reading first
    // and measuring the string afterwards is not a bound at all — whatever was
    // in the file is already in memory by then, and these records are a few
    // hundred bytes written by this component.
    const description = await stat(pending);
    if (!description.isFile() || description.size > CALL_CONTEXT_MAX_BYTES) {
      return { kind: 'UNAVAILABLE' };
    }

    const parsed: unknown = JSON.parse(await readFile(pending, 'utf8'));
    if (!isHostCallContext(parsed)) {
      return { kind: 'UNAVAILABLE' };
    }
    if (!options.toolNames.includes(parsed.tool_name)) {
      return { kind: 'UNAVAILABLE' };
    }
    if (isExpired(parsed, options.now)) {
      return { kind: 'UNAVAILABLE' };
    }
    return {
      kind: 'CLAIMED',
      sessionId: parsed.session_id,
      currentDirectory: parsed.current_directory,
      toolName: parsed.tool_name,
    };
  } catch {
    return { kind: 'UNAVAILABLE' };
  } finally {
    // The record has had its one attempt, whatever came of it. The marker is
    // deliberately left where it is: it, and not this unlink, is what makes a
    // second attempt impossible.
    await unlink(pending).catch(() => undefined);
  }
}

/**
 * Removes this component's own stale files, and nothing else.
 *
 * Bounded by name and by age, one directory deep, never recursive. Its failure
 * is deliberately unobservable to callers: authentication does not depend on
 * tidiness, and a valid call must not fail because some unrelated file could
 * not be removed.
 */
export async function sweepCallContexts(options: {
  readonly directory: string;
  readonly now: number;
}): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(options.directory);
  } catch {
    return;
  }

  for (const entry of entries) {
    // Including the previous version's claimed records, which are removed on
    // age and never read: they are litter, not state this version acts on.
    if (!isOwnedCallContextFilename(entry)) {
      continue;
    }

    const path = join(options.directory, entry);
    let description;
    try {
      description = await stat(path);
    } catch {
      // Gone already, or not readable. Either way it is not this sweep's to
      // reason about.
      continue;
    }

    if (!description.isFile()) {
      continue;
    }

    // Age decides, and it decides *before* anything is read. A record being
    // written right now by another hook is incomplete for a moment, and a
    // sweep that judged files by whether they parse would delete exactly that
    // one — leaving a perfectly valid call with nothing to claim. Which is a
    // failure of availability rather than of authentication, and precisely the
    // parallel case this runtime is meant to support.
    //
    // Nothing is parsed here at all. Whether a record *means* anything is the
    // claim's question, asked of its contents; the only question here is
    // whether this is old litter of ours.
    const age = options.now - description.mtimeMs;
    if (age <= CALL_CONTEXT_MAX_AGE_MS) {
      // Including a file stamped in the future, which is not old.
      continue;
    }

    await unlink(path).catch(() => undefined);
  }
}
