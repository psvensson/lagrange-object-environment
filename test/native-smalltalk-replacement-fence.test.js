import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '../src');

// Bead 04f, shipped WITH the E3 adapter slice it exists to fence (Bead eij.3).
//
// WHAT THIS IS AND IS NOT, stated narrowly because the neighbouring Rust check
// over the portable artifact already had to be corrected once for over-claiming:
// hosts/linux/tests/portable_images_artifact.rs proves that Images' PUBLIC
// BARRELS do not re-export its private token/compiler/reconciliation owners. It
// does NOT make them unreachable -- every one of those modules is inside the
// artifact closure and one deep import still reaches it. That check is a
// regression detector on the barrel; THIS one is the other half: a fence over
// the ENVIRONMENT'S OWN SOURCE, which is the side this repo actually controls.
//
// THE RULE. The Environment reaches Images' native method semantics through
// exactly three authorized seams -- describe, read-for-update, replace -- all
// injected into ImageClientAdapter as plain functions. It must not name, import
// or re-implement:
//
//   * the position token's MINT or PARSER. The token is opaque BY CONTRACT (not
//     by secrecy -- its observed Block locator is derivable, and no claim to the
//     contrary is made anywhere). Opacity holds here because this repo has no
//     code that could look inside it, which is precisely what is checked below.
//   * RECONCILIATION and method-definition helpers. They are trusted CONSTRUCTION
//     helpers that perform NO authorization; calling one would be an unauthorized
//     write that bypasses the whole authority model.
//   * the COMPILER. E3 supplies source to an authorized seam and lowers nothing.
//   * method-dictionary / binding readers. Current truth comes from an authorized
//     read, never from decoding storage.
const FORBIDDEN = [
  // token owner
  /\bsmalltalkMethodPositionToken\b/,
  /\bparseSmalltalkMethodPositionToken\b/,
  /\bSMALLTALK_METHOD_POSITION_TOKEN\w*\b/,
  /\bsmalltalk-method-position-token\b/,
  // reconciliation / construction owners
  /\breconcileMethods\w*\b/,
  /\bdefineMethods\w*\b/,
  /\bsmalltalk-class-builder\b/,
  /\bsmalltalk-instance-variables\b/,
  /\bensureClassFromDeclaration\b/,
  /\bimportCuisNativePackage\b/,
  // compiler
  /\bcompileSymmetricSmalltalkMethod\b/,
  /\bcompileArtifact\b/,
  // storage / binding readers
  /\bmethodBindings\b/,
  /\bmethodBlockRef\b/,
];
// Deliberately NOT in the list: `MethodDictionary`. It is not an importable
// entry point, and both places it occurs in this tree are prose asserting the
// module does NOT decode one. A fence that reddens on a module DOCUMENTING the
// rule it obeys is a fence that gets deleted rather than fixed.

const sourceFiles = () => readdirSync(SRC, {withFileTypes: true})
  .flatMap((entry) => (entry.isDirectory()
    ? readdirSync(resolve(SRC, entry.name)).filter((f) => f.endsWith('.js')).map((f) => `${entry.name}/${f}`)
    : (entry.name.endsWith('.js') ? [entry.name] : [])));

test('04f: the Environment names none of Images private token/compiler/reconciliation owners', () => {
  const files = sourceFiles();
  assert.ok(files.length >= 15, `expected the whole src tree to be scanned, saw ${files.length}`);
  for (const rel of files) {
    const source = readFileSync(resolve(SRC, rel), 'utf8');
    for (const pattern of FORBIDDEN) {
      assert.equal(
        pattern.test(source), false,
        `src/${rel} names ${pattern}: the Environment reaches native method semantics ONLY through the `
        + 'three authorized seams (describe / read-for-update / replace). Reaching a private owner '
        + 'would be an unauthorized write or a second decoder -- re-decide this deliberately, never '
        + 'by widening the list.',
      );
    }
  }
});

test('04f: the three authorized seams are the ENTIRE native method surface the adapter consumes', () => {
  const adapter = readFileSync(resolve(SRC, 'image-client-adapter.js'), 'utf8');
  // Every `authorized*` Images function this module destructures from the client.
  // An exhaustive list, so a fourth native seam cannot appear without appearing here.
  const destructured = adapter.slice(adapter.indexOf('  const {\n    images,'), adapter.indexOf('} = client;'));
  assert.ok(destructured.length > 0, 'the client destructuring block must be found');
  const consumed = [...destructured.matchAll(/^\s{4}(authorized[A-Za-z]+),$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(consumed, [
    'authorizedDescribeSmalltalkClass',
    'authorizedDescribeSmalltalkMethod',
    'authorizedReadProject',
    'authorizedReadSmalltalkMethodForUpdate',
    'authorizedRenameProject',
    'authorizedReplaceSmalltalkMethod',
  ], 'the adapter consumes exactly these authorized Images seams');
});

test('04f: no Environment source imports lagrange-images at all', () => {
  // The client is INJECTED. A direct import would let any module reach any Images
  // internal regardless of what the adapter exposes, which is what makes the
  // seam-count above meaningful rather than decorative.
  for (const rel of sourceFiles()) {
    const source = readFileSync(resolve(SRC, rel), 'utf8');
    for (const match of source.matchAll(/^import\s[^;]*?from\s+'([^']+)';/gms)) {
      const specifier = match[1];
      assert.equal(
        /lagrange-images|\/src\/language\/|portable-runtime/.test(specifier), false,
        `src/${rel} imports ${specifier}: the Environment takes the Images surface by INJECTION only, so `
        + 'that no module can reach an Images internal regardless of what the adapter exposes',
      );
    }
  }
});
