//! Shared test-only loader for composing checked-in Environment modules with
//! the pinned Images portable-runtime artifact.
//!
//! Artifact modules may resolve their own canonical `src/...` closure. Every
//! non-artifact module must enter that closure through the one public
//! `portable-runtime` alias; the audit handle makes that boundary executable.

use std::sync::{Arc, Mutex};

use lagrange_host_linux::images_composition::{
    portable_artifact::{PortableImagesArtifactLoader, PORTABLE_RUNTIME_ALIAS},
    CRYPTO_BOOTSTRAP_JS, CRYPTO_BOOTSTRAP_SPECIFIER,
};
use lagrange_host_linux::js_env::EmbeddedLoader;
use rquickjs::loader::{ImportAttributes, Loader, Resolver};
use rquickjs::{Ctx, Error, Module, Result as JsResult};

pub type ExternalArtifactResolutions = Arc<Mutex<Vec<(String, String, String)>>>;

#[derive(Clone)]
pub struct PublicEntryCompositionLoader {
    images: PortableImagesArtifactLoader,
    environment: EmbeddedLoader,
    external_artifact_resolutions: ExternalArtifactResolutions,
}

impl PublicEntryCompositionLoader {
    pub fn new(environment: EmbeddedLoader) -> Result<(Self, ExternalArtifactResolutions), String> {
        let external_artifact_resolutions = Arc::new(Mutex::new(Vec::new()));
        let images = PortableImagesArtifactLoader::from_embedded()?
            .with_host_module(CRYPTO_BOOTSTRAP_SPECIFIER, CRYPTO_BOOTSTRAP_JS)?;
        Ok((
            Self {
                images,
                environment,
                external_artifact_resolutions: Arc::clone(&external_artifact_resolutions),
            },
            external_artifact_resolutions,
        ))
    }
}

impl Resolver for PublicEntryCompositionLoader {
    fn resolve<'js>(
        &mut self,
        ctx: &Ctx<'js>,
        base: &str,
        name: &str,
        attributes: Option<ImportAttributes<'js>>,
    ) -> JsResult<String> {
        if !base.starts_with("src/") && name.starts_with("src/") {
            return Err(Error::new_resolving_message(
                base,
                name,
                "non-artifact modules must use the public portable-runtime alias",
            ));
        }

        match Resolver::resolve(&mut self.images, ctx, base, name, attributes.clone()) {
            Ok(resolved) => {
                if resolved.starts_with("src/") && !base.starts_with("src/") {
                    if name != PORTABLE_RUNTIME_ALIAS {
                        return Err(Error::new_resolving_message(
                            base,
                            name,
                            "non-artifact modules must use the public portable-runtime alias",
                        ));
                    }
                    self.external_artifact_resolutions
                        .lock()
                        .expect("artifact resolution audit lock poisoned")
                        .push((base.to_string(), name.to_string(), resolved.clone()));
                }
                Ok(resolved)
            }
            Err(Error::Resolving { .. }) => {
                Resolver::resolve(&mut self.environment, ctx, base, name, attributes)
            }
            Err(error) => Err(error),
        }
    }
}

impl Loader for PublicEntryCompositionLoader {
    fn load<'js>(
        &mut self,
        ctx: &Ctx<'js>,
        name: &str,
        attributes: Option<ImportAttributes<'js>>,
    ) -> JsResult<Module<'js, rquickjs::module::Declared>> {
        match Loader::load(&mut self.images, ctx, name, attributes.clone()) {
            Ok(module) => Ok(module),
            Err(Error::Loading { .. }) => {
                Loader::load(&mut self.environment, ctx, name, attributes)
            }
            Err(error) => Err(error),
        }
    }
}
