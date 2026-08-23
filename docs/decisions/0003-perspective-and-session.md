# ADR 0003: Perspective is durable; Session is transient

## Status

Accepted

## Context

A live environment benefits from restoring meaningful work state, but persisting every pointer move, hover, open menu and caret blink would fill image history with UI churn.

Users also need multiple arrangements over the same objects and need to share some arrangements independently of the objects they reference.

## Decision

A **Perspective** expresses durable user/group intention: subjects, chosen presentations, composition, useful bookmarks/selections and tool configuration.

A **Session** expresses current client interaction: focus, pointer, menus, drags, carets, animation and caches.

Perspectives should eventually be represented as ordinary image objects. Sessions remain transient by default. Deliberate user actions may promote useful session state into a Perspective.

## Consequences

Reopening a Perspective can resume intellectual work without replaying meaningless UI mechanics. Perspective sharing can use ordinary image authority. Renderers remain free to keep implementation-specific state locally.
