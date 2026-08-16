/**
 * Reading what disagrees with a handful of Memories, in one statement.
 *
 * One statement is not a performance preference here — it is what makes the
 * answer usable. The material this returns is meant to be *compared*: this
 * Memory's conditions against that one's, this evidence against that. Read
 * across several statements, the two halves of a comparison could come from
 * two different moments, and a difference the reader saw might be a difference
 * that never existed at any single instant. So the candidate, its
 * `CONTRADICTS` Relations, each counterpart Problem, each counterpart
 * Environment and each counterpart's Verifications are all taken from one
 * PostgreSQL snapshot.
 *
 * It also settles a race for free. Deleting a Problem removes its Relations
 * first and the Problem last, in one transaction — so within a single snapshot
 * a Relation whose counterpart has been deleted cannot be observed. The
 * inaccessible counterpart that *can* be observed is the one whose owner
 * switched automatic reading off, which is an update rather than a delete.
 *
 * The shape follows the two enrichment reads before it: identifiers become
 * rows through `unnest(...) with ordinality`, and everything is joined outwards
 * from them so that "this Memory is gone" and "nothing disagrees with it" stay
 * distinguishable. Owner and read control are re-applied at **both** ends —
 * the candidate and the counterpart are separate Problems and a link between
 * them is not permission to read either.
 *
 * Aggregation rather than a flat product. Candidate × Relation × Verification
 * is a triple product, and unpicking it in application code means trusting
 * repeated columns to agree. `json_agg` with an explicit `order by` keeps each
 * list ordered by the database that produced it, which is the same approach the
 * canonical-source read already takes.
 */

import type { Confidence, FixKind, Freshness, ProblemStatus } from '../domain/enums.js';
import type { EnvironmentSnapshot } from '../domain/environment.js';
import type { OwnerContext } from '../domain/owner.js';
import type { ProblemId } from '../domain/problem.js';
import type { ProjectId } from '../domain/project.js';
import {
  MissingConflictEnvironmentError,
  type ConflictMemorySnapshot,
  type ConflictSubject,
  type Contradiction,
} from '../domain/retrieval-conflict.js';
import type { VerificationEvidence } from '../domain/retrieval-revalidation.js';
import type { VerificationType } from '../domain/enums.js';
import type { DatabaseExecutor } from './executor.js';

/** What one candidate's row carries: its own semantics, and what disagrees. */
export interface ConflictRow {
  readonly subject: ConflictSubject;
  readonly contradictions: readonly Contradiction[];
}

interface RawEvidence {
  verification_type: VerificationType;
  result: boolean;
  summary: string;
  evidence_ref: string | null;
  created_at: string;
}

interface RawContradiction {
  reason: string;
  relation_created_at: string;
  other_problem_id: string;
  other_project_id: string;
  other_symptoms: string;
  other_problem_domain: string | null;
  other_suspected_boundary: string | null;
  other_status: ProblemStatus;
  other_fix_kind: FixKind | null;
  other_confidence: Confidence;
  other_freshness: Freshness;
  other_snapshot: EnvironmentSnapshot | null;
  other_evidence: RawEvidence[] | null;
}

interface Row {
  problem_id: string | null;
  symptoms: string | null;
  problem_domain: string | null;
  suspected_boundary: string | null;
  status: ProblemStatus | null;
  fix_kind: FixKind | null;
  contradictions: RawContradiction[] | null;
}

/**
 * The Verifications behind the other Memory, oldest first.
 *
 * Failures included, for the reason the revalidation read gives: a check that
 * did not confirm anything is still part of how strongly a conclusion was
 * established, and keeping only successes would make both sides of every
 * disagreement look equally well checked.
 */
const OTHER_EVIDENCE = `
        coalesce((
          select json_agg(json_build_object(
                   'verification_type', v.verification_type,
                   'result', v.result,
                   'summary', v.summary,
                   'evidence_ref', v.evidence_ref,
                   'created_at', v.created_at
                 ) order by v.created_at asc, v.verification_id asc)
            from public.verifications v
           where v.owner_id = op.owner_id
             and v.problem_id = op.problem_id
        ), '[]'::json)`;

/**
 * The disagreements recorded against one candidate.
 *
 * `CONTRADICTS` reads the same both ways and only one row is ever stored, so
 * a Relation touching this candidate is found from either end and the *other*
 * end is whichever one it is not. That is the whole of the symmetry handling:
 * `from` and `to` decide which Problem to look up and then stop mattering.
 *
 * The counterpart's join re-applies owner and read control. A Relation is a
 * link between two Problems, not a grant over the second one, and the owner
 * predicate sits in the join rather than a `where` so that an unreadable
 * counterpart drops its own item instead of collapsing the candidate's row.
 *
 * Ordered by when the link was recorded, with the identifier breaking ties:
 * two Relations written in one transaction share a timestamp to the
 * microsecond, and without it their order would be whatever the plan produced.
 */
const CONTRADICTIONS = `
      coalesce((
        select json_agg(json_build_object(
                 'reason', rel.reason,
                 'relation_created_at', rel.created_at,
                 'other_problem_id', op.problem_id,
                 'other_project_id', op.project_id,
                 'other_symptoms', op.symptoms,
                 'other_problem_domain', op.problem_domain,
                 'other_suspected_boundary', op.suspected_boundary,
                 'other_status', op.status,
                 'other_fix_kind', op.fix_kind,
                 'other_confidence', op.confidence,
                 'other_freshness', op.freshness,
                 'other_snapshot', oe.snapshot,
                 'other_evidence', ${OTHER_EVIDENCE}
               ) order by rel.created_at asc, rel.relation_id asc)
          from public.relations rel
          join public.problems op
            on op.owner_id = rel.owner_id
           and op.problem_id = case
                                 when rel.from_id = pr.problem_id then rel.to_id
                                 else rel.from_id
                               end
           and op.memory_read_enabled
          left join public.environments oe
            on oe.owner_id = op.owner_id
           and oe.environment_id = op.environment_id
         where rel.owner_id = pr.owner_id
           and rel.relation_type = 'CONTRADICTS'
           and (rel.from_id = pr.problem_id or rel.to_id = pr.problem_id)
      ), '[]'::json)`;

/**
 * One statement, owner-scoped, with the read control applied at both ends.
 *
 * The candidate's own semantic fields come back beside its disagreements
 * because a difference needs two sides and the search result does not already
 * carry this Memory's symptoms.
 */
export const CONFLICT_STATEMENT = `
  select pr.problem_id as problem_id,
         pr.symptoms as symptoms,
         pr.problem_domain as problem_domain,
         pr.suspected_boundary as suspected_boundary,
         pr.status as status,
         pr.fix_kind as fix_kind,
         ${CONTRADICTIONS} as contradictions
    from unnest($2::uuid[]) with ordinality as requested(problem_id, position)
    left join public.problems pr
      on pr.owner_id = $1
     and pr.problem_id = requested.problem_id
     and pr.memory_read_enabled
   order by requested.position asc`;

function toEvidence(raw: RawEvidence): VerificationEvidence {
  return {
    verificationType: raw.verification_type,
    result: raw.result,
    summary: raw.summary,
    evidenceRef: raw.evidence_ref,
    // `json_build_object` renders a timestamp as text, unlike a plain column.
    createdAt: new Date(raw.created_at),
  };
}

function toSnapshot(raw: RawContradiction): ConflictMemorySnapshot {
  if (raw.other_snapshot === null) {
    throw new MissingConflictEnvironmentError();
  }

  return {
    problemId: raw.other_problem_id as ProblemId,
    projectId: raw.other_project_id as ProjectId,
    symptoms: raw.other_symptoms,
    problemDomain: raw.other_problem_domain,
    suspectedBoundary: raw.other_suspected_boundary,
    status: raw.other_status,
    fixKind: raw.other_fix_kind,
    confidence: raw.other_confidence,
    freshness: raw.other_freshness,
    historicalEnvironment: raw.other_snapshot,
    evidence: (raw.other_evidence ?? []).map(toEvidence),
  };
}

/**
 * What disagrees with whichever of these Problems is still readable.
 *
 * A Problem present in the result has its own semantics and its list of
 * disagreements, which may be empty — nothing was recorded against it. One
 * absent from the result cannot be seen by this owner, and which of the four
 * reasons applies is deliberately not knowable from here.
 *
 * A read, and only a read.
 */
export async function readConflicts(
  executor: DatabaseExecutor,
  context: OwnerContext,
  problemIds: readonly ProblemId[],
): Promise<Map<ProblemId, ConflictRow>> {
  if (problemIds.length === 0) {
    // Nothing to ask about, and the answer could not change this empty map.
    return new Map();
  }

  const result = await executor.query<Row>(CONFLICT_STATEMENT, [context.ownerId, [...problemIds]]);

  const byProblem = new Map<ProblemId, ConflictRow>();

  for (const row of result.rows) {
    if (row.problem_id === null || row.symptoms === null || row.status === null) {
      // The left join reporting a Problem that is gone, was never this
      // owner's, or has automatic reading switched off. `symptoms` and
      // `status` are not null in storage, so their absence is the join rather
      // than a malformed row.
      continue;
    }

    byProblem.set(row.problem_id as ProblemId, {
      subject: {
        symptoms: row.symptoms,
        problemDomain: row.problem_domain,
        suspectedBoundary: row.suspected_boundary,
        status: row.status,
        fixKind: row.fix_kind,
      },
      contradictions: (row.contradictions ?? []).map((raw) => ({
        reason: raw.reason,
        relationCreatedAt: new Date(raw.relation_created_at),
        other: toSnapshot(raw),
      })),
    });
  }

  return byProblem;
}
