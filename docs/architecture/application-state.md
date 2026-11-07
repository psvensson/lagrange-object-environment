# Application-state editing

E5 uses the ordinary inspector and Command route to edit one scalar value in a
real imported YAXO application. Images imports canonical source and executes the
parser; the Environment discovers the resulting XMLStringNode through the
Project root and displayed reference actions. No application object is staged
by the Environment.

The bounded operation changes the node's text. The pinned `string:` method is
exactly a scalar assignment, so an Images `image-mutation-binding/v1` is a
sufficient public operation. This is a declared scalar edit, not an authorized
Smalltalk message send. It does not establish a way to invoke arbitrary domain
setters, mutate dictionaries, or bypass validation in other applications.

The trusted test installation uses Images' public `instanceVariableBindings`
helper to obtain the slot ID from the importer-returned class. Images installs
the callable interface and binding. Neither user navigation nor the renderer
knows this provisioning path, and no slot ID is inferred from its spelling.

`ImageClientAdapter.bindTextSlotMutation` adapts an existing immutable Block,
binding artifact and callable interface through their public Images parsers. It
supports exactly one mapped string slot, and refuses lexical environments,
foreign-image code, indexed fields and other types. The binding is the single
source of its writable-slot list and slot-to-wire-field translation. These
records are insert-only at the admitted Images revision; changed semantics
require new identities.

The generic `createTextSlotMutationCommand` delegates applicability and invocation
to that adapter operation. The existing CommandRouter obtains authority for
each invocation, the dispatcher classifies failures, and the EnvironmentShell
supplies the token paired with the displayed inspector state. Missing tokens
fail explicitly: the operation never substitutes a fresh privileged read.
Images owns authorization, Shape validation, conditional persistence and history.

After success or conflict, the composition requests a fresh authorized inspector
read. A receipt is never displayed state. The proof includes an outside write
between commit and reread: the winning value and its read token must be shown,
even when both differ from the user's submitted text and returned receipt.
Denied and stale attempts preserve state, version token and the history frontier;
a stale attempt is not silently retried. The native getter verifies the actual
application value, and parent identities and relationships remain unchanged.

## Proof scope

`test/yaxo-state.integration.test.js` runs the real pinned Node Images runtime
with its LagrangeBackend over the test-only SQLite Application Database driver.
`test/text-slot-mutation.integration.test.js` distinguishes different field maps,
missing tokens, wrong subjects and unsupported bindings. E4 remains independently
proved after its unchanged navigation harness is moved to shared test support.

This is E5 Environment consumer acceptance, not native-host E5 acceptance. The
portable root at `caf72f2` lacks `instanceVariableBindings`,
`parseImageMutationBindingArtifact`, `resolveCallableInterface` and
`resolveDeclaredType`. The adapter refuses unavailable helpers rather than
importing private modules. Bead `u4k` tracks portable exposure/admission and the
actual native GTK E5 proof. Existing browser/native regression suites establish
the shared editing route, not execution of this application-state workflow there.

E6 separately proves durable reacquisition with fresh runtime and Environment
resources; an in-memory successful edit is not restart evidence.
