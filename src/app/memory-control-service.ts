/**
 * The controls a person keeps over their own memory.
 *
 * Three independent axes, and they are independent on purpose:
 *
 * `memory_read_enabled` — whether this Problem should be drawn on when memory
 * is consulted automatically. `memory_write_enabled` — whether an assistant
 * should add to it on its own. `suppressed` — surface this less, without
 * saying anything about whether it is still true. And separately,
 * invalidating sets `freshness` to `INVALID`: the record no longer holds as
 * a basis for judgement.
 *
 * Collapsing these into one "disabled" state would lose the differences that
 * matter later. "Do not read this" and "this turned out to be wrong" are
 * different facts, and a retrieval layer will want to treat them differently —
 * surfacing an invalid memory as a warning, for instance, while a
 * read-disabled one is simply absent. So nothing here derives one from
 * another: turning off reads does not suppress, suppressing does not
 * invalidate, and invalidating does not disable anything.
 *
 * Two things these controls are not.
 *
 * They are not authorisation. Turning off reads does not hide the Problem from
 * its owner: every read endpoint keeps working, and the controls themselves
 * stay reachable, or a Problem could be locked away by accident with no way
 * back. What they govern is automatic use, which is a later phase.
 *
 * And they are not enforced yet. Nothing in this phase reads them, because
 * nothing retrieves memory automatically and nothing can tell a person's own
 * write from an assistant's. Recording the intent correctly now is what lets
 * the layer that can tell the difference honour it later.
 */

import { InvalidApplicationInputError, ResourceNotFoundError } from './errors.js';
import { applyProblemMutation } from './problem-mutation.js';
import type { AuthenticatedRequestContext } from './request-context.js';
import type { Freshness } from '../domain/enums.js';
import { toProblemId, type ProblemId } from '../domain/problem.js';
import type { ProblemRecord, UpdateProblemInput } from '../repository/index.js';

export interface MemoryControlCommand {
  readonly expectedVersion: number;
  readonly changedBy: string;
  readonly memoryReadEnabled?: boolean;
  readonly memoryWriteEnabled?: boolean;
  readonly suppressed?: boolean;
  /**
   * Marks the memory as no longer holding.
   *
   * Only `true` is accepted. There is no un-invalidate here because it could
   * not know what to restore: a Problem that became `INVALID` may have been
   * `CURRENT` before it, or `STALE_UNKNOWN`, or `SUPERSEDED`, and guessing
   * would overwrite a real distinction. Saying a memory holds again is an
   * explicit statement about which kind of freshness it has, made through the
   * ordinary update.
   */
  readonly invalidate?: true;
}

export interface MemoryControlService {
  updateControls(
    context: AuthenticatedRequestContext,
    problemId: string,
    command: MemoryControlCommand,
  ): Promise<ProblemRecord>;
}

/**
 * Converts a path identifier, treating a malformed one as absent.
 *
 * Transport validates the format first; this is the backstop for any other
 * caller.
 */
function asProblemId(value: string): ProblemId {
  try {
    return toProblemId(value);
  } catch {
    throw new ResourceNotFoundError();
  }
}

/**
 * What invalidating sets `freshness` to.
 *
 * Named and typed rather than written inline, so a typo fails to compile and
 * the one mapping this route makes is visible in one place.
 */
const INVALIDATED: Freshness = 'INVALID';

export function createMemoryControlService(): MemoryControlService {
  return {
    updateControls(context, problemId, command) {
      const target = asProblemId(problemId);

      // Only the controls actually named. Each maps to exactly one Problem
      // field and to nothing else — no control implies another.
      const patch: UpdateProblemInput = {
        ...(command.memoryReadEnabled !== undefined
          ? { memoryReadEnabled: command.memoryReadEnabled }
          : {}),
        ...(command.memoryWriteEnabled !== undefined
          ? { memoryWriteEnabled: command.memoryWriteEnabled }
          : {}),
        ...(command.suppressed !== undefined ? { suppressed: command.suppressed } : {}),
        // The one control whose name differs from the field it moves.
        ...(command.invalidate === true ? { freshness: INVALIDATED } : {}),
      };

      // The history names the Problem field that moved, not the control that
      // moved it: `invalidate` is a verb a caller used, `freshness` is what
      // changed, and a reader following the record needs the latter.
      const changedFields = [
        ...(command.memoryReadEnabled !== undefined ? ['memory_read_enabled'] : []),
        ...(command.memoryWriteEnabled !== undefined ? ['memory_write_enabled'] : []),
        ...(command.suppressed !== undefined ? ['suppressed'] : []),
        ...(command.invalidate === true ? ['freshness'] : []),
      ];

      if (Object.keys(patch).length === 0) {
        // Transport rejects this too. Repeated here because a request that
        // changes nothing would still move the version and `updated_at`; the
        // token and the signature are not controls.
        throw new InvalidApplicationInputError(
          'A memory control update must change at least one control.',
        );
      }

      // The same path as the ordinary update: same version column, same
      // compare-and-swap, same transaction, same history. A second lock or a
      // second write path would drift from this one.
      return applyProblemMutation(context, {
        problemId: target,
        expectedVersion: command.expectedVersion,
        changedBy: command.changedBy,
        patch,
        changedFields,
      });
    },
  };
}
