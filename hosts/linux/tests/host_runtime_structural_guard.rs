//! HOST-RUNTIME STRUCTURAL GUARDS. The obsolete 64j Node subprocess bridge was
//! deleted once Bead 3zb reproduced its acceptance in-process. These durable
//! fences ensure it stays deleted and preserve the artifact-source and crypto
//! ownership constraints accumulated by later 3zb slices.
//!
//! The no-Node fence recursively scans every production Rust source file, so a
//! newly added module cannot silently evade it. No subprocess is spawned here.

use std::fs;
use std::path::{Path, PathBuf};

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
    "\"node\"", // invoking the node runtime by name
    "node_modules",
    "bridge-worker", // the throwaway worker path
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

fn collect_rust_files(dir: &Path, files: &mut Vec<PathBuf>) {
    let entries = fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("structural guard: cannot read {}: {e}", dir.display()));
    for entry in entries {
        let path = entry.expect("structural guard: read_dir entry").path();
        if path.is_dir() {
            collect_rust_files(&path, files);
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("rs") {
            files.push(path);
        }
    }
}

fn production_rust_files() -> Vec<PathBuf> {
    let mut files = Vec::new();
    collect_rust_files(&src_dir(), &mut files);
    files.sort();
    assert!(
        !files.is_empty(),
        "structural guard must scan production Rust sources"
    );
    files
}

#[test]
fn production_src_has_no_node_or_subprocess_dependency() {
    let dir = src_dir();
    let mut violations = Vec::new();
    for path in production_rust_files() {
        let file = path
            .strip_prefix(&dir)
            .expect("production source under src");
        let text = fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("structural guard: cannot read {}: {e}", path.display()));
        for (line_no, line) in text.lines().enumerate() {
            for needle in FORBIDDEN_NEEDLES {
                if line.contains(needle) {
                    violations.push(format!(
                        "{}:{}: forbidden {:?}: {}",
                        file.display(),
                        line_no + 1,
                        needle,
                        line.trim()
                    ));
                }
            }
        }
    }
    assert!(
        violations.is_empty(),
        "HOST-RUNTIME STRUCTURAL GUARD VIOLATED: production hosts/linux/src acquired a \
         Node/subprocess dependency; production code must not spawn Node.\n{}",
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
            !FORBIDDEN_NEEDLES
                .iter()
                .any(|needle| benign.contains(needle)),
            "guard false-positives on a benign line: {benign:?}"
        );
    }
}

#[test]
fn node_subprocess_bridge_remains_deleted() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    for relative in [
        "src/bridge/mod.rs",
        "tests/bridge_spike.rs",
        "tests/native_js_loop.rs",
        "tests/bridge-worker/acceptance-worker.mjs",
        "tests/bridge-worker/bridge.mjs",
        "tests/bridge-worker/loopback-worker.mjs",
    ] {
        assert!(
            !root.join(relative).exists(),
            "retired Node bridge scaffold must stay absent: {relative}"
        );
    }
    assert!(
        !root.join("tests/bridge-worker").exists(),
        "retired Node bridge worker directory must stay absent"
    );
    let lib = fs::read_to_string(root.join("src/lib.rs")).expect("read src/lib.rs");
    assert!(
        !lib.contains("pub mod bridge;"),
        "the retired Node bridge must not be re-exported from the Linux host"
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
    for banned in [
        "Math.random",
        "createHash",
        "createCipheriv",
        "crypto.subtle",
    ] {
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
    // sets apply to this production file (the recursive scan covers it too), so
    // the check is against their union -- e.g. a `use lagrange_images::...` is
    // caught by the global crate-ident needle rather than a crypto-specific one.
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
