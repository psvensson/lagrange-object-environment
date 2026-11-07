# Real YAXO source input for E4

`manifest.json` is the exact `cuis-semantic-export-v2` text emitted by the pinned
Cuis toolchain through Images' public API. It contains the real package's 24
classes and 341 methods. It is source material, not an application object
snapshot. The test imports the nine-class, 70-method M4 scope and executes the
unchanged native tokenizer and parser to create its application graph afresh.

`provenance.json` identifies the Images revision, upstream Cuis commit, package
and image blobs, every input's SHA-256, VM executable and archive, output bytes,
and scope. `scope.json` copies only the scope data from the named Images M4
proof. `LICENSE` retains the upstream Cuis MIT notice.

To reproduce, obtain the inputs with the pinned Images revision's
`scripts/integration-setup.sh`, then from this repository run:

```sh
LAGRANGE_IMAGES_REPO=/path/to/lagrange-images \
LAGRANGE_CUIS_ASSETS=/path/to/lagrange-images/.integration \
nice -n 15 node scripts/export-yaxo-fixture.mjs --check
```

The generator archives the exact Images commit into its own temporary directory;
it never changes that checkout. Every input is verified before export. Without
`--check` it writes the export and its output identity; with `--check` it requires
byte-for-byte reproduction. The original export and a separate check both
produced 127,725 bytes, SHA-256
`9ff25bbdcf147c710bf6732945b26154a10db9f7f4d9c0bd6a31ac5ccc12f643`.
Follow the repository's temperature and serial execution rules for this build.

CI consumes these verified source bytes and executes the native parser in Node,
with no Cuis provider in the application runtime. DOM and GTK separately prove
generic inspector action routing. This fixture does not establish native-host
YAXO execution, E5 state editing, E6 restart, or an Environment import UI.

The test uses the pinned M4 SQL shim with public Images LagrangeBackend over an
in-memory Node SQLite database. Use Node 22.13+ on the 22.x line, or 23.4+.
This is test infrastructure, with no restart or persistence acceptance claim.
