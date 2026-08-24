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
| Perspective semantics | `Perspective` | `src/model.js` | Durable environment intention; image persistence is reached through the image interaction owner. Durable representation is defined by ADR 0008. |
| Session semantics | `Session` | `src/model.js` | Ephemeral client interaction state. |
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
| Object Environment -> Lagrange Images | `ImageClientAdapter` | planned | Sole environment-side adapter for public image APIs, observation, authorized operations and durable Perspective projection. Lagrange Images still owns its own public semantics. Observation core: `src/image-observation.js` (ADR 0009); Perspective projection core: `src/perspective-projection.js` (ADR 0008). |
| Perspective -> durable image representation | `ImageClientAdapter` (`src/perspective-projection.js`) | current: projection core; adapter planned | Owns the Perspective <-> ordinary-image-object encode/decode contract of ADR 0008. `Perspective` owns semantics; Lagrange Images owns storage. The pure projection is implemented; the image-writing adapter is still planned. |
| Presentation -> renderer | `RendererAdapter` | planned | Converts semantic presentation output into renderer-specific view operations without moving semantics into the renderer. |
| Input/gesture/key/menu -> semantic command | `CommandRouter` | planned | Resolves UI invocation policy to one command + semantic subject; does not authorize the command. |
| Command -> image operation | `CommandDispatcher` (`src/command-dispatcher.js`) | current: dispatcher core; adapter delegation planned | Owns command invocation sequencing/result/error mapping and the typed error taxonomy of ADR 0010; passes authority through opaquely (never holds it) and delegates the image crossing to `ImageClientAdapter`. |
| Perspective -> durable image representation | `ImageClientAdapter` | planned | Owns the persistence projection; `Perspective` owns semantics, Lagrange Images owns storage/object semantics. |
| Session -> composition/render lifecycle | `Compositor` | planned | Owns ephemeral composition/focus/layout lifecycle; durable intent is promoted explicitly to Perspective. |
| Language personality -> environment presentations/commands | `PersonalityExtensionRegistry` | planned | Sole registration/discovery seam so each language extends one environment rather than creating another IDE architecture. |
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
