/**
 * Checks the application value sets against the real database.
 *
 * This is what keeps `src/domain/enums.ts` and the migration from drifting.
 * Every TypeScript value is cast to its DOMAIN, so adding a value in
 * TypeScript without the matching migration fails here. The reverse direction
 * is covered too, by reading the constraint back from PostgreSQL's own
 * catalog — not by parsing the migration file.
 *
 * Skipped when `DATABASE_URL` is not set.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readDatabaseUrl } from '../../src/config/env.js';
import { resolveDatabaseConfig } from '../../src/db/config.js';
import { ENUM_DOMAIN_BINDINGS, ENUM_DOMAIN_SCHEMA } from '../../src/db/enum-domains.js';
import { closePool, createPool, type DatabasePool } from '../../src/db/pool.js';

const databaseUrl = readDatabaseUrl();

/** Values no set may accept, whatever the set is. */
function invalidSamplesFor(values: readonly string[]): { label: string; value: string }[] {
  const first = values[0] ?? '';

  return [
    { label: 'empty string', value: '' },
    { label: 'blank string', value: '   ' },
    { label: 'lowercased', value: first.toLowerCase() },
    { label: 'mixed case', value: first.charAt(0) + first.slice(1).toLowerCase() },
    { label: 'leading space', value: ` ${first}` },
    { label: 'trailing space', value: `${first} ` },
    { label: 'unknown value', value: 'NOT_A_REAL_VALUE' },
  ];
}

/** Literals PostgreSQL reports in its own canonical rendering of the CHECK. */
function literalsFromConstraintDefinition(definition: string): string[] {
  return [...definition.matchAll(/'([^']*)'/g)].map((match) => match[1] ?? '');
}

describe.skipIf(databaseUrl === undefined)('domain enums in the database', () => {
  let pool: DatabasePool;

  beforeAll(() => {
    pool = createPool(resolveDatabaseConfig({ nodeEnv: 'test', connectionTimeoutMillis: 5_000 }));
  });

  afterAll(async () => {
    await closePool(pool);
  });

  it('defines every expected DOMAIN and no native enum type', async () => {
    const types = await pool.query<{ typname: string; typtype: string }>(
      `select t.typname, t.typtype
         from pg_type t
         join pg_namespace n on n.oid = t.typnamespace
        where n.nspname = $1 and t.typtype in ('d', 'e')`,
      [ENUM_DOMAIN_SCHEMA],
    );

    const domains = types.rows.filter((row) => row.typtype === 'd').map((row) => row.typname);
    const nativeEnums = types.rows.filter((row) => row.typtype === 'e').map((row) => row.typname);

    expect(nativeEnums).toEqual([]);
    expect(domains.sort()).toEqual(ENUM_DOMAIN_BINDINGS.map((b) => b.domainName).sort());
  });

  it('holds exactly the tables the migrations create, and no others', async () => {
    const result = await pool.query<{ table_name: string }>(
      'select table_name from information_schema.tables where table_schema = $1',
      [ENUM_DOMAIN_SCHEMA],
    );

    // The value sets are defined by their own migration and belong to no
    // table; these are the tables that use them. Listed exhaustively so a
    // table appearing by accident is visible — which is the check this
    // replaces, from when `relations` was the example of one that did not
    // exist yet.
    expect(result.rows.map((row) => row.table_name).sort()).toEqual([
      'change_logs',
      'environments',
      'events',
      'owners',
      'problems',
      'projects',
      'relations',
      'usage_logs',
      'verifications',
    ]);
  });

  describe.each(ENUM_DOMAIN_BINDINGS)('$domainName', (binding) => {
    // The identifier comes from our own constant, never from input, and
    // `enum-domains.test.ts` pins its shape.
    const castTo = `${ENUM_DOMAIN_SCHEMA}.${binding.domainName}`;

    it('accepts every value the application considers valid', async () => {
      for (const value of binding.values) {
        const result = await pool.query<{ value: string }>(`select $1::${castTo} as value`, [
          value,
        ]);

        expect(result.rows[0]?.value).toBe(value);
      }
    });

    it.each(invalidSamplesFor(binding.values))('rejects $label', async ({ value }) => {
      await expect(pool.query(`select $1::${castTo}`, [value])).rejects.toThrow(
        /violates check constraint/,
      );
    });

    it('allows null, because nullability belongs to the column', async () => {
      const result = await pool.query<{ value: string | null }>(`select $1::${castTo} as value`, [
        null,
      ]);

      expect(result.rows[0]?.value).toBeNull();
    });

    it('allows exactly the application values and no others', async () => {
      const result = await pool.query<{ definition: string }>(
        `select pg_get_constraintdef(c.oid) as definition
           from pg_constraint c
           join pg_type t on t.oid = c.contypid
           join pg_namespace n on n.oid = t.typnamespace
          where n.nspname = $1 and t.typname = $2 and c.conname = $3`,
        [ENUM_DOMAIN_SCHEMA, binding.domainName, binding.constraintName],
      );

      const definition = result.rows[0]?.definition;
      expect(definition).toBeDefined();

      const databaseValues = literalsFromConstraintDefinition(definition ?? '');
      expect(databaseValues.sort()).toEqual([...binding.values].sort());
    });
  });
});
