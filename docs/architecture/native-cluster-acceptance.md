# Native cluster acceptance

Current status: **blocked before image creation**. Bead `8dh` depends on `llh`. The native
transport and GTK viewer have passed their controlled-service proofs; no real
cluster navigation, authorization or unchanged-history result is claimed yet.

The dedicated `Native cluster / native-cluster` CI job installs the locked
published `lagrange-server@0.4.0` package (source
`07206ba1c8bb396f4eb097a753915bb34580d824`) and checks out Images
`caf72f26d6a28a6901aea876a49d22311e29cf21`. This is separate from the existing
artifact-only Linux host job. The live gate must pass before the viewer PR can
merge; an ignored Rust test in the ordinary artifact suite is not acceptance.

`examples/native-cluster/deployment.js` owns a development-only operator identity,
constant-time authentication and actual runtime-issued grants. It installs an
isolated Project with readable and denied members through public Images APIs.
It selects `mode: 'lagrange'` explicitly, resolves the public package entry, and
checks backend kind/durability. The deployment reports an expected Images pin;
the harness verifies the configured checkout's HEAD and tracked bytes before
launch. The standalone example does not certify an arbitrary supplied runtime
URL. It contains no mock fallback or readiness retry.
It is a separate service process; the native desktop launches no Node process.

The parent process reserves three ports simultaneously, releases them together,
and passes `node.restApiPort`, `admin.websocketPort`, and `node.wsPort`. A port
collision fails. The earlier plan's `cli.ws.port` was a logical configuration
key, not the accepted configuration object shape; the first attempt exposed and
corrected this error before any storage operation.

`test/native-cluster/run.js` owns the service/native process lifetimes and private
IPC controls. Setup is bounded to 160 seconds and the whole process to 500
seconds. The intended proof launches the existing binary and requires both a
successful Project read and a mapped window. The Rust action test uses the exact
production `Viewer`, compares GTK values with independent public Images reads,
checks denied targets and real revocation, then independently rereads records and
history to reject navigation writes. Controlled transport tests separately cover
unreachable endpoints and closing during a held read.

## First semantic failure

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

The lower repository already contains an unmerged historical candidate
`cc15416c2fdf743eb4861f7da06e045749ed0731`, branch
`work/published-package-runtime-provenance`, with Quest
`published-package-runtime-build-provenance`. It describes the same failure in
0.2.7/0.2.8. That candidate is a lead for its owner, not accepted repair evidence;
it has not been applied to this consumer or edited by this task. The published
latest version remained 0.4.0 when checked.

The next dependency is an independently reviewed and published Lagrange repair
with installed-package startup proof. Then update the explicit package pin under
review and rerun this acceptance with the same bounds. Later image creation and
navigation stages remain unrun; fixing this first blocker alone does not prove
they will succeed. Do not add a consumer lockfile inside
`node_modules`, relax the measured-build requirement, switch to a source checkout
and claim package acceptance, increase deadlines, or silently use mock storage.
