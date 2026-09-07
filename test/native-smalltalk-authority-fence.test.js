import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, 'native-smalltalk-browser.integration.test.js');
const source = () => readFileSync(FIXTURE, 'utf8');

// THE AUTHORITY-BOOTSTRAP FENCE (Bead eij.3, after Images ccd8321 / #231).
//
// A review rejected an earlier E3 acceptance because it made the post-write fresh
// reread succeed only by PRE-GRANTING `object/read` on Block ids the fixture had
// learned in advance through Images-private helpers. That is future authority
// information no production Environment can derive or obtain, and it turned a
// consumer-contract proof into a statement about what the fixture happened to
// know. An earlier E2 fixture had a milder version of the same problem: a
// `boundBlockFor` bootstrap that whispered the CURRENT Block id.
//
// Images ccd8321 removed the need for either: a public method read authorizes
// `smalltalk-method/read` on the logical {imageId, classRef, selector} POSITION,
// which is nameable from public vocabulary alone and stable across immutable
// revisions.
//
// This fence keeps it that way STRUCTURALLY. The runtime half lives in the
// acceptance itself (every recorded method grant is exactly
// {ids: [classRef.objectId], position: {classRef, selector}}, and the issued
// context is proven NOT to satisfy an object/read demand on the Block it
// resolved to). This file is the source half: it runs with no Images runtime, so
// it cannot be skipped away, and it fails on the shapes a wrong implementation
// would actually take.
//
// WHAT IT DOES NOT CLAIM: it is a scan over ONE fixture's authority provider, not
// a proof about every possible composition. It is aimed at the regression that
// actually happened twice.

// The authority provider the acceptance composition hands to the browser's
// bindings, extracted from the fixture rather than duplicated here.
function authorityProviderSource() {
  const text = source();
  const start = text.indexOf('  const authorityFor = (target) => {');
  assert.notEqual(start, -1, 'the acceptance composition must still define authorityFor(target)');
  const end = text.indexOf('\n  };', start);
  assert.notEqual(end, -1, 'authorityFor(target) must be a delimited function body');
  return text.slice(start, end);
}

const FORBIDDEN_IN_AUTHORITY = [
  // The two bootstraps that actually happened.
  /\bboundBlockFor\b/,
  /\bpreGrant\w*\b/,
  // Images-private / storage readers.
  /\bmethodBindings\b/,
  /\bmethodBlockRef\b/,
  /\bMethodDictionary\b/,
  // Reading a resolved Block out of a descriptor or a binding.
  /\.method\b/,
  /\bblockId\b/,
  /\bblockRef\b/,
  // Compiler-derived revision identity.
  /\bcompile\w*\b/,
  /\brevision\b/,
];

test('the acceptance builds semantic method-read authority from the LOCATOR alone', () => {
  const provider = authorityProviderSource();
  for (const pattern of FORBIDDEN_IN_AUTHORITY) {
    assert.equal(
      pattern.test(provider), false,
      `the composition's authorityFor names ${pattern}: a semantic method read must be authorized from `
      + '{imageId, classRef, selector} and the public method-position vocabulary ONLY. A physical Block '
      + 'grant -- current OR future -- makes the acceptance prove what the fixture knew instead of what a '
      + 'consumer can obtain.',
    );
  }
  // And it must positively use the locator and the position vocabulary, so this
  // is not green merely because the provider became trivial.
  assert.ok(/target\.classRef/.test(provider), 'it must build from the declaring class ref');
  assert.ok(/target\.selector/.test(provider), 'and from the selector');
  assert.ok(/authorityForMethod/.test(provider), 'through the method-position grant helper');
});

test('the fixture no longer carries a Block-identity bootstrap at all', () => {
  const text = source();
  // Comments may still EXPLAIN why it is gone; nothing may assign or call it.
  const live = text
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  assert.equal(/\bboundBlockFor\b/.test(live), false,
    'boundBlockFor is a fixture-only bootstrap that supplied a Block id the consumer could not obtain');
});

test('the method-position grant helper is built from the public vocabulary only', () => {
  const text = source();
  const start = text.indexOf('  const methodPositionGrant = (classRef, selector) => ({');
  assert.notEqual(start, -1, 'the fixture must build its grant through one named helper');
  const helper = text.slice(start, text.indexOf('\n  });', start));
  assert.ok(/SMALLTALK_METHOD_READ_OPERATION/.test(helper), 'the operation comes from Images, never a literal');
  assert.ok(/smalltalkMethodPositionResource\(IMAGE, classRef, selector\)/.test(helper),
    'and the resource is built by Images from exactly {imageId, classRef, selector}');
  for (const pattern of FORBIDDEN_IN_AUTHORITY) {
    assert.equal(pattern.test(helper), false, `the grant helper names ${pattern}`);
  }
});
