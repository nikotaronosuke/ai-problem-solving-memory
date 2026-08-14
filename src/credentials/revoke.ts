/**
 * Executable entrypoint: revoke a credential.
 *
 * Run with `npm run credential:revoke -- --credential-id <uuid>`.
 *
 * Takes an identifier rather than a token, for two reasons. The person
 * revoking usually does not have the token — that is frequently *why* they are
 * revoking it — and passing a live credential on a command line puts it in a
 * shell history file, which is the sort of place credentials are found later.
 *
 * Scoped to the owner in `MEMORY_OWNER_ID`. A credential id belonging to
 * somebody else matches nothing: the scope is part of the statement rather
 * than a check performed after the fact, so there is no window between reading
 * a row and deciding whether it was allowed.
 *
 * Takes effect on the next request. Nothing about a credential is cached, so
 * there is no restart, no wait, and no window in which a revoked credential
 * still works.
 */

import { loadEnv } from '../config/env.js';
import { resolveDatabaseConfig } from '../db/config.js';
import { closePool, createPool } from '../db/pool.js';
import { toCredentialId } from '../domain/credential.js';
import { toOwnerId } from '../domain/owner.js';
import { MEMORY_OWNER_ID_VAR, readOwnerIdFromEnv } from '../owner/context.js';
import { createCredentialRepository } from './repository.js';

function readCredentialId(argv: readonly string[]): string | undefined {
  const at = argv.indexOf('--credential-id');
  return at === -1 ? undefined : argv[at + 1];
}

const requested = readCredentialId(process.argv.slice(2));
if (requested === undefined || requested.trim() === '') {
  console.error('Usage: npm run credential:revoke -- --credential-id <uuid>');
  process.exit(1);
}

const configured = readOwnerIdFromEnv();
if (configured === undefined) {
  console.error(`${MEMORY_OWNER_ID_VAR} is not set. Copy .env.example to .env.`);
  process.exit(1);
}

const ownerId = toOwnerId(configured);
const credentialId = toCredentialId(requested);
const env = loadEnv();
const pool = createPool(resolveDatabaseConfig({ nodeEnv: env.nodeEnv }));

try {
  const revoked = await createCredentialRepository(pool).revoke(ownerId, credentialId);

  if (revoked) {
    console.log(`credential revoked | ${credentialId}`);
  } else {
    // One message for "no such credential", "not yours" and "already revoked".
    // The distinction is not useful to whoever ran this and would turn the
    // command into a way of asking which credential ids exist.
    console.log(`nothing to revoke  | ${credentialId}`);
  }
} finally {
  await closePool(pool);
}
