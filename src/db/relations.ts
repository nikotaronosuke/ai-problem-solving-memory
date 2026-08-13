/**
 * Database access for relations.
 *
 * Create and list only. There is no update path and no delete path, so there
 * is no `updated_at` and no version — how a mistaken link is corrected is not
 * decided in this phase.
 *
 * As elsewhere, every function takes an `OwnerContext`, the owner comes from
 * the context rather than caller input, and reads are scoped by `owner_id`.
 *
 * Nothing here is idempotent on a client-supplied key. Events and
 * Verifications have `client_event_id` because a retried append after an
 * ambiguous failure must not register twice; whether the same reasoning
 * applies to a link — and what "the same link" even means when the reason
 * differs — is a question this phase does not answer, so no key is invented
 * for it.
 */

import type { RelationType } from '../domain/enums.js';
import type { OwnerContext, OwnerId } from '../domain/owner.js';
import type { ProblemId } from '../domain/problem.js';
import { generateRelationId, toRelationReason, type RelationId } from '../domain/relation.js';
import { FOREIGN_KEY_VIOLATION, ProblemNotAvailableError, violatesConstraint } from './errors.js';
import type { DatabaseExecutor } from './executor.js';

const OWNER_FROM_FK = 'relations_owner_id_from_id_fkey';
const OWNER_TO_FK = 'relations_owner_id_to_id_fkey';

export interface RelationRecord {
  readonly relationId: RelationId;
  readonly ownerId: OwnerId;
  readonly fromId: ProblemId;
  readonly toId: ProblemId;
  readonly relationType: RelationType;
  readonly reason: string;
  readonly createdAt: Date;
}

/**
 * What a caller supplies to link two Problems.
 *
 * There is no owner field, and no relation id: both are the server's. `reason`
 * is required, so a link always arrives with an account of itself.
 */
export interface CreateRelationInput {
  readonly fromId: ProblemId;
  readonly toId: ProblemId;
  readonly relationType: RelationType;
  readonly reason: string;
}

interface RelationRow {
  relation_id: string;
  owner_id: string;
  from_id: string;
  to_id: string;
  relation_type: RelationType;
  reason: string;
  created_at: Date;
}

function toRecord(row: RelationRow): RelationRecord {
  // The id columns are `uuid`, so the values are already normalised UUIDs.
  return {
    relationId: row.relation_id as RelationId,
    ownerId: row.owner_id as OwnerId,
    fromId: row.from_id as ProblemId,
    toId: row.to_id as ProblemId,
    relationType: row.relation_type,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

const RELATION_COLUMNS = `relation_id, owner_id, from_id, to_id, relation_type, reason,
  created_at`;

/**
 * Links two of the context owner's problems.
 *
 * Both ends are checked as an (owner, problem) pair by the foreign keys, so
 * neither can point at another owner's Problem. Either failing raises the same
 * `ProblemNotAvailableError`, whether the Problem does not exist or is
 * someone else's — the caller has already established which end it was asking
 * about, and telling the two apart here would answer "is this id real?" for
 * anyone who tried.
 *
 * The two problems may belong to different projects. That is the point: a
 * problem solved in one project informing another is what makes this memory
 * worth keeping, and confining links to one project would rule it out.
 *
 * One row per link, whichever direction it was stated from. No mirror row is
 * written for the symmetric types.
 */
export async function createRelation(
  executor: DatabaseExecutor,
  context: OwnerContext,
  input: CreateRelationInput,
): Promise<RelationRecord> {
  const reason = toRelationReason(input.reason);
  const relationId = generateRelationId();

  let inserted;
  try {
    inserted = await executor.query<RelationRow>(
      `insert into public.relations
              (relation_id, owner_id, from_id, to_id, relation_type, reason)
            values ($1, $2, $3, $4, $5, $6)
         returning ${RELATION_COLUMNS}`,
      [relationId, context.ownerId, input.fromId, input.toId, input.relationType, reason],
    );
  } catch (error) {
    if (
      violatesConstraint(error, FOREIGN_KEY_VIOLATION, OWNER_FROM_FK) ||
      violatesConstraint(error, FOREIGN_KEY_VIOLATION, OWNER_TO_FK)
    ) {
      // One of the two ends is not this owner's. Which one is not
      // distinguished, by design.
      throw new ProblemNotAvailableError();
    }
    throw error;
  }

  const row = inserted.rows[0];
  if (row === undefined) {
    throw new Error('Relation insert returned no row.');
  }

  return toRecord(row);
}

/**
 * Lists the relations touching one of the context owner's problems, oldest
 * first.
 *
 * Both directions. A Problem that only ever appeared as the target of a link
 * still needs to see it — otherwise "what else does this relate to?" would
 * have a different answer depending on which end someone happened to record
 * the link from, which is not a difference the reader should have to know
 * about.
 *
 * Rows come back as stored. A link recorded as A supersedes B reads that way
 * from B's list too, rather than being flipped into something B supersedes:
 * reversing it would state the opposite of what was recorded.
 *
 * `relation_id` breaks ties so that two relations created in the same instant
 * still come back in a stable order rather than an arbitrary one.
 *
 * A problem that does not exist and one belonging to someone else both yield
 * an empty list, so the result cannot confirm an id exists.
 */
export async function listRelations(
  executor: DatabaseExecutor,
  context: OwnerContext,
  problemId: ProblemId,
): Promise<RelationRecord[]> {
  const result = await executor.query<RelationRow>(
    `select ${RELATION_COLUMNS}
       from public.relations
      where owner_id = $1 and (from_id = $2 or to_id = $2)
      order by created_at asc, relation_id asc`,
    [context.ownerId, problemId],
  );

  return result.rows.map(toRecord);
}
