# Native Project viewer

`lagrange-host-linux view` is the on-screen read-only assembly. Its default
command remains the GLB offscreen driver; there is exactly one binary target.
The viewer connects to the authorized application read service from ADR 0017.
The service deployment attaches to Images and owns authentication/grants; the
native host never selects a Block, issues authority, provisions data or spawns a
Node bridge.

`native_viewer/session.js` embeds the existing ImageReadConnection, remote
ImageClientAdapter, registries, ProjectBrowser, ObjectNavigator, selection,
EnvironmentShell and Compositor. The only Images entry is the pinned public
portable-runtime artifact, used for its canonical reference helper. Startup
opens the configured Project and the already-supported empty inspector. It
performs no member read unless a GTK action or explicit `--member` requests it.
Activation uses the ordinary shell binding; its returned completion Promise
covers the existing single error-reporting path and completed presentation work.

`LinuxRendererAdapter` owns stable GTK containers, mounting, replacement and
teardown. Each realization captures its opaque surface handle and immutable
epoch in a plain-intent sink. `semantic_gtk` owns the controls and emission, and
disables the sink when a realization is dropped. Existing test users retain the
default inspection buffer. Neither the adapter nor the host decodes item keys
into references or makes authorization decisions.

All clicks and Refresh enter one GTK-owned FIFO with capacity 32. Exactly one
operation is sent to the non-GTK worker at a time. After that operation completes
through rendering, the GTK owner checks the next intent's realization epoch;
a queued old event cannot select a different target under a reused key on the
same surface. Excess input is dropped without a worker backlog. The GLib callback
processes at most 64 renderer operations and never recursively iterates the main
context while borrowing the host. The worker and JavaScript owner never touch GTK.

Refresh uses ProjectBrowser.refresh and the shell's current-selection reread.
A failed Project read leaves a fixed failure status and disables the stale panes;
Refresh can reconnect. Object read refusals use existing unauthorized/unavailable
presentations. Writable capability lists are empty. No observation, writes,
compiler or native E5/E6 acceptance is claimed.

Shutdown stops input admission and closes the native network transport before
waiting for JavaScript. GTK keeps pumping teardown operations while the actor
applies its existing five-second whole-drain policy. The CLI retains an independent
eight-second process ceiling even after GUI/actor cleanup, because OS DNS can
outlive HTTP cancellation and block executor destruction. Incomplete shutdown
exits 1 with a fixed message. This does not resolve the actor's separate `5ms`
continuously-ready-Promise limitation.

`native_read_transport.rs` tests transport mechanics; `native_viewer.rs` drives
real GTK controls and launches the actual existing binary against scripted HTTP.
Those fixtures do not establish Images authorization or cluster integration.
Bead `8dh`'s separate real-cluster acceptance must use the pinned published Lagrange
package, a separately launched trusted service deployment, independently observed
source values/history, and the same production native assembly. No mock fallback
may be reported as that acceptance.

The first real deployment attempt is currently blocked in the published Lagrange
package before image creation. See [the acceptance record](native-cluster-acceptance.md)
for the exact failure, owner, pins, and remaining gate.
