export {
  Command,
  Perspective,
  Presentation,
  Session,
} from './model.js';

export {
  PERSPECTIVE_FORMAT_VERSION,
  decodePerspective,
  encodePerspectiveRecord,
  encodePresentations,
} from './perspective-projection.js';

export {
  CHANGE_TYPE,
  normalizeChange,
  observeChanges,
} from './image-observation.js';

export {
  CommandAuthorizationError,
  CommandConflictError,
  CommandExecutionError,
  CommandNotApplicableError,
  classifyInvocationError,
  createCommandDispatcher,
} from './command-dispatcher.js';

export {createPresentationRegistry} from './presentation-registry.js';

export {createCommandRegistry} from './command-registry.js';

export {UNAVAILABLE_REF_KIND, UNAUTHORIZED_REF_KIND, createObjectNavigator} from './object-navigator.js';

export {
  PROJECT_PRESENTATION_KIND,
  PROJECT_SUBJECT_KIND,
  PROJECT_VIEW_ID,
  ProjectPresentationError,
  createProjectBrowser,
  createProjectPresentationProvider,
  createProjectSubject,
  resolveProjectMemberTarget,
} from './project-browser.js';

export {
  LOCATOR_RELATION as NATIVE_CLASS_RELATION,
  NATIVE_SMALLTALK_VIEW_ID,
  TARGET_GROUP as NATIVE_TARGET_GROUP,
  NATIVE_CLASS_PRESENTATION_KIND,
  NATIVE_CLASS_SUBJECT_KIND,
  NATIVE_METHOD_PRESENTATION_KIND,
  NATIVE_METHOD_SUBJECT_KIND,
  NativeClassPresentationError,
  // E3 (Bead eij.3): the production replacement affordance and its Command. A
  // composition needs all three -- the input array a descriptor carries, the
  // resolver over it, and the Command a registry registers -- and they are
  // exported TOGETHER because an affordance without its Command is a dead
  // control and a Command without its binding is unreachable.
  NATIVE_METHOD_INPUTS,
  NATIVE_METHOD_SOURCE_INPUT_ROLE,
  REPLACE_NATIVE_METHOD_COMMAND_ID,
  createNativeClassPresentationProvider,
  createNativeClassSubject,
  createNativeMethodPresentationProvider,
  createNativeMethodSubject,
  createNativeSmalltalkBrowser,
  createReplaceNativeMethodCommand,
  resolveMethodReplacementInput,
  resolveNativeTarget,
} from './native-smalltalk-browser.js';

export {
  createObjectInspectorProvider,
  createUnavailableRefProvider,
  createUnauthorizedRefProvider,
} from './object-presentation-providers.js';

export {RendererError, RendererResourceLostError} from './renderer-errors.js';

export {RENDERER_ADAPTER_METHODS, createCompositor} from './compositor.js';

export {createFakeRendererAdapter} from './fake-renderer-adapter.js';

export {
  PROBE_SHAPE_SLOTS,
  PROBE_TYPE_DECLARATIONS,
  classIdFor,
  createImageClientAdapter,
  refToEdgeString,
} from './image-client-adapter.js';
