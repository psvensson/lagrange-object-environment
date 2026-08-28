# Documentation

The documents here define the object-environment boundary before they define a visual style or toolkit.

- [Architecture](architecture.md) — layers and ownership
- [Portable client host boundary](architecture/portable-client-host.md) — "no browser required": the browser is the reference host (ADR 0013); portable-vs-host-specific classification and the two realization routes
- [RendererAdapter contract](contracts/renderer-adapter.md) — the host-portability boundary between the environment and a host's renderer
- [Core concepts](concepts.md) — Image, Project, Presentation, Command, Perspective and Session
- [Projects and collaborative work](projects-and-collaboration.md) — organization, history UX, Git projection and multi-author work
- [Identity, authority and sharing](security-and-sharing.md) — principals, transient authority and invitations
- [Ownership registry](ownership.md) — single owner for every major subsystem and every cross-subsystem interaction
- [Provider-independent agent workflow](agent-workflow.md) — Beads, planning/falsification/verification/reconciliation and handoffs
- [Roadmap](roadmap.md) — staged implementation plan
- [Decisions](decisions/README.md) — architectural decisions intended to stay stable while UI experiments change
- [Proposals](proposals/) — downward proposals to Lagrange Images for missing image-level contracts (per ADR 0002)
  - [Authorized object-creation lane](proposals/authorized-object-creation-lane.md) — delivered as substrate ADR 0062
  - [Indexed-part lanes for ordered collections](proposals/indexed-part-lanes-for-ordered-collections.md) — Perspective persistence

Agents should start at the repository-root [`AGENTS.md`](../AGENTS.md), then use the ownership registry and Beads state to locate the authoritative context for a task.
