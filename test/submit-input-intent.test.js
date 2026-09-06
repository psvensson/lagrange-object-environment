import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// The submit-input INTENT corpus. A DIFFERENT contract domain from SemanticUi
// documents: a document is validator/projector-owned data flowing outward to a
// host, an intent is host-ORIGINATED data flowing back. They live in separate
// directories and are enumerated separately, and deliberately share no helper --
// a common one would end up making the same shape assumptions about both, which
// is how the two domains would quietly merge.

const HERE = dirname(fileURLToPath(import.meta.url));
const INTENTS = resolve(HERE, 'fixtures/semantic-ui/intents');

const intentFiles = () => readdirSync(INTENTS).filter((f) => f.endsWith('.json')).sort();
const readIntent = (name) => JSON.parse(readFileSync(resolve(INTENTS, name), 'utf8'));

test('the intent corpus is enumerated on its own, and every file is an intent', () => {
  const files = intentFiles();
  assert.ok(files.length >= 4, `expected the intent corpus to be populated, saw ${files.length}`);
  for (const name of files) {
    const intent = readIntent(name);
    assert.ok(['edit-field', 'submit-input'].includes(intent.kind), `${name} is not an intent`);
    assert.ok(Number.isSafeInteger(intent.key) && intent.key >= 0, `${name} key`);
    // An intent is NOT a SemanticUi document: it must never carry one's shape.
    assert.ok(!Object.hasOwn(intent, 'root'), `${name} carries a document root`);
    assert.ok(!Object.hasOwn(intent, 'version'), `${name} carries a document version`);
  }
});

test('TEXT IS MANDATORY on submit-input, and the empty string is a legal value', () => {
  // The distinction that matters: ABSENT text is not an empty submission. The
  // Rust port previously modelled text as Option<String> with
  // skip_serializing_if, so a submit-input built with None would serialize as
  // {"kind":"submit-input","key":0} and compare EQUAL to a fixture that also
  // lacked the field -- the omission could never be caught by a byte comparison.
  // It is now an enum variant that REQUIRES its text, so absence is not
  // constructible; this asserts the JS side of the same contract.
  const empty = readIntent('submit-input-empty.json');
  assert.ok(Object.hasOwn(empty, 'text'), 'an empty submission must still CARRY its text field');
  assert.equal(empty.text, '');

  for (const name of intentFiles().filter((f) => f.startsWith('submit-input'))) {
    assert.ok(Object.hasOwn(readIntent(name), 'text'), `${name} omits text`);
  }
});

test('RAW means raw: no trimming, no parsing, no normalization', () => {
  const {text} = readIntent('submit-input-multiline.json');
  // Each of these is something a "helpful" host or a stray .trim() would remove,
  // and each would silently corrupt a method body:
  assert.match(text, /^ {2}/, 'leading whitespace was trimmed');
  assert.match(text, / {2}\n/, 'trailing whitespace on a line was trimmed');
  assert.ok(text.endsWith('\n'), 'the TRAILING NEWLINE was stripped');
  assert.ok(text.includes('\t'), 'a tab was normalized away');
  assert.ok(text.split('\n').length > 2, 'the value is not genuinely multiline');
});

test('Unicode survives byte-identically', () => {
  const {text} = readIntent('submit-input-unicode.json');
  assert.ok(/[åäö]/.test(text), 'latin-1 supplement lost');
  assert.ok(/[぀-ヿ一-鿿]/.test(text), 'CJK lost');
  assert.ok([...text].some((c) => c.codePointAt(0) > 0xffff), 'astral plane (emoji) lost');
  // Round-tripping through JSON must not change a single byte.
  assert.equal(JSON.parse(JSON.stringify({text})).text, text);
});
