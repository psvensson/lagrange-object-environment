// Slice-4 TEST-ONLY guest composition (Bead lagrange-object-environment-3zb).
//
// WIRING OWNER ONLY. This module wires the REAL, UNCHANGED Environment semantic
// core (object-navigator / selection-model / environment-shell / compositor /
// command-router / command-registry / command-dispatcher / presentation-registry
// / object-presentation-providers / image-observation / model) against the TEST
// Images capability (`globalThis.imagesCapability`, slice 3B) and the REAL
// renderer port (`globalThis.rendererAdapter`, slice 3A). It owns ONLY
// composition + the thin guest Images adapter; it implements NO Images
// substrate semantics and NO renderer semantics. It is a TEST-ONLY guest
// harness: the production embedding must never reference it.
//
// The narrow slice-4 claim: the real unchanged Environment core runs in-process
// under rquickjs, consumes only the defined Images capability, and drives the
// real LinuxRendererAdapter/GTK host, preserving PR #40 Environment-level
// interaction semantics. It does NOT claim real lagrange-images portability,
// real authority enforcement, real CAS correctness, or real observation-cursor
// correctness (those are 3zb-B).
//
// Its independent counterpart is `real-images-composition.mjs`: that harness
// uses the same checked-in Environment sources with the pinned real Images
// artifact, but deliberately shares no JavaScript composition so the fake
// boundary proof and real semantic proof constrain rather than mirror each
// other.
//
// The guest Images adapter DELIBERATELY duplicates three tiny ImageClientAdapter
// seam compositions (the dispatcher image seam, the observe composition, the
// writableSlots constant) because extraction would require editing the REAL
// modules (forbidden). Recorded on the Bead (slice-3B Finding-5 decision).

import {Command} from './model.js';
import {createEnvironmentShell} from './environment-shell.js';
import {createCompositor} from './compositor.js';
import {createObjectNavigator} from './object-navigator.js';
import {createCommandRouter} from './command-router.js';
import {createCommandRegistry} from './command-registry.js';
import {createCommandDispatcher} from './command-dispatcher.js';
import {createPresentationRegistry} from './presentation-registry.js';
import {createObjectInspectorProvider, createUnavailableRefProvider, createUnauthorizedRefProvider} from './object-presentation-providers.js';
import {createSelectionModel} from './selection-model.js';
import {observeChanges} from './image-observation.js';

// --- guest-local referencesOfValue -------------------------------------------
// The fake's slots contain only leaves and direct refs ({kind:'ref', objectId}).
// This walker is honest about that: it returns a DIRECT ref, and never claims
// to walk nested composites (the real lagrange-images walker is 3zb-B).
function isRefShape(value) {
  return Boolean(
    value && typeof value === 'object'
    && (value.kind === 'ref' || value.kind === 'pinned-ref')
    && typeof value.objectId === 'string' && value.objectId.length > 0,
  );
}
function referencesOfValue(value) {
  return isRefShape(value) ? [value] : [];
}

// --- the thin guest Images adapter over the TEST port ------------------------
// Translates the Environment-facing call shape -> plain-data port request ->
// scripted response/error -> Environment-facing shape. The PORT owns transport;
// the fake host owns scripted outcomes; NEITHER owns Images semantics.
function createGuestImagesAdapter(port) {
  const api = {};
  api.readObject = async ({imageId, objectId, authority = null, blockId} = {}) =>
    port.readObject(objectId, {imageId, authority, blockId});
  api.mutateObject = async ({imageId, objectId, value, authority = null, blockId, versionToken = null} = {}) =>
    port.mutateObject(objectId, value, versionToken, {imageId, authority, blockId});
  // observe composes the REAL observeChanges over the port's observePull lane.
  // The poll closure counts completed successful pulls (the live-follow
  // anchor-sync seam: the fake's
  // live-follow-from-high-water has NO backlog, so the test must wait for >=1
  // poll before any external mutation).
  api.observe = (imageId, {authority = null, blockId, afterCursor, signal, intervalMs} = {}) =>
    observeChanges({
      poll: async (cursor) => {
        const result = await port.observePull(cursor, {imageId, authority, blockId});
        globalThis.__obsPollCount = (globalThis.__obsPollCount ?? 0) + 1;
        return result;
      },
      afterCursor, signal, intervalMs,
    });
  // The SINGLE owner of the writable-slot set the SemanticUi projector uses.
  api.writableSlots = Object.freeze(['probe-title']);
  // dispatch composes the REAL createCommandDispatcher over a guest image seam
  // that invokes the guest Command, injecting `adapter` into the invoke context
  // (the real registered Command destructures {authority, adapter, text, versionToken}).
  const dispatcher = createCommandDispatcher({
    image: async ({command, subject, authority, context}) => {
      return command.invoke(subject, {...context, authority, adapter: api});
    },
  });
  api.dispatch = (command, subject, {authority = null, context = {}} = {}) => {
    return dispatcher.dispatch({command, subject, authority, context});
  };
  return Object.freeze(api);
}

// --- composition --------------------------------------------------------------
// Builds the whole Environment and installs globalThis.__session (the boolean/
// count/string seam surface the Rust test drives). `blockId` values are inert
// opaque strings the fake carries but never interprets.
export function setup({imageId, blockIds, seededObjectIds}) {
  const port = globalThis.imagesCapability;
  const rendererAdapter = globalThis.rendererAdapter;
  if (!port) throw new Error('imagesCapability port not installed');
  if (!rendererAdapter) throw new Error('rendererAdapter port not installed');

  const adapter = createGuestImagesAdapter(port);

  const presentationRegistry = createPresentationRegistry();
  presentationRegistry.register(createObjectInspectorProvider());
  presentationRegistry.register(createUnavailableRefProvider());
  presentationRegistry.register(createUnauthorizedRefProvider());

  const commandRegistry = createCommandRegistry();
  // The REAL registered edit Command (owns the text mutation, forwards the
  // opaque versionToken the shell attaches). The value is keyed 'probe-title'
  // and WRAPPED ({value: text}) to preserve the {value} slot shape (the real
  // title->probe-title mapping + wrapping is substrate, BELOW the port, which
  // the fake deliberately does not reproduce). For the olm held-Command proof it
  // optionally awaits a guest gate AFTER the mutation commits.
  commandRegistry.register(new Command({
    id: 'set-title',
    title: 'Set title',
    appliesTo: (subject) => Boolean(subject && subject.objectId),
    invoke: async (subject, {authority, adapter: a, text, versionToken}) => {
      const result = await a.mutateObject({
        imageId: subject.imageId, objectId: subject.objectId,
        value: {'probe-title': {value: text}}, authority, blockId: blockIds.mutation, versionToken,
      });
      // olm held-Command seam: the mutation has COMMITTED; hold the edit open so
      // the self-observation arrives while editInFlight > 0 (proves the real
      // EnvironmentShell defer/drain). Released by __session.releaseGate().
      if (globalThis.__holdEdit) {
        globalThis.__gateHeld = true;
        await globalThis.__editGatePromise;
        globalThis.__gateHeld = false;
      }
      return result;
    },
  }));

  const navigator = createObjectNavigator({
    adapter, presentationRegistry, commandRegistry, referencesOfValue,
  });
  const selectionModel = createSelectionModel();
  const compositor = createCompositor({rendererAdapter});
  const shell = createEnvironmentShell({navigator, selectionModel, compositor, writableSlots: adapter.writableSlots});

  // Inert authority (the fake has no authority calculus). Threaded, never read.
  const inertAuthority = null;
  const commandRouter = createCommandRouter({
    compositor, commandRegistry,
    dispatch: (command, subject, opts) => adapter.dispatch(command, subject, opts),
    authorityProvider: async () => inertAuthority,
  });

  // The intent adapter for bindIntents: a guest object whose onIntent stores the
  // shell's FIRE-AND-FORGET routing handler. The test PULLS intents on the GTK
  // thread (activate_gtk_action / edit_gtk_field) and PUSHES them to
  // __jsenv_on_push, which calls the stored handler. bindIntents' handler is
  // already fire-and-forget (handleActivateItem/handleEditField .catch()), so
  // this never blocks the GTK thread on downstream presentOn work.
  const intentAdapter = {
    onIntent: (handler) => {
      globalThis.__intentHandler = handler;
      return () => { globalThis.__intentHandler = null; };
    },
  };

  const session = {
    imageId, blockIds, seededObjectIds, adapter, shell, compositor, selectionModel,
    navigator, commandRouter, commandRegistry, intentAdapter,
    obsEvents: 0, onDeferredCount: 0, followHandle: null,
  };
  globalThis.__session = session;

  // The fire-and-forget push handler: routes a pulled intent to the stored
  // bindIntents handler and returns IMMEDIATELY (never awaits the downstream
  // navigation/edit -> presentOn work, which would need the GTK thread). It is
  // `async` because the actor's push delivery awaits a returned Promise; the body
  // routes fire-and-forget and resolves at once.
  globalThis.__jsenv_on_push = async (payloadJson) => {
    const {intent, surfaceHandle} = JSON.parse(payloadJson);
    const h = globalThis.__intentHandler;
    if (h) h(intent, surfaceHandle);
  };

  // --- boolean/count/string seam surface (the Rust test drives these) --------
  const ref = (objectId) => ({kind: 'ref', imageId, objectId});
  const probeValue = (record) => record?.slots?.['probe-title']?.value ?? null;

  // Open the workspace on the root + bind intents; return the surface handles.
  session.open = async (rootObjectId) => {
    await shell.openWorkspace(ref(rootObjectId), {
      authority: inertAuthority, readBlockId: blockIds.read,
      viewDescriptorFor: () => ({kind: 'surface', width: 200, height: 200}),
    });
    const navigatorSurfaceHandle = compositor.surfaceHandleForView('navigator-view');
    const inspectorSurfaceHandle = compositor.surfaceHandleForView('inspector-view');
    // Bindings name LOGICAL views (navigator/inspector); the Compositor resolves
    // each emitted GTK handle to the live view at interaction time (Bead 4o8).
    // The handles below are kept ONLY for the native side's intent labelling.
    session.unsubscribeIntents = shell.bindIntents({
      adapter: intentAdapter, navigator: true, inspector: true,
      commandRouter, commandId: 'set-title', authority: inertAuthority, readBlockId: blockIds.read,
      // Diagnostic capture: the bindIntents path is otherwise fire-and-forget
      // (errors swallowed + reread). Capture the last edit error name so the
      // test/diagnostic can see a conflict/denial that would otherwise vanish.
      onEditError: (error) => { globalThis.__lastEditError = String(error?.name ?? error); },
    });
    session.navigatorSurfaceHandle = navigatorSurfaceHandle;
    session.inspectorSurfaceHandle = inspectorSurfaceHandle;
    return {
      navigatorSurfaceHandle,
      inspectorSurfaceHandle,
      rootObjectId,
      primaryObjectId: seededObjectIds.b,
    };
  };

  const selectObject = async (objectId) => {
    await shell.selectObject(ref(objectId), {authority: inertAuthority, readBlockId: blockIds.read});
  };

  session.selectPrimary = async () => {
    await selectObject(seededObjectIds.b);
    return {selected: true};
  };

  // A FRESH port read of the object's current title (the image state, NOT the UI).
  const readTitle = async (objectId) => probeValue(await adapter.readObject({
    imageId, objectId, authority: inertAuthority, blockId: blockIds.read,
  }));
  session.imageTitle = async () => readTitle(seededObjectIds.b);

  // A guest-side EXTERNAL advance behind the shell's back. It deliberately
  // crosses the same adapter -> Images capability port as every Environment
  // operation, but never routes through Shell/CommandRouter or uses the
  // shell-held token. Opaque tokens remain guest-side; only exact booleans cross.
  session.externalMutate = async (text) => {
    const objectId = seededObjectIds.b;
    const current = await adapter.readObject({
      imageId, objectId, authority: inertAuthority, blockId: blockIds.read,
    });
    const previousToken = current?.versionToken ?? null;
    const result = await adapter.mutateObject({
      imageId,
      objectId,
      value: {'probe-title': {value: text}},
      authority: inertAuthority,
      blockId: blockIds.mutation,
      versionToken: previousToken,
    });
    const nextToken = result?.versionToken ?? null;
    return {
      committed: typeof nextToken === 'string' && nextToken.length > 0,
      tokenAdvanced: previousToken !== null && nextToken !== previousToken,
    };
  };

  // The displayed title in the Compositor's durable intent (proves a reread
  // LANDED via presentOn, not a shadow). Also the presentation kind (for the
  // unauthorized-ref arm).
  session.inspector = () => {
    const v = compositor.durableIntent().find((x) => x.viewId === 'inspector-view');
    return {
      title: v?.presentationDescriptor?.parameters?.fields?.['probe-title']?.value ?? null,
      kind: v?.presentationDescriptor?.kind ?? null,
      reason: v?.presentationDescriptor?.parameters?.reason ?? null,
    };
  };

  // The shell's transient token state (boolean/equality only; the token string
  // NEVER crosses). tokenIsFresh compares against a fresh port read.
  session.tokenState = async () => {
    const objectId = seededObjectIds.b;
    const t = shell._inspectorToken();
    const fresh = (await adapter.readObject({imageId, objectId, authority: inertAuthority, blockId: blockIds.read}))?.versionToken ?? null;
    return {
      hasToken: Boolean(t.token),
      objectIdMatchesPrimary: t.objectId === objectId,
      tokenIsFresh: t.token !== null && t.token === fresh,
      obsEvents: session.obsEvents,
    };
  };

  session.obsPollCount = () => globalThis.__obsPollCount ?? 0;

  session.follow = () => {
    const observeForFollow = (id, opts) => {
      const lane = adapter.observe(id, opts);
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
      imageId, authority: inertAuthority,
      observationBlockId: blockIds.observation, readBlockId: blockIds.read,
      onUpdate: () => { session.obsEvents += 1; },
      onError: () => { session.obsError = (session.obsError ?? 0) + 1; },
      onDeferred: () => { session.onDeferredCount += 1; },
    });
    return {
      following: Boolean(session.followHandle),
      asyncIterable: session.followLaneIsAsyncIterable === true,
    };
  };
  session.unfollow = () => { if (session.followHandle) { session.followHandle.stop(); session.followHandle = null; } return true; };

  // --- olm held-Command seams ---
  session.armHold = () => {
    globalThis.__editGatePromise = new Promise((res) => { globalThis.__releaseGateFn = res; });
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

  // A direct handleEditField (used for the denied + stale arms; the live-follow
  // olm edit is driven by a GTK edit intent via bindIntents instead). Captures
  // the error name (the edit is otherwise fire-and-forget via bindIntents).
  session.edit = async (key, text) => {
    let captured = null;
    let edited = false;
    await shell.handleEditField({
      key, text, commandId: 'set-title', commandRouter,
      surfaceHandle: session.inspectorSurfaceHandle,
      authority: inertAuthority, readBlockId: blockIds.read,
      onEdited: () => { edited = true; },
      // The error arm never dead-ends: it offers a fresh authorized reread so the
      // inspector reflects the image's current value (the stale-recovery arm
      // depends on this; the denied-write arm rereads the unchanged value).
      onEditError: async (error, {reread} = {}) => {
        captured = {name: error.name};
        if (reread) await reread();
      },
    });
    return {edited, error: captured};
  };

  // The stale-token proof: capture the shell's held token at edit entry and the
  // image's CURRENT token (a fresh read), computing usedStaleToken GUEST-SIDE
  // (boolean only; the token string never crosses). The shared driver invokes
  // externalMutate FIRST through this guest adapter, then calls this seam.
  session.staleEditEntryState = async () => {
    const objectId = seededObjectIds.b;
    const held = shell._inspectorToken().token;
    const current = (await adapter.readObject({imageId, objectId, authority: inertAuthority, blockId: blockIds.read}))?.versionToken ?? null;
    // tokenAtEditEntry: the shell reads its held token SYNCHRONOUSLY at
    // handleEditField entry; that is the token it will attach (held RIGHT NOW).
    const tokenAtEditEntry = shell._inspectorToken().token;
    const usedStaleToken = tokenAtEditEntry !== null
      && tokenAtEditEntry === held
      && held !== current;
    return {usedStaleToken, heldIsNull: held === null, differsFromCurrent: held !== current};
  };

  session.prepareDeniedWrite = async () => {
    const objectId = seededObjectIds.deniedMutate;
    await selectObject(objectId);
    return {
      expectedTitle: session.inspector().title,
      sameObjectAsPrimary: objectId === seededObjectIds.b,
    };
  };

  session.deniedWriteState = async () => ({
    imageTitle: await readTitle(seededObjectIds.deniedMutate),
    inspectorTitle: session.inspector().title,
  });

  session.selectDeniedRead = async () => {
    await selectObject(seededObjectIds.deniedRead);
    return {selected: true};
  };

  session.selectUnavailable = async () => {
    await selectObject(seededObjectIds.unavailable);
    return {selected: true};
  };

  // C1 falsifier: the token must be ABSENT from durable intent, every
  // presentation descriptor's parameters, SemanticUi-derived output (the Rust
  // projector is a pure fn of the descriptor, so descriptor+GTK-text absence
  // covers it), renderer-bound payloads, and GTK-visible text. Computed entirely
  // guest-side; returns ONLY counts/booleans (the token strings never cross).
  session.c1Check = ({gtkVisibleText = [], gtkDescriptorJson = '[]'} = {}) => {
    const current = shell._inspectorToken().token;
    const creationTokens = [];
    const tokens = [...new Set([current, ...creationTokens].filter(Boolean))];
    const durableSinks = [JSON.stringify(compositor.durableIntent())];
    const presentationParameterSinks = compositor.durableIntent()
      .map((v) => JSON.stringify(v.presentationDescriptor?.parameters ?? {}));
    const gtkSinks = [gtkDescriptorJson, JSON.stringify(gtkVisibleText)];
    const sinks = [...durableSinks, ...presentationParameterSinks, ...gtkSinks];
    let leaks = 0;
    for (const sink of sinks) for (const token of tokens) if (sink.includes(token)) leaks += 1;
    return {
      currentTokenChecked: typeof current === 'string' && current.length > 0 && tokens.includes(current),
      creationTokensChecked: creationTokens.length,
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
    return {destroyed: true};
  };

  return session;
}
