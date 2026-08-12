import { describe, expect, it } from 'vitest';

import type { DatabasePool } from '../../src/db/pool.js';
import {
  MEMORY_OWNER_ID_VAR,
  OwnerContextError,
  readOwnerIdFromEnv,
  resolveOwnerContext,
} from '../../src/owner/context.js';

/** Synthetic UUID. Never a real owner id from anyone's environment. */
const VALID_UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

/**
 * A pool that fails if it is used. Missing and malformed values must be
 * rejected before anything reaches the database.
 */
function unusedPool(): DatabasePool {
  return {
    query: () => {
      throw new Error('the database should not be reached');
    },
  } as unknown as DatabasePool;
}

describe('readOwnerIdFromEnv', () => {
  it('returns undefined when unset or blank', () => {
    expect(readOwnerIdFromEnv({})).toBeUndefined();
    expect(readOwnerIdFromEnv({ [MEMORY_OWNER_ID_VAR]: '' })).toBeUndefined();
    expect(readOwnerIdFromEnv({ [MEMORY_OWNER_ID_VAR]: '   ' })).toBeUndefined();
  });

  it('returns the trimmed value when set', () => {
    expect(readOwnerIdFromEnv({ [MEMORY_OWNER_ID_VAR]: ` ${VALID_UUID} ` })).toBe(VALID_UUID);
  });
});

describe('resolveOwnerContext', () => {
  it('fails closed when the owner is not configured', async () => {
    await expect(resolveOwnerContext(unusedPool(), {})).rejects.toThrow(OwnerContextError);

    await expect(resolveOwnerContext(unusedPool(), {})).rejects.toMatchObject({
      reason: 'MISSING',
    });
  });

  it('treats a blank value as missing rather than malformed', async () => {
    await expect(
      resolveOwnerContext(unusedPool(), { [MEMORY_OWNER_ID_VAR]: '   ' }),
    ).rejects.toMatchObject({ reason: 'MISSING' });
  });

  it('fails closed when the owner is malformed', async () => {
    await expect(
      resolveOwnerContext(unusedPool(), { [MEMORY_OWNER_ID_VAR]: 'owner-1' }),
    ).rejects.toMatchObject({ reason: 'INVALID' });
  });

  it('rejects a provider-style identity, which is not an owner id', async () => {
    await expect(
      resolveOwnerContext(unusedPool(), { [MEMORY_OWNER_ID_VAR]: 'github|1234567' }),
    ).rejects.toMatchObject({ reason: 'INVALID' });
  });

  it('does not echo a malformed value, which may not be safe to print', async () => {
    const looksLikeASecret = 'sk-live-not-a-real-token-2f8c';

    try {
      await resolveOwnerContext(unusedPool(), { [MEMORY_OWNER_ID_VAR]: looksLikeASecret });
      expect.unreachable('should have thrown');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(looksLikeASecret);
    }
  });
});
