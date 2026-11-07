import assert from 'node:assert/strict';
import test from 'node:test';
import {api, loadError} from './support/yaxo-environment.js';
import {createImageClientAdapter} from '../src/image-client-adapter.js';
import {createTextSlotMutationCommand} from '../src/index.js';

test('text-slot mutation real-runtime lane is required in CI', () => {
  if (process.env.LAGRANGE_IMAGES_REQUIRED === '1') assert.ifError(loadError);
});

test('declared text mutation has one mapping, requires the displayed token and refuses unsupported bindings', {
  skip: Boolean(loadError),
}, async () => {
  const runtime = await api.createRuntime({backend: {mode: 'mock'}});
  let executions = 0;
  const client = {...api, ...runtime, executor: {execute(...args) {
    executions += 1;
    return runtime.executor.execute(...args);
  }}};
  const adapter = createImageClientAdapter(client);
  try {
    for (const imageId of ['a', 'b']) {
      await runtime.images.createImage({id: imageId});
      await runtime.images.putShape(imageId, {id: 'shape', slots: [
        {id: 'first-slot', name: 'first'}, {id: 'second-slot', name: 'second'},
      ]});
      await runtime.images.putObject(imageId, {id: 'same-id', shape: api.objectRef(imageId, 'shape'),
        slots: {'first-slot': api.textValue('first'), 'second-slot': api.textValue('second')}});
    }
    async function install(imageId, id, fields, typeFields) {
      await api.installCallableInterfaceV2({images: runtime.images, imageId,
        interfaceId: id + '-interface', functionName: 'change',
        parameters: ['string', 'string', 'change-record'], result: 'string',
        types: {'change-record': {kind: 'record', fields: typeFields}}});
      return api.installImageMutationBinding({images: runtime.images, imageId,
        callableInterface: api.objectRef(imageId, id + '-interface'), fields,
        blockId: id, bindingId: id + '-binding'});
    }
    for (const [id, slot, name] of [['first', 'first-slot', 'caption'], ['second', 'second-slot', 'body']]) {
      await install('a', id, [{name, slot}], [{name, type: 'string'}]);
      const mutation = await adapter.bindTextSlotMutation({imageId: 'a', blockId: id});
      assert.deepEqual(mutation.writableSlots, [slot]);
      const subject = api.objectRef('a', 'same-id');
      const command = createTextSlotMutationCommand({id, title: 'Edit text', mutation});
      const record = await runtime.images.getObject('a', 'same-id');
      const versionToken = api.objectVersionToken('a', 'same-id', record._version);
      const authority = runtime.authority.issue({principal: 'writer', grants: [
        {operation: 'object/write', resource: api.objectResource('a', 'same-id')},
      ]});
      const request = {subject, field: {slot}, text: id + '-edited', versionToken, authority};
      const count = executions;
      for (const absent of [undefined, null, '']) {
        await assert.rejects(mutation.mutate({...request, versionToken: absent}), /displayed version token/);
      }
      for (const invalid of [
        {field: {slot: 'wrong'}}, {subject: api.objectRef('b', 'same-id')},
        {subject: {...subject, kind: 'pinned-ref', revision: '1'}},
      ]) await assert.rejects(mutation.mutate({...request, ...invalid}), /does not match/);
      await assert.rejects(mutation.mutate({...request, text: 5}), /string text/);
      assert.equal(executions, count, 'invalid UI context never reaches an invocation');
      await assert.rejects(adapter.dispatch(command, subject, {authority,
        context: {field: {slot: 'wrong'}, text: 'wrong', versionToken}}),
      {name: 'CommandNotApplicableError'});
      await adapter.dispatch(command, subject, {authority, context: request});
      const current = await runtime.images.getObject('a', 'same-id');
      assert.deepEqual(current.slots, {...record.slots, [slot]: api.textValue(id + '-edited')},
        'wire name and slot both come from this binding, not a hardcoded probe');
    }
    for (const [id, fields, typeFields] of [
      ['number', [{name: 'x', slot: 'first-slot'}], [{name: 'x', type: 's32'}]],
      ['multiple', [{name: 'x', slot: 'first-slot'}, {name: 'y', slot: 'second-slot'}],
        [{name: 'x', type: 'string'}, {name: 'y', type: 'string'}]],
      ['indexed', [{name: 'x', indexed: true}], [{name: 'x', type: {kind: 'list', element: 'string'}}]],
    ]) {
      await install('a', id, fields, typeFields);
      await assert.rejects(adapter.bindTextSlotMutation({imageId: 'a', blockId: id}), /one mapped string slot/);
    }
    await runtime.images.putLexicalEnvironment('a', {id: 'unavailable-environment', bindings: {}});
    await runtime.images.putBlock('a', {id: 'lexical', code: api.objectRef('a', 'first-binding'),
      environment: api.objectRef('a', 'unavailable-environment')});
    await assert.rejects(adapter.bindTextSlotMutation({imageId: 'a', blockId: 'lexical'}), /no lexical environment/);
    const template = await runtime.images.getCodeArtifact('a', 'first-binding');
    for (const [id, parameters, field] of [
      ['bad-signature', ['string', 'change-record'], 'caption'],
      ['bad-map', ['string', 'string', 'change-record'], 'not-caption'],
    ]) {
      await api.installCallableInterfaceV2({images: runtime.images, imageId: 'a', interfaceId: id + '-interface',
        functionName: 'unsupported', parameters, result: 'string',
        types: {'change-record': {kind: 'record', fields: [{name: field, type: 'string'}]}}});
      await runtime.images.putCodeArtifact('a', {id: id + '-binding', representation: template.representation,
        content: template.content, dependencies: [{role: 'interface', artifact: api.objectRef('a', id + '-interface')}]});
      await runtime.images.putBlock('a', {id, code: api.objectRef('a', id + '-binding'), environment: null});
      await assert.rejects(adapter.bindTextSlotMutation({imageId: 'a', blockId: id}), /one mapped string slot/);
    }
    await install('b', 'foreign', [{name: 'x', slot: 'first-slot'}], [{name: 'x', type: 'string'}]);
    await runtime.images.putBlock('a', {id: 'foreign', code: api.objectRef('b', 'foreign-binding'), environment: null});
    const beforeForeign = await runtime.images.getObject('b', 'same-id');
    await assert.rejects(adapter.bindTextSlotMutation({imageId: 'a', blockId: 'foreign'}), /local Block/);
    assert.deepEqual(await runtime.images.getObject('b', 'same-id'), beforeForeign);
    const limited = createImageClientAdapter({...client, parseImageMutationBindingArtifact: undefined});
    await assert.rejects(limited.bindTextSlotMutation({imageId: 'a', blockId: 'first'}), /requires public Images helper/);
    await assert.rejects(adapter.bindTextSlotMutation({imageId: 'a', blockId: 'missing'}), /local Block/);
  } finally { await runtime.close(); }
});
