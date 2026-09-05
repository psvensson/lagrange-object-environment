//! Supply-chain pin for the embedded Images portable-runtime source artifact.
//!
//! Images owns production, canonical validation and identity. This test proves
//! only that OE embedded the exact reviewed canonical bytes from the recorded
//! revision; it does not reconstruct Images' closure or artifact validator.

use lagrange_host_linux::images_composition::{
    portable_artifact::{PortableImagesArtifactLoader, PORTABLE_RUNTIME_ALIAS},
    PORTABLE_RUNTIME_ARTIFACT_BYTES, PORTABLE_RUNTIME_ARTIFACT_ENTRY,
    PORTABLE_RUNTIME_ARTIFACT_FORMAT, PORTABLE_RUNTIME_CONTENT_IDENTITY,
    PORTABLE_RUNTIME_SOURCE_REVISION,
};
use lagrange_host_linux::js_env::actor::JsEnvActor;
use rquickjs::loader::Resolver;
use sha2::{Digest, Sha256};

#[test]
fn embedded_portable_runtime_artifact_is_the_pinned_canonical_material() {
    assert_eq!(
        PORTABLE_RUNTIME_SOURCE_REVISION,
        "9af24da93eba17357b05168ad5fc657be51bce94"
    );
    assert_eq!(PORTABLE_RUNTIME_ARTIFACT_BYTES.len(), 1_180_089);
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
    assert_eq!(artifact["modules"].as_array().map(Vec::len), Some(112));
    assert!(
        artifact.get("provenance").is_none(),
        "canonical material must not contain the external source provenance"
    );
}

/// ONE Images revision, two consumers: the vendored artifact (native lane) and
/// the CI sibling checkout (JS real-runtime integration lane) must agree, and
/// `PORTABLE_RUNTIME_SOURCE_REVISION` is the authoritative value. A bump that
/// moves one without the other is a hard failure here, never a silent drift.
#[test]
fn ci_sibling_checkout_pins_the_same_images_revision_as_the_artifact() {
    let workflow = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.github/workflows/ci.yml");
    let text = std::fs::read_to_string(&workflow)
        .unwrap_or_else(|e| panic!("the CI workflow must be readable at {}: {e}", workflow.display()));
    // Exactly ONE Images checkout block may exist; a second (with its own ref)
    // would otherwise be invisible to the anchor below.
    assert_eq!(
        text.matches("repository: psvensson/lagrange-images").count(),
        1,
        "ci.yml must check out psvensson/lagrange-images exactly once"
    );
    // Anchor on the sibling-checkout block, then take its `ref:` line. NOTE: the
    // key order `repository:` -> `ref:` -> `path:` is load-bearing for this
    // parse (YAML itself does not require it); a reordering fails CLOSED here.
    let block_start = text
        .find("repository: psvensson/lagrange-images")
        .expect("ci.yml must check out the pinned psvensson/lagrange-images sibling");
    let refs: Vec<&str> = text[block_start..]
        .lines()
        .take_while(|line| !line.trim_start().starts_with("path:"))
        .filter_map(|line| line.trim().strip_prefix("ref:"))
        .map(str::trim)
        .collect();
    assert_eq!(
        refs.len(),
        1,
        "exactly one `ref:` must follow the lagrange-images checkout block, found {refs:?}"
    );
    assert_eq!(
        refs[0], PORTABLE_RUNTIME_SOURCE_REVISION,
        "the JS lane's sibling checkout (src/runtime.js) and the native lane's vendored artifact (src/portable-runtime.js) must consume ONE Images revision: PORTABLE_RUNTIME_SOURCE_REVISION is authoritative"
    );
}

#[test]
fn resolver_has_one_artifact_identity_and_a_closed_namespace() {
    let mut loader = PortableImagesArtifactLoader::from_embedded()
        .expect("construct loader from the pinned artifact")
        .with_host_module("host/probe", "export const marker = 'host-overlay';")
        .expect("register exact host overlay");
    let runtime = rquickjs::Runtime::new().expect("runtime");
    let context = rquickjs::Context::full(&runtime).expect("context");

    context.with(|ctx| {
        let resolve = |loader: &mut PortableImagesArtifactLoader, base: &str, name: &str| {
            Resolver::resolve(loader, &ctx, base, name, None)
        };

        assert_eq!(
            resolve(&mut loader, "host/probe", PORTABLE_RUNTIME_ALIAS).unwrap(),
            PORTABLE_RUNTIME_ARTIFACT_ENTRY
        );
        assert_eq!(
            resolve(
                &mut loader,
                PORTABLE_RUNTIME_ARTIFACT_ENTRY,
                "./support/default-crypto.js"
            )
            .unwrap(),
            "src/support/default-crypto.js"
        );
        assert_eq!(
            resolve(&mut loader, "host/probe", "host/probe").unwrap(),
            "host/probe"
        );

        for forbidden in [
            "support/default-crypto",
            "fs",
            "node:fs",
            "src/not-in-the-artifact.js",
        ] {
            assert!(
                resolve(&mut loader, PORTABLE_RUNTIME_ARTIFACT_ENTRY, forbidden).is_err(),
                "unexpectedly resolved forbidden/unknown specifier {forbidden:?}"
            );
        }
        assert!(
            resolve(
                &mut loader,
                "src/support/default-crypto.js",
                "../../outside.js"
            )
            .is_err(),
            "relative import must not escape the artifact src/ root"
        );
    });
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn loader_links_the_artifact_and_preserves_alias_identity() {
    let loader = PortableImagesArtifactLoader::from_embedded()
        .expect("construct loader from the pinned artifact")
        .with_host_module("host/probe", "export const marker = 'host-overlay';")
        .expect("register exact host overlay");
    assert_eq!(loader.entry(), PORTABLE_RUNTIME_ARTIFACT_ENTRY);

    let actor = JsEnvActor::spawn(loader).expect("spawn artifact-backed actor");
    let report = actor
        .eval_async(
            r#"(async () => {
              const exact = await import('src/portable-runtime.js');
              const alias = await import('portable-runtime');
              const host = await import('host/probe');
              const requiredEnvironmentExports = [
                'installSmalltalkKernel',
                'findSmalltalkKernel',
                'defineClass',
                'installCallableInterfaceV2',
                'installImageCreationBinding',
                'installImageMutationBinding',
                'installImageObjectReadBinding',
                'installImageObservationBinding',
                'objectRef',
                'textValue',
                'referencesOfValue',
                'objectResource',
                'parseObjectResource',
                'objectVersionToken',
                'packCompositeValue',
                'unpackCompositeValue',
                'normalizeTypeDeclarations',
                'authorizedReadProject',
                'authorizedRenameProject',
                'createProject',
                'addProjectMember',
                'projectObjectId',
              ];
              // ADMISSION FACT for the Images 9af24da bump, deliberately separate from the
              // requirement list above: the authorized native Smalltalk browsing seams of
              // Images ADR 0087. No BYTE assertion (revision literal, length, sha256, module
              // count) can show that the artifact's CLOSURE actually links and resolves them
              // through the sole public alias -- that is what this proves. Object Environment
              // E1 consumes only the class seam; the method seam is listed because Images
              // publishes the pair and E2 consumes it next.
              const admittedNativeBrowseSeams = [
                'authorizedDescribeSmalltalkClass',
                'authorizedDescribeSmalltalkMethod',
              ];
              return {
                sameModule: exact.setDefaultCryptoProvider === alias.setDefaultCryptoProvider,
                marker: host.marker,
                exportedCreate: typeof exact.createPortableRuntime,
                requiredEnvironmentExportCount: requiredEnvironmentExports.length,
                missingEnvironmentExports: requiredEnvironmentExports.filter(
                  (name) => typeof alias[name] !== 'function',
                ),
                missingNativeBrowseSeams: admittedNativeBrowseSeams.filter(
                  (name) => typeof alias[name] !== 'function',
                ),
                // The seams reached through the public alias must be the EXACT functions the
                // OWNER module defines, not wrappers the barrel built. Comparing the alias to
                // the canonical entry would prove nothing -- the alias RESOLVES to that entry,
                // so both names denote one module namespace and `===` holds for every key,
                // `undefined === undefined` included. The owner module is the only comparison
                // that can fail, and it also fails CLOSED at a revision whose closure does not
                // carry it (import throws -> false).
                browseSeamsAreOwnerFunctions: await (async () => {
                  let owner = null;
                  try {
                    owner = await import('src/language/smalltalk-browse.js');
                  } catch {
                    return false;
                  }
                  return admittedNativeBrowseSeams.every(
                    (name) => typeof owner[name] === 'function' && owner[name] === alias[name],
                  );
                })(),
              };
            })()"#,
        )
        .await
        .expect("link and evaluate pinned artifact closure");
    let report: serde_json::Value = serde_json::from_str(&report).expect("JSON report");
    assert_eq!(report["sameModule"], true);
    assert_eq!(report["marker"], "host-overlay");
    assert_eq!(report["exportedCreate"], "function");
    assert_eq!(report["requiredEnvironmentExportCount"], 22);
    assert_eq!(
        report["missingEnvironmentExports"],
        serde_json::json!([]),
        "every B3 composition helper must be callable through the sole public portable-runtime alias"
    );
    assert_eq!(
        report["missingNativeBrowseSeams"],
        serde_json::json!([]),
        "the pinned revision must LINK and expose the ADR 0087 authorized native browsing seams through the alias"
    );
    assert_eq!(
        report["browseSeamsAreOwnerFunctions"], true,
        "the alias must expose the ADR 0087 seams as the exact functions src/language/smalltalk-browse.js defines"
    );

    actor.shutdown().await;
}
