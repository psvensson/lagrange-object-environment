// Bead 3zb-B3 part 1: TEST-ONLY in-process Environment -> real Images wiring.
//
// This module owns bootstrap and dependency injection only. Environment
// semantics remain in image-client-adapter.js; Images retains runtime,
// authority, optimistic-concurrency and observation semantics. The real path
// stays entirely inside the guest and does NOT exercise the plain-data Images
// capability/WIT-shaped boundary proven independently by
// acceptance-composition.mjs.
//
// Source acquisition is the pinned Images portable artifact plus checked-in
// Environment source bytes. There is no sibling checkout, package resolver,
// filesystem fallback or Node personality. All Images helpers come through the
// one public `portable-runtime` entry.

import {createImageClientAdapter, classIdFor} from 'image-client-adapter';
import {
  createPortableRuntime,
  installSmalltalkKernel,
  findSmalltalkKernel,
  defineClass,
  installCallableInterfaceV2,
  installImageCreationBinding,
  installImageMutationBinding,
  installImageObjectReadBinding,
  installImageObservationBinding,
  objectRef,
  textValue,
  referencesOfValue,
  objectResource,
  parseObjectResource,
  objectVersionToken,
  packCompositeValue,
  unpackCompositeValue,
  normalizeTypeDeclarations,
  authorizedReadProjectDescriptor,
  createProject,
  addProjectMember,
  projectObjectId,
} from 'portable-runtime';
import {installNativeCryptoProvider} from 'host/crypto-bootstrap';

const OBSERVE_INTERVAL_MS = 10;

async function setup({imageId, ids}) {
  // Images enforces this ordering: createPortableRuntime fails fast when no
  // provider is installed.
  installNativeCryptoProvider();

  const runtime = await createPortableRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: imageId});
  await installSmalltalkKernel({images: runtime.images, imageId});

  const adapter = createImageClientAdapter({
    images: runtime.images,
    invocations: runtime.invocations,
    executor: runtime.executor,
    authority: runtime.authority,
    defineClass,
    installCallableInterfaceV2,
    installImageCreationBinding,
    installImageMutationBinding,
    installImageObjectReadBinding,
    installImageObservationBinding,
    findSmalltalkKernel,
    objectRef,
    objectResource,
    parseObjectResource,
    objectVersionToken,
    textValue,
    packCompositeValue,
    unpackCompositeValue,
    normalizeTypeDeclarations,
    authorizedReadProjectDescriptor,
    // Part 2's ObjectNavigator consumes this same public binding. Passing it
    // here keeps the composition surface identical without claiming Navigator
    // behavior in this headless adapter-only slice.
    referencesOfValue,
  });
  await adapter.ensureSchema(imageId, ids);

  const resource = (objectId) => objectResource(imageId, objectId);
  const issue = (principal, grants) => runtime.authority.issue({principal, grants});
  const grant = (operation, objectId) => ({operation, resource: resource(objectId)});

  async function readProjectFixture() {
    const projectId = 'portable-project';
    await createProject({images: runtime.images, imageId, projectId, name: 'Portable Project'});
    await addProjectMember({
      images: runtime.images, imageId, projectId,
      key: 'z-last', role: 'test', target: objectRef(imageId, 'target-z'),
    });
    await addProjectMember({
      images: runtime.images, imageId, projectId,
      key: 'a-first', role: 'source', target: objectRef(imageId, 'target-a'),
    });
    const projectAuthority = issue('alice', [grant('object/read', projectObjectId(projectId))]);
    const descriptor = await adapter.readProject({imageId, projectId, authority: projectAuthority});
    const denied = issue('mallory', []);
    const deniedKinds = [];
    for (const candidate of [projectId, 'missing-project']) {
      try {
        await adapter.readProject({imageId, projectId: candidate, authority: denied});
        deniedKinds.push('NO_THROW');
      } catch (error) {
        deniedKinds.push(error?.name ?? null);
      }
    }
    return {descriptor, deniedKinds};
  }

  return Object.freeze({
    adapter,
    classId: classIdFor(ids.className),
    reference: (objectId) => objectRef(imageId, objectId),
    authorities: Object.freeze({
      none: () => issue('mallory', []),
      create: (subjectObjectId) => issue('alice', [
        grant('object/create', classIdFor(ids.className)),
        grant('object/edge-write', subjectObjectId),
      ]),
      read: (objectId) => issue('alice', [grant('object/read', objectId)]),
      readWrite: (objectId) => issue('alice', [
        grant('object/read', objectId),
        grant('object/write', objectId),
      ]),
      readOnly: (objectId) => issue('mallory', [grant('object/read', objectId)]),
    }),
    observeIntervalMs: OBSERVE_INTERVAL_MS,
    readProjectFixture,
  });
}

export {setup};
