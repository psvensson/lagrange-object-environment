import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  SEMANTIC_UI_INPUT_FORBIDDEN_KEYS,
  SEMANTIC_UI_SUPPORTED_VERSIONS,
  semanticUiForPresentation,
  validateSemanticUi,
} from '../src/semantic-ui.js';

// SemanticUi/v2 (Bead ngh): ONE new node kind, `input` -- a TRANSIENT text
// argument to an interaction, deliberately distinguishable from a `field`, which
// displays semantic state that exists.
//
// The distinction is the whole point. Images truthfully answers `source: null`
// for a native method, and the projector already OMITS Source/Provenance rows
// rather than rendering them empty (Images jtz.1), because an empty row would
// imply a durable field exists. An editable empty `field` labelled "Source"
// would assert exactly that. `input` says only "this view accepts text here".

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, 'fixtures/semantic-ui');

// The expected key set, spelled as a LITERAL here and deliberately NOT derived
// from the projector, a shared constant or a fixture helper. If the expectation
// came from the same source as the thing under test, projector + fixture +
// assertion would drift together and this would be green by construction --
// which is exactly how the first version of this falsifier failed.
const EXPECTED_INPUT_KEYS = ['key', 'kind', 'label', 'submitLabel', 'valueKind'];

const INPUT_NODE = Object.freeze({
  kind: 'input', key: 0, label: 'Replacement source', valueKind: 'text', submitLabel: 'Replace',
});
const docWith = (version, node) => ({kind: 'semantic-ui', version, root: {kind: 'group', title: 'x', children: [node]}});
const projectWith = (inputs) => semanticUiForPresentation({
  kind: 'object', subject: {objectId: 'o'}, parameters: {fields: {}, inputs},
});
const inputsOf = (doc) => {
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (n.kind === 'input') out.push(n);
    for (const c of n.children ?? []) walk(c);
    for (const i of n.items ?? []) walk(i);
  };
  walk(doc.root);
  return out;
};

test('THE VERSION GATE: the same input node is rejected under v1 and accepted under v2', () => {
  // A single red fixture could not prove this -- it is satisfied by ANY
  // rejection for ANY reason. Only the PAIR, over one identical node, shows the
  // version genuinely gates the kind table. This is the constraint that forces
  // the Rust port's raw validation to run BEFORE its tagged-enum deserialize,
  // which would otherwise make `input` legal in a v1 document automatically.
  assert.throws(() => validateSemanticUi(docWith(1, INPUT_NODE)), /unknown node kind "input" in SemanticUi\/v1/);
  const v2 = validateSemanticUi(docWith(2, INPUT_NODE));
  assert.equal(v2.version, 2);
  // And an unknown version is STILL loud. The invariant is "a version this host
  // does not understand is rejected", never "the integer 2 is forever invalid".
  assert.throws(() => validateSemanticUi(docWith(3, INPUT_NODE)), /unsupported version/);
  assert.deepEqual([...SEMANTIC_UI_SUPPORTED_VERSIONS], [1, 2]);
});

test('v2 is v1 PLUS input, not an alternative vocabulary', () => {
  // Every checked-in v1 document must validate unchanged when restamped v2.
  // This distinguishes a genuine superset from a second, divergent vocabulary
  // that merely happens to contain an input node.
  let checked = 0;
  for (const name of readdirSync(FIXTURES).filter((f) => f.endsWith('.json'))) {
    const doc = JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf8'));
    if (doc.kind !== 'semantic-ui' || doc.version !== 1) continue;
    checked += 1;
    validateSemanticUi({...doc, version: 2});
  }
  assert.ok(checked >= 6, `expected the v1 corpus to be exercised, saw ${checked}`);
});

test('an input may not carry ANYTHING that reads as a current value', () => {
  // One assertion per property: a fixture binds only the exact property it
  // spells, and each of these would let the node be read as "the current source
  // is empty" -- the precise lie this kind exists to prevent.
  assert.deepEqual([...SEMANTIC_UI_INPUT_FORBIDDEN_KEYS], ['text', 'value', 'currentValue', 'editable']);
  for (const forbidden of SEMANTIC_UI_INPUT_FORBIDDEN_KEYS) {
    assert.throws(
      () => validateSemanticUi(docWith(2, {...INPUT_NODE, [forbidden]: 'x'})),
      new RegExp(`input\\.${forbidden} is not allowed`),
      `an input carrying ${forbidden} was accepted`,
    );
  }
});

test('an input node carries EXACTLY the intended keys, asserted against a literal', () => {
  const doc = projectWith([{role: 'replacement-source', label: 'Replacement source', submitLabel: 'Replace'}]);
  const [node] = inputsOf(doc);
  assert.ok(node, 'no input node was emitted');
  assert.deepEqual(Object.keys(node).sort(), EXPECTED_INPUT_KEYS);
  // The semantic ROLE stays with the Environment owner: a renderer must not
  // learn what an input MEANS, only that it accepts text.
  assert.ok(!JSON.stringify(doc).includes('replacement-source'), 'the semantic role leaked into the document');
  // And the document contains no editable field at all, so nothing in it can be
  // mistaken for a writable record field whose value is empty.
  assert.ok(!JSON.stringify(doc).includes('"editable"'), 'an editable field appeared beside the input');
});

test('KEY DERIVATION: the projector reads array POSITION and never re-derives a key', () => {
  // With a ONE-element array no test could distinguish "indexes the shared
  // array" from "hard-codes 0" -- both answer identically. Reversing a
  // MULTI-element array is what makes the two implementations separable.
  const a = {role: 'alpha', label: 'Alpha', submitLabel: 'SA'};
  const b = {role: 'beta', label: 'Beta', submitLabel: 'SB'};
  const c = {role: 'gamma', label: 'Gamma', submitLabel: 'SC'};
  const pairs = (inputs) => inputsOf(projectWith(inputs)).map((n) => [n.key, n.label]);
  assert.deepEqual(pairs([a, b, c]), [[0, 'Alpha'], [1, 'Beta'], [2, 'Gamma']]);
  assert.deepEqual(pairs([c, b, a]), [[0, 'Gamma'], [1, 'Beta'], [2, 'Alpha']]);
});

test('a document is stamped v2 ONLY when it uses a v2 capability', () => {
  assert.equal(semanticUiForPresentation({kind: 'object', subject: {objectId: 'o'}, parameters: {fields: {}}}).version, 1);
  assert.equal(projectWith([{label: 'L', submitLabel: 'S'}]).version, 2);
  assert.equal(projectWith([]).version, 1, 'an EMPTY inputs array is not a v2 capability');
});

test('PRODUCTION FENCE: no production presentation carries inputs, so v2 has no affordance yet', () => {
  // "This slice ships a CAPABILITY, not an affordance" is a scope statement.
  // This makes it executable. E1 established the rule it protects: never render
  // an affordance that routes nowhere. The v2 input has no production producer
  // and no binding until E3 adds them TOGETHER with the Command that gives the
  // affordance meaning.
  //
  // THE LOAD-BEARING CHECK is the checked-in PRODUCTION descriptors themselves:
  // every production fixture is still v1 and carries no input node. That is a
  // statement about what the system actually projects, which is the invariant
  // that matters. (The two v2-* fixtures are the synthetic capability corpus and
  // are excluded by name -- they exist precisely to exercise the new kind.)
  const SYNTHETIC = new Set(['v2-input.json', 'v2-input-reorder.json']);
  let production = 0;
  for (const name of readdirSync(FIXTURES).filter((f) => f.endsWith('.json'))) {
    if (SYNTHETIC.has(name)) continue;
    const doc = JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf8'));
    if (doc.kind !== 'semantic-ui') continue;
    production += 1;
    assert.equal(doc.version, 1, `${name} is not v1: no production document may use v2 in this slice`);
    assert.equal(inputsOf(doc).length, 0, `${name} carries an input node`);
  }
  assert.ok(production >= 6, `expected the production corpus to be exercised, saw ${production}`);

  // A SECONDARY TRIPWIRE, not the owner of this invariant: the native Smalltalk
  // browser is the module E3 will change, so a mention of `inputs` there is an
  // early warning that a production affordance is arriving. It is a cheaper,
  // earlier signal than the descriptor check above -- not a substitute for it.
  //
  // WHEN E3 LANDS this whole fence is REPLACED ATOMICALLY, never merely deleted:
  // the invariant becomes "a production input exists AND its binding and Command
  // exist with it", which is the same rule stated for the state where the
  // affordance is live.
  const owner = readFileSync(resolve(HERE, '../src/native-smalltalk-browser.js'), 'utf8');
  assert.ok(
    !/\binputs\b/.test(owner),
    'src/native-smalltalk-browser.js now mentions `inputs`: a production v2 affordance must land in '
    + 'the SAME slice as its binding and Command, never before them',
  );
});
