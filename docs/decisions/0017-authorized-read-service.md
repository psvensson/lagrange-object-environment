# 0017 — A remote read service composes existing authorized Images operations

Status: accepted (Bead 6g7; native/live-cluster acceptance remains 8dh)

## Context

A native client needs network access to an existing image. The Images development
HTTP storage scaffold does not authenticate or enforce the authorized application
read boundary. Images AuthorityContexts are runtime-local identities, not JSON
credentials. Project membership does not grant access to its targets.

## Decision

An Object Environment host may expose a small application read service over the
existing public `ImageClientAdapter`. It attaches to one image and a trusted,
preinstalled immutable object-read Block. The adapter validates that binding with
Images' public parsers and interface contract before the service listens.

`ImageReadConnection` owns the closed `environment-image-read/v1` protocol: Project
read and object read only. Its remote adapter exposes the same semantic read
results and empty writable lists. A caller cannot select an executable Block or
send principal, grants, authority, source, or arbitrary operations. Errors cross
as an enum; messages and error classes are reconstructed from local constants.

The deployment owns runtime/bootstrap, real authentication, current identity to
actual AuthorityContext lookup, and runtime closure. The service requires these
providers explicitly and calls them for each request. The host does not mint
contexts or infer policy from locators. A test operator root may issue exact
grants for a controlled proof, but does not establish production identity policy.

`hosts/image-read-service/server.js` owns HTTP(S) bodies, sockets, deadlines,
admission and drain. Plain HTTP binds only to loopback. Client transports must
validate TLS for remote endpoints, forbid credential-forwarding redirects, limit
response bytes, and keep credentials out of semantic/UI state. There are no
retries or mock/auto fallback in a live deployment.

Timeout or disconnect cancels response delivery. Images reads currently have no
cancellation signal, so an admitted operation occupies capacity until its actual
promise settles. Closing stops admission, cancels delivery and drains under a
finite grace; incomplete backend work is an explicit failure. Output delivery has
its own finite deadline through HTTP finish/close, including refusals; slow readers
are disconnected. The standalone
CLI closes the deployment and enforces a process shutdown ceiling, including a
signal received during startup.

This service is application composition. A deployment may use the public Images
runtime with explicit `mode: 'lagrange'`, running one real embedded Lagrange node
per process lifetime. It does not replace Lagrange inter-node routing or require
managed RequestCell/OCI hosting. Bootstrap/schema setup is separate from viewer
startup and read requests. The desktop remains native and does not launch a Node
bridge. ADRs 0002, 0005, 0010 and 0014 remain in force.

## Consequences and proof

The remote adapter supports explicit refresh. `ProjectBrowser` checks observation
capability when `follow()` is requested; unsupported observation fails explicitly.
There is no inert observation stub, remote mutation, compiler or installer API.

The contract tests use the pinned real Images runtime with explicit mock storage.
They prove auth, revocation, denied existing/missing equivalence, conflicting
principals on one pipelined connection, binding restrictions, ordinary Project
navigation, no read-time writes, bounded admission, late-result suppression and
process shutdown. They do not prove a real cluster or native executable. That
acceptance belongs to the dependent native viewer task.

The native binding carries raw status/body data through the same connection.
It fixes one origin and `/v1/read`, verifies TLS with system trust or an explicit
CA, and permits plaintext only for literal loopback. Redirects, proxy discovery,
compression and retries are disabled. The operator credential is read from a
bounded private regular file and remains in Rust; guest modules receive neither
that credential nor an arbitrary URL capability. Admission is limited to 16
requests, with 16 KiB request and 4 MiB streaming response limits.

Native I/O runs on a composition-supplied executor separate from the JavaScript
owner. Cancellation guards hold the exact operation handle, and capacity remains
occupied until actual I/O settlement. Socket cancellation therefore does not
require guest progress. OS hostname resolution can outlive HTTP cancellation;
the executable must retain its independent process shutdown ceiling. Native
transport tests use scripted socket responses and prove mechanics only.

The production and test composition share one public-entry resolver. Its fence
checks the canonical resolved target after either resolver path, including the
flat Environment fallback. External modules may enter the Images artifact only
through literal `portable-runtime`; normalized private-path spellings are refused.

Rejected: serializing AuthorityContexts; using the trusted storage scaffold as a
client API; accepting a caller-selected Block; implementing root grant policy in
the UI; requiring managed hosting before a standalone application service can be
proved. Revisit the last choice when managed hosting is independently available
and the deployment needs its lifecycle guarantees.
