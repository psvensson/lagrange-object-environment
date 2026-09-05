// Bead 3zb-B3 Part 2B: test-only full Environment -> real Images -> GTK wiring.
//
// This module owns bootstrap and dependency injection only. Environment
// semantics remain in the unchanged flat modules; Images retains authority,
// CAS, observation-cursor and state semantics. Every Images helper enters
// through the public portable-runtime alias.

import {Command} from 'model';
import {createEnvironmentShell} from 'environment-shell';
import {createCompositor} from 'compositor';
import {createObjectNavigator} from 'object-navigator';
import {createCommandRouter} from 'command-router';
import {createCommandRegistry} from 'command-registry';
import {createPresentationRegistry} from 'presentation-registry';
import {
  createObjectInspectorProvider,
  createUnavailableRefProvider,
  createUnauthorizedRefProvider,
} from 'object-presentation-providers';
import {createSelectionModel} from 'selection-model';
import {createImageClientAdapter, classIdFor} from 'image-client-adapter';
import {createProjectBrowser, createProjectPresentationProvider, createProjectSubject} from 'project-browser';
import {observeChanges} from 'image-observation';
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
  authorizedReadProject,
  authorizedRenameProject,
  authorizedDescribeSmalltalkClass,
  authorizedDescribeSmalltalkMethod,
  createProject,
  addProjectMember,
  projectObjectId,
} from 'portable-runtime';
import {installNativeCryptoProvider} from 'host/crypto-bootstrap';

const OBSERVE_INTERVAL_MS = 10;

async function setup({imageId, ids}) {
  const rendererAdapter = globalThis.rendererAdapter;
  if (!rendererAdapter) throw new Error('rendererAdapter port not installed');

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
    authorizedReadProject,
    authorizedRenameProject,
    authorizedDescribeSmalltalkClass,
    authorizedDescribeSmalltalkMethod,
  });
  await adapter.ensureSchema(imageId, ids);

  const resource = (objectId) => objectResource(imageId, objectId);
  const grant = (operation, objectId) => ({operation, resource: resource(objectId)});
  const issue = (principal, grants) => runtime.authority.issue({principal, grants});
  const authorities = Object.freeze({
    none: () => issue('mallory', []),
    create: (subjectObjectId) => issue('alice', [
      grant('object/create', classIdFor(ids.className)),
      grant('object/edge-write', subjectObjectId),
    ]),
    read: (objectId) => issue('alice', [grant('object/read', objectId)]),
    readOnly: (objectId) => issue('mallory', [grant('object/read', objectId)]),
    readWrite: (objectId) => issue('alice', [
      grant('object/read', objectId),
      grant('object/write', objectId),
    ]),
  });
  const ref = (objectId) => objectRef(imageId, objectId);
  const classId = classIdFor(ids.className);

  const primary = await adapter.createObject({
    imageId,
    classId,
    title: 'original-real',
    subject: ref('smalltalk/nil'),
    authority: authorities.create('smalltalk/nil'),
    blockId: ids.blockId,
  });
  const root = await adapter.createObject({
    imageId,
    classId,
    title: 'root-real',
    subject: ref(primary.objectId),
    authority: authorities.create(primary.objectId),
    blockId: ids.blockId,
  });
  const secret = await adapter.createObject({
    imageId,
    classId,
    title: 'secret-real',
    subject: ref('smalltalk/nil'),
    authority: authorities.create('smalltalk/nil'),
    blockId: ids.blockId,
  });
  const creationTokens = [primary.versionToken, root.versionToken, secret.versionToken];
  const missingObjectId = 'authorized-missing-real';

  const presentationRegistry = createPresentationRegistry();
  presentationRegistry.register(createObjectInspectorProvider());
  presentationRegistry.register(createUnavailableRefProvider());
  presentationRegistry.register(createUnauthorizedRefProvider());
  presentationRegistry.register(createProjectPresentationProvider());

  const commandRegistry = createCommandRegistry();
  // The ORDINARY Project rename Command (okv Slice C): composition-registered,
  // applicable to the Project subject, consuming only semantic context and
  // calling the adapter's Images-owned rename. It edits `name` and nothing else.
  commandRegistry.register(new Command({
    id: 'rename-project',
    title: 'Rename Project',
    appliesTo: (subject) => subject?.kind === 'project',
    invoke: async (subject, {authority, adapter: imageAdapter, text, versionToken, field}) => {
      if (field?.field !== 'name') throw new TypeError('rename-project edits the Project name only');
      return imageAdapter.renameProject({
        imageId: subject.imageId, projectId: subject.projectId, name: text, versionToken, authority,
      });
    },
  }));
  commandRegistry.register(new Command({
    id: 'set-title',
    title: 'Set title',
    appliesTo: (subject) => Boolean(subject && subject.objectId),
    invoke: async (subject, {authority, adapter: imageAdapter, text, versionToken}) => {
      const result = await imageAdapter.mutateObject({
        imageId: subject.imageId,
        objectId: subject.objectId,
        value: {title: text},
        authority,
        blockId: ids.mutationBlockId,
        versionToken,
      });
      if (globalThis.__holdEdit) {
        globalThis.__gateHeld = true;
        await globalThis.__editGatePromise;
        globalThis.__gateHeld = false;
      }
      return result;
    },
  }));

  const navigator = createObjectNavigator({
    adapter,
    presentationRegistry,
    commandRegistry,
    referencesOfValue,
  });
  const selectionModel = createSelectionModel();
  const compositor = createCompositor({rendererAdapter});
  const shell = createEnvironmentShell({
    navigator,
    selectionModel,
    compositor,
    writableSlots: adapter.writableSlots,
  });

  let deniedWriteMode = false;
  let projectDeniedMode = false;
  // The Project browser: owner of the project view, the edit affordance/resolver
  // and the transient Project token. Bound BEFORE any Project is opened (bindings
  // name the logical view; the Compositor resolves the GTK handle at intent time).
  const browser = createProjectBrowser({adapter, presentationRegistry, compositor});
  const projectAuthority = (projectId, {write}) => issue(write ? 'alice' : 'mallory', [
    grant('object/read', projectObjectId(projectId)),
    ...(write ? [grant('object/write', projectObjectId(projectId))] : []),
  ]);
  const commandRouter = createCommandRouter({
    compositor,
    commandRegistry,
    dispatch: (command, subject, opts) => adapter.dispatch(command, subject, opts),
    authorityProvider: async ({subject}) => subject?.kind === 'project'
      ? projectAuthority(subject.projectId, {write: !projectDeniedMode})
      : (deniedWriteMode
        ? authorities.readOnly(subject.objectId)
        : authorities.readWrite(subject.objectId)),
  });

  const intentAdapter = {
    onIntent: (handler) => {
      globalThis.__intentHandler = handler;
      return () => { globalThis.__intentHandler = null; };
    },
  };

  const session = {
    runtime,
    adapter,
    shell,
    compositor,
    selectionModel,
    navigator,
    commandRouter,
    commandRegistry,
    intentAdapter,
    primary,
    root,
    secret,
    creationTokens,
    obsEvents: 0,
    onDeferredCount: 0,
    followHandle: null,
    unsubscribeIntents: null,
  };
  // ---- Project rename leg (okv Slice C; driven only by real_images_acceptance) ----
  session.projectId = null;
  session.lastProjectEdit = null;
  session.openProject = async () => {
    const projectId = 'acceptance-project';
    await createProject({images: runtime.images, imageId, projectId, name: 'Old'});
    await addProjectMember({
      images: runtime.images, imageId, projectId,
      key: 'm', role: 'source', target: objectRef(imageId, primary.objectId),
    });
    session.projectId = projectId;
    projectDeniedMode = false;
    const opened = await browser.open(createProjectSubject({imageId, projectId}), {
      authority: projectAuthority(projectId, {write: false}),
      viewDescriptor: {kind: 'surface', width: 200, height: 200},
    });
    return {
      projectSurfaceHandle: compositor.surfaceHandleForView(browser.viewId),
      projectId,
      name: opened.presentationDescriptor.parameters.project.name,
    };
  };
  // The report never carries a token string (opaque tokens stay guest-side).
  session.projectState = async () => {
    const live = compositor.liveView(browser.viewId);
    const descriptor = live?.presentationDescriptor ?? null;
    const held = descriptor ? browser.tokenFor(descriptor) : null;
    const fresh = session.projectId === null ? null : (await adapter.readProject({
      imageId, projectId: session.projectId, authority: projectAuthority(session.projectId, {write: false}),
    })).versionToken;
    return {
      name: descriptor?.parameters?.project?.name ?? null,
      hasToken: held !== null,
      tokenIsFresh: held !== null && held === fresh,
      lastEdit: session.lastProjectEdit,
    };
  };
  session.prepareProjectDeniedWrite = async () => {
    projectDeniedMode = true;
    return {denied: true};
  };
  globalThis.__session = session;
  globalThis.__obsPollCount = 0;

  globalThis.__jsenv_on_push = async (payloadJson) => {
    const {intent, surfaceHandle} = JSON.parse(payloadJson);
    const handler = globalThis.__intentHandler;
    if (handler) handler(intent, surfaceHandle);
  };

  const titleOf = (record) => record?.slots?.['probe-title']?.value ?? null;
  const readTitle = async () => titleOf(await adapter.readObject({
    imageId,
    objectId: primary.objectId,
    authority: authorities.read(primary.objectId),
    blockId: ids.readBlockId,
  }));
  const selectObject = async (objectId, authority) => {
    await shell.selectObject(ref(objectId), {authority, readBlockId: ids.readBlockId});
  };
  const countedObserve = (observedImageId, {
    authority = null,
    blockId,
    afterCursor,
    signal,
  } = {}) => observeChanges({
    poll: async (cursor) => {
      const result = await adapter.observePull({
        imageId: observedImageId,
        afterCursor: cursor,
        authority,
        blockId,
      });
      globalThis.__obsPollCount += 1;
      return result;
    },
    afterCursor,
    signal,
    intervalMs: OBSERVE_INTERVAL_MS,
  });

  session.open = async (rootObjectId) => {
    if (rootObjectId !== root.objectId) throw new TypeError('unexpected root object id');
    await shell.openWorkspace(ref(rootObjectId), {
      authority: authorities.read(rootObjectId),
      readBlockId: ids.readBlockId,
      viewDescriptorFor: () => ({kind: 'surface', width: 200, height: 200}),
    });
    const navigatorSurfaceHandle = compositor.surfaceHandleForView('navigator-view');
    const inspectorSurfaceHandle = compositor.surfaceHandleForView('inspector-view');
    // Bindings name LOGICAL views (navigator/inspector); the Compositor resolves
    // each emitted GTK handle to the live view at interaction time (Bead 4o8).
    // The handles below are kept ONLY for the native side's intent labelling.
    session.unsubscribeIntents = shell.bindIntents({
      adapter: intentAdapter,
      navigator: true,
      inspector: true,
      commandRouter,
      commandId: 'set-title',
      authority: authorities.read(primary.objectId),
      readBlockId: ids.readBlockId,
      onEditError: (error) => {
        globalThis.__lastEditError = String(error?.name ?? error);
      },
      // The project view's edit binding (okv Slice C): the ordinary GTK edit-field
      // intent on the live project view routes to rename-project with the
      // browser's own field resolver and paired token; the reread after a commit
      // uses a per-call Project READ authority (the rename authority is write-only).
      editBindings: [{
        viewId: browser.viewId,
        commandId: 'rename-project',
        resolveField: browser.resolveField,
        tokenFor: browser.tokenFor,
        onEdited: async (result) => {
          session.lastProjectEdit = {edited: result !== null, error: null, rereadError: null};
          try {
            if (result === null) throw new Error('the edit was not routed to any Command');
            await browser.refresh({authority: projectAuthority(session.projectId, {write: false})});
          } catch (error) {
            session.lastProjectEdit.rereadError = String(error?.name ?? error);
          }
        },
        onEditError: async (error) => {
          session.lastProjectEdit = {edited: false, error: String(error?.name ?? error), rereadError: null};
          try {
            await browser.refresh({authority: projectAuthority(session.projectId, {write: false})});
          } catch (rereadError) {
            session.lastProjectEdit.rereadError = String(rereadError?.name ?? rereadError);
          }
        },
      }],
    });
    session.navigatorSurfaceHandle = navigatorSurfaceHandle;
    session.inspectorSurfaceHandle = inspectorSurfaceHandle;
    return {
      navigatorSurfaceHandle,
      inspectorSurfaceHandle,
      rootObjectId,
      primaryObjectId: primary.objectId,
    };
  };

  session.selectPrimary = async () => {
    deniedWriteMode = false;
    await selectObject(primary.objectId, authorities.read(primary.objectId));
    return {selected: true};
  };

  session.imageTitle = async () => readTitle();

  session.externalMutate = async (text) => {
    const authority = authorities.readWrite(primary.objectId);
    const current = await adapter.readObject({
      imageId,
      objectId: primary.objectId,
      authority,
      blockId: ids.readBlockId,
    });
    const previousToken = current?.versionToken ?? null;
    const result = await adapter.mutateObject({
      imageId,
      objectId: primary.objectId,
      value: {title: text},
      authority,
      blockId: ids.mutationBlockId,
      versionToken: previousToken,
    });
    const nextToken = result?.versionToken ?? null;
    return {
      committed: typeof nextToken === 'string' && nextToken.length > 0,
      tokenAdvanced: previousToken !== null && nextToken !== previousToken,
    };
  };

  session.inspector = () => {
    const view = compositor.durableIntent().find((entry) => entry.viewId === 'inspector-view');
    return {
      title: view?.presentationDescriptor?.parameters?.fields?.['probe-title']?.value ?? null,
      kind: view?.presentationDescriptor?.kind ?? null,
      reason: view?.presentationDescriptor?.parameters?.reason ?? null,
    };
  };

  session.tokenState = async () => {
    const held = shell._inspectorToken();
    const fresh = (await adapter.readObject({
      imageId,
      objectId: primary.objectId,
      authority: authorities.read(primary.objectId),
      blockId: ids.readBlockId,
    }))?.versionToken ?? null;
    return {
      hasToken: Boolean(held.token),
      objectIdMatchesPrimary: held.objectId === primary.objectId,
      tokenIsFresh: held.token !== null && held.token === fresh,
      obsEvents: session.obsEvents,
    };
  };

  session.obsPollCount = () => globalThis.__obsPollCount;

  session.follow = () => {
    const observeForFollow = (observedImageId, opts) => {
      const lane = countedObserve(observedImageId, opts);
      session.followLaneIsAsyncIterable = Boolean(
        lane && typeof lane[Symbol.asyncIterator] === 'function',
      );
      if (!session.followLaneIsAsyncIterable) {
        throw new TypeError('follow observation lane must be an async iterable');
      }
      return lane;
    };
    session.followHandle = shell.followSelected({
      observe: observeForFollow,
      imageId,
      authority: authorities.read(primary.objectId),
      observationBlockId: ids.observationBlockId,
      readBlockId: ids.readBlockId,
      onUpdate: () => { session.obsEvents += 1; },
      onError: () => { session.obsError = (session.obsError ?? 0) + 1; },
      onDeferred: () => { session.onDeferredCount += 1; },
    });
    return {
      following: Boolean(session.followHandle),
      asyncIterable: session.followLaneIsAsyncIterable === true,
    };
  };

  session.unfollow = () => {
    if (session.followHandle) {
      session.followHandle.stop();
      session.followHandle = null;
    }
    return true;
  };

  session.armHold = () => {
    globalThis.__editGatePromise = new Promise((resolve) => {
      globalThis.__releaseGateFn = resolve;
    });
    globalThis.__gateHeld = false;
    globalThis.__holdEdit = true;
    return true;
  };
  session.gateHeld = () => Boolean(globalThis.__gateHeld);
  session.deferredCount = () => session.onDeferredCount;
  session.releaseGate = () => {
    globalThis.__holdEdit = false;
    if (globalThis.__releaseGateFn) globalThis.__releaseGateFn();
    return true;
  };

  session.edit = async (key, text) => {
    let captured = null;
    let edited = false;
    await shell.handleEditField({
      key,
      text,
      commandId: 'set-title',
      commandRouter,
      surfaceHandle: session.inspectorSurfaceHandle,
      authority: authorities.read(primary.objectId),
      readBlockId: ids.readBlockId,
      onEdited: () => { edited = true; },
      onEditError: async (error, {reread} = {}) => {
        captured = {name: error.name};
        if (reread) await reread();
      },
    });
    return {edited, error: captured};
  };

  session.staleEditEntryState = async () => {
    const held = shell._inspectorToken().token;
    const current = (await adapter.readObject({
      imageId,
      objectId: primary.objectId,
      authority: authorities.read(primary.objectId),
      blockId: ids.readBlockId,
    }))?.versionToken ?? null;
    const tokenAtEditEntry = shell._inspectorToken().token;
    const usedStaleToken = tokenAtEditEntry !== null
      && tokenAtEditEntry === held
      && held !== current;
    return {
      usedStaleToken,
      heldIsNull: held === null,
      differsFromCurrent: held !== current,
    };
  };

  session.prepareDeniedWrite = async () => {
    deniedWriteMode = true;
    await selectObject(primary.objectId, authorities.readOnly(primary.objectId));
    return {
      expectedTitle: session.inspector().title,
      sameObjectAsPrimary: true,
    };
  };

  session.deniedWriteState = async () => ({
    imageTitle: titleOf(await adapter.readObject({
      imageId,
      objectId: primary.objectId,
      authority: authorities.readOnly(primary.objectId),
      blockId: ids.readBlockId,
    })),
    inspectorTitle: session.inspector().title,
  });

  session.selectDeniedRead = async () => {
    await selectObject(secret.objectId, authorities.none());
    return {selected: true};
  };

  session.selectUnavailable = async () => {
    await selectObject(missingObjectId, authorities.read(missingObjectId));
    return {selected: true};
  };

  session.c1Check = ({gtkVisibleText = [], gtkDescriptorJson = '[]'} = {}) => {
    const current = shell._inspectorToken().token;
    const retainedCreationTokens = creationTokens.filter(
      (token) => typeof token === 'string' && token.length > 0,
    );
    const tokens = [...new Set([current, ...retainedCreationTokens].filter(Boolean))];
    const durableSinks = [JSON.stringify(compositor.durableIntent())];
    const presentationParameterSinks = compositor.durableIntent()
      .map((view) => JSON.stringify(view.presentationDescriptor?.parameters ?? {}));
    const gtkSinks = [gtkDescriptorJson, JSON.stringify(gtkVisibleText)];
    const sinks = [...durableSinks, ...presentationParameterSinks, ...gtkSinks];
    let leaks = 0;
    for (const sink of sinks) {
      for (const token of tokens) if (sink.includes(token)) leaks += 1;
    }
    return {
      currentTokenChecked: typeof current === 'string'
        && current.length > 0
        && tokens.includes(current),
      creationTokensChecked: retainedCreationTokens.length,
      tokensChecked: tokens.length,
      durableSinksChecked: durableSinks.length,
      presentationParameterSinksChecked: presentationParameterSinks.length,
      gtkSinksChecked: gtkSinks.length,
      leaks,
    };
  };

  session.teardown = async () => {
    session.unfollow();
    session.unsubscribeIntents?.();
    await compositor.destroy();
    await runtime.close();
    return {destroyed: true};
  };

  return {rootObjectId: root.objectId};
}

export {setup};
