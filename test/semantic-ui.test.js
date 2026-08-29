import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  semanticUiForPresentation,
  validateSemanticUi,
  valueText,
} from '../src/semantic-ui.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures', 'semantic-ui');

const ref = (objectId) => ({kind: 'ref', imageId: 'img', objectId});

// The descriptors the fixtures were generated from. The projector MUST
// reproduce each checked-in fixture exactly (the fixture is the canonical
// cross-host source of truth — a projector edit without a fixture edit goes
// red, and vice versa).
const CASES = {
  navigator: {kind: 'navigator', subject: ref('obj-root'), parameters: {fields: {'slot-title': {kind: 'text', value: 'Root'}}, references: [ref('obj-b'), ref('obj-c')]}},
  inspector: {kind: 'inspector', subject: ref('obj-b'), parameters: {fields: {'slot-title': {kind: 'text', value: 'B'}, 'slot-count': {kind: 'int', value: 17}}, references: [ref('obj-c')]}},
  unavailable: {kind: 'unavailable-reference', subject: ref('obj-gone'), parameters: {reason: 'not found'}},
  unauthorized: {kind: 'unauthorized-reference', subject: ref('obj-secret'), parameters: {reason: 'denied'}},
};

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

test('the projector reproduces each checked-in green fixture exactly', async () => {
  for (const [name, descriptor] of Object.entries(CASES)) {
    const expected = await readJson(join(FIXTURES, `${name}.json`));
    assert.deepEqual(
      semanticUiForPresentation(descriptor),
      expected,
      `semanticUiForPresentation(${name}) must deep-equal the checked-in fixture`,
    );
  }
});

test('the validator accepts every checked-in green fixture', async () => {
  for (const name of Object.keys(CASES)) {
    const doc = await readJson(join(FIXTURES, `${name}.json`));
    assert.equal(validateSemanticUi(doc), doc, `${name}.json must validate`);
  }
});

test('the validator LOUDLY rejects every red conformance fixture', async () => {
  const redCases = await (async () => {
    const {readdir} = await import('node:fs/promises');
    return (await readdir(join(FIXTURES, 'red'))).filter((f) => f.endsWith('.json'));
  })();
  assert.ok(redCases.length >= 5, 'expected a red conformance corpus');
  for (const file of redCases) {
    const doc = await readJson(join(FIXTURES, 'red', file));
    assert.throws(
      () => validateSemanticUi(doc),
      /SemanticUi\/v1 contract violation/,
      `red fixture ${file} must be rejected`,
    );
  }
});

test('specific violations are rejected with clear reasons', () => {
  const base = {kind: 'semantic-ui', version: 1, root: {kind: 'group', title: 'x', children: []}};
  // host-specific field
  assert.throws(() => validateSemanticUi({...base, root: {kind: 'group', title: 'x', children: [{kind: 'text', text: 'y', tagName: 'h3'}]}}), /host-specific field/);
  // ref in an action
  assert.throws(() => validateSemanticUi({...base, root: {kind: 'group', children: [{kind: 'collection', items: [{kind: 'action', key: 0, label: 'a', subject: ref('o')}]}]}}), /ref\/subject/);
  // unknown version
  assert.throws(() => validateSemanticUi({...base, version: 2}), /unsupported version/);
  // unknown node kind
  assert.throws(() => validateSemanticUi({...base, root: {kind: 'window', children: []}}), /unknown node kind/);
  // non-integer action key
  assert.throws(() => validateSemanticUi({...base, root: {kind: 'group', children: [{kind: 'collection', items: [{kind: 'action', key: 'obj-c', label: 'a'}]}]}}), /descriptor-local item key/);
  // host-specific field on the DOCUMENT object itself (not just nodes)
  assert.throws(() => validateSemanticUi({...base, geometry: {x: 0}}), /document: host-specific field/);
  // a ref smuggled at the document level
  assert.throws(() => validateSemanticUi({...base, subject: ref('o')}), /document\.subject: a ref\/subject/);
});

test('integral-valued numbers are accepted (JSON number model), matching the Rust validator', () => {
  // JSON has one number type; 1 and 1.0 are the same number. Both validators
  // accept integral-valued numbers and reject fractional/negative ones.
  const withKey = (key) => ({kind: 'semantic-ui', version: 1, root: {kind: 'group', children: [{kind: 'collection', items: [{kind: 'action', key, label: 'a'}]}]}});
  for (const k of [1, 1.0, 1e3, -0]) {
    assert.equal(validateSemanticUi(withKey(k)).root.children[0].items[0].key, k, `integral key ${k} accepted`);
  }
  for (const k of [1.5, -1, -1.0]) {
    assert.throws(() => validateSemanticUi(withKey(k)), /descriptor-local item key/, `key ${k} rejected`);
  }
  // version as an integral number (incl. float syntax) is accepted; non-1 rejected.
  assert.ok(validateSemanticUi({kind: 'semantic-ui', version: 1.0, root: {kind: 'group', children: []}}));
  assert.throws(() => validateSemanticUi({kind: 'semantic-ui', version: 2.0, root: {kind: 'group', children: []}}), /unsupported version/);
});

test('action keys stay descriptor-local integers (the PR #33 security property)', () => {
  const doc = semanticUiForPresentation(CASES.navigator);
  const collection = doc.root.children.find((c) => c.kind === 'collection');
  assert.deepEqual(
    collection.items.map((a) => a.key),
    [0, 1],
    'action keys are descriptor-local indices, never refs',
  );
  assert.ok(
    collection.items.every((a) => typeof a.key === 'number' && !('ref' in a) && !('subject' in a)),
    'no action carries a ref/subject',
  );
});

test('valueText normalizes leaf Values to display text (owned here, not in a realizer)', () => {
  assert.equal(valueText({kind: 'text', value: 'B'}), 'B');
  assert.equal(valueText({kind: 'int', value: 17}), '17');
  assert.equal(valueText(ref('obj-x')), '-> obj-x');
  assert.equal(valueText('plain'), 'plain');
  assert.equal(valueText(null), '');
});
