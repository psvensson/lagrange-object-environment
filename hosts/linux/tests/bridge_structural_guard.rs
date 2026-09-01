//! 64j STRUCTURAL GUARD: the throwaway Node<->Rust bridge must NOT become a
//! production dependency. The bridge (hosts/linux/src/bridge/) is the ONLY place
//! a Node subprocess may be spawned; the rest of hosts/linux/src (the REAL
//! production adapter: linux_adapter, semantic_gtk, projector, semantic_ui, lib,
//! main) must have NO Node/subprocess dependency. When 3zb embeds the JS core
//! in-process, the bridge is DELETED and this guard becomes trivially true.
//!
//! This is a SOURCE-TEXT guard (no subprocess is spawned here): it scans the
//! production .rs files and fails if any references a process spawn, a Node
//! invocation, a child stdio pipe, or the worker path. It is the no-widening
//! falsification for the "easy to delete / not a public API / no production Node
//! dependency" fence (user-mandated for the 64j-A bridge spike).

use std::fs;
use std::path::{Path, PathBuf};

/// The production source files (NOT the throwaway bridge/). If a new production
/// module is added to hosts/linux/src, add it here — the guard must cover it.
const PRODUCTION_FILES: &[&str] = &[
    "lib.rs",
    "main.rs",
    "linux_adapter.rs",
    "projector.rs",
    "semantic_gtk.rs",
    "semantic_ui.rs",
    // 3zb-A embedded-JS-runtime host port. The highest-drift-risk module for a
    // Node/subprocess/bridge reference, so it MUST be under this guard (the
    // adversarial plan review's mandatory fix). It must never reference Node,
    // a subprocess, the throwaway worker, or lagrange-images.
    "js_env/mod.rs",
    "js_env/actor.rs",
    "js_env/renderer_port.rs",
    // 3zb-A slice-3B TEST Images capability (scripted outcomes, NO substrate
    // semantics). Same drift risk: it must never reference Node/subprocess/the
    // throwaway worker, and — being the stand-in for the port — must NOT become
    // a shadow lagrange-images (no real substrate import).
    "js_env/images_capability.rs",
];

/// Needles that would indicate a Node/subprocess dependency leaking into
/// production code. These target a process spawn / the Node RUNTIME invocation /
/// the throwaway worker path — NOT the bare word "node" (SemanticUi has a
/// `Node` type and `match node {` arms, which are not a runtime dependency).
const FORBIDDEN_NEEDLES: &[&str] = &[
    "std::process",
    "process::Command",
    "Command::new",
    // A process spawn. The dedicated JS-owner OS thread uses
    // `std::thread::Builder::spawn`, which is a THREAD, not a subprocess — so we
    // target Command/child process spawns, not any `.spawn(`. (`.spawn(` alone
    // would false-positive the legitimate owner-thread spawn in js_env/actor.rs.)
    ".spawn(\"node\"",
    "Command::new(\"node\")",
    ".stdout(Stdio",
    ".stdin(Stdio",
    ".stderr(Stdio",
    "\"node\"",          // invoking the node runtime by name
    "node_modules",
    "bridge-worker",    // the throwaway worker path
    "acceptance-worker",
    "loopback-worker",
    "LAGRANGE_IMAGES_URL",
    // A real lagrange-images SUBSTRATE import in production Rust (the crate is
    // `lagrange_images`, underscore). The js_env TEST capability must NOT become
    // a shadow Images — it must never reference the real substrate crate. The
    // bare word "lagrange-images" (hyphen) appears in legitimate doc comments, so
    // we target the underscore crate identifier only.
    "lagrange_images",
];

fn src_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

#[test]
fn production_src_has_no_node_or_subprocess_dependency() {
    let dir = src_dir();
    let mut violations = Vec::new();
    for file in PRODUCTION_FILES {
        let path = dir.join(file);
        let text = fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("structural guard: cannot read {}: {e}", path.display()));
        for (line_no, line) in text.lines().enumerate() {
            for needle in FORBIDDEN_NEEDLES {
                if line.contains(needle) {
                    violations.push(format!("{}:{}: forbidden {:?}: {}", file, line_no + 1, needle, line.trim()));
                }
            }
        }
    }
    assert!(
        violations.is_empty(),
        "64j STRUCTURAL GUARD VIOLATED: production hosts/linux/src acquired a Node/subprocess dependency \
         outside the throwaway bridge/. The bridge must stay deletable; production code must not spawn Node.\n{}",
        violations.join("\n")
    );
}

/// Non-vacuity: the guard's needle-scan actually catches a Node/subprocess
/// reference. Run the SAME detection logic over a synthetic forbidden line and
/// assert it flags; if a future edit weakens FORBIDDEN_NEEDLES or the scan, this
/// goes RED (the guard cannot be vacuously green).
#[test]
fn guard_detection_is_not_vacuous() {
    let forbidden_examples = [
        "let child = std::process::Command::new(\"node\").spawn();",
        "let mut cmd = process::Command::new(\"sh\");",
        "// loads hosts/linux/tests/bridge-worker/acceptance-worker.mjs",
        "let url = env!(\"LAGRANGE_IMAGES_URL\");",
    ];
    for line in forbidden_examples {
        let hit = FORBIDDEN_NEEDLES.iter().any(|needle| line.contains(needle));
        assert!(hit, "guard FAILED to flag a forbidden line: {line:?}");
    }
    // And the inverse: benign lines must NOT be flagged — a SemanticUi `node`
    // binding AND the dedicated JS-owner OS thread spawn (a thread, not a
    // subprocess).
    for benign in [
        "match node { SemanticNode::Group(..) => {} }",
        "let t = std::thread::Builder::new().name(\"js-env-owner\").spawn(move || {",
        "tokio::task::spawn_local(_drive);",
    ] {
        assert!(
            !FORBIDDEN_NEEDLES.iter().any(|needle| benign.contains(needle)),
            "guard false-positives on a benign line: {benign:?}"
        );
    }
}

#[test]
fn bridge_is_the_only_subprocess_spawn_site() {
    // Sanity: the guard's premise is that the bridge DOES spawn the worker (so
    // the guard isn't vacuously green because nothing spawns anything). Assert
    // the bridge file actually contains a process spawn.
    let bridge = fs::read_to_string(src_dir().join("bridge").join("mod.rs"))
        .expect("read bridge/mod.rs");
    assert!(
        bridge.contains("Command::new") && bridge.contains("node"),
        "the guard is vacuous: the throwaway bridge no longer spawns the Node worker \
         (was it deleted by 3zb? then this whole guard module should be deleted too)"
    );
}
