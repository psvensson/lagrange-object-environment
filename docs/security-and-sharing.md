# Identity, authority and sharing

## Split the concerns

Four responsibilities answer different questions:

```text
identity service / control plane
  Who are you? Which groups exist?

trusted authority root
  Which rights may this principal/session receive?
  issue / revoke / policy

Lagrange Images execution
  Is this concrete operation authorized right now?
  transient context + require(operation, resource)

Object Environment
  How should permitted objects, durable preferences and sharing intent be exposed to a human?
```

These may be deployed together, but they should not collapse into one semantic layer.

This repository should not implement passwords, OIDC, Keycloak semantics, authority-token minting or a second object ACL system.

## Principal identity

The environment works with an authenticated principal identity supplied by the lower system. Human-friendly names, contacts and account discovery may be resolved for UI purposes, but authorization must not be re-derived from an email address or display name.

External SSO and an installation-provided identity service can therefore converge on the same environment contracts.

### EnvironmentProfile is preference data, not identity

ADR 0015 introduces an ordinary image-level `EnvironmentProfile` for durable preferences such as a selected Theme or default Perspective.

The profile may contain an opaque external `principalKey` so the one `ProfileResolver` can associate the object with the authenticated principal. That field is descriptive data only:

```text
external authenticated principal != EnvironmentProfile
EnvironmentProfile.principalKey   != authentication
EnvironmentProfile                != authority
Theme ref from profile            != authority to read Theme
```

A forged or duplicated profile naming another principal cannot authenticate the caller or grant any right. Profile lookup starts from the principal supplied by the trusted identity layer, and every profile/theme read or write still crosses the ordinary image authorization boundary.

No profile needs to exist for a principal who has never personalized the environment. In that case the environment uses the image's ordinary `EnvironmentCatalog` defaults without writing on login/open. The profile is materialized lazily on the first deliberate durable personalization through the single ProfileResolver interaction described by ADR 0015.

## Authority is transient

`lagrange-images` ADR 0037 deliberately makes authority execution context rather than program data.

```text
principal != capability
reference != authority
Perspective != authority
EnvironmentProfile != authority
Theme != authority
Project != authority
```

A trusted host/control-plane API may issue, attenuate and revoke authority contexts. Image execution receives only the context needed for the call and exposes a check-only `require` seam to protected operations. Authority never becomes a canonical Value, object slot, lexical capture or durable image grant.

The environment should normally not receive or store the authority context itself. It uses authenticated/authorized APIs; the server side associates requests with the appropriate authority.

## References do not carry access

Environment concepts do not confer authority:

```text
ObjectRef      != permission to dereference
Presentation   != permission to read subject
Command        != permission to invoke
Perspective    != permission to access everything it mentions
EnvironmentProfile ref != permission to read its preferences
Theme ref      != permission to read Theme/DesignToken objects
Project edge   != permission to follow the edge
```

This is essential for partial sharing. If an accessible object refers to an inaccessible object, the UI may render an opaque/unavailable reference rather than accidentally traversing it.

## Ownership is not one thing

User-facing language may say "owner", but the architecture should distinguish:

- **administration** — who may change sharing/policy or lifecycle at the trusted control-plane layer
- **authorship/provenance** — who created or changed something and when
- **authority** — what the current authenticated execution may actually do

Do not collapse all three into an `owner` field on every image object.

## Sharing part of an image

A user can inhabit a strict subset of the same Image. There is no need to manufacture a smaller workspace/image merely to express access.

But Project hierarchy is not currently an authority hierarchy. `lagrange-images` v0 grants are exact-match operation/resource pairs and authorized object projection never follows refs. A future flow such as:

```text
Share Project A with Alice as editor
```

must therefore ask a trusted lower authority API to create whatever explicit rights the eventual authority model defines. The environment must not simulate this by assuming reachable objects are authorized.

## Perspectives, Themes and sharing

A Perspective is stored as ordinary image data, and the UI may offer private/shared/published modes. Those modes are **sharing intent and policy UX**, not authority encoded in the Perspective itself.

A Theme is likewise ordinary image data and may be shared or published using ordinary object-sharing mechanisms. Sharing a Theme ref and authorizing the Theme/DesignToken graph remain separate operations.

Sharing a Perspective and sharing everything referenced by it are always separate operations.

## Invitations

Invitation is orchestration/UX, not a new security model.

A future flow may look like:

```text
Share Project -> choose person/group -> choose intended rights
             -> resolve/create principal
             -> request authority-policy change through trusted API
             -> optionally share a Perspective or entry point
```

If the invitee is not yet a principal, a cluster/account service can hold a pending invitation and bind it after authentication. The environment may drive that flow but should not make the pending email token into image authority.

## Security design rule

Every environment operation that reads or changes protected image semantics must go through a public authorized API. If the UI requires a privileged bypass, fix the underlying contract rather than bless the bypass.
