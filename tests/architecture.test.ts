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

/**
 * Module specifiers a file imports from, however it spells them.
 *
 * Static imports in either quote style, and dynamic `import()`. A detector
 * that only understood one form would report a clean result for a violation
 * written in the other, which is worse than not checking.
 */
function importsOf(source: string): string[] {
  const staticImports = [...source.matchAll(/from\s+["']([^"']+)["']/g)];
  const dynamicImports = [...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)];
  const bareSideEffect = [...source.matchAll(/^\s*import\s+["']([^"']+)["']/gm)];

  return [...staticImports, ...dynamicImports, ...bareSideEffect].map((match) => match[1] ?? '');
}

/** Whether a specifier reaches the database driver or a vendor SDK. */
function isDriverOrVendor(specifier: string): boolean {
  return specifier === 'pg' || specifier.startsWith('pg/') || specifier.startsWith('@supabase');
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

  it('knows nothing about transport', async () => {
    const modules = await readModules(join(SRC, 'domain'));

    const offenders: string[] = [];
    for (const module of modules) {
      for (const specifier of importsOf(module.source)) {
        // A domain rule that imported Fastify would be a rule about requests.
        // The transition rule in particular has to stay answerable without
        // one: it decides what is allowed, not what status code says so.
        if (specifier === 'fastify' || specifier.startsWith('fastify/')) {
          offenders.push(`${module.path} -> ${specifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('is the only place that names a problem status', async () => {
    const modules = await readModules(SRC);

    const namers = modules
      .filter((module) =>
        /(^|[^A-Z_])'(INVESTIGATING|FIX_CANDIDATE|VERIFIED|PAUSED|CLOSED_UNRESOLVED)'/m.test(
          module.source,
        ),
      )
      .map((module) => module.path)
      .sort();

    // The value set and the transition rule. A service or route comparing
    // against a status literal would be deciding part of the matrix for
    // itself, and the two copies would drift.
    expect(namers).toEqual(['domain/enums.ts', 'domain/problem-status.ts']);
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

describe('transport layer', () => {
  it('depends on no driver, vendor or database module', async () => {
    const modules = await readModules(join(SRC, 'http'));
    expect(modules.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const module of modules) {
      for (const specifier of importsOf(module.source)) {
        // Transport talks to application services. Reaching past them would
        // make what a client learns a consequence of how the driver answers.
        if (isDriverOrVendor(specifier) || specifier.includes('/db/')) {
          offenders.push(`${module.path} -> ${specifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('writes no SQL', async () => {
    const modules = await readModules(join(SRC, 'http'));

    const offenders = modules
      .filter((module) =>
        /\b(select\s|insert\s+into|update\s+public\.|delete\s+from)\b/i.test(module.source),
      )
      .map((module) => module.path);

    expect(offenders).toEqual([]);
  });

  it('reaches storage only through the application layer', async () => {
    const modules = await readModules(join(SRC, 'http'));

    const internalTargets = new Set<string>();
    for (const module of modules) {
      for (const specifier of importsOf(module.source)) {
        if (specifier.startsWith('.')) {
          internalTargets.add(specifier.replace(/^\.+\//, '').replace(/\.js$/, ''));
        }
      }
    }

    // Whatever else it imports, the way out of transport is `app/`.
    expect([...internalTargets].some((target) => target.startsWith('app/'))).toBe(true);
    expect([...internalTargets].some((target) => target.startsWith('repository/'))).toBe(false);
  });

  it('does not name a database-layer error type', async () => {
    const modules = await readModules(join(SRC, 'http'));

    // Transport maps application errors by type. Recognising a storage error
    // here would make PostgreSQL part of the HTTP contract.
    const offenders = modules
      .filter((module) =>
        /\b(ProjectNotAvailableError|EnvironmentNotAvailableError|ProblemNotAvailableError|EmptyProjectUpdateError|EmptyProblemUpdateError)\b/.test(
          module.source,
        ),
      )
      .map((module) => module.path);

    expect(offenders).toEqual([]);
  });
});

describe('application layer', () => {
  it('imports no driver or vendor SDK directly', async () => {
    const modules = await readModules(join(SRC, 'app'));
    expect(modules.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const module of modules) {
      for (const specifier of importsOf(module.source)) {
        if (isDriverOrVendor(specifier)) {
          offenders.push(`${module.path} -> ${specifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('writes no SQL, leaving that to the database layer', async () => {
    const modules = await readModules(join(SRC, 'app'));

    const offenders = modules
      .filter((module) =>
        /\b(select\s|insert\s+into|update\s+public\.|delete\s+from)\b/i.test(module.source),
      )
      .map((module) => module.path);

    expect(offenders).toEqual([]);
  });

  it('does not name a database-layer error type', async () => {
    const modules = await readModules(join(SRC, 'app'));

    // The same rule transport follows. It matters most for the append paths:
    // idempotent append is the database layer's to implement, and a service
    // that recognised a storage failure would be deciding that behaviour from
    // above — the place that cannot see a concurrent writer.
    const offenders = modules
      .filter((module) =>
        /\b(ProjectNotAvailableError|EnvironmentNotAvailableError|ProblemNotAvailableError|EmptyProjectUpdateError|EmptyProblemUpdateError)\b/.test(
          module.source,
        ),
      )
      .map((module) => module.path);

    expect(offenders).toEqual([]);
  });

  it('reaches the database only through the repository', async () => {
    const modules = await readModules(join(SRC, 'app'));

    const offenders: string[] = [];
    for (const module of modules) {
      for (const specifier of importsOf(module.source)) {
        // Four exceptions, all of them boundary types or lifecycle rather
        // than data access. `db/health` and `db/pool` are what the health
        // probe needs, since it reports on the pool itself and no repository
        // operation covers that. `db/executor` and `db/transaction` are the
        // seams: a service names them to say "something that can run a
        // statement" and "something that can run several as one", and neither
        // gives it a way to reach a table or a driver type.
        const reachesStorage =
          specifier.includes('/db/') &&
          !specifier.includes('/db/health') &&
          !specifier.includes('/db/pool') &&
          !specifier.includes('/db/executor') &&
          !specifier.includes('/db/transaction');
        if (reachesStorage) {
          offenders.push(`${module.path} -> ${specifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe('import detector', () => {
  it('finds a specifier however it is written', () => {
    const sample = [
      "import a from 'single';",
      'import b from "double";',
      "const c = await import('dynamic-single');",
      'const d = await import("dynamic-double");',
      "import 'side-effect';",
    ].join('\n');

    // The detector is the thing every other test in this file relies on, so
    // its blind spots would be invisible failures elsewhere.
    expect(importsOf(sample).sort()).toEqual([
      'double',
      'dynamic-double',
      'dynamic-single',
      'side-effect',
      'single',
    ]);
  });
});

describe('sanitization boundary', () => {
  it('knows nothing about transport, the driver or SQL', async () => {
    const modules = await readModules(join(SRC, 'sanitization'));

    const offenders: string[] = [];
    for (const module of modules) {
      for (const specifier of importsOf(module.source)) {
        // It sits between the services and storage. Reaching either outward
        // to HTTP or downward to the driver would tie the one mandatory
        // checkpoint to a particular caller or a particular database.
        if (
          isDriverOrVendor(specifier) ||
          specifier === 'fastify' ||
          specifier.startsWith('fastify/') ||
          specifier.startsWith('@fastify/') ||
          specifier.includes('/http/') ||
          specifier.includes('/db/')
        ) {
          offenders.push(`${module.path} -> ${specifier}`);
        }
      }
      if (
        /\bselect\b.*\bfrom\b|\binsert into\b|\bupdate public\.|\bdelete from\b/i.test(
          module.source,
        )
      ) {
        offenders.push(`${module.path} contains SQL`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('is not reached into by the domain', async () => {
    const modules = await readModules(join(SRC, 'domain'));

    const offenders = modules
      .filter((module) => importsOf(module.source).some((s) => s.includes('/sanitization/')))
      .map((module) => module.path);

    // Whether a value is a secret is not a rule about problem solving. Mixing
    // privacy into the domain would make the rules answerable only with a
    // policy in hand.
    expect(offenders).toEqual([]);
  });

  it('detects secrets without reaching anything', async () => {
    const modules = (await readModules(join(SRC, 'sanitization'))).filter((module) =>
      module.path.startsWith('sanitization/secrets/'),
    );
    expect(modules.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const module of modules) {
      for (const specifier of importsOf(module.source)) {
        // Detection is a question about a string. Anything it could reach —
        // a repository, the driver, a route, a model — would make the answer
        // depend on something other than the string, and a refusal nobody can
        // reproduce is a refusal nobody can trust.
        const local = specifier.startsWith('.');
        const withinSanitization =
          local && !specifier.includes('/db/') && !specifier.includes('/repository/');
        if (!withinSanitization) {
          offenders.push(`${module.path} -> ${specifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('keeps knowledge of what a credential looks like inside one directory', async () => {
    const modules = await readModules(SRC);

    const users = modules
      .filter((module) =>
        /SecretDetector|SecretFinding|SecretCategory|createSecretDetector|SECRET_CATEGORIES/.test(
          module.source,
        ),
      )
      .map((module) => module.path)
      .sort();

    // What a credential looks like is a privacy rule, not a rule about problem
    // solving, and not something a route or a service should be able to ask.
    // It stays inside `sanitization/`: the application layer re-exports the
    // policy so the composition root can choose one, and never the detector,
    // so nothing outside here can name a category or read a finding.
    expect(users).toEqual([
      'sanitization/index.ts',
      'sanitization/secrets/detector.ts',
      'sanitization/secrets/finding.ts',
      'sanitization/secrets/index.ts',
      'sanitization/secrets/patterns.ts',
      'sanitization/secrets/policy.ts',
      'sanitization/secrets/redactor.ts',
    ]);
  });

  it('keeps credential offsets out of everything but the detector and redactor', async () => {
    const modules = await readModules(SRC);

    const users = modules
      .filter((module) =>
        /\bSpan\b|findJwtSpans|findAssignmentValues|replaceSpans/.test(module.source),
      )
      .map((module) => module.path)
      .sort();

    // A span is an offset and a length, which is information about a secret:
    // how long it is, and where it appeared. `SecretFinding` is two closed
    // identifiers precisely so nothing of that shape can travel into an error
    // or a log, and this is what keeps spans from leaking past the two files
    // that need them.
    expect(users).toEqual([
      'sanitization/secrets/detector.ts',
      'sanitization/secrets/patterns.ts',
      'sanitization/secrets/redactor.ts',
    ]);
  });

  it('is the only thing a repository is handed out through', async () => {
    const modules = await readModules(SRC);

    // Call sites, not the definition or the re-export.
    const callsIt = (source: string): boolean =>
      /(?<!function\s)\bcreateMemoryRepository\s*\(/.test(source);

    const builders = modules
      .filter((module) => callsIt(module.source))
      .map((module) => module.path)
      .sort();

    // A service never constructs a repository; it is given one. So there is
    // exactly one place where the boundary could be forgotten, and this is
    // the test that notices if a second appears.
    expect(builders).toEqual(['app/request-context.ts']);

    const context = modules.find((module) => module.path === 'app/request-context.ts');
    const constructions = context?.source.match(/createMemoryRepository\s*\(/g) ?? [];
    const wrapped = context?.source.match(/withSanitization\s*\(\s*createMemoryRepository/g) ?? [];

    // Both handouts — the ordinary repository and the transactional one —
    // must be wrapped. Wrapping one and not the other would leave exactly the
    // multi-write paths unchecked.
    expect(constructions.length).toBeGreaterThan(0);
    expect(wrapped).toHaveLength(constructions.length);
  });
});

describe('credential boundary', () => {
  it('keeps credential storage out of the Memory repository', async () => {
    const modules = await readModules(join(SRC, 'repository'));

    const offenders: string[] = [];
    for (const module of modules) {
      for (const specifier of importsOf(module.source)) {
        if (specifier.includes('/credentials/') || specifier.includes('/db/credentials')) {
          offenders.push(module.path + ' -> ' + specifier);
        }
      }
      if (/credential|token_hash|tokenHash/i.test(module.source)) {
        offenders.push(module.path + ' names credentials');
      }
    }

    // `MemoryRepository` is owner-scoped and sanitized. A credential lookup
    // runs before an owner exists and must not be sanitized at all, so the two
    // are different seams rather than one with a flag.
    expect(offenders).toEqual([]);
  });

  it('never sanitizes the credential store', async () => {
    const modules = await readModules(SRC);

    const wrapped = modules
      .filter((module) => /withSanitization\s*\(/.test(module.source))
      .map((module) => module.path)
      .sort();

    // Sanitization exists to keep credentials out of what a person writes
    // down. Pointing it at the credential store would have it inspecting a
    // digest for signs of a credential, and a policy could decide to redact
    // the one column that has to survive verbatim.
    expect(wrapped).toEqual(['app/request-context.ts', 'sanitization/sanitizing-repository.ts']);
  });

  it('reads the Authorization header in exactly one place', async () => {
    const modules = await readModules(SRC);

    const readers = modules
      .filter((module) => /headers\.authorization|headers\['authorization'\]/i.test(module.source))
      .map((module) => module.path)
      .sort();

    // The hook consumes it and hands on a context. A route or a service that
    // could reach the header could pass a credential somewhere, and the value
    // would start appearing in places nobody audited.
    expect(readers).toEqual(['http/app.ts']);
  });

  it('leaves no path from MEMORY_OWNER_ID to an HTTP request context', async () => {
    const source = await readFile(join(SRC, 'app', 'request-context.ts'), 'utf8');
    // Comments removed: the file explains at length that this fallback is
    // gone, and prose saying so must not read as the thing it describes.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // Knowing an owner's identifier is not the same as holding a credential
    // for it. A fallback here would make an identifier that lives in
    // configuration files into a password that cannot be revoked.
    expect(code).not.toContain('MEMORY_OWNER_ID');
    expect(code).not.toContain('readOwnerIdFromEnv');
    expect(code).not.toContain('resolveOwnerContext(');
    expect(code).not.toContain('EnvSource');
    expect(code).not.toContain('process.env');
  });

  it('builds an owner context only where existence is checked', async () => {
    const modules = await readModules(SRC);

    const asserters = modules
      .filter((module) => /as OwnerContext/.test(module.source))
      .map((module) => module.path)
      .sort();

    // `OwnerContext` means somebody asked the database. One file may assert
    // it, directly under the check that earns it; a cast anywhere else would
    // turn the type back into a value you can simply claim.
    expect(asserters).toEqual(['owner/context.ts']);
  });

  it('keeps credential code from writing Memory content', async () => {
    const modules = (await readModules(SRC)).filter((module) =>
      module.path.startsWith('credentials/'),
    );
    expect(modules.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const module of modules) {
      for (const specifier of importsOf(module.source)) {
        if (specifier.includes('/repository/') || specifier.includes('/http/')) {
          offenders.push(module.path + ' -> ' + specifier);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe('the delete path', () => {
  it('removes Memory rows from exactly one file', async () => {
    const modules = await readModules(SRC);

    const deleters = modules
      .filter((module) => /delete\s+from\s+public\./i.test(module.source))
      .map((module) => module.path)
      .sort();

    // One file. Revoking a credential is an update rather than a delete, so
    // this is the only place in the system that removes a row at all. What
    // must not appear is a second: the order rows have to go in is a fact
    // about the foreign key graph, and a second place that knows it is a
    // second place that can be wrong about it.
    expect(deleters).toEqual(['db/problem-deletion.ts']);
  });

  it('names the owner in every statement that removes something', async () => {
    const source = await readFile(join(SRC, 'db', 'problem-deletion.ts'), 'utf8');

    const statements = source.match(/delete\s+from\s+public\.[\s\S]*?`/gi) ?? [];
    expect(statements.length).toBe(6);

    // The foreign keys into `problems` are composite, so another owner's row
    // cannot reference this one and matching on the id alone would happen to
    // be safe today. It is still one edit away from not being, and there is no
    // reason to write it the other way.
    for (const statement of statements) {
      expect(statement).toContain('owner_id = $1');
    }
  });

  it('takes the row lock before removing anything', async () => {
    const source = await readFile(join(SRC, 'db', 'problem-deletion.ts'), 'utf8');

    const lockAt = source.indexOf('for update');
    const firstDeleteAt = source.search(/delete\s+from\s+public\./i);

    // Without the lock, an append can land between the read and the delete,
    // and which of the two wins is decided by timing rather than by anything
    // either caller can see.
    expect(lockAt).toBeGreaterThan(-1);
    expect(lockAt).toBeLessThan(firstDeleteAt);
  });

  it('keeps the delete away from credentials', async () => {
    const source = await readFile(join(SRC, 'db', 'problem-deletion.ts'), 'utf8');
    // Comments stripped: the file explains at length why credentials are not
    // its business, and prose saying so must not read as the thing it
    // describes.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // Clients and credentials belong to the owner, not to a Problem, and no
    // foreign key connects them. Deleting a Problem must not be able to lock
    // somebody out of their own memory.
    for (const forbidden of ['clients', 'client_credentials', 'owners', 'credential']) {
      expect(code).not.toContain(forbidden);
    }
  });

  it('leaves Projects and Environments alone', async () => {
    const source = await readFile(join(SRC, 'db', 'problem-deletion.ts'), 'utf8');

    const removed = [...source.matchAll(/delete\s+from\s+public\.(\w+)/gi)].map(
      (match) => match[1],
    );

    // Deliberate, not an omission. An Environment is a moment in time other
    // Problems may name, and a Project outlives the problems found in it.
    expect(removed).not.toContain('projects');
    expect(removed).not.toContain('environments');
    expect([...removed].sort()).toEqual([
      'change_logs',
      'events',
      'problems',
      'relations',
      'usage_logs',
      'verifications',
    ]);
  });

  it('deletes through the repository rather than around it', async () => {
    const modules = await readModules(SRC);

    const importers = modules
      .filter((module) =>
        importsOf(module.source).some((specifier) => specifier.includes('problem-deletion')),
      )
      .map((module) => module.path)
      .sort();

    // The facade and the barrel that re-exports its result type, and nothing
    // else. A service reaching the database function directly would be a
    // delete outside the sanitized, owner-scoped seam every other write goes
    // through.
    expect(importers).toEqual(['repository/index.ts', 'repository/memory-repository.ts']);
  });
});

describe('the export path', () => {
  it('reads Memory and nothing that grants access to it', async () => {
    // The statement that runs, not the source that builds it: the tables are
    // interpolated, so reading the file would check the generator's shape and
    // miss what it produced.
    const { MEMORY_EXPORT_STATEMENT } = await import('../src/db/memory-export.js');

    const tables = [...MEMORY_EXPORT_STATEMENT.matchAll(/from\s+public\.(\w+)/gi)].map(
      (match) => match[1],
    );

    // Exactly the eight Memory tables. Clients and credentials belong to the
    // owner rather than to their memory, and an artifact carrying one would
    // move access along with the data — a backup file that is also a key.
    expect([...new Set(tables)].sort()).toEqual([
      'change_logs',
      'environments',
      'events',
      'problems',
      'projects',
      'relations',
      'usage_logs',
      'verifications',
    ]);
  });

  it('never reaches the credential code', async () => {
    const modules = (await readModules(SRC)).filter(
      (module) => module.path === 'db/memory-export.ts' || module.path === 'app/export-service.ts',
    );
    expect(modules).toHaveLength(2);

    const offenders: string[] = [];
    for (const module of modules) {
      for (const specifier of importsOf(module.source)) {
        if (specifier.includes('/credentials/') || specifier.includes('/db/credentials')) {
          offenders.push(`${module.path} -> ${specifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('scopes every collection to the owner', async () => {
    const { MEMORY_EXPORT_STATEMENT } = await import('../src/db/memory-export.js');

    // Eight subqueries, one per collection, and each of them filtered. The
    // composite foreign keys make a cross-owner reference impossible in the
    // first place, so an unscoped subquery would still produce a correct
    // artifact for a single-owner database and a catastrophic one otherwise.
    const scoped = [...MEMORY_EXPORT_STATEMENT.matchAll(/where\s+\w+\.owner_id\s*=\s*\$1/gi)];
    const froms = [...MEMORY_EXPORT_STATEMENT.matchAll(/from\s+public\.\w+/gi)];

    expect(froms).toHaveLength(8);
    expect(scoped).toHaveLength(8);
  });

  it('builds the document in one statement, so it describes one moment', async () => {
    const source = await readFile(join(SRC, 'db', 'memory-export.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // One `select`, holding all eight collections as subqueries. Splitting it
    // into eight statements would give eight snapshots, and an artifact
    // assembled across them can describe a state that never existed.
    expect([...code.matchAll(/^\s*select json_build_object/gim)]).toHaveLength(1);

    // And no transaction machinery, because a single statement needs none.
    expect(code).not.toContain('begin');
    expect(code).not.toContain('isolation level');
    expect(code).not.toContain('for update');
    expect(code).not.toContain('for share');
  });

  it('keeps the timestamps and the JSON away from the driver', async () => {
    const source = await readFile(join(SRC, 'db', 'memory-export.ts'), 'utf8');

    // The document is fetched as text. Asking for `json` would have the driver
    // parse it, which rounds microseconds off every timestamp and precision
    // off any large number in a snapshot — the two things this module exists
    // to preserve.
    expect(source).toContain(')::text as artifact');
    expect(source).toContain('\'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\'');
  });

  it('sends the artifact without re-serialising it', async () => {
    const route = await readFile(join(SRC, 'http', 'export-routes.ts'), 'utf8');

    // `JSON.parse` followed by `JSON.stringify` is not a round trip for this
    // document, so the route overrides the schema-compiled serialiser and
    // passes the text through.
    expect(route).toContain('.serializer(');
    expect(route).not.toContain('JSON.parse');
    expect(route).not.toContain('JSON.stringify');
  });

  it('writes nothing', async () => {
    const source = await readFile(join(SRC, 'db', 'memory-export.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // Reading your own memory must not edit it — including when the export is
    // refused for holding a credential, where the temptation to redact it in
    // place is exactly the wrong instinct.
    for (const write of ['insert into', 'update public.', 'delete from']) {
      expect(code.toLowerCase()).not.toContain(write);
    }
  });
});

describe('contract generation', () => {
  it('is named in one transport module and nowhere else', async () => {
    const modules = await readModules(SRC);

    const users = modules
      .filter((module) =>
        importsOf(module.source).some(
          (specifier) => specifier === '@fastify/swagger' || specifier.startsWith('@fastify/'),
        ),
      )
      .map((module) => module.path)
      .sort();

    // Generation reads route schemas, so it belongs beside them and nowhere
    // deeper. A domain rule or a repository that imported an OpenAPI library
    // would mean the shape of a document had started influencing what the
    // system does, which is the inversion this task exists to prevent.
    expect(users).toEqual(['http/openapi.ts']);
  });

  it('leaves no OpenAPI vocabulary below the transport layer', async () => {
    const modules = await readModules(SRC);

    const offenders = modules
      .filter((module) => !module.path.startsWith('http/'))
      .filter((module) => /\bopenapi\b|\bswagger\b|operationId/i.test(module.source))
      .map((module) => module.path)
      .sort();

    expect(offenders).toEqual([]);
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
