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

test('PRODUCTION AFFORDANCE FENCE: a production input exists WITH its binding and its Command', async () => {
  // REPLACED ATOMICALLY BY E3 (Bead eij.3), which is what ngh's version of this
  // test instructed its successor to do -- never merely delete it.
  //
  // ngh's invariant was "NO production code path can introduce a v2 input",
  // because an affordance that routes nowhere is a dead control: E1's rule that
  // nothing renders what cannot happen. E3 makes exactly one production input
  // real, so the invariant INVERTS rather than disappearing: the input may exist
  // ONLY as long as the binding and the Command that consume it exist with it.
  //
  // What is NOT claimed, restated from ngh because it is still true: this is a
  // golden-file check plus a source tripwire, not a statement about everything
  // the system could project at runtime -- `parameters` is a spread of a
  // provider's context, and a provider's context is built from Image data.
  const browser = await import('../src/native-smalltalk-browser.js');

  // (1) THE PRODUCTION INPUT IS REAL, and it is the browser's own array -- not a
  // fixture literal, so a projector/browser drift cannot pass this.
  const inputs = browser.NATIVE_METHOD_INPUTS;
  assert.equal(inputs.length, 1, 'E3 threads exactly ONE input; a second needs its own justification');
  assert.equal(inputs[0].role, browser.NATIVE_METHOD_SOURCE_INPUT_ROLE);
  assert.ok(Object.isFrozen(inputs) && Object.isFrozen(inputs[0]));

  // (2) ITS COMMAND EXISTS, is discoverable on a native-method subject, and is the
  // one the binding names. A Command whose id did not match the binding's would
  // be refused by CommandRouter (Bead z9b) -- loudly, but only at the first user
  // gesture, which is exactly what this catches at build time instead.
  const command = browser.createReplaceNativeMethodCommand();
  assert.equal(command.id, browser.REPLACE_NATIVE_METHOD_COMMAND_ID);
  assert.equal(command.applies({kind: 'native-method', imageId: 'i', classRef: {}, selector: 's'}, {}), true);
  assert.equal(command.applies({kind: 'native-class', imageId: 'i', classRef: {}}, {}), false);

  // (3) ITS BINDING EXISTS, names that Command explicitly, and resolves the SAME
  // key space the projector emits: key 0 -> the source role, and nothing else.
  const binding = browser.createNativeSmalltalkBrowser({
    adapter: {
      describeSmalltalkClass: () => {}, readSmalltalkMethodForUpdate: () => {},
      classifySmalltalkClassReadError: () => {}, classifySmalltalkMethodReadError: () => {},
    },
    presentationRegistry: {discover: () => ({presentations: [], failures: []})},
    compositor: {openView: async () => {}, presentOn: async () => {}, liveView: () => null},
  }).replacementInputBinding({authorityFor: () => null, onReplacementError: () => {}});
  assert.equal(binding.commandId, browser.REPLACE_NATIVE_METHOD_COMMAND_ID,
    'the binding must name the Command that exists; an explicit commandId dispatches THAT one or nothing');
  const descriptor = {kind: 'native-method', parameters: {inputs}};
  assert.deepEqual(binding.resolveInput(descriptor, 0), {role: browser.NATIVE_METHOD_SOURCE_INPUT_ROLE});
  assert.equal(binding.resolveInput(descriptor, 1), null, 'a key past the array is a no-op, never a wrong input');
  assert.equal(typeof binding.tokenFor, 'function', 'the affordance carries its transient token supplier');

  // (4) GOLDEN FILE. Exactly ONE production fixture may be v2, and it is the
  // editable method -- the document the browser actually produces. Every other
  // production fixture is still v1 with no input node, so E3 widened the
  // affordance to one place rather than everywhere.
  const SYNTHETIC = new Set(['v2-input.json', 'v2-input-reorder.json']);
  const V2_PRODUCTION = new Set(['native-method-editable.json']);
  let production = 0;
  let v2Production = 0;
  for (const name of readdirSync(FIXTURES).filter((f) => f.endsWith('.json'))) {
    if (SYNTHETIC.has(name)) continue;
    const doc = JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf8'));
    if (doc.kind !== 'semantic-ui') continue;
    production += 1;
    if (V2_PRODUCTION.has(name)) {
      v2Production += 1;
      assert.equal(doc.version, 2, `${name} is the production v2 document and must be stamped v2`);
      assert.equal(inputsOf(doc).length, 1, `${name} must carry exactly the one E3 input`);
      assert.deepEqual(inputsOf(doc)[0], {
        kind: 'input', key: 0, label: 'New source', valueKind: 'text', submitLabel: 'Replace',
      }, 'the role must NOT cross into the document: the renderer never learns what an input MEANS');
      continue;
    }
    assert.equal(doc.version, 1, `${name} is not v1: only the editable method may use v2`);
    assert.equal(inputsOf(doc).length, 0, `${name} carries an input node`);
  }
  assert.ok(production >= 7, `expected the production corpus to be exercised, saw ${production}`);
  assert.equal(v2Production, 1, 'exactly one production fixture is the v2 one');

  // (5) SOURCE TRIPWIRE over EVERY module that turns a provider's context into
  // descriptor `parameters`. ngh forbade `inputs` in all four; E3 permits it in
  // EXACTLY ONE -- the owner that also supplies the binding and the Command
  // asserted above -- and still forbids it in the other three. A production
  // affordance in a module with no binding is the failure this catches.
  const AFFORDANCE_OWNER = 'src/native-smalltalk-browser.js';
  const BUILDERS = [
    'src/environment-shell.js',
    'src/project-browser.js',
    AFFORDANCE_OWNER,
    'src/composition-persistence.js',
  ];
  for (const rel of BUILDERS) {
    const source = readFileSync(resolve(HERE, '..', rel), 'utf8');
    if (rel === AFFORDANCE_OWNER) {
      assert.ok(/\binputs\b/.test(source), `${AFFORDANCE_OWNER} must still thread the production input it owns`);
      continue;
    }
    assert.ok(
      !/\binputs\b/.test(source),
      `${rel} now mentions \`inputs\`: a production v2 affordance must land in the SAME slice as its `
      + 'input binding and its Command, never before them (E1: nothing renders an affordance that '
      + 'routes nowhere). Widen this fence deliberately, with that owner\'s binding and Command, '
      + 'never by deleting it.',
    );
  }

  // (6) The list of builders above must stay complete: every module that spreads
  // a provider context into descriptor parameters must be in it, or the tripwire
  // silently shrinks the way it already did once.
  const spreadSites = readdirSync(resolve(HERE, '../src'))
    .filter((f) => f.endsWith('.js'))
    // Matches every shape in the tree: a property spread
    // (`parameters: {...presentation.context}`), a direct assignment
    // (`parameters: p.context ?? {}`) and E3's named local
    // (`const parameters = {...presentation.context}`). The first version of this
    // detector assumed a spread and silently missed two of the four; a later
    // draft of THIS one matched a bare `parameters,` and swept in a module that
    // builds no descriptor at all. It must be tied to `.context`, which is what
    // makes a module a descriptor-parameter builder in the first place.
    .filter((f) => /parameters[^\n]{0,60}\.context\b/.test(readFileSync(resolve(HERE, '../src', f), 'utf8')))
    .map((f) => `src/${f}`);
  assert.deepEqual(spreadSites.sort(), [...BUILDERS].sort(),
    'a module builds descriptor parameters from a provider context but is not covered by the tripwire');
});
