/**
 * Database access for verifications.
 *
 * Append and list only. Verifications are append-only, so there is no update
 * and no application delete path.
 *
 * A Verification attaches to a Problem, not to an Event, so nothing here
 * depends on the event module. The two share only the errors both raise.
 *
 * Recording a successful Verification does not move the Problem to VERIFIED.
 * That transition is a domain decision, made in P2-06 after checking that a
 * successful Verification exists — not a side effect of a write.
 *
 * This is the minimum P1-10 needs. Duplicate replay is P2-05, and the general
 * repository layer is P1-12.
 */

import type { ClientEventId } from '../domain/client-event-id.js';
import type { VerificationType } from '../domain/enums.js';
import type { OwnerContext, OwnerId } from '../domain/owner.js';
import type { ProblemId } from '../domain/problem.js';
import { normaliseOptionalText } from '../domain/text.js';
import {
  generateVerificationId,
  toVerificationSummary,
  type VerificationId,
} from '../domain/verification.js';
import {
  DuplicateClientEventIdError,
  FOREIGN_KEY_VIOLATION,
  ProblemNotAvailableError,
  UNIQUE_VIOLATION,
  violatesConstraint,
} from './errors.js';
import type { DatabasePool } from './pool.js';

const OWNER_PROBLEM_FK = 'verifications_owner_id_problem_id_fkey';
const CLIENT_EVENT_ID_KEY = 'verifications_owner_id_client_event_id_key';

export interface VerificationRecord {
  readonly verificationId: VerificationId;
  readonly ownerId: OwnerId;
  readonly problemId: ProblemId;
  readonly verificationType: VerificationType;
  /** Whether the check confirmed the state. */
  readonly result: boolean;
  readonly summary: string;
  readonly evidenceRef: string | null;
  readonly verifiedBy: string | null;
  readonly clientEventId: ClientEventId;
  readonly createdAt: Date;
}

/**
 * What a caller supplies to record a verification.
 *
 * There is no owner field. `result` is required: a check that was carried out
 * has an outcome, and leaving it unstated would make the record unusable as
 * evidence.
 */
export interface AppendVerificationInput {
  readonly problemId: ProblemId;
  readonly verificationType: VerificationType;
  readonly result: boolean;
  readonly summary: string;
  readonly clientEventId: ClientEventId;
  readonly evidenceRef?: string | null;
  readonly verifiedBy?: string | null;
}

interface VerificationRow {
  verification_id: string;
  owner_id: string;
  problem_id: string;
  verification_type: VerificationType;
  result: boolean;
  summary: string;
  evidence_ref: string | null;
  verified_by: string | null;
  client_event_id: string;
  created_at: Date;
}

function toRecord(row: VerificationRow): VerificationRecord {
  // The id columns are `uuid`, so the values are already normalised UUIDs.
  return {
    verificationId: row.verification_id as VerificationId,
    ownerId: row.owner_id as OwnerId,
    problemId: row.problem_id as ProblemId,
    verificationType: row.verification_type,
    result: row.result,
    summary: row.summary,
    evidenceRef: row.evidence_ref,
    verifiedBy: row.verified_by,
    clientEventId: row.client_event_id as ClientEventId,
    createdAt: row.created_at,
  };
}

const VERIFICATION_COLUMNS = `verification_id, owner_id, problem_id, verification_type, result,
  summary, evidence_ref, verified_by, client_event_id, created_at`;

/**
 * Records a verification against one of the context owner's problems.
 *
 * Fails if this owner has already used the same `clientEventId` for a
 * verification. Events keep a separate namespace, so the same value may also
 * appear once there.
 */
export async function appendVerification(
  pool: DatabasePool,
  context: OwnerContext,
  input: AppendVerificationInput,
): Promise<VerificationRecord> {
  const summary = toVerificationSummary(input.summary);
  const evidenceRef = normaliseOptionalText(input.evidenceRef);
  const verifiedBy = normaliseOptionalText(input.verifiedBy);
  const verificationId = generateVerificationId();

  let inserted;
  try {
    inserted = await pool.query<VerificationRow>(
      `insert into public.verifications
              (verification_id, owner_id, problem_id, verification_type, result, summary,
               evidence_ref, verified_by, client_event_id)
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         returning ${VERIFICATION_COLUMNS}`,
      [
        verificationId,
        context.ownerId,
        input.problemId,
        input.verificationType,
        input.result,
        summary,
        evidenceRef,
        verifiedBy,
        input.clientEventId,
      ],
    );
  } catch (error) {
    if (violatesConstraint(error, FOREIGN_KEY_VIOLATION, OWNER_PROBLEM_FK)) {
      // The (owner, problem) pair does not exist. Whether the problem is
      // unknown or someone else's is not distinguished, by design.
      throw new ProblemNotAvailableError();
    }
    if (violatesConstraint(error, UNIQUE_VIOLATION, CLIENT_EVENT_ID_KEY)) {
      throw new DuplicateClientEventIdError();
    }
    throw error;
  }

  const row = inserted.rows[0];
  if (row === undefined) {
    throw new Error('Verification insert returned no row.');
  }

  return toRecord(row);
}

/**
 * Lists one of the context owner's problems' verifications, oldest first.
 *
 * `verification_id` breaks ties so that repeated reads agree even when two
 * verifications share a timestamp.
 *
 * A problem that does not exist and one belonging to someone else both yield
 * an empty list, so the result cannot confirm an id exists.
 */
export async function listVerifications(
  pool: DatabasePool,
  context: OwnerContext,
  problemId: ProblemId,
): Promise<VerificationRecord[]> {
  const result = await pool.query<VerificationRow>(
    `select ${VERIFICATION_COLUMNS}
       from public.verifications
      where owner_id = $1 and problem_id = $2
      order by created_at asc, verification_id asc`,
    [context.ownerId, problemId],
  );

  return result.rows.map(toRecord);
}
