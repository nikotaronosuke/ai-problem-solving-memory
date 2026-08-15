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
    //
    // Two modules call it, and both wrap Memory-content repositories: the
    // request context wraps the Memory repository and the retrieval artifacts,
    // and the artifact generation service wraps the artifact repository it
    // builds over its gate's transactional executor. The credential store is
    // wrapped by neither. (The definition itself no longer matches this
    // pattern — the function became generic when a second kind of repository
    // needed it — which leaves the list saying exactly what it means: the
    // call sites.)
    expect(wrapped).toEqual([
      'app/request-context.ts',
      'app/retrieval-artifact-generation-service.ts',
    ]);
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
    // Seven since P4-01: the retrieval artifact goes with everything else the
    // Problem owned, and being derived is not a reason to leave it behind.
    expect(statements.length).toBe(7);

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
      'retrieval_artifacts',
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

describe('the retry queue is not part of the server', () => {
  it('is imported by nothing the server runs', async () => {
    const modules = (await readModules(SRC)).filter(
      (module) => !module.path.startsWith('reliability/'),
    );

    const importers = modules
      .filter((module) =>
        importsOf(module.source).some((specifier) => specifier.includes('reliability')),
      )
      .map((module) => module.path);

    // The queue holds writes the server could not accept, and the most
    // ordinary reason for that is the server not running. Something the server
    // starts cannot be the thing that keeps working when it stops, so nothing
    // under `http`, `app`, `db` or the entry point may reach it. It ships from
    // this repository for adapters to use, not for the server to run.
    expect(importers).toEqual([]);
  });

  it('reaches neither the database nor the credential store', async () => {
    const modules = await readModules(join(SRC, 'reliability'));
    expect(modules.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const module of modules) {
      for (const specifier of importsOf(module.source)) {
        if (
          specifier === 'pg' ||
          specifier.startsWith('pg/') ||
          specifier.includes('/db/') ||
          specifier.includes('/credentials/') ||
          specifier.includes('/repository/')
        ) {
          offenders.push(`${module.path} -> ${specifier}`);
        }
      }
    }

    // It runs where the database is unreachable by assumption, and it must
    // never hold a credential — so it has no reason to name either.
    expect(offenders).toEqual([]);
  });

  it('ships no HTTP client of its own', async () => {
    const modules = await readModules(join(SRC, 'reliability'));

    const offenders = modules
      .filter((module) =>
        /\bfetch\s*\(|node:http|node:https|undici|axios/.test(
          module.source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''),
        ),
      )
      .map((module) => module.path);

    // Delivery is an interface. Choosing a transport, a timeout and a
    // credential source on behalf of adapters that do not exist yet is how a
    // library acquires behaviour nobody picked.
    expect(offenders).toEqual([]);
  });

  it('has no clock, timer or scheduler', async () => {
    const modules = await readModules(join(SRC, 'reliability'));

    const offenders = modules
      .filter((module) =>
        /Date\.now|new Date\(\)|setTimeout|setInterval|setImmediate/.test(
          module.source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''),
        ),
      )
      .map((module) => module.path);

    // The caller supplies the moment and decides when to drain. A background
    // loop here would keep running in a process with nothing to do, and would
    // need a clock and a scheduler to test around.
    expect(offenders).toEqual([]);
  });

  it('queues exactly the two writes the server deduplicates', async () => {
    const { QUEUEABLE_OPERATIONS } = await import('../src/reliability/index.js');

    // Events and Verifications carry `client_event_id` and the database keeps
    // the first write, so resending one is safe by construction. Nothing else
    // has that property: creating a Problem twice makes two Problems, an
    // update carries a version a retry has already left behind, and deleting
    // must never appear on this list at all.
    expect([...QUEUEABLE_OPERATIONS]).toEqual(['appendEvent', 'appendVerification']);
  });

  it('writes down a closed set of fields, with nothing that authenticates', async () => {
    const source = await readFile(join(SRC, 'reliability', 'item.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    const stored = /interface StoredItem \{([\s\S]*?)\n\}/.exec(code)?.[1] ?? '';
    const fields = [...stored.matchAll(/^\s*(\w+)[?]?:/gm)].map((match) => match[1]).sort();

    // The on-disk shape, asserted whole rather than by spot-checking the
    // fields somebody remembered. A queue file outlives the process and gets
    // copied by whatever backs up a home directory.
    expect(fields).toEqual([
      'attempt_count',
      'client_event_id',
      'enqueued_at',
      'next_attempt_at',
      'operation',
      'owner_id',
      'payload',
      'problem_id',
      'problem_important',
      'queue_item_id',
      'schema_version',
      'terminal_failure',
    ]);
    for (const forbidden of [
      'token',
      'credential',
      'authorization',
      'header',
      'stack',
      'message',
    ]) {
      expect(stored.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('generates the idempotency key in one place, and never on a retry', async () => {
    const modules = await readModules(join(SRC, 'reliability'));

    const generators = modules
      .filter((module) => /generateClientEventId/.test(module.source))
      .map((module) => module.path);

    // One caller, and it is the coordinator, which assigns the key once before
    // the write is made durable. The queue must never generate one: a fresh key
    // on a retry turns one Event into one row per attempt, which is precisely
    // the duplicate the key exists to prevent, produced by the mechanism meant
    // to prevent it.
    expect(generators).toEqual(['reliability/coordinator.ts']);
  });

  it('makes the write durable before it attempts to send it', async () => {
    const source = await readFile(join(SRC, 'reliability', 'coordinator.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    const enqueueAt = code.indexOf('queue.enqueue');
    const attemptAt = code.indexOf('queue.attempt');

    // Order matters and is the task's whole decision. Attempting first leaves a
    // window where a failure and the process ending together lose the write
    // with no trace anywhere.
    expect(enqueueAt).toBeGreaterThan(-1);
    expect(attemptAt).toBeGreaterThan(enqueueAt);

    // And no way around it: a fallback that sent directly when the queue
    // refused the write would reintroduce that window at the moment the system
    // is least able to track what happened.
    expect(code).not.toContain('catch');
    expect(code).not.toContain('drain');
  });

  it('decides whether an item may be attempted in one place', async () => {
    const source = await readFile(join(SRC, 'reliability', 'queue.ts'), 'utf8');

    // Two stages, both shared: whether an item may be attempted, and then the
    // attempt. A review found `attempt` skipping the first, which let a caller
    // holding an item id resend a write the server had permanently refused, or
    // ignore a backoff that was still running. One definition, used by both
    // entry points, is what makes "stopped means stopped" true however an item
    // is reached.
    expect([...source.matchAll(/function eligibility\(/g)]).toHaveLength(1);
    expect([...source.matchAll(/eligibility\(item, now\)/g)].length).toBeGreaterThanOrEqual(2);
  });

  it('decides an outcome in one place, shared by the first attempt and a retry', async () => {
    const source = await readFile(join(SRC, 'reliability', 'queue.ts'), 'utf8');
    const coordinator = await readFile(join(SRC, 'reliability', 'coordinator.ts'), 'utf8');

    // One call site, inside the per-item processing that both the first
    // attempt and a sweep of everything due run. The classification, the
    // backoff, the owner guard and the terminal states exist once; two copies
    // would be two places for a first attempt to stop behaving like a retry,
    // which is the property the whole queue rests on.
    expect([...source.matchAll(/classifyDeliveryOutcome\(/g)]).toHaveLength(1);
    expect([...source.matchAll(/processItem\(/g)].length).toBeGreaterThanOrEqual(3);

    // The coordinator reads the answer and translates it. It does not classify
    // a failure, compute a delay, or decide that an item has stopped — it names
    // those outcomes in its mapping, which is a different thing from producing
    // them.
    expect(coordinator).not.toContain('classifyDeliveryOutcome');
    expect(coordinator).not.toContain('nextDelayMs');
    expect(coordinator).not.toContain('terminalFailure');
    expect(coordinator).not.toContain('attemptCount');
  });

  it('absorbs a named set of failures and nothing wider', async () => {
    const source = await readFile(join(SRC, 'reliability', 'fallback.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // Every `catch` here re-throws what it does not recognise. The easy way to
    // make "a Memory failure never stops the caller" true is a catch that
    // swallows everything, which would turn an owner mismatch, a broken
    // invariant and a delivery that ignored its contract into silence.
    const catches = [...code.matchAll(/catch \(error\) \{/g)];
    expect(catches.length).toBeGreaterThan(0);
    expect([...code.matchAll(/throw error;/g)].length).toBeGreaterThanOrEqual(catches.length);

    // The absorbed set, named literally.
    for (const absorbed of [
      'QueueCapacityError',
      'SanitizationRejectedError',
      'QueueStorageError',
    ]) {
      expect(code).toContain(`error instanceof ${absorbed}`);
    }
  });

  it('states the write’s kind and importance once each', async () => {
    const barrel = await readFile(join(SRC, 'reliability', 'index.ts'), 'utf8');
    const source = await readFile(join(SRC, 'reliability', 'fallback.ts'), 'utf8');

    // A review found the operation and the Problem's importance being given
    // twice — once to the submission and once to the decision — which made it
    // possible to submit an important Event and describe it as routine, or to
    // submit an Event and describe it as a Verification. Neither fails at the
    // time; both show up as a notice somebody never received.
    //
    // So the general helpers are private, and the public entry points take the
    // caller's own input. The operation comes from which function was called.
    expect(barrel).not.toContain('submitWithFallback');
    expect(barrel).not.toContain('fallbackForSubmit');
    expect(barrel).toContain('submitEventWithFallback');
    expect(barrel).toContain('submitVerificationWithFallback');

    for (const wrapper of ['submitEventWithFallback', 'submitVerificationWithFallback']) {
      const signature =
        new RegExp(`export function ${wrapper}\\(([\\s\\S]*?)\\): Promise`).exec(source)?.[1] ?? '';
      expect(signature).not.toBe('');
      expect(signature).not.toContain('operation');
      expect(signature).not.toContain('problemImportant');
    }
  });

  it('answers the caller rather than running the caller’s work', async () => {
    const source = await readFile(join(SRC, 'reliability', 'fallback.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // No `withMemoryFallback(mainWork, …)`. A Memory library that took the
    // assistant's work as a callback would be deciding whether real work
    // happens, which is a long way from remembering how problems were solved.
    expect(code).not.toContain('mainWork');
    expect(code).not.toContain('withMemoryFallback');

    // And `continueMainWork` is typed rather than computed: there is no
    // failure of the Memory that stops the work, so there is no branch.
    expect(code).toContain('readonly continueMainWork: true');
    expect(code).not.toContain('continueMainWork: false');
  });

  it('says one thing to a person, and nothing about the write', async () => {
    const { MEMORY_NOTICE_KINDS } = await import('../src/reliability/index.js');
    const source = await readFile(join(SRC, 'reliability', 'fallback.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // The spec names six occasions worth interrupting somebody for, and one
    // concerns saving. Splitting it by cause would describe internals the
    // person did not ask about.
    expect([...MEMORY_NOTICE_KINDS]).toEqual(['IMPORTANT_MEMORY_UNSAVED']);

    const intent = /interface MemoryNoticeIntent \{([\s\S]*?)\n\}/.exec(code)?.[1] ?? '';
    const fields = [...intent.matchAll(/readonly (\w+)[?]?:/g)].map((match) => match[1]).sort();
    expect(fields).toEqual(['dedupKey', 'kind', 'operation']);

    // No sentence is built here. Each assistant says things its own way, in
    // its own language, which is what an adapter is for — a library producing
    // English prose would have decided how a Japanese-speaking user is spoken
    // to. Every string in this module is an identifier or a closed value, and
    // the longest is `IMPORTANT_MEMORY_UNSAVED`; a sentence would be longer
    // than any of them.
    expect(code).not.toContain('message');
    const literals = [...code.matchAll(/'([^']*)'/g)].map((match) => match[1] ?? '');
    expect(literals.length).toBeGreaterThan(0);
    const longest = literals.reduce((left, right) => (right.length > left.length ? right : left));
    expect(longest.length).toBeLessThanOrEqual('IMPORTANT_MEMORY_UNSAVED'.length);
  });

  it('inspects a write before it reaches the disk, using the boundary’s own policy', async () => {
    const queue = await readFile(join(SRC, 'reliability', 'queue.ts'), 'utf8');

    // The same policy the write boundary uses, not a second idea of what a
    // credential looks like. A queue that skipped it would be a durable copy
    // of exactly what P3-01 through P3-03 keep out of the database.
    expect(queue).toContain('sanitizeValue');
    expect(queue).toContain('createSecretDetectionPolicy');
    expect(queue).not.toContain('createSecretDetector');
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

describe('the operational log', () => {
  /**
   * Scripts a person runs and reads the output of.
   *
   * They print results — a token, once, at issuance; whether the database
   * answered — and that is what they are for. The distinction P3-10 draws is
   * between an operational log, which accumulates unattended, and a command
   * whose output is the answer somebody asked for.
   */
  const ADMINISTRATIVE_CLIS = [
    'credentials/issue.ts',
    'credentials/revoke.ts',
    'db/check-connection.ts',
    'owner/bootstrap.ts',
  ];

  /** Every `x.log.<level>({ … })` call site, with the keys it passes. */
  function loggedKeys(source: string): string[] {
    const calls = [...source.matchAll(/\.log\.\w+\(\s*\{([^{}]*)\}/g)];
    return calls.flatMap((call) => [...(call[1] ?? '').matchAll(/(\w+)\s*:/g)].map((m) => m[1]!));
  }

  /**
   * The full argument text of every `x.log.<level>(…)` call.
   *
   * Scanned by matching parentheses rather than by regex, so a call spanning
   * several lines is read whole. A guard that only saw the first line of a
   * call would report clean for a violation written on the second.
   */
  function logCallArguments(source: string): string[] {
    const found: string[] = [];
    const opener = /\.log\.\w+\(/g;

    let match: RegExpExecArray | null;
    while ((match = opener.exec(source)) !== null) {
      let depth = 1;
      let at = match.index + match[0].length;
      const from = at;

      while (at < source.length && depth > 0) {
        const character = source[at];
        if (character === '(') {
          depth += 1;
        } else if (character === ')') {
          depth -= 1;
        }
        at += 1;
      }

      found.push(source.slice(from, at - 1));
    }

    return found;
  }

  it('carries only the fields this policy names', async () => {
    const modules = await readModules(SRC);

    // The allowlist, spelled out. Every one of these is a value the server
    // produced: an event name, a count, a status code, a closed reason. None
    // of them can hold a caller's text, a driver's message or Memory content.
    const ALLOWED = new Set([
      'event',
      'failure',
      'validationContext',
      'validationProblemCount',
      'statusCode',
      'locator',
      'kind',
      'reason',
      'healthReason',
      'latencyMs',
      'signal',
    ]);

    const offenders: string[] = [];
    for (const module of modules) {
      for (const key of loggedKeys(module.source)) {
        if (!ALLOWED.has(key)) {
          offenders.push(`${module.path} -> ${key}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('is never handed an error', async () => {
    const modules = await readModules(SRC);

    // `{ err: error }` is the shape this used to take, and Pino expands an
    // error into its message, its stack, its `cause` and every enumerable
    // property it has — including, for a `pg` constraint violation, the row
    // that broke it. The serializer would catch this now; the point of also
    // forbidding it here is that nobody should have to rely on that.
    //
    // What is forbidden is the error *value*: a bare `err` or `error`, and any
    // of the properties that carry the failure's own words. Reading a field
    // Fastify computed — `error.validationContext` is one of four strings it
    // chose — is a different act, and stays allowed.
    const dangerous = [
      /\b(?:err|error)\b(?!\s*\.)/,
      /\.(?:message|stack|cause|detail|constraint|table|column|query|internalQuery|where|path)\b/,
    ];

    // Quoted message text is stripped first. `'error during shutdown'` is a
    // sentence this repository wrote, and a guard that read prose would be
    // arguing with the word rather than the value. Template literals are left
    // in, deliberately — `${error.message}` is exactly the thing to catch.
    const withoutMessages = (argument: string): string =>
      argument.replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');

    const offenders: string[] = [];
    for (const module of modules) {
      for (const argument of logCallArguments(module.source)) {
        const code = withoutMessages(argument);
        if (dangerous.some((pattern) => pattern.test(code))) {
          offenders.push(`${module.path} -> ${argument.replace(/\s+/g, ' ').trim()}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('is never handed a request body or a response payload', async () => {
    const modules = await readModules(SRC);

    const offenders = modules
      .filter((module) =>
        /\.log\.\w+\([^)]*\b(?:request\.body|req\.body|request\.raw|reply\.raw|payload|body)\b/.test(
          module.source,
        ),
      )
      .map((module) => module.path)
      .sort();

    expect(offenders).toEqual([]);
  });

  it('decides what a request, a response and a failure look like in one place', async () => {
    const modules = await readModules(SRC);

    const withSerializers = modules
      .filter((module) => /\bserializers\b/.test(module.source))
      .map((module) => module.path)
      .sort();

    // One home for the policy. A second serializer configured somewhere else
    // would be a second answer to the same question, and the safe one would
    // not necessarily win.
    expect(withSerializers).toEqual(['http/app.ts']);
  });

  it('brings in no logging library of its own', async () => {
    const modules = await readModules(SRC);

    const offenders: string[] = [];
    for (const module of modules) {
      for (const specifier of importsOf(module.source)) {
        // Pino arrives through Fastify and is configured through Fastify.
        // Importing it directly, or adding a second logger, would put a sink
        // outside the configuration every test here checks.
        if (/^(pino|winston|bunyan|loglevel|@opentelemetry)/.test(specifier)) {
          offenders.push(`${module.path} -> ${specifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('keeps the server process to one line of console output', async () => {
    const modules = await readModules(SRC);

    const consoleUsers = modules
      .filter((module) => /\bconsole\.\w+\(/.test(module.source))
      .map((module) => module.path)
      .sort();

    expect(consoleUsers).toEqual([...ADMINISTRATIVE_CLIS, 'index.ts'].sort());

    const entrypoint = modules.find((module) => module.path === 'index.ts');
    const calls = [...entrypoint!.source.matchAll(/console\.(\w+)\(([^\n]*)/g)];

    // Two, and both of them static. The summary is a service name, a Node
    // version, an environment, a level and the address about to be bound —
    // decided by whoever started the process, at a moment when there are no
    // callers. The failure line is a constant.
    expect(calls.map((call) => call[1])).toEqual(['log', 'error']);
    expect(calls[0]![2]).toContain('formatStartupSummary(buildStartupSummary(env))');
    expect(calls[1]![2]).toContain('STARTUP_FAILURE_MESSAGE');
  });

  it('reads configuration inside the boundary that catches it failing', async () => {
    const modules = await readModules(SRC);
    const entrypoint = modules.find((module) => module.path === 'index.ts')!.source;

    // `loadEnv` and `createPool` run before a logger exists, so a failure in
    // either is an uncaught exception with a stack — and two of the errors
    // reachable there quote their input. They belong inside `main`, whose
    // caller prints fixed text.
    const main = /async function main\(\): Promise<void> \{([\s\S]*?)\n\}/.exec(entrypoint);
    expect(main).not.toBeNull();
    expect(main![1]).toContain('loadEnv()');
    expect(main![1]).toContain('createPool(');
    expect(main![1]).toContain('buildMemoryHttpApp(');

    // And nothing is left at the top level that could throw past it.
    const afterMain = entrypoint.slice(entrypoint.indexOf('\ntry {\n  await main();'));
    expect(afterMain).toContain('await main();');
    expect(afterMain).not.toContain('loadEnv');
    expect(afterMain).not.toContain('createPool');
  });

  it('leaves the retry queue without a logger', async () => {
    const modules = await readModules(join(SRC, 'reliability'));
    expect(modules.length).toBeGreaterThan(0);

    // The queue holds payloads, file paths, idempotency keys and terminal
    // reasons — the things P3-07 through P3-09 decided not to carry outward.
    // Where a client-side library's diagnostics go is the Adapter's question,
    // in Phase 5, and answering it here would answer it for every caller.
    const offenders = modules
      .filter((module) => /\.log\.\w+\(|\bconsole\.\w+\(|\blogger\b/.test(module.source))
      .map((module) => module.path)
      .sort();

    expect(offenders).toEqual([]);
  });

  it('is written from two modules and no others', async () => {
    const modules = await readModules(SRC);

    const writers = modules
      .filter((module) => /\.log\.\w+\(/.test(module.source))
      .map((module) => module.path)
      .sort();

    // The transport boundary, which knows what a request did, and the
    // composition root, which knows about the process. Nothing below them
    // logs at all — no service, no repository, no domain rule, and in
    // particular neither of the modules that own UsageLog and ChangeLog.
    //
    // That is what keeps the two kinds of log apart without needing a rule
    // about it. UsageLog and ChangeLog are Memory data: rows an owner reads,
    // exports and deletes. Mirroring them into the process log would copy
    // Memory content somewhere none of those operations reach, and writing
    // process events into them would make Memory the place operations get
    // audited — the Global Audit warehouse this module is not.
    expect(writers).toEqual(['http/app.ts', 'index.ts']);

    const memoryLogModules = modules.filter((module) =>
      /^(?:app|db|domain)\/(?:usage-logs?|change-logs?)\.ts$/.test(module.path),
    );
    expect(memoryLogModules.length).toBeGreaterThan(0);
    for (const module of memoryLogModules) {
      expect(module.source).not.toMatch(/\.log\.\w+\(|\bconsole\.\w+\(/);
    }
  });
});

describe('the retrieval artifact', () => {
  it('is handed out from one place, under its own policy', async () => {
    const modules = await readModules(SRC);

    // Call sites, not the definition. Named by path rather than excluded by a
    // pattern: "everywhere except where it is declared" is a fact about one
    // file, and reads better as one.
    const definition = 'repository/retrieval-artifact-repository.ts';
    const builders = modules
      .filter((module) => module.path !== definition)
      .filter((module) => module.source.includes('createRetrievalArtifactRepository('))
      .map((module) => module.path)
      .sort();

    // The same rule the Memory repository lives under, for the same reason:
    // few, named places where the boundary could be forgotten. The request
    // context hands one out per request; the generation service builds one
    // over its gate's transactional executor, so the write commits or
    // vanishes with the gate. A construction site beyond these is how a
    // repository ends up handed out unwrapped.
    const approved = ['app/request-context.ts', 'app/retrieval-artifact-generation-service.ts'];
    expect(builders).toEqual(approved);

    for (const path of approved) {
      const source = modules.find((module) => module.path === path)?.source ?? '';
      const constructions = source.split('createRetrievalArtifactRepository(').length - 1;
      // Every construction is wrapped. Counted by looking at what precedes
      // each one rather than by matching across the line break between them.
      const unwrapped = source
        .split('createRetrievalArtifactRepository(')
        .slice(0, -1)
        .filter((before) => !/withSanitization\(\s*$/.test(before)).length;

      expect(constructions, `${path} builds none`).toBeGreaterThan(0);
      expect(unwrapped, `${path} builds one unwrapped`).toBe(0);
      // Its own policy, not the write boundary's. An artifact is refused whole
      // rather than redacted, because its embedding was built from the text
      // before a redaction could apply.
      expect(source).toContain('createArtifactInspectionPolicy');
    }
  });

  it('is removed by the delete path', async () => {
    const source = await readFile(join(SRC, 'db', 'problem-deletion.ts'), 'utf8');

    // The standing rule a derived store arrives under: it is deleted in the
    // same change that introduces it, in the open, beside everything else the
    // Problem owned.
    expect(source).toContain('delete from public.retrieval_artifacts');
  });

  it('has no generator, no provider and no search', async () => {
    const modules = await readModules(SRC);

    const offenders: string[] = [];
    for (const module of modules) {
      for (const specifier of importsOf(module.source)) {
        // P4-01 is storage. Summaries, embeddings, ranking and searching
        // belong to the tasks that own them, and a client library arriving
        // early is how a storage task becomes a model decision.
        if (/^(openai|@anthropic|@google|cohere|@huggingface|langchain|pgvector)/.test(specifier)) {
          offenders.push(`${module.path} -> ${specifier}`);
        }
      }
    }

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

describe('the retrieval summary generator', () => {
  it('names no model vendor and opens no connection of its own', async () => {
    const modules = await readModules(SRC);

    const offenders: string[] = [];
    for (const module of modules) {
      for (const specifier of importsOf(module.source)) {
        // A summariser is where a vendor SDK would first look reasonable, and
        // choosing one here would put a model decision inside a module whose
        // job is to be independent of it. The port exists so that decision can
        // be made later, by whoever has a reason.
        if (
          /^(openai|@anthropic|@google|@mistral|cohere|@huggingface|langchain|llamaindex)/.test(
            specifier,
          ) ||
          /^(axios|node-fetch|undici|got|superagent)$/.test(specifier)
        ) {
          offenders.push(`${module.path} -> ${specifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('hands the generator a document and nothing it could write through', async () => {
    const source = await readFile(join(SRC, 'app', 'retrieval-summary-service.ts'), 'utf8');
    const port = source.slice(source.indexOf('export interface RetrievalSummaryGenerator {'));
    const body = port.slice(0, port.indexOf('\n}'));

    // The strongest form of "generating a summary does not change the Memory":
    // the port has no way to. It is given a string and returns a value, so a
    // repository, an executor or a pool cannot be reached from inside one.
    for (const reachable of ['Repository', 'Executor', 'DatabasePool', 'OwnerContext']) {
      expect(body.includes(reachable), `the generator port can reach a ${reachable}`).toBe(false);
    }
    expect(body).toContain('RetrievalSummaryGeneratorInput');
  });

  it('generates without a path to the artifact write', async () => {
    const source = await readFile(join(SRC, 'app', 'retrieval-summary-service.ts'), 'utf8');

    // An artifact needs an embedding, and an embedding needs a provider that
    // nothing here has. A draft that could be written down would be written
    // down incomplete, or with a placeholder vector standing in for one.
    expect(source).not.toContain('upsertArtifact');
    expect(source).not.toContain('RetrievalArtifactRepository');
    expect(source).not.toContain('createRetrievalArtifactRepository');
  });

  it('inspects what a generator produced before returning it', async () => {
    const source = await readFile(join(SRC, 'app', 'retrieval-summary-service.ts'), 'utf8');

    // The step that has to happen here rather than at storage: whatever comes
    // back next goes to an embedding provider, and a vector computed from a
    // credential cannot be redacted afterwards.
    expect(source).toContain('createArtifactInspectionPolicy');
    expect(source).toContain('sanitizeValue');
  });

  it('reads its source in one owner-scoped statement', async () => {
    // The statement that runs, not the source that builds it: the subqueries
    // are interpolated, so reading the file would check the fragments and miss
    // what they were assembled into.
    const { RETRIEVAL_SUMMARY_SOURCE_STATEMENT } =
      await import('../src/db/retrieval-summary-source.js');

    // Four reads would take four snapshots and could assemble a state that
    // never existed, which would then be fingerprinted as though it had.
    expect(RETRIEVAL_SUMMARY_SOURCE_STATEMENT).not.toContain(';');

    // Every subquery carries the owner, not just the outer one. The composite
    // foreign keys make a cross-owner row unstorable, so matching on the
    // problem alone would happen to be safe — and would be one schema edit
    // away from not being.
    const scoped = [
      ...RETRIEVAL_SUMMARY_SOURCE_STATEMENT.matchAll(/from\s+public\.(\w+)\s+(\w+)/g),
    ];
    expect(scoped.length).toBeGreaterThan(0);
    for (const [, table, alias] of scoped) {
      expect(
        RETRIEVAL_SUMMARY_SOURCE_STATEMENT.includes(`${String(alias)}.owner_id`),
        `${String(table)} is read without naming the owner`,
      ).toBe(true);
    }
    expect(RETRIEVAL_SUMMARY_SOURCE_STATEMENT).toContain('pr.owner_id = $1');
  });

  it('writes nothing, anywhere on the generation path', async () => {
    for (const path of [
      join(SRC, 'db', 'retrieval-summary-source.ts'),
      join(SRC, 'repository', 'retrieval-summary-source-reader.ts'),
      join(SRC, 'app', 'retrieval-summary-service.ts'),
    ]) {
      const source = await readFile(path, 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

      for (const write of ['insert into', 'update public.', 'delete from']) {
        expect(code.toLowerCase().includes(write), `${path} performs a ${write}`).toBe(false);
      }
    }
  });

  it('has no search, no ranking and no embedding', async () => {
    const modules = await readModules(SRC);
    const code = modules
      .filter((module) => module.path.includes('retrieval-summary'))
      .map((module) => module.source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''))
      .join('\n');

    expect(code.length).toBeGreaterThan(0);
    // P4-02 turns one Problem into one summary. Finding, ordering and
    // comparing are separate tasks, and a vector operator or a text-search
    // call appearing here would be one of them arriving early.
    for (const later of ['tsvector', 'to_tsquery', 'plainto_tsquery', '<=>', '<->', 'embedding']) {
      expect(code.includes(later), `the summary path already does ${later}`).toBe(false);
    }
  });
});

describe('lexical search', () => {
  it('names the owner and the read control in the statement itself', async () => {
    const { FULL_TEXT_SEARCH_STATEMENT } = await import('../src/db/retrieval-full-text-search.js');

    // Both are filters rather than something applied to the rows afterwards.
    // Another owner's artifact must not be scored, ordered or counted towards
    // the limit; and a Problem whose owner turned automatic reading off must
    // not be fetched in order to be discarded above.
    expect(FULL_TEXT_SEARCH_STATEMENT).toContain('ra.owner_id = $1');
    expect(FULL_TEXT_SEARCH_STATEMENT).toContain('pr.memory_read_enabled');
    expect(FULL_TEXT_SEARCH_STATEMENT).toContain('pr.owner_id = ra.owner_id');
  });

  it('orders by the score and breaks every tie', async () => {
    const { FULL_TEXT_SEARCH_STATEMENT } = await import('../src/db/retrieval-full-text-search.js');

    // Without a total order, a smaller limit could return a different subset of
    // equally-scoring candidates on each run.
    expect(FULL_TEXT_SEARCH_STATEMENT).toContain('order by lexical_score desc, ra.problem_id asc');
    expect(FULL_TEXT_SEARCH_STATEMENT).toContain('limit $5');
    // `generated_at` is not evidence about currency, so it is not a tie-break.
    expect(FULL_TEXT_SEARCH_STATEMENT).not.toContain('generated_at');
  });

  it('builds its document from the artifact and nothing else', async () => {
    const migrations = join(process.cwd(), 'supabase', 'migrations');
    const files = await readdir(migrations);
    const search = files.find((name) => name.includes('p4_03'));
    expect(search).toBeDefined();

    const sql = await readFile(join(migrations, search ?? ''), 'utf8');
    const statements = sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');

    // The artifact is the searchable representation, and P4-02 exists to
    // produce it. Indexing the Problem's own text alongside would put two
    // definitions of "the searchable text" in the system; indexing the
    // structural features would take work that compares meaning and hand it to
    // something that compares words.
    for (const absent of ['title', 'symptoms', 'problem_domain', 'structural_features']) {
      expect(statements.includes(absent), `the document includes ${absent}`).toBe(false);
    }
    expect(statements).toContain('normalized_summary');
    expect(statements).toContain('keywords');
    // Named in full, so a session setting cannot change what a stored document
    // means.
    expect(statements).toContain('pg_catalog.simple');
  });

  it('searches without writing anything', async () => {
    for (const path of [
      join(SRC, 'db', 'retrieval-full-text-search.ts'),
      join(SRC, 'repository', 'retrieval-search-reader.ts'),
      join(SRC, 'domain', 'retrieval-search.ts'),
    ]) {
      const source = await readFile(path, 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

      // Search is a read. Recording that a search happened is a later task's,
      // and doing it here would make every query a write.
      for (const write of [
        'insert into',
        'update public.',
        'delete from',
        'createUsageLog',
        'createChangeLog',
      ]) {
        expect(code.toLowerCase().includes(write.toLowerCase()), `${path} performs ${write}`).toBe(
          false,
        );
      }
    }
  });

  it('has no vector search, no ranking policy and no generation', async () => {
    const modules = await readModules(SRC);
    const code = modules
      .filter(
        (module) =>
          // The lexical implementation only. `domain/retrieval-search.ts` is
          // deliberately absent since P4-05: it hosts the query and candidate
          // types BOTH searches share, vector candidate included, and a shared
          // vocabulary is not the lexical path doing vector work.
          module.path === 'db/retrieval-full-text-search.ts' ||
          module.path === 'repository/retrieval-search-reader.ts',
      )
      .map((module) => module.source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''))
      .join('\n');

    expect(code.length).toBeGreaterThan(0);
    // Lexical candidates only. Distance operators, embeddings, a hybrid merge
    // and a confidence-aware ordering are each a later task, and a search that
    // generated what it could not find would turn a read into a write.
    for (const later of [
      '<=>',
      '<->',
      'embedding',
      'cosine',
      'upsertArtifact',
      'generateSummary',
    ]) {
      expect(code.includes(later), `lexical search already does ${later}`).toBe(false);
    }
  });
});

describe('the artifact generation pipeline', () => {
  it('takes the lock inside its gate, and calls the provider outside it', async () => {
    const source = await readFile(
      join(SRC, 'app', 'retrieval-artifact-generation-service.ts'),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // The gate is only atomic because the row is locked; a version that reads,
    // compares and writes without the lock returns identical results and
    // quietly reopens the gap the lock exists to close.
    expect(code).toContain('lockProblemForArtifactWrite');
    const gate = code.slice(code.indexOf('transactionRunner.run'));
    expect(gate).toContain('lockProblemForArtifactWrite');
    // And the slow call stays outside: a provider invoked inside the
    // transaction would turn its latency into everybody's lock time.
    expect(gate.includes('.embed('), 'the provider is called inside the gate').toBe(false);
  });

  it('gives the provider port no way to reach storage', async () => {
    const source = await readFile(join(SRC, 'domain', 'retrieval-embedding.ts'), 'utf8');
    const port = source.slice(source.indexOf('export interface EmbeddingProvider {'));
    const body = port.slice(0, port.indexOf('\n}'));

    // The port is handed a string and returns a value. A provider that could
    // reach a repository, an executor or a context would be able to act on
    // the Memory it is embedding.
    for (const reachable of ['Repository', 'Executor', 'DatabasePool', 'OwnerContext']) {
      expect(body.includes(reachable), `the provider port can reach a ${reachable}`).toBe(false);
    }
    expect(body).toContain('EmbeddingProviderInput');
  });

  it('has no vector search and no distance operator', async () => {
    const modules = await readModules(SRC);
    const code = modules
      .filter(
        (module) =>
          module.path.includes('retrieval-embedding') ||
          module.path.includes('retrieval-artifact-generation') ||
          module.path.includes('problem-lock'),
      )
      .map((module) => module.source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''))
      .join('\n');

    expect(code.length).toBeGreaterThan(0);
    // P4-04 produces and stores vectors. Comparing them is the next task, and
    // an operator arriving early is that task starting unannounced.
    for (const later of ['<=>', '<#>', '<->', 'cosine', 'hnsw', 'ivfflat', 'l2_distance']) {
      expect(code.includes(later), `the generation path already uses ${later}`).toBe(false);
    }
  });
});

describe('vector search', () => {
  it('names the owner, the read control and the whole vector space in the statement', async () => {
    const { VECTOR_SEARCH_STATEMENT } = await import('../src/db/retrieval-vector-search.js');

    // The two hard filters every search here carries, plus the three-part
    // compatibility test. Model alone is not enough: a distance across
    // versions signifies nothing, and a distance across dimensions is an
    // error rather than a low score — an incompatible row must be excluded by
    // the filter, where it can neither break the query nor occupy the limit.
    expect(VECTOR_SEARCH_STATEMENT).toContain('ra.owner_id = $1');
    expect(VECTOR_SEARCH_STATEMENT).toContain('pr.owner_id = ra.owner_id');
    expect(VECTOR_SEARCH_STATEMENT).toContain('pr.memory_read_enabled');
    expect(VECTOR_SEARCH_STATEMENT).toContain('ra.embedding_model = $3');
    expect(VECTOR_SEARCH_STATEMENT).toContain('ra.embedding_model_version = $4');
    expect(VECTOR_SEARCH_STATEMENT).toContain('vector_dims(ra.embedding) = $5');
  });

  it('orders by cosine distance and breaks every tie', async () => {
    const { VECTOR_SEARCH_STATEMENT } = await import('../src/db/retrieval-vector-search.js');

    // `<=>` is cosine, a system decision: it is the metric that separates
    // direction from magnitude. The order is total so equal distances return
    // identically and a smaller limit is a prefix of a larger one's answer.
    expect(VECTOR_SEARCH_STATEMENT).toContain('<=>');
    expect(VECTOR_SEARCH_STATEMENT).toContain('order by cosine_distance asc, ra.problem_id asc');
    expect(VECTOR_SEARCH_STATEMENT).toContain('limit $8');
    expect(VECTOR_SEARCH_STATEMENT).not.toContain('generated_at');
  });

  it('searches without writing, locking or generating', async () => {
    for (const path of [
      join(SRC, 'db', 'retrieval-vector-search.ts'),
      join(SRC, 'repository', 'retrieval-vector-search-reader.ts'),
      join(SRC, 'app', 'retrieval-vector-search-service.ts'),
    ]) {
      const source = await readFile(path, 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

      // A search is a read. In particular it never regenerates an artifact it
      // failed to find — a model-mismatch miss is answered by the lexical
      // channel and by later orchestration, not by a write at query time.
      for (const forbidden of [
        'insert into',
        'update public.',
        'delete from',
        'createUsageLog',
        'createChangeLog',
        'upsertArtifact',
        'generateArtifact',
        'RetrievalArtifactGenerationService',
        'DatabaseTransactionRunner',
        'lockProblemForArtifactWrite',
      ]) {
        expect(
          code.toLowerCase().includes(forbidden.toLowerCase()),
          `${path} contains ${forbidden}`,
        ).toBe(false);
      }
    }
  });

  it('exposes text to callers, and a vector only to the storage boundary', async () => {
    const source = await readFile(join(SRC, 'app', 'retrieval-vector-search-service.ts'), 'utf8');

    // The application surface accepts words. The embedding is produced inside
    // the service by the same provider the artifacts used, which is what makes
    // query-space compatibility structural rather than conventional — a public
    // method taking a raw vector would reopen it.
    const request = source.slice(source.indexOf('export interface VectorSearchRequest {'));
    const requestBody = request.slice(0, request.indexOf('\n}'));
    expect(requestBody).toContain('text: string');
    expect(requestBody.includes('mbedding'), 'the request can carry a vector').toBe(false);

    const service = source.slice(source.indexOf('export interface RetrievalVectorSearchService {'));
    const serviceBody = service.slice(0, service.indexOf('\n}'));
    expect(serviceBody.includes('mbedding'), 'the service interface accepts a vector').toBe(false);
  });

  it('inspects the query before any provider could see it', async () => {
    const source = await readFile(join(SRC, 'app', 'retrieval-vector-search-service.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // The gate this search adds over the lexical one: the query is about to
    // leave the process, so a confirmed credential turns into a typed outcome
    // with the provider never called. The policy inspection must come before
    // the embed call in the one method both live in.
    const inspectAt = code.indexOf('queryPolicy.inspect');
    const embedAt = code.indexOf('.embed(');
    expect(inspectAt).toBeGreaterThan(-1);
    expect(embedAt).toBeGreaterThan(-1);
    expect(inspectAt).toBeLessThan(embedAt);
    expect(code).toContain('SENSITIVE_QUERY_NOT_EMBEDDED');
  });
});
