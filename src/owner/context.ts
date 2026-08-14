/**
 * Establishing who the current operation belongs to.
 *
 * In local development the owner comes from `MEMORY_OWNER_ID`. Resolution
 * fails closed: a missing variable, a malformed value and an owner that is not
 * in the database are three distinct failures, and none of them yields a
 * context. Owner-scoped work takes an `OwnerContext`, so it cannot start
 * before ownership is settled.
 *
 * There are two ways in, and both end at the same existence check. Local
 * tooling reads `MEMORY_OWNER_ID`; an HTTP request arrives with a credential
 * that names an owner, and `resolveOwnerContextFor` confirms that owner is
 * real. Neither hands out a context for an id nobody checked, which is the
 * whole value of the type.
 */

import { toOwnerId, type OwnerContext, type OwnerId } from '../domain/owner.js';
import { findOwnerRecord } from '../db/owners.js';
import type { EnvSource } from '../config/env.js';
import type { DatabaseExecutor } from '../db/executor.js';

/** Name of the variable holding the local development owner id. */
export const MEMORY_OWNER_ID_VAR = 'MEMORY_OWNER_ID';

export type OwnerContextFailure =
  /** The variable is absent or blank. */
  | 'MISSING'
  /** The variable is set but is not a usable owner id. */
  | 'INVALID'
  /** A well-formed owner id with no matching row. */
  | 'UNKNOWN';

/** Raised when no owner can be established. */
export class OwnerContextError extends Error {
  readonly reason: OwnerContextFailure;

  constructor(reason: OwnerContextFailure, detail: string) {
    super(`Cannot establish an owner context (${reason}): ${detail}`);
    this.name = 'OwnerContextError';
    this.reason = reason;
  }
}

/**
 * Asserts a context for an owner already confirmed to exist.
 *
 * Not exported: this is the single point where a context comes into being,
 * and it sits directly under the existence check below so the two cannot be
 * separated. Everything else receives a context rather than making one.
 */
function establishOwnerContext(ownerId: OwnerId): OwnerContext {
  return { ownerId } as OwnerContext;
}

/**
 * Establishes the context for an owner id that came from somewhere trusted.
 *
 * "Trusted" means the value is already a validated `OwnerId` — from a
 * credential row, say — and not that its existence can be assumed. The
 * database is still asked, because the invariant this type carries is that
 * somebody checked, and an id read out of a foreign key is not the same as a
 * row that is still there.
 *
 * This exists so that credential-based authentication has one honest way to
 * reach a context, rather than a cast at the call site. There is deliberately
 * no public constructor that skips the check.
 */
export async function resolveOwnerContextFor(
  executor: DatabaseExecutor,
  ownerId: OwnerId,
): Promise<OwnerContext> {
  const owner = await findOwnerRecord(executor, ownerId);
  if (owner === undefined) {
    throw new OwnerContextError('UNKNOWN', `no owner ${ownerId} exists.`);
  }
  return establishOwnerContext(ownerId);
}

/** Reads the configured owner id without validating or checking it. */
export function readOwnerIdFromEnv(source: EnvSource = process.env): string | undefined {
  const raw = source[MEMORY_OWNER_ID_VAR];
  if (raw === undefined) {
    return undefined;
  }

  const value = raw.trim();
  return value === '' ? undefined : value;
}

/**
 * Establishes the owner for owner-scoped work.
 *
 * Call this when starting such work, not at import time — code that never
 * touches owned data must keep running without an owner configured.
 */
export async function resolveOwnerContext(
  executor: DatabaseExecutor,
  source: EnvSource = process.env,
): Promise<OwnerContext> {
  const configured = readOwnerIdFromEnv(source);
  if (configured === undefined) {
    throw new OwnerContextError(
      'MISSING',
      `${MEMORY_OWNER_ID_VAR} is not set. See .env.example, then run \`npm run owner:bootstrap\`.`,
    );
  }

  let ownerId;
  try {
    ownerId = toOwnerId(configured);
  } catch (error) {
    // The value is not echoed: a misconfigured variable can hold something
    // that was never meant to be printed.
    const detail = error instanceof Error ? error.message : 'it is not a UUID';
    throw new OwnerContextError('INVALID', `${MEMORY_OWNER_ID_VAR} is unusable. ${detail}`);
  }

  const owner = await findOwnerRecord(executor, ownerId);
  if (owner === undefined) {
    // Safe to name: this is already a well-formed UUID, not a stray secret.
    throw new OwnerContextError(
      'UNKNOWN',
      `no owner ${ownerId} exists. Run \`npm run owner:bootstrap\` to create it locally.`,
    );
  }

  return establishOwnerContext(ownerId);
}
