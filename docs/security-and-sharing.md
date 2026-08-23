# Identity, authority and sharing

## Split the concerns

Three layers answer different questions:

```text
cluster / identity service
  Who are you?

Lagrange Images
  What may this principal do to this image object?

Object Environment
  How should those permitted objects and operations be exposed to a human?
```

This repository should not implement passwords, OIDC, Keycloak semantics or a second object ACL system.

## Principal identity

The environment works with an authenticated principal identity supplied by the lower system. Human-friendly names, contacts and account discovery may be resolved for UI purposes, but durable image semantics should depend on stable principal identities rather than an email address or identity-provider detail.

External SSO and an installation-provided identity service can therefore converge on the same environment/image contracts.

## Authority

Lagrange Images owns capability/grant semantics and enforcement.

Environment concepts do not confer authority:

```text
ObjectRef      != permission to dereference
Presentation   != permission to read subject
Command        != permission to invoke
Perspective    != permission to access everything it mentions
Project member != ambient authority over arbitrary referenced objects
```

This is essential for partial sharing. If an accessible object refers to an inaccessible object, the UI may render an opaque/unavailable reference rather than accidentally traversing it.

## Ownership is not one thing

User-facing language may say "owner", but the architecture should distinguish:

- **administration** — who may invite/remove principals, delegate authority, archive/delete or change image policy
- **authorship/provenance** — who created or changed something and when
- **authority** — what a principal may currently do to an object

Do not collapse all three into an `owner` field on every object.

## Sharing part of an image

A user can inhabit a strict subset of the same Image. There is no need to manufacture a smaller workspace/image merely to express access.

```text
Image
  Project A       <- Alice can read/write
    A1
    A2 -> B1      <- B1 may remain an opaque unavailable ref

  Project B       <- Alice has no authority
    B1
    B2
```

A Perspective can make the permitted subset pleasant to inhabit, but capability enforcement remains below it.

## Perspectives and sharing

Because a Perspective is intended to become an image object, ordinary image authority can express:

- private perspective: author read/write only
- shared perspective: several principals may update layout/content
- published perspective: broad read, narrow write
- group perspective: authority granted to a principal group

Sharing a Perspective and sharing everything referenced by it are separate operations.

## Invitations

Invitation is primarily orchestration/UX, not a new security model.

A future flow may look like:

```text
Share Project -> choose person/group -> choose intended rights
             -> resolve/create principal
             -> create image grant through authorized API
             -> optionally share a Perspective or entry point
```

If the invitee is not yet a principal, a cluster/account service can hold a pending invitation and bind it after authentication. The environment may drive that flow but should not make the pending email token into image authority.

## Security design rule

Every environment operation that reads or changes image semantics must be possible to describe through public authorized image APIs. If the UI requires a privileged bypass, fix the underlying contract rather than bless the bypass.
