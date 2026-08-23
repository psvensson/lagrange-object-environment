# Lagrange Object Environment

A live object computing environment for Lagrange Images.

The environment is not an IDE wrapped around an image and not a desktop full of applications which happen to use image objects. The image **is** the persistent workspace/world. This project provides the human interaction layer through which that world is organized, presented, manipulated, programmed and shared.

The core inversion is:

```text
traditional GUI
application -> owns data -> builds widgets -> user manipulates widgets

Lagrange Object Environment
image objects -> presentations -> commands -> authorized image operations
```

A rendered thing retains the identity of the object it presents. The same object may have many presentations: a list row, source fragment, inspector, graph node, topology view or domain-specific editor. Operations are commands on semantic objects rather than arbitrary widget callbacks.

## System boundary

```text
Lagrange / trusted control plane
  cluster, authentication, principal/group resolution
  root authority issuance/revocation and policy
        |
Lagrange Images
  persistent language-neutral object world
  object identity, history and execution-time authority enforcement
        |
Lagrange Object Environment
  projects, presentations, commands, perspectives
  generic tools, collaboration UX and composition
        |
Client/rendering substrate
  graphics, text, input, accessibility and transient session state
```

`lagrange-images` deliberately has no durable grant object. Authority travels beside an activation as transient execution context; references and durable image objects never become authority tokens. The environment consumes the public authorized APIs and drives control-plane sharing flows without inventing a second ACL model.

This repository should remain an ordinary consumer of public `lagrange-images` APIs. If the environment needs to reach into image internals, that is evidence of a missing image-level abstraction rather than permission to couple the projects.

## Vocabulary

- **Image** — the complete persistent world and workspace. There is deliberately no second Workspace container.
- **Project** — an object-environment convention for semantic organization inside an image. It is represented by ordinary image objects and relationships, not a new core `lagrange-images` record kind.
- **Presentation** — a semantic view of an object in a context. Presentation does not own the object and does not confer authority.
- **Command** — an inspectable operation applicable to semantic subjects. Invocation eventually crosses an authorized image/control-plane boundary.
- **Perspective** — a durable arrangement/intention for viewing and working with part of an image. It can itself be represented by ordinary image objects.
- **Session** — ephemeral interaction state for one connected client: focus, pointer state, open menus, drags, carets and other UI churn.
- **Compositor** — arranges presentations. Overlapping windows are one possible policy, not the primitive model.

## Why image = workspace

A separate workspace abstraction would duplicate the image's persistence and object graph. The legitimate needs usually attributed to workspaces are handled independently:

```text
per-user arrangement       -> Perspective
semantic organization      -> Project
subset / current focus     -> Perspective subject/query
purpose-specific layout    -> multiple Perspectives
access to only part        -> authority below the environment
current UI mechanics       -> Session
```

This keeps one ontology: the objects being worked on and durable objects describing projects/perspectives can live in the same persistent world without pretending that a second container owns them.

## Identity and sharing

Authentication and root authorization policy live below the environment. The environment should receive an authenticated principal/session and authorized image APIs; it should not need to understand passwords or make authorization decisions from email addresses.

The inherited invariant is important:

```text
reference != authority
```

Seeing or carrying an `ObjectRef` must not by itself authorize dereferencing or mutating the target. A Perspective or Project reference likewise grants nothing by itself.

The current `lagrange-images` authority algebra is exact-match and object access does not recursively follow refs. A future "share this whole Project" operation therefore cannot be implemented by pretending project containment already implies transitive capability. The environment owns that user intent; the trusted authority layer and image contracts must define how it becomes enforceable rights.

## Initial shape

The first implementation is deliberately headless. It defines small environment-level models and tests their boundaries before choosing a renderer or GUI toolkit.

```text
src/model.js
  Presentation
  Command
  Perspective
  Session

src/index.js
  public exports
```

Run with Node.js 22 or newer:

```sh
npm test
```

## Where to read next

1. [Architecture](docs/architecture.md)
2. [Core concepts](docs/concepts.md)
3. [Projects and collaborative work](docs/projects-and-collaboration.md)
4. [Identity, authority and sharing](docs/security-and-sharing.md)
5. [Roadmap](docs/roadmap.md)
6. [Architecture decisions](docs/decisions/README.md)
