# Ownership registry

This is the authoritative map of architectural ownership for the Object Environment.

The rule is strict:

> Every major subsystem has one owner. Every interaction between subsystems has one owner.

An owner is one architectural code locus — a module, service, adapter, registry, or lower repository/layer. It is not a claim about a human maintainer.

The owner owns the concern's semantic decisions, state-transition/public contract and primary proof surface. Other components may call, observe or adapt it; they may not independently decide the same rule.

A planned owner reserves responsibility but does not claim implementation exists yet.

## Subsystem owners

| Responsibility | Single owner | Location/status | Notes |
| --- | --- | --- | --- |
| Public package surface | Public API module | `src/index.js` | Selects what this package exposes; does not invent subsystem semantics. |
| Headless environment model bootstrap | Environment model | `src/model.js` | Current bootstrap owner until concrete subsystems are split by pressure. |
| Presentation semantics | `Presentation` | `src/model.js` | Semantic subject + presentation context; never image identity or authority. |
| Command semantics | `Command` | `src/model.js` | Command description/applicability; authorization remains below the environment. |
| Presentation discovery | `PresentationRegistry` (`src/presentation-registry.js`) | current | Sole owner of subject/context -> candidate Presentations discovery (synchronous, registration-ordered, no priority, renderer-independent). Discovers; the `Presentation` remains the semantic result. Never renders, never consults authority. Language personalities contribute providers via `PersonalityExtensionRegistry`; selection of one-versus-all is the consumer's/Compositor's concern, not this registry's. |
| Command discovery | `CommandRegistry` (`src/command-registry.js`) | current | Sole owner of subject/context -> applicable Commands discovery (synchronous, registration-ordered, applicability-only). Discovery never filters on authority; a returned Command confers none (ADR 0004). Invocation/authorization belongs to `CommandDispatcher`, not this registry. |
| Generic object experience (inspect/navigate/unavailable/unauthorized) | `ObjectNavigator` (`src/object-navigator.js`) | current | Sole owner of the object -> inspector -> discover refs -> follow ref -> presentation loop (and its unavailable-ref / unauthorized-ref branches). Composes `PresentationRegistry`/`CommandRegistry`/`ImageClientAdapter` — does not re-implement their selection or invocation. Reads the object fresh under EXPLICIT per-call authority via the adapter's authorized read seam (a ref is never authority; authority is threaded, never stored); materializes the outcome into the subject (denied read -> `unauthorized-ref`, missing/backend -> `unavailable-ref`, distinctly), then discovers synchronously. Never renders. Generic providers (`src/object-presentation-providers.js`) plug into the registry rather than hard-coding selection. |
| Perspective semantics | `Perspective` | `src/model.js` | Durable environment intention; image persistence is reached through the image interaction owner. Durable representation is defined by ADR 0012 (superseding ADR 0008's representation). |
| Session semantics | `Session` | `src/model.js` | Ephemeral client interaction state. |
| Renderer-specific graphics and host resources | `RendererAdapter` | contract defined (`src/compositor.js` boundary); realizations planned | Owns ALL concrete renderer resources (browser/native GPU, device, queue, surface, frame, Component/WIT graphics host providers). Returns only OPAQUE, TRANSIENT, Session-scoped string handles upward; never exposes DOM/WebGPU/GPU objects or raw GPU ops across the boundary. The Compositor-facing contract is lifecycle-only and data-representable (remote-friendly); does not own semantic Presentation or composition policy. |
| Durable image/object/project semantics | Lagrange Images | external: `psvensson/lagrange-images` | This repository is a public consumer; no shadow object/project/history store here. |
| Image authorization enforcement | Lagrange Images execution boundary | external: `psvensson/lagrange-images` | Authority is transient execution context; references/presentations/commands confer none. |
| Root authentication/principal and authority issuance | Lagrange/control-plane identity/authority layer | external/planned integration | The environment consumes normalized identity/authority operations; it does not implement passwords/OIDC/Keycloak policy. |
| Agent task/dependency graph | Beads | `.beads`/Dolt after `bd init` | Authoritative operational work tracker; no duplicate Markdown TODO tracker. |
| Short durable agent discoveries | Beads memory | `bd remember` | Architectural discoveries must also be promoted to tests/docs/ADR when they change project truth. |
| Architecture decision history | ADR set | `docs/decisions/` | Why durable decisions were made. |
| Current ownership map | Ownership registry | this file | Must change whenever a major owner/boundary changes. |

## Interaction owners

The endpoint owners do not jointly own an interaction. Each boundary has one owner responsible for translation/protocol, ordering, error semantics, lifecycle and integration proof appropriate to that boundary.

| Interaction | Single interaction owner | Status | Responsibility |
| --- | --- | --- | --- |
| External caller -> Object Environment package | Public API module | current: `src/index.js` | Defines the package-facing entry surface and composition points. |
| Object Environment -> Lagrange Images | `ImageClientAdapter` (`src/image-client-adapter.js`) | current | Sole environment-side adapter for public image APIs, observation, authorized operations and durable Perspective projection. Lagrange Images still owns its own public semantics. Composes the cores: observation `src/image-observation.js` (ADR 0009), command dispatch `src/command-dispatcher.js` (ADR 0010), Perspective projection `src/perspective-projection.js` (ADR 0012). The leaf/edge object loop and the Perspective save/load round trip are both proven against a real runtime. Save is a staged authorized workflow: the adapter obtains a fresh opaque authority context per image invocation from an injected authority provider (it neither issues nor inspects contexts), creating children first and the indexed Perspective last (the commit point). Reads are the authorized whole-record object/read lane (`image-object-read-binding/v1`, substrate ADR 0068): `readObject`/`authorizedReadObject` are the environment's SINGLE user-facing "read an object" seam, crossing `object/read` under explicit authority; the privileged `images.getObject` survives only for control-plane/schema reads (trusted host) and mutateObject's version-token fetch, never on a user-facing path. Load reads the Perspective and EACH child as a separate authorized read via an injected read authorityProvider (ref != authority). |
| Perspective -> durable image representation | `ImageClientAdapter` (`src/perspective-projection.js`) | current: projection core + adapter save/load (ADR 0012, formatVersion 3) | Owns the Perspective <-> ordinary-image-object encode/decode contract of ADR 0012 (superseding ADR 0008). `Perspective` owns semantics; Lagrange Images owns storage. Implemented: a Perspective object holding its ordered presentation refs in its indexed part (membership + ordering, one owner) plus one child object per presentation; order/membership have a single owner (no ordinal, no back-edge). Load enumerates the indexed part via object/read-level access. |
| Presentation -> renderer | `RendererAdapter` | contract defined; realizations planned | Converts semantic presentation output into renderer-specific view operations without moving semantics into the renderer; for Component-backed presentations, supplies the exact-version graphics/surface host interfaces the renderer declares (on the renderer-Component -> graphics-host side, BELOW the Compositor boundary). |
| Compositor -> concrete render surface | `RendererAdapter` | contract defined (`src/compositor.js`); realizations planned | Owns translation from logical surface/view lifecycle requests (createSurface/attachPresentation/detachPresentation/resize/destroySurface/destroyAll) into concrete renderer surfaces and GPU resources, returning only opaque transient handles. `Compositor` owns logical arrangement and lifetime intent; `RendererAdapter` owns host-resource realization. This is the remote-friendly boundary (one level above wasi:webgpu): all args are data-representable, so a future RemoteRendererAdapter can move the renderer across a network without changing Compositor/Presentation/Perspective semantics. |
| Input/gesture/key/menu -> semantic command | `CommandRouter` | planned | Resolves UI invocation policy to one command + semantic subject; does not authorize the command. |
| Command -> image operation | `CommandDispatcher` (`src/command-dispatcher.js`) | current | Owns command invocation sequencing/result/error mapping and the typed error taxonomy of ADR 0010; passes authority through opaquely (never holds it) and delegates the image crossing to `ImageClientAdapter` (`src/image-client-adapter.js`), which invokes the command through its seam. |
| Session -> composition/render lifecycle | `Compositor` (`src/compositor.js`) | current (minimal seam) | Owns ephemeral logical view lifecycle and arrangement intent: which presentation is shown, its logical view lifetime, and teardown on Session destroy. Holds surface handles ONLY as transient Session-scoped state in its private view map (never in Session.state, a Perspective or the image); a Perspective is rebuilt from durable intent ({viewId, viewDescriptor, presentationDescriptor}) only, handle-free by construction. Requests realization from `RendererAdapter` across the data-representable boundary; does not implement GPU/WIT. Broader composition (focus/layout/stacking primitives, surface policy) is a later Phase 2 slice. |
| Language personality -> environment presentations/commands | `PersonalityExtensionRegistry` | planned | The language-personality contribution boundary: a personality contributes presentation providers and commands, which it feeds into `PresentationRegistry`/`CommandRegistry`. It is NOT the generic discovery owner — it does not answer `discover(subject, context)`; the two generic registries do. Keeps each language extending one environment rather than creating another IDE architecture. |
| Beads task/memory -> agent work session | `bd prime` workflow | current/tool-owned | Operational context injection and work discovery; project-specific governance remains in `AGENTS.md`. |

## Ownership change protocol

Before implementing a new major subsystem or interaction:

1. identify the responsibility in the plan/Bead
2. name exactly one owner here
3. identify which existing owner loses or delegates responsibility, if any
4. state the boundary contract/invariants
5. identify the primary proof/tests
6. only then implement

A proposal that says responsibility is "shared", "co-owned", "handled on both sides", or leaves the interaction owner implicit is incomplete.

## Detecting ownership drift

Treat these as defects:

- two modules persist competing versions of the same semantic state
- two endpoints both retry/reconcile the same interaction independently
- validation/business rules are copied to both sides of a boundary without one authoritative source
- a UI adapter starts deciding image semantics
- a lower substrate learns presentation/session policy
- two registries select implementations for the same extension point
- an integration test cannot say which component is responsible for a failure

When drift is found, do not merely synchronize the duplicate implementations. Restore one owner and make the other side consume it.
