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
