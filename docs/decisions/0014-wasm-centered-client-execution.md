# ADR 0014: WASM/WIT is the central portable client execution boundary

## Status

Accepted.

This ADR **supersedes ADR 0013 decision 5 and the corresponding rejected-alternative wording only**. ADR 0013's other decisions remain in force: the browser is a reference host rather than the client platform; `RendererAdapter` remains the host-renderer portability boundary; SemanticUi remains semantic rather than a widget toolkit; and browser -> Linux -> Android remains the host progression.

ADR 0011's Component-backed graphics direction also remains in force. This ADR extends the same Component/WIT principle upward to the environment/client execution architecture.

## Context

ADR 0013 deliberately deferred the environment-core runtime choice. It named three possibilities: embed JavaScript in native hosts, port the core, or eventually make the environment itself a WASM Component. The first native semantic proof (PR #40 / Bead 64j) used the smallest credible falsifier: the real, unmodified JavaScript environment core ran in a throwaway Node child and drove the real Linux `RendererAdapter`. That proof was successful and established that the semantic architecture is host-portable without widening the six-op renderer contract.

The follow-up embedding investigation then exposed the cost of making a native JavaScript VM the architectural answer. The real acceptance closure reaches not only the environment code but substantial `lagrange-images` implementation machinery. Node-specific vocabulary such as `Buffer` and `node:crypto` appears because the client process is embedding substrate implementation details, not because those details belong to the environment. Repeating that model for future languages would lead toward one bespoke native bridge/runtime per language.

That is the wrong direction for Lagrange. The platform already treats WebAssembly Components and WIT as the portable executable/interface boundary for image execution and graphics. Language additions should converge on that boundary rather than add peer host architectures.

## Decision

1. **WASM Components + WIT are the normal portable execution boundary for the client as well as image/service execution.** Host-portable environment logic, extensions and future language-produced executable client logic should preferentially cross hosts as Components with explicit WIT imports/exports.

2. **Per-language native embeddings are not the language-support architecture.** Adding Go, Java, JavaScript, Rust or another language must not normally mean adding a Go<->Rust, Java<->Rust or JS<->Rust semantic bridge. Language toolchains may differ, but the host-facing result should converge on a WASM Component/WIT contract where viable.

3. **The existing JavaScript environment core remains the reference semantic implementation, but componentizing it is now the preferred direction, not a distant option.** A successful path may package the existing JS implementation into a Component; this decision does not require a rewrite to Rust.

4. **The native host remains native.** "WASM in the center" does not mean GTK, Android platform controls, GPU drivers, windowing, text shaping, accessibility or other OS resources move into WASM. The host owns concrete resources and exposes narrow capabilities to Components.

5. **WIT boundaries must follow existing semantic ownership rather than duplicate it.** In particular:
   - rendering imports reflect the existing renderer/SemanticUi ownership and must not teach the Rust host key->ref, key->slot, Command, authority or version-token semantics;
   - image imports expose public, authorized `lagrange-images` capabilities rather than embedding or reproducing private Images storage/runtime internals in the environment;
   - observation, crypto, version-token and codec semantics stay with `lagrange-images`; the client consumes their public semantic results.

6. **Do not freeze a large new WIT surface speculatively.** Derive the first interfaces from the already-proven PR #40 semantic loop and existing owners. The first useful falsifier is not a Hello World component. It must exercise a real asynchronous path such as:

   ```text
   environment JS packaged as a Component
       -> authorized image read
       -> renderer operation
       -> change/observation delivery
       -> authorized reread
       -> presentation update
   ```

   The same portable environment artifact should be hostable by native Wasmtime and, where tooling permits, the browser/Jco route.

7. **A native embedded JS runtime is a bounded fallback, not the target architecture.** If current JS Component tooling cannot express the required async imported calls, streams/events or lifecycle faithfully, a temporary in-process JS runtime may be used to ship/prove the native client. It must:
   - sit behind the same WIT-shaped/plain-data ownership boundaries being developed for the Component route;
   - avoid a broad Node compatibility personality;
   - contain no new semantic ownership;
   - have an explicit removal criterion when the Component toolchain can satisfy the acceptance flow.

8. **The existing Node subprocess bridge remains proof scaffolding only.** PR #40 proved semantic host portability. It is not a supported client architecture and should be removed when either the Component route or, if necessary, the bounded in-process fallback reproduces that acceptance in one process.

9. **Future language support is evaluated by Component/WIT viability first.** Toolchain immaturity for one language may delay that language or justify a narrow adapter at its tooling boundary; it does not redefine the host architecture for all languages.

## Immediate implementation direction

The current in-process-embed Bead is reinterpreted as a **WASM-first client-runtime investigation**:

1. inventory the smallest real PR #40 environment slice and the public host/Image capabilities it actually needs;
2. define the smallest WIT-shaped boundary from existing owners;
3. componentize a real existing JS slice without semantic forks;
4. run it under the existing Linux Wasmtime host;
5. prove at least one genuinely async image -> renderer -> observation/reread path;
6. if that succeeds, extend toward the full PR #40 acceptance and delete the Node bridge;
7. if it fails on a concrete upstream JS-guest/Component async limitation, record that exact RED and only then resume a bounded embedded-JS fallback behind the same boundary.

The investigation must stop rather than widening architecture if it requires a second command/authority/navigation model, host-side semantic knowledge, a per-language native client architecture, or a large Node compatibility layer.

## Consequences

- Lagrange gains one answer to the future-language question: **different source languages, one portable Component/WIT execution architecture**.
- The Rust/native host becomes a capability provider rather than the semantic implementation of each language personality.
- The environment no longer has a reason to import the whole `lagrange-images` JS composition root merely to perform user-facing reads/mutations/observation; public authorized capabilities are the desired boundary.
- The Component route may expose missing or poorly shaped public Images seams. Those are substrate findings and should be fixed at their owner rather than bypassed in the environment.
- `RendererAdapter` remains useful and proven; a future WIT renderer interface must preserve its semantic ownership and six-op lifecycle result unless a separately reviewed falsifier proves otherwise.
- JavaScript, Go, Rust, Java and other languages may have different maturity/toolchains, but host-specific FFI machinery must not become part of the semantic model.

## Rejected alternatives

- **Make rquickjs/QuickJS the permanent Linux client runtime** — creates JavaScript-specific host architecture and encourages repetition for future languages.
- **Use a native language bridge per supported language** — defeats the language-neutral Component/WIT model.
- **Port the environment to Rust solely to avoid JavaScript embedding** — changes implementation language without solving the general language boundary.
- **Embed the entire `lagrange-images` JavaScript runtime inside every environment host** — pulls substrate implementation dependencies such as codecs/crypto/toolchains across an ownership boundary that should be public semantic capability calls.
- **Wait for every language/toolchain to have perfect Component support before using WIT** — makes the weakest ecosystem toolchain dictate the architecture. Prefer Components where viable and bounded temporary adapters where not.
