/**
 * Reading and writing clients and their credentials.
 *
 * Kept away from the Memory tables on purpose. A credential lookup happens
 * *before* an owner is known — it is what establishes one — so it cannot run
 * through an owner-scoped repository, and it must not run through the
 * sanitization boundary either: a SHA-256 digest is not Memory content, and a
 * secret detector let loose on one would be inspecting the wrong thing
 * entirely.
 *
 * Nothing here accepts or returns a raw token. What crosses this boundary is a
 * public lookup value, a digest, and identifiers.
 */

import type { DatabaseExecutor } from './executor.js';
import type { ClientId } from '../domain/client.js';
import type { CredentialId } from '../domain/credential.js';
import type { OwnerId } from '../domain/owner.js';

/**
 * A credential found by its public selector.
 *
 * Carries the digest so the caller can compare it, the client and owner it
 * speaks for, and when it was revoked if it was. It does not carry, and could
 * not reconstruct, the secret that was presented.
 */
export interface CredentialLookupRecord {
  readonly credentialId: CredentialId;
  readonly clientId: ClientId;
  readonly ownerId: OwnerId;
  readonly tokenHash: Buffer;
  readonly revokedAt: Date | null;
}

interface CredentialLookupRow {
  credential_id: string;
  client_id: string;
  owner_id: string;
  token_hash: Buffer;
  revoked_at: Date | null;
}

/**
 * Finds the credential a lookup value selects.
 *
 * One row at most: the lookup column is unique. Returning the row is not the
 * same as accepting it — revocation and the digest comparison are the caller's,
 * and both still have to pass.
 */
export async function findCredentialByLookup(
  executor: DatabaseExecutor,
  lookup: string,
): Promise<CredentialLookupRecord | undefined> {
  const result = await executor.query<CredentialLookupRow>(
    `select cc.credential_id, cc.token_hash, cc.revoked_at,
            c.client_id, c.owner_id
       from public.client_credentials cc
       join public.clients c on c.client_id = cc.client_id
      where cc.token_lookup = $1`,
    [lookup],
  );

  const row = result.rows[0];
  if (row === undefined) {
    return undefined;
  }

  return {
    credentialId: row.credential_id as CredentialId,
    clientId: row.client_id as ClientId,
    ownerId: row.owner_id as OwnerId,
    tokenHash: row.token_hash,
    revokedAt: row.revoked_at,
  };
}

export interface InsertClientInput {
  readonly clientId: ClientId;
  readonly ownerId: OwnerId;
  readonly label: string;
}

export async function insertClient(
  executor: DatabaseExecutor,
  input: InsertClientInput,
): Promise<void> {
  await executor.query(
    `insert into public.clients (client_id, owner_id, label)
          values ($1, $2, $3)`,
    [input.clientId, input.ownerId, input.label],
  );
}

export interface InsertCredentialInput {
  readonly credentialId: CredentialId;
  readonly clientId: ClientId;
  readonly tokenLookup: string;
  readonly tokenHash: Buffer;
}

export async function insertCredential(
  executor: DatabaseExecutor,
  input: InsertCredentialInput,
): Promise<void> {
  await executor.query(
    `insert into public.client_credentials (credential_id, client_id, token_lookup, token_hash)
          values ($1, $2, $3, $4)`,
    [input.credentialId, input.clientId, input.tokenLookup, input.tokenHash],
  );
}

/**
 * Marks one of this owner's credentials revoked.
 *
 * Scoped through the client's owner in the statement itself, so a credential
 * id belonging to somebody else matches nothing rather than being checked
 * afterwards. Already-revoked rows are left alone: the first revocation is the
 * one that happened, and moving the timestamp would rewrite when it did.
 *
 * Returns whether a row moved, which is all the caller needs to report.
 */
export async function revokeCredential(
  executor: DatabaseExecutor,
  ownerId: OwnerId,
  credentialId: CredentialId,
): Promise<boolean> {
  const result = await executor.query(
    `update public.client_credentials cc
        set revoked_at = now()
       from public.clients c
      where c.client_id = cc.client_id
        and c.owner_id = $1
        and cc.credential_id = $2
        and cc.revoked_at is null`,
    [ownerId, credentialId],
  );

  return (result.rowCount ?? 0) > 0;
}
