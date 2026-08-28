//! L1 portability falsification suite (Bead hqt / ADR 0013).
//!
//! Proves the EXACT browser-tested GLB renderer Component core binary runs
//! under Wasmtime with native wasi:webgpu + wasi-gfx surface + lagrange:assets
//! — no jco/JS/browser/DOM — and that the portability contract's key
//! invariants hold natively: artifact identity, a real shaded render, and
//! per-instance asset isolation.

use std::collections::HashMap;

use lagrange_host_linux::{
    box_big_glb_bytes, box_big_glb_hash, box_glb_bytes, box_glb_hash, component_hash, mesh_pixels,
    GlbHost,
};

const EXPECTED_COMPONENT_SHA256: &str =
    "c64b061cf1fcccb5a0adb80495acf2269ab572aed7758ecaa5b97e4eefea0811";
const EXPECTED_BOX_SHA256: &str =
    "d7fb78e8645325d7b3cb93dfac33ffe8873d1c094d6d0f63b268530144ace90a";
const EXPECTED_BOX_BIG_SHA256: &str =
    "8a029802ec2222ad79f152ff1107e7cc3573ec384a876046b573119cf7f3bcf0";

fn allowlist(bytes: Vec<u8>) -> HashMap<String, Vec<u8>> {
    let mut m = HashMap::new();
    m.insert("main-model".to_string(), bytes);
    m
}

/// The same predicate as test/browser/glb-proof.test.js `assertMesh`: a
/// coherent render has a band of bright, yellow-tinted mesh pixels covering
/// between 2% and 80% of the frame (NOT blank, NOT full-clear).
fn assert_mesh(frame: &[u8], width: u32, height: u32, bytes_per_row: u32, label: &str) -> usize {
    let mesh = mesh_pixels(frame, width, height, bytes_per_row);
    let total = (width * height) as usize;
    assert!(
        mesh > total / 50 && mesh < total * 4 / 5,
        "{label}: should render a shaded Box (mesh {mesh}/{total} = {:.3}, want 0.02..0.8)",
        mesh as f64 / total as f64
    );
    mesh
}

/// The native host runs the EXACT Component binary the browser tests.
#[test]
fn same_component_hash() {
    assert_eq!(
        component_hash(),
        EXPECTED_COMPONENT_SHA256,
        "artifact identity: the native host must consume the browser-tested Component"
    );
}

/// The discrimination fixtures are pinned: a regenerated box.glb / box-big.glb
/// must not silently shrink the small-vs-big mesh-pixel gap that
/// `per_instance_asset_isolation` relies on.
#[test]
fn glb_fixtures_pinned() {
    assert_eq!(box_glb_hash(), EXPECTED_BOX_SHA256, "box.glb changed");
    assert_eq!(box_big_glb_hash(), EXPECTED_BOX_BIG_SHA256, "box-big.glb changed");
}

/// The unchanged Component renders a shaded GLB mesh through the native
/// offscreen surface (real pixels read back).
#[tokio::test]
async fn renders_shaded_mesh() -> anyhow::Result<()> {
    let host = GlbHost::new();
    let run = host
        .run_instance(allowlist(box_glb_bytes()), 320, 200, 4)
        .await?;
    assert!(
        !run.captured_frames.is_empty(),
        "expected at least one presented frame (not rendering)"
    );
    let frame = &run.captured_frames[run.captured_frames.len() - 1];
    assert_eq!(frame.len(), (run.bytes_per_row * run.height) as usize);
    assert_mesh(frame, run.width, run.height, run.bytes_per_row, "GLB Box frame");
    Ok(())
}

/// TWO instances, each loading 'main-model' but with DIFFERENT durable bytes
/// (small vs big Box) in their OWN Stores: B's mesh-pixel count must exceed
/// A's by a clear margin (they resolved different bytes for the same name),
/// and A's count stays stable. The native analogue of the browser
/// two-isolated-sessions discrimination.
#[tokio::test]
async fn per_instance_asset_isolation() -> anyhow::Result<()> {
    let host = GlbHost::new();

    // Instance A (small box) first.
    let run_a1 = host
        .run_instance(allowlist(box_glb_bytes()), 320, 200, 3)
        .await?;
    let frame_a1 = &run_a1.captured_frames[run_a1.captured_frames.len() - 1];
    let mesh_a1 = assert_mesh(
        frame_a1,
        run_a1.width,
        run_a1.height,
        run_a1.bytes_per_row,
        "instance A (small box)",
    );

    // Instance B (big box), instantiated AFTER A, its OWN Store.
    let run_b = host
        .run_instance(allowlist(box_big_glb_bytes()), 320, 200, 3)
        .await?;
    let frame_b = &run_b.captured_frames[run_b.captured_frames.len() - 1];
    let mesh_b = assert_mesh(
        frame_b,
        run_b.width,
        run_b.height,
        run_b.bytes_per_row,
        "instance B (big box)",
    );

    // B resolved the BIG box: clearly more mesh pixels than A's small box.
    assert!(
        mesh_b as f64 > mesh_a1 as f64 * 1.3,
        "instance B should render the big box (mesh B {mesh_b} vs A {mesh_a1}, want B > 1.3*A)"
    );

    // A STILL renders the small box after B existed (no shared/clobbered
    // provider): a fresh A run matches A's first count closely.
    let run_a2 = host
        .run_instance(allowlist(box_glb_bytes()), 320, 200, 3)
        .await?;
    let frame_a2 = &run_a2.captured_frames[run_a2.captured_frames.len() - 1];
    let mesh_a2 = mesh_pixels(frame_a2, run_a2.width, run_a2.height, run_a2.bytes_per_row);
    assert!(
        (mesh_a2 as f64 - mesh_a1 as f64).abs() <= mesh_a1 as f64 * 0.2,
        "instance A's render must be stable across runs (A1 {mesh_a1} vs A2 {mesh_a2})"
    );
    Ok(())
}

/// An instance whose allowlist does NOT contain 'main-model': `load` returns
/// Err and the Component fails (its start traps) rather than rendering.
#[tokio::test]
async fn denied_asset_errors() {
    let host = GlbHost::new();
    let result = host.run_instance(HashMap::new(), 320, 200, 3).await;
    let err = match result {
        Ok(_) => panic!("a missing asset must not render; the run should surface the error"),
        Err(e) => e,
    };
    let msg = format!("{err:#}").to_lowercase();
    assert!(
        msg.contains("not in allowlist") || msg.contains("main-model") || msg.contains("trap"),
        "the surfaced error should identify the denied asset load, got: {err:#}"
    );
}
