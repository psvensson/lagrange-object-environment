import assert from 'node:assert/strict';
import test from 'node:test';
import {createSqliteApplicationRuntime} from './support/sqlite-application-runtime.js';
import {api, loadError, IMAGE, READ, prepare, openEnvironment, findEditableObject}
  from './support/yaxo-environment.js';

test('E5 real-runtime lane is required in CI', () => {
  if (process.env.LAGRANGE_IMAGES_REQUIRED === '1') assert.ifError(loadError);
});

test('E5 edits actual parsed application state through ordinary Commands, with denial and stale recovery', {
  skip: Boolean(loadError), timeout: 120_000,
}, async () => {
  const runtime = await api.createRuntime({
    backend: {instance: new api.LagrangeBackend({runtime: createSqliteApplicationRuntime()})},
  });
  let e;
  try {
    const expected = await prepare(runtime, {editing: true});
    const original = await runtime.images.getObject(IMAGE, expected.text.objectId);
    const graphBefore = await Promise.all([expected.document, expected.documentElements, expected.root, expected.child]
      .map((ref) => runtime.images.getObject(IMAGE, ref.objectId)));
    e = await openEnvironment(runtime, {editing: true});
    const discovered = await findEditableObject(e);
    assert.deepEqual(discovered.subject, expected.text, 'action discovery reaches the native text node');
    const subject = discovered.subject;
    const slot = e.mutation.writableSlots[0];
    const shownText = () => e.descriptor().parameters.fields[slot].value;
    const read = () => e.adapter.readObject({imageId: IMAGE, objectId: subject.objectId,
      authority: e.grantFor(subject), blockId: READ});
    const nativeText = async () => runtime.executor.execute(await runtime.invocations.sendMessage({
      languageId: 'symmetric-smalltalk', receiver: subject, message: api.textValue('string'), arguments: [],
    }, {dispatchImage: IMAGE}));
    const outsideWrite = async (text) => {
      const current = await read();
      return e.mutation.mutate({subject, field: {slot}, text, versionToken: current.versionToken,
        authority: e.grantFor(subject, 'object/write')});
    };
    assert.equal(shownText(), 'Tove');
    assert.ok((await e.edit('Ada')).receipt);
    assert.equal(shownText(), 'Ada');
    assert.deepEqual(await nativeText(), api.textValue('Ada'));

    const beforeDenied = await read();
    const deniedFrontier = await runtime.images.frontier(IMAGE);
    const deniedDescriptor = e.descriptor();
    const denied = await e.edit('Denied', {deny: true});
    assert.equal(denied.error.name, 'CommandAuthorizationError');
    assert.deepEqual(await read(), beforeDenied);
    assert.equal(await runtime.images.frontier(IMAGE), deniedFrontier, 'denial writes no history');
    assert.equal(e.descriptor(), deniedDescriptor, 'denial does not patch or reread the display');

    const staleToken = e.shell._inspectorToken().token;
    await outsideWrite('Grace');
    const winner = await read();
    const winnerFrontier = await runtime.images.frontier(IMAGE);
    assert.notEqual(winner.versionToken, staleToken, 'outside write actually advanced this object');
    assert.equal(shownText(), 'Ada', 'the displayed observation really is stale');
    const attempts = e.dispatches.length;
    const conflicted = await e.edit('Stale overwrite');
    assert.equal(conflicted.error.name, 'CommandConflictError');
    assert.equal(e.dispatches.length, attempts + 1, 'no silent retry');
    assert.deepEqual(await read(), winner, 'stale attempt changes neither value nor token');
    assert.equal(await runtime.images.frontier(IMAGE), winnerFrontier, 'stale attempt writes no history');
    assert.equal(shownText(), 'Grace', 'recovery shows the authoritative winning value');
    assert.equal(e.shell._inspectorToken().token, winner.versionToken);
    assert.ok((await e.edit('Lin')).receipt, 'explicit retry succeeds after reread');
    assert.deepEqual(await nativeText(), api.textValue('Lin'));

    // A competing write AFTER our commit but BEFORE the authorized reread must
    // win the display. A local text patch or receipt-token promotion fails here.
    const interleaved = await e.edit('Own commit', {afterCommit: () => outsideWrite('Final winner')});
    assert.ok(interleaved.receipt);
    assert.equal(shownText(), 'Final winner');
    assert.notEqual(e.shell._inspectorToken().token, interleaved.receipt.versionToken);
    assert.deepEqual(await nativeText(), api.textValue('Final winner'));
    const current = await runtime.images.getObject(IMAGE, subject.objectId);
    assert.deepEqual(current.slots, {...original.slots, [slot]: api.textValue('Final winner')});
    for (const property of ['id', 'shape', 'behavior', 'indexed', 'metadata']) {
      assert.deepEqual(current[property], original[property], 'scalar mutation preserves ' + property);
    }
    assert.deepEqual(await Promise.all([expected.document, expected.documentElements, expected.root, expected.child]
      .map((ref) => runtime.images.getObject(IMAGE, ref.objectId))), graphBefore);
    assert.deepEqual(e.attemptedReads, e.expectedAttempts);
    assert.deepEqual(runtime.toolchainProviders.list(), []);
    assert.deepEqual(runtime.foreignRuntimeProviders.list(), []);
  } finally {
    if (e) await e.compositor.destroy();
    await runtime.close();
  }
});
