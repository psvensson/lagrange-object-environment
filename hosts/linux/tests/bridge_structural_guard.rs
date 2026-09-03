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
    // 3zb-B1b native crypto PRIMITIVES. A new file is silently unguarded until
    // it is listed here (the B1b plan review's mandatory fix), and this is the
    // module where an Images import or a semantic name would be most tempting.
    "js_env/host_crypto.rs",
    // 3zb-B2 pinned Images artifact composition. The loader is production
    // composition code and must remain read-only/in-memory: no sibling checkout,
    // filesystem path, Node, or subprocess fallback.
    "images_composition/mod.rs",
    "images_composition/portable_artifact.rs",
];

const ARTIFACT_COMPOSITION_FILES: &[&str] = &[
    "images_composition/mod.rs",
    "images_composition/portable_artifact.rs",
];

const FORBIDDEN_IN_ARTIFACT_COMPOSITION: &[&str] = &[
    "std::fs",
    "PathBuf",
    "LAGRANGE_IMAGES_SRC",
    "lagrange-images/src",
];

const REQUIRED_IN_ARTIFACT_COMPOSITION: &[(&str, &[&str])] = &[
    (
        "images_composition/mod.rs",
        &[
            "PORTABLE_RUNTIME_ARTIFACT_BYTES",
            "PORTABLE_RUNTIME_CONTENT_IDENTITY",
        ],
    ),
    (
        "images_composition/portable_artifact.rs",
        &["PortableImagesArtifactLoader", "Sha256::digest"],
    ),
];

/// FILE-SCOPED fences, applied ONLY to the named file.
///
/// These cannot live in `FORBIDDEN_NEEDLES`, which is applied uniformly: words
/// like `cursor`, `authority` and `versionToken` are LEGITIMATE elsewhere
/// (`js_env/images_capability.rs` alone contains `cursor` ~25 times and
/// `authority` ~16 times), so a global needle would fail on day one. The
/// ownership rule being enforced here is narrower and file-specific:
///
///   **the host owns generic primitives; Images owns crypto semantics and the
///   provider contract; composition owns their binding.**
///
/// So `js_env/host_crypto.rs` must name no Images semantic concept, must not
/// reach for a lagrange-images module by SPECIFIER (the underscore-crate needle
/// in `FORBIDDEN_NEEDLES` does not catch a JS specifier), must not grow a
/// WebCrypto personality, and must not acquire a second entropy source.
const FORBIDDEN_IN_CRYPTO: &[(&str, &[&str])] = &[(
    "js_env/host_crypto.rs",
    &[
        // Images SEMANTICS. The host computes primitives; it must never learn
        // what they are used for.
        "cursor",
        "versionToken",
        "version_token",
        "typeFingerprint",
        "type_fingerprint",
        "fingerprint",
        "derivation",
        "authority",
        "Project",
        // Provider ASSEMBLY / CONTRACT — owned by Images and by the guest
        // composition respectively, never by the host.
        "assertCryptoProvider",
        "setDefaultCryptoProvider",
        "getDefaultCryptoProvider",
        "cryptoProvider",
        // lagrange-images module SPECIFIERS (a JS import string, which the
        // underscore crate-ident needle would not catch).
        "default-crypto",
        "crypto-provider",
        "portable-runtime",
        "support/",
        // Node crypto and a WebCrypto compatibility personality. Crypto reaches
        // Images through its own provider contract, never a `crypto` global.
        "node:crypto",
        "crypto.subtle",
        "SubtleCrypto",
        "webcrypto",
        "globalThis.crypto",
        // A SECOND entropy source. `getrandom` (the OS CSPRNG) must be the only
        // one; a seeded userspace generator would both weaken the primitive and
        // duplicate authority over randomness.
        "thread_rng",
        "StdRng",
        "SmallRng",
        "SeedableRng",
        "seed_from_u64",
        "from_seed",
        "XorShift",
        "rand::",
    ],
)];

/// Needles that MUST be present, so a fence cannot pass by the thing it guards
/// being deleted. (A missing `getrandom` would make every "no seeded PRNG"
/// needle vacuously true.)
const REQUIRED_IN_CRYPTO: &[(&str, &[&str])] =
    &[("js_env/host_crypto.rs", &["getrandom", "aes_gcm", "Sha256"])];

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
        // The js_env TEST capability must NOT become a private lagrange-images host:
        // the underscore form is the needle (LAGRANGE_IMAGES_URL above only covers
        // the env-var form).
        "use lagrange_images::runtime;",
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

#[test]
fn portable_artifact_composition_has_no_filesystem_or_sibling_fallback() {
    for file in ARTIFACT_COMPOSITION_FILES {
        let path = src_root().join(file);
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        for (line_no, line) in text.lines().enumerate() {
            if line.trim_start().starts_with("//") {
                continue;
            }
            for needle in FORBIDDEN_IN_ARTIFACT_COMPOSITION {
                assert!(
                    !line.contains(needle),
                    "{file}:{} contains forbidden artifact fallback `{needle}` in code: {}",
                    line_no + 1,
                    line.trim()
                );
            }
        }
    }
}

#[test]
fn portable_artifact_composition_fences_are_not_vacuous() {
    for (file, needles) in REQUIRED_IN_ARTIFACT_COMPOSITION {
        let path = src_root().join(file);
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        for needle in *needles {
            assert!(text.contains(needle), "{file} must retain `{needle}`");
        }
    }

    for planted in [
        "let root = PathBuf::from(env!(\"LAGRANGE_IMAGES_SRC\"));",
        "let source = std::fs::read_to_string(\"lagrange-images/src/x.js\");",
    ] {
        assert!(
            FORBIDDEN_IN_ARTIFACT_COMPOSITION
                .iter()
                .any(|needle| planted.contains(needle)),
            "artifact fence missed planted fallback: {planted}"
        );
    }
}

// ---------------------------------------------------------------------------
// Bead 3zb slice B1b: the crypto ownership fence
// ---------------------------------------------------------------------------

fn src_root() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src")
}

/// **The host owns primitives; Images owns crypto semantics and the provider
/// contract; composition owns their binding.**
///
/// Enforced by source scan rather than left as prose: the native crypto module
/// must name no Images semantic concept, must not reach a lagrange-images module
/// by specifier, must not grow a WebCrypto personality, and must not acquire a
/// second entropy source.
#[test]
fn native_crypto_names_no_images_semantics() {
    for (file, needles) in FORBIDDEN_IN_CRYPTO {
        let path = src_root().join(file);
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        for (lineno, line) in text.lines().enumerate() {
            // COMMENT LINES ARE EXEMPT, deliberately. This module's own header
            // draws the three-layer ownership diagram and therefore NAMES the
            // neighbouring layers ("assertCryptoProvider / setDefaultCryptoProvider"
            // belong to Images). Documenting the boundary is exactly what an
            // ownership-critical file should do; the fence is about CODE
            // dependencies, so scanning prose would punish the good behaviour it
            // is meant to encourage. A whole-line `//` cannot hide code.
            if line.trim_start().starts_with("//") {
                continue;
            }
            for needle in *needles {
                assert!(
                    !line.contains(needle),
                    "{file}:{} names `{needle}` in CODE, which belongs to lagrange-images or to \
                     the guest composition, not to the generic host primitives:\n  {line}",
                    lineno + 1
                );
            }
        }
    }
}

/// A fence must not pass because the guarded thing was deleted.
#[test]
fn native_crypto_still_uses_the_established_libraries() {
    for (file, required) in REQUIRED_IN_CRYPTO {
        let path = src_root().join(file);
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
        for needle in *required {
            assert!(
                text.contains(needle),
                "{file} no longer mentions `{needle}` -- either the primitive was removed or it \
                 was reimplemented by hand; both invalidate the fences above"
            );
        }
    }
}

/// Provider ASSEMBLY lives in guest composition code, not in the host.
///
/// The bootstrap is the one place allowed to name the Images seam, and it must
/// really be doing the binding rather than the host doing it behind its back.
#[test]
fn provider_assembly_lives_in_guest_composition() {
    let bootstrap = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src/images_composition/crypto-bootstrap.js");
    let text = std::fs::read_to_string(&bootstrap).expect("read crypto-bootstrap.js");

    // It binds the two sides...
    assert!(
        text.contains("setDefaultCryptoProvider"),
        "the bootstrap must install through the public Images seam"
    );
    assert!(
        text.contains("__jsenv_crypto_"),
        "the bootstrap must adapt the generic host primitives"
    );
    for method in [
        "secureRandomBytes",
        "sha256",
        "aes256gcmEncrypt",
        "aes256gcmDecrypt",
        "uuid",
    ] {
        assert!(text.contains(method), "the bootstrap must supply {method}");
    }
    // ...and it must consume the seam from the PUBLIC composition root rather
    // than deep-importing the private support module (Images exposed
    // setDefaultCryptoProvider from portable-runtime precisely so this is
    // possible; a deep import here would silently re-create the coupling).
    assert!(
        text.contains("from 'portable-runtime'"),
        "the bootstrap must import the seam from the PUBLIC portable-runtime root"
    );
    assert!(
        !text.contains("support/default-crypto"),
        "the bootstrap must NOT deep-import the private support module"
    );
    // It must not reimplement Images-owned validation.
    assert!(
        !text.contains("function assertCryptoProvider"),
        "assertCryptoProvider is Images-owned and must not be reproduced in composition code"
    );
    // And it must implement no cryptography of its own.
    for banned in ["Math.random", "createHash", "createCipheriv", "crypto.subtle"] {
        assert!(
            !text.contains(banned),
            "the bootstrap must adapt primitives, never implement crypto: found `{banned}`"
        );
    }
}

/// Non-vacuity for the crypto fences: each forbidden needle must actually be
/// detected, and a benign line must NOT trip them.
#[test]
fn crypto_fence_detection_is_not_vacuous() {
    let (_, needles) = FORBIDDEN_IN_CRYPTO[0];

    // Every needle detects a line that contains it.
    for needle in needles {
        let planted = format!("    let x = \"{needle}\"; // planted");
        assert!(
            needles.iter().any(|n| planted.contains(n)),
            "needle `{needle}` failed to detect its own planted line"
        );
    }

    // Representative violations a future edit might actually make. BOTH needle
    // sets apply to this file (it is in PRODUCTION_FILES too), so the check is
    // against their union -- e.g. a `use lagrange_images::...` is caught by the
    // global crate-ident needle rather than by a crypto-specific one.
    let catches = |line: &str| {
        needles.iter().any(|n| line.contains(n))
            || FORBIDDEN_NEEDLES.iter().any(|n| line.contains(n))
    };
    for violation in [
        "use lagrange_images::support::default_crypto;",
        "// derive the observation cursor key here",
        "let provider = assertCryptoProvider(candidate);",
        "import {setDefaultCryptoProvider} from 'portable-runtime';",
        "let rng = StdRng::seed_from_u64(42);",
        "globalThis.crypto.subtle.digest('SHA-256', data)",
    ] {
        assert!(
            catches(violation),
            "the crypto fence would MISS this violation: {violation}"
        );
    }

    // Benign lines in a crypto primitive module must NOT trip the fence, or the
    // guard becomes noise that the next author disables.
    for benign in [
        "/// `sha256(bytes) -> Uint8Array(32)`.",
        "let cipher = Aes256Gcm::new_from_slice(key)?;",
        "fill_random(&mut buf)?;",
        "expect_len(&ctx, iv.as_ref(), 12, \"AES-256-GCM iv\")?;",
        "// Detached: the tag comes back separately.",
    ] {
        assert!(
            !catches(benign),
            "the crypto fence false-positives on a benign line: {benign}"
        );
    }
}
