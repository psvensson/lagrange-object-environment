# Portable client host boundary

Status: working reference for ADR 0013 + ADR 0014.

ADR 0013 makes **"no browser required"** an architectural invariant and names the browser the **reference host**. ADR 0014 adds the stronger execution rule: **WASM Components + WIT are the normal portable client execution boundary.** Native per-language embeddings are bounded fallbacks, not the architecture for adding languages.

## The model

```text
                         Lagrange Images
               durable objects / Projects / history
                 authorized semantic capabilities
                              │
                              │ WIT-shaped public capabilities
                              ▼
                   Environment Component
             existing JS semantic core where viable
                 packaged/componentized as WASM
                              │
            Subject / Presentation / Command /
            Perspective / Composition / Selection
                              │
                  host capability imports
                ┌─────────────┼─────────────┐
                │             │             │
          renderer/UI       input       other host
             WIT/data      events       capabilities
                │
       RendererAdapter semantics
       (six lifecycle ops remain the
        proven renderer ownership model)
                │
        ┌───────┴────────┐
        │                │
   Browser host      Linux native host
        │                │
 SemanticUI → DOM   SemanticUI → GTK
 Graphics → WebGPU  Graphics → native wasi:webgpu/wasi-gfx
        │                │
        └───────┬────────┘
                │
       WASM Components / WIT
```

The native host remains responsible for concrete OS resources: GTK/Compose/DOM controls, surfaces, GPU devices/queues, windowing, text shaping, accessibility, clipboard/IME and other platform services. "WASM in the center" means portable semantic execution converges on Components/WIT; it does **not** mean the OS host itself is implemented in WASM.

## Why this changed

The first native semantic proof (PR #40 / Bead 64j) intentionally used a throwaway Node subprocess so the real, unmodified JavaScript environment core could drive the real Linux `RendererAdapter` quickly. It proved the important semantic claim: the core is host-portable and the six-op renderer boundary did not need widening.

The follow-up embed census showed the downside of making a JavaScript VM the permanent architecture: running the whole client-side JS composition root also drags substantial `lagrange-images` implementation machinery into the host process (binary codecs, cursor crypto, token machinery and other Node-oriented implementation details). Repeating that pattern for Go, Java or other languages would create bespoke host/runtime bridges.

ADR 0014 therefore moves the preferred boundary upward: the environment should consume **public authorized Images capabilities** and execute portably as a Component where current tooling permits. Language toolchains may differ, but the host-facing architecture should converge on WASM/WIT rather than one FFI/runtime per source language.

## Portable vs host-specific

| Layer | Portable (host contract) | Host-specific (one implementation) |
|---|---|---|
| Subject / ref | yes | no |
| Presentation (descriptor) | yes | no |
| Commands | yes | no |
| Perspective (durable layout) | yes | no |
| Composition (tree, viewIds) | yes | no |
| Selection | yes | no |
| Environment execution | WASM Component + WIT preferred | Wasmtime / browser Component host; bounded fallback embed only if tooling blocks |
| Images interaction | public authorized semantic capability | concrete Images runtime/storage implementation stays below |
| Focus semantics | mostly | concrete focus mechanism per host |
| Semantic tool UI | yes (the description) | DOM / GTK / Compose realization |
| Component lifecycle | yes | runtime embedding (browser/Jco vs native Wasmtime) |
| GPU API | `wasi:webgpu` / WIT | WebGPU / wgpu / Vulkan / Metal |
| Surface / window | abstract | browser canvas / native window / Android Surface |
| Clipboard / IME / accessibility | semantic contract | platform implementation |
| Renderer surface handles | no (opaque to the contract) | yes |

Any portable host boundary must be **data-representable**. The existing `RendererAdapter` seam already enforces this property. Future WIT interfaces must preserve the same ownership discipline: DOM nodes, GTK widgets, GPU objects, authorities and concurrency tokens do not become portable identity.

## Three kinds of Component use

### 1. Environment Component

The environment's semantic orchestration is the new preferred Component target:

```text
existing Environment JS
        │
   componentize/package
        ▼
environment.component.wasm
        │
        ├── import authorized Images capabilities
        ├── import renderer capabilities
        └── receive/consume host input/change events
```

The goal is to preserve the existing tested JS semantics rather than rewrite them merely to change the hosting mechanism.

### 2. Graphics Components

Existing direction from ADR 0011/0013:

```text
Presentation Component
      -> wasi:webgpu / wasi-gfx
      -> host GPU/surface
```

The portable artifact is the Component core binary + host-provided WIT imports. Browser glue is one instantiation route; native Wasmtime supplies the imports directly.

### 3. Language-produced Components

Future source languages should converge on the same execution architecture where their toolchains permit:

```text
Go / Rust / JavaScript / Java / ...
            │
      language toolchain
            ▼
      WASM Component
            │
            ▼
        Lagrange WIT
```

A language's compiler/runtime adapter may be specific to that language. The **host semantic architecture must not become language-specific**.

## JavaScript and the fallback rule

JavaScript remains the current reference implementation of the environment semantics. ADR 0014 changes only the preferred hosting direction.

The next investigation is **WASM-first**:

1. derive the smallest WIT-shaped host/Images boundary from the already-proven PR #40 loop;
2. componentize a real existing JS slice;
3. run it under the existing native Wasmtime host;
4. prove a genuinely asynchronous path (authorized read -> renderer -> observation/change -> reread -> update), not only a synchronous Hello World;
5. expand toward the complete PR #40 acceptance if the toolchain supports the required imports/events/lifecycle.

If current JS Component tooling cannot faithfully express that async path, an embedded JS runtime may be used temporarily. That fallback must stay behind the same plain-data/WIT-shaped ownership boundary, avoid broad Node compatibility, and carry an explicit removal criterion. It must not become the precedent for Go, Java or future languages.

## Images boundary

The environment should not need to host the whole `lagrange-images` JavaScript composition root merely to perform ordinary client work.

Desired direction:

```text
Environment Component
       │
       │ public authorized capability
       ▼
Lagrange Images owner
       ├── storage representation
       ├── binary codecs
       ├── version tokens
       ├── observation cursor crypto
       └── authority enforcement
```

Images semantics remain below this repository. If componentization exposes a missing public semantic capability, that is a substrate/API finding: add/fix the capability at its owner rather than reproduce private storage, codec, crypto or authority semantics in the environment.

## Host progression

Browser (reference) -> **Linux native** -> Android.

The Linux proof has now progressed beyond ADR 0013's original plan:

- the same graphics Component core runs natively under Wasmtime;
- SemanticUi drives real GTK controls;
- one `LinuxRendererAdapter` holds native semantic UI + Component graphics behind the unchanged six-op contract;
- PR #40 proved the real JavaScript semantic core can drive that native host end-to-end through throwaway transport.

The next portability question is therefore **execution packaging**, not renderer semantics: can the semantic core itself move behind the Component/WIT boundary without acquiring a bespoke native-language runtime architecture?

## Falsification

The WASM-first direction is wrong or prematurely blocked if the real acceptance demonstrates one of these, and the exact RED must be recorded:

- current JS guest Component tooling cannot express the required asynchronous imported calls/events/streams/lifecycle faithfully;
- the proposed WIT boundary duplicates Command, authority, navigation, version-token or observation ownership rather than exposing existing owners;
- a seventh renderer semantic operation becomes genuinely necessary;
- componentizing the existing core requires host-specific semantic forks;
- the environment must understand private Images storage/codec/crypto details rather than consuming a public capability.

A tooling RED may justify a bounded temporary JS embed. It does **not** justify changing the long-term architecture to one native runtime bridge per language.

## Current out of scope

- freezing a large general-purpose Environment WIT world before the real async slice proves it;
- rewriting the environment in Rust solely to avoid JavaScript;
- broad Node compatibility inside the Linux host;
- per-language native client runtimes as the normal support path;
- moving GTK/Compose/DOM or OS resource ownership into WASM.
