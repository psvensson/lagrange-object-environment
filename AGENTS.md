# Agent instructions

This repository is designed to survive model, provider and session changes. Agents are transient execution machinery; durable project truth lives in the repository, its tests/CI, ADRs and Beads.

## Read this first

At the start of every task:

1. Read this file.
2. Run `npm install` if dependencies are not present.
3. If Beads is not initialized, run `npm run beads:init`.
4. Run `npm run beads:prime` and `npm run beads:ready`.
5. Read the relevant current architecture docs, `docs/ownership.md`, relevant ADRs, tests and the Bead for the task.
6. Inspect current HEAD/PR/CI state before trusting an older plan.
7. Reconcile the written plan against the code that actually exists before editing.

Do not ask the human to repeat information that is already recoverable from repository state.

## Source-of-truth order

When sources disagree, prefer them in this order:

1. executable behavior and tests on current HEAD
2. current architecture/ownership documentation
3. accepted ADRs, interpreted together with later ADRs
4. the current Bead and its evidence/comments
5. roadmap/backlog material
6. conversation/session memory

A plan or chat statement is never evidence that something is implemented.

## Beads is the work graph and operational memory

This project uses `bd` (Beads) for task tracking and short durable project memory.

- Run `bd prime` for current workflow guidance.
- Use `bd ready --json`, `bd show <id> --json`, `bd update <id> --claim --json` and `bd close <id> --reason "..." --json`.
- Create discovered work as a new Bead and link it with `discovered-from` rather than silently expanding the current task.
- Use `bd remember "..."` for concise discoveries, hazards, measurements and rejected assumptions that future agents should find.
- Use Beads dependencies for blockers/ordering instead of prose-only dependency lists.
- Do not create `MEMORY.md` or another parallel memory system.
- Do not use Markdown TODO/checklists as the authoritative task tracker. Roadmaps are strategic documents, not issue queues.
- At the end of a session, sync Beads with `bd dolt push` when the configured remote is available.

If a discovery changes an architectural invariant, public contract or behavior, `bd remember` is not sufficient by itself: promote the result into tests and the appropriate current doc/ADR as part of reconciliation.

The repository pins the Beads CLI as a development dependency. Use the repository version (`npx bd ...` or the npm scripts) rather than assuming a globally installed version.

## Single-owner principle

**Every subsystem or major responsibility has exactly one architectural owner. Every interaction between subsystems also has exactly one architectural owner.**

An owner is a module, service, adapter, registry, repository/layer or other single code locus — not necessarily a human. Ownership means that this locus is authoritative for the concern's invariants, state transitions/public contract and primary proof tests.

Rules:

- `shared ownership`, `both sides own it`, duplicated policy and mutually authoritative implementations are invalid designs.
- Other components may request, observe, cache or adapt an owner's state, but they must not independently decide the same semantic rule.
- A subsystem owner may delegate pure helpers; it may not split semantic authority.
- A cross-subsystem interaction owner owns the protocol/translation, sequencing, error mapping, cancellation/retry/idempotency policy where relevant, and integration proof for that boundary.
- The interaction owner is separate from the two subsystem owners. Naming both endpoint owners does **not** answer who owns the interaction.
- Before adding a new major subsystem or interaction, add or update exactly one entry in `docs/ownership.md`.
- If ownership is ambiguous, stop implementation and resolve ownership first. Ambiguity is an architecture bug, not a detail to leave for code review.
- If implementing a feature seems to require two components to make the same decision, redesign the boundary rather than adding synchronization between competing owners.

Every nontrivial Bead/plan must name the affected subsystem owner(s) and, for every crossed boundary, the interaction owner from `docs/ownership.md`.

## Planning gate

Do not implement a nontrivial change until the current Bead contains or links enough evidence to answer:

- **Problem** — what observable problem exists?
- **Current behavior** — what code/tests/docs establish it?
- **Owner** — which subsystem owner is authoritative?
- **Interaction owner** — which boundary owner applies, or `none`?
- **Relevant invariants/ADRs** — what must not be accidentally changed?
- **Plan** — smallest semantic slices, in dependency order.
- **Falsification** — what result would show the plan/assumption is wrong?
- **Alternatives checked** — especially previously rejected or tempting approaches.
- **Completion proof** — exact tests/CI/evidence needed before closing.

Every nontrivial Bead must have its plan verified by an independent subagent before implementation begins. This is mandatory, not only for architecture changes: delegate an adversarial plan review to a fresh-context subagent that reads the current HEAD, the relevant ADRs/tests/docs and the Bead, and reports gaps, wrong assumptions and falsification weaknesses. Prefer a different model/provider when economical because disagreement is useful evidence. Record the outcome in the Bead. Do not implement against an unverified plan.

Treat a change as nontrivial whenever it touches anything beyond comments, documentation wording or typo fixes — when in doubt, treat it as nontrivial: an unnecessary review is cheaper than an unreviewed regression.

## Before proposing a design

Search first:

- relevant ADRs
- Beads memories/issues, including closed/superseded work
- current tests
- git/PR history when it contains the missing rationale

If an approach was previously rejected, do not revive it without stating which premise has changed.

This is the primary ping-pong prevention rule.

## Implementation discipline

Work in the smallest semantic slices that can be independently checked.

For each slice:

1. establish/characterize current behavior when needed
2. add or identify a proof that distinguishes the intended behavior from the old/wrong behavior
3. implement only that slice
4. run the narrow proof
5. run affected regression tests
6. inspect the diff for boundary/ownership drift before continuing
7. verify the completed slice with an independent subagent before moving on

Every implementation step must be verified by an independent subagent. After a slice is implemented and its proofs pass, delegate a fresh-context adversarial review of the actual diff and tests — not just the plan — and resolve its findings before the slice counts as done, or record each unresolved finding with the reason it is not being addressed. Self-review by the implementing agent is not a substitute: the point is that a second, independent reader can catch what the first rationalized.

Do not fix unrelated discovered problems opportunistically. Record them as `discovered-from` Beads unless they block the current change.

Do not make a UI-level workaround for a missing image semantic contract. Conversely, do not push renderer/session concerns into `lagrange-images` merely because the image is durable.

## Falsification over assertion

Prefer proofs that would fail under the competing/wrong implementation.

Examples:

- revert or perturb the critical condition and show the intended proof goes red
- prove unauthorized/unavailable paths, not only successful paths
- prove identity/revision distinctions with conflicting cases
- prove both sides of a cross-subsystem contract independently where possible

A green test that cannot distinguish the intended design from the tempting wrong design is weak evidence.

## Verification gate

Before calling implementation complete:

1. targeted tests pass
2. affected regression suite passes
3. repository-wide required tests pass
4. exact PR-head CI is green
5. the diff matches the plan and named owners
6. current docs/ADRs/ownership registry are reconciled
7. durable discoveries are recorded in Beads and promoted to tests/docs/ADR when architectural
8. deferred work is represented as linked Beads rather than hidden in prose/chat

Do not merge on an older green commit after the PR head changed.

## Reconciliation gate

Implementation is not finished when the code works. Ask what the work taught the project.

Record as appropriate:

- new invariant or decision -> ADR/current architecture + proof
- surprising behavior/hazard -> `bd remember`, and a test when regressible
- rejected attractive approach -> `bd remember` with why and a concrete `revisit when` condition
- new work -> Bead linked with `discovered-from`
- changed subsystem/boundary -> `docs/ownership.md`
- completed task -> Bead closure reason with proof references

No important discovery should exist only in chat.

## Handoff protocol

A provider/session handoff must leave the next agent able to continue from repository state alone.

Before stopping:

1. leave HEAD coherent; do not leave knowingly broken partial edits unless the Bead explicitly describes the state
2. update the Bead with what is done, what remains, and current proof status
3. record discoveries/rejected approaches
4. record blockers/dependencies
5. update ownership/ADR/current docs when their truth changed
6. sync Beads when possible

The next agent should be able to start with `bd prime`, `bd ready`, the active Bead and current HEAD — not this conversation.

## Repository workflow

Use one semantic task per branch and pull request.

```text
main -> agent/<task> -> pull request -> exact-head CI -> squash merge -> main
```

- Never intentionally make feature/documentation changes directly on `main`.
- Branch from current `main` unless the task explicitly depends on another unmerged branch.
- Keep the PR narrow enough that its ownership and proof story are obvious.
- Prefer squash merge so the main history contains one semantic commit per task.

## Code and dependency policy

- JavaScript ES modules; no TypeScript/build step without concrete pressure.
- Node.js 22 or newer.
- Prefer standard library before dependencies.
- Keep environment semantics renderer-independent.
- Consume `lagrange-images` through its public API only.
- A reference is never authority.
- Command applicability is never authorization.
- Session mechanics do not become durable image state by accident.

## Beads bootstrap

The repository intentionally owns its custom `AGENTS.md`, so initialize Beads with the repository script, which passes `--skip-agents`:

```sh
npm install
npm run beads:init
npm run beads:prime
npm run beads:ready
```

Do not run a provider-specific `bd setup` recipe that rewrites repository instructions unless there is a separate reviewed task to do so. Provider portability is a project requirement.
