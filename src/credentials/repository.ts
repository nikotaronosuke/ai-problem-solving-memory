/**
 * The storage seam for credentials, separate from the one for Memory.
 *
 * `MemoryRepository` is owner-scoped: it is handed out once ownership is
 * settled, and every write through it passes the sanitization boundary. A
 * credential cannot live there for two reasons that are both structural rather
 * than stylistic.
 *
 * It runs too early. Looking a credential up is what *decides* the owner, so
 * there is no owner-scoped anything to run it through yet.
 *
 * And it is not Memory content. Sanitization exists to keep credentials out of
 * what a person writes down; pointing it at the credential store would have it
 * inspecting a SHA-256 digest for signs of a credential, which is at best
 * wasted work and at worst a policy deciding to redact the one column that has
 * to survive verbatim.
 *
 * So this is its own interface, with its own tests, and an architecture test
 * pins that the two never merge.
 */

import {
  findCredentialByLookup,
  insertClient,
  insertCredential,
  revokeCredential,
  type CredentialLookupRecord,
} from '../db/credentials.js';
import type { DatabaseExecutor } from '../db/executor.js';
import type { ClientId } from '../domain/client.js';
import type { CredentialId } from '../domain/credential.js';
import type { OwnerId } from '../domain/owner.js';

export type { CredentialLookupRecord };

export interface IssueClientCredentialInput {
  readonly clientId: ClientId;
  readonly ownerId: OwnerId;
  readonly label: string;
  readonly credentialId: CredentialId;
  readonly tokenLookup: string;
  readonly tokenHash: Buffer;
}

export interface IssueCredentialForClientInput {
  readonly clientId: ClientId;
  readonly credentialId: CredentialId;
  readonly tokenLookup: string;
  readonly tokenHash: Buffer;
}

export interface CredentialRepository {
  /**
   * Finds the credential a public selector names, if there is one.
   *
   * Never decides anything. Revocation and the digest comparison happen above
   * this, so no caller can accidentally treat "a row exists" as "the presented
   * credential is valid".
   */
  findByLookup(lookup: string): Promise<CredentialLookupRecord | undefined>;

  /** Creates a client and its first credential together. */
  issueClientCredential(input: IssueClientCredentialInput): Promise<void>;

  /** Adds a credential to a client that already exists, for rotation. */
  issueCredentialForClient(input: IssueCredentialForClientInput): Promise<void>;

  /** Revokes one of this owner's credentials. Answers whether one moved. */
  revoke(ownerId: OwnerId, credentialId: CredentialId): Promise<boolean>;
}

/**
 * Builds the credential repository.
 *
 * Not owner-scoped, unlike `MemoryRepository`, and that difference is the
 * point: `findByLookup` runs before any owner exists to scope to. The write
 * paths take an owner explicitly, and `revoke` scopes in its statement.
 */
export function createCredentialRepository(executor: DatabaseExecutor): CredentialRepository {
  return {
    findByLookup: (lookup) => findCredentialByLookup(executor, lookup),

    async issueClientCredential(input) {
      await insertClient(executor, {
        clientId: input.clientId,
        ownerId: input.ownerId,
        label: input.label,
      });
      await insertCredential(executor, {
        credentialId: input.credentialId,
        clientId: input.clientId,
        tokenLookup: input.tokenLookup,
        tokenHash: input.tokenHash,
      });
    },

    issueCredentialForClient: (input) => insertCredential(executor, input),

    revoke: (ownerId, credentialId) => revokeCredential(executor, ownerId, credentialId),
  };
}
