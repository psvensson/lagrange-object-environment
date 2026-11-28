# Native cluster acceptance

**Current status:** the source-development trial selects main snapshot
`ab347e9`, resolved on 2026-11-28, and awaits exact-head live acceptance.
No successful source cluster navigation, authorization or unchanged-history
result is claimed yet. The historical
published-package lane remains blocked before image creation; Bead `llh`
remains open. Controlled-service and mechanical process proofs do not substitute
for either live result.

## Two explicit acceptance contracts

| Lane | Trigger | Exact runtime identity | Images |
| --- | --- | --- | --- |
| `Native source development / native-source-development` | Pull requests and pushes to `main` | Source `ab347e9625a64ed24b7700b8f958bd54d8e3db06`, manifest version `0.4.2` | `dc4266c664002e69ad5ca0b67dd0b7f094c8d8e7` |
| `Published package acceptance (manual) / published-native-cluster` | Explicit `workflow_dispatch` | Locked `lagrange-server@0.4.0`, gitHead `07206ba1c8bb396f4eb097a753915bb34580d824` | `caf72f26d6a28a6901aea876a49d22311e29cf21` |

This is a deliberate development-acceptance contract. The manual package proof
retains its failure and does not act as an automatic release interlock. Source
success neither repairs the installed package nor proves its acceptance.
The ordinary artifact-only Linux job remains separate; its ignored real-cluster
test is not evidence that the live journey ran.

The current native portable artifact and automatic JS/source-development
consumers agree on Images `dc4266c`. The manual historical package lane keeps
its own `caf72f2` identity. Manifest admission checks each selected version
independently: source `0.4.2` and published package `0.4.0`. Tagged runtime
selection, exact revision and Images pairing remain required in both lanes.

## Source admission and topology

[`runtime-selection.js`](../../examples/native-cluster/runtime-selection.js)
owns the two identities and resolves one public entry. The explicit
`--lagrange-checkout PATH --host-id NAME` choice requires the exact repository
root/HEAD, a clean index and working tree, no untracked runtime source including
ignored source additions, the tracked lock and the declared public entry.
Installed root dependencies are permitted. Source mode does not resolve the
published package; failures do not select an alternative backend.

The current trial fixes the main revision resolved on 2026-11-28 to the exact
source identity above. Its manifest still says `0.4.2`, so the version alone
does not distinguish it from the previously tested release `657b7e3`. The
public embedding, host/formation configuration and readiness contract remain
compatible with the existing harness. Upstream changes do not establish a live
Object Environment result; this fresh-directory proof still requires its own
exact-source execution and does not cover retained restart.

The local declaration is one actual host, three processes and configured
replication count three. Every node uses the same explicit host identity.
Only the seed declares `formation.declaredHostCount: 1`. Distinct process UUIDs
do not create physical failure domains. This proof does not establish an
achieved three-voter target, three-host RF3 or host-failure tolerance.

## One runtime and acceptance interaction

The [shared launch session](../../examples/native-cluster/launch.js) owns
prerequisite admission, private run/credential/configuration allocation, nine
listener reservations, topology and worker factories.
[`runDemoCohort`](../../examples/native-cluster/demo-cohort.js) owns the single
startup/use/teardown sequence. The interactive command and
[`run-source.js`](../../test/native-cluster/run-source.js) both use it; the
acceptance runner adds no second node startup loop.

Workers start sequentially. The cohort requires exactly the expected three
active node IDs and retains all worker liveness checks. It then reads only the
seed's public `/readyz`, because that node's application handle installs and
serves the graph. The
[pinned public probe contract](https://github.com/psvensson/lagrange/blob/ab347e9625a64ed24b7700b8f958bd54d8e3db06/docs/bootstrap-readiness-probes.md)
owns readiness. OE does not infer it from membership, leases or private
publication rows.

Each probe covers headers and body under at most five seconds and a 64 KiB body
bound, within the original remaining startup time. HTTP 200 with `ready: true`
permits the next stage. HTTP 503 with `ready: false` permits another read-only
probe. Redirects, contradictory values, malformed or oversized bodies, held
responses and transport failures fail the run. Joiner serving probes are not
additional prerequisites for the seed-only application path.

[`deployment.js`](../../examples/native-cluster/deployment.js) owns the
development operator identity, constant-time authentication, real runtime-issued
grants and isolated Project graph. It uses public Images APIs and the admitted
Lagrange public entry; the cohort attaches its already-started runtime through
`LagrangeBackend({runtime})`. Backend kind/durability and tagged provenance are
checked. The seed installs the schema and graph once. An application refusal,
including `FORMATION_PENDING` after public readiness, remains a failure without
write retry.

The native acceptance adapter uses the cohort's existing native-owner seam:

1. Obtain and validate the independent baseline snapshot; verify missing
   authentication receives 401.
2. Start the actual `lagrange-host-linux view` executable through the demo
   guardian and require its mapped-window ready event.
3. Close the CLI cleanly, then run the existing Rust GTK action test through its
   existing direct-child acceptance owner.
4. Exercise Project/member/reference navigation and denial; revoke the real
   service authority through private seed IPC and verify the native refusal.
5. Read a second full snapshot independently through public Images and compare
   records and history against the baseline.
6. Close all owned resources, re-admit the selected checkouts and delete the
   credential before emitting source acceptance.

The adapter retains every child before awaiting it, closes acquired delegates
before awaiting journey unwind, and prevents acquisitions after cancellation.
Semantic and cleanup failures remain failures. The native desktop itself starts
no Node process and owns no runtime/bootstrap or grant policy.

## Bounds, evidence and proof limits

| Boundary | Bound |
| --- | --- |
| Cohort startup through the actual mapped CLI | One 160-second deadline |
| CLI mapped-window wait | At most 20 seconds within that startup deadline |
| GTK actions to revocation request | At most 80 seconds |
| Private revocation acknowledgement | At most 5 seconds |
| Remaining action/exit proof | At most 40 seconds |
| Independent after-snapshot | At most 30 seconds |
| Full source acceptance, including cleanup | 500 seconds; semantic cancellation by 485 seconds |
| Demo process closure | Existing 12-second guardian allowance and 15-second parent ceiling |

Every stage is capped by the remaining overall budget. A later run must not
increase a bound or reinterpret timeout as readiness to obtain acceptance.
The interactive demo has the same startup bound and no interactive lifetime
timeout.

Private snapshot/revoke commands are seed-only and available only after graph
installation. The deployment remains the content/authority owner. The evidence
delegate writes two exclusive private files capped at 1 MiB each and returns
small sequence/byte-length/SHA-256/provenance receipts. The reader independently
validates the file and receipt before use. The IPC reply cap stays 16 KiB.
Snapshot truncation, substituted history, duplicate sequence, invalid receipt
or failed closure cannot pass the proof.

`OE_SOURCE_EVIDENCE_DIR` enables a separate allowlisted CI export: sanitized
`manifest.json` and `diagnostics.json`, validated `receipts.json`, and
`snapshot-1.json`/`snapshot-2.json` only when the independent size, hash,
sequence and provenance checks succeed. Snapshots contain the generated
demonstration graph/history. Credentials, configuration, raw process logs and
the private run directory are excluded. A failure export records the admitted
identity, topology, stages and bounded failure information without inventing a
successful later phase. The cohort also retains one bounded startup observation:
membership-attempt count and latest validated rows, plus readiness-attempt count
and latest validated boolean. Each result carries its membership round and
elapsed time. A missing result remains `null`; a readiness result from an older
round does not describe later membership. This is diagnostic evidence only and
does not change the startup decision or add a polling history to the phase list.

Completion requires the exact-head automatic source job, ordinary required
Node/browser/native checks and independent actual-diff review. Passing
mechanical tests or reaching a native fixture window does not establish a
working source cluster. No successful source acceptance receipt has been
recorded for this implementation yet.

### First source attempt: 2026-11-23

[PR #111](https://github.com/psvensson/lagrange-object-environment/pull/111)
head `03109abdc2171a74144dda17e20b4b3cec207598`, source tree
`2e18e340c54b3a3be7085e14e6ede505e6cec4d7`, was tested with Lagrange source
`234f478e034b738328c63900e74b6bea3ee63bb8` and Images
`dc4266c664002e69ad5ca0b67dd0b7f094c8d8e7`.
[Ordinary CI 45210538312](https://github.com/psvensson/lagrange-object-environment/actions/runs/45210538312)
passed 636 Node tests, 18 browser tests, and the full configured native suite.

That original source selection was informed by cold GCP formation evidence in
the upstream
[operation-integrity record](https://github.com/psvensson/lagrange/blob/09e4e64ea12e073eb369c48bd3e017615648f26c/solve/epics/operation-integrity-and-reliable-formation.md).
It was upstream context, not an Object Environment acceptance result; its
recorded retained-restart failure was outside this fresh-directory proof.

[Source run 45210538192](https://github.com/psvensson/lagrange-object-environment/actions/runs/45210538192)
completed all three worker start commands by 19.101 seconds, then remained in
the combined membership/seed-readiness wait. The original startup deadline
stopped it at 160.388 seconds; bounded cleanup and failure export finished by
160.779 seconds. Image installation and native launch were not reached.

Artifact `14836242476`, SHA-256
`c60ee82c032a2003f34d6595097254541bf257881b3ed22d819f0352ab7765dc`,
contains the failed manifest, empty worker-failure diagnostics, and empty
snapshot receipts. It predates the bounded startup-observation correction:
it cannot establish whether exact membership ever completed or `/readyz` was
called. The timeout alone does not classify the cause as a Lagrange serving
defect. No deadline, replication setting, or acceptance requirement was relaxed
in response.

### Released-source comparison: 2026-11-26

[PR #112](https://github.com/psvensson/lagrange-object-environment/pull/112)
head `94640bff6167bb310331321661ce2be49bda4798` tested released source
`657b7e396aabf75501e6f2156638514d85f24f6c`, manifest version `0.4.2`, with
Images `dc4266c664002e69ad5ca0b67dd0b7f094c8d8e7` through the same source
harness. [Source run 45773416437](https://github.com/psvensson/lagrange-object-environment/actions/runs/45773416437)
observed the three expected active members and made 577 readiness attempts.
The last seed result was `ready: false` at 159897 ms; the original 160-second
startup deadline ended the trial before graph installation or native launch.
The retained receipt and artifact digest are recorded in that PR. This failed
release trial does not determine the current `ab347e9` trial's outcome.

PR #112 also records its separate installed `0.4.2` package failure at
`runtime-start`. This source-only trial retains the historical `0.4.0` package
selection in the table above; it does not repeat or relabel the package trial.

## Preserved published-package method

`test/native-cluster/run.js` retains the original separately owned single
service/runtime and native-process journey. Its parent reserves three listener
ports simultaneously and passes `node.restApiPort`, `admin.websocketPort`,
and `node.wsPort`; collision fails. The earlier plan's `cli.ws.port` was a
logical configuration key, not the accepted object shape, and was corrected
before storage work.

The original service setup remains bounded to 160 seconds and the proof to
500 seconds. The intended proof uses the real CLI and the same production
`Viewer` action test, independent Images oracle and unchanged-history check.
Controlled transport tests separately cover unreachable endpoints and closing
during a held read. The package workflow still reports a real failure until the
published dependency is repaired.

## First semantic failure: published package, 2026-11-07

On 2026-11-07, the corrected setup failed at `runtime-start` with
`ORIGINAL_ALLOCATION_HOLD / original-allocation-observation-unavailable`, before
`image-create`, `graph-install`, `binding-install`, or any viewer launch.
Lagrange's `initializeOriginalSeedAttempt` requires measured build provenance.
The installed package's `runtimeBuildProvenance` reports `unavailable` because
`measureRuntimeContent` tries to open the installed package's own
`package-lock.json`, which the published tarball does not contain.

Evidence from the local run is `/tmp/oe-native-n3-real-02.log`, with bootstrap
record `/tmp/oe-native-cluster-Il3VY0/bootstrap.json`. A separate read-only
diagnostic of that owner returned the exact missing-file reason in
`/tmp/oe-native-n3-provenance-diagnostic.log`. It is diagnosis, not a successful
cluster run. The package integrity is pinned in the deployment lockfile. No
credential/config file should be published with these logs.

The [preserved first-failure logs](../evidence/native-cluster-2026-11-07/manifest.json)
include their SHA-256 hashes and proof limits. The attempt preceded the final
harness cleanup corrections; it is not final-head acceptance.

The historical investigation identified lower-repository candidate
`cc15416c2fdf743eb4861f7da06e045749ed0731`, branch
`work/published-package-runtime-provenance`, with Quest
`published-package-runtime-build-provenance`, describing the same failure in
0.2.7/0.2.8. That was an owner lead, not accepted repair evidence; it was not
applied to this consumer. The package observed by that investigation was 0.4.0.

Bead `llh` still requires an independently reviewed and published Lagrange
repair with installed-package startup proof. Then update the explicit package
pin under review and rerun this manual acceptance with the same bounds.
Later package-lane image creation/navigation stages remain unproven. Do not
synthesize a consumer lockfile inside `node_modules`, relax measured-build
admission, attribute a source result to the package, increase deadlines or
substitute mock storage.
