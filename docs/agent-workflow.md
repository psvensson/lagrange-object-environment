# Provider-independent agent workflow

The project assumes agents and LLM providers will change frequently. Continuity therefore comes from durable repository state, not conversation memory.

## Durable state roles

| State | Durable home | Purpose |
| --- | --- | --- |
| Current implementation truth | code + tests + exact-head CI | What actually works. |
| Current architecture | architecture/concept/ownership docs | What the system is now. |
| Architectural decision history | ADRs | Why important decisions were made. |
| Active/deferred work and dependency graph | Beads | What is being worked on, blocked, discovered or ready. |
| Short discoveries/hazards/rejected assumptions | `bd remember` | Fast memory across agents/providers. |
| Strategic direction | roadmap | Where the project is trying to go; not an issue tracker. |

No chat transcript is required to resume work.

## Bootstrap

On a fresh checkout/session:

```sh
npm install
npm run beads:init      # harmlessly reports existing initialization after first setup
npm run beads:prime
npm run beads:ready
```

`beads:init` deliberately uses `bd init --quiet --skip-agents`. The project owns `AGENTS.md`; provider-specific Beads setup must not rewrite the common instructions by default.

If an initialized repository has a configured Dolt remote, pull Beads state before selecting work:

```sh
npx bd dolt pull
npm run beads:ready
```

## Work lifecycle

### 1. Select and claim

Use ready work rather than guessing from the roadmap:

```sh
npx bd ready --json
npx bd show <id> --json
npx bd update <id> --claim --json
```

For new human-requested work, create a Bead before nontrivial implementation and include the planning fields below.

### 2. Reconnaissance

Establish what is true on current HEAD:

- relevant implementation paths
- tests that currently characterize the behavior
- relevant current docs and ADRs
- ownership entries
- prior Beads/memories and rejected approaches
- PR/CI state when continuing existing work

Do not plan from a stale conversation summary when current repository evidence is available.

### 3. Plan gate

A nontrivial task should record:

```text
Problem
Current evidence
Subsystem owner(s)
Interaction owner(s), or none
Relevant invariants / ADRs
Plan in semantic slices
Falsification / counterexample plan
Alternatives checked
Completion proof
```

A plan is not verified merely because it sounds coherent. Verification means it is checked against current code/tests, ownership is unambiguous, and there is a falsification/counterexample that could prove the plan wrong.

For architectural or major cross-subsystem work, perform a separate plan-review pass before implementation. Using a different provider/model is preferred when credits permit because disagreement is useful evidence. A fresh-context adversarial pass is the fallback.

### 4. Implement and prove slice by slice

For each semantic slice:

1. characterize the old behavior when needed
2. create/identify a discriminating proof
3. make the smallest implementation change
4. run targeted proof
5. run affected regression proof
6. inspect the diff for owner/boundary drift
7. continue only after the slice is coherent

Prefer tests that fail for the attractive wrong implementation, not only tests that happen to pass for the intended one.

### 5. Record discoveries without derailing

When implementation exposes adjacent work:

```sh
npx bd create "<title>" --description="<evidence and why it matters>" \
  --deps discovered-from:<current-id> --json
```

Do not silently broaden the current PR unless the discovery blocks the task.

For a compact fact future agents should know:

```sh
npx bd remember "<fact; evidence; consequence; revisit condition if rejected>"
```

Useful memory categories include:

- invariant
- surprising discovery
- failed/tempting approach
- hazard
- measurement
- compatibility constraint

A rejected approach should say **why** and **revisit when**. This prevents both ping-pong and permanent dogma.

### 6. Verification gate

Before completion:

- targeted proof green
- affected regressions green
- full required suite green
- exact PR-head CI green
- diff matches plan and ownership map
- docs/ADR/ownership reconciled
- discoveries/deferred work persisted

If the head changes after a green run, the old green run is historical evidence, not merge authority.

### 7. Reconciliation

Ask what changed in project knowledge, not only code.

Promote knowledge based on its type:

```text
behavior that can regress        -> test
current architectural truth      -> current docs / ownership map
architectural rationale          -> ADR
short durable discovery          -> bd remember
new/deferred work                -> Bead (+ dependency relation)
measurement                      -> bd remember + benchmark/test when stable
```

Important semantic facts must not live only in Beads memory if tests/current docs/ADR can encode them more strongly.

### 8. Handoff

Before leaving a task unfinished:

- update the active Bead with current state and evidence
- link blockers/discoveries
- record failed approaches and revisit conditions
- leave HEAD coherent
- sync Beads when possible

A replacement agent should only need current HEAD, `AGENTS.md`, `bd prime`, the active Bead and referenced evidence.

## Beads synchronization

Beads currently uses Dolt-backed storage. The working database is not ordinary Git file history; use Beads' sync commands rather than treating JSONL as the canonical database:

```sh
npx bd dolt pull
npx bd dolt push
```

The first local initialization should be done with the repository-pinned Beads version. Do not hand-create `.beads` metadata/database files.

## No duplicate planning systems

Avoid simultaneous authoritative task stores such as:

- Markdown TODO files
- ad-hoc `work/` task queues
- provider-specific memory files
- GitHub issues duplicating Beads tasks without a deliberate external-facing reason

ADRs/current docs and Beads are complementary rather than duplicates: ADRs explain architectural decisions; Beads tracks work and operational memory.

## Ownership as a planning primitive

Before implementation, every task must be expressible as changes routed through named owners.

For a boundary-crossing flow:

```text
caller
   -> subsystem A owner
   -> INTERACTION OWNER
   -> subsystem B owner
```

The interaction owner is responsible for the contract between A and B. If the plan has only A and B and no owner for the arrow, the plan is incomplete.

See [ownership.md](ownership.md).
