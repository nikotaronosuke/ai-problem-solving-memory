/**
 * The transition rule, on its own.
 *
 * No database, no HTTP, no repository — this is the rule as a function, which
 * is the point of putting it in the domain. Every pair of statuses is checked,
 * both directions, so the matrix is verified rather than sampled: a move
 * quietly added or removed shows up here.
 */

import { describe, expect, it } from 'vitest';

import { PROBLEM_STATUSES, type ProblemStatus } from '../../src/domain/enums.js';
import {
  allowedTransitionsFrom,
  decideTransition,
  isTerminalProblemStatus,
  TERMINAL_PROBLEM_STATUSES,
} from '../../src/domain/problem-status.js';

/**
 * The matrix, written out again independently of the implementation.
 *
 * Deliberately a separate list rather than an import: a test that asked the
 * module what it allows and then checked that it allows it would pass for any
 * matrix at all.
 */
const ALLOWED: readonly (readonly [ProblemStatus, ProblemStatus])[] = [
  ['INVESTIGATING', 'FIX_CANDIDATE'],
  ['INVESTIGATING', 'PAUSED'],
  ['INVESTIGATING', 'CLOSED_UNRESOLVED'],
  ['FIX_CANDIDATE', 'INVESTIGATING'],
  ['FIX_CANDIDATE', 'VERIFIED'],
  ['FIX_CANDIDATE', 'PAUSED'],
  ['FIX_CANDIDATE', 'CLOSED_UNRESOLVED'],
  ['PAUSED', 'INVESTIGATING'],
  ['PAUSED', 'FIX_CANDIDATE'],
  ['PAUSED', 'CLOSED_UNRESOLVED'],
];

function isAllowed(from: ProblemStatus, to: ProblemStatus): boolean {
  return ALLOWED.some(([f, t]) => f === from && t === to);
}

/** Every ordered pair of statuses, including a status with itself. */
const ALL_PAIRS = PROBLEM_STATUSES.flatMap((from) =>
  PROBLEM_STATUSES.map((to) => [from, to] as const),
);

describe('the transition matrix', () => {
  it.each(ALLOWED)('allows %s → %s', (from, to) => {
    // Evidence is supplied so that the only rule under test is the matrix.
    const decision = decideTransition({
      currentStatus: from,
      targetStatus: to,
      hasSuccessfulVerification: true,
    });

    expect(decision.allowed).toBe(true);
  });

  it.each(ALL_PAIRS)('decides %s → %s the same way as the stated matrix', (from, to) => {
    const decision = decideTransition({
      currentStatus: from,
      targetStatus: to,
      hasSuccessfulVerification: true,
    });

    expect(decision.allowed).toBe(isAllowed(from, to));
  });

  it('refuses every move a status makes to itself', () => {
    for (const status of PROBLEM_STATUSES) {
      const decision = decideTransition({
        currentStatus: status,
        targetStatus: status,
        hasSuccessfulVerification: true,
      });

      // Not a harmless no-op: it would move `updated_at` and record a change
      // that never happened.
      expect(decision).toMatchObject({ allowed: false, refusal: 'SAME_STATUS' });
    }
  });

  it('covers exactly the pairs the matrix names', () => {
    const decided = ALL_PAIRS.filter(
      ([from, to]) =>
        decideTransition({
          currentStatus: from,
          targetStatus: to,
          hasSuccessfulVerification: true,
        }).allowed,
    );

    // Twenty-five pairs, ten of them legal. Catches an addition as well as a
    // removal.
    expect(ALL_PAIRS).toHaveLength(25);
    expect(decided).toHaveLength(ALLOWED.length);
    expect(new Set(decided.map((pair) => pair.join('→')))).toEqual(
      new Set(ALLOWED.map((pair) => pair.join('→'))),
    );
  });
});

describe('resuming paused work', () => {
  it.each(['INVESTIGATING', 'FIX_CANDIDATE'] as const)(
    'lets a paused problem resume as %s',
    (target) => {
      const decision = decideTransition({
        currentStatus: 'PAUSED',
        targetStatus: target,
        hasSuccessfulVerification: false,
      });

      // Setting work aside and coming back to it is the ordinary case, so
      // PAUSED leads back to both working statuses.
      expect(decision.allowed).toBe(true);
    },
  );

  it('is not a terminal status', () => {
    expect(isTerminalProblemStatus('PAUSED')).toBe(false);
    expect(allowedTransitionsFrom('PAUSED').length).toBeGreaterThan(0);
  });

  it('cannot be verified without passing through a candidate fix', () => {
    const decision = decideTransition({
      currentStatus: 'PAUSED',
      targetStatus: 'VERIFIED',
      hasSuccessfulVerification: true,
    });

    expect(decision).toMatchObject({ allowed: false, refusal: 'NOT_ALLOWED' });
  });
});

describe('terminal statuses', () => {
  it.each(TERMINAL_PROBLEM_STATUSES)('nothing leads out of %s', (status) => {
    expect(isTerminalProblemStatus(status)).toBe(true);
    expect(allowedTransitionsFrom(status)).toEqual([]);

    for (const target of PROBLEM_STATUSES.filter((candidate) => candidate !== status)) {
      const decision = decideTransition({
        currentStatus: status,
        targetStatus: target,
        hasSuccessfulVerification: true,
      });

      // Reopening a resolved or abandoned problem raises real questions —
      // does the old evidence still hold, is it even the same problem — and
      // guessing at them here would settle them by accident.
      expect(decision).toMatchObject({ allowed: false, refusal: 'TERMINAL_STATUS' });
    }
  });

  it('names exactly the statuses with no way out', () => {
    expect([...TERMINAL_PROBLEM_STATUSES].sort()).toEqual(
      PROBLEM_STATUSES.filter(isTerminalProblemStatus).toSorted(),
    );
  });
});

describe('verifying a problem', () => {
  it('needs a successful verification', () => {
    const decision = decideTransition({
      currentStatus: 'FIX_CANDIDATE',
      targetStatus: 'VERIFIED',
      hasSuccessfulVerification: false,
    });

    expect(decision).toMatchObject({ allowed: false, refusal: 'VERIFICATION_REQUIRED' });
  });

  it('is allowed once one exists', () => {
    const decision = decideTransition({
      currentStatus: 'FIX_CANDIDATE',
      targetStatus: 'VERIFIED',
      hasSuccessfulVerification: true,
    });

    expect(decision.allowed).toBe(true);
  });

  it('is reachable only from a candidate fix', () => {
    const sources = PROBLEM_STATUSES.filter(
      (from) =>
        decideTransition({
          currentStatus: from,
          targetStatus: 'VERIFIED',
          hasSuccessfulVerification: true,
        }).allowed,
    );

    // "We think this is the fix" and "we checked, and it holds" are two
    // steps, and collapsing them loses the first.
    expect(sources).toEqual(['FIX_CANDIDATE']);
  });

  it.each(['INVESTIGATING', 'PAUSED'] as const)(
    'refuses %s → VERIFIED for the route, not the evidence',
    (from) => {
      const decision = decideTransition({
        currentStatus: from,
        targetStatus: 'VERIFIED',
        hasSuccessfulVerification: true,
      });

      // Evidence is present, so this must be refused as a disallowed move
      // rather than a missing verification.
      expect(decision).toMatchObject({ allowed: false, refusal: 'NOT_ALLOWED' });
    },
  );

  it('does not let evidence unlock any other move', () => {
    const withEvidence = ALL_PAIRS.filter(
      ([from, to]) =>
        decideTransition({
          currentStatus: from,
          targetStatus: to,
          hasSuccessfulVerification: true,
        }).allowed,
    );
    const withoutEvidence = ALL_PAIRS.filter(
      ([from, to]) =>
        decideTransition({
          currentStatus: from,
          targetStatus: to,
          hasSuccessfulVerification: false,
        }).allowed,
    );

    // A successful verification is a precondition for exactly one move, and
    // otherwise changes nothing.
    expect(withEvidence.length - withoutEvidence.length).toBe(1);
    expect(
      withEvidence.filter(
        ([from, to]) => !withoutEvidence.some(([f, t]) => f === from && t === to),
      ),
    ).toEqual([['FIX_CANDIDATE', 'VERIFIED']]);
  });
});

describe('refusal reasons', () => {
  it('explains itself without naming the caller’s input back', () => {
    const decision = decideTransition({
      currentStatus: 'VERIFIED',
      targetStatus: 'INVESTIGATING',
      hasSuccessfulVerification: true,
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason.length).toBeGreaterThan(0);
    }
  });

  it('reports the missing verification rather than the disallowed move', () => {
    const decision = decideTransition({
      currentStatus: 'FIX_CANDIDATE',
      targetStatus: 'VERIFIED',
      hasSuccessfulVerification: false,
    });

    // The move itself is legal; what is missing is the evidence. Saying "not
    // allowed" would send someone looking for the wrong problem.
    expect(decision).toMatchObject({ refusal: 'VERIFICATION_REQUIRED' });
  });
});
