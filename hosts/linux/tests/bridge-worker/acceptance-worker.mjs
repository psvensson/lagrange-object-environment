/**
 * THROWAWAY 64j-A acceptance worker (Node side). NOT a public API; deleted when
 * 3zb embeds in-process. This runs the UNMODIFIED src/ environment core + the
 * REAL lagrange-images runtime (mock backend) against the REAL Rust
 * LinuxRendererAdapter over the bridge. It proves the SEMANTIC host-portability
 * claim: the real JS core drives the real native host.
 *
 * The host (Rust) owns GTK + mints surface handles; it drives GTK controls and
 * relays the emitted intents + the inspector's surface handle here. This worker
 * wires the FULL real graph (ImageClientAdapter + ObjectNavigator +
 * SelectionModel + Compositor[bridge adapter] + EnvironmentShell + CommandRouter
 * + CommandRegistry) and answers plain-data requests from the host. NO semantic
 * logic crosses the bridge — only the six RendererAdapter ops (JS->Rust) and the
 * intents + handle/status (Rust->JS). versionToken NEVER crosses.
 */

import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';
import {createBridgeAdapter} from './bridge.mjs';

// The src/ environment core (unmodified). Paths are relative to this file:
// hosts/linux/tests/bridge-worker/ -> repo root is ../../../..
const SRC = '../../../../src/';
const [
  {createImageClientAdapter, classIdFor},
  {createEnvironmentShell},
  {createSelectionModel},
  {createCompositor},
  {createObjectNavigator},
  {createCommandRouter},
  {Command},
  {createPresentationRegistry},
  {createCommandRegistry},
  providers,
] = await Promise.all([
  import(`${SRC}image-client-adapter.js`),
  import(`${SRC}environment-shell.js`),
  import(`${SRC}selection-model.js`),
  import(`${SRC}compositor.js`),
  import(`${SRC}object-navigator.js`),
  import(`${SRC}command-router.js`),
  import(`${SRC}model.js`),
  import(`${SRC}presentation-registry.js`),
  import(`${SRC}command-registry.js`),
  import(`${SRC}object-presentation-providers.js`),
]);
const {createObjectInspectorProvider, createUnavailableRefProvider, createUnauthorizedRefProvider} = providers;

// The REAL lagrange-images runtime (sibling repo; mock backend). Resolvable via
// env for portability; default is the sibling checkout.
const RUNTIME_URL = process.env.LAGRANGE_IMAGES_URL
  ?? pathToFileURL(new URL('../../../../../lagrange-images/src/runtime.js', import.meta.url).pathname).href;

// 64j PREFLIGHT (non-vacuous acceptance): the native-JS-core portability gate
// must HARD-FAIL when the sibling runtime is missing or unimportable — NEVER
// interpret an import failure as an acceptable skip (unlike the ordinary
// integration suite's skip-when-absent). On failure the worker emits a
// structured {event:'preflight-error'} and exits non-zero BEFORE signalling
// readiness, so the host fails fast with a named reason (not an opaque timeout).
function preflightFail(reason) {
  process.stdout.write(`${JSON.stringify({event: 'preflight-error', reason})}\n`);
  console.error(`ACCEPTANCE-PREFLIGHT-ERROR: ${reason}`);
  process.exit(2);
}
const imagesApi = await import(RUNTIME_URL).catch((error) => {
  preflightFail(`the sibling lagrange-images runtime failed to import (${RUNTIME_URL}): ${error?.message ?? error}`);
  return null; // unreachable (preflightFail exits), satisfies the type checker
});
// A successfully-imported module is not enough: the 64j proof drives the REAL
// public API, so the entry points it uses must actually be present.
const REQUIRED_RUNTIME_EXPORTS = [
  'createRuntime', 'installSmalltalkKernel', 'defineClass', 'installCallableInterfaceV2',
  'installImageCreationBinding', 'installImageMutationBinding', 'installImageObjectReadBinding',
  'installImageObservationBinding', 'findSmalltalkKernel', 'objectRef', 'objectResource',
  'parseObjectResource', 'objectVersionToken', 'textValue', 'packCompositeValue',
  'unpackCompositeValue', 'normalizeTypeDeclarations', 'referencesOfValue',
];
const missing = REQUIRED_RUNTIME_EXPORTS.filter((name) => typeof imagesApi[name] === 'undefined');
if (missing.length > 0) {
  preflightFail(`the sibling lagrange-images runtime imported but is missing required public-API exports: ${missing.join(', ')}`);
}

const IMAGE = 'native-loop-image';
const IDS = Object.freeze({
  className: 'Probe', shapeId: 'probe-shape', classId: 'probe-class',
  interfaceId: 'probe-interface', bindingId: 'probe-binding', blockId: 'probe-block',
  mutationInterfaceId: 'probe-mutate-interface', mutationBindingId: 'probe-mutate-binding', mutationBlockId: 'probe-mutate-block',
  readInterfaceId: 'object-read-interface', readBindingId: 'object-read-binding', readBlockId: 'object-read-block',
  observationInterfaceId: 'observation-interface', observationBindingId: 'observation-binding', observationBlockId: 'observation-block',
});

// --- bridge transport (newline-JSON over stdin/stdout) -----------------------
const rl = createInterface({input: process.stdin, terminal: false});
const responseHandlers = [];
const requestHandlers = new Map(); // cmd -> async fn(args) -> result
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

const bridgeAdapter = createBridgeAdapter({
  send,
  onResponse: (fn) => responseHandlers.push(fn),
  onEvent: () => {},
});

rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  // A response to a bridge op the adapter issued (id-correlated).
  if (typeof msg.id === 'number' && ('ok' in msg || 'err' in msg)) {
    for (const fn of responseHandlers) fn(msg);
    return;
  }
  // A GTK intent event from the host: feed the shell's intent seam.
  if (msg.event === 'intent') {
    for (const fn of intentListeners) fn(msg.intent, msg.surfaceHandle);
    return;
  }
  // A host request: {cmd, reqId, args} -> {reqId, ok|err}.
  if (typeof msg.cmd === 'string' && requestHandlers.has(msg.cmd)) {
    try {
      const result = await requestHandlers.get(msg.cmd)(msg.args ?? {});
      send({reqId: msg.reqId, ok: result ?? null});
    } catch (error) {
      send({reqId: msg.reqId, err: String(error?.message ?? error)});
    }
  }
});

// The intent seam the bridge adapter's onIntent drives (the host relays GTK
// intents as {event:'intent'}; bindIntents subscribes via adapter.onIntent).
const intentListeners = new Set();
const originalOnIntent = bridgeAdapter.onIntent;
bridgeAdapter.onIntent = (fn) => {
  intentListeners.add(fn);
  return () => intentListeners.delete(fn);
};
void originalOnIntent;

// --- build the real environment graph ----------------------------------------
let session = null;

async function openSession() {
  const runtime = await imagesApi.createRuntime({backend: {mode: 'mock'}});
  await runtime.images.createImage({id: IMAGE});
  await imagesApi.installSmalltalkKernel({images: runtime.images, imageId: IMAGE});
  const adapter = createImageClientAdapter({
    images: runtime.images,
    invocations: runtime.invocations,
    executor: runtime.executor,
    defineClass: imagesApi.defineClass,
    installCallableInterfaceV2: imagesApi.installCallableInterfaceV2,
    installImageCreationBinding: imagesApi.installImageCreationBinding,
    installImageMutationBinding: imagesApi.installImageMutationBinding,
    installImageObjectReadBinding: imagesApi.installImageObjectReadBinding,
    installImageObservationBinding: imagesApi.installImageObservationBinding,
    findSmalltalkKernel: imagesApi.findSmalltalkKernel,
    objectRef: imagesApi.objectRef,
    objectResource: imagesApi.objectResource,
    parseObjectResource: imagesApi.parseObjectResource,
    objectVersionToken: imagesApi.objectVersionToken,
    textValue: imagesApi.textValue,
    packCompositeValue: imagesApi.packCompositeValue,
    unpackCompositeValue: imagesApi.unpackCompositeValue,
    normalizeTypeDeclarations: imagesApi.normalizeTypeDeclarations,
  });
  await adapter.ensureSchema(IMAGE, IDS);

  const presentationRegistry = createPresentationRegistry();
  presentationRegistry.register(createObjectInspectorProvider());
  presentationRegistry.register(createUnavailableRefProvider());
  presentationRegistry.register(createUnauthorizedRefProvider());
  const commandRegistry = createCommandRegistry();
  commandRegistry.register(new Command({
    id: 'set-title',
    title: 'Set title',
    appliesTo: (subject) => Boolean(subject && subject.objectId),
    invoke: async (subject, {authority, adapter: a, text, versionToken}) => a.mutateObject({
      imageId: subject.imageId, objectId: subject.objectId,
      value: {title: text}, authority, blockId: IDS.mutationBlockId, versionToken,
    }),
  }));
  const navigator = createObjectNavigator({
    adapter, presentationRegistry, commandRegistry, referencesOfValue: imagesApi.referencesOfValue,
  });
  const selectionModel = createSelectionModel();
  // The Compositor drives the REAL Rust LinuxRendererAdapter over the bridge.
  const compositor = createCompositor({rendererAdapter: bridgeAdapter});
  const shell = createEnvironmentShell({navigator, selectionModel, compositor, writableSlots: adapter.writableSlots});

  const classId = classIdFor(IDS.className);
  const ref = (objectId) => ({kind: 'ref', imageId: IMAGE, objectId});
  const readAuthority = (objectId) => runtime.authority.issue({
    principal: 'alice', grants: [{operation: 'object/read', resource: imagesApi.objectResource(IMAGE, objectId)}],
  });
  const writeAuthority = (objectId) => runtime.authority.issue({
    principal: 'alice', grants: [{operation: 'object/write', resource: imagesApi.objectResource(IMAGE, objectId)}],
  });
  const createAuthority = (subjectTarget) => runtime.authority.issue({
    principal: 'alice',
    grants: [
      {operation: 'object/create', resource: imagesApi.objectResource(IMAGE, classId)},
      {operation: 'object/edge-write', resource: imagesApi.objectResource(IMAGE, subjectTarget)},
    ],
  });

  // Root references B (browse root -> activate reference); B is inspected+edited.
  const created = await adapter.createObject({
    imageId: IMAGE, classId, title: 'original', subject: ref('smalltalk/nil'), authority: createAuthority('smalltalk/nil'), blockId: IDS.blockId,
  });
  const root = await adapter.createObject({
    imageId: IMAGE, classId, title: 'root', subject: ref(created.objectId), authority: createAuthority(created.objectId), blockId: IDS.blockId,
  });

  const commandRouter = createCommandRouter({
    compositor,
    commandRegistry,
    dispatch: (command, subject, opts) => adapter.dispatch(command, subject, opts),
    authorityProvider: async ({subject}) => writeAuthority(subject.objectId),
  });

  // Open the workspace on the root: the Compositor drives createSurface +
  // attachPresentation over the bridge to the REAL Rust adapter (navigator +
  // inspector GTK panes appear natively).
  await shell.openWorkspace(ref(root.objectId), {
    authority: readAuthority(root.objectId),
    readBlockId: IDS.readBlockId,
    viewDescriptorFor: () => ({kind: 'surface', width: 200, height: 200}),
  });

  // The navigator + inspector surface handles the RUST adapter minted, read back
  // via the Compositor's read-only view->handle lookup (the JS core owns the map;
  // the handles are the Rust adapter's process-unique strings).
  const navigatorSurfaceHandle = compositor.surfaceHandleForView('navigator-view');
  const inspectorSurfaceHandle = compositor.surfaceHandleForView('inspector-view');

  // Wire the host-neutral intent seam: GTK intents (relayed by the host) route
  // to the shell owners. activate-item -> selection; edit-field -> handleEditField.
  shell.bindIntents({
    adapter: bridgeAdapter,
    navigatorSurfaceHandle,
    inspectorSurfaceHandle,
    commandRouter,
    commandId: 'set-title',
    authority: readAuthority(created.objectId),
    readBlockId: IDS.readBlockId,
  });

  session = {
    runtime, adapter, shell, compositor, selectionModel, navigator, commandRouter, commandRegistry,
    ref, readAuthority, writeAuthority, created, root,
    navigatorSurfaceHandle, inspectorSurfaceHandle,
    follow: null,
    obsEvents: 0, // count of observation->reread landings (proves the lane fired)
  };
  return {
    rootObjectId: root.objectId,
    createdObjectId: created.objectId,
    navigatorSurfaceHandle,
    inspectorSurfaceHandle,
  };
}

// --- host request handlers ----------------------------------------------------
requestHandlers.set('open', async () => openSession());

// Start observation-driven reread (the acceptance flow's observation leg). The
// shell re-reads + presentOn on each observed change to the selected object.
requestHandlers.set('follow', async () => {
  const s = session;
  s.follow = s.shell.followSelected({
    observe: (imageId, opts) => s.adapter.observe(imageId, opts),
    imageId: IMAGE,
    authority: s.readAuthority(s.created.objectId),
    observationBlockId: IDS.observationBlockId,
    readBlockId: IDS.readBlockId,
    onUpdate: (d, change) => {
      s.obsEvents += 1;
      console.error(`OBS-REREAD #${s.obsEvents} objectId=${change.objectId}`);
    },
    onError: (e) => console.error(`OBS-ERROR ${e?.name}: ${e?.message}`),
  });
  return {following: true};
});

// The current inspector's field value (the JS core's authoritative descriptor;
// the host asserts the GTK pane matches). readObject reads the IMAGE state.
requestHandlers.set('title', async () => {
  const read = await session.adapter.readObject({
    imageId: IMAGE, objectId: session.created.objectId,
    authority: session.readAuthority(session.created.objectId), blockId: IDS.readBlockId,
  });
  return {title: read?.slots?.['probe-title']?.value ?? null};
});

// The current inspector descriptor's displayed title (what the Compositor last
// presented — proves the reread landed, NOT a shadow). The JS durable intent.
requestHandlers.set('inspectorTitle', async () => {
  const v = session.compositor.durableIntent().find((x) => x.viewId === 'inspector-view');
  return {title: v?.presentationDescriptor?.parameters?.fields?.['probe-title']?.value ?? null};
});

// The shell's transient token state (proves C1 invariants; the token itself
// NEVER crosses the bridge — only a boolean about its presence/change).
requestHandlers.set('tokenState', async () => {
  const t = session.shell._inspectorToken();
  // Also report the image's CURRENT version token so the host can compare
  // (proves whether the shell's token is stale vs. the image, without crossing
  // the token itself — only an equality boolean).
  const read = await session.adapter.readObject({
    imageId: IMAGE, objectId: session.created.objectId,
    authority: session.readAuthority(session.created.objectId), blockId: IDS.readBlockId,
  });
  const fresh = read?.versionToken ?? null;
  return {
    hasToken: Boolean(t.token),
    objectId: t.objectId,
    tokenIsFresh: t.token !== null && t.token === fresh,
    obsEvents: session.obsEvents,
  };
});

// An external mutation (the stale-token setup): advance the version behind the
// shell's back so its held token becomes stale.
requestHandlers.set('externalMutate', async ({title}) => {
  await session.adapter.mutateObject({
    imageId: IMAGE, objectId: session.created.objectId, value: {title},
    authority: session.writeAuthority(session.created.objectId), blockId: IDS.mutationBlockId,
  });
  return {mutated: true};
});

// Drive the NORMAL edit path via handleEditField, capturing any error (the
// worker surfaces it; the bindIntents path intentionally swallows + rereads).
requestHandlers.set('edit', async ({key, text}) => {
  let captured = null;
  let edited = null;
  await session.shell.handleEditField({
    key, text, commandId: 'set-title', commandRouter: session.commandRouter,
    inspectorSurfaceHandle: session.inspectorSurfaceHandle,
    authority: session.readAuthority(session.created.objectId), readBlockId: IDS.readBlockId,
    onEdited: (r) => { edited = {result: r === null ? null : 'ok'}; },
    onEditError: (error) => { captured = {name: error.name, message: String(error?.message ?? error)}; },
  });
  return {edited, error: captured};
});

// A denied-write CommandRouter (no write grant) for the denied arm. The host
// triggers an edit through THIS router to prove a denied WRITE surfaces
// CommandAuthorizationError and mutates nothing.
requestHandlers.set('editDenied', async ({key, text}) => {
  // A denied-write CommandRouter (no write grant) over the SAME registry. The
  // shell resolves key->slot + the transient token, then routes through this
  // router -> fresh (empty) authority -> CommandAuthorizationError, no mutation.
  const deniedRouter = createCommandRouter({
    compositor: session.compositor,
    commandRegistry: session.commandRegistry,
    dispatch: (command, subject, opts) => session.adapter.dispatch(command, subject, opts),
    authorityProvider: async () => session.runtime.authority.issue({principal: 'mallory', grants: []}),
  });
  let captured = null;
  await session.shell.handleEditField({
    key, text, commandId: 'set-title', commandRouter: deniedRouter,
    inspectorSurfaceHandle: session.inspectorSurfaceHandle,
    authority: session.readAuthority(session.created.objectId), readBlockId: IDS.readBlockId,
    onEditError: (error) => { captured = {name: error.name}; },
  });
  return {error: captured};
});

// A GENUINE stale-token conflict under active follow: advance the version
// EXTERNALLY, then drive an edit through handleEditField WITHOUT yielding to the
// follow loop in between — so the shell captures the pre-external (stale) token.
// This is the deterministic conflict: handleEditField reads the held token
// synchronously at entry, before any follow reread can refresh it. Optimistic
// concurrency must REJECT the stale edit (NOT last-writer-wins); the recovery
// reread shows the current (external) value.
requestHandlers.set('staleConflictEdit', async ({externalTitle, key, text}) => {
  await session.adapter.mutateObject({
    imageId: IMAGE, objectId: session.created.objectId, value: {title: externalTitle},
    authority: session.writeAuthority(session.created.objectId), blockId: IDS.mutationBlockId,
  });
  // NO await of the follow loop here: handleEditField captures the still-stale
  // token synchronously. (The follow loop runs on the JS event loop between
  // awaits; by not yielding, we keep the token stale for this edit.)
  let captured = null;
  let rereadValue = null;
  await session.shell.handleEditField({
    key, text, commandId: 'set-title', commandRouter: session.commandRouter,
    inspectorSurfaceHandle: session.inspectorSurfaceHandle,
    authority: session.readAuthority(session.created.objectId), readBlockId: IDS.readBlockId,
    onEditError: async (error, {reread}) => {
      captured = {name: error.name};
      const d = await reread();
      rereadValue = d?.parameters?.fields?.['probe-title']?.value ?? null;
    },
  });
  return {error: captured, rereadValue};
});

// Stop the observation->reread lane (used to isolate the edit from the
// follow race; the integration test stops follow before editing).
requestHandlers.set('unfollow', async () => {
  if (session?.follow) {
    session.follow.stop();
    session.follow = null;
  }
  return {following: false};
});

// C1 FALSIFIER (native loop): the versionToken must NEVER appear in any sink
// that crosses (or could cross) the bridge — the Compositor's durableIntent,
// every presentationDescriptor's parameters, and the GTK-visible text. The token
// itself must NEVER cross the bridge, so this handler computes the leak check
// ENTIRELY worker-side and returns ONLY booleans (never the token). It checks
// the CURRENT token plus the created object's token (both real tokens).
requestHandlers.set('c1Check', async ({gtkVisibleText = []} = {}) => {
  const current = session.shell._inspectorToken().token;
  const createdToken = session.created.versionToken;
  const tokenStrings = [...new Set([current, createdToken].filter(Boolean))];
  // Sinks that would cross the bridge: the durable intent (the Perspective-shaped
  // data), each presentation descriptor's parameters (what attachPresentation
  // sends to the host), and the GTK-visible text the host read back.
  const sinks = [
    JSON.stringify(session.compositor.durableIntent()),
    ...session.compositor.durableIntent().map((v) => JSON.stringify(v.presentationDescriptor?.parameters ?? {})),
    JSON.stringify(gtkVisibleText),
  ];
  let leaks = 0;
  for (const sink of sinks) {
    for (const token of tokenStrings) {
      if (sink.includes(token)) leaks += 1;
    }
  }
  return {
    tokensChecked: tokenStrings.length, // >0 proves we actually checked real tokens
    sinksChecked: sinks.length,
    leaks, // MUST be 0
  };
});

// Graceful shutdown.
requestHandlers.set('close', async () => {
  if (session?.follow) session.follow.stop();
  if (session?.compositor) await session.compositor.destroy();
  setTimeout(() => process.exit(0), 20);
  return {closed: true};
});

// Signal readiness to the host.
send({event: 'ready'});
console.error('ACCEPTANCE-WORKER-READY');
