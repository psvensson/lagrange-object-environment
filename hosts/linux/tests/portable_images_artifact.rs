//! Supply-chain pin for the embedded Images portable-runtime source artifact.
//!
//! Images owns production, canonical validation and identity. This test proves
//! only that OE embedded the exact reviewed canonical bytes from the recorded
//! revision; it does not reconstruct Images' closure or artifact validator.

use lagrange_host_linux::images_composition::{
    PORTABLE_RUNTIME_ARTIFACT_BYTES, PORTABLE_RUNTIME_ARTIFACT_ENTRY,
    PORTABLE_RUNTIME_ARTIFACT_FORMAT, PORTABLE_RUNTIME_CONTENT_IDENTITY,
    PORTABLE_RUNTIME_SOURCE_REVISION,
};
use sha2::{Digest, Sha256};

#[test]
fn embedded_portable_runtime_artifact_is_the_pinned_canonical_material() {
    assert_eq!(
        PORTABLE_RUNTIME_SOURCE_REVISION,
        "c7f2f97c2cbb316364cf2a706459caed4313b0ea"
    );
    assert_eq!(PORTABLE_RUNTIME_ARTIFACT_BYTES.len(), 1_061_921);
    assert_eq!(PORTABLE_RUNTIME_ARTIFACT_BYTES.last(), Some(&b'}'));

    let digest = Sha256::digest(PORTABLE_RUNTIME_ARTIFACT_BYTES);
    let actual = format!("sha256:{digest:x}");
    assert_eq!(actual, PORTABLE_RUNTIME_CONTENT_IDENTITY);

    // Minimal consumer compatibility facts only. Closure completeness,
    // canonical ordering/path rules and validation remain Images-owned.
    let artifact: serde_json::Value =
        serde_json::from_slice(PORTABLE_RUNTIME_ARTIFACT_BYTES).expect("pinned artifact is JSON");
    assert_eq!(artifact["format"], PORTABLE_RUNTIME_ARTIFACT_FORMAT);
    assert_eq!(artifact["entry"], PORTABLE_RUNTIME_ARTIFACT_ENTRY);
    assert_eq!(artifact["modules"].as_array().map(Vec::len), Some(107));
    assert!(
        artifact.get("provenance").is_none(),
        "canonical material must not contain the external source provenance"
    );
}
