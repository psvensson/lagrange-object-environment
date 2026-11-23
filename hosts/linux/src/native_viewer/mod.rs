//! Production module closure for the read-only native viewer. All Environment
//! sources are embedded verbatim; no filesystem, test module or sibling loader.
use crate::images_composition::public_entry_loader::PublicEntryCompositionLoader;
use crate::js_env::EmbeddedLoader;
pub mod window;
pub mod cli;

pub fn environment_loader() -> EmbeddedLoader {
    EmbeddedLoader::new()
        .with_module("model", include_str!("../../../../src/model.js"))
        .with_module(
            "renderer-errors",
            include_str!("../../../../src/renderer-errors.js"),
        )
        .with_module(
            "selection-model",
            include_str!("../../../../src/selection-model.js"),
        )
        .with_module(
            "image-observation",
            include_str!("../../../../src/image-observation.js"),
        )
        .with_module(
            "image-read-connection",
            include_str!("../../../../src/image-read-connection.js"),
        )
        .with_module(
            "command-registry",
            include_str!("../../../../src/command-registry.js"),
        )
        .with_module(
            "command-dispatcher",
            include_str!("../../../../src/command-dispatcher.js"),
        )
        .with_module(
            "presentation-registry",
            include_str!("../../../../src/presentation-registry.js"),
        )
        .with_module(
            "object-navigator",
            include_str!("../../../../src/object-navigator.js"),
        )
        .with_module(
            "object-presentation-providers",
            include_str!("../../../../src/object-presentation-providers.js"),
        )
        .with_module("compositor", include_str!("../../../../src/compositor.js"))
        .with_module(
            "environment-shell",
            include_str!("../../../../src/environment-shell.js"),
        )
        .with_module(
            "perspective-projection",
            include_str!("../../../../src/perspective-projection.js"),
        )
        .with_module(
            "image-client-adapter",
            include_str!("../../../../src/image-client-adapter.js"),
        )
        .with_module(
            "project-browser",
            include_str!("../../../../src/project-browser.js"),
        )
        .with_module(
            "native/read-transport",
            crate::image_read_transport::HOST_BINDING_JS,
        )
        .with_module("native/viewer-session", include_str!("session.js"))
}

pub fn loader() -> Result<PublicEntryCompositionLoader, String> {
    PublicEntryCompositionLoader::new(environment_loader()).map(|(loader, _audit)| loader)
}
