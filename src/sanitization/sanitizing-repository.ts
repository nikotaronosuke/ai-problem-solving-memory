/**
 * The boundary itself: a repository that cannot be written through unchecked.
 *
 * Where this sits is the whole design. A service does not build a repository —
 * it is handed one, by the request context, and that is the only way to get
 * one. So wrapping the repository at the moment it is handed out puts the
 * policy on the path of every write that exists, and every write that will
 * exist, without any service knowing it is there. An adapter written later gets
 * the same context by the same route and inherits the same boundary; there is
 * no second way in to forget about.
 *
 * The alternative was a `sanitize()` call at the top of each service, or in
 * each route handler. Both work until someone adds the fourteenth write and
 * does not know the convention, and neither would have covered a caller that
 * is not HTTP. A boundary that depends on being remembered is a boundary that
 * reports success while a path goes around it.
 *
 * It is a `Proxy` rather than a hand-written wrapper for the same reason. A
 * wrapper listing twelve write methods is a list that goes stale: add a
 * thirteenth to `MemoryRepository` and the wrapper still compiles, still
 * delegates, and silently stops covering it. Intercepting every call instead
 * means a new operation is covered the moment it exists, because nothing had to
 * be updated for it to be.
 *
 * The default is to sanitize. Reads are named below and pass their arguments
 * through untouched; anything not named is treated as a write. An operation
 * added and never classified is therefore checked, not skipped — the failure
 * mode of forgetting is a redundant inspection of an identifier, rather than an
 * unchecked write.
 *
 * What this deliberately does not do is decide anything. It finds the strings
 * and asks; the answering is the policy's, and in this phase the policy keeps
 * everything. See `policy.ts`.
 *
 * "The strings" means keys as well as values. A caller can put arbitrary text
 * in an object key — an Environment snapshot stores whatever JSON was sent —
 * so a boundary that inspected only values could be walked around by naming a
 * field after the secret.
 */

import { sanitizeValue } from './sanitize.js';
import type { SanitizationPolicy } from './policy.js';
import type { MemoryRepository } from '../repository/index.js';

/**
 * Operations that read and store nothing.
 *
 * Their arguments are identifiers used to find rows, not content on its way
 * into one, so there is nothing for a policy to rule on. Naming reads rather
 * than writes is what makes the default safe: this list being wrong by
 * omission causes extra work, not a gap.
 */
const READ_ONLY_OPERATIONS: ReadonlySet<string> = new Set([
  'getProject',
  'listProjects',
  'getEnvironment',
  'listEnvironments',
  'getProblem',
  'listProblems',
  'listEvents',
  'listVerifications',
  'listChangeLogs',
  'listUsageLogs',
  'listRelations',
  // A read with no arguments at all. Listed anyway rather than left to the
  // fail-closed default, because the default would call it a write, and an
  // operation classified as a write that never writes makes the classification
  // mean less each time it happens.
  'exportOwnerMemory',
]);

/** Whether an operation's arguments are inspected before it runs. */
export function isSanitizedOperation(operation: string): boolean {
  return !READ_ONLY_OPERATIONS.has(operation);
}

/**
 * Wraps a repository so every write is inspected before it reaches storage.
 *
 * Every argument of a write is walked, identifiers included. Excluding them
 * would mean this layer deciding which fields matter, and which fields matter
 * is precisely what P3-02 owns — the path is passed to the policy so it can
 * tell an identifier from a summary, which is the right place for that
 * knowledge to live.
 */
export function withSanitization(
  repository: MemoryRepository,
  policy: SanitizationPolicy,
): MemoryRepository {
  return new Proxy(repository, {
    get(target, property, receiver): unknown {
      const member: unknown = Reflect.get(target, property, receiver);

      // `ownerId` and anything else that is not a callable operation.
      if (typeof member !== 'function' || typeof property !== 'string') {
        return member;
      }

      const operation = member as (...args: unknown[]) => unknown;

      if (!isSanitizedOperation(property)) {
        return operation.bind(target);
      }

      // `async` so a refusal comes back as a rejected promise rather than a
      // synchronous throw. Every operation returns a promise, and a caller
      // that attached `.catch()` instead of awaiting would otherwise crash on
      // the one path built to be handled.
      return async (...args: unknown[]): Promise<unknown> => {
        // Rebuilt, never mutated in place, and completed for every argument
        // before the first one is delegated: a refusal partway through leaves
        // the caller's input untouched and no statement issued.
        const inspected = args.map((argument, index) =>
          sanitizeValue(argument, policy, [
            { kind: 'operation', name: property },
            { kind: 'argument', index },
          ]),
        );

        return await Reflect.apply(operation, target, inspected);
      };
    },
  });
}
