# ADR 0017: System inspection is a Perspective over transient control-plane observations

## Status

Proposed — architecture/design only. No implementation is claimed by this ADR.

## Context

The Object Environment should be able to show the live state of the Lagrange
database itself: nodes, latency groups, tables, partitions, replica placement,
leaders, active moves/recovery and several kinds of load. The display should be
colourful and visibly reactive without becoming a second monitoring system or a
second owner of cluster semantics.

There are three tempting but wrong ways to build this:

1. repeatedly call admin snapshot/diagnostic endpoints from the UI;
2. mirror cluster state and metrics into durable image objects so the existing
   image observation path can see them; or
3. teach `lagrange-images` about Lagrange cluster topology because the Object
   Environment normally reaches durable object semantics through Images.

All three blur existing ownership. Lagrange core owns cluster membership,
placement, replication, readiness and telemetry. Lagrange Images owns durable
image/object/language semantics. The Object Environment owns human-facing
Perspectives and Presentations.

The Object Environment architecture already permits consumption of public
image **and control-plane** contracts. ADR 0002 remains in force for image
operations: the environment must use public Lagrange Images APIs and must not
import image internals. Cluster observation is not an image operation, so
routing it through Images would add an unnecessary semantic middle layer.

Core's proposed `architecture/operational-observation-plane.md` defines the
lower target contract: one read-only projection over authoritative core owners,
with gap-free snapshot/continuation semantics, owner-declared conditions,
measurements, explicit partial availability and no distributed polling.

## Decision

### 1. `System Inspector` is an ordinary Perspective family

System inspection is not a privileged application shell. It is a family of
ordinary Presentations composed inside a normal durable Perspective.

The first named views are:

- **Constellation** — whole-cluster node/topology overview;
- **Placement** — table partitions × nodes, showing replicas and leaders;
- **Heat** — the same placement geometry encoded by one selected quantitative
  metric;
- **Inspector** — detail for the selected cluster/node/table/partition/replica
  or operation; and
- **Pulse** — a bounded live event strip for structural changes observed while
  the Session is open.

These are presentation modes over the same semantic subject identities, not
five stores or five independent observation mechanisms.

### 2. Durable UI intention is image object state; live cluster facts are not

ADR 0015 remains the rule for durable environment semantics. The Perspective
and its child presentation/configuration objects may persist things such as:

```text
view kind
selected/pinned stable subject selector(s)
metric id
filters and sort
manual layout overrides
legend/display preferences
camera/zoom intention when useful
```

They do **not** persist:

```text
current node membership
current replica holders
current leaders
current readiness/health/placement state
metric samples
current active operations
observation cursors/frontiers
connection state
```

Those values are transient observations owned by core.

A durable `SystemSubject`/selector object may retain the stable identity needed
to reopen a view — for example `{cluster, kind, subjectKey}` — plus user-owned
annotations or presentation intent. It is a locator, not a cached copy of the
subject's current operational state.

This distinction satisfies the environment's object-native design without
turning every metric sample or replica transition into replicated image
history.

### 3. One `SystemClientAdapter` owns the Object Environment → Lagrange
control-plane interaction

A planned renderer-independent `SystemClientAdapter` is the single interaction
owner for operational observation.

It is responsible for:

- translating environment observation interests to the public core operational
  observation contract;
- passing transient authority/principal context through at use time;
- normalizing transport-specific messages into the one environment-facing
  snapshot/delta/reset contract;
- owning subscription/resume/cancel lifecycle;
- exposing denied/unavailable/stale/reset as explicit outcomes; and
- ensuring consumers cannot accidentally fall back to polling admin snapshots.

It does **not** decide cluster state, metric meaning, health, placement
correctness or authorization policy. Those stay below the boundary.

`ImageClientAdapter` remains the sole owner of Object Environment → Lagrange
Images interactions. `SystemClientAdapter` does not replace it, and neither
adapter proxies the other's semantics.

### 4. Visibility declares interest; the environment does not implement
propagation

The Compositor already owns logical visibility and view lifetime. A visible
System Inspector presentation declares the semantic observation scope it needs.
`SystemClientAdapter` acquires that scope and releases it when no live view
needs it (with any bounded grace/lease defined by the adapter contract).

A large placement matrix declares one table-placement interest, not one remote
subscription per cell. Multiple local views with equivalent interests should
share/coalesce one adapter interest where possible; core performs distributed
coalescing below that boundary.

There is no timer whose purpose is to ask whether distributed cluster state
changed.

### 5. `SystemInspector` owns presentation semantics, not core semantics

A planned renderer-independent `SystemInspector` presentation owner maps the
canonical operational observation model to SemanticUi/graphics presentations.
It owns:

- the available view modes;
- stable spatial ordering/layout policy;
- selection and cross-view highlighting;
- level-of-detail and matrix virtualization decisions;
- presentation-only heat normalization;
- animation intent;
- how stale/unavailable/partial states are made visible; and
- how one core subject activates the ordinary detailed Inspector.

It may not derive a competing semantic `healthy`, `ready`, `violating` or
`safe` decision. A `violations only` filter consumes owner-declared conditions
from core. If core does not expose the required semantic condition, the UI shows
raw facts or `unknown`; it does not fill the gap with local policy.

### 6. Placement and Heat share one geometry

Placement and Heat intentionally use the same row/column geometry:

```text
rows    = table partitions (or aggregated partition ranges when zoomed out)
columns = stable node ordering/grouping
cell    = partition × node relationship
```

Placement encodes structural meaning (replica, leader, adding, removing,
lagging/owner-declared exception). Heat replaces identity colour emphasis with
one quantitative metric scale while preserving positions.

This makes switching from “where is it?” to “where is the load?” a semantic
mode change rather than a complete spatial relearning.

### 7. Visual motion has semantic meaning

The default animation rule is:

> **Structural changes move. Quantitative changes flow. Exceptional changes
> pulse.**

Examples:

- a replica move may visibly transition from one node column to another;
- leader change may receive one short emphasis pulse;
- a partition split may divide one row into two;
- a changing CPU/read/write value updates smoothly without flashing; and
- an owner-declared failure/violation may pulse once when it first appears,
  then remain calmly visible.

Animation is presentation state. Reduced-motion mode must preserve all semantic
information without motion.

### 8. Colour is never the only carrier of structural meaning

Structural states use shape/icon/border/text in addition to colour. Colour is
used in two disciplined ways:

- stable categorical accents for identity/grouping in ordinary modes; and
- one quantitative sequential/diverging scale for the selected metric in Heat.

The system must not simultaneously use unrelated colours for table identity,
load, health and selection in the same mark.

Actual colours come through the ordinary Theme/DesignToken resolution path from
ADR 0015. System Inspector introduces semantic appearance roles, not renderer-
specific CSS/GTK colour constants.

### 9. High-rate samples are Session state unless deliberately summarized

The current live sample cache, smoothing state, local sparkline buffer,
selection, hover, viewport, expanded rows, animation phase and observation
cursor are Session/transient state.

A Session may keep a bounded ring of samples/events for “since this view
opened” sparklines and Pulse. That buffer is explicitly not authoritative
historical telemetry and is never silently persisted into the Perspective.

True historical scrub/playback waits for a lower retained operational-history
contract. The UI must not manufacture one by storing received live messages in
image objects.

### 10. Version 1 is read-only

The first System Inspector has no cluster mutation commands.

When operational commands are later added, the UI may expose ordinary Commands
against the selected semantic subject, but invocation must route through the
canonical lower admin/control-plane command owner with fresh authorization.
Editing an observation projection is never a valid control path.

## Ownership summary

Planned ownership after this ADR is implemented:

| Concern | Owner |
| --- | --- |
| cluster membership/readiness/placement/replication/load semantics | existing Lagrange core owners |
| unified external operational observation | Lagrange core `OperationalObservationOwner` |
| Object Environment ↔ core observation interaction | `SystemClientAdapter` |
| Object Environment ↔ Images interaction | existing `ImageClientAdapter` |
| durable System Inspector intention/configuration | ordinary Perspective/presentation image objects via existing Perspective owners |
| System Inspector view semantics | `SystemInspector` |
| visibility/composition lifetime | existing `Compositor` |
| concrete drawing/animation/accessibility | existing `RendererAdapter` |
| theme values | existing Theme/DesignToken owner from ADR 0015 |

Implementation must add the planned environment owners/interactions to
`docs/ownership.md` when their code locus exists. This design ADR does not
pretend an unimplemented module already exists.

## Consequences

- The display can be richly live without database polling.
- Operational state changes do not create image-history write amplification.
- The Object Environment remains object-native where durability matters:
  Perspectives, selected subject locators, preferences and themes are objects.
- Lagrange Images remains independent of cluster-dashboard semantics.
- A CLI, automation client or another frontend can consume the same core
  observation contract without the Object Environment.
- The UI cannot quietly reinterpret placement/readiness policy; missing lower
  semantics become explicit lower-layer pressure.
- Large displays can scale by scope, aggregation and virtualization rather than
  multiplying remote subscriptions.

## Rejected alternatives

### Mirror nodes/partitions/metrics as ordinary image objects

Rejected. It makes derived operational state look durable and authoritative,
creates continuous replicated image churn, complicates staleness, and forces a
second lifecycle for facts already owned by core.

### Add cluster observation to `lagrange-images`

Rejected. The information is useful independently of Images and is not
image/object/language semantics. Images would become a forwarding layer between
two owners without adding semantic value.

### Let each Presentation call admin/diagnostic APIs directly

Rejected. That would split the Object Environment → core interaction across
views and encourage each view to invent its own polling, errors and state
interpretation.

### Poll one admin snapshot from `SystemClientAdapter`

Rejected as the normal live path. Centralizing polling in one adapter is still
polling and conflicts with core's no-polling live observation direction.

### Encode all meaning with a single “cluster health score”

Rejected. CPU, I/O, replication state, readiness and active recovery are
independent dimensions with different owners. A single score hides causality
and inevitably embeds arbitrary policy in the UI.

### Persist the Pulse timeline as Perspective state

Rejected. A received-event ring is a transient partial observation. Durable
historical playback requires an authoritative retained lower source.

## Activation / implementation gate

This ADR is ready to guide implementation only after Lagrange core has sealed a
public operational-observation contract for the first vertical slice.

The first environment implementation should then prove, in order:

1. `SystemClientAdapter` consumes that public contract and no direct internal
   system-table/admin-snapshot path;
2. one real table-placement snapshot renders;
3. one remote replica/leader structural change updates the view unsolicited;
4. idle observation performs zero repeated remote reads solely to discover
   changes;
5. Placement and Heat preserve the same geometry;
6. one unsupported/unavailable metric renders as unavailable rather than zero;
7. disconnect/resume/reset is visually explicit; and
8. Perspective persistence contains only durable intent, with no metrics,
   topology snapshot or observation cursor leaked into image state.

Implementation is nontrivial architecture work and therefore requires the
repository's ordinary Bead, independent plan review, ownership update and
exact-head proof gates before code is claimed complete.
