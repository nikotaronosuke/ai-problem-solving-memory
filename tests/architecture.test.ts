/**
 * Layering rules, checked against the source itself.
 *
 * The dependency direction is
 *   domain ← service/API (Phase 2) ← repository ← db ← PostgreSQL
 * and the point of it is that the domain keeps working when the storage
 * underneath changes. That only stays true if nothing quietly reaches upward,
 * so it is checked rather than trusted.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src');

async function readModules(directory: string): Promise<{ path: string; source: string }[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.ts'));

  return Promise.all(
    files.map(async (entry) => {
      const path = join(entry.parentPath, entry.name);
      return {
        path: path.slice(SRC.length + 1).replace(/\\/g, '/'),
        source: await readFile(path, 'utf8'),
      };
    }),
  );
}

/** Module specifiers a file imports from, ignoring type-only or not. */
function importsOf(source: string): string[] {
  return [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1] ?? '');
}

describe('domain layer', () => {
  it('depends on no storage, driver or vendor', async () => {
    const modules = await readModules(join(SRC, 'domain'));
    expect(modules.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const module of modules) {
      for (const specifier of importsOf(module.source)) {
        const reachesStorage =
          specifier === 'pg' ||
          specifier.startsWith('pg/') ||
          specifier.startsWith('@supabase') ||
          specifier.includes('/db/') ||
          specifier.includes('/repository/');
        if (reachesStorage) {
          offenders.push(`${module.path} -> ${specifier}`);
        }
      }
    }

    // A domain rule that imported a driver would be a rule about PostgreSQL.
    expect(offenders).toEqual([]);
  });

  it('mentions no SQL', async () => {
    const modules = await readModules(join(SRC, 'domain'));

    const offenders = modules
      .filter((module) =>
        /\b(select|insert into|update\s+public\.|delete from)\b/i.test(module.source),
      )
      .map((module) => module.path);

    expect(offenders).toEqual([]);
  });
});

describe('repository layer', () => {
  it('writes no SQL of its own, leaving that to the database layer', async () => {
    const modules = await readModules(join(SRC, 'repository'));
    expect(modules.length).toBeGreaterThan(0);

    const offenders = modules
      .filter((module) =>
        /\b(select\s|insert\s+into|update\s+public\.|delete\s+from)\b/i.test(module.source),
      )
      .map((module) => module.path);

    expect(offenders).toEqual([]);
  });

  it('imports no database driver directly, only the executor type', async () => {
    const modules = await readModules(join(SRC, 'repository'));

    const offenders: string[] = [];
    for (const module of modules) {
      for (const specifier of importsOf(module.source)) {
        if (
          specifier === 'pg' ||
          specifier.startsWith('pg/') ||
          specifier.startsWith('@supabase')
        ) {
          offenders.push(`${module.path} -> ${specifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('exposes no pool or client type in its public surface', async () => {
    const index = await readFile(join(SRC, 'repository', 'index.ts'), 'utf8');

    // Only what is actually exported — prose explaining what is kept out does
    // not itself leak anything.
    const exported = index
      .split('\n')
      .filter((line) => line.trimStart().startsWith('export'))
      .join('\n');

    expect(exported).not.toContain('DatabasePool');
    expect(exported).not.toContain('PoolClient');
    expect(exported).toContain('DatabaseExecutor');
  });
});

describe('database layer', () => {
  it('is the only place that names the driver', async () => {
    const modules = await readModules(SRC);

    const driverUsers = modules
      .filter((module) => importsOf(module.source).some((specifier) => specifier === 'pg'))
      .map((module) => module.path)
      .sort();

    // Configuration shapes it, pool lifecycle creates it, and the executor
    // type describes the little of it anything else is allowed to need.
    expect(driverUsers).toEqual(['db/config.ts', 'db/executor.ts', 'db/pool.ts']);
  });
});
