# System Inspector

Detailed design for a live, colourful operational view of Lagrange inside the
Object Environment.

> **Status:** proposed design. It depends on Lagrange core's proposed
> `architecture/operational-observation-plane.md` and ADR 0017. Nothing in this
> document claims that the lower observation contract or these presentations
> are implemented yet.

## Goal

The System Inspector should make the database's current physical and logical
shape understandable at a glance while remaining useful for precise diagnosis.
It should feel like looking at a living machine rather than reading a periodic
status report.

The primary questions are:

1. **What exists?** Nodes, latency groups, tables, partitions and replicas.
2. **Where is it?** Which nodes host each partition replica and which replica
   leads it.
3. **What is changing?** Joins, readiness transitions, replica moves, leader
   changes, splits/merges, recovery and other owner-declared operations.
4. **Where is the pressure?** CPU, disk, network, reads/writes, Raft, execution
   and other metrics for which core has a canonical source.
5. **What is exceptional?** Owner-declared violations, failures, stale sources
   or incomplete state.
6. **What is this exact thing doing?** Drill from any mark to one node, table,
   partition, replica or operation without losing context.

The design deliberately uses several coordinated views. One giant topology
chart cannot answer all six questions without becoming a graph hairball.

## Architectural position

```text
Lagrange core semantic owners
  membership / latency / tables / partitions / replicas / readiness /
  placement / operations / telemetry
        |
        v
core Operational Observation Plane
  canonical subjects + snapshot + live deltas + measurements + conditions
        |
        v
SystemClientAdapter                         ImageClientAdapter
  transient authorized core observation       durable image semantics
        |                                      |
        +-------------------+------------------+
                            v
                    System Inspector
              Perspective + Presentations
                            |
                    SemanticUi / graphics
                            |
              Compositor + RendererAdapter
```

The two adapters are intentionally parallel:

- `ImageClientAdapter` remains the environment's single owner for Lagrange
  Images interaction.
- `SystemClientAdapter` owns the environment's interaction with the public
  Lagrange control-plane observation contract.

The System Inspector never reads core system tables or diagnostics endpoints
directly, and `lagrange-images` does not proxy operational cluster state.

## Durable object model versus live observation

The environment remains object-native, but the dividing line is durability.

### Durable ordinary image objects

The durable System Inspector Perspective stores **intention**, for example:

```text
SystemInspectorPerspective
  viewKind: constellation | placement | heat | inspector
  rootSubject: SystemSubjectLocator
  metricId?: text
  filters?: SystemInspectorFilterSet
  sort?: SystemInspectorSort
  pinnedSubjects?: refs to SystemSubjectLocator objects
  layoutOverrides?: list of user-authored placement hints
  legendOptions?: presentation preferences
  zoomIntent?: durable only when the user deliberately saves it
```

A `SystemSubjectLocator` is a stable locator, not a state mirror:

```text
SystemSubjectLocator
  clusterKey
  subjectKind
  subjectKey
  optional user annotation/title
```

A locator is useful because a person may want a Perspective that says “open the
orders table placement view and keep partitions p17 and p42 pinned” after a
restart. On reopen, the live state is resolved fresh through core.

### Transient Session state

The following remain Session/runtime-local:

```text
current snapshot and deltas
metric samples and smoothing buffers
observation cursor/frontier
connection/reconnect state
selection and hover
viewport and virtualized row window
expanded/collapsed transient rows
animation progress
current pulse-event ring
renderer/GPU resources
```

No automatic live update writes these values into image history.

## Shared semantic subject model

Every visual mark ultimately refers to one lower `OperationalSubjectRef` from
core. The System Inspector may wrap that reference in transient presentation
state, but it does not create a second identity scheme.

The expected subject kinds are:

- cluster;
- latency group;
- node;
- table;
- partition;
- replica; and
- operation.

A click, keyboard activation or programmatic selection therefore always
produces the same kind of semantic selection regardless of view. A partition
selected in Placement is the same partition selected in Heat and Inspector.

## The coordinated view family

The first family has five views, four primary and one supporting:

1. **Constellation** — cluster-wide overview.
2. **Placement** — partition × node structural matrix.
3. **Heat** — the same matrix geometry with one quantitative metric.
4. **Inspector** — selected-subject detail.
5. **Pulse** — live structural event strip shared by the active inspector
   composition.

A Perspective may contain several simultaneously. For example, a wide desktop
could show Constellation above Placement with Inspector to the right; a narrow
screen might show the same subjects one presentation at a time.

No view owns observation independently. Each declares an interest and consumes
one normalized observation model from `SystemClientAdapter`.

---

# 1. Constellation

## Purpose

Answer within a few seconds:

- how many nodes are present;
- how they divide into latency groups;
- which nodes are busy, unavailable or in a meaningful lifecycle transition;
- whether obvious placement/recovery work is occurring; and
- where to click next.

This is the view suitable for leaving open on another monitor.

## Layout

Nodes have stable positions while they remain members of the observed cluster.
Latency groups form explicit regions. The default ordering should be stable and
deterministic, not continuously optimized around changing values.

```text
+ Stockholm / latency group A --------------------------------------+
|                                                                    |
|  node-1              node-2              node-3                    |
|  [state]             [state]             [state]                   |
|  CPU  42%            CPU  21%            CPU  38%                  |
|  Disk 67%            Disk 18%            Disk 51%                  |
|  Net  18 MB/s        Net   4 MB/s        Net  11 MB/s              |
|  Raft  ...           Raft ...            Raft ...                  |
|                                                                    |
+--------------------------------------------------------------------+

         + latency group B ---------------------------+
         | node-4                    node-5            |
         +---------------------------------------------+
```

For many nodes the node card progressively simplifies into a compact glyph with
small quantitative bands; selecting one expands detail in Inspector rather
than making every card enormous.

## Node encoding

One scalar “load score” is explicitly avoided. A node can be CPU-light but
network- or disk-heavy. The initial card should support a small fixed set of
independent bands such as:

- CPU;
- memory where useful;
- disk occupancy / disk I/O as distinct metrics when both exist;
- network;
- Raft/replication activity; and
- query/service execution.

Only metrics that core actually supports are shown. An unsupported metric is
not replaced by a guessed value.

Node lifecycle/readiness state is owner-declared core state, rendered with a
text/icon/border treatment. The renderer never decides that high CPU means
“unhealthy” unless core has a named condition saying so.

## Connections

Persistent all-to-all Raft lines are forbidden: they become visual noise.

Transient connections may appear when they communicate an event with temporal
meaning:

- replica transfer source → target;
- unusually relevant cross-latency-group traffic if core supplies that metric;
- a leader transition;
- recovery/snapshot transfer; or
- a selected partition's replica relationships.

Selecting a partition may temporarily reveal only that partition's topology on
top of Constellation.

## Animation

Node numeric bands interpolate gently. Structural transitions animate only when
they preserve comprehension — for example a new node enters its group, a node
leaves, or a move arc briefly appears. Repeated CPU changes never make the card
pulse.

---

# 2. Placement

## Purpose

This is the operational workhorse. It answers:

> For this table, where does every partition live right now?

Rows are partitions; columns are nodes.

```text
                   node1    node2    node3    node4    node5

orders / p01         ●        ◉        ●
orders / p02         ●                 ◉        ●
orders / p03                  ●        ●                 ◉
orders / p04         ◉        ●                          ●
orders / p05         ●                 ●        ◉
orders / p06                  ◉        ●        ●
```

Legend conceptually:

```text
●  replica
◉  leader replica
○  replica being added / not yet complete
◌  departing replica
!  owner-declared exception/violation on this relationship
```

The final symbols need accessible visual design, but the semantic rule is fixed:
colour is never required to distinguish them.

## Stable geometry

Node columns remain in the same stable order used by Constellation where
possible, grouped by latency group. Partition rows use stable canonical order.

When a replica moves, the user sees state change *within familiar coordinates*
rather than the whole display re-layout.

## Structural information

A cell can encode:

- no replica;
- current replica;
- leader replica;
- adding/catching-up replica;
- removing/departing replica;
- active operation concerning that replica; and
- owner-declared condition/violation.

The row can additionally show desired RF/current owner-declared replica state,
partition size when available and current operation state.

The view does **not** calculate “replication healthy” from `count(dots) == 3`.
Core may expose desired replication factor as a fact and a replication/placement
condition as a semantic state. Raw counts can still be displayed, but the UI
never silently substitutes its own policy for the lower owner's verdict.

## Exception mode

A first-class **exceptions only** filter shows rows/relations with core-provided
conditions.

This is especially important at large scale: an operator should be able to
turn a 10,000-partition table into the handful of partitions that currently
need attention without downloading or re-implementing placement policy in the
renderer.

## Scale

The matrix must not create one DOM/GTK/native widget or remote subscription for
every possible cell.

At increasing scale:

1. virtualize rows and columns locally;
2. request only visible/near-visible detailed partitions where the core
   contract supports scoped detail;
3. represent large ranges as explicit density/aggregate bands at low zoom; and
4. expand a range to canonical partition rows on demand.

An aggregate band is visibly an aggregate. It cannot pretend to be a physical
partition.

---

# 3. Heat

## Purpose

Answer:

> The placement is known; where is the selected kind of pressure concentrated?

Heat deliberately reuses **exactly the Placement matrix coordinates**.
Switching modes changes encoding, not geometry.

```text
                   n1       n2       n3       n4       n5
orders / p01       ░        █        ▒
orders / p02       █                 ▒        ░
orders / p03                ░        █                 ▒
```

## One metric at a time

The metric selector might eventually offer:

```text
Reads
Writes
CPU
Memory
Disk I/O
Disk occupancy
Network
Raft
Storage bytes
Replica lag
SQL execution
Service/WASM execution
```

The list is capability-driven. It contains only metric IDs reported by core for
the active scope.

One primary quantitative colour scale is used at a time. This avoids trying to
make hue simultaneously mean table identity, write load, health and selection.

Structural marks such as leader/replica state remain visible with shape/border
atop the heat encoding.

## Normalization

Two notions are kept distinct:

- **semantic thresholds** come only from core/metric owners, when they exist;
- **presentation normalization** may map the current numeric distribution to a
  readable heat scale (for example percentile or fixed domain).

If percentile normalization makes the hottest item red, that means “highest in
this selected visual domain,” not “core considers this unhealthy.” The legend
must make that distinction explicit.

Users may choose a fixed domain where meaningful (for example 0–100% capacity)
so two moments remain visually comparable.

## Time behavior

Measurements update without changing positions. The rendering owner may smooth
visual interpolation between two samples, but labels/tooltips/Inspector retain
the real sample value and timestamp.

A stale sample visually decays or receives a stale indicator rather than
remaining indistinguishable from fresh data.

---

# 4. Inspector

## Purpose

A precise detail presentation for one selected subject.

Every meaningful mark in the other views activates the ordinary semantic
Inspector for that subject. There is no separate widget-specific drilldown
identity.

## Partition example

```text
                         orders / p381
                    18.4 GB · selected metrics

                           LEADER
                        +---------+
                        | node-17 |
                        +---------+
                         /       \
                        /         \
                +---------+     +---------+
                | node-23 |     | node-41 |
                +---------+     +---------+

                RF fact       owner-declared state
                active move   replica/lag conditions
```

Below the topology, compact sections can include:

- current canonical properties;
- replica list with roles/states;
- active operations;
- owner-declared conditions;
- selected quantitative measurements;
- transient local sparklines since this Session began; and
- links/activation targets to host nodes, table and related operation subjects.

## Node example

A node Inspector can show:

- lifecycle/readiness state;
- latency group;
- resource metrics;
- hosted replica count/reference set at an appropriate level of detail;
- leader count when core exposes the fact;
- active operations involving the node; and
- current owner-declared conditions.

The detail view should prefer named owner states over enormous raw diagnostic
blobs. A future “raw diagnostics” presentation can exist separately when
needed.

---

# 5. Pulse

## Purpose

Make structural change visible without forcing the operator to stare at every
animated mark.

```text
15:03:21  orders/p381 leader changed node17 -> node23
15:03:18  orders/p044 replica added on node12
15:03:14  node09 state changed -> TRAFFIC_READY
15:03:02  orders/p118 split -> p118 + p722
```

Clicking an event selects its subject(s) in every coordinated presentation.
Keyboard activation does the same.

## What Pulse is in version 1

Pulse is a bounded transient Session ring of events actually received from the
core observation stream while the view is alive.

It may be useful for the last few minutes of visual context, but it is labelled
accordingly. It is **not** the cluster's historical event log.

If the observation stream resets, Pulse inserts an explicit reset/gap marker.
It never silently joins pre-gap and post-gap events into an apparently complete
history.

## Future playback

Once core owns a retained operational-history contract, Pulse can grow into a
scrubber/playback presentation:

```text
live <---- 30 s ---- 5 min ---- 1 h ---- retained horizon
```

That future view should reconstruct from the authoritative lower history, not
from a Perspective's persisted UI cache.

---

# Cross-view coordination

## Selection

There is one Session selection model for operational subjects. Selecting
`partition p381` in any view:

- highlights p381's row in Placement/Heat;
- reveals its replica relationships in Constellation;
- loads p381 in Inspector; and
- highlights Pulse events concerning p381.

Multiple selection can be added later when a concrete workflow demands it.

## Pinned subjects

A deliberate `Pin` command may create/update durable
`SystemSubjectLocator` references in the Perspective. Pinning preserves the
intent to reopen/compare that subject; it does not preserve a snapshot of its
operational state.

If a pinned subject no longer exists when the Perspective reopens, that is an
explicit `not found/retired` presentation state. The environment does not
silently retarget by display name.

## View-mode switch

Placement ↔ Heat is a mode switch over the same table/root and viewport. The
selected partition, column ordering, scroll position and zoom remain Session
state through the switch.

Constellation ↔ Placement changes semantic scale but keeps selection.

---

# Observation scopes and lifecycle

The UI declares observation scopes that match what is visible.

## Cluster overview scope

Needs:

- latency groups;
- nodes;
- node lifecycle/owner conditions;
- a small configured set of node aggregate metrics;
- active operations with cluster-visible significance.

It does not need every partition row.

## Table placement scope

Needs:

- selected table;
- its partitions;
- replica/node relationships and leaders;
- relevant active operations/conditions;
- selected metric only when Heat is active.

## Partition detail scope

Needs detailed state for exactly one/few selected partitions and their replicas,
plus requested metrics.

## Lifecycle

```text
Presentation becomes visible
        |
        v
SystemInspector describes semantic interest
        |
        v
SystemClientAdapter acquire(scope)
        |
        v
snapshot + live continuation
        |
view hidden/destroyed
        |
        v
release(scope)
```

Equivalent local scopes are reference-counted/coalesced by the adapter. The
core plane owns distributed coalescing below that.

A bounded release grace may avoid subscription churn while a user briefly
switches tabs/panes, but the grace timer is lifecycle optimization, not change
detection.

---

# Visual grammar

The System Inspector should be colourful, but colour must carry disciplined
meaning.

## Stable spatial identity first

A subject should remain in the same place while only its quantitative values
change. Humans detect anomalies by remembering spatial patterns; constantly
re-sorting by the current hottest value destroys that memory.

Automatic layout changes therefore happen only for structural reasons such as
node membership/latency-group changes, and even then should preserve existing
positions where possible.

## Structural marks

Illustrative semantics:

| Meaning | Non-colour carrier |
| --- | --- |
| node | labelled container/glyph |
| replica | filled mark |
| leader | ring/crown/inner marker around replica mark |
| adding | outline/progress treatment |
| departing | dashed/fading structural treatment |
| owner condition | explicit icon/border + text in detail |
| selected | focus/selection outline |
| stale | clock/stale glyph + age |
| unavailable | explicit unavailable mark, never empty space |

Exact renderer shapes remain design-token/presentation work, but semantic roles
are renderer-neutral.

## Colour roles

1. **Categorical colour**: table/latency-group/semantic category identity where
   it helps orientation.
2. **Quantitative colour**: the current Heat metric.
3. **Interaction accent**: selection/focus according to the active Theme.
4. **Condition emphasis**: owner-declared severity roles.

No single mark should ask the user to decode four simultaneous hues. When Heat
is active, metric colour dominates and categorical identity moves to labels,
shape, grouping or subtle borders.

## Theming

All semantic appearance roles resolve through the Theme/DesignToken system from
ADR 0015. The System Inspector may introduce roles such as:

```text
system.node.surface
system.latency-group.boundary
system.replica.normal
system.replica.leader
system.operation.active
system.condition.warning
system.condition.failure
system.observation.stale
system.observation.unavailable
system.heat.low ... system.heat.high
```

These are semantic roles, not fixed RGB values. High-contrast and dark/light
Themes resolve them normally.

## Motion

The design rule is:

> Structural changes move. Quantitative changes flow. Exceptional changes
> pulse.

Motion must never be necessary to understand a state. With reduced motion:

- transitions snap or crossfade minimally;
- event arrival still appears in Pulse;
- structural state remains distinct by shape/text; and
- focus/selection remains clearly visible.

---

# Staleness, disconnection and uncertainty

The display must be trustworthy under failure.

## Global connection state

A disconnected/reconnecting observation source receives a visible top-level
status. The last snapshot may remain on screen for context, but it is visibly
stale and ages.

## Partial sources

If topology is current but one metric source is unavailable, topology remains
usable while that metric renders `unavailable`. The whole display need not go
blank.

## Reset

When core reports continuity loss:

1. mark the affected scope reconciling;
2. do not animate missing intermediate structural events as if observed;
3. replace state from the new snapshot;
4. insert a Pulse reset/gap marker; and
5. restore normal live status only after the new snapshot is established.

## Unknown is not zero

No renderer path converts missing, denied, stale or unsupported into numeric
zero. This rule should have direct tests because colourful dashboards otherwise
make this mistake very easily.

---

# Load and metric semantics

The visual design wants many metric types, but the architecture must resist
inventing metrics merely to complete a screen.

Each metric supplied by core has at least:

```text
metric id
subject
value + unit
sample timestamp
optional measurement window
optional capacity/denominator
source status
```

The UI may derive **presentation statistics** over the received set:

- min/max for legend domain;
- percentile rank;
- local moving interpolation for animation; or
- a bounded Session sparkline.

It may not transform those into semantic claims such as overloaded, unhealthy
or unsafe unless the lower owner supplies that condition/threshold semantics.

## Suggested initial metric priority

Prefer metrics that directly explain common cluster behavior and already have
credible owners:

1. node CPU / memory / disk capacity;
2. node disk and network activity;
3. partition/table read and write rates where canonical counters exist;
4. replica lag / Raft activity where canonical telemetry exists;
5. query/service execution work;
6. storage bytes per partition; and
7. cross-latency-group traffic when the latency/topology owner can expose it
   without duplicating accounting.

This is a prioritization, not a claim that every item exists today.

---

# Large-cluster behaviour

The same design must remain useful beyond a five-node demonstration.

## Node scale

- <= roughly a few dozen nodes: labelled cards/glyphs can remain individually
  visible in Constellation.
- larger groups: use compact glyphs and density while retaining stable subject
  activation.
- huge clusters: introduce explicit hierarchical grouping only from canonical
  topology/grouping facts; do not invent arbitrary UI “zones” that resemble
  real failure domains.

Exact breakpoints are renderer/measurement choices and should be tested rather
than frozen architecturally.

## Partition scale

Thousands of partitions demand virtualization and level-of-detail:

```text
zoomed out: partition-range density bands
mid:         compact rows
zoomed in:   full replica/leader/operation marks
selected:    Inspector detail
```

A low-detail range can summarize facts but must expand deterministically to the
canonical rows it represents.

## Update scale

Rendering is frame-batched. Receiving 10,000 measurement deltas does not imply
10,000 synchronous layout operations.

`SystemClientAdapter` updates its transient current projection; the
presentation owner marks affected semantic regions; the renderer consumes a
bounded frame update. Structural continuity remains exact even though rendering
is batched.

High-rate metrics may already be coalesced by core according to its contract.
The UI may additionally collapse redundant intermediate visual frames; it does
not rewrite timestamps or claim it displayed every sample.

---

# Accessibility and alternate renderers

The System Inspector is not a canvas-only design.

Every graphical relationship should have a semantic representation suitable
for:

- keyboard navigation;
- screen readers;
- high contrast;
- text/table fallback presentations; and
- native GTK/other future renderers.

For example, Placement's graphical matrix should expose row/column/cell labels
such as:

```text
partition p381, node-17: leader replica, current
partition p381, node-23: follower replica, lag state normal
partition p381, node-41: replica adding, operation move-72
```

These labels come from semantic state, not pixel interpretation.

A text/list Presentation over the same subjects is a legitimate alternate view,
not a degraded separate data path.

---

# Commands in version 1

Version 1 remains read-only but may have local/presentation commands:

- select/open subject;
- pin/unpin subject locator;
- switch Placement/Heat;
- choose metric;
- filter exceptions;
- change sort/group view where semantically safe;
- save deliberate Perspective layout/view intent; and
- copy/activate semantic identifiers according to existing environment command
  conventions.

There are no move-replica, drain-node, transfer-leader or similar cluster
mutations in this slice.

When operational mutations are later justified, each becomes an ordinary
Command whose lower action is separately authorized and owned by core's
canonical control-plane command path.

---

# Failure-resistant design rules

These should become implementation falsifiers, not merely prose:

1. **No polling:** an idle live view performs no repeated remote reads whose
   purpose is discovering whether distributed state changed.
2. **No mirror:** saving/restoring the Perspective does not contain topology,
   metrics, leader state or observation cursors.
3. **No health duplication:** the environment has no parallel readiness/
   placement/replication correctness evaluator.
4. **No per-cell subscriptions:** a Placement matrix's remote interest is
   scoped by table/viewport semantics, not mark count.
5. **Unknown != zero:** unsupported/unavailable/stale measurements never render
   as numeric zero.
6. **Reset is visible:** continuity loss cannot silently look like a smooth
   sequence.
7. **Identity survives modes:** selecting a subject in Placement and switching
   to Heat preserves the same subject identity.
8. **Geometry survives metrics:** changing the Heat metric changes encoding,
   not partition/node coordinates.
9. **Reduced motion is complete:** disabling motion loses no state meaning.
10. **Authority is pass-through:** durable Perspectives contain no authority or
    grant tokens.

---

# Recommended implementation sequence

This repository should begin only after the core observation vertical is public
and sealed. Then implement in separate Bead-reviewed slices:

## E1 — Boundary proof

- planned `SystemClientAdapter`;
- one canonical core table-placement scope;
- snapshot + unsolicited delta + reset/cancel;
- authorization pass-through;
- no direct internal/admin snapshot fallback.

No polished graphics yet.

## E2 — Placement semantics

- `SystemInspector` owner;
- canonical partition × node model;
- replica/leader/operation/condition marks;
- virtualization baseline;
- text/accessibility representation;
- exact subject activation.

## E3 — Heat on identical geometry

- metric capability discovery;
- one metric scale at a time;
- unavailable/stale behavior;
- same geometry/selection as Placement;
- frame batching/coalescing proof.

## E4 — Constellation

- stable node layout grouped by canonical latency group;
- node aggregate metrics;
- selected-partition topology overlay;
- transient operation connections only.

## E5 — Inspector + Pulse

- partition/node/replica detail;
- transient Session sparklines;
- bounded event ring;
- explicit reset/gap markers;
- cross-view event activation.

## E6 — Object-native durable intent + theming polish

- durable SystemSubjectLocator/pins where required;
- Perspective round-trip proving no live state leak;
- Theme/DesignToken semantic roles;
- reduced-motion/high-contrast proof;
- browser/native renderer parity for semantic state.

The sequence intentionally proves the data/ownership boundary before visual
polish. A beautiful mock driven by polling or mirrored state is a regression,
not an intermediate success.

# Deliberately deferred

- authoritative historical playback;
- cluster mutation/admin commands;
- user-configurable alert policy;
- arbitrary metric formulas;
- long-term metrics storage;
- automatic anomaly detection;
- a universal topology force graph;
- 3D as a requirement (a later 3D Presentation can use the same semantic model
  if it genuinely improves comprehension); and
- teaching Lagrange Images any cluster-observation concept.

These can be reconsidered when a concrete workflow provides pressure without
changing the core ownership model above.
