# ADR 0007: Provider-independent agent governance uses repository truth, Beads and single ownership

## Status

Accepted

## Context

Development will move between LLM providers and sessions for cost and capability reasons. Conversation-local memory therefore cannot be a project dependency.

The project also needs to avoid two recurring failure modes of agentic development:

1. **knowledge loss / ping-pong** — one agent discovers why an attractive approach is wrong, a later agent cannot see that discovery, and reintroduces it;
2. **ownership blur** — multiple modules or both sides of an integration begin implementing the same policy, so fixes oscillate between them and no component is clearly accountable for correctness.

ADRs already provide good architectural decision history, but they are too heavyweight to be the task graph or the first landing place for every observation. A provider-independent operational memory/task graph is useful alongside them.

## Decision

### 1. Repository state is authoritative, not agent memory

Agents are replaceable. Current code/tests, current architecture/ownership docs, ADRs and durable Beads state must be sufficient to resume work.

A chat transcript may help an active session but cannot be required for continuation.

### 2. Beads owns task/dependency tracking and short operational memory

The repository pins `@beads/bd` and uses Beads for:

- active/deferred work
- blockers and dependency relationships
- `discovered-from` work
- compact persistent discoveries through `bd remember`

The project does not maintain a competing Markdown TODO or `MEMORY.md` system.

Important architectural discoveries are promoted from Beads into stronger durable forms: tests, current docs, ownership records and ADRs.

The project owns a common `AGENTS.md`; Beads is initialized with `--skip-agents` so provider-specific setup does not replace project governance.

### 3. Planning and implementation are both gated by evidence

A nontrivial change must establish current behavior, owners, relevant invariants, a semantic implementation plan, a falsification/counterexample plan and completion proof before implementation.

Implementation proceeds in independently verifiable semantic slices. Completion requires exact-head CI plus reconciliation of durable project knowledge.

### 4. Every major subsystem has exactly one owner

A subsystem owner is one architectural locus authoritative for the concern's semantic decisions, state/public contract and primary proof.

`shared ownership` is not an accepted steady-state design.

### 5. Every cross-subsystem interaction has exactly one owner

The interaction itself has an owner distinct from merely listing the two endpoint owners.

That owner is authoritative for the boundary protocol/translation, sequencing and applicable lifecycle/error/retry/idempotency behavior, plus integration proof.

An interaction without a named owner is not ready to implement.

### 6. Ownership is recorded in one registry

`docs/ownership.md` is the current responsibility map. New major subsystems/interactions must be entered there before implementation, and ownership changes update it as part of the same task.

## Consequences

Changing provider should be closer to changing execution machinery than onboarding a developer from oral history.

Previously rejected approaches can be rediscovered deliberately rather than accidentally: a Beads memory should capture why the approach failed and the condition under which it deserves reconsideration.

Agents are discouraged from opportunistic scope growth because discovered work has a first-class durable destination.

Cross-boundary bugs have a named place to fix. The project should not solve ambiguity by duplicating the same policy on both sides.

The process costs some explicit planning/reconciliation tokens, but those tokens buy reusable project state and should reduce repeated investigation across providers.
