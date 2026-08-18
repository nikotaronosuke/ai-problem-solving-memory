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

    // Two files, each owning a different kind of removal. The delete path is
    // the only place that removes Memory rows — the order rows have to go in
    // is a fact about the foreign key graph, and a second place that knows it
    // is a second place that can be wrong about it. The invalidation module
    // removes exactly one derived table's rows and knows no ordering at all;
    // the next test pins it to that table. Every other file that wants a
    // delete embeds the invalidation module's text rather than writing its
    // own.
    expect(deleters).toEqual(['db/problem-deletion.ts', 'db/retrieval-artifact-invalidation.ts']);
  });

  it('lets the invalidation module delete derived rows and nothing else', async () => {
    const source = await readFile(join(SRC, 'db', 'retrieval-artifact-invalidation.ts'), 'utf8');

    const statements = source.match(/delete\s+from\s+public\.(\w+)/gi) ?? [];
    // One delete, of the one regenerable table. A canonical table appearing
    // here would make an invalidation into a data loss.
    expect(statements).toEqual(['delete from public.retrieval_artifacts']);

    // Owner and problem both, as bound parameters — never an interpolation.
    expect(source).toContain('where owner_id = $1');
    expect(source).toContain('and problem_id = $2');
  });

  it('keeps every provider and network reach out of the invalidation path', async () => {
    // The delete runs inside canonical write transactions. Anything slow or
    // external there would put somebody's inference time inside everybody's
    // lock time — the rule the generation service is built around, applied to
    // the module that rides the writes.
    for (const file of [
      'db/retrieval-artifact-invalidation.ts',
      'db/events.ts',
      'db/verifications.ts',
      'db/problems.ts',
    ]) {
      const source = await readFile(join(SRC, ...file.split('/')), 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      for (const forbidden of ['fetch(', 'http://', 'https://', 'setTimeout', 'axios']) {
        expect(`${file}:${code.includes(forbidden)}`).toBe(`${file}:false`);
      }
    }
  });

  it('keeps the maintenance layer vendor-neutral', async () => {
    // Which concrete stack generates is the composition edge's decision, and
    // no earlier layer's. A vendor name in the scheduler or the sweep would
    // be that decision leaking upstream.
    for (const file of [
      'app/retrieval-generation-coordinator.ts',
      'app/retrieval-artifact-reconciliation-service.ts',
      'app/retrieval-artifact-maintenance.ts',
      'domain/retrieval-generation-profile.ts',
      'db/retrieval-artifact-reconciliation.ts',
    ]) {
      const source = await readFile(join(SRC, ...file.split('/')), 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      for (const vendor of ['openai', 'anthropic', 'gemini', 'voyage', 'cohere', 'claude']) {
        expect(`${file}:${code.toLowerCase().includes(vendor)}`).toBe(`${file}:false`);
      }
    }
  });

  it('confines the vendor to the provider directory', async () => {
    // The ports are vendor-neutral and the composition edge chooses a
    // concrete stack. Everything OpenAI-specific therefore lives under
    // src/providers/openai and nowhere else — one directory to swap when the
    // stack changes, and no vendor name quietly becoming a dependency of a
    // layer that must outlive it.
    const modules = await readModules(SRC);

    for (const module of modules) {
      if (module.path.startsWith('providers/')) {
        continue;
      }
      const code = module.source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(`${module.path}:${code.toLowerCase().includes('openai')}`).toBe(
        `${module.path}:false`,
      );
      for (const specifier of importsOf(module.source)) {
        // The composition root may import the provider composition boundary
        // — the vendor-neutral front door — and nothing may import past it.
        // `providers/index.js` exports no vendor name, so even the one
        // allowed import learns "a stack exists", not whose.
        const allowed = module.path === 'index.ts' && specifier === './providers/index.js';
        expect(
          `${module.path} imports ${specifier}:${!allowed && specifier.includes('providers/')}`,
        ).toBe(`${module.path} imports ${specifier}:false`);
      }
    }
  });

  it('gives the provider transport one fixed host and no way to move it', async () => {
    const providerModules = (await readModules(SRC)).filter((module) =>
      module.path.startsWith('providers/openai/'),
    );
    expect(providerModules.length).toBeGreaterThan(0);

    const urls = providerModules.flatMap(
      (module) => module.source.match(/https?:\/\/[^\s'"`]+/g) ?? [],
    );
    // Exactly one network location in the whole family, the official one.
    expect([...new Set(urls)]).toEqual(['https://api.openai.com/v1']);

    for (const { path, source } of providerModules) {
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      // No configurable base URL, which is what would let a configuration
      // send the credential to an arbitrary host.
      expect(`${path}:${/baseurl/i.test(code)}`).toBe(`${path}:false`);
    }
  });

  it('reads the provider credential variable in exactly one file', async () => {
    const modules = await readModules(SRC);

    // The quoted literal, not the constant's name: everything else refers to
    // the variable through `OPENAI_API_KEY_ENV`, so the raw string existing
    // twice would be two places that can disagree about which variable holds
    // the credential.
    const readers = modules
      .filter((module) => module.source.includes(`'OPENAI_API_KEY'`))
      .map((module) => module.path);

    expect(readers).toEqual(['providers/openai/config.ts']);
  });

  it('keeps the retrieval runtime vendor-neutral and honestly owner-scoped', async () => {
    const source = await readFile(join(SRC, 'runtime', 'retrieval-runtime.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    // No vendor, no credential, no network of its own: the runtime schedules
    // work through ports it was handed and could not tell one vendor from
    // another.
    for (const forbidden of ['openai', 'OPENAI_API_KEY', 'fetch(', 'https://', 'http://']) {
      expect(`${forbidden}:${code.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
    // Owner contexts are resolved, never asserted into existence: a cast
    // would make up an owner nobody checked is still there. The call form is
    // required and every escape-hatch cast is refused, because `as unknown
    // as …` is exactly how a conjured context would be spelled.
    expect(code).toContain('await resolveOwnerContextFor(');
    expect(`cast:${/as\s+unknown/.test(code)}`).toBe('cast:false');
    expect(`cast:${/as\s+OwnerContext\b/.test(code)}`).toBe('cast:false');
  });

  it('starts retrieval maintenance after the listener, and never awaits it', async () => {
    const source = await readFile(join(SRC, 'index.ts'), 'utf8');

    // The startup sweep is background backfill: CRUD availability must not
    // wait on a provider. The start call sits after the listen, and nothing
    // in the entrypoint awaits the runtime.
    const listenAt = source.indexOf('await app.listen(');
    const startAt = source.indexOf('retrievalRuntime?.start()');
    expect(listenAt).toBeGreaterThan(-1);
    expect(startAt).toBeGreaterThan(listenAt);
    expect(`awaited:${/await\s+retrievalRuntime/.test(source)}`).toBe('awaited:false');
  });

  it('lets the owner discovery select identifiers and nothing else', async () => {
    const { OWNER_DISCOVERY_STATEMENT } = await import('../src/db/owner-discovery.js');

    // One column. A discovery that carried problem ids, titles or anything
    // beyond the identifier would be a cross-owner read of actual content.
    const selectList = OWNER_DISCOVERY_STATEMENT.slice(
      0,
      OWNER_DISCOVERY_STATEMENT.indexOf('from public.problems'),
    );
    expect(selectList).toContain('distinct owner_id');
    expect(`extra:${selectList.includes(',')}`).toBe('extra:false');
    for (const forbidden of ['problem_id', 'title', 'symptoms', 'summary']) {
      expect(`${forbidden}:${OWNER_DISCOVERY_STATEMENT.includes(forbidden)}`).toBe(
        `${forbidden}:false`,
      );
    }
  });

  it('keeps the all-owner discovery inside the maintenance runtime', async () => {
    const modules = await readModules(SRC);

    const users = modules
      .filter((module) =>
        importsOf(module.source).some((specifier) => specifier.includes('owner-discovery')),
      )
      .map((module) => module.path)
      .sort();

    // The one cross-owner read exists for the sweep and for nothing else. On
    // the repository, the HTTP surface, the client or the adapter it would
    // be a second, unguarded path to every owner's records.
    expect(users).toEqual(['runtime/retrieval-runtime.ts']);

    for (const module of modules) {
      if (module.path.startsWith('http/') || module.path.startsWith('repository/')) {
        expect(`${module.path}:${module.source.includes('listOwnerIdsWithReadableProblems')}`).toBe(
          `${module.path}:false`,
        );
      }
    }
  });

  it('lets only the runtime and its scheduler own an interval timer', async () => {
    const modules = await readModules(SRC);

    for (const module of modules) {
      if (module.path === 'runtime/retrieval-runtime.ts') {
        continue;
      }
      const code = module.source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      // A timer anywhere else is background behaviour some layer acquired
      // without a lifecycle to stop it.
      expect(`${module.path}:${/\bsetInterval\s*\(/.test(code)}`).toBe(`${module.path}:false`);
    }
  });

  it('keeps the provider credential out of the general configuration', async () => {
    // The server's own EnvConfig and startup summary must not learn the
    // provider credential: the summary is built for pasting into an issue,
    // and the general config travels wherever configuration travels.
    for (const file of ['config/env.ts', 'service.ts']) {
      const source = await readFile(join(SRC, ...file.split('/')), 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      for (const forbidden of ['OPENAI_API_KEY', 'apiKey', 'credential']) {
        expect(`${file} ${forbidden}:${code.includes(forbidden)}`).toBe(
          `${file} ${forbidden}:false`,
        );
      }
    }
  });

  it('runs every canonical write that invalidates inside a transaction boundary', async () => {
    // The delete is a second statement, and the transaction is what makes it
    // one atom with the write. The Problem writers are wrapped by their
    // services' transactions; the two append services must wrap explicitly,
    // and this reads that they still do.
    const eventService = await readFile(join(SRC, 'app', 'event-service.ts'), 'utf8');
    const verificationService = await readFile(join(SRC, 'app', 'verification-service.ts'), 'utf8');

    expect(eventService).toMatch(/runInTransaction\([\s\S]*?appendEvent\(/);
    expect(verificationService).toMatch(/runInTransaction\([\s\S]*?appendVerification\(/);
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

describe('the search path', () => {
  it('serves exactly one search route, under the Problem it is a search for', async () => {
    const modules = await readModules(SRC);

    const declarations = modules.flatMap(({ path, source }) =>
      [...source.matchAll(/scope\.(get|post|patch|delete)<?[^(]*\(\s*'([^']*search[^']*)'/g)].map(
        (match) => `${path} ${match[1]} ${match[2]}`,
      ),
    );

    // One route, one method, one path. A collection route would have to take
    // the Problem in the body — the same fact with two possible sources — and a
    // GET would put somebody's own description of their own problem into a query
    // string, a proxy cache and an access log.
    expect(declarations).toEqual(['http/search-routes.ts post /problems/:problem_id/search']);
  });

  it('takes the owner from the authenticated context and never from a request', async () => {
    const source = await readFile(join(SRC, 'runtime', 'retrieval-search-runtime.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    // Resolved, never asserted: an `OwnerContext` cast into existence is an
    // owner nobody checked is still there. The call form is required, and both
    // spellings of the escape hatch are refused — `as unknown as …` is exactly
    // how a conjured context would be written.
    expect(code).toContain('context.repository.ownerId');
    expect(code).toContain('await resolveOwnerContextFor(');
    expect(`cast:${/as\s+unknown/.test(code)}`).toBe('cast:false');
    expect(`cast:${/as\s+OwnerContext\b/.test(code)}`).toBe('cast:false');

    const routes = await readFile(join(SRC, 'http', 'search-routes.ts'), 'utf8');
    const routeCode = routes.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    // Transport does not know an owner id at all. Not from a body, not from a
    // header, not from the path — it hands over the context it authenticated.
    expect(`ownerId:${routeCode.includes('ownerId')}`).toBe('ownerId:false');
    expect(`owner_id:${routeCode.includes('owner_id')}`).toBe('owner_id:false');
  });

  it('keeps the search composition vendor-neutral and off the network', async () => {
    const source = await readFile(join(SRC, 'runtime', 'retrieval-search-runtime.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    // Two ports and a pool. It could not tell one provider from another, hold a
    // credential, or reach anything itself.
    for (const forbidden of [
      'openai',
      'OPENAI_API_KEY',
      'fetch(',
      'https://',
      'http://',
      'apiKey',
    ]) {
      expect(`${forbidden}:${code.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it('builds no stand-in provider anywhere in production', async () => {
    const modules = await readModules(SRC);

    // Both ports are optional and the two stage services own the degradation.
    // An object whose only purpose is to fail would be a provider by type, so
    // every later reader would have to know it was not one — and a zero vector
    // or a constant score would be worse: a wrong answer rather than none.
    for (const { path, source } of modules) {
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      for (const forbidden of [
        'AlwaysFail',
        'alwaysFail',
        'UnavailableProvider',
        'unavailableProvider',
        'NullProvider',
        'nullProvider',
        'DummyProvider',
        'dummyProvider',
        'FakeProvider',
        'fakeProvider',
        'NoopProvider',
        'noopProvider',
        'StubProvider',
        'stubProvider',
      ]) {
        expect(`${path}:${code.includes(forbidden)}`).toBe(`${path}:false`);
      }
    }
  });

  it('lets a search neither generate an artifact nor wait behind one', async () => {
    const source = await readFile(join(SRC, 'runtime', 'retrieval-search-runtime.ts'), 'utf8');

    // A search reads. Generating on the way would turn a read into a write
    // holding a model call, and reusing the maintenance permit gate would let a
    // background sweep decide how long a person's search takes.
    for (const specifier of importsOf(source)) {
      for (const forbidden of [
        'retrieval-runtime',
        'retrieval-generation-coordinator',
        'retrieval-artifact-generation-service',
        'retrieval-artifact-maintenance',
        'retrieval-summary-service',
      ]) {
        expect(`${specifier} pulls ${forbidden}:${specifier.includes(forbidden)}`).toBe(
          `${specifier} pulls ${forbidden}:false`,
        );
      }
    }
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    // And no gate of its own, either: a second one would be a second thing to
    // reason about, protecting nothing a connection pool does not already bound.
    for (const forbidden of ['semaphore', 'Semaphore', 'permit', 'waiters', 'setInterval']) {
      expect(`${forbidden}:${code.includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it('keeps one search cache for the process, created where it is shared', async () => {
    const modules = await readModules(SRC);

    const creators = modules
      .filter(({ source }) => source.includes('createRetrievalSearchCache('))
      .map(({ path }) => path)
      .sort();

    // Created in the module that outlives a request and nowhere else. A cache
    // built inside `resolve` would be empty on arrival every time, which is the
    // one thing a five-minute cache must not be — and no test would notice,
    // because every result would still be correct.
    expect(creators).toEqual([
      'app/retrieval-search-cache.ts',
      'runtime/retrieval-search-runtime.ts',
    ]);
  });

  it('lets only the composition root know both the runtime and the transport', async () => {
    const modules = await readModules(SRC);

    for (const { path, source } of modules) {
      if (path === 'index.ts') {
        continue;
      }
      const specifiers = importsOf(source);
      const reachesRuntime = specifiers.some((specifier) => specifier.includes('runtime/'));
      // Transport asks for a service through a port and never assembles one, so
      // `src/http/` still holds no pool and no repository — the layering that
      // has held since Phase 2 must not end at the endpoint with the most
      // machinery behind it.
      if (path.startsWith('http/')) {
        expect(`${path} reaches a runtime:${reachesRuntime}`).toBe(
          `${path} reaches a runtime:false`,
        );
      }
    }

    const root = await readFile(join(SRC, 'index.ts'), 'utf8');
    const rootImports = importsOf(root);
    expect(rootImports).toContain('./runtime/retrieval-search-runtime.js');
    expect(rootImports).toContain('./http/index.js');
  });
});

describe('the provider failure classification', () => {
  it('keeps the vendor’s own failure words inside the provider directory', async () => {
    const modules = await readModules(SRC);

    // The general vendor guard already refuses the string `openai` outside
    // `providers/`, which covers the class names. This says the same thing from
    // the other direction and about the thing that matters: an HTTP status from
    // a provider must not exist above the boundary that translates it.
    for (const { path, source } of modules) {
      if (path.startsWith('providers/')) {
        continue;
      }
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      for (const forbidden of ['OpenAiRequestError', 'OpenAiResponseError', 'HTTP_ERROR']) {
        expect(`${path} names ${forbidden}:${code.includes(forbidden)}`).toBe(
          `${path} names ${forbidden}:false`,
        );
      }
    }
  });

  it('carries nothing but a kind out of a provider failure', async () => {
    const source = await readFile(join(SRC, 'domain', 'retrieval-provider-failure.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    // A provider error travels into logs, and the request that produced it held
    // somebody's Memory rendered as text along with the credential. So the
    // classified failure has one field, and the constructor takes one argument.
    for (const forbidden of ['status', 'cause', 'body', 'url', 'openai']) {
      expect(`${forbidden}:${code.toLowerCase().includes(forbidden)}`).toBe(`${forbidden}:false`);
    }
  });

  it('routes both search-path adapters through the one translation', async () => {
    for (const file of ['embedding-provider.ts', 'structural-reranker.ts']) {
      const source = await readFile(join(SRC, 'providers', 'openai', file), 'utf8');
      // Wrapping the whole call, not each throw: a check added inside an
      // adapter is classified without anyone remembering to classify it.
      expect(source, file).toContain('withClassifiedOpenAiFailures(');
    }
  });

  it.each([
    ['retrieval-vector-search-service.ts', 'embeddingProvider.embed'],
    ['retrieval-structural-rerank-service.ts', 'reranker.rerank'],
  ])('makes %s ask before it degrades', async (file, call) => {
    const source = await readFile(join(SRC, 'app', file), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    // The finding this guard exists for: both used to catch every throw and
    // report the channel unavailable, so a provider that answered unusably was
    // indistinguishable from one that was never configured.
    expect(code, file).toContain('isRetrievalProviderIntegrationFailure(');

    // And the catch around the *port call* must bind what it caught. A bare
    // `catch {` there discards the very thing the branch is decided from, and
    // it is what both of these used to have. Other bare catches in these files
    // are fine and deliberate — a local parse failure carries no classification
    // to read.
    const callAt = code.indexOf(`await ${call}(`);
    expect(callAt, `${file} does not call the port`).toBeGreaterThan(-1);
    const afterTheCall = code.slice(callAt, callAt + 200);

    expect(`${file} binds the failure:${afterTheCall.includes('} catch (')}`).toBe(
      `${file} binds the failure:true`,
    );
    expect(`${file} discards the failure:${afterTheCall.includes('} catch {')}`).toBe(
      `${file} discards the failure:false`,
    );
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
      // How many usage rows a search tried to write and lost. A number this
      // codebase counted, and the only thing that makes the loss visible at
      // all — the caller got its candidates and has no reason to know.
      'attemptedRows',
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
    expect(calls[0]![2]).toContain(
      'formatStartupSummary(buildStartupSummary(env, configuredRetrieval.enabled))',
    );
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
    // The search route is the second transport module, added by P5-02c. It is
    // there for one line: a search that answered whose usage record was lost.
    // The pipeline hands that failure up as a closed report rather than logging
    // it itself, precisely so the writing stays at this boundary.
    //
    // That is what keeps the two kinds of log apart without needing a rule
    // about it. UsageLog and ChangeLog are Memory data: rows an owner reads,
    // exports and deletes. Mirroring them into the process log would copy
    // Memory content somewhere none of those operations reach, and writing
    // process events into them would make Memory the place operations get
    // audited — the Global Audit warehouse this module is not.
    expect(writers).toEqual(['http/app.ts', 'http/search-routes.ts', 'index.ts']);

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

  it('gives no caller a way to replace the query privacy policy', async () => {
    const source = await readFile(join(SRC, 'app', 'retrieval-vector-search-service.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    const factory = code.slice(code.indexOf('export function createRetrievalVectorSearchService('));
    const parameters = factory.slice(factory.indexOf('('), factory.indexOf('): RetrievalVector'));

    // The distinction this fixes: a policy parameter that defaults to the safe
    // one is still a way to pass an unsafe one, and "safe unless overridden"
    // is not a boundary. A caller handing in a policy that keeps everything
    // would turn "a credential is never transmitted to a provider" into a
    // suggestion. So the parameter list holds the provider and the reader and
    // nothing that could carry a policy.
    expect(
      parameters.includes('Policy'),
      'the factory accepts something that could be a policy',
    ).toBe(false);
    expect(
      parameters.includes('Detector'),
      'the factory accepts something that could be a detector',
    ).toBe(false);

    // And it is built inside, where nobody can reach it.
    expect(code).toContain('const queryPolicy = createSemanticQueryInspectionPolicy();');

    // Still through the sanitization boundary rather than from a detector:
    // what a credential looks like is not this module's knowledge to hold.
    expect(
      code.includes('createSecretDetector') || code.includes('SecretDetector'),
      'the service reaches for the detector directly',
    ).toBe(false);
  });
});

describe('hybrid candidate retrieval', () => {
  it('derives the vector service owner from its reader rather than a parameter', async () => {
    const source = await readFile(join(SRC, 'app', 'retrieval-vector-search-service.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // The owner exists on the service so a hybrid composition can compare the
    // two channels. It must report the scope that actually applies, not one a
    // caller asserted — so it comes from the reader and the factory has no
    // owner parameter to disagree with it.
    expect(code).toContain('ownerId: reader.ownerId');
    const factory = code.slice(code.indexOf('export function createRetrievalVectorSearchService('));
    const parameters = factory.slice(factory.indexOf('('), factory.indexOf('): RetrievalVector'));
    expect(parameters.includes('ownerId'), 'the factory accepts an owner id').toBe(false);
  });

  it('refuses to build channels that belong to different owners', async () => {
    const source = await readFile(join(SRC, 'app', 'retrieval-hybrid-search-service.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // Each channel is owner-safe alone and neither can check the other, so
    // only the pairing can be wrong. Checked once at construction: a
    // wrongly-built service should not exist rather than fail later on
    // somebody's query.
    expect(code).toContain('lexicalReader.ownerId !== vectorService.ownerId');
    const factory = code.slice(code.indexOf('export function createRetrievalHybridSearchService('));
    expect(factory.slice(0, factory.indexOf('return {'))).toContain('throw new Error');
  });

  it('fuses on ranks alone, never on either channel raw score', async () => {
    const source = await readFile(join(SRC, 'domain', 'retrieval-hybrid-search.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // The two scores disagree in scale and in direction, so arithmetic on them
    // is meaningless however careful it looks. Fusion reads position only.
    expect(code.includes('lexicalScore'), 'the fusion reads the lexical score').toBe(false);
    expect(code.includes('cosineDistance'), 'the fusion reads the cosine distance').toBe(false);
    expect(code).toContain('HYBRID_RRF_K');
  });

  it('keeps the fusion constants out of every caller reach', async () => {
    const domain = await readFile(join(SRC, 'domain', 'retrieval-hybrid-search.ts'), 'utf8');
    const service = await readFile(join(SRC, 'app', 'retrieval-hybrid-search-service.ts'), 'utf8');

    // A caller able to set k or the window could change what "most relevant"
    // means per call, which would make two searches of one Memory
    // incomparable and any later evaluation of the ranking meaningless.
    expect(domain).toContain('export const HYBRID_RRF_K = 10');
    expect(domain).toContain('export const HYBRID_SOURCE_LIMIT = 20');

    const request = service.slice(service.indexOf('export interface HybridSearchRequest {'));
    const requestBody = request.slice(0, request.indexOf('\n}'));
    for (const tunable of ['k', 'sourceLimit', 'depth', 'weight']) {
      expect(
        new RegExp(`\\b${tunable}\\b\\s*[?:]`).test(requestBody),
        `the request exposes ${tunable}`,
      ).toBe(false);
    }
  });

  it('leaves ranking and structural comparison to the stages that own them', async () => {
    const modules = await readModules(SRC);
    const code = modules
      .filter((module) => module.path.includes('retrieval-hybrid-search'))
      .map((module) => module.source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''))
      .join('\n');

    expect(code.length).toBeGreaterThan(0);
    // This stage narrows to a bounded candidate set. Weighing a Memory by how
    // trustworthy or how current it is, or comparing what the problems were
    // actually about, are separate later stages — and doing any of it here
    // would settle their questions with none of their information.
    for (const later of [
      'structuralFeatures',
      'confidence',
      'freshness',
      'suppressed',
      'importance',
      'symptoms',
      'suspectedBoundary',
      'problemDomain',
    ]) {
      expect(code.includes(later), `the hybrid stage already reads ${later}`).toBe(false);
    }
  });

  it('searches without writing or generating anything', async () => {
    for (const path of [
      join(SRC, 'domain', 'retrieval-hybrid-search.ts'),
      join(SRC, 'app', 'retrieval-hybrid-search-service.ts'),
    ]) {
      const source = await readFile(path, 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

      for (const forbidden of [
        'insert into',
        'update public.',
        'delete from',
        'createUsageLog',
        'createChangeLog',
        'upsertArtifact',
        'generateArtifact',
        'DatabaseTransactionRunner',
      ]) {
        expect(
          code.toLowerCase().includes(forbidden.toLowerCase()),
          `${path} contains ${forbidden}`,
        ).toBe(false);
      }
    }
  });

  it('degrades on an unreachable provider and on nothing else', async () => {
    const source = await readFile(join(SRC, 'app', 'retrieval-hybrid-search-service.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // Exactly one class is caught. Widening this to every semantic failure
    // would hide a provider returning nonsense, or a database error, behind a
    // result that looks like a complete search.
    expect(code).toContain('instanceof EmbeddingGenerationFailedError');
    expect(
      code.includes('InvalidEmbeddingProviderOutputError'),
      'the hybrid stage catches malformed provider output',
    ).toBe(false);
    // And the lexical channel has no degraded form at all.
    expect(code).toContain("lexicalSettled.status === 'rejected'");
  });

  it('validates everything before either channel starts', async () => {
    const source = await readFile(join(SRC, 'app', 'retrieval-hybrid-search-service.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // A malformed request must reach neither the database nor an embedding
    // provider — the latter being, under a real deployment, a network call
    // made on behalf of a request that was never going to succeed.
    const lexicalCheck = code.indexOf('resolveFullTextSearchQuery(');
    const semanticCheck = code.indexOf('resolveVectorSearchQuery(');
    const limitCheck = code.indexOf('resolveHybridSearchLimit(');
    const execution = code.indexOf('Promise.allSettled');

    for (const [label, at] of [
      ['the lexical text', lexicalCheck],
      ['the semantic text', semanticCheck],
      ['the limit', limitCheck],
    ] as const) {
      expect(at, `${label} is not checked`).toBeGreaterThan(-1);
      expect(at, `${label} is checked after the channels start`).toBeLessThan(execution);
    }
  });
});

describe('structural reranking', () => {
  /** The four modules this stage is made of, comments stripped. */
  async function rerankCode(): Promise<string> {
    const modules = await readModules(SRC);
    const code = modules
      .filter((module) => module.path.includes('retrieval-structural'))
      .map((module) => module.source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''))
      .join('\n');
    expect(code.length).toBeGreaterThan(0);
    return code;
  }

  it('gives the reranker port no way to reach storage', async () => {
    const source = await readFile(join(SRC, 'domain', 'retrieval-structural-rerank.ts'), 'utf8');
    const port = source.slice(source.indexOf('export interface StructuralReranker {'));
    const body = port.slice(0, port.indexOf('\n}'));

    // The same posture as the summary generator and the embedding provider: it
    // is handed a shape and returns a value. A reranker that could reach a
    // repository or an executor would be able to act on the Memory it is
    // judging.
    for (const reachable of ['Repository', 'Reader', 'Executor', 'DatabasePool', 'OwnerContext']) {
      expect(body.includes(reachable), `the reranker port can reach a ${reachable}`).toBe(false);
    }
    expect(body).toContain('StructuralRerankerInput');
  });

  it('shows the reranker structure and nothing another stage owns', async () => {
    const source = await readFile(join(SRC, 'domain', 'retrieval-structural-rerank.ts'), 'utf8');
    const input = source.slice(source.indexOf('export interface StructuralRerankerInput {'));
    const inputBody = input.slice(0, input.indexOf('\n}'));
    const candidate = source.slice(
      source.indexOf('export interface StructuralRerankerCandidate {'),
    );
    const candidateBody = candidate.slice(0, candidate.indexOf('\n}'));

    // A model shown which candidates the first stage liked could reproduce its
    // ordering; one shown the project could prefer the current one. Both are
    // decisions belonging to a later stage, and neither was asked of this one.
    for (const withheld of [
      'projectId',
      'fusionScore',
      'lexicalRank',
      'vectorRank',
      'hybridRank',
      'normalizedSummary',
      'keywords',
      'embedding',
      'limit',
      'threshold',
      'weight',
    ]) {
      expect(
        `${inputBody}\n${candidateBody}`.includes(withheld),
        `the reranker is sent ${withheld}`,
      ).toBe(false);
    }
    expect(inputBody).toContain('StructuralFeatures');
    expect(candidateBody).toContain('StructuralFeatures');
  });

  it('carries no reranker identity, because nothing here is stored', async () => {
    const code = await rerankCode();

    // The embedding model's identity is persisted because artifacts must be
    // regenerable when it changes. This stage writes nothing, so an identity
    // would be a field with no reader — added when logging or evaluation
    // actually needs one.
    for (const premature of ['rerankerId', 'rerankerVersion', 'modelId', 'modelVersion']) {
      expect(code.includes(premature), `the rerank stage records ${premature}`).toBe(false);
    }
  });

  it('gives no caller a way to replace the rerank privacy policy', async () => {
    const source = await readFile(
      join(SRC, 'app', 'retrieval-structural-rerank-service.ts'),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    const factory = code.slice(
      code.indexOf('export function createRetrievalStructuralRerankService('),
    );
    const parameters = factory.slice(
      factory.indexOf('('),
      factory.indexOf('): RetrievalStructural'),
    );

    // A policy parameter defaulting to the safe one is still a way to pass an
    // unsafe one, and "safe unless overridden" is not a boundary.
    expect(
      parameters.includes('Policy'),
      'the factory accepts something that could be a policy',
    ).toBe(false);
    expect(
      parameters.includes('Detector'),
      'the factory accepts something that could be a detector',
    ).toBe(false);
    expect(code).toContain('const inspectionPolicy = createStructuralRerankInspectionPolicy();');

    // And through the sanitization boundary rather than from a detector: what
    // a credential looks like is not this module's knowledge to hold.
    expect(
      code.includes('createSecretDetector') || code.includes('SecretDetector'),
      'the service reaches for the detector directly',
    ).toBe(false);
  });

  it('inspects the whole payload before any reranker could see it', async () => {
    const source = await readFile(
      join(SRC, 'app', 'retrieval-structural-rerank-service.ts'),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // Two of the three inputs have been through none of this system's write
    // checks — a caller's profile, and features read back out of storage — and
    // this is where they would leave the process.
    const inspectAt = code.indexOf('sanitizeValue(');
    const sendAt = code.indexOf('reranker.rerank(');
    expect(inspectAt).toBeGreaterThan(-1);
    expect(sendAt).toBeGreaterThan(-1);
    expect(inspectAt).toBeLessThan(sendAt);
    expect(code).toContain("'SKIPPED_SENSITIVE_INPUT'");
  });

  it('validates the request before the database or a model is touched', async () => {
    const source = await readFile(
      join(SRC, 'app', 'retrieval-structural-rerank-service.ts'),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    const checkAt = code.indexOf('resolveStructuralRerankRequest(');
    const readAt = code.indexOf('reader.readStructural(');
    const sendAt = code.indexOf('reranker.rerank(');
    expect(checkAt).toBeGreaterThan(-1);
    expect(checkAt).toBeLessThan(readAt);
    expect(checkAt).toBeLessThan(sendAt);
  });

  it('requires the answer to cover every candidate exactly once', async () => {
    const source = await readFile(join(SRC, 'domain', 'retrieval-structural-rerank.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // Allowing omissions would put a hidden threshold inside the model. This
    // stage has none on purpose, so a candidate with nothing in common is
    // ranked last rather than made to disappear.
    expect(code).toContain('seen.size !== wanted.size');
    expect(code).toContain("'a candidate appears twice'");
    expect(code).toContain("'a candidate was not one of the inputs'");
  });

  it('checks that a claimed dimension had something on both sides', async () => {
    const source = await readFile(join(SRC, 'domain', 'retrieval-structural-rerank.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // Availability, not agreement. A model may not name a dimension that is
    // empty on one side or the other — an empty `successful_directions` in
    // particular means the record does not support a claim, so citing it as a
    // match reports two Problems as alike where at least one says nothing.
    expect(code).toContain('function comparisonMaterialExists(');
    expect(code).toContain("'a matched dimension has nothing to compare'");

    // And the check reads what was sent, so it cannot be run against a set
    // that has drifted from the one the model saw.
    expect(code).toContain('input: StructuralRerankerInput');

    // What it must not do is decide the match itself. Comparing the text here
    // would be lexical overlap scoring — the thing structural reranking exists
    // to avoid — arriving as a validation rule instead.
    const helper = code.slice(code.indexOf('function comparisonMaterialExists('));
    const body = helper.slice(0, helper.indexOf('\n}'));
    for (const overreach of ['toLowerCase', 'includes(', 'some(', 'trim(', '===  ']) {
      expect(
        body.includes(overreach),
        `the availability check compares content with ${overreach}`,
      ).toBe(false);
    }
  });

  it('reports the position the first stage gave a candidate, not an index', async () => {
    const source = await readFile(
      join(SRC, 'app', 'retrieval-structural-rerank-service.ts'),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // `hybridRank` is provenance. Numbering the survivors of the re-read would
    // rewrite the earlier stage's answer and hide the gap that says a
    // candidate disappeared between the two stages.
    expect(code).toContain('const ranks = hybridRanks(request.candidates);');
    expect(code).toContain('ranks.get(candidate.problemId)');
    expect(code.includes('hybridRank: index + 1'), 'a rank is taken from a survivor index').toBe(
      false,
    );
    expect(
      /present\.map\(\(candidate, index\)/.test(code),
      'the scored list still walks the survivors with an index',
    ).toBe(false);
  });

  it('applies the cut itself and offers no tunable to a caller', async () => {
    const domain = await readFile(join(SRC, 'domain', 'retrieval-structural-rerank.ts'), 'utf8');
    const service = await readFile(
      join(SRC, 'app', 'retrieval-structural-rerank-service.ts'),
      'utf8',
    );

    expect(domain).toContain('export const DEFAULT_STRUCTURAL_RERANK_LIMIT = 5');
    expect(domain).toContain('export const MIN_STRUCTURAL_RERANK_LIMIT = 1');
    expect(domain).toContain('export const MAX_STRUCTURAL_RERANK_LIMIT = 5');
    expect(service).toContain('orderStructuralCandidates(scored, resolved.limit)');

    // A similarity threshold is the one knob this stage must not have: it
    // would decide that a Memory is not worth offering using less information
    // than the ranking stage will have.
    const request = domain.slice(domain.indexOf('export interface StructuralRerankRequest {'));
    const requestBody = request.slice(0, request.indexOf('\n}'));
    for (const tunable of ['threshold', 'weight', 'k', 'temperature', 'prompt']) {
      expect(
        new RegExp(`\\b${tunable}\\b\\s*[?:]`).test(requestBody),
        `the request exposes ${tunable}`,
      ).toBe(false);
    }
  });

  it('leaves ranking to the stage that owns it', async () => {
    const code = await rerankCode();

    // Structural similarity is one input to ranking, not ranking. Weighing how
    // trustworthy, how current or how close to hand a Memory is here would
    // settle the ranking stage's questions with none of its information.
    for (const later of [
      'confidence',
      'freshness',
      'recency',
      'suppressed',
      'importance',
      'trustScore',
    ]) {
      expect(code.includes(later), `the rerank stage already weighs ${later}`).toBe(false);
    }
  });

  it('proposes nothing and applies nothing', async () => {
    const code = await rerankCode();

    // Turning a Memory into a suggested action, and applying one, are separate
    // later tasks with their own approval questions. A stage that quietly
    // began either would answer those questions by accident.
    for (const later of [
      'suggestion',
      'suggestedFix',
      'applyFix',
      'autoApply',
      'approval',
      'proposal',
      'actionPlan',
    ]) {
      expect(code.includes(later), `the rerank stage already does ${later}`).toBe(false);
    }
  });

  it('reranks without writing, locking or generating', async () => {
    for (const path of [
      join(SRC, 'domain', 'retrieval-structural-rerank.ts'),
      join(SRC, 'db', 'retrieval-structural-read.ts'),
      join(SRC, 'repository', 'retrieval-structural-reader.ts'),
      join(SRC, 'app', 'retrieval-structural-rerank-service.ts'),
    ]) {
      const source = await readFile(path, 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

      // In particular it never regenerates an artifact it failed to find:
      // that would turn a search into a generation at the moment somebody is
      // waiting for an answer.
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
        'for update',
      ]) {
        expect(
          code.toLowerCase().includes(forbidden.toLowerCase()),
          `${path} contains ${forbidden}`,
        ).toBe(false);
      }
    }
  });

  it('reads the owner and the read control again, in one statement', async () => {
    const { STRUCTURAL_ARTIFACT_STATEMENT } =
      await import('../src/db/retrieval-structural-read.js');

    // What was true when the first stage ran is not a filter now. And three
    // columns only: the summary, the keywords and the embedding are not needed
    // to compare structure, so this stage never handles them.
    expect(STRUCTURAL_ARTIFACT_STATEMENT).toContain('ra.owner_id = $1');
    expect(STRUCTURAL_ARTIFACT_STATEMENT).toContain('pr.owner_id = ra.owner_id');
    expect(STRUCTURAL_ARTIFACT_STATEMENT).toContain('pr.memory_read_enabled');
    expect(STRUCTURAL_ARTIFACT_STATEMENT).toContain('ra.problem_id = any($2::uuid[])');
    // The source-schema gate is a predicate, never a value this stage reads:
    // the fingerprint decides whether an artifact may be compared, and its
    // bytes still travel nowhere.
    expect(STRUCTURAL_ARTIFACT_STATEMENT).toContain('starts_with(ra.source_fingerprint, $3)');
    const selectList = STRUCTURAL_ARTIFACT_STATEMENT.slice(
      0,
      STRUCTURAL_ARTIFACT_STATEMENT.indexOf('from public.retrieval_artifacts'),
    );
    for (const unused of [
      'normalized_summary',
      'keywords',
      'embedding',
      'search_document',
      'source_fingerprint',
    ]) {
      expect(selectList.includes(unused), `the structural read pulls ${unused}`).toBe(false);
    }
  });

  it('adds no schema of its own', async () => {
    const migrations = join(process.cwd(), 'supabase', 'migrations');
    const files = await readdir(migrations);

    // Reranking reads columns that already exist. A migration arriving with it
    // would mean the stage had decided to store something, which it does not.
    for (const file of files) {
      const sql = (await readFile(join(migrations, file), 'utf8')).toLowerCase();
      expect(sql.includes('rerank'), `${file} was written for reranking`).toBe(false);
    }
  });

  it('ships no HTTP client and no vendor SDK of its own', async () => {
    const modules = await readModules(SRC);
    const stage = modules.filter((module) => module.path.includes('retrieval-structural'));
    expect(stage.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const module of stage) {
      const code = module.source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (/\bfetch\s*\(|node:http|node:https|undici|axios/.test(code)) {
        offenders.push(module.path);
      }
      for (const specifier of importsOf(module.source)) {
        if (/^(openai|@anthropic|@google|@mistral|cohere|@huggingface|langchain)/.test(specifier)) {
          offenders.push(`${module.path} -> ${specifier}`);
        }
      }
    }

    // The port exists so the model decision can be made later, by whoever has
    // a reason. Choosing a vendor here would make it for them.
    expect(offenders).toEqual([]);
  });
});

describe('retrieval ranking', () => {
  /** The four modules this stage is made of, comments stripped. */
  async function rankingCode(): Promise<string> {
    const modules = await readModules(SRC);
    const code = modules
      .filter((module) => module.path.includes('retrieval-ranking'))
      .map((module) => module.source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''))
      .join('\n');
    expect(code.length).toBeGreaterThan(0);
    return code;
  }

  it('decides the order with no model, no network and nothing to send', async () => {
    const modules = await readModules(SRC);
    const stage = modules.filter((module) => module.path.includes('retrieval-ranking'));
    expect(stage.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const module of stage) {
      const code = module.source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (/\bfetch\s*\(|node:http|node:https|undici|axios/.test(code)) {
        offenders.push(module.path);
      }
      for (const specifier of importsOf(module.source)) {
        if (/^(openai|@anthropic|@google|@mistral|cohere|@huggingface|langchain)/.test(specifier)) {
          offenders.push(`${module.path} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);

    // Every input is an enum, a boolean or a number that already exists, so
    // this stage is arithmetic. That is why it has no port to be unavailable
    // and — the reason the guard also names the policies — nothing crossing a
    // boundary that would need inspecting.
    const code = await rankingCode();
    for (const absent of [
      'Reranker',
      'EmbeddingProvider',
      'SummaryGenerator',
      'sanitizeValue',
      'InspectionPolicy',
      'SecretDetector',
    ]) {
      expect(code.includes(absent), `the ranking stage reaches for ${absent}`).toBe(false);
    }
  });

  it('reads the controls, and nothing an earlier stage owns', async () => {
    const { RANKING_METADATA_STATEMENT } = await import('../src/db/retrieval-ranking-read.js');

    // The owner and the read control are applied again: they were true when
    // the earlier stages ran, and that is a fact about then. The join to
    // `projects` is owner-scoped too, so a candidate cannot pick up somebody
    // else's technology label.
    expect(RANKING_METADATA_STATEMENT).toContain('pr.owner_id = $1');
    expect(RANKING_METADATA_STATEMENT).toContain('cp.owner_id = $1');
    expect(RANKING_METADATA_STATEMENT).toContain('pj.owner_id = pr.owner_id');
    expect(RANKING_METADATA_STATEMENT).toContain('pr.memory_read_enabled');
    expect(RANKING_METADATA_STATEMENT).toContain('pr.problem_id = any($3::uuid[])');

    // What it must not pull. Timestamps especially: currency is what
    // `freshness` says it is, and a clock implying otherwise would be a second
    // opinion nobody asked for.
    for (const unused of [
      'importance',
      'pr.status',
      'fix_kind',
      'created_at',
      'updated_at',
      'generated_at',
      'environment_id',
      'retrieval_artifacts',
      'verifications',
      'events',
      'relations',
      'normalized_summary',
      'structural_features',
      'embedding',
    ]) {
      expect(RANKING_METADATA_STATEMENT.includes(unused), `the ranking read pulls ${unused}`).toBe(
        false,
      );
    }
  });

  it('takes the current Project and the candidates from one snapshot', async () => {
    const { RANKING_METADATA_STATEMENT } = await import('../src/db/retrieval-ranking-read.js');
    const service = await readFile(join(SRC, 'app', 'retrieval-ranking-service.ts'), 'utf8');
    const code = service.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // Every field the policy reads is editable. Two statements could compare a
    // Project's label against candidate rows that never coexisted with it.
    expect(RANKING_METADATA_STATEMENT).toContain('union all');
    expect((code.match(/reader\.read/g) ?? []).length).toBe(1);
  });

  it('weighs no importance, no status and no clock', async () => {
    const code = await rankingCode();

    // Importance is a separate axis the specification gives no ranking rule
    // for; status is already reflected in confidence, and boosting VERIFIED
    // again would count one piece of evidence twice. A timestamp would be a
    // "newer is better" policy nobody wrote down.
    for (const absent of [
      'importance',
      'VERIFIED',
      'fixKind',
      'createdAt',
      'updatedAt',
      'generatedAt',
      'Date.now',
      'new Date(',
    ]) {
      expect(code.includes(absent), `the ranking stage reads ${absent}`).toBe(false);
    }
  });

  it('adds no score and applies no threshold', async () => {
    const domain = await readFile(join(SRC, 'domain', 'retrieval-ranking.ts'), 'utf8');
    const code = domain.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // A weighted sum needs an exchange rate between "verified twice" and "0.3
    // more structurally similar", and there isn't one — so the ordering is a
    // tuple, and the guard is that no comparison invents a number.
    const comparator = code.slice(code.indexOf('export function rankCandidates('));
    expect(comparator.length).toBeGreaterThan(0);
    for (const weighting of ['weight', 'score +', '+ 0.', '* 0.', 'threshold', 'Math.']) {
      expect(comparator.includes(weighting), `the comparator uses ${weighting}`).toBe(false);
    }

    // And the ordinals are the specification's own value sets, in its order.
    expect(code).toContain("['HIGH', 'MEDIUM', 'LOW', 'CONFLICTED']");
    expect(code).toContain("['CURRENT', 'STALE_UNKNOWN', 'SUPERSEDED', 'INVALID']");
  });

  it('never turns a missing structural judgement into a score', async () => {
    const domain = await readFile(join(SRC, 'domain', 'retrieval-ranking.ts'), 'utf8');
    const code = domain.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // Two directions, one rule. When no rerank ran the comparison step is
    // skipped rather than defaulted; when one did, a missing score is refused
    // rather than filled in. Either coercion would make "nobody judged this"
    // indistinguishable from "judged, and found nothing in common".
    expect(code).toContain("const structureCounts = structuralStatus === 'USED'");
    expect(code).toContain('if (structureCounts) {');
    expect(code).toContain('a.structuralScore === null || b.structuralScore === null');
    expect(code).toContain('const structural = b.structuralScore - a.structuralScore;');

    // The code itself, not the comment above it: a guard that only read the
    // prose would have passed while the line below it coerced.
    const comparator = code.slice(code.indexOf('export function rankCandidates('));
    for (const coercion of [
      '?? 0',
      '??0',
      'Number(',
      'structuralScore || ',
      'structuralScore ?? ',
    ]) {
      expect(comparator.includes(coercion), `a missing score is coerced with ${coercion}`).toBe(
        false,
      );
    }
  });

  it('keeps the two positions apart', async () => {
    const domain = await readFile(join(SRC, 'domain', 'retrieval-ranking.ts'), 'utf8');
    const code = domain.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // `hybridRank` is where the first retrieval stage put a candidate and
    // keeps its gaps; `rankingRank` is this stage's final position and is
    // contiguous. Two facts, two fields.
    expect(code).toContain('rankingRank: index + 1');
    expect(code.includes('hybridRank: index'), 'the hybrid position is renumbered').toBe(false);
  });

  it('does not re-judge what the reranker judged', async () => {
    const domain = await readFile(join(SRC, 'domain', 'retrieval-ranking.ts'), 'utf8');
    const comparator = domain.slice(domain.indexOf('export function rankCandidates('));
    const body = comparator.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // Carried as provenance, never weighed. Counting matched dimensions would
    // be this stage answering a semantic question it was not asked.
    expect(body.includes('matchedDimensions'), 'the comparator reads matched dimensions').toBe(
      false,
    );
  });

  it('matches a technology label exactly, or not at all', async () => {
    const domain = await readFile(join(SRC, 'domain', 'retrieval-ranking.ts'), 'utf8');
    const helper = domain.slice(domain.indexOf('export function classifyProjectRelation('));
    const body = helper
      .slice(0, helper.indexOf('\n}'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    // Case folding and nothing else. Substring, token overlap or a synonym
    // table would be a technology-identity model invented inside a ranking
    // function, asserting a shared stack nobody claimed.
    expect(body).toContain('toLowerCase()');
    for (const stretch of ['includes(', 'startsWith', 'endsWith', 'replace(', 'split(', 'match(']) {
      expect(body.includes(stretch), `the technology match stretches with ${stretch}`).toBe(false);
    }
  });

  it('ranks without writing, caching or logging', async () => {
    for (const path of [
      join(SRC, 'domain', 'retrieval-ranking.ts'),
      join(SRC, 'db', 'retrieval-ranking-read.ts'),
      join(SRC, 'repository', 'retrieval-ranking-reader.ts'),
      join(SRC, 'app', 'retrieval-ranking-service.ts'),
    ]) {
      const source = await readFile(path, 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

      for (const forbidden of [
        'insert into',
        'update public.',
        'delete from',
        'createUsageLog',
        'createChangeLog',
        'upsertArtifact',
        'DatabaseTransactionRunner',
        'for update',
        'cache',
      ]) {
        expect(
          code.toLowerCase().includes(forbidden.toLowerCase()),
          `${path} contains ${forbidden}`,
        ).toBe(false);
      }
    }
  });

  it('leaves the later stages their own questions', async () => {
    const code = await rankingCode();

    // Currency is ranked on and reported; what to re-check about the current
    // environment belongs to the revalidation contract. Dead ends and
    // conflicts each have their own task, and a stage that started either
    // would answer their questions by accident.
    for (const later of [
      'mustRevalidate',
      'currentEnvironment',
      'historicalEnvironment',
      'deadEnd',
      'dead_end',
      'CONTRADICTS',
      'conflict',
      'suggestion',
      'applyFix',
      'approval',
    ]) {
      expect(code.includes(later), `the ranking stage already does ${later}`).toBe(false);
    }
  });

  it('fixes the owner at construction and takes no ranking input from a caller', async () => {
    const reader = await readFile(join(SRC, 'repository', 'retrieval-ranking-reader.ts'), 'utf8');
    const readerCode = reader.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(readerCode).toContain('ownerId: context.ownerId');

    const service = await readFile(join(SRC, 'app', 'retrieval-ranking-service.ts'), 'utf8');
    const factory = service.slice(
      service.indexOf('export function createRetrievalRankingService('),
    );
    const parameters = factory.slice(factory.indexOf('('), factory.indexOf('): RetrievalRanking'));
    expect(parameters.includes('ownerId'), 'the factory accepts an owner id').toBe(false);

    // The request carries identifiers and the structural result. Letting a
    // caller supply trust, currency or suppression would make the ranking
    // something a caller could arrange — and would miss a change made since
    // the previous stage ran.
    const domain = await readFile(join(SRC, 'domain', 'retrieval-ranking.ts'), 'utf8');
    const request = domain.slice(domain.indexOf('export interface RetrievalRankingRequest {'));
    const requestBody = request.slice(0, request.indexOf('\n}'));
    for (const supplied of ['confidence', 'freshness', 'suppressed', 'platform', 'ownerId']) {
      expect(
        new RegExp(`\\b${supplied}\\b`).test(requestBody),
        `the request carries ${supplied}`,
      ).toBe(false);
    }
  });

  it('adds no schema of its own', async () => {
    const migrations = join(process.cwd(), 'supabase', 'migrations');
    const files = await readdir(migrations);

    // Ranking reads columns that already exist.
    for (const file of files) {
      const sql = (await readFile(join(migrations, file), 'utf8')).toLowerCase();
      expect(sql.includes('ranking'), `${file} was written for ranking`).toBe(false);
    }
  });
});

describe('search caching', () => {
  /** The three modules this stage is made of, comments stripped. */
  async function cacheCode(): Promise<string> {
    const modules = await readModules(SRC);
    const code = modules
      .filter((module) => module.path.includes('retrieval-search-cache'))
      .map((module) => module.source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''))
      .join('\n');
    expect(code.length).toBeGreaterThan(0);
    return code;
  }

  it('stores searches in memory, with nothing to install and nothing to delete', async () => {
    const modules = await readModules(SRC);
    const stage = modules.filter(
      (module) =>
        module.path.includes('retrieval-search-cache') ||
        module.path.includes('retrieval-search-service'),
    );
    expect(stage.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const module of stage) {
      const code = module.source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      // A five-minute optimisation stored in a table would have to arrive with
      // a delete path, an export exclusion and a place in the deletion
      // guarantees — all so something disposable could survive a restart it
      // does not need to survive.
      for (const persistence of ['insert into', 'update public.', 'delete from', 'create table']) {
        if (code.toLowerCase().includes(persistence)) {
          offenders.push(`${module.path} -> ${persistence}`);
        }
      }
      for (const specifier of importsOf(module.source)) {
        if (/^(redis|ioredis|memcached|lru-cache|node-cache|keyv|@upstash)/.test(specifier)) {
          offenders.push(`${module.path} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('adds no migration and no dependency', async () => {
    const migrations = join(process.cwd(), 'supabase', 'migrations');
    for (const file of await readdir(migrations)) {
      const sql = (await readFile(join(migrations, file), 'utf8')).toLowerCase();
      expect(sql.includes('cache'), `${file} was written for caching`).toBe(false);
    }

    const manifest = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      '@fastify/swagger',
      'fastify',
      'pg',
    ]);
  });

  it('keeps nothing of the search it was asked about', async () => {
    const domain = await readFile(join(SRC, 'domain', 'retrieval-search-cache.ts'), 'utf8');
    const entry = domain.slice(domain.indexOf('export interface RetrievalSearchCacheEntry {'));
    const entryBody = entry.slice(0, entry.indexOf('\n}'));

    // A query may contain credential-shaped text, and that is safe only
    // because a query is used and discarded. An entry holds a result and an
    // expiry, so it stays safe.
    for (const raw of [
      'lexicalText',
      'semanticText',
      'currentFeatures',
      'canonicalSource',
      'normalizedSummary',
      'keywords',
      'embedding',
    ]) {
      expect(entryBody.includes(raw), `a cache entry carries ${raw}`).toBe(false);
    }
    expect(entryBody).toContain('StructuralRerankResult');
    expect(entryBody).toContain('expiresAt');
  });

  it('identifies a search by a digest that includes its owner', async () => {
    const domain = await readFile(join(SRC, 'domain', 'retrieval-search-cache.ts'), 'utf8');
    const code = domain.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    const compute = code.slice(code.indexOf('export function computeRetrievalSearchCacheKey('));
    const body = compute.slice(0, compute.indexOf('\n}'));

    // One process holds one cache for every owner, so the owner is what keeps
    // two people's searches apart.
    expect(body).toContain('input.ownerId');
    expect(body).toContain('input.currentProblemId');
    expect(body).toContain('input.understandingFingerprint');
    expect(body).toContain('input.lexicalText');
    expect(body).toContain('input.semanticText');
    expect(body).toContain('input.effectiveHybridLimit');
    expect(body).toContain('input.effectiveRerankLimit');
    expect(body).toContain("createHash('sha256')");

    // The digest is what is kept; the values are not.
    expect(body).toContain('JSON.stringify([');
  });

  it('normalises nothing about the search itself', async () => {
    const domain = await readFile(join(SRC, 'domain', 'retrieval-search-cache.ts'), 'utf8');
    const compute = domain.slice(domain.indexOf('export function computeRetrievalSearchCacheKey('));
    const body = compute
      .slice(0, compute.indexOf('\n}'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    // Two searches are the same only when they are the same. Folding case,
    // trimming or sorting a list here would answer one question with another
    // question's result.
    for (const invented of ['toLowerCase', 'trim(', '.sort(', 'normalize(', 'new Set(']) {
      expect(body.includes(invented), `the key invents an equivalence with ${invented}`).toBe(
        false,
      );
    }
  });

  it('bounds what it holds and how long it holds it', async () => {
    const domain = await readFile(join(SRC, 'domain', 'retrieval-search-cache.ts'), 'utf8');
    expect(domain).toContain('export const RETRIEVAL_SEARCH_CACHE_TTL_MS = 300_000');
    expect(domain).toContain('export const RETRIEVAL_SEARCH_CACHE_MAX_ENTRIES = 100');

    const app = await readFile(join(SRC, 'app', 'retrieval-search-cache.ts'), 'utf8');
    const code = app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // An unbounded map in a long-running process is a leak with a five-minute
    // fuse per entry and no ceiling at all.
    expect(code).toContain('entries.size > RETRIEVAL_SEARCH_CACHE_MAX_ENTRIES');
    // Reading refreshes recency and must not touch the expiry: a search
    // repeated every four minutes would otherwise never be recomputed.
    expect(code).toContain('entries.set(key, entry)');
    expect(code.includes('expiresAt: clock() + RETRIEVAL_SEARCH_CACHE_TTL_MS')).toBe(true);
    const get = code.slice(code.indexOf('get(key)'), code.indexOf('set(key, result)'));
    expect(get.includes('expiresAt:'), 'reading rewrites the expiry').toBe(false);
  });

  it('takes its clock from outside', async () => {
    const app = await readFile(join(SRC, 'app', 'retrieval-search-cache.ts'), 'utf8');
    const code = app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // Expiry is what this thing is about, and a test that has to sleep to see
    // it is slow and occasionally wrong. The default lives at the factory
    // boundary; nothing below reads a clock of its own.
    expect(code).toContain('clock: Clock = () => Date.now()');
    const body = code.slice(code.indexOf('const entries = new Map'));
    expect(body.includes('Date.now'), 'the cache reads a clock of its own').toBe(false);
    expect(body.includes('new Date('), 'the cache reads a clock of its own').toBe(false);
  });

  it('hands out copies in both directions', async () => {
    const app = await readFile(join(SRC, 'app', 'retrieval-search-cache.ts'), 'utf8');
    const code = app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // `readonly` is a compile-time courtesy that is gone at run time, so a
    // caller sorting the array it was handed would reorder the next caller's.
    expect((code.match(/copyStructuralRerankResult\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('receives its cache rather than building one per request', async () => {
    const service = await readFile(join(SRC, 'app', 'retrieval-search-service.ts'), 'utf8');
    const code = service.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // Everything else here is rebuilt per request. A cache constructed inside
    // would start empty every time — a working cache that never answers.
    const factory = code.slice(code.indexOf('export function createRetrievalSearchService('));
    const parameters = factory.slice(factory.indexOf('('), factory.indexOf('): RetrievalSearch'));
    expect(parameters).toContain('cache: RetrievalSearchCache');
    expect(code.includes('createRetrievalSearchCache('), 'the service builds its own cache').toBe(
      false,
    );
  });

  it('lets a caller name the Problem and nothing that could contradict it', async () => {
    const service = await readFile(join(SRC, 'app', 'retrieval-search-service.ts'), 'utf8');
    const request = service.slice(service.indexOf('export interface RetrievalSearchRequest {'));
    const body = request.slice(0, request.indexOf('\n}'));

    // The Project comes from the Problem's own row and the excluded Problem is
    // the current one, so neither can disagree with what was asked about.
    for (const supplied of [
      'ownerId',
      'currentProjectId',
      'excludeProblemId',
      'confidence',
      'freshness',
      'suppressed',
      'platform',
    ]) {
      expect(new RegExp(`\\b${supplied}\\b`).test(body), `the request carries ${supplied}`).toBe(
        false,
      );
    }
    expect(body).toContain('currentProblemId');
  });

  it('excludes the Problem from both stages, not just the one that shows', async () => {
    const service = await readFile(join(SRC, 'app', 'retrieval-search-service.ts'), 'utf8');
    const code = service.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // Both calls, and the count is the assertion. The rerank exclusion alone
    // keeps the Problem out of the answer, so dropping the hybrid one is
    // invisible in a result — while still letting the Problem occupy a slot in
    // the candidate window and crowd out a real Memory.
    expect((code.match(/excludeProblemId: request\.currentProblemId/g) ?? []).length).toBe(2);
  });

  it('refuses two reads of one Problem that disagree about its Project', async () => {
    const service = await readFile(join(SRC, 'app', 'retrieval-search-service.ts'), 'utf8');
    const code = service.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // A Problem cannot move between Projects, so this cannot happen — which is
    // exactly why it is checked rather than reconciled. Ranking on either
    // answer would rest on a contradiction, and the ranking uses the second
    // read's value.
    expect(code).toContain('after.projectId !== before.projectId');
    expect(code).toContain('rankAndReport(after.projectId');
  });

  it('reads the Problem again before it keeps anything', async () => {
    const service = await readFile(join(SRC, 'app', 'retrieval-search-service.ts'), 'utf8');
    const code = service.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // The two long calls leave a window an assistant appends Events into. An
    // answer to a question that has moved is reported, not stored.
    expect((code.match(/sourceReader\.readSource\(/g) ?? []).length).toBe(2);
    const secondRead = code.lastIndexOf('sourceReader.readSource(');
    expect(secondRead).toBeGreaterThan(code.indexOf('rerankService.rerank('));
    expect(secondRead).toBeLessThan(code.indexOf('cache.set('));
    expect(code).toContain("kind: 'CURRENT_SOURCE_CHANGED'");
  });

  it('keeps only a search that ran cleanly end to end', async () => {
    const service = await readFile(join(SRC, 'app', 'retrieval-search-service.ts'), 'utf8');
    const code = service.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // A provider outage or a skipped credential frozen for five minutes would
    // outlast its own cause.
    const eligible = code.slice(code.indexOf('function isCacheable('));
    expect(eligible).toContain("semanticStatus === 'USED'");
    expect(eligible).toContain("structuralStatus === 'USED'");
    expect(eligible).toContain("structuralStatus === 'NOT_NEEDED'");
    for (const degraded of [
      'PROVIDER_UNAVAILABLE',
      'SKIPPED_SENSITIVE_QUERY',
      'RERANKER_UNAVAILABLE',
      'STRUCTURAL_DATA_UNAVAILABLE',
      'SKIPPED_SENSITIVE_INPUT',
    ]) {
      expect(eligible.includes(degraded), `a ${degraded} search is kept`).toBe(false);
    }
    expect(code).toContain('if (isCacheable(');

    // And only after the last stage has succeeded. A result stored before
    // ranking ran would be a partial answer with a five-minute life.
    const ranked = code.indexOf('const outcome = await rankAndReport(');
    const stored = code.indexOf('cache.set(');
    expect(ranked, 'the search does not finish before it is stored').toBeGreaterThan(-1);
    expect(ranked).toBeLessThan(stored);
  });

  it('ranks on every search, cached or not', async () => {
    const service = await readFile(join(SRC, 'app', 'retrieval-search-service.ts'), 'utf8');
    const code = service.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // The one function both paths go through, which is what makes "a reused
    // search still respects every control" true by construction rather than by
    // two code paths agreeing with each other.
    expect((code.match(/rankingService\.rank\(/g) ?? []).length).toBe(1);
    expect((code.match(/rankAndReport\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it('reports no cache status', async () => {
    const service = await readFile(join(SRC, 'app', 'retrieval-search-service.ts'), 'utf8');
    const outcome = service.slice(service.indexOf('export type RetrievalSearchOutcome ='));
    const body = outcome.slice(0, outcome.indexOf('\n\nexport interface'));

    // Whether an answer was recomputed is not something a caller acts on, and
    // a field saying so would be a product promise made for tests.
    for (const observability of ['cacheStatus', 'cacheAge', 'fromCache', "'HIT'", "'MISS'"]) {
      expect(body.includes(observability), `the outcome reports ${observability}`).toBe(false);
    }
  });

  it('keeps the Project out of the document a fingerprint is taken over', async () => {
    const { RETRIEVAL_SUMMARY_SOURCE_STATEMENT } =
      await import('../src/db/retrieval-summary-source.js');

    // The Project is metadata for retrieval. Inside the canonical object it
    // would move every fingerprint and regenerate every artifact for a fact no
    // summary describes.
    const document = RETRIEVAL_SUMMARY_SOURCE_STATEMENT.slice(
      RETRIEVAL_SUMMARY_SOURCE_STATEMENT.indexOf('json_build_object'),
      RETRIEVAL_SUMMARY_SOURCE_STATEMENT.indexOf('as canonical_source'),
    );
    expect(document.includes('project_id'), 'the canonical document names the Project').toBe(false);
    expect(RETRIEVAL_SUMMARY_SOURCE_STATEMENT).toContain('pr.project_id as project_id');
  });

  it('adds no usage log, no HTTP surface and no later stage', async () => {
    const code = await cacheCode();
    const service = await readFile(join(SRC, 'app', 'retrieval-search-service.ts'), 'utf8');
    const both = `${code}\n${service.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')}`;

    for (const later of [
      'createUsageLog',
      'SEARCHED_LOG',
      'REFERENCED',
      'ADOPTED',
      'EXCLUDED',
      'mustRevalidate',
      'historicalEnvironment',
      'CONTRADICTS',
      'fastify',
    ]) {
      expect(both.includes(later), `the search stage already does ${later}`).toBe(false);
    }

    // The search service now names a dead-end stage, which is the whole point
    // of composing one. The cache itself still knows nothing about it — what
    // is remembered is the rerank result, and warnings are read fresh every
    // time.
    expect(code.includes('deadEnd'), 'the cache took on dead ends').toBe(false);
    expect(code.includes('DeadEnd'), 'the cache took on dead ends').toBe(false);
  });

  it('records only what a search can observe', async () => {
    const writer = await readFile(join(SRC, 'app', 'retrieval-usage-log-writer.ts'), 'utf8');
    const code = writer.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // A search sees that a Memory came back. Whether anybody then read it,
    // took its direction, set it aside, or changed course because of it
    // happens somewhere this code cannot see — and the four other actions are
    // observations, so inventing them from this one would make the log a
    // workflow it was deliberately not made into.
    expect(code).toContain("const SEARCHED: UsageAction = 'SEARCHED'");
    for (const unobserved of ['REFERENCED', 'ADOPTED', 'EXCLUDED', 'CHANGED_STRATEGY']) {
      expect(code.includes(unobserved), `the writer produces ${unobserved}`).toBe(false);
    }

    const service = await readFile(join(SRC, 'app', 'retrieval-search-service.ts'), 'utf8');
    const serviceCode = service.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const unobserved of ['REFERENCED', 'ADOPTED', 'EXCLUDED', 'CHANGED_STRATEGY']) {
      expect(serviceCode.includes(unobserved), `the search produces ${unobserved}`).toBe(false);
    }
  });

  it('gives the writer nowhere to put what was searched for', async () => {
    const writer = await readFile(join(SRC, 'app', 'retrieval-usage-log-writer.ts'), 'utf8');
    const input = writer.slice(writer.indexOf('export interface RecordSearchedInput {'));
    const body = input.slice(0, input.indexOf('\n}'));

    // A rule about what must not be logged is only as good as the next person
    // who reads it. A shape with nowhere to put the text is checked by the
    // compiler.
    for (const raw of [
      'lexicalText',
      'semanticText',
      'currentFeatures',
      'canonicalSource',
      'query',
      'ownerId',
      'normalizedSummary',
      'keywords',
      'embedding',
    ]) {
      expect(body.includes(raw), `the writer accepts ${raw}`).toBe(false);
    }
    expect(body).toContain('currentProblemId');
    expect(body).toContain('candidates');
  });

  it('composes a reason from closed vocabulary and nothing else', async () => {
    const writer = await readFile(join(SRC, 'app', 'retrieval-usage-log-writer.ts'), 'utf8');
    const compose = writer.slice(writer.indexOf('export function composeSearchedReason('));
    const body = compose
      .slice(0, compose.indexOf('\n}'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    // Five facts, all enums or small numbers. Trust, currency and suppression
    // decide an order rather than describing what looked similar; a raw
    // structural score is one model's internal number; the identifiers have
    // their own columns; a Project's technology label is the owner's free
    // text.
    for (const excluded of [
      'structuralScore',
      'confidence',
      'freshness',
      'suppressed',
      'hybridRank',
      'problemId',
      'projectId',
      'platform',
    ]) {
      expect(body.includes(excluded), `the reason carries ${excluded}`).toBe(false);
    }
    expect(body).toContain('rankingRank');
    expect(body).toContain('projectRelation');
    expect(body).toContain('semanticStatus');
    expect(body).toContain('structuralStatus');
    expect(body).toContain('matchedDimensions');

    // Neutral wording. The rerank guarantees both sides had content in a named
    // dimension, not that the contents agree — "matched" would claim a check
    // nobody performed.
    expect(body).toContain('comparison_dimensions=');
    expect(body.includes('matched_dimensions='), 'the reason claims a match').toBe(false);

    // And the status is what decides whether any are named, not the list on
    // its own. A rerank that did not run produces no dimensions today, so the
    // two agree — but that agreement is a fact about how the stage upstream
    // happens to be wired, and this function is exported.
    expect(body).toContain("structuralStatus !== 'USED'");
    const gate = body.indexOf("structuralStatus !== 'USED'");
    const fallback = body.indexOf('NO_COMPARISON_DIMENSIONS');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(fallback);
  });

  it('refuses an observation whose parts disagree', async () => {
    const writer = await readFile(join(SRC, 'app', 'retrieval-usage-log-writer.ts'), 'utf8');
    const code = writer.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // Safe on its own — the reason would say `none` regardless — so this is
    // not what keeps the row honest. It is what stops the contradiction being
    // accepted and half the caller's input silently dropped.
    expect(code).toContain("if (input.structuralStatus !== 'USED') {");
    expect(code).toContain('throw new ContradictorySearchObservationError()');

    // The refusal names nothing. Everything it could name belongs to
    // somebody's Memory, and an error travels.
    const error = writer.slice(writer.indexOf('export class ContradictorySearchObservationError'));
    const constructorBody = error.slice(0, error.indexOf('\n}'));
    for (const leak of ['problemId', 'projectId', 'sourceAi', 'matchedDimensions', '${']) {
      expect(constructorBody.includes(leak), `the refusal names ${leak}`).toBe(false);
    }
  });

  it('writes one search’s rows together, and wraps nothing else', async () => {
    const writer = await readFile(join(SRC, 'app', 'retrieval-usage-log-writer.ts'), 'utf8');
    const code = writer.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // Two of five rows would record a search that offered fewer Memories than
    // it did. And the transaction holds a connection, so it must not span the
    // provider or the model — both of which are long finished by here.
    expect(code).toContain('context.runInTransaction(');
    for (const outside of ['embed(', 'rerank(', 'hybridService', 'rerankService', 'cache.']) {
      expect(code.includes(outside), `the writer transaction reaches ${outside}`).toBe(false);
    }

    // Through the sanitized repository the context established, not past it.
    // `source_ai` is caller-derived text, so that boundary is doing real work
    // on this path.
    expect(code).toContain('repository.createUsageLog(');
    expect(code.includes("from '../db/"), 'the writer reaches the database directly').toBe(false);
  });

  it('reports a lost record in terms that carry nothing', async () => {
    const writer = await readFile(join(SRC, 'app', 'retrieval-usage-log-writer.ts'), 'utf8');
    const failure = writer.slice(writer.indexOf('export interface RetrievalUsageLogFailure {'));
    const body = failure.slice(0, failure.indexOf('\n}'));

    // A kind and a count. Both are values this code chose, and a failure
    // report travels to wherever an operator looks.
    expect(body).toContain("kind: 'SEARCH_USAGE_LOG_WRITE_FAILED'");
    expect(body).toContain('attemptedRows: number');
    for (const leak of [
      'Error',
      'message',
      'cause',
      'sourceAi',
      'ownerId',
      'problemId',
      'detail',
    ]) {
      expect(body.includes(leak), `the failure report carries ${leak}`).toBe(false);
    }

    // No default reporter. One that printed would choose an output nobody
    // asked for; one that did nothing would make silence the easiest thing to
    // get, which is the failure the port exists to prevent.
    const service = await readFile(join(SRC, 'app', 'retrieval-search-service.ts'), 'utf8');
    const code = service.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const factory = code.slice(code.indexOf('export function createRetrievalSearchService('));
    const parameters = factory.slice(factory.indexOf('('), factory.indexOf('): RetrievalSearch'));
    expect(parameters).toContain('usageLogFailureReporter: RetrievalUsageLogFailureReporter');
    expect(parameters.includes('= '), 'a collaborator is defaulted away').toBe(false);
    expect(code.includes('console.'), 'the search logs to a console').toBe(false);
  });

  it('lets a lost record stop neither the search nor its reuse', async () => {
    const service = await readFile(join(SRC, 'app', 'retrieval-search-service.ts'), 'utf8');
    const code = service.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // The search has already succeeded and the caller is holding an answer
    // that cost two network calls. Losing the record of it is a smaller loss
    // than throwing that away — but it is not silence: the catch reports.
    const recordAt = code.indexOf('async function recordSurfaced(');
    const record = code.slice(recordAt, code.indexOf('return {', recordAt));
    expect(record).toContain('usageLogFailureReporter.report(');
    expect(record.includes('throw'), 'a lost record fails the search').toBe(false);

    // On a miss the cache is filled first, so a lost log line cannot discard a
    // result worth reusing. Checked as "between the cache and the return"
    // rather than by position alone, so moving the call earlier cannot be
    // hidden by leaving a second one behind.
    const stored = code.indexOf('cache.set(');
    expect(stored).toBeGreaterThan(-1);
    const afterCache = code.slice(stored);
    const logged = afterCache.indexOf('recordSurfaced(');
    expect(logged, 'the miss path does not record after filling the cache').toBeGreaterThan(-1);
    expect(logged).toBeLessThan(afterCache.indexOf('return outcome;'));
  });

  it('records from the ranked candidates, on every search', async () => {
    const service = await readFile(join(SRC, 'app', 'retrieval-search-service.ts'), 'utf8');
    const code = service.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // Both paths record, and both record what ranking just produced — never
    // the cached rerank, which may still name a Memory since deleted or
    // switched off.
    expect((code.match(/await recordSurfaced\(/g) ?? []).length).toBe(2);
    expect(code).toContain('outcome.candidates');
    const recordAt = code.indexOf('async function recordSurfaced(');
    const record = code.slice(recordAt, code.indexOf('return {', recordAt));
    expect(record).toContain("outcome.kind !== 'SEARCHED' || outcome.candidates.length === 0");
  });

  it('keeps who is searching out of what makes a search the same search', async () => {
    const key = await readFile(join(SRC, 'domain', 'retrieval-search-cache.ts'), 'utf8');

    // Two assistants asking the same question of the same Problem get the same
    // Memories, and each is recorded under its own name. Putting the searcher
    // in the key would split the cache for no retrieval reason.
    expect(key.includes('sourceAi'), 'the cache key carries the searcher').toBe(false);

    const service = await readFile(join(SRC, 'app', 'retrieval-search-service.ts'), 'utf8');
    const request = service.slice(service.indexOf('export interface RetrievalSearchRequest {'));
    const requestBody = request.slice(0, request.indexOf('\n}'));
    expect(requestBody.includes('sourceAi'), 'the request carries the searcher').toBe(false);
    expect(service).toContain('export interface RetrievalSearchInvocation {');
  });

  it('leaves the lower stages and the generic reads write-free', async () => {
    const modules = await readModules(SRC);
    const lower = modules.filter(
      (module) =>
        module.path.includes('retrieval-hybrid-search') ||
        module.path.includes('retrieval-structural-rerank') ||
        module.path.includes('retrieval-ranking') ||
        module.path.includes('retrieval-full-text-search') ||
        module.path.includes('retrieval-vector-search'),
    );
    expect(lower.length).toBeGreaterThan(0);

    // The whole search is the operation somebody performed. A stage of it is
    // not, and a stage that logged would record several uses for one search.
    for (const module of lower) {
      expect(module.source.includes('UsageLog'), `${module.path} records usage of its own`).toBe(
        false,
      );
    }
  });

  it('adds no counter that would compete with the log', async () => {
    const modules = await readModules(SRC);
    const code = modules
      .filter((module) => module.path.includes('retrieval-'))
      .map((module) => module.source)
      .join('\n');

    // The rows are the event source. A count kept beside them would be a
    // second answer to the same question, and the two would disagree.
    for (const derived of ['use_count', 'useCount', 'lastUsedAt', 'searchCount', 'searchId']) {
      expect(code.includes(derived), `the retrieval path keeps ${derived}`).toBe(false);
    }
  });

  it('leaves the retry queue alone', async () => {
    const item = await readFile(join(SRC, 'reliability', 'item.ts'), 'utf8');

    // The queue replays writes that carry an idempotency key, and a usage log
    // has none — a replayed one would be a second row for one search. Adding a
    // key here would answer an adapter-retry question no adapter has asked.
    expect(item).toContain("readonly operation: 'appendEvent'");
    expect(item).toContain("readonly operation: 'appendVerification'");
    expect(item.includes('createUsageLog'), 'the queue replays usage logs').toBe(false);
    expect(item.includes("'recordSearched'"), 'the queue replays searches').toBe(false);
  });

  it('never decides whether a Memory is still true', async () => {
    const modules = await readModules(SRC);
    const stage = modules.filter((module) => module.path.includes('retrieval-revalidation'));
    expect(stage.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const module of stage) {
      const code = module.source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      // The things that would settle the question — a working tree, a package
      // manifest, a running process, a vendor's documentation — live where the
      // work is happening. Reaching for any of them here would move a
      // judgement to the one place that cannot make it.
      if (/\bfetch\s*\(|node:http|node:https|node:fs|undici|axios/.test(code)) {
        offenders.push(module.path);
      }
      for (const specifier of importsOf(module.source)) {
        if (
          /^(openai|@anthropic|@google|@mistral|cohere|langchain|node:fs|node:child_process)/.test(
            specifier,
          )
        ) {
          offenders.push(`${module.path} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);

    const code = stage
      .map((module) => module.source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''))
      .join('\n');
    for (const absent of [
      'EmbeddingProvider',
      'StructuralReranker',
      'isStale',
      'needsUpdate',
      'isSafe',
      'currentEnough',
    ]) {
      expect(code.includes(absent), `the revalidation stage produces ${absent}`).toBe(false);
    }
  });

  it('takes nothing from a caller about the present', async () => {
    const service = await readFile(join(SRC, 'app', 'retrieval-search-service.ts'), 'utf8');
    const request = service.slice(service.indexOf('export interface RetrievalSearchRequest {'));
    const body = request.slice(0, request.indexOf('\n}'));

    // Asking a caller for the current environment would put the comparison
    // here, where the answer cannot be checked — and the Problem's own stored
    // snapshot is not "now" either, it is another point in the past.
    for (const present of [
      'currentEnvironment',
      'currentCode',
      'currentVersion',
      'currentCommit',
      'currentSpec',
      'officialSpec',
      'currentDocumentation',
    ]) {
      expect(body.includes(present), `the request accepts ${present}`).toBe(false);
    }
  });

  it('keeps the checklist fixed and out of reach', async () => {
    const domain = await readFile(join(SRC, 'domain', 'retrieval-revalidation.ts'), 'utf8');
    const code = domain.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // Frozen because `readonly` is gone at run time and one array is shared by
    // every candidate of every search in the process.
    expect(code).toContain('export const REVALIDATION_CHECKS = Object.freeze([');
    expect(code).toContain("'CURRENT_CODE'");
    expect(code).toContain("'CURRENT_ENVIRONMENT'");
    expect(code).toContain("'RELEVANT_VERSION'");
    expect(code).toContain("'OFFICIAL_SPEC'");

    // And attached unconditionally. A checklist that shrank for a Memory the
    // record calls current would turn "always re-check" into "re-check when
    // the server is unsure", which is a much weaker promise.
    const service = await readFile(join(SRC, 'app', 'retrieval-revalidation-service.ts'), 'utf8');
    const serviceCode = service.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(serviceCode).toContain('requiredChecks: REVALIDATION_CHECKS');
    for (const condition of ['freshness', 'confidence', 'suppressed', 'projectRelation']) {
      expect(serviceCode.includes(condition), `the checklist depends on ${condition}`).toBe(false);
    }
  });

  it('returns the stored snapshot without interpreting it', async () => {
    const domain = await readFile(join(SRC, 'domain', 'retrieval-revalidation.ts'), 'utf8');
    const context = domain.slice(domain.indexOf('export interface RevalidationContext {'));
    const body = context.slice(0, context.indexOf('\n}'));

    // Which keys a snapshot carries is not fixed, so picking values out of it
    // would mean guessing at a schema that does not exist.
    expect(body).toContain('historicalEnvironment: EnvironmentSnapshot');
    for (const invented of [
      'os:',
      'runtime:',
      'framework:',
      'versions:',
      'browser:',
      'freshness',
    ]) {
      expect(body.includes(invented), `the context invents ${invented}`).toBe(false);
    }
  });

  it('reads the checks and nothing a later task owns', async () => {
    const { REVALIDATION_STATEMENT } = await import('../src/db/retrieval-revalidation-read.js');

    // Owner and read control re-applied — what was true when ranking ran is
    // not a filter now. The owner predicate sits in the join because a `where`
    // on a left-joined table turns it back into an inner join.
    expect(REVALIDATION_STATEMENT).toContain('pr.owner_id = $1');
    expect(REVALIDATION_STATEMENT).toContain('pr.memory_read_enabled');
    expect(REVALIDATION_STATEMENT).toContain('e.owner_id = pr.owner_id');
    expect(REVALIDATION_STATEMENT).toContain('v.owner_id = pr.owner_id');
    expect(REVALIDATION_STATEMENT).toContain('unnest($2::uuid[]) with ordinality');
    expect(REVALIDATION_STATEMENT).toContain('order by requested.position asc');
    expect(REVALIDATION_STATEMENT).toContain('v.created_at asc, v.verification_id asc');

    // Left joins, so a Problem that is gone and one whose Environment is
    // missing are distinguishable. An inner join would report the second as
    // the first.
    expect((REVALIDATION_STATEMENT.match(/left join/g) ?? []).length).toBe(3);

    // Dead ends and conflicts each have their own task.
    for (const later of ['public.events', 'public.relations', 'DEAD_END', 'CONTRADICTS']) {
      expect(REVALIDATION_STATEMENT.includes(later), `the read reaches ${later}`).toBe(false);
    }
  });

  it('raises rather than dropping a Problem with no conditions', async () => {
    const service = await readFile(join(SRC, 'app', 'retrieval-revalidation-service.ts'), 'utf8');
    const code = service.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // Short results are ordinary here, so a broken database must not be able
    // to hide inside one.
    expect(code).toContain('found.historicalEnvironment === undefined');
    expect(code).toContain('throw new MissingHistoricalEnvironmentError()');

    const gone = code.indexOf('found === undefined');
    const missing = code.indexOf('found.historicalEnvironment === undefined');
    expect(gone).toBeGreaterThan(-1);
    expect(missing).toBeGreaterThan(gone);
  });

  it('requires the positions it is given to be the order it is given', async () => {
    const service = await readFile(join(SRC, 'app', 'retrieval-revalidation-service.ts'), 'utf8');
    const code = service.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // Renumbering below reads a candidate's place in the array, which is only
    // correct if the array *was* the order. Reordered or gapped input would be
    // silently renumbered into something that agreed with neither — and this
    // service is exported, so the ranking stage producing 1, 2, 3 is a fact
    // about today's wiring rather than about the function.
    // One comparison carries it. The right-hand side is an integer, so a
    // fractional, infinite or `NaN` position fails this equality on its own —
    // a separate integer test could never be the reason a value was rejected.
    expect(code).toContain('candidate.rankingRank !== index + 1');
    expect(code).toContain("'their ranking positions are inconsistent'");

    // Before the database, so an unusable list costs nothing.
    const checked = code.indexOf('candidate.rankingRank !== index + 1');
    const read = code.indexOf('reader.readForCandidates(');
    expect(checked).toBeGreaterThan(-1);
    expect(checked).toBeLessThan(read);
  });

  it('renumbers the offered positions and leaves the provenance alone', async () => {
    const service = await readFile(join(SRC, 'app', 'retrieval-revalidation-service.ts'), 'utf8');
    const code = service.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // `rankingRank` is the position in the list actually offered, so it closes
    // up when something drops. `hybridRank` records where the first retrieval
    // stage put it and keeps its gaps.
    expect(code).toContain('rankingRank: offered.length + 1');
    expect(code.includes('hybridRank:'), 'the provenance is renumbered').toBe(false);
    // Rebuilt rather than edited, so the caller's array is not changed.
    expect(code).toContain('...candidate,');
    expect(code).toContain('matchedDimensions: [...candidate.matchedDimensions]');
  });

  it('enriches on every search and stores none of it', async () => {
    const service = await readFile(join(SRC, 'app', 'retrieval-search-service.ts'), 'utf8');
    const code = service.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // One call inside the function both a hit and a miss go through, so a
    // reused search gets context as fresh as a new one. A Verification on a
    // candidate does not move the current Problem's fingerprint, so a cached
    // enrichment would go stale without anything noticing.
    expect((code.match(/revalidationService\.enrich\(/g) ?? []).length).toBe(1);
    const ranked = code.indexOf('async function rankAndReport(');
    const enriched = code.indexOf('revalidationService.enrich(');
    expect(enriched).toBeGreaterThan(ranked);

    // The cache still holds the rerank result and nothing else.
    const key = await readFile(join(SRC, 'domain', 'retrieval-search-cache.ts'), 'utf8');
    for (const enrichment of ['historicalEnvironment', 'evidence', 'requiredChecks']) {
      expect(key.includes(enrichment), `the cache stores ${enrichment}`).toBe(false);
    }

    // And nothing is stored anywhere else either.
    for (const path of [
      join(SRC, 'domain', 'retrieval-revalidation.ts'),
      join(SRC, 'db', 'retrieval-revalidation-read.ts'),
      join(SRC, 'repository', 'retrieval-revalidation-reader.ts'),
      join(SRC, 'app', 'retrieval-revalidation-service.ts'),
    ]) {
      const source = await readFile(path, 'utf8');
      const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const forbidden of [
        'insert into',
        'update public.',
        'delete from',
        'createUsageLog',
        'createChangeLog',
        'appendVerification',
      ]) {
        expect(
          stripped.toLowerCase().includes(forbidden.toLowerCase()),
          `${path} contains ${forbidden}`,
        ).toBe(false);
      }
    }
  });

  it('leaves the ranking stage responsible for ranking only', async () => {
    const modules = await readModules(SRC);
    const ranking = modules.filter((module) => module.path.includes('retrieval-ranking'));
    expect(ranking.length).toBeGreaterThan(0);

    // The revalidation context hangs beside the ranking view rather than
    // inside it, so a stage's own type does not widen every time a later task
    // has something to add.
    for (const module of ranking) {
      for (const later of ['Environment', 'Verification', 'requiredChecks', 'revalidation']) {
        expect(module.source.includes(later), `${module.path} took on ${later}`).toBe(false);
      }
    }
  });

  it('adds no schema for what it reads', async () => {
    const migrations = join(process.cwd(), 'supabase', 'migrations');
    for (const file of await readdir(migrations)) {
      const sql = (await readFile(join(migrations, file), 'utf8')).toLowerCase();
      expect(sql.includes('revalidation'), `${file} was written for revalidation`).toBe(false);
    }
  });

  it('puts no invalidation hook into the write paths', async () => {
    const modules = await readModules(SRC);
    const writers = modules.filter(
      (module) =>
        module.path.includes('event-service') ||
        module.path.includes('verification-service') ||
        module.path.includes('problem-service') ||
        module.path.includes('project-environment-service'),
    );
    expect(writers.length).toBeGreaterThan(0);

    // Appending an Event already misses, because the key is built over the
    // Problem's canonical source. A hook would spread a cache dependency
    // through every write path and be forgotten by the next one added.
    for (const module of writers) {
      expect(module.source.includes('Cache'), `${module.path} knows about the search cache`).toBe(
        false,
      );
    }
  });
});

describe('dead ends', () => {
  /** The four modules this stage is made of. */
  const DEAD_END_PATHS = [
    join(SRC, 'domain', 'retrieval-dead-end.ts'),
    join(SRC, 'db', 'retrieval-dead-end-read.ts'),
    join(SRC, 'repository', 'retrieval-dead-end-reader.ts'),
    join(SRC, 'app', 'retrieval-dead-end-service.ts'),
  ];

  /** All four, comments stripped. */
  async function deadEndCode(): Promise<string> {
    const sources = await Promise.all(DEAD_END_PATHS.map((path) => readFile(path, 'utf8')));
    return sources
      .map((source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''))
      .join('\n');
  }

  it('reads the Events that recorded a dead end, and only those', async () => {
    const { DEAD_END_STATEMENT } = await import('../src/db/retrieval-dead-end-read.js');

    // The one Event type that means "this direction was tried and does not
    // lead anywhere". A `USER_CORRECTION` or an `ATTEMPT` warns nobody off
    // anything, and reading them as though they did would put words in the
    // record's mouth.
    expect(DEAD_END_STATEMENT).toContain("ev.event_type = 'DEAD_END'");
    for (const other of ['HYPOTHESIS', 'ATTEMPT', 'DISCOVERY', 'FIX', 'USER_CORRECTION']) {
      expect(DEAD_END_STATEMENT.includes(other), `the read also takes ${other}`).toBe(false);
    }

    // Owner and read control re-applied. What was visible when ranking ran is
    // not a filter now, and the predicates sit in the join because a `where`
    // on a left-joined table turns it back into an inner join.
    expect(DEAD_END_STATEMENT).toContain('pr.owner_id = $1');
    expect(DEAD_END_STATEMENT).toContain('pr.memory_read_enabled');
    expect(DEAD_END_STATEMENT).toContain('ev.owner_id = pr.owner_id');

    // Deterministic, oldest first, and stable when two share a moment.
    expect(DEAD_END_STATEMENT).toContain('unnest($2::uuid[]) with ordinality');
    expect(DEAD_END_STATEMENT).toContain('order by requested.position asc');
    expect(DEAD_END_STATEMENT).toContain('ev.created_at asc, ev.event_id asc');

    // Left joins, so a Problem that is gone and one with nothing recorded
    // against it stay distinguishable. An inner join would report the second
    // as the first, and the caller would lose a Memory rather than a warning.
    expect((DEAD_END_STATEMENT.match(/left join/g) ?? []).length).toBe(2);

    // No cap, no `limit`: cutting historical fact at some N would silently
    // drop the part somebody needed.
    expect(DEAD_END_STATEMENT.includes(' limit '), 'the read caps the warnings').toBe(false);
  });

  it('asks in one statement and asks nothing when there is nothing to ask about', async () => {
    const code = await readFile(join(SRC, 'db', 'retrieval-dead-end-read.ts'), 'utf8');
    const stripped = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // One query for every candidate, so the answer describes a state the
    // database really held rather than several it passed through.
    expect((stripped.match(/executor\.query/g) ?? []).length).toBe(1);
    expect(stripped).toContain('problemIds.length === 0');
  });

  it('warns and never forbids', async () => {
    const domain = await readFile(join(SRC, 'domain', 'retrieval-dead-end.ts'), 'utf8');
    const warning = domain.slice(domain.indexOf('export interface DeadEndWarning {'));
    const body = warning.slice(0, warning.indexOf('\n}'));

    // A direction that failed under one runtime or one library version may be
    // right under another, and the record cannot tell which. Anything here
    // that read as permission would turn a description of the past into a rule
    // about the present — which is exactly the judgement the revalidation
    // contract exists to hand back to the caller.
    for (const prohibition of [
      'retryBlocked',
      'retryAllowed',
      'blocked',
      'forbidden',
      'doNotTry',
      'hardBlock',
      'mustNotRetry',
      'approvalRequired',
      'severity',
      'notify',
      'notification',
      'alert',
      'warnLevel',
    ]) {
      expect(body.includes(prohibition), `a warning carries ${prohibition}`).toBe(false);
    }

    // What was tried, what happened, why, and where to look. Nothing about
    // whose assistant hit it, and none of the identifiers the candidate it
    // hangs from already carries.
    expect(body).toContain('summary: string');
    expect(body).toContain('createdAt: Date');
    for (const carried of ['eventId', 'ownerId', 'problemId', 'sourceAi', 'clientEventId']) {
      expect(body.includes(carried), `a warning repeats ${carried}`).toBe(false);
    }
  });

  it('never drops or reorders a Memory for having them', async () => {
    const service = await readFile(join(SRC, 'app', 'retrieval-dead-end-service.ts'), 'utf8');
    const code = service.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // The only reason a candidate is left out here is that the Memory itself
    // has gone since the stage before read it — never how much is recorded
    // against it. Sorting or filtering on the warnings would make an honest
    // record a liability.
    expect(code).toContain('warnings === undefined');
    for (const weighing of ['.sort(', 'deadEndWarnings.length >', 'penalt', 'score -=', 'demote']) {
      expect(code.includes(weighing), `the stage weighs warnings with ${weighing}`).toBe(false);
    }

    // Positions close up when something drops; the first stage's provenance
    // keeps its gaps. Rebuilt rather than edited, so the caller's array is
    // unchanged.
    //
    // Renumbering reads a candidate's place in the array, which is only
    // correct if the array *was* the order — so the input positions are
    // required to agree with it, and required before the database is asked, so
    // that an unusable list costs nothing. This service is exported, which is
    // why the previous stage producing 1, 2, 3 is not enough on its own.
    expect(code).toContain('candidate.ranking.rankingRank !== index + 1');
    const checked = code.indexOf('candidate.ranking.rankingRank !== index + 1');
    expect(checked).toBeGreaterThan(-1);
    expect(checked).toBeLessThan(code.indexOf('reader.readForCandidates('));
    expect(code).toContain('rankingRank: offered.length + 1');
    expect(code.includes('hybridRank:'), 'the provenance is renumbered').toBe(false);
    expect(code).toContain('matchedDimensions: [...candidate.ranking.matchedDimensions]');
  });

  it('leaves the earlier stages exactly as they were', async () => {
    const modules = await readModules(SRC);

    // Ranking is a deterministic tuple of stored controls, and a count of
    // recorded failures is not one of them. The dead-end comparison already
    // has its place: the reranker weighs it as one of seven dimensions, on
    // structure rather than on how many Events happen to exist.
    const ranking = modules.filter((module) => module.path.includes('retrieval-ranking'));
    expect(ranking.length).toBeGreaterThan(0);
    for (const module of ranking) {
      for (const later of ['deadEnd', 'DeadEnd', 'dead_end', 'DEAD_END', 'warning']) {
        expect(module.source.includes(later), `${module.path} took on ${later}`).toBe(false);
      }
    }
    const { STRUCTURAL_COMPARISON_DIMENSIONS } =
      await import('../src/domain/retrieval-structural-rerank.js');
    expect(STRUCTURAL_COMPARISON_DIMENSIONS).toContain('dead_end_directions');

    // And the checklist the previous task fixed is untouched — four checks,
    // asked for unconditionally, whatever is recorded against a Memory.
    const revalidation = await readFile(join(SRC, 'domain', 'retrieval-revalidation.ts'), 'utf8');
    expect(revalidation).toContain('export const REVALIDATION_CHECKS = Object.freeze([');
    for (const check of [
      'CURRENT_CODE',
      'CURRENT_ENVIRONMENT',
      'RELEVANT_VERSION',
      'OFFICIAL_SPEC',
    ]) {
      expect(revalidation).toContain(`'${check}'`);
    }
    const revalidationService = await readFile(
      join(SRC, 'app', 'retrieval-revalidation-service.ts'),
      'utf8',
    );
    expect(
      revalidationService.includes('deadEnd'),
      'the revalidation stage took on dead ends',
    ).toBe(false);
  });

  it('hangs the warnings off the envelope rather than inside a stage', async () => {
    const result = await readFile(join(SRC, 'domain', 'retrieval-result.ts'), 'utf8');

    // Neither stage owns the shape a search hands back. Left in the
    // revalidation module, that module would have had to widen every time a
    // later task had something to add.
    expect(result).toContain('export interface RevalidatedMemoryCandidate {');
    expect(result).toContain('export interface RetrievalMemoryCandidate extends');
    expect(result).toContain('deadEndWarnings: readonly DeadEndWarning[]');

    // Three fields and no more. Conflict comparison is the next task, and a
    // field landing here ahead of the stage that fills it would ship a shape
    // the server cannot honour.
    const bodyOf = (name: string): string => {
      const start = result.indexOf(`export interface ${name}`);
      expect(start, `${name} is missing`).toBeGreaterThan(-1);
      const body = result.slice(start);
      return body.slice(0, body.indexOf('\n}'));
    };
    const declared = (body: string): string[] =>
      [...body.matchAll(/^ {2}readonly (\w+)[?]?:/gm)].map((match) => match[1] ?? '');

    // Two fields, then three. Conflict comparison is the next task, and a
    // field landing here ahead of the stage that fills it would ship a shape
    // the server cannot honour.
    expect(declared(bodyOf('RevalidatedMemoryCandidate'))).toEqual(['ranking', 'revalidation']);
    expect(declared(bodyOf('DeadEndAwareMemoryCandidate'))).toEqual(['deadEndWarnings']);
    // The conflict field is the stage after this one and now belongs here; the
    // exact field sets above are what keep each stage to one addition. What
    // must stay out is anything that turns material into instruction —
    // measured on the declarations, since the prose explains that an empty
    // list is not a recommendation.
    const declarations = result.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const later of ['suggestion', 'approval', 'recommendation', 'action']) {
      expect(declarations.includes(later), `the envelope carries ${later}`).toBe(false);
    }

    const revalidation = await readFile(join(SRC, 'domain', 'retrieval-revalidation.ts'), 'utf8');
    expect(
      revalidation.includes('export interface RetrievalMemoryCandidate'),
      'the envelope stayed in the revalidation module',
    ).toBe(false);
  });

  it('takes them from the Events, never from the regenerable profile', async () => {
    const code = await deadEndCode();

    // `dead_end_directions` on an artifact is a summary generator's paraphrase,
    // rewritten whenever the artifact is regenerated and kept for structural
    // comparison. What a caller is warned with is what somebody recorded.
    expect(code).toContain('public.events');
    for (const derived of [
      'retrieval_artifacts',
      'structural_features',
      'dead_end_directions',
      'StructuralFeatures',
    ]) {
      expect(code.includes(derived), `the stage reads ${derived}`).toBe(false);
    }
  });

  it('writes nothing, calls nobody and reaches no later task', async () => {
    for (const path of DEAD_END_PATHS) {
      const source = await readFile(path, 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

      // Reading what a Memory already knows changes nothing about it, and a
      // usage log written from here would record a warning as a use.
      for (const forbidden of [
        'insert into',
        'update public.',
        'delete from',
        'appendEvent',
        'createUsageLog',
        'createChangeLog',
        'for update',
        'DatabaseTransactionRunner',
        'cache',
      ]) {
        expect(
          code.toLowerCase().includes(forbidden.toLowerCase()),
          `${path} has ${forbidden}`,
        ).toBe(false);
      }

      // Judging a dead end still current would need the working tree, the
      // manifest or a vendor's documentation — none of which are here. The
      // ambient process is on that list too: reading `process.env`, a runtime
      // version or a platform would be the server comparing the recorded
      // conditions against *its own* surroundings, which are not the ones the
      // caller is working in and never were.
      expect(/\bfetch\s*\(|node:http|node:https|node:fs|undici|axios/.test(code)).toBe(false);
      for (const ambient of [
        'process.env',
        'process.version',
        'process.platform',
        'process.cwd',
        'os.',
      ]) {
        expect(code.includes(ambient), `${path} reads ${ambient}`).toBe(false);
      }
      for (const specifier of importsOf(source)) {
        expect(
          /^(openai|@anthropic|@google|@mistral|cohere|langchain|node:fs|node:child_process)/.test(
            specifier,
          ),
          `${path} imports ${specifier}`,
        ).toBe(false);
      }

      // Conflicting Memories are the next task's question.
      for (const later of ['public.relations', 'CONTRADICTS', 'Relation', 'conflict']) {
        expect(code.includes(later), `${path} reaches ${later}`).toBe(false);
      }
    }
  });

  it('takes nothing from a caller about what is being attempted now', async () => {
    const service = await readFile(join(SRC, 'app', 'retrieval-search-service.ts'), 'utf8');
    const request = service.slice(service.indexOf('export interface RetrievalSearchRequest {'));
    const body = request.slice(0, request.indexOf('\n}'));

    // Accepting the direction about to be tried would invite this stage to
    // compare it against the recorded ones and answer "you may not" — a
    // judgement about the present, made where the present cannot be seen.
    for (const present of [
      'currentAction',
      'plannedAction',
      'attempt',
      'intendedFix',
      'currentEnvironment',
      'currentDirection',
    ]) {
      expect(body.includes(present), `the request accepts ${present}`).toBe(false);
    }
  });

  it('enriches on every search, stores none of it, and finishes before anything is kept', async () => {
    const service = await readFile(join(SRC, 'app', 'retrieval-search-service.ts'), 'utf8');
    const code = service.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // One call, inside the function both a hit and a miss go through. A
    // `DEAD_END` recorded against a *candidate* moves nothing the cache key
    // watches, so a remembered enrichment would keep sending people down a
    // direction that is by then known not to work.
    expect((code.match(/deadEndService\.enrich\(/g) ?? []).length).toBe(1);
    const ranked = code.indexOf('async function rankAndReport(');
    const enriched = code.indexOf('deadEndService.enrich(');
    expect(ranked).toBeGreaterThan(-1);
    expect(enriched).toBeGreaterThan(ranked);
    expect(enriched).toBeGreaterThan(code.indexOf('revalidationService.enrich('));

    // The cache still holds the rerank result and nothing else, and it is set
    // only after a search has run through this stage — a result stored before
    // the last stage succeeded would be a partial answer with a five-minute
    // life. The log follows for the same reason: it must describe what was
    // offered, which is not known until the drops here have happened.
    const key = await readFile(join(SRC, 'domain', 'retrieval-search-cache.ts'), 'utf8');
    for (const enrichment of ['deadEnd', 'DeadEnd', 'warning']) {
      expect(key.includes(enrichment), `the cache stores ${enrichment}`).toBe(false);
    }
    const reported = code.indexOf('await rankAndReport(after.projectId');
    const stored = code.indexOf('cache.set(key, reranked)');
    expect(reported).toBeGreaterThan(-1);
    expect(stored).toBeGreaterThan(reported);

    // The log follows by data dependency rather than by luck of ordering: it
    // is handed the finished outcome, on both paths, and records the ranking
    // view of exactly the candidates that survived this stage. A Memory
    // dropped here is absent from the list and so absent from the log.
    expect(code).toContain('await recordSurfaced(request.currentProblemId, sourceAi, reused)');
    expect(code).toContain('await recordSurfaced(request.currentProblemId, sourceAi, outcome)');
    expect((code.match(/recordSurfaced\(request\.currentProblemId/g) ?? []).length).toBe(2);
    expect(code).toContain('candidates: outcome.candidates.map((candidate) => candidate.ranking)');
    const reused = code.indexOf('const reused = await rankAndReport(before.projectId');
    expect(reused).toBeGreaterThan(-1);
    expect(
      code.indexOf('recordSurfaced(request.currentProblemId, sourceAi, reused)'),
    ).toBeGreaterThan(reused);
    expect(
      code.indexOf('recordSurfaced(request.currentProblemId, sourceAi, outcome)'),
    ).toBeGreaterThan(reported);
  });

  it('adds no schema, no contract and no dependency', async () => {
    const migrations = join(process.cwd(), 'supabase', 'migrations');
    for (const file of await readdir(migrations)) {
      const sql = (await readFile(join(migrations, file), 'utf8')).toLowerCase();
      expect(sql.includes('dead_end_warning'), `${file} was written for dead ends`).toBe(false);
    }

    // `DEAD_END` is already an Event type and the columns already exist, so
    // there is nothing to migrate.
    //
    // P5-02c published this, and in exactly one place. The warning is part of
    // what a search candidate carries — a direction that did not work, and
    // under what conditions — so it belongs to the search surface and to no
    // other route. `deadEndSummary` on the close-problem route is a different
    // thing and predates all of this: what a person writes when they close a
    // Problem.
    const routes = await readModules(join(SRC, 'http'));
    // Where each may appear, written out rather than derived. `RetrievalDeadEnd`
    // is the internal stage's name and stays internal.
    const allowedIn: Record<string, readonly string[]> = {
      deadEndWarnings: ['http/search-resources.ts'],
      DeadEndWarning: ['http/search-resources.ts'],
      RetrievalDeadEnd: [],
    };
    for (const [exposed, allowed] of Object.entries(allowedIn)) {
      const found = routes
        .filter((module) => module.source.includes(exposed))
        .map((module) => module.path)
        .sort();
      expect(found, `where ${exposed} appears`).toEqual([...allowed].sort());
    }

    const manifest = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies).sort()).toEqual([
      '@fastify/swagger',
      'fastify',
      'pg',
    ]);
  });
});

describe('conflicts', () => {
  /** The four modules this stage is made of. */
  const CONFLICT_PATHS = [
    join(SRC, 'domain', 'retrieval-conflict.ts'),
    join(SRC, 'db', 'retrieval-conflict-read.ts'),
    join(SRC, 'repository', 'retrieval-conflict-reader.ts'),
    join(SRC, 'app', 'retrieval-conflict-service.ts'),
  ];

  /** All four, comments stripped. */
  async function conflictCode(): Promise<string> {
    const sources = await Promise.all(CONFLICT_PATHS.map((path) => readFile(path, 'utf8')));
    return sources
      .map((source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''))
      .join('\n');
  }

  const bodyOf = (source: string, name: string): string => {
    const start = source.indexOf(`export interface ${name}`);
    expect(start, `${name} is missing`).toBeGreaterThan(-1);
    const body = source.slice(start);
    return body.slice(0, body.indexOf('\n}'));
  };

  const declared = (body: string): string[] =>
    [...body.matchAll(/^ {2}readonly (\w+)[?]?:/gm)].map((match) => match[1] ?? '');

  it('reads the links somebody recorded as disagreements, and only those', async () => {
    const { CONFLICT_STATEMENT } = await import('../src/db/retrieval-conflict-read.js');

    // One relation type. The other five mean something else entirely, and a
    // `SUPERSEDES` read as settling a disagreement would be the server
    // deciding an argument by walking a graph nobody asked it to walk.
    expect(CONFLICT_STATEMENT).toContain("rel.relation_type = 'CONTRADICTS'");
    for (const other of ['SIMILAR_TO', 'RELATED_TO', 'CAUSED_BY', 'SUPERSEDES', 'DERIVED_FROM']) {
      expect(CONFLICT_STATEMENT.includes(other), `the read also takes ${other}`).toBe(false);
    }

    // Both ends of the link, because `CONTRADICTS` reads the same both ways
    // and only one row is ever stored.
    expect(CONFLICT_STATEMENT).toContain(
      '(rel.from_id = pr.problem_id or rel.to_id = pr.problem_id)',
    );
    expect(CONFLICT_STATEMENT).toContain('when rel.from_id = pr.problem_id then rel.to_id');

    // Owner and read control at *both* ends. A link between two Problems is
    // not permission to read the second one.
    expect(CONFLICT_STATEMENT).toContain('pr.owner_id = $1');
    expect(CONFLICT_STATEMENT).toContain('pr.memory_read_enabled');
    expect(CONFLICT_STATEMENT).toContain('op.owner_id = rel.owner_id');
    expect(CONFLICT_STATEMENT).toContain('op.memory_read_enabled');
    expect(CONFLICT_STATEMENT).toContain('rel.owner_id = pr.owner_id');
    expect(CONFLICT_STATEMENT).toContain('v.owner_id = op.owner_id');

    // Deterministic, oldest first, stable when two share a moment.
    expect(CONFLICT_STATEMENT).toContain('unnest($2::uuid[]) with ordinality');
    expect(CONFLICT_STATEMENT).toContain('order by requested.position asc');
    expect(CONFLICT_STATEMENT).toContain('order by rel.created_at asc, rel.relation_id asc');
    expect(CONFLICT_STATEMENT).toContain('order by v.created_at asc, v.verification_id asc');

    // No cap: cutting the record of what disagrees at some N would silently
    // drop whichever disagreement somebody needed.
    expect(CONFLICT_STATEMENT.includes(' limit '), 'the read caps the disagreements').toBe(false);
    expect(CONFLICT_STATEMENT.includes('distinct'), 'the read merges disagreements').toBe(false);
  });

  it('goes one hop and stops', async () => {
    const { CONFLICT_STATEMENT } = await import('../src/db/retrieval-conflict-read.js');

    // The candidate's own relations, and nothing beyond the Problem at the far
    // end of each. A second traversal would make a search return a graph, and
    // a graph with cycles at that.
    expect((CONFLICT_STATEMENT.match(/public\.relations/g) ?? []).length).toBe(1);

    const code = await conflictCode();
    for (const traversal of ['listRelations', 'recurse', 'traverse', 'depth', 'visited']) {
      expect(code.includes(traversal), `the stage walks the graph with ${traversal}`).toBe(false);
    }

    // And the other Memory carries nothing that would nest another stage's
    // answer inside this one.
    const domain = await readFile(join(SRC, 'domain', 'retrieval-conflict.ts'), 'utf8');
    const snapshot = bodyOf(domain, 'ConflictMemorySnapshot');
    for (const recursive of ['deadEndWarnings', 'conflict', 'contradictions', 'requiredChecks']) {
      expect(snapshot.includes(recursive), `the snapshot nests ${recursive}`).toBe(false);
    }
  });

  it('reads in one statement and asks nothing when there is nothing to ask about', async () => {
    const code = await readFile(join(SRC, 'db', 'retrieval-conflict-read.ts'), 'utf8');
    const stripped = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // One query for the candidate, its links, each counterpart, each
    // counterpart's Environment and each counterpart's checks. The material is
    // meant to be compared, and two halves read at two moments would let a
    // reader see a difference that never existed at any single instant.
    expect((stripped.match(/executor\.query/g) ?? []).length).toBe(1);
    expect(stripped).toContain('problemIds.length === 0');
  });

  it('supplies comparison material and reaches no verdict', async () => {
    const code = await conflictCode();
    // Declarations only: the prose above them explains at length why there is
    // no winner here, and a guard that read the explanation as the offence
    // would forbid saying so.
    const domain = (await readFile(join(SRC, 'domain', 'retrieval-conflict.ts'), 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    // The specification says a conflict is not settled by majority: what gets
    // compared is the difference in environment, in version, in symptoms, the
    // stated reason, and the strength of the verification behind each. Every
    // one of those the server can supply; none is one it can judge.
    for (const verdict of [
      'winner',
      'loser',
      'preferred',
      'canonical',
      'resolved',
      'resolution',
      'conflictScore',
      'severity',
      'chooseThis',
      'ignoreOther',
      'notify',
      'notification',
      'hasConflict',
      'conflictState',
    ]) {
      expect(domain.includes(verdict), `the contract declares ${verdict}`).toBe(false);
    }
    for (const deciding of ['.sort(', 'Math.max', 'Math.min', 'rank(']) {
      expect(code.includes(deciding), `the stage decides with ${deciding}`).toBe(false);
    }

    // And the five materials are all named by the types.
    expect(domain).toContain('historicalEnvironment: EnvironmentSnapshot');
    expect(domain).toContain('symptoms: string');
    expect(domain).toContain('reason: string');
    expect(domain).toContain('evidence: readonly VerificationEvidence[]');
  });

  it('never drops or reorders a Memory for being contested', async () => {
    const service = await readFile(join(SRC, 'app', 'retrieval-conflict-service.ts'), 'utf8');
    const code = service.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // The only reason a candidate is left out here is that the Memory itself
    // has gone since the stage before read it — never how much disagrees with
    // it. A Memory that records its disagreements is not a worse Memory.
    expect(code).toContain('conflict === undefined');
    for (const weighing of [
      '.sort(',
      'contradictions.length >',
      'penalt',
      'demote',
      'confidence =',
      'freshness =',
    ]) {
      expect(code.includes(weighing), `the stage weighs conflicts with ${weighing}`).toBe(false);
    }

    // Renumbering reads a candidate's place in the array, which is only
    // correct if the array *was* the order — checked before the database, so
    // an unusable list costs nothing.
    expect(code).toContain('candidate.ranking.rankingRank !== index + 1');
    const checked = code.indexOf('candidate.ranking.rankingRank !== index + 1');
    expect(checked).toBeGreaterThan(-1);
    expect(checked).toBeLessThan(code.indexOf('reader.readForCandidates('));

    // Positions close up; the first stage's provenance keeps its gaps; the two
    // earlier enrichments travel through unchanged.
    expect(code).toContain('rankingRank: offered.length + 1');
    expect(code.includes('hybridRank:'), 'the provenance is renumbered').toBe(false);
    expect(code).toContain('matchedDimensions: [...candidate.ranking.matchedDimensions]');
    expect(code).toContain('revalidation: candidate.revalidation');
    expect(code).toContain('deadEndWarnings: candidate.deadEndWarnings');
  });

  it('keeps a record own conflict apart from a link between two', async () => {
    const code = await conflictCode();
    const modules = await readModules(SRC);

    // `CONFLICTED` is a statement about one record: it holds evidence pointing
    // both ways. A `CONTRADICTS` Relation is a link somebody stored between
    // two Problems. Neither implies the other, and this stage writes neither.
    expect(code.includes("'CONFLICTED'"), 'the stage acts on CONFLICTED').toBe(false);
    expect(code.includes('createRelation'), 'the stage writes a link').toBe(false);

    // The ranking view stays the single source for the confidence value, and
    // the ranking stage stays free of any of this.
    const ranking = modules.filter((module) => module.path.includes('retrieval-ranking'));
    expect(ranking.length).toBeGreaterThan(0);
    for (const module of ranking) {
      // Comments stripped: the ranking module explains that which Memories
      // disagree is a separate question, and saying so is not doing it.
      const source = module.source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const later of ['CONTRADICTS', 'contradiction', 'Contradiction', 'conflict']) {
        expect(source.includes(later), `${module.path} took on ${later}`).toBe(false);
      }
    }
    const { CONFIDENCES } = await import('../src/domain/enums.js');
    expect(CONFIDENCES).toEqual(['HIGH', 'MEDIUM', 'LOW', 'CONFLICTED']);
  });

  it('hangs the disagreements off the envelope, with an exact field set', async () => {
    const result = await readFile(join(SRC, 'domain', 'retrieval-result.ts'), 'utf8');

    // One stage, one field, and each intermediate named for the stage that
    // produced it. P4-14 is evaluation and adds nothing here.
    expect(declared(bodyOf(result, 'RevalidatedMemoryCandidate'))).toEqual([
      'ranking',
      'revalidation',
    ]);
    expect(declared(bodyOf(result, 'DeadEndAwareMemoryCandidate'))).toEqual(['deadEndWarnings']);
    expect(declared(bodyOf(result, 'RetrievalMemoryCandidate'))).toEqual(['conflict']);
    expect(result).toContain('extends DeadEndAwareMemoryCandidate');

    const domain = await readFile(join(SRC, 'domain', 'retrieval-conflict.ts'), 'utf8');
    expect(declared(bodyOf(domain, 'ConflictContext'))).toEqual(['subject', 'contradictions']);
    expect(declared(bodyOf(domain, 'Contradiction'))).toEqual([
      'reason',
      'relationCreatedAt',
      'other',
    ]);
    expect(declared(bodyOf(domain, 'ConflictSubject'))).toEqual([
      'symptoms',
      'problemDomain',
      'suspectedBoundary',
      'status',
      'fixKind',
    ]);
    expect(declared(bodyOf(domain, 'ConflictMemorySnapshot'))).toEqual([
      'problemId',
      'projectId',
      'symptoms',
      'problemDomain',
      'suspectedBoundary',
      'status',
      'fixKind',
      'confidence',
      'freshness',
      'historicalEnvironment',
      'evidence',
    ]);

    // The stored row's direction does not travel: `CONTRADICTS` reads the same
    // both ways, so which end it was written from is not a fact about the
    // disagreement.
    for (const stored of ['fromId', 'toId', 'relationId', 'relationType']) {
      expect(domain.includes(stored), `the contract exposes ${stored}`).toBe(false);
    }
  });

  it('writes nothing, calls nobody and reaches no later task', async () => {
    for (const path of CONFLICT_PATHS) {
      const source = await readFile(path, 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

      // Reading what disagrees with a Memory changes neither Memory, and a
      // usage log written from here would record a comparison as a use.
      for (const forbidden of [
        'insert into',
        'update public.',
        'delete from',
        'appendEvent',
        'appendVerification',
        'createUsageLog',
        'createChangeLog',
        'for update',
        'DatabaseTransactionRunner',
        'cache',
      ]) {
        expect(
          code.toLowerCase().includes(forbidden.toLowerCase()),
          `${path} has ${forbidden}`,
        ).toBe(false);
      }

      // Deciding which of two disagreeing Memories applies now would need the
      // working tree, the manifest or a vendor's documentation — and the
      // ambient process is on that list too, because this server's own
      // surroundings are not the ones the caller is working in.
      expect(/\bfetch\s*\(|node:http|node:https|node:fs|undici|axios/.test(code)).toBe(false);
      for (const ambient of [
        'process.env',
        'process.version',
        'process.platform',
        'process.cwd',
        'os.',
      ]) {
        expect(code.includes(ambient), `${path} reads ${ambient}`).toBe(false);
      }
      for (const specifier of importsOf(source)) {
        expect(
          /^(openai|@anthropic|@google|@mistral|cohere|langchain|node:fs|node:child_process)/.test(
            specifier,
          ),
          `${path} imports ${specifier}`,
        ).toBe(false);
      }

      // The regenerable search profile is not a source here either, for the
      // reason the dead-end stage gives: a paraphrase is not the record.
      for (const derived of [
        'retrieval_artifacts',
        'normalized_summary',
        'structural_features',
        'StructuralFeatures',
      ]) {
        expect(code.includes(derived), `${path} reads ${derived}`).toBe(false);
      }
    }
  });

  it('takes nothing from a caller about the present', async () => {
    const service = await readFile(join(SRC, 'app', 'retrieval-search-service.ts'), 'utf8');
    const request = service.slice(service.indexOf('export interface RetrievalSearchRequest {'));
    const body = request.slice(0, request.indexOf('\n}'));

    // Accepting what is being attempted, or the environment it is being
    // attempted in, would invite this stage to settle the disagreement — a
    // judgement about the present, made where the present cannot be seen.
    for (const present of [
      'currentAttempt',
      'plannedFix',
      'proposedDirection',
      'currentHypothesis',
      'currentEnvironment',
      'currentVersion',
      'currentSpec',
      'currentCode',
    ]) {
      expect(body.includes(present), `the request accepts ${present}`).toBe(false);
    }
  });

  it('enriches on every search, stores none of it, and finishes before anything is kept', async () => {
    const service = await readFile(join(SRC, 'app', 'retrieval-search-service.ts'), 'utf8');
    const code = service.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // One call, inside the function both a hit and a miss go through, and last
    // of the three. A Relation between two *candidates* moves nothing the
    // cache key watches — that key is built from the Problem being worked on —
    // so a remembered enrichment would keep two Memories looking agreed.
    expect((code.match(/conflictService\.enrich\(/g) ?? []).length).toBe(1);
    const ranked = code.indexOf('async function rankAndReport(');
    const enriched = code.indexOf('conflictService.enrich(');
    expect(ranked).toBeGreaterThan(-1);
    expect(enriched).toBeGreaterThan(ranked);
    expect(enriched).toBeGreaterThan(code.indexOf('revalidationService.enrich('));
    expect(enriched).toBeGreaterThan(code.indexOf('deadEndService.enrich('));

    // The cache still holds the rerank result and nothing else.
    const key = await readFile(join(SRC, 'domain', 'retrieval-search-cache.ts'), 'utf8');
    for (const enrichment of ['conflict', 'Conflict', 'contradiction', 'CONTRADICTS']) {
      expect(key.includes(enrichment), `the cache stores ${enrichment}`).toBe(false);
    }

    // It is filled, and the log written, only after a search has run through
    // this stage: a result stored before the last stage succeeded would be a
    // partial answer with a five-minute life, and the log must describe what
    // was offered, which is not known until the drops here have happened.
    const reported = code.indexOf('await rankAndReport(after.projectId');
    const stored = code.indexOf('cache.set(key, reranked)');
    expect(reported).toBeGreaterThan(-1);
    expect(stored).toBeGreaterThan(reported);
    expect(code).toContain('await recordSurfaced(request.currentProblemId, sourceAi, reused)');
    expect(code).toContain('await recordSurfaced(request.currentProblemId, sourceAi, outcome)');
    expect(code).toContain('candidates: outcome.candidates.map((candidate) => candidate.ranking)');
  });

  it('adds no schema, no contract and no dependency', async () => {
    const migrations = join(process.cwd(), 'supabase', 'migrations');
    for (const file of await readdir(migrations)) {
      const sql = (await readFile(join(migrations, file), 'utf8')).toLowerCase();
      // Not the bare word: `CONFLICTED` is a confidence value the schema has
      // had since the enums went in, and `on conflict` is ordinary SQL. What
      // must be absent is a table or column added for this stage.
      for (const added of ['conflict_', 'contradiction', 'table public.conflicts']) {
        expect(sql.includes(added), `${file} was written for conflicts`).toBe(false);
      }
    }

    // `CONTRADICTS` is already a relation type and every column already exists.
    //
    // P5-02c published the shape, and in exactly one place: a candidate carries
    // what contradicts it, because two memories that disagree are the case a
    // reader most needs to see rather than have decided for them. No other
    // route says any of it. Not the bare word either — `VERSION_CONFLICT` is
    // the optimistic-lock message and predates all of this.
    const routes = await readModules(join(SRC, 'http'));
    for (const exposed of ['ConflictContext', 'Contradiction', 'contradictions']) {
      const found = routes
        .filter((module) => module.source.includes(exposed))
        .map((module) => module.path)
        .sort();
      // One mapper, and no other route. A Problem read on its own says nothing
      // about what contradicts it; that comparison is a search's answer.
      expect(found, `where ${exposed} appears`).toEqual(['http/search-resources.ts']);
    }

    const manifest = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies).sort()).toEqual([
      '@fastify/swagger',
      'fastify',
      'pg',
    ]);
  });
});

describe('successful directions', () => {
  /** The three modules this stage is made of. */
  const DIRECTION_PATHS = [
    join(SRC, 'db', 'retrieval-successful-direction-read.ts'),
    join(SRC, 'repository', 'retrieval-successful-direction-reader.ts'),
    join(SRC, 'app', 'retrieval-successful-direction-service.ts'),
  ];

  async function directionCode(): Promise<string> {
    const sources = await Promise.all(DIRECTION_PATHS.map((path) => readFile(path, 'utf8')));
    return sources
      .map((source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''))
      .join('\n');
  }

  it('reads no Event, because no Event can establish this', async () => {
    const { SUCCESSFUL_DIRECTION_STATEMENT } =
      await import('../src/db/retrieval-successful-direction-read.js');

    // A `FIX` Event records that a fix was *tried*. Nothing links it to the
    // Verification that later passed, so a Problem with three fixes and one
    // successful check does not say which fix the check was about. Reading any
    // of them here would turn a recorded attempt into a proven success.
    expect(SUCCESSFUL_DIRECTION_STATEMENT.includes('public.events')).toBe(false);
    for (const eventish of ['FIX', 'DISCOVERY', 'USER_CORRECTION', 'DEAD_END', 'event_type']) {
      expect(
        SUCCESSFUL_DIRECTION_STATEMENT.includes(eventish),
        `the read reaches ${eventish}`,
      ).toBe(false);
    }
    // The same rule across all three modules, not just the statement: an Event
    // must not be reachable from any of them, however it is spelled.
    const code = await directionCode();
    for (const eventish of [
      'public.events',
      'appendEvent',
      "'FIX'",
      "'DISCOVERY'",
      "'USER_CORRECTION'",
      'event_type',
      'public.relations',
    ]) {
      expect(code.includes(eventish), `the stage reaches ${eventish}`).toBe(false);
    }
  });

  it('applies the same evidence gate the generator was held to, again', async () => {
    const { SUCCESSFUL_DIRECTION_STATEMENT } =
      await import('../src/db/retrieval-successful-direction-read.js');
    const code = await readFile(join(SRC, 'db', 'retrieval-successful-direction-read.ts'), 'utf8');
    const stripped = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // Status and a check that passed, read in the same statement as the
    // artifact — and the rule is imported rather than restated, so it cannot
    // drift from the one the generation path enforces.
    expect(SUCCESSFUL_DIRECTION_STATEMENT).toContain('pr.status as status');
    expect(SUCCESSFUL_DIRECTION_STATEMENT).toContain('and v.result');
    expect(SUCCESSFUL_DIRECTION_STATEMENT).toContain('v.owner_id = pr.owner_id');
    expect(stripped).toContain('requiresSuccessfulVerification(row.status)');
    expect(stripped).toContain('row.has_successful_verification === true');

    // The artifact records what was true when it was written and is never
    // rewritten when what it describes changes, so the generation-time gate is
    // not trusted for ever.
    expect(stripped).toContain('byProblem.set(problemId, [])');
  });

  it('takes the directions from the stored profile and parses them', async () => {
    const { SUCCESSFUL_DIRECTION_STATEMENT } =
      await import('../src/db/retrieval-successful-direction-read.js');
    const code = await readFile(join(SRC, 'db', 'retrieval-successful-direction-read.ts'), 'utf8');
    const stripped = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    expect(SUCCESSFUL_DIRECTION_STATEMENT).toContain('ra.structural_features');
    // Left-joined: the artifact is derived data, and a Memory without one is
    // still a Memory.
    expect(SUCCESSFUL_DIRECTION_STATEMENT).toContain('left join public.retrieval_artifacts ra');
    expect(SUCCESSFUL_DIRECTION_STATEMENT).toContain('pr.owner_id = $1');
    expect(SUCCESSFUL_DIRECTION_STATEMENT).toContain('pr.memory_read_enabled');
    expect(SUCCESSFUL_DIRECTION_STATEMENT).toContain('ra.owner_id = pr.owner_id');
    expect(SUCCESSFUL_DIRECTION_STATEMENT).toContain('unnest($2::uuid[]) with ordinality');
    // No cap and no de-duplication: the generator chose an order and repeating
    // itself is its own statement.
    expect(SUCCESSFUL_DIRECTION_STATEMENT.includes(' limit ')).toBe(false);
    expect(SUCCESSFUL_DIRECTION_STATEMENT.includes('distinct')).toBe(false);

    // Parsed rather than trusted: the column is `jsonb` and its type here is a
    // compile-time claim about a row an earlier version wrote.
    expect(stripped).toContain('parseStructuralFeatures(row.structural_features)');
    expect((stripped.match(/executor\.query/g) ?? []).length).toBe(1);
    expect(stripped).toContain('problemIds.length === 0');
  });

  it('never becomes an Event-shaped claim', async () => {
    const result = await readFile(join(SRC, 'domain', 'retrieval-result.ts'), 'utf8');
    const declarations = result.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // Plain strings. A summary, a result and a timestamp would dress a
    // generator's reading up as something somebody recorded at a moment.
    expect(declarations).toContain('readonly successfulDirections: readonly string[];');
    for (const shape of ['SuccessfulDirection[]', 'evidenceRef', 'createdAt', 'sourceAi']) {
      expect(
        declarations.includes(`successfulDirections: readonly ${shape}`),
        `the directions carry ${shape}`,
      ).toBe(false);
    }
    // And no module was created to give them one.
    const modules = await readModules(SRC);
    expect(
      modules.some((module) => module.path.includes('domain/retrieval-successful-direction')),
      'a domain module was created for a string array',
    ).toBe(false);
  });

  it('never drops or reorders a Memory for what it says worked', async () => {
    const service = await readFile(
      join(SRC, 'app', 'retrieval-successful-direction-service.ts'),
      'utf8',
    );
    const code = service.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // The only reason a candidate is left out is that the Memory itself has
    // gone. A Memory whose artifact has not been generated is kept, with an
    // empty list — derived data does not decide whether experience exists.
    expect(code).toContain('directions === undefined');
    for (const weighing of ['.sort(', 'directions.length >', 'penalt', 'demote', 'confidence =']) {
      expect(code.includes(weighing), `the stage weighs directions with ${weighing}`).toBe(false);
    }

    expect(code).toContain('candidate.ranking.rankingRank !== index + 1');
    const checked = code.indexOf('candidate.ranking.rankingRank !== index + 1');
    expect(checked).toBeLessThan(code.indexOf('reader.readForCandidates('));

    expect(code).toContain('rankingRank: offered.length + 1');
    expect(code.includes('hybridRank:'), 'the provenance is renumbered').toBe(false);
    expect(code).toContain('matchedDimensions: [...candidate.ranking.matchedDimensions]');
    expect(code).toContain('revalidation: candidate.revalidation');
    expect(code).toContain('deadEndWarnings: candidate.deadEndWarnings');
  });

  it('leaves the ranking stage free of it', async () => {
    const modules = await readModules(SRC);
    const ranking = modules.filter((module) => module.path.includes('retrieval-ranking'));
    expect(ranking.length).toBeGreaterThan(0);

    for (const module of ranking) {
      const source = module.source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const later of ['successfulDirection', 'successful_directions', 'SuccessfulDirection']) {
        expect(source.includes(later), `${module.path} took on ${later}`).toBe(false);
      }
    }
  });

  it('hangs the directions off the envelope, with an exact field set', async () => {
    const result = await readFile(join(SRC, 'domain', 'retrieval-result.ts'), 'utf8');

    const bodyOf = (name: string): string => {
      const start = result.indexOf(`export interface ${name}`);
      expect(start, `${name} is missing`).toBeGreaterThan(-1);
      const body = result.slice(start);
      return body.slice(0, body.indexOf('\n}'));
    };
    const declared = (body: string): string[] =>
      [...body.matchAll(/^ {2}readonly (\w+)[?]?:/gm)].map((match) => match[1] ?? '');

    // One stage, one field, each intermediate named for the stage that made it.
    expect(declared(bodyOf('RevalidatedMemoryCandidate'))).toEqual(['ranking', 'revalidation']);
    expect(declared(bodyOf('DeadEndAwareMemoryCandidate'))).toEqual(['deadEndWarnings']);
    expect(declared(bodyOf('SuccessfulDirectionAwareMemoryCandidate'))).toEqual([
      'successfulDirections',
    ]);
    expect(declared(bodyOf('RetrievalMemoryCandidate'))).toEqual(['conflict']);
    expect(result).toContain('extends SuccessfulDirectionAwareMemoryCandidate');

    // Nothing that turns material into instruction, and no Phase 5 field.
    const declarations = result.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const later of [
      'recommendation',
      'suggestion',
      'approval',
      'currentTruth',
      'retryAllowed',
      'adopt',
      'notification',
    ]) {
      expect(declarations.includes(later), `the envelope carries ${later}`).toBe(false);
    }
  });

  it('writes nothing, calls nobody and reads nothing about the present', async () => {
    for (const path of DIRECTION_PATHS) {
      const source = await readFile(path, 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

      for (const forbidden of [
        'insert into',
        'update public.',
        'delete from',
        'createUsageLog',
        'createChangeLog',
        'for update',
        'DatabaseTransactionRunner',
        'cache',
      ]) {
        expect(
          code.toLowerCase().includes(forbidden.toLowerCase()),
          `${path} has ${forbidden}`,
        ).toBe(false);
      }

      expect(/\bfetch\s*\(|node:http|node:https|node:fs|undici|axios/.test(code)).toBe(false);
      for (const ambient of ['process.env', 'process.version', 'process.platform', 'process.cwd']) {
        expect(code.includes(ambient), `${path} reads ${ambient}`).toBe(false);
      }
      for (const specifier of importsOf(source)) {
        expect(
          /^(openai|@anthropic|@google|@mistral|cohere|langchain|node:fs|node:child_process)/.test(
            specifier,
          ),
          `${path} imports ${specifier}`,
        ).toBe(false);
      }
    }
  });

  it('runs on every search, is stored nowhere, and finishes before anything is kept', async () => {
    const service = await readFile(join(SRC, 'app', 'retrieval-search-service.ts'), 'utf8');
    const code = service.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // One call, inside the function both a hit and a miss go through, between
    // the dead ends and the conflicts. A status change or a check appended
    // moves nothing the cache key watches, so a remembered answer would keep
    // offering a direction the record no longer supports.
    expect((code.match(/successfulDirectionService\.enrich\(/g) ?? []).length).toBe(1);
    const ranked = code.indexOf('async function rankAndReport(');
    const enriched = code.indexOf('successfulDirectionService.enrich(');
    expect(enriched).toBeGreaterThan(ranked);
    expect(enriched).toBeGreaterThan(code.indexOf('deadEndService.enrich('));
    expect(enriched).toBeLessThan(code.indexOf('conflictService.enrich('));

    const key = await readFile(join(SRC, 'domain', 'retrieval-search-cache.ts'), 'utf8');
    for (const enrichment of ['successfulDirection', 'successful_directions']) {
      expect(key.includes(enrichment), `the cache stores ${enrichment}`).toBe(false);
    }

    const reported = code.indexOf('await rankAndReport(after.projectId');
    expect(code.indexOf('cache.set(key, reranked)')).toBeGreaterThan(reported);
    expect(code).toContain('await recordSurfaced(request.currentProblemId, sourceAi, outcome)');
  });

  it('adds no schema, no HTTP surface and no dependency', async () => {
    const migrations = join(process.cwd(), 'supabase', 'migrations');
    for (const file of await readdir(migrations)) {
      const sql = (await readFile(join(migrations, file), 'utf8')).toLowerCase();
      expect(sql.includes('successful_direction'), `${file} was written for directions`).toBe(
        false,
      );
    }

    // Phase 4 ended with the retrieval surface still internal, because no
    // concrete generator, embedding provider or reranker was wired into
    // `src/index.ts` and a published route would have shipped a contract no
    // standard composition could answer. P5-02b wired the stack; P5-02c
    // published the route.
    //
    // So these are reachable now — through the search surface, and only there.
    // The service type reaches `app.ts` as well, as the name of the port the
    // route asks through: transport holds a resolver, never a pool.
    const routes = await readModules(join(SRC, 'http'));
    // Where each may appear, written out. The candidate material lives in the
    // one mapper; the service type is the name of the port the route asks
    // through, so it reaches the route and the dependency list beside it and
    // stops there.
    const allowedIn: Record<string, readonly string[]> = {
      successfulDirections: ['http/search-resources.ts'],
      RetrievalSearchService: ['http/app.ts', 'http/search-routes.ts'],
      'retrieval-search': ['http/search-resources.ts'],
    };
    for (const [exposed, allowed] of Object.entries(allowedIn)) {
      const found = routes
        .filter((module) => module.source.includes(exposed))
        .map((module) => module.path)
        .sort();
      expect(found, `where ${exposed} appears`).toEqual([...allowed].sort());
    }

    const manifest = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies).sort()).toEqual([
      '@fastify/swagger',
      'fastify',
      'pg',
    ]);
  });

  it('leaves no adapter and no Phase 5 code in production', async () => {
    const modules = await readModules(SRC);
    for (const module of modules) {
      for (const later of [
        'ClaudeCodeAdapter',
        'CodexAdapter',
        'autoSearchTrigger',
        'ToolGateway',
        'ApprovalEngine',
        'ModelRouter',
      ]) {
        expect(module.source.includes(later), `${module.path} started ${later}`).toBe(false);
      }
    }
  });
});

describe('what the transport maps a failure from', () => {
  it('answers for application failures, not for domain ones', async () => {
    const source = await readFile(join(SRC, 'http', 'app.ts'), 'utf8');
    const code = source.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    // The error handler decides what a caller is told. What it decides *from*
    // is the application layer's vocabulary: `InvalidApplicationInputError`
    // means "this service would not accept that", which is exactly what a 400
    // says. A domain error class named here would mean the edge had learned a
    // rule from two layers down — and then every new domain rule is a
    // transport change, which is how an edge accumulates knowledge of the
    // things it exists to be insulated from.
    //
    // This is deliberately narrow. `src/http/resources.ts` mirrors domain
    // enums and constants and should: describing what a value may be is not
    // the same as mapping how a failure is reported.
    for (const forbidden of [
      'InvalidProjectFieldError',
      'InvalidProjectIdError',
      'InvalidProblemFieldError',
      'InvalidOwnerIdError',
    ]) {
      expect(`app.ts maps ${forbidden}:${code.includes(forbidden)}`).toBe(
        `app.ts maps ${forbidden}:false`,
      );
    }

    // And the one it does map is still there, so this cannot pass by the
    // handler having lost its input branch altogether.
    expect(code).toContain('InvalidApplicationInputError');
  });

  it('translates a refused Project field where both layers are known', async () => {
    const source = await readFile(join(SRC, 'app', 'project-environment-service.ts'), 'utf8');
    const code = source.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    // The other side of the same boundary: the application layer is where the
    // domain's refusal becomes the application's, because it is the only layer
    // that legitimately knows both.
    expect(code).toContain('InvalidProjectFieldError');
    expect(code).toContain('InvalidApplicationInputError');

    // Translated generically rather than by asking which field it was. A rule
    // added to the Project domain later needs no change here.
    expect(`the service inspects error.field:${code.includes('.field')}`).toBe(
      'the service inspects error.field:false',
    );
  });
});
