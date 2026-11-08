# Isolated native viewer deployment

This development deployment is currently blocked by the published Lagrange
startup defect described in [the acceptance record](../../docs/architecture/native-cluster-acceptance.md).
It is not a working-cluster or production identity claim.

The service installs a new isolated demonstration graph. Its operator can read
the Project, `root`, and `target`; Project membership does not grant access to
`denied`. Credentials and authority remain in the service/native transport.

To reproduce the acceptance, install the locked package with `npm ci` in this
directory, compile `hosts/linux/tests/native_cluster.rs` with Cargo's `--no-run`,
and run from the repository root under a display:

```sh
xvfb-run -a node test/native-cluster/run.js \
  /absolute/path/to/compiled/native_cluster-test \
  /absolute/path/to/clean/lagrange-images-checkout
```

The Images checkout must be at `caf72f26d6a28a6901aea876a49d22311e29cf21`.
The CI workflow shows the exact build command and executable discovery. Follow
`AGENTS.md`'s temperature, one-job, one-test-thread and serial execution rules for
local builds/tests. The harness creates private credentials and retains a local
evidence directory. Never upload its credential or configuration files.

For an existing authorized read-service endpoint, the native executable's launch
command is documented in [the Linux host README](../../hosts/linux/README.md).
The deployment module can be passed to the standalone read-service CLI with
`OE_CLUSTER_CONFIG` naming a trusted JSON configuration. That configuration
provides `credentialFile` (a mode-600 file containing 64 random hex characters),
`imagesRuntime` (the pinned public `src/runtime.js` URL), an unused `dataDir`,
three distinct nonzero `restPort`, `adminPort`, and `transportPort`, and a `nonce`
used only in the demonstration labels. This provisions a new graph and is not a
general attachment or migration command for an existing production image.

## Three-node native demo

The launcher is available on this development branch as `npm run demo:native`.
**Real-cluster acceptance is still blocked by the published 0.4.0 startup defect
above.** Mechanical subprocess proofs exercise the production launcher/protocol
with fixture providers. They do not establish a working Lagrange deployment.

Once the published dependency is repaired and admitted, the entry command is:

```sh
npm ci --prefix examples/native-cluster
npm run demo:native -- \
  --images-checkout /absolute/path/to/clean/pinned/lagrange-images \
  --native-binary /absolute/path/to/lagrange-host-linux
```

Use the exact Images revision stated above and the compiled native executable
from this branch, plus `/usr/bin/python3` with its standard library and Linux
subreaper/parent-death support. The supervisor runs with `-I -S`; a bounded
capability check occurs before run-directory allocation. Build instructions are in the Linux host README. The launcher
never installs packages, compiles code, substitutes a source checkout for the
published package, or falls back to mock/single-node storage. `--help` requires
no dependencies or data allocation. `--data-parent PATH` optionally selects an
existing parent directory; each invocation creates a new private child beneath
it. Existing data is never removed or overwritten.

The command starts three separate node processes, each with a small supervisor,
with distinct UUIDs, nine listener
ports and three data directories. It waits for those exact three nodes to be
active, then installs the demonstration graph once through the seed. Active
membership is not proof that application writes work: a schema/write refusal
stops the run and is retained without retry. Startup has one 160-second budget,
including the native client's `native-viewer-ready` event after its window maps.
The interactive session has no lifetime timeout.

The first tour shows current remote features: open the Project, inspect `root`,
follow its reference to `target`, try the restricted reference, and Refresh.
Remote editing, method replacement, live observation, Theme rendering and classic
Smalltalk source glyphs have separate contracts and work items.

Closing the client window, Ctrl-C, SIGTERM or a node failure stops the owned
process groups. A supervisor retains the payload and adopted descendants until
all have been reaped, including descendants that closed their output pipes.
Graceful closure gets 12 seconds before SIGKILL; escalation or an abnormal
descendant exit is a reported cleanup failure. Group signals originate inside
the supervised group. Unexpected supervisor loss is incomplete custody; the
parent never guesses ownership from a numeric group ID. Processes that escape
the group are outside the termination guarantee. A final parent shutdown ceiling is 15 seconds. The
launcher retains data, provenance and bounded private process logs in the printed
run directory and removes its credential file on completed cleanup. Ordinary
logs retain a 4 MiB prefix with an explicit truncation marker. Separate private
`.diagnostics` files retain the first bounded record for each of initialization,
operation, protocol and cleanup (at most 64 KiB), independently of stdout/stderr
volume or framing. Failed forced
shutdown can leave private credentials there: do not publish the run directory.

Node environment values come from the generated topology. Ambient cluster and
Node loader/test settings are excluded; joiners get the launcher's explicit
`SEED_NODE_ADDRESS`, because the pinned embedded entry uses it to select joining.
The pinned bootstrap REST listener binds all interfaces; local advertised
addresses and WebSocket settings do not establish loopback-only binding for all
Lagrange listeners. The application read service has its separate loopback HTTP
policy.

Images attaches through the public `LagrangeBackend({runtime})` constructor.
Its closure also stops that runtime. The worker retains the raw handle through
acquisition failures and sequences service closure, Images deployment closure,
and idempotent raw stop. A forwarding port observes delegated stop failures
without replacing original values, promises or errors. Bounded diagnostics keep
constituent cleanup failures even if an acquisition provider suppresses them and
a subsequent stop succeeds. No lifecycle observer changes runtime policy.

Bead `owj` depends on the native viewer's published-artifact acceptance (`8dh`).
The actual three-node native proof, full required checks and exact-head CI remain
required before merge or completion.
