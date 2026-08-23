# Lagrange Object Environment

A live object computing environment for Lagrange Images.

The environment is not an IDE wrapped around an image and not a desktop full of applications which happen to use image objects. The image **is** the persistent workspace/world. This project provides the human interaction layer through which that world is presented, manipulated, programmed and shared.

The core inversion is:

```text
traditional GUI
application -> owns data -> builds widgets -> user manipulates widgets

Lagrange Object Environment
image objects -> presentations -> commands -> image operations
```

A rendered thing retains the identity of the object it presents. The same object may have many presentations: a list row, source fragment, inspector, graph node, topology view or domain-specific editor. Operations are commands on semantic objects rather than arbitrary widget callbacks.

## System boundary

```text
Lagrange
  distributed substrate, cluster identity and authentication
        |
Lagrange Images
  persistent language-neutral object world
  object identity, history, capabilities and authorization
        |
Lagrange Object Environment
  presentations, commands, perspectives, composition and generic tools
        |
Client/rendering substrate
  graphics, text, input, accessibility and transient session state
```

This repository should remain an ordinary consumer of public `lagrange-images` APIs. If the environment needs to reach into image internals, that is evidence of a missing image-level abstraction rather than permission to couple the projects.

## Vocabulary

- **Image** — the complete persistent world and workspace. There is deliberately no second Workspace container.
- **Project** — semantic organization inside an image. Projects may relate objects without imposing a filesystem or single-parent ownership model.
- **Presentation** — a semantic view of an object in a context. Presentation does not own the object and does not confer authority.
- **Command** — an inspectable operation applicable to semantic subjects. Invocation eventually crosses the image authorization boundary.
- **Perspective** — a durable arrangement/intention for viewing and working with part of an image. It can be private, shared or published because it is itself an image object.
- **Session** — ephemeral interaction state for one connected client: focus, pointer state, open menus, drags, carets and other UI churn.
- **Compositor** — arranges presentations. Overlapping windows are one possible policy, not the primitive model.

## Why image = workspace

A separate workspace abstraction would duplicate the image's persistence, object graph and sharing semantics. The legitimate needs usually attributed to workspaces are handled independently:

```text
per-user arrangement       -> Perspective
subset / current project   -> Perspective subject/query + Project
purpose-specific layout    -> multiple Perspectives
access to only part        -> image capabilities
current UI mechanics       -> Session
```

This keeps one ontology: the objects being worked on and the tools/views used to work on them can all live in the same persistent world without pretending that a second container owns them.

## Identity and sharing

Authentication belongs below the image/environment boundary. The environment should receive an authenticated principal; it should not need to understand passwords, OIDC, Keycloak or email-based identity.

Authorization belongs to Lagrange Images. The environment may provide excellent UX for sharing and invitations, but the durable effect is an image grant/capability, not a UI ACL.

The inherited invariant is important:

```text
reference != authority
```

Seeing or carrying an `ObjectRef` must not by itself authorize dereferencing or mutating the target. That permits a user to inhabit one part of an image even when visible objects refer into parts they cannot access.

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
3. [Identity, authority and sharing](docs/security-and-sharing.md)
4. [Roadmap](docs/roadmap.md)
5. [Architecture decisions](docs/decisions/README.md)
