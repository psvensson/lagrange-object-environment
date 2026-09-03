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
        "ac12a01e7597e2d1c634658cc127a460d46f6150"
    );
    assert_eq!(PORTABLE_RUNTIME_ARTIFACT_BYTES.len(), 1_101_070);
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
    assert_eq!(artifact["modules"].as_array().map(Vec::len), Some(109));
    assert!(
        artifact.get("provenance").is_none(),
        "canonical material must not contain the external source provenance"
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
                'authorizedReadProjectDescriptor',
                'createProject',
                'addProjectMember',
                'projectObjectId',
              ];
              return {
                sameModule: exact.setDefaultCryptoProvider === alias.setDefaultCryptoProvider,
                marker: host.marker,
                exportedCreate: typeof exact.createPortableRuntime,
                requiredEnvironmentExportCount: requiredEnvironmentExports.length,
                missingEnvironmentExports: requiredEnvironmentExports.filter(
                  (name) => typeof alias[name] !== 'function',
                ),
              };
            })()"#,
        )
        .await
        .expect("link and evaluate pinned artifact closure");
    let report: serde_json::Value = serde_json::from_str(&report).expect("JSON report");
    assert_eq!(report["sameModule"], true);
    assert_eq!(report["marker"], "host-overlay");
    assert_eq!(report["exportedCreate"], "function");
    assert_eq!(report["requiredEnvironmentExportCount"], 21);
    assert_eq!(
        report["missingEnvironmentExports"],
        serde_json::json!([]),
        "every B3 composition helper must be callable through the sole public portable-runtime alias"
    );

    actor.shutdown().await;
}
