# Documentation

The documents here define the object-environment boundary before they define a visual style or toolkit.

- [Architecture](architecture.md) — layers and ownership
- [Core concepts](concepts.md) — Image, Project, Presentation, Command, Perspective and Session
- [Projects and collaborative work](projects-and-collaboration.md) — organization, history UX, Git projection and multi-author work
- [Identity, authority and sharing](security-and-sharing.md) — principals, transient authority and invitations
- [Ownership registry](ownership.md) — single owner for every major subsystem and every cross-subsystem interaction
- [Provider-independent agent workflow](agent-workflow.md) — Beads, planning/falsification/verification/reconciliation and handoffs
- [Roadmap](roadmap.md) — staged implementation plan
- [Decisions](decisions/README.md) — architectural decisions intended to stay stable while UI experiments change

Agents should start at the repository-root [`AGENTS.md`](../AGENTS.md), then use the ownership registry and Beads state to locate the authoritative context for a task.
