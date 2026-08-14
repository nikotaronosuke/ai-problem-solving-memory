/**
 * Executable entrypoint: issue a credential for a new client.
 *
 * Run with `npm run credential:issue -- --label "Claude Code laptop"`.
 *
 * This is a local administrative command and deliberately not an HTTP
 * endpoint. Issuing credentials over the API would need a credential to
 * authorise it, which is a chicken-and-egg problem with only bad answers: an
 * unauthenticated issue endpoint hands one to anybody who can reach the port,
 * and a bootstrap exception is an unauthenticated endpoint with a longer
 * explanation. Running locally against the database sidesteps the question —
 * whoever can run this already has the database.
 *
 * The token is printed once. The server keeps a digest and cannot reconstruct
 * it, so a lost token is replaced rather than recovered — which is why a client
 * may hold several at a time.
 */

import { loadEnv } from '../config/env.js';
import { resolveDatabaseConfig } from '../db/config.js';
import { closePool, createPool } from '../db/pool.js';
import { generateClientId, toClientLabel } from '../domain/client.js';
import {
  formatCredentialToken,
  generateCredentialId,
  generateCredentialToken,
  hashCredentialSecret,
} from '../domain/credential.js';
import { toOwnerId } from '../domain/owner.js';
import { MEMORY_OWNER_ID_VAR, readOwnerIdFromEnv } from '../owner/context.js';
import { createCredentialRepository } from './repository.js';

/** Reads `--label <value>`, which is the one thing this needs to be told. */
function readLabel(argv: readonly string[]): string | undefined {
  const at = argv.indexOf('--label');
  return at === -1 ? undefined : argv[at + 1];
}

const label = readLabel(process.argv.slice(2));
if (label === undefined || label.trim() === '') {
  console.error('Usage: npm run credential:issue -- --label "Claude Code laptop"');
  process.exit(1);
}

const configured = readOwnerIdFromEnv();
if (configured === undefined) {
  console.error(
    `${MEMORY_OWNER_ID_VAR} is not set. Copy .env.example to .env, then run \`npm run owner:bootstrap\`.`,
  );
  process.exit(1);
}

// The owner must already exist. This command grants access to Memory that is
// already there; it does not bring an owner into being as a side effect.
const ownerId = toOwnerId(configured);
const env = loadEnv();
const pool = createPool(resolveDatabaseConfig({ nodeEnv: env.nodeEnv }));

try {
  const clientId = generateClientId();
  const credentialId = generateCredentialId();
  const token = generateCredentialToken();

  await createCredentialRepository(pool).issueClientCredential({
    clientId,
    ownerId,
    label: toClientLabel(label),
    credentialId,
    tokenLookup: token.lookup,
    // The secret is hashed here and never written anywhere else. What goes to
    // the database is a digest; what goes to the screen is the only copy.
    tokenHash: hashCredentialSecret(token.secret),
  });

  console.log(`client created     | ${clientId}`);
  console.log(`credential created | ${credentialId}`);
  console.log('');
  console.log('Token, shown once and not recoverable:');
  console.log('');
  console.log(`  ${formatCredentialToken(token)}`);
  console.log('');
  console.log('Send it as: Authorization: Bearer <token>');
} finally {
  await closePool(pool);
}
