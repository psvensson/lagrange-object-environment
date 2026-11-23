# Isolated native viewer deployment

**Current status:** the source-development path is implemented and awaits
exact-head live acceptance. No successful source cluster run is claimed yet.
The separately retained published-package proof remains blocked before image
creation by the historical Lagrange startup defect.

The deployment installs a fresh demonstration graph through public Images APIs.
Its operator can read the Project, `root`, and `target`; the `denied` member
retains its independent authorization check. Credentials and authority remain in
the service and native transport.

## Runtime choices

The launcher admits one explicit identity pair, defined by
[`runtime-selection.js`](runtime-selection.js):

| Choice | Lagrange identity | Images checkout |
| --- | --- | --- |
| `--lagrange-checkout PATH --host-id NAME` | Source commit `234f478e034b738328c63900e74b6bea3ee63bb8` | `dc4266c664002e69ad5ca0b67dd0b7f094c8d8e7` |
| No source option | Locked `lagrange-server@0.4.0`, package gitHead `07206ba1c8bb396f4eb097a753915bb34580d824` | `caf72f26d6a28a6901aea876a49d22311e29cf21` |

Source selection never resolves the installed package. A missing or invalid
selection fails; it does not switch to the other choice or to mock storage.
Both Lagrange manifests say `0.4.0`, so the receipt's tagged selection and full
revision distinguish them.

Source admission requires the repository root, exact HEAD, a clean index and
working tree, no added runtime source files, the tracked lockfile, and the
declared public `src/public-api.js` entry. Ignored additions beneath runtime
source paths are also refused. Installed root `node_modules` is permitted.
Install dependencies before launching; the launcher performs no installation or
compilation. Later module-import/dependency errors remain failures under the
worker's process owner.

## Run the source-development demo

Prepare clean checkouts at the source and Images revisions above. Install
Lagrange's locked dependencies and build the native executable before starting
the cohort. Follow `AGENTS.md`'s temperature and serial-execution rules for
local installation, builds and tests; the configured CI lane supplies the
complete remote verification.

From the Object Environment repository root:

```sh
npm ci --prefix /absolute/path/to/lagrange-source --no-audit --no-fund
npm run demo:native -- \
  --lagrange-checkout /absolute/path/to/lagrange-source \
  --host-id "$(hostname)" \
  --images-checkout /absolute/path/to/lagrange-images \
  --native-binary /absolute/path/to/lagrange-host-linux
```

Use the actual machine name as `--host-id`. This launcher places all three
processes on that one host, with the same host identity, distinct node UUIDs,
nine listener ports and separate fresh data directories. Only the seed declares
`formation.declaredHostCount: 1`. The configured message-group and partition
replication counts remain three. This topology does not establish an achieved
three-voter target, three-host spread or host-failure tolerance.

The native executable needs a display. Build instructions are in
[the Linux host README](../../hosts/linux/README.md). The launcher also requires
`/usr/bin/python3` with its standard library and Linux subreaper/parent-death
support. Its supervisor runs with `-I -S`; the bounded capability check precedes
run-directory allocation. `--help` requires no dependencies or data allocation.
`--data-parent PATH` optionally selects an existing parent directory; every run
creates a private child without replacing existing data.

Startup waits for the three expected active node identities and observes the
seed's public `/readyz` verdict, because the seed's application handle installs
and serves this graph. Worker liveness remains required throughout. Only
HTTP 200 with `ready: true` permits the next stage; HTTP 503 with
`ready: false` permits another bounded read-only probe. No lower readiness
state is reconstructed from membership or private control-plane rows.

The seed installs the real Images schema and demonstration graph once.
Any refusal, including `FORMATION_PENDING` after a ready probe, fails the run
without retrying the write. The original 160-second startup budget includes
the actual native client's `native-viewer-ready` event after its window maps.
The interactive session itself has no lifetime timeout.

The first tour opens the Project, inspects `root`, follows its reference to
`target`, exercises the restricted reference and Refresh. Remote editing,
method replacement, live observation and Theme composition retain their
separate contracts.

## Real source acceptance

The automatic [Native source development workflow](../../.github/workflows/native-source.yml)
runs on pull requests and pushes to `main`. It checks out the exact source pair,
proves the published package is absent, and compiles both native artifacts before
starting any runtime. Its entry point takes the compiled action test first:

```sh
xvfb-run -a -s "-screen 0 1280x1024x24" node test/native-cluster/run-source.js \
  /absolute/path/to/compiled/native_cluster-test \
  --lagrange-checkout /absolute/path/to/lagrange-source \
  --host-id "$(hostname)" \
  --images-checkout /absolute/path/to/lagrange-images \
  --native-binary /absolute/path/to/lagrange-host-linux
```

The harness calls the same launcher and cohort as the interactive demo. It
requires the actual CLI window, then runs the existing Rust GTK navigation,
denial and revocation proof against the same service. Private seed controls
obtain independent full before/after graph and history snapshots; their equality
must hold after the read-only journey. These controls exist only on the parent's
private IPC channel after installation.

The complete acceptance is bounded to 500 seconds, with semantic work cancelled
by 485 seconds to retain 15 seconds for cleanup. The startup budget stays
160 seconds. A later source recheck, child-closure failure or credential-cleanup
failure prevents the acceptance event. Mechanical tests and a mapped fixture
window do not establish this live result.

## Process and evidence lifetime

Closing the interactive window, Ctrl-C, SIGTERM or a node failure stops the
owned process groups. Each demo supervisor retains its payload and adopted
descendants through reaping. Its 12-second graceful-closure allowance precedes
forced termination; escalation or an abnormal descendant exit is a cleanup
failure. Parent death initiates the same bounded drain. Unexpected supervisor
loss is incomplete custody; the parent does not infer ownership from a numeric
group ID. Processes escaping the supervised group remain outside that guarantee.
The Rust action test has its existing separate direct-child acceptance owner.

Workers close the read service, the public Images deployment and their retained
raw runtime handle. The public `LagrangeBackend({runtime})` constructor retains
its existing start/stop policy. A forwarding observer preserves delegated stop
failures even when a later idempotent stop succeeds.

Node environment values come from the generated topology. Ambient cluster and
Node loader/test settings are excluded; source nodes receive the shared
`NODE_HOST_ID`, and joiners receive the explicit seed address. The pinned
bootstrap REST listener binds all interfaces; local advertised addresses do not
establish loopback-only binding for every Lagrange listener. The application
read service has its separate loopback HTTP policy.

The printed private run directory retains data, provenance and bounded logs.
Normal cleanup removes its credential. Ordinary logs retain a 4 MiB prefix;
separate bounded diagnostic records preserve initialization, operation, protocol
and cleanup failures. Full snapshots use two exclusive mode-600 files capped at
1 MiB each, with sequence/length/hash/provenance receipts within the existing
16 KiB IPC reply bound.

CI evidence export is opt-in through `OE_SOURCE_EVIDENCE_DIR` and uses a narrow
allowlist: sanitized `manifest.json`, `diagnostics.json`, `receipts.json`, and
the two generated-graph snapshots only after independent validation. Credentials,
worker configuration, raw logs and the entire private run directory are excluded.
See [the acceptance contract](../../docs/architecture/native-cluster-acceptance.md)
for proof limits and the historical failure.

## Published-package proof

The [Published package acceptance workflow](../../.github/workflows/native-cluster.yml)
is explicitly manual (`workflow_dispatch`). It retains the original locked
package, Images `caf72f2` checkout, one-runtime harness and real failure result:

```sh
npm ci --prefix examples/native-cluster
xvfb-run -a node test/native-cluster/run.js \
  /absolute/path/to/compiled/native_cluster-test \
  /absolute/path/to/clean/lagrange-images-at-caf72f2
```

This proof remains blocked at the recorded package startup defect. Bead `llh`
remains open. Source-development success cannot satisfy it, and this manual
workflow is not an automatic release interlock. The package needs its own
reviewed repair, publication and installed-startup acceptance.

For an existing authorized endpoint, use the Linux executable's documented
`view` command. The standalone development service accepts `OE_CLUSTER_CONFIG`
with a private `credentialFile`, the pinned public Images `imagesRuntime` URL,
unused `dataDir`, distinct `restPort`/`adminPort`/`transportPort`, and a label
`nonce`. Its default selection remains the published package. It provisions a
new graph; it is not an attachment or migration command for an existing image.
