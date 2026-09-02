// DIAGNOSTIC TOOLING (not a runtime dependency, not part of the build).
//
// Static module-closure census: traces the transitive JS module closure reachable
// from the Environment core entry points + the lagrange-images runtime entry,
// following real static + dynamic import specifiers recursively, and classifies
// node:* builtins / external packages reached. Repo-relative, deterministic.
//
// PURPOSE: architectural/portability diagnostic for the native/WASM embedding
// work (Bead lagrange-object-environment-3zb). It answers "what COULD this pull
// in?" — the statically-reachable superset.
//
// IMPORTANT LIMITATION: this is a STATIC trace, so it OVER-APPROXIMATES — it
// follows barrel re-exports (e.g. lagrange-images/src/runtime.js re-exporting
// toolchain/foreign-runtime) that the acceptance never executes. The AUTHORITATIVE
// executed-closure result (which modules were genuinely CALLED) was derived with
// NODE_V8_COVERAGE function-level coverage and is recorded on Bead 3zb: only
// node:crypto is a real node:* dependency; the Environment-side modules import
// ZERO node:* builtins. Use this script to re-check the static superset when the
// dependency surface changes; do not treat its output as the executed closure.
//
// Usage: node scripts/census-module-closure.mjs [--verbose]
import {readFileSync, existsSync} from 'node:fs';
import {resolve, dirname, normalize} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_ROOT = resolve(HERE, '..');
const IMAGES_ROOT = resolve(ENV_ROOT, '../lagrange-images');

// The semantic entry points (the env core modules the acceptance worker loads,
// EXCLUDING bridge/transport machinery which is deleted with the bridge).
const ENV_ENTRIES = [
  'src/image-client-adapter.js',
  'src/environment-shell.js',
  'src/selection-model.js',
  'src/compositor.js',
  'src/object-navigator.js',
  'src/command-router.js',
  'src/model.js',
  'src/presentation-registry.js',
  'src/command-registry.js',
  'src/object-presentation-providers.js',
].map((p) => resolve(ENV_ROOT, p));

// The lagrange-images runtime the acceptance loads (createRuntime mock + kernel
// install + authorized create/read/write/observe + authority/dispatch).
const IMAGES_ENTRIES = [resolve(IMAGES_ROOT, 'src/runtime.js')];

const IMPORT_RE = /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s*['"]([^'"]+)['"]/g;

function importsOf(file) {
  let src;
  try {
    src = readFileSync(file, 'utf8');
  } catch {
    return {missing: true, local: [], node: [], external: []};
  }
  const local = [];
  const node = [];
  const external = [];
  for (const match of src.matchAll(IMPORT_RE)) {
    const spec = match[1] ?? match[2] ?? match[3];
    if (!spec) continue;
    if (spec.startsWith('node:')) node.push(spec);
    else if (spec.startsWith('./') || spec.startsWith('../')) local.push(spec);
    else external.push(spec); // bare specifier (npm package)
  }
  return {missing: false, local, node, external};
}

function resolveLocal(spec, fromFile) {
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [base, `${base}.js`, `${base}.mjs`, resolve(base, 'index.js')]) {
    if (existsSync(candidate) && !candidate.endsWith('/')) return normalize(candidate);
  }
  return null;
}

const visited = new Map(); // file -> {node:Set, external:Set}
const nodeBuiltins = new Map(); // spec -> Set<file>
const externalPkgs = new Map(); // spec -> Set<file>
const missing = [];
const queue = [...ENV_ENTRIES, ...IMAGES_ENTRIES];

while (queue.length > 0) {
  const file = queue.shift();
  const norm = normalize(file);
  if (visited.has(norm)) continue;
  const {missing: miss, local, node, external} = importsOf(norm);
  if (miss) {
    missing.push(norm);
    continue;
  }
  visited.set(norm, {node: new Set(node), external: new Set(external)});
  for (const spec of node) {
    if (!nodeBuiltins.has(spec)) nodeBuiltins.set(spec, new Set());
    nodeBuiltins.get(spec).add(norm);
  }
  for (const spec of external) {
    if (!externalPkgs.has(spec)) externalPkgs.set(spec, new Set());
    externalPkgs.get(spec).add(norm);
  }
  for (const spec of local) {
    const resolved = resolveLocal(spec, norm);
    if (resolved) queue.push(resolved);
  }
}

const envFiles = [...visited.keys()].filter((f) => f.startsWith(ENV_ROOT));
const imagesFiles = [...visited.keys()].filter((f) => f.startsWith(IMAGES_ROOT));

console.log('=== MODULE CLOSURE ===');
console.log(`env modules:        ${envFiles.length}`);
console.log(`images modules:     ${imagesFiles.length}`);
console.log(`total:              ${visited.size}`);
if (missing.length) console.log(`MISSING (unresolved): ${missing.length}\n  ${missing.join('\n  ')}`);

console.log('\n=== node:* builtins reached (spec -> count of importing files) ===');
for (const [spec, files] of [...nodeBuiltins.entries()].sort()) {
  console.log(`  ${spec.padEnd(28)} ${files.size} file(s)`);
}

console.log('\n=== node:* builtin -> importing files (detail) ===');
for (const [spec, files] of [...nodeBuiltins.entries()].sort()) {
  console.log(`  ${spec}:`);
  for (const f of [...files].sort()) console.log(`    ${f.replace(ENV_ROOT, 'ENV').replace(IMAGES_ROOT, 'IMG')}`);
}

console.log('\n=== external (npm) packages reached ===');
if (externalPkgs.size === 0) console.log('  (none)');
for (const [spec, files] of [...externalPkgs.entries()].sort()) {
  console.log(`  ${spec.padEnd(28)} ${files.size} file(s)`);
}

console.log('\n=== env modules loaded ===');
for (const f of envFiles.sort()) console.log(`  ${f.replace(ENV_ROOT + '/', '')}`);

console.log('\n=== images modules loaded (count only; full list via --verbose) ===');
if (process.argv.includes('--verbose')) {
  for (const f of imagesFiles.sort()) console.log(`  ${f.replace(IMAGES_ROOT + '/', '')}`);
} else {
  console.log(`  (${imagesFiles.length} files; run with --verbose to list)`);
}
