import assert from 'node:assert/strict';
import test from 'node:test';

import {Presentation} from '../src/model.js';
import {createPresentationRegistry} from '../src/presentation-registry.js';
import {
  PROJECT_VIEW_ID,
  ProjectPresentationError,
  createProjectBrowser,
  createProjectPresentationProvider,
  createProjectSubject,
  resolveProjectMemberTarget,
} from '../src/project-browser.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

function project(projectId, name, members = []) {
  return Object.freeze({
    format: 'lagrange-project/v1', projectId, name, namespace: null,
    members: Object.freeze(members),
  });
}

function ref(imageId, objectId) {
  return Object.freeze({kind: 'ref', imageId, objectId});
}

function fakeCompositor() {
  const views = new Map();
  const calls = [];
  return Object.freeze({
    async openView({viewId, viewDescriptor, presentationDescriptor}) {
      if (views.has(viewId)) throw new TypeError(`duplicate view ${viewId}`);
      views.set(viewId, {viewDescriptor, presentationDescriptor});
      calls.push({kind: 'open', viewId, presentationDescriptor});
      return viewId;
    },
    async presentOn(viewId, presentationDescriptor) {
      const view = views.get(viewId);
      if (!view) throw new TypeError(`missing view ${viewId}`);
      view.presentationDescriptor = presentationDescriptor;
      calls.push({kind: 'present', viewId, presentationDescriptor});
    },
    async closeView(viewId) {
      if (!views.has(viewId)) throw new TypeError(`missing view ${viewId}`);
      views.delete(viewId);
      calls.push({kind: 'close', viewId});
    },
    viewStatus: (viewId) => views.has(viewId) ? 'live' : null,
    descriptor: (viewId) => views.get(viewId)?.presentationDescriptor ?? null,
    calls: () => [...calls],
  });
}

function registryWithProjectProvider() {
  const registry = createPresentationRegistry();
  registry.register(createProjectPresentationProvider());
  return registry;
}

function idleObservation(signal, {started} = {}) {
  return (async function* observe() {
    if (started) started.resolve();
    await new Promise((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', resolve, {once: true});
    });
  })();
}

test('Project provider preserves the canonical descriptor and identity includes Image + Project', async () => {
  const canonical = project('same', 'A', [
    Object.freeze({key: 'member/a', role: 'source', target: ref('b', 'target')}),
  ]);
  const adapter = {
    readProject: async () => canonical,
    observe: () => idleObservation(new AbortController().signal),
  };
  const browser = createProjectBrowser({
    adapter, presentationRegistry: registryWithProjectProvider(), compositor: fakeCompositor(),
  });

  const a = createProjectSubject({imageId: 'a', projectId: 'same'});
  const result = await browser.browse(a, {authority: Object.freeze({opaque: true})});
  assert.equal(result.presentation.context.project, canonical,
    'the Images-owned canonical descriptor is retained by identity, never copied');
  assert.equal(result.presentation.subject.imageId, 'a');

  const provider = createProjectPresentationProvider();
  const inB = provider.present(createProjectSubject({imageId: 'b', projectId: 'same'}), {project: canonical});
  assert.notEqual(result.presentation.id, inB.id,
    'same Project id in different Images must not alias presentation identity');
});

test('ProjectBrowser alone enforces exact-one Project presentation selection and surfaces provider failures', async () => {
  const subject = createProjectSubject({imageId: 'img', projectId: 'p'});
  const canonical = project('p', 'P');
  const adapter = {readProject: async () => canonical, observe: () => idleObservation(new AbortController().signal)};

  const none = createPresentationRegistry();
  none.register({id: 'broken-project', present() { throw new Error('provider broke'); }});
  const noBrowser = createProjectBrowser({adapter, presentationRegistry: none, compositor: fakeCompositor()});
  await assert.rejects(
    noBrowser.browse(subject),
    (error) => error instanceof ProjectPresentationError
      && error.failures.length === 1 && /no Project presentation/.test(error.message),
  );

  const ambiguous = createPresentationRegistry();
  ambiguous.register(createProjectPresentationProvider());
  ambiguous.register({
    id: 'second-project',
    present(candidate, context) {
      return new Presentation({
        id: 'second', subject: candidate, kind: 'project', context: {project: context.project}, state: {},
      });
    },
  });
  const ambiguousBrowser = createProjectBrowser({
    adapter, presentationRegistry: ambiguous, compositor: fakeCompositor(),
  });
  await assert.rejects(
    ambiguousBrowser.browse(subject),
    (error) => error instanceof ProjectPresentationError && /ambiguous/.test(error.message),
  );
});

test('Project member resolver uses the current descriptor index while stable key remains member identity', () => {
  const first = ref('a', 'old');
  const retargeted = ref('b', 'new');
  const descriptor = (target) => ({
    kind: 'project',
    parameters: {project: project('p', 'P', [{key: 'stable-key', role: 'source', target}])},
  });

  assert.equal(resolveProjectMemberTarget(descriptor(first), 0), first);
  assert.equal(resolveProjectMemberTarget(descriptor(retargeted), 0), retargeted,
    'a fresh descriptor with the same durable key resolves its new cross-Image target');
  for (const stale of [-1, 1, 0.5, 'stable-key', null]) {
    assert.equal(resolveProjectMemberTarget(descriptor(first), stale), null);
  }
});

test('follow rereads and explicit refresh share one lane, so the later explicit refresh wins', async () => {
  const followRead = deferred();
  const followReadStarted = deferred();
  const observationReleased = deferred();
  let reads = 0;
  const descriptors = [
    project('p', 'open'),
    project('p', 'follow-old'),
    project('p', 'explicit-new'),
  ];
  const adapter = {
    async readProject() {
      const index = reads++;
      if (index === 1) {
        followReadStarted.resolve();
        return followRead.promise;
      }
      return descriptors[index];
    },
    observe(_imageId, {signal}) {
      return (async function* changes() {
        yield {type: 'record.put', objectId: 'opaque-project-root'};
        await new Promise((resolve) => {
          observationReleased.resolve();
          signal.addEventListener('abort', resolve, {once: true});
        });
      })();
    },
  };
  const compositor = fakeCompositor();
  const browser = createProjectBrowser({adapter, presentationRegistry: registryWithProjectProvider(), compositor});
  await browser.open(createProjectSubject({imageId: 'img', projectId: 'p'}));
  const follow = browser.follow({observationBlockId: 'observe'});
  await followReadStarted.promise;
  const explicit = browser.refresh();
  followRead.resolve(descriptors[1]);
  await explicit;

  assert.equal(compositor.descriptor(PROJECT_VIEW_ID).parameters.project.name, 'explicit-new');
  assert.deepEqual(
    compositor.calls().filter(({kind}) => kind === 'present')
      .map(({presentationDescriptor}) => presentationDescriptor.parameters.project.name),
    ['follow-old', 'explicit-new'],
    'serialized invocation order prevents the slower follow from overwriting the later refresh',
  );
  follow.stop();
  await follow.done;
  await observationReleased.promise;
});

test('stopping follow releases its unresolved read and suppresses every late effect', async () => {
  const staleRead = deferred();
  const staleReadStarted = deferred();
  const explicitReadStarted = deferred();
  let reads = 0;
  let updates = 0;
  const adapter = {
    async readProject() {
      reads += 1;
      if (reads === 1) return project('p', 'Open');
      if (reads === 2) {
        staleReadStarted.resolve();
        return staleRead.promise;
      }
      explicitReadStarted.resolve();
      return project('p', 'Explicit');
    },
    observe(_imageId, {signal}) {
      return (async function* changes() {
        yield {type: 'record.put', objectId: 'opaque'};
        await new Promise((resolve) => signal.addEventListener('abort', resolve, {once: true}));
      })();
    },
  };
  const compositor = fakeCompositor();
  const browser = createProjectBrowser({adapter, presentationRegistry: registryWithProjectProvider(), compositor});
  await browser.open(createProjectSubject({imageId: 'img', projectId: 'p'}));
  const follow = browser.follow({
    observationBlockId: 'observe',
    onUpdate() { updates += 1; },
  });
  await staleReadStarted.promise;

  follow.stop();
  await follow.done;
  const explicit = browser.refresh();
  await explicitReadStarted.promise;
  await explicit;
  assert.equal(compositor.descriptor(PROJECT_VIEW_ID).parameters.project.name, 'Explicit',
    'a later explicit refresh completes while the stopped read remains unresolved');

  staleRead.resolve(project('p', 'Late stale follow'));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(compositor.descriptor(PROJECT_VIEW_ID).parameters.project.name, 'Explicit');
  assert.equal(updates, 0, 'a stopped follow never reports the late read');
  assert.deepEqual(
    compositor.calls().filter(({kind}) => kind === 'present')
      .map(({presentationDescriptor}) => presentationDescriptor.parameters.project.name),
    ['Explicit'],
    'a stopped follow never presents the late read',
  );
});

test('replacement open bypasses an unresolved old follow read and fails with no stale view', async () => {
  const oldRead = deferred();
  const oldReadStarted = deferred();
  const replacementReadStarted = deferred();
  let reads = 0;
  let observationIterations = 0;
  const adapter = {
    async readProject({projectId}) {
      reads += 1;
      if (reads === 1) return project('old', 'Old');
      if (reads === 2) {
        oldReadStarted.resolve();
        return oldRead.promise;
      }
      replacementReadStarted.resolve();
      throw Object.assign(new Error(`denied ${projectId}`), {name: 'AuthorityError'});
    },
    observe(_imageId, {signal}) {
      return (async function* changes() {
        observationIterations += 1;
        yield {type: 'record.put', objectId: 'opaque'};
        await new Promise((resolve) => signal.addEventListener('abort', resolve, {once: true}));
        observationIterations += 1;
      })();
    },
  };
  const compositor = fakeCompositor();
  const browser = createProjectBrowser({adapter, presentationRegistry: registryWithProjectProvider(), compositor});
  await browser.open(createProjectSubject({imageId: 'a', projectId: 'old'}));
  const oldFollow = browser.follow({observationBlockId: 'observe'});
  await oldReadStarted.promise;

  const replacement = browser.open(createProjectSubject({imageId: 'b', projectId: 'denied'}));
  let oldDoneSettled = false;
  await oldFollow.done.then(() => { oldDoneSettled = true; });
  assert.equal(oldDoneSettled, true, 'replacement acknowledges the old follow stop before its read can finish');
  assert.equal(browser.activeSubject(), null, 'replacement clears old active identity immediately');

  await replacementReadStarted.promise;
  assert.equal(compositor.viewStatus(PROJECT_VIEW_ID), null,
    'the old view closes and replacement read starts while the stale read remains unresolved');
  await assert.rejects(replacement, (error) => error?.name === 'AuthorityError');
  assert.equal(compositor.viewStatus(PROJECT_VIEW_ID), null,
    'failed replacement closes the old view and admits no new one');
  assert.equal(browser.activeSubject(), null);

  oldRead.resolve(project('old', 'Late old result'));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(compositor.viewStatus(PROJECT_VIEW_ID), null,
    'the late stale descriptor cannot reopen or present a Project view');
  assert.equal(observationIterations, 1, 'the stopped old iterator performs no later observation iteration');
});

test('successful replacement bypasses an unresolved old follow read and admits only the new subject', async () => {
  const oldRead = deferred();
  const oldReadStarted = deferred();
  const replacementReadStarted = deferred();
  let reads = 0;
  const adapter = {
    async readProject() {
      reads += 1;
      if (reads === 1) return project('old', 'Old');
      if (reads === 2) {
        oldReadStarted.resolve();
        return oldRead.promise;
      }
      replacementReadStarted.resolve();
      return project('new', 'New');
    },
    observe(_imageId, {signal}) {
      return (async function* changes() {
        yield {type: 'record.put', objectId: 'opaque'};
        await new Promise((resolve) => signal.addEventListener('abort', resolve, {once: true}));
      })();
    },
  };
  const compositor = fakeCompositor();
  const browser = createProjectBrowser({adapter, presentationRegistry: registryWithProjectProvider(), compositor});
  await browser.open(createProjectSubject({imageId: 'a', projectId: 'old'}));
  const oldFollow = browser.follow({observationBlockId: 'observe'});
  await oldReadStarted.promise;
  const replacement = browser.open(createProjectSubject({imageId: 'b', projectId: 'new'}));
  await oldFollow.done;
  await replacementReadStarted.promise;
  await replacement;

  assert.deepEqual(browser.activeSubject(), {kind: 'project', imageId: 'b', projectId: 'new'});
  assert.deepEqual(compositor.descriptor(PROJECT_VIEW_ID).subject,
    {kind: 'project', imageId: 'b', projectId: 'new'});

  oldRead.resolve(project('old', 'Late old result'));
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(compositor.descriptor(PROJECT_VIEW_ID).subject,
    {kind: 'project', imageId: 'b', projectId: 'new'},
    'the late stale descriptor cannot overwrite the replacement');
});
