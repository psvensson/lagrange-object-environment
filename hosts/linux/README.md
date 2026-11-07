# hosts/linux — native Linux Component host (ADR 0013 L1)

The existing `lagrange-host-linux` executable has two modes: `view` opens a
read-only GTK Project/inspector connected to the authorized Images read service;
its default mode retains the offscreen GLB portability proof. The viewer embeds
the ordinary Environment modules in QuickJS and runs no Node/browser subprocess.
It is a bounded integration client, not a production identity or deployment stack.

## Launch the viewer

From this directory, with GTK4/OpenSSL development libraries and the pinned Rust
toolchain available:

```sh
sensors
CARGO_BUILD_JOBS=1 nice -n 15 cargo build --locked --bin lagrange-host-linux
sensors
./target/debug/lagrange-host-linux view \
  --endpoint https://read-service.example:8443 \
  --image IMAGE_ID --project PROJECT_ID \
  --credential-file /path/to/viewer.token
```

The credential file must be a private regular file (for example mode 600), supplied
by the trusted read-service deployment. Add `--ca-file /path/to/ca.pem` for a
private CA. TLS certificate/hostname verification remains enabled. Plain HTTP is
allowed only for literal loopback. The endpoint is the application read service,
not a Lagrange inter-node listener.

Startup reads only the Project and opens an empty inspector. Click a member to
read it, then follow inspector reference buttons. `--member KEY` explicitly
requests one initial member selection. Refresh rereads the Project and current
selection. Failed refresh visibly disables stale panes until reconnection.
Close, SIGINT and SIGTERM cancel network work and drain the session; incomplete
shutdown exits with failure under an eight-second process ceiling.

The service must already be running with its runtime, installed read binding,
authentication and grants. The executable never provisions an image or infers
access from membership. Native editing, compilation, observation and production
SSO remain outside this viewer. See
[the viewer architecture](../../docs/architecture/native-cluster-viewer.md) and
[the read-service decision](../../docs/decisions/0017-authorized-read-service.md).

Real-cluster acceptance is currently blocked before image creation by the
published Lagrange package's build-provenance defect. The native viewer has
passed controlled-service tests; see [the live acceptance record](../../docs/architecture/native-cluster-acceptance.md)
before treating it as an accepted cluster client.

The default graphics mode runs the exact checked-in GLB renderer Component core
binary (`test/browser/components/glb/glb.component.wasm`) under Wasmtime with
native `wasi:webgpu`, `wasi-gfx:surface` and `lagrange:assets/provider` imports.

## What L1 proves (and what it does not)

**Proven (deterministic, CI-gated):** the unmodified Component executes and
renders a real shaded GLB mesh on a real GPU outside the browser, and the
portability contract's key invariants hold natively — artifact identity, a real
render, per-instance asset isolation, and explicit failure on a denied asset.

**Not yet proven (follow-up Bead):** an **on-screen GLB Component** surface.
L1 uses a headless offscreen `wasi-gfx:surface` realization (the native analogue
of the browser CI's `TextureRenderTarget`). The visible-window proof is a
separate, narrower surface-realization task. **Do not** treat the GTK viewer window as proof of an on-screen GLB surface.

This is a **native Component host / proof**, not a `LinuxRendererAdapter`: it
hosts one Component instance and exercises its graphics lifecycle. The six-op
`RendererAdapter` portability falsification is reserved for **L3**.

## The headline result

- **browser proof artifact hash == native proof artifact hash**
  (`same_component_hash` asserts the sha256 of the binary both hosts run).
- **native dependency graph contains:** Wasmtime, wasi-gfx (`wasi-webgpu` /
  `surface`), native host code.
- **native dependency graph does NOT contain:** jco, DOM, browser, Node.

## Layout

```
hosts/linux/
  Cargo.toml          pinned deps (see Toolchain below)
  Cargo.lock
  rust-toolchain.toml pinned Rust (wasmtime 47 needs >= 1.94)
  src/lib.rs          the host: GlbHost + offscreen surface-webgpu + readback
  src/main.rs         manual driver (prints hash + mesh stats, optional PPM dump)
  tests/
    l1_portability.rs the falsification suite (5 tests)
```

The Component binary and the GLB assets (`box.glb`, `box-big.glb`) are consumed
**read-only** from `test/browser/`; they are never copied, rebuilt, or modified.

## Run

```
CARGO_BUILD_JOBS=1 nice -n 15 cargo test --locked --test l1_portability -- --test-threads=1
CARGO_BUILD_JOBS=1 nice -n 15 xvfb-run -a cargo test --locked -- --test-threads=1
CARGO_BUILD_JOBS=1 nice -n 15 cargo run --locked -- --dump-ppm /tmp/frame.ppm   # manual, writes a frame
```

The L1 tests run headless (offscreen surface); a real GPU/Vulkan driver is used
if present, otherwise Mesa (llvmpipe/lavapipe). The L2/L3 GTK tests call
`gtk4::init()` and need a display (CI uses Xvfb, see `.github/workflows/ci.yml`).

## Toolchain / dependency pins (reproducibility)

- **Rust** pinned via `rust-toolchain.toml` (`1.98.0`, minimal). wasmtime 47
  requires rustc >= 1.94. Always let the toolchain file select the compiler
  (plain `cargo ...`, never `rustup run stable cargo ...`, which bypasses the
  pin) and pass `--locked` so Cargo.lock is never silently rewritten. Note the
  sibling `renderer-component/rust-toolchain.toml` deliberately pins a DIFFERENT
  compiler (1.89.0): it is the one that reproduces the checked-in Component
  bytes this host pins by sha256 (see `docs/renderer-component.md`).
- **wasi-gfx-runtime** pinned to an **exact git revision**
  (`772bc344d3d0e24ba2d3ee29fc0033fc6ccea81d`), NOT `main` — the
  Wasmtime/wgpu/wit-bindgen combination is tightly coupled. That revision pins
  `wasi:webgpu@0.3.0-rc.2` and `wasi-gfx:surface@0.2.0` with WIT deps
  byte-identical to `renderer-component/wit/deps`, and ships native Wasmtime
  host crates (`wasi-webgpu-wasmtime`, `surface-wasmtime`, `frame-buffer-wasmtime`).
- `Cargo.lock` is checked in.

## Architecture (headless offscreen — "Option C")

- Real `wasi:webgpu` host (`wasi_webgpu_wasmtime::add_to_linker`).
- Real `wasi-gfx:surface/surface` host (`surface_wasmtime::add_surface_to_linker`)
  with a dummy offscreen `GfxWindow` (raw window/display handles never used).
- **Custom** `wasi-gfx:surface/surface-webgpu` host (`OffscreenContext` via a
  bindgen `with` remap): hands the Component a host-owned offscreen texture
  (`RENDER_ATTACHMENT | COPY_SRC`, Bgra8unorm) created on the Component's own
  device; `present()` copies it to a readback buffer and captures BGRA bytes.
  The Component cannot tell which realization it got (same seam as the browser
  CI `TextureRenderTarget`).
- **Per-instance isolation:** one `Store` per Component instance; the
  `lagrange:assets/provider.load` allowlist is a per-instance field.

## Implementation findings (recorded in Bead hqt)

1. **A readback command buffer must actually be submitted.** `buffer_map_async`
   does NOT execute pending/unsubmitted command buffers — the all-zeros bug.
   `present()` encodes the copy, calls `queue_submit` on the Component's queue,
   then maps/polls.
2. **Queue identity is obtained through the public native host API.**
   `wasi_webgpu_wasmtime::Device.queue` is `pub(crate)`; the host captures the
   `QueueId` via the public `HostGpuDevice::queue` host method (which pushes the
   device's `Arc<QueueId>` into the ResourceTable).
3. **Wasmtime `Linker::instance()` is define-only.** You cannot shadow/intercept
   a single method inside `wasi:webgpu` without replacing (and wiping) the whole
   interface subtree — so the design must not depend on method
   shadow/interception.
