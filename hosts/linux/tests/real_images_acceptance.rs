//! Bead 3zb-B3 Part 2B: the pinned real Images portable runtime drives the
//! unchanged full Environment and real LinuxRendererAdapter/GTK in-process.
//!
//! This test owns only embedded source loading, renderer installation and real
//! guest bootstrap. The common NAV/OBS/OLM/STALE/DENIED/C1 protocol remains in
//! `support/in_process_acceptance.rs`, including denied-vs-unavailable and C1.

#[path = "support/in_process_acceptance.rs"]
mod in_process_acceptance;
#[path = "support/public_entry_composition_loader.rs"]
mod public_entry_composition_loader;

use in_process_acceptance::{
    gtk_init, run_in_process_acceptance, stub_glb_runner, AcceptanceFlavor,
};
use lagrange_host_linux::images_composition::portable_artifact::PORTABLE_RUNTIME_ALIAS;
use lagrange_host_linux::js_env::actor::JsEnvActor;
use lagrange_host_linux::js_env::renderer_port::{install_renderer_adapter, RendererPortHost};
use lagrange_host_linux::js_env::EmbeddedLoader;
use public_entry_composition_loader::{ExternalArtifactResolutions, PublicEntryCompositionLoader};
use serde_json::{json, Value};

const COMPOSITION: &str = include_str!("real-images-acceptance-composition.mjs");

fn environment_loader() -> EmbeddedLoader {
    EmbeddedLoader::new()
        .with_module("model", include_str!("../../../src/model.js"))
        .with_module(
            "renderer-errors",
            include_str!("../../../src/renderer-errors.js"),
        )
        .with_module(
            "selection-model",
            include_str!("../../../src/selection-model.js"),
        )
        .with_module(
            "image-observation",
            include_str!("../../../src/image-observation.js"),
        )
        .with_module(
            "command-router",
            include_str!("../../../src/command-router.js"),
        )
        .with_module(
            "command-registry",
            include_str!("../../../src/command-registry.js"),
        )
        .with_module(
            "command-dispatcher",
            include_str!("../../../src/command-dispatcher.js"),
        )
        .with_module(
            "presentation-registry",
            include_str!("../../../src/presentation-registry.js"),
        )
        .with_module(
            "object-navigator",
            include_str!("../../../src/object-navigator.js"),
        )
        .with_module(
            "object-presentation-providers",
            include_str!("../../../src/object-presentation-providers.js"),
        )
        .with_module("compositor", include_str!("../../../src/compositor.js"))
        .with_module(
            "environment-shell",
            include_str!("../../../src/environment-shell.js"),
        )
        .with_module(
            "perspective-projection",
            include_str!("../../../src/perspective-projection.js"),
        )
        .with_module(
            "image-client-adapter",
            include_str!("../../../src/image-client-adapter.js"),
        )
        .with_module("test/real-images-acceptance", COMPOSITION)
}

fn actor() -> (JsEnvActor, ExternalArtifactResolutions) {
    let (loader, external_artifact_resolutions) =
        PublicEntryCompositionLoader::new(environment_loader())
            .expect("construct combined public-entry composition loader");
    let actor = JsEnvActor::spawn(loader).expect("spawn real Images/Environment actor");
    (actor, external_artifact_resolutions)
}

fn assert_exact_keys(value: &Value, expected: &[&str], what: &str) {
    let object = value
        .as_object()
        .unwrap_or_else(|| panic!("{what} must be an object: {value}"));
    let mut actual = object.keys().map(String::as_str).collect::<Vec<_>>();
    let mut expected = expected.to_vec();
    actual.sort_unstable();
    expected.sort_unstable();
    assert_eq!(actual, expected, "{what} exact key set");
}

fn assert_public_entry_audit(external_artifact_resolutions: &ExternalArtifactResolutions) {
    let resolutions = external_artifact_resolutions
        .lock()
        .expect("artifact resolution audit lock poisoned")
        .clone();
    assert!(
        !resolutions.is_empty(),
        "the full composition must actually cross the public Images entry"
    );
    assert!(
        resolutions.iter().all(
            |(_, requested, resolved)| requested == PORTABLE_RUNTIME_ALIAS
                && resolved.starts_with("src/")
        ),
        "every external artifact resolution must use the public Images alias: {resolutions:?}"
    );
}

#[test]
fn real_images_full_environment_gtk_acceptance() {
    gtk_init();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("tokio runtime");
    let (actor, external_artifact_resolutions) = actor();
    let (mut host, renderer_tx) = RendererPortHost::new(stub_glb_runner());
    {
        let tx = renderer_tx.clone();
        runtime
            .block_on(
                actor
                    .with_context(move |ctx| install_renderer_adapter(&ctx, tx, "rendererAdapter")),
            )
            .expect("install renderer");
    }

    let setup = runtime
        .block_on(actor.eval_async(
            r#"
(async () => {
  const m = await import('test/real-images-acceptance');
  return await m.setup({
    imageId: 'real-full-image',
    ids: {
      className: 'Probe', shapeId: 'probe-shape',
      interfaceId: 'probe-interface', bindingId: 'probe-binding', blockId: 'probe-block',
      mutationInterfaceId: 'probe-mutate-interface',
      mutationBindingId: 'probe-mutate-binding', mutationBlockId: 'probe-mutate-block',
      readInterfaceId: 'object-read-interface', readBindingId: 'object-read-binding',
      readBlockId: 'object-read-block', observationInterfaceId: 'observation-interface',
      observationBindingId: 'observation-binding', observationBlockId: 'observation-block',
    },
  });
})()
"#,
        ))
        .expect("configure real Images guest composition");
    let setup: Value = serde_json::from_str(&setup).expect("setup report must be JSON");
    assert_exact_keys(&setup, &["rootObjectId"], "setup");
    let root_object_id = setup["rootObjectId"]
        .as_str()
        .filter(|value| !value.is_empty())
        .expect("setup.rootObjectId must be a nonempty string")
        .to_string();

    assert_public_entry_audit(&external_artifact_resolutions);
    let private_import = runtime
        .block_on(actor.eval_async(
            r#"
(async () => {
  try {
    await import('src/value/scalars.js');
    return {loaded: true, message: null};
  } catch (error) {
    return {loaded: false, message: String(error && error.message)};
  }
})()
"#,
        ))
        .expect("private artifact import probe must return");
    let private_import: Value =
        serde_json::from_str(&private_import).expect("private import probe must return JSON");
    assert_exact_keys(
        &private_import,
        &["loaded", "message"],
        "private import probe",
    );
    assert_eq!(private_import["loaded"], json!(false));
    assert!(
        private_import["message"]
            .as_str()
            .is_some_and(|message| message.contains("public portable-runtime alias")),
        "runtime resolver must reject external private artifact imports: {private_import}"
    );

    run_in_process_acceptance(
        &runtime,
        &actor,
        &mut host,
        &AcceptanceFlavor {
            name: "pinned real Images",
            root_object_id: &root_object_id,
            initial_title: "original-real",
            observed_title: "observed-real",
            olm_title: "olm-real",
            stale_external_title: "stale-external-real",
            stale_attempt_title: "stale-attempt-real",
            denied_write_title: "stale-external-real",
            denied_attempt_title: "denied-attempt-real",
            denied_write_same_object_as_primary: true,
            expected_creation_tokens: 3,
            minimum_c1_tokens: 4,
        },
    );

    assert_public_entry_audit(&external_artifact_resolutions);
    runtime.block_on(actor.shutdown());
}
