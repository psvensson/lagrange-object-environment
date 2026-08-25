# Architecture decisions

The first decisions intentionally constrain semantics while leaving visual design open.

1. [0001 — The image is the workspace](0001-image-is-the-workspace.md)
2. [0002 — The object environment is a public consumer of Lagrange Images](0002-public-images-consumer.md)
3. [0003 — Perspective is durable; Session is transient](0003-perspective-and-session.md)
4. [0004 — Presentations and commands operate on semantic subjects](0004-presentations-and-commands.md)
5. [0005 — Identity is external; authority is transient and enforced below the environment](0005-identity-and-authority.md)
6. [0006 — Project semantics stay image-level; Project interaction and graphical work belong here](0006-project-and-environment-boundary.md)
7. [0007 — Provider-independent agent governance uses repository truth, Beads and single ownership](0007-provider-independent-agent-governance.md)
8. [0008 — A Perspective is an ordinary image object of one well-known Shape](0008-perspective-as-image-object.md) *(representation superseded by 0012)*
9. [0009 — Live observation is a pull-based change feed owned by the image adapter](0009-image-observation-change-feed.md)
10. [0010 — Command invocation passes authority through; the environment never holds it](0010-command-invocation-authority-passthrough.md)
11. [0011 — Portable Component graphics are ordinary presentations](0011-component-backed-graphics-presentations.md)
12. [0012 — A Perspective is a small object graph — a Perspective plus child presentation objects](0012-perspective-as-object-graph.md)
