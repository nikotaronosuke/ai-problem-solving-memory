/**
 * A request context for tests that are not about authentication.
 *
 * Most of the HTTP suites exist to check a route's contract: what it accepts,
 * what it refuses, what it stores. Making every one of them issue a credential
 * and attach a header would add a step that none of them is testing, and would
 * bury the thing each file is actually about.
 *
 * So this stands in for the real service and hands back a context bound to an
 * owner the test already created. It is a test double, in `tests/`, and
 * production has no equivalent: `createRequestContextService` takes an
 * authenticator and has no path that reaches an owner without one. That
 * asymmetry is deliberate — the moment a bypass exists in `src/`, it is
 * reachable, and "only in development" is not a property anything enforces.
 *
 * The credential path itself is covered end to end by
 * `tests/credentials/authentication.integration.test.ts`, against a real
 * database, a real repository, a real authenticator and the real HTTP hook.
 */

import { createTransactionRunner } from '../../src/db/transaction.js';
import type { DatabaseExecutor } from '../../src/db/executor.js';
import { generateClientId } from '../../src/domain/client.js';
import type { OwnerId } from '../../src/domain/owner.js';
import { resolveOwnerContextFor } from '../../src/owner/context.js';
import { createMemoryRepository } from '../../src/repository/index.js';
import {
  createSecretDetectionPolicy,
  withSanitization,
  type SanitizationPolicy,
} from '../../src/sanitization/index.js';
import type { RequestContextService } from '../../src/app/index.js';

/**
 * Builds a context service that authenticates nothing.
 *
 * The repository it hands out is the real one, wrapped in the real
 * sanitization boundary with the real default policy — so everything below
 * authentication behaves exactly as it does in production, which is what the
 * suites using this are there to check.
 */
export function createFixedRequestContextService(
  executor: DatabaseExecutor,
  ownerId: OwnerId,
  policy: SanitizationPolicy = createSecretDetectionPolicy(),
): RequestContextService {
  const transactionRunner = createTransactionRunner(executor as never);
  const clientId = generateClientId();

  return {
    async authenticate() {
      const ownerContext = await resolveOwnerContextFor(executor, ownerId);

      return {
        clientId,
        repository: withSanitization(createMemoryRepository(executor, ownerContext), policy),
        runInTransaction: (work) =>
          transactionRunner.run((transactional) =>
            work(withSanitization(createMemoryRepository(transactional, ownerContext), policy)),
          ),
      };
    },
  };
}
