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

Both the Node consumer lane (`test/yaxo-state.integration.test.js`) and the
native Linux GTK lane (`hosts/linux/tests/native_application_parity.rs`, Bead
`u4k`) prove E5 application-state editing end-to-end. At admitted Images
`dc4266c664002e69ad5ca0b67dd0b7f094c8d8e7`, `src/portable-runtime.js` re-exports
the exact owner functions `instanceVariableBindings`,
`parseImageMutationBindingArtifact`, `resolveCallableInterface` and
`resolveDeclaredType`, verified in `hosts/linux/tests/portable_images_artifact.rs`.
`hosts/linux/tests/native_application_parity.rs` navigates to the parsed
`XMLStringNode` solely via displayed GTK actions, drives real `gtk4::Entry`
edits (`edit_gtk_field`), and verifies positive state mutation, post-commit
competing write before reread, denied write (`CommandAuthorizationError`),
intervening outside write + stale conflict (`CommandConflictError`) + fresh
authorized reread, retry after reread, native getter agreement, and unchanged
ancestor records.

E6 proves durable reacquisition with fresh runtime and Environment resources
as described below; an in-memory successful edit is not restart evidence.

## Restart recovery (E6)

`test/yaxo-restart.integration.test.js` runs two fresh Node processes over one
SQLite file through the public LagrangeBackend. Process A imports canonical
source, discovers the parsed graph through the Project, performs the ordinary E5
edit, releases all views and closes storage. Only after A exits does process B
start with the database filename and `{imageId, projectId, memberKey}` locator.
The parent retains A's report solely for comparison; none of its application
refs, tokens, handles or authority enters B.

B constructs fresh runtime caches, authority service, Session and renderer
resources. It acquires the Project/member through public authorized reads and
navigates the same graph by displayed actions. The proof compares the complete
observed graph, identities, relationships and edited text, then performs another
ordinary edit and checks the native getter and fresh display. It proves that
first edit survives process restart, and that interaction can continue afterward;
it does not claim a second restart has been performed.

Recovery cannot invoke application provisioning. A refusing/counting schema
adapter makes even an idempotent provisioning attempt fail; a deliberate control
proves that refusal. Backend-owned SQL schema initialization remains allowed.
Wrong Project/member locators fail and release admitted resources, while empty,
Project-only and root-only grants still fail at their independent boundaries.
Read-only recovery leaves the committed image frontier unchanged.

The parent process helper owns serial child execution, deadlines, cancellation,
exit collection and temporary-file cleanup. It kills and awaits its child on
failure or cancellation; valid JSON from a failed process is not acceptance.
Finite child controls prove timeout/cancellation reaping. Each application process
proves nonempty live host resources and zero resources after destruction, closes
the SQL driver and demonstrates that the closed runtime cannot read.

This is durable Node consumer acceptance with a test-only SQLite Application
Database driver. It is not a distributed-cluster recovery, native-host durable
backend, launchable-product restoration or durable Perspective proof. Native
durable E6 host assembly remains separate.
