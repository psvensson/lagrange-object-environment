//! Bead 3zb slice B1b: the Env <-> Images COMPOSITION layer.
//!
//! A sibling of `js_env`, deliberately: `js_env` owns generic host primitives
//! and must never import or name a `lagrange-images` module, while this layer
//! exists precisely to bind the two. The directory boundary is the ownership
//! statement, and the structural guard checks it.
//!
//! The composition itself is JavaScript (`crypto-bootstrap.js`) rather than a
//! Rust string literal, so that B2 and B3 reuse the SAME source verbatim instead
//! of re-deriving it, and so it is reviewable as the module it is.

/// The guest bootstrap that adapts the generic host crypto primitives to the
/// `lagrange-images` crypto-provider contract and installs them through the
/// public `setDefaultCryptoProvider` seam.
pub const CRYPTO_BOOTSTRAP_JS: &str = include_str!("crypto-bootstrap.js");

/// The module specifier the bootstrap is loaded under. Bare and canonical so it
/// is loader-agnostic: it resolves the same way under B1b's repo-tree loader and
/// under the artifact loader B2 introduces.
pub const CRYPTO_BOOTSTRAP_SPECIFIER: &str = "host/crypto-bootstrap";
