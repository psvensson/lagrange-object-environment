//! Fake-Images composition for the shared in-process Environment/GTK acceptance.
//!
//! This test owns only the scripted Images setup, capability/renderer
//! installation, and fake guest composition bootstrap. The shared test-only
//! protocol owner in `support/in_process_acceptance.rs` drives the real,
//! unchanged Environment semantic core through NAV/OBS/OLM/STALE/DENIED/C1.
//! The fake deliberately claims no real Images authority, CAS, cursor, or
//! persistence semantics.
//!
//! THREAD MODEL: this remains the single GTK-owning test in this process. GTK
//! and RendererPortHost stay on the test thread; JS has its dedicated actor
//! thread; the scripted Images capability has its own non-JS worker thread.

#[path = "support/in_process_acceptance.rs"]
mod in_process_acceptance;

use in_process_acceptance::{
    gtk_init, run_in_process_acceptance, stub_glb_runner, AcceptanceFlavor,
};
use lagrange_host_linux::js_env::actor::JsEnvActor;
use lagrange_host_linux::js_env::images_capability::{
    install_images_capability, ImagesCapabilityHost,
};
use lagrange_host_linux::js_env::renderer_port::{install_renderer_adapter, RendererPortHost};
use lagrange_host_linux::js_env::EmbeddedLoader;
use serde_json::json;

/// The 12-module real Environment closure + the TEST-only composition module,
/// registered under flat stems (the Env src/ graph is flat; all cross-imports
/// are './x.js'). Loaded via include_str! (checked-in sources).
fn env_loader() -> EmbeddedLoader {
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
        .with_module("composition", include_str!("acceptance-composition.mjs"))
}

#[test]
fn slice4_acceptance() {
    gtk_init();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("tokio runtime");

    // Composition-specific scripted Images setup.
    let (images_host, images_tx, script) = ImagesCapabilityHost::new();
    script.add_object(
        "obj-root",
        json!({"link": {"kind": "ref", "imageId": "img", "objectId": "obj-b"}}),
    );
    script.add_object("obj-b", json!({"probe-title": {"value": "original"}}));
    script.add_object(
        "obj-denied-read",
        json!({"probe-title": {"value": "secret"}}),
    );
    script.deny_read("obj-denied-read");
    script.add_object(
        "obj-denied-mutate",
        json!({"probe-title": {"value": "frozen"}}),
    );
    script.deny_mutate("obj-denied-mutate");
    images_host.start();

    // Composition-specific capability installation.
    let (mut host, renderer_tx) = RendererPortHost::new(stub_glb_runner());
    let actor = JsEnvActor::spawn(env_loader()).expect("spawn actor");
    {
        let tx = renderer_tx.clone();
        runtime
            .block_on(
                actor
                    .with_context(move |ctx| install_renderer_adapter(&ctx, tx, "rendererAdapter")),
            )
            .expect("install renderer");
    }
    {
        let tx = images_tx.clone();
        runtime
            .block_on(
                actor.with_context(move |ctx| {
                    install_images_capability(&ctx, tx, "imagesCapability")
                }),
            )
            .expect("install images");
    }

    // Import and configure the fake guest composition only. The shared driver
    // owns the protocol from __session.open(rootObjectId) onward.
    let setup = runtime
        .block_on(actor.eval_async(
            r#"
(async () => {
  const m = await import('composition');
  m.setup({
    imageId: 'img',
    blockIds: {read: 'blk-read', mutation: 'blk-mut', observation: 'blk-obs'},
    seededObjectIds: {
      root: 'obj-root', b: 'obj-b', deniedRead: 'obj-denied-read',
      deniedMutate: 'obj-denied-mutate', unavailable: 'obj-unavailable',
    },
  });
  return true;
})()
"#,
        ))
        .expect("configure fake guest composition");
    assert_eq!(setup, "true", "fake composition setup");

    run_in_process_acceptance(
        &runtime,
        &actor,
        &mut host,
        &AcceptanceFlavor {
            name: "scripted fake Images",
            root_object_id: "obj-root",
            initial_title: "original",
            observed_title: "observed-1",
            olm_title: "edited-olm",
            stale_external_title: "external-stale",
            stale_attempt_title: "stale-write",
            denied_write_title: "frozen",
            denied_attempt_title: "attempt",
            denied_write_same_object_as_primary: false,
            expected_creation_tokens: 0,
            minimum_c1_tokens: 1,
            before_teardown: &[],
        },
    );

    runtime.block_on(actor.shutdown());
}
