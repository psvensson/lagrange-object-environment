# ADR 0002: The object environment is a public consumer of Lagrange Images

## Status

Accepted

## Context

The environment will put substantial pressure on object inspection, change observation, history, command invocation and authorization. It would be easy to satisfy those needs by importing image internals or adding UI concepts to `lagrange-images`.

That would make the architecture circular and prevent other clients from using the same capabilities.

## Decision

`lagrange-object-environment` must consume `lagrange-images` through public contracts.

UI concepts such as Presentation, Perspective, panes, windows, selection and rendering do not belong in `lagrange-images`.

When the environment cannot implement a legitimate semantic operation through public image APIs, treat that as evidence of a missing image-level abstraction. Add the smallest language-neutral contract there, then consume it here.

## Consequences

The environment becomes a demanding reference client for the image platform. This keeps Lagrange Images useful without the UI and permits alternate environments or automation clients later.

Some early work may proceed against small injected/mock image clients until the required public image seam exists.
