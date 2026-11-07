# Native WebAssembly function host

The bounded QuickJS fallback in ADR 0014 needs a WebAssembly function host to
execute the public Images portable runtime. `js_env/host_wasm.rs` owns this
JavaScript-to-Wasmtime interaction. Images owns compilation, import, ABI choice,
value handles, effects, continuations, cache identity, instance reuse and authority.
The host recognizes none of those semantics and spawns no Node/browser process.

The supported surface is `Module(bytes)`, `Instance(module, imports)`,
`compile(bytes)` and `instantiate(module, imports)`. The byte overload of
`instantiate` is explicitly unsupported. The profile supports function imports
and exports with i32 parameters and zero or one i32 result. Conversion follows
JavaScript `value | 0`, which rejects BigInt. Imports are resolved once at
instantiation. Internal globals remain Wasmtime state. Memory/table resources and
unsupported public signatures fail explicitly; this is not a full WebAssembly
JavaScript API implementation.

JavaScript closures retain imported functions and the native call closure. Native
closures contain only Rust resources: rquickjs does not trace JavaScript values
captured by a Rust function. An exported function therefore retains its imports
and Store even after its Instance wrapper becomes unreachable. No global instance
registry pins these resources. Runtime/backend close alone does not release
Images module caches or instance pools; disposal proofs must drop those references
and collect the guest heap.

During a synchronous engine call, scoped thread-local dispatch borrows the current
QuickJS context. Wasmtime callbacks capture import indices only. They never
reacquire the runtime lock or send owner commands. Separate-instance nesting
restores the enclosing dispatch scope. Same-instance reentry fails explicitly
through checked borrowing. Imported JavaScript throws retain their exact value;
native validation/link/execution failures use CompileError, LinkError and RuntimeError.

Modules are limited to 8 MiB. Instantiation (including start) and each exported
call receive 1,000,000 fuel units. Fuel bounds Wasm instructions only: it does not
bound compilation, synchronous JavaScript imports, or a complete multi-segment
Images invocation. It does not fix the existing synchronous-JavaScript interruption
limitation. This facility is removed with the bounded embedding when the preferred
Component/WIT route can faithfully satisfy the asynchronous acceptance flow.

The existing actor shutdown grace can also be delayed by continuously ready
Promise work: the pinned rquickjs `WithFuture` drains pending jobs within one
poll. The initial native parity run exceeded its stage deadline and only later
reported clean shutdown. Bead `5ms` tracks this separate scheduling limitation;
an eventual clean shutdown does not establish that its grace deadline held.

`native_application_parity.rs` owns its test-local child lifecycle and watchdog.
It runs the same native workload in an isolated test process, with a 180-second
physical ceiling and a finite timeout control that proves kill/reap behavior.
Ordinary operations keep their 30-second budget. Only the combined imported
tokenizer initialization and input-stream bootstrap gets 90 seconds: it measured
40.217 seconds with the optimized engine, versus 116.824 seconds without it on
the same host, artifact, public mock backend and test pump. This is a test budget,
not an interactive latency or shutdown guarantee. The host development profile
optimizes only `rquickjs-sys`; debug information and assertions remain enabled.

Native parity uses trusted bootstrap/import of the canonical YAXO source input.
Authorized method replacement remains on the existing Command/adapter/Images seam.
Human-facing authorized import, E5 application-state edits and E6 restart recovery
have separate acceptance criteria.
