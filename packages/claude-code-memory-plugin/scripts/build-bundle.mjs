/**
 * Builds the plugin's distribution runtime.
 *
 * An installed plugin is a *copy* of this directory and nothing else: no
 * sibling workspace packages, no repository root, no `node_modules`, and no
 * install step the host would have to be trusted to run. So everything the
 * the tools execute has to already be inside the directory, which is what
 * this produces — two self-contained ES modules whose only unresolved imports
 * are Node's own built-ins.
 *
 * The output is generated, committed, and checked byte-for-byte against a
 * fresh build. That is the whole discipline: the source stays the authority,
 * and a stale or hand-edited artifact is a test failure rather than something
 * a user discovers at runtime.
 *
 * Usage:
 *   node scripts/build-bundle.mjs           write the committed bundle
 *   node scripts/build-bundle.mjs --check   build to a temporary directory and
 *                                           compare, writing nothing
 */

import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE_DIRECTORY = join(PACKAGE_ROOT, 'bundle');

/**
 * What ships, and what each thing is.
 *
 * Named here rather than at two call sites, so the generator and the freshness
 * check cannot come to disagree about what the distribution consists of.
 */
export const BUNDLE_ENTRYPOINTS = [
  { entry: 'src/server.ts', output: 'server.js' },
  { entry: 'src/pre-tool-use.ts', output: 'pre-tool-use.js' },
];

/** Everything the committed bundle directory is allowed to contain. */
export const BUNDLE_FILES = BUNDLE_ENTRYPOINTS.map((one) => one.output);

/**
 * Where the licences of the code that travels inside the bundle are recorded.
 *
 * Generated beside the bundle rather than inside it, because it is a document
 * about the distribution rather than a thing the runtime loads.
 */
export const NOTICES_FILE = 'THIRD_PARTY_NOTICES.txt';

/**
 * Said in the bytes, because that is where somebody reading them will be.
 *
 * Deliberately carries no version, date, machine or path: a header that
 * changed per build would make the artifact irreproducible, and the point of
 * committing it is that two people can build it and get the same file.
 */
const BANNER = [
  '// Generated file — do not edit directly.',
  '//',
  '// Built from this package’s TypeScript sources by scripts/build-bundle.mjs.',
  '// The source is the authority: change src/, run the bundle script, commit the',
  '// result. An edit made here is lost on the next build and is invisible to the',
  '// type checker, the linter and every test in this repository.',
].join('\n');

/** Node's own modules, which an installed plugin may of course still import. */
const NODE_BUILTIN = /^node:/u;

/** The esbuild settings, in one place so a check cannot use different ones. */
function optionsFor(entry, outfile) {
  return {
    entryPoints: [join(PACKAGE_ROOT, entry)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: ['node22.12'],
    sourcemap: false,
    minify: false,
    // Third-party code travels with its licence. `eof` keeps the legal
    // comments esbuild recognises and collects them deterministically.
    legalComments: 'eof',
    banner: { js: BANNER },
    metafile: true,
    // Absolute paths from whoever built this must not reach the bytes.
    absWorkingDir: PACKAGE_ROOT,
    logLevel: 'silent',
  };
}

/** SHA-256 of a file, as hex. */
async function digestOf(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

/**
 * Every import the build could not resolve, which must be Node built-ins only.
 *
 * Read from esbuild's own graph rather than by searching the output text: the
 * graph is what actually decides whether an installed copy can start, and a
 * text search would miss an import it did not think to look for.
 */
function unresolvedImportsOf(metafile) {
  // One entrypoint per build, so one output. Taken by position rather than by
  // path, because the key is relative to the working directory and a check
  // builds somewhere else entirely.
  const output = Object.values(metafile.outputs)[0];
  return [...new Set((output?.imports ?? []).filter((one) => one.external).map((one) => one.path))];
}

/**
 * The third-party packages whose code ends up inside the outputs.
 *
 * Read from the build graph, so a dependency that arrives through another
 * dependency is found the same way a direct one is — a hand-kept list would
 * quietly stop being the truth the first time the graph changed.
 */
function bundledPackagesOf(metafile) {
  const found = new Set();
  for (const key of Object.keys(metafile.inputs)) {
    const path = key.split('\\').join('/');
    const at = path.lastIndexOf('node_modules/');
    if (at < 0) {
      continue;
    }
    const parts = path.slice(at + 'node_modules/'.length).split('/');
    found.add(parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0]);
  }
  return found;
}

/**
 * The notices file, built from what the graph says actually shipped.
 *
 * Every package here is redistributed verbatim inside the bundle, and each of
 * their licences asks for its notice to travel with the copy. Sorted and
 * LF-terminated so two builds of the same inputs produce the same bytes.
 */
async function noticesFor(packages) {
  const sections = [];
  for (const name of [...packages].sort()) {
    const directory = join(PACKAGE_ROOT, '..', '..', 'node_modules', name);
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    const licence = await readFile(join(directory, 'LICENSE'), 'utf8').catch(() => undefined);
    if (licence === undefined) {
      throw new Error(`${name} is bundled but ships no LICENSE file to carry with it`);
    }
    sections.push(
      [
        `${name} ${manifest.version} (${manifest.license ?? 'see below'})`,
        '',
        licence.replace(/\r\n/gu, '\n').trimEnd(),
      ].join('\n'),
    );
  }

  return [
    'Third-party software redistributed inside this plugin’s bundle.',
    '',
    'Generated file — do not edit directly. Produced by scripts/build-bundle.mjs',
    'from the packages the build graph says are compiled into bundle/server.js and',
    'bundle/pre-tool-use.js. Each notice below belongs to its own copyright holder.',
    '',
    ...sections.map((section) => `${'-'.repeat(76)}\n\n${section}\n`),
  ].join('\n');
}

/** Builds both entrypoints into `directory`, returning what was produced. */
async function buildInto(directory) {
  await mkdir(directory, { recursive: true });

  const produced = [];
  const packages = new Set();
  for (const { entry, output } of BUNDLE_ENTRYPOINTS) {
    const outfile = join(directory, output);
    const result = await build(optionsFor(entry, outfile));
    for (const name of bundledPackagesOf(result.metafile)) {
      packages.add(name);
    }
    produced.push({
      output,
      outfile,
      unresolved: unresolvedImportsOf(result.metafile),
      digest: await digestOf(outfile),
      bytes: (await readFile(outfile)).byteLength,
    });
  }

  const notices = join(directory, NOTICES_FILE);
  await writeFile(notices, await noticesFor(packages), 'utf8');
  produced.push({
    output: NOTICES_FILE,
    outfile: notices,
    unresolved: [],
    digest: await digestOf(notices),
    bytes: (await readFile(notices)).byteLength,
  });

  return produced;
}

/**
 * Refuses a build whose runtime closure is not closed.
 *
 * An installed copy has no `node_modules`, so a surviving package import is not
 * a smaller bundle — it is a plugin that cannot start on somebody else's
 * machine, discovered by them rather than here.
 */
function assertClosed(produced) {
  for (const one of produced) {
    const foreign = one.unresolved.filter((path) => !NODE_BUILTIN.test(path));
    if (foreign.length > 0) {
      throw new Error(
        `${one.output} still imports ${foreign.join(', ')}, which an installed copy cannot resolve`,
      );
    }
  }
}

/** Where a produced artifact belongs in the committed tree. */
function committedPath(output) {
  return output === NOTICES_FILE
    ? join(PACKAGE_ROOT, NOTICES_FILE)
    : join(BUNDLE_DIRECTORY, output);
}

/** Writes the committed bundle. */
async function generate() {
  await rm(BUNDLE_DIRECTORY, { recursive: true, force: true });
  const scratch = await mkdtemp(join(tmpdir(), 'memory-plugin-bundle-'));
  let produced;
  try {
    produced = await buildInto(scratch);
    assertClosed(produced);
    await mkdir(BUNDLE_DIRECTORY, { recursive: true });
    for (const one of produced) {
      await writeFile(committedPath(one.output), await readFile(one.outfile));
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  for (const one of produced) {
    process.stdout.write(`${one.output}\t${String(one.bytes)} bytes\t${one.digest}\n`);
    process.stdout.write(`  external: ${one.unresolved.join(', ') || '(none)'}\n`);
  }
}

/**
 * Builds to a temporary directory and compares, writing nothing here.
 *
 * This is the check that makes the committed artifact trustworthy: it fails
 * when the source, a dependency or a build option moved without the bundle
 * being regenerated, and it says so without printing anybody's paths.
 */
async function check() {
  const scratch = await mkdtemp(join(tmpdir(), 'memory-plugin-bundle-'));
  try {
    const produced = await buildInto(scratch);
    assertClosed(produced);

    const present = (await readdir(BUNDLE_DIRECTORY).catch(() => [])).sort();
    const expected = [...BUNDLE_FILES].sort();
    const unexpected = present.filter((name) => !expected.includes(name));
    if (unexpected.length > 0) {
      throw new Error(
        `the bundle directory holds files nothing generates: ${unexpected.join(', ')}`,
      );
    }

    for (const one of produced) {
      const digest = await digestOf(committedPath(one.output)).catch(() => undefined);
      if (digest === undefined) {
        throw new Error(`${one.output} is missing from the committed bundle`);
      }
      if (digest !== one.digest) {
        throw new Error(
          `${one.output} is stale: committed ${digest.slice(0, 12)}, ` +
            `freshly built ${one.digest.slice(0, 12)}. Run the bundle script and commit the result.`,
        );
      }
      process.stdout.write(`${one.output}\tup to date\t${one.digest}\n`);
      process.stdout.write(`  external: ${one.unresolved.join(', ') || '(none)'}\n`);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Reported as a name, never as a path from whoever ran it. */
function safeName(path) {
  return basename(path);
}

async function main() {
  const checking = process.argv.includes('--check');
  try {
    await (checking ? check() : generate());
  } catch (error) {
    process.stderr.write(`${safeName(process.argv[1] ?? 'build-bundle.mjs')}: `);
    process.stderr.write(`${error instanceof Error ? error.message : 'failed'}\n`);
    process.exitCode = 1;
  }
}

// Only when Node was asked to run this file. A test that imports it wants the
// definitions above, not a build.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

export { BANNER, buildInto, assertClosed, unresolvedImportsOf, BUNDLE_DIRECTORY, PACKAGE_ROOT };
