# ADR 0004: Presentations and commands operate on semantic subjects

## Status

Accepted

## Context

Conventional GUI architectures often let applications own data and wire widget callbacks directly to mutations. That hides semantic identity behind rendered strings/widgets and makes menus, key commands, scripting, collaboration and alternate presentations separate mechanisms.

## Decision

The environment centers two abstractions:

- **Presentation** — one semantic subject shown in one context.
- **Command** — one discoverable/applicable operation attempted on a semantic subject.

Rendered elements should retain a path back to their semantic subject. A subject may have many simultaneous presentations.

Gestures, menus, key bindings and command palettes are invocation policies over Commands, not the semantic operation itself.

Command applicability does not imply authorization. Invocation must use authorized image APIs.

## Consequences

Generic tools and domain-specific tools can use one interaction mechanism. Language personalities can add presentations and commands without creating separate IDE architectures. The visual toolkit can change without changing semantic operations.
