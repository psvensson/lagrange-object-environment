//! Pinned Images artifact -> rquickjs module translation.
//!
//! Images owns artifact production, canonical validation, closure membership,
//! and content identity. This module owns only the consumer boundary: it checks
//! that the embedded bytes are the reviewed identity, reads the supported
//! format/entry/modules fields, and exposes those exact logical paths to
//! rquickjs without a filesystem or package-resolution fallback.

use std::collections::HashMap;

use rquickjs::loader::{ImportAttributes, Loader, Resolver};
use rquickjs::{Ctx, Error, Module, Result as JsResult};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::{
    PORTABLE_RUNTIME_ARTIFACT_BYTES, PORTABLE_RUNTIME_ARTIFACT_FORMAT,
    PORTABLE_RUNTIME_CONTENT_IDENTITY,
};

/// The sole public alias for the Images composition root.
///
/// It exists for the checked-in crypto bootstrap. Resolution returns the
/// artifact's canonical entry path, so importing the alias and importing the
/// exact path instantiate one module rather than two copies of Images state.
pub const PORTABLE_RUNTIME_ALIAS: &str = "portable-runtime";

#[derive(Deserialize)]
struct PortableArtifact {
    format: String,
    entry: String,
    modules: Vec<PortableArtifactModule>,
}

#[derive(Deserialize)]
struct PortableArtifactModule {
    path: String,
    source: String,
}

/// Read-only loader over the exact embedded Images portable-runtime artifact.
#[derive(Clone)]
pub struct PortableImagesArtifactLoader {
    entry: String,
    modules: HashMap<String, String>,
    host_modules: HashMap<String, String>,
}

impl PortableImagesArtifactLoader {
    /// Construct from the reviewed, embedded artifact bytes.
    ///
    /// This deliberately performs only consumer compatibility checks. Images'
    /// producer owns canonical ordering, path validity, duplicate rejection,
    /// static-import validation, and closure completeness.
    pub fn from_embedded() -> Result<Self, String> {
        let digest = Sha256::digest(PORTABLE_RUNTIME_ARTIFACT_BYTES);
        let actual_identity = format!("sha256:{digest:x}");
        if actual_identity != PORTABLE_RUNTIME_CONTENT_IDENTITY {
            return Err(format!(
                "embedded Images artifact identity mismatch: expected {}, got {actual_identity}",
                PORTABLE_RUNTIME_CONTENT_IDENTITY
            ));
        }

        let artifact: PortableArtifact = serde_json::from_slice(PORTABLE_RUNTIME_ARTIFACT_BYTES)
            .map_err(|error| format!("embedded Images artifact is not valid JSON: {error}"))?;
        if artifact.format != PORTABLE_RUNTIME_ARTIFACT_FORMAT {
            return Err(format!(
                "unsupported Images artifact format {:?}; expected {:?}",
                artifact.format, PORTABLE_RUNTIME_ARTIFACT_FORMAT
            ));
        }

        let entry = artifact.entry;
        let modules = artifact
            .modules
            .into_iter()
            .map(|module| (module.path, module.source))
            .collect::<HashMap<_, _>>();
        if !modules.contains_key(&entry) {
            return Err(format!("Images artifact entry is unavailable: {entry}"));
        }

        Ok(Self {
            entry,
            modules,
            host_modules: HashMap::new(),
        })
    }

    /// Add one exact host-owned overlay in the disjoint `host/...` namespace.
    pub fn with_host_module(mut self, name: &str, source: &str) -> Result<Self, String> {
        if !name.starts_with("host/")
            || name == "host/"
            || name
                .chars()
                .any(|character| matches!(character, '\\' | '?' | '#'))
        {
            return Err(format!(
                "host overlay must have an exact host/... module name, got {name:?}"
            ));
        }
        self.host_modules
            .insert(name.to_string(), source.to_string());
        Ok(self)
    }

    /// Canonical entry path stored in the artifact.
    pub fn entry(&self) -> &str {
        &self.entry
    }

    fn resolve_name(&self, base: &str, name: &str) -> Result<String, String> {
        if name == PORTABLE_RUNTIME_ALIAS {
            return Ok(self.entry.clone());
        }
        if self.host_modules.contains_key(name) {
            return Ok(name.to_string());
        }
        if name.starts_with('.') {
            return self.resolve_relative(base, name);
        }
        if name.starts_with("src/") && self.modules.contains_key(name) {
            return Ok(name.to_string());
        }

        Err(format!(
            "module is not an exact artifact path, the {PORTABLE_RUNTIME_ALIAS:?} alias, or an exact host overlay"
        ))
    }

    fn resolve_relative(&self, base: &str, name: &str) -> Result<String, String> {
        if !base.starts_with("src/") || !self.modules.contains_key(base) {
            return Err("relative imports are allowed only from canonical artifact modules".into());
        }

        let mut segments = base.split('/').collect::<Vec<_>>();
        segments.pop();
        for segment in name.split('/') {
            match segment {
                "" | "." => {}
                ".." if segments.len() > 1 => {
                    segments.pop();
                }
                ".." => return Err("relative import escapes the artifact src/ root".into()),
                value => segments.push(value),
            }
        }
        let canonical = segments.join("/");
        if self.modules.contains_key(&canonical) {
            Ok(canonical)
        } else {
            Err(format!(
                "module is not present in the embedded Images artifact: {canonical}"
            ))
        }
    }
}

impl Resolver for PortableImagesArtifactLoader {
    fn resolve<'js>(
        &mut self,
        _ctx: &Ctx<'js>,
        base: &str,
        name: &str,
        _attributes: Option<ImportAttributes<'js>>,
    ) -> JsResult<String> {
        self.resolve_name(base, name)
            .map_err(|message| Error::new_resolving_message(base, name, message))
    }
}

impl Loader for PortableImagesArtifactLoader {
    fn load<'js>(
        &mut self,
        ctx: &Ctx<'js>,
        name: &str,
        _attributes: Option<ImportAttributes<'js>>,
    ) -> JsResult<Module<'js, rquickjs::module::Declared>> {
        let source = self
            .host_modules
            .get(name)
            .or_else(|| self.modules.get(name))
            .ok_or_else(|| {
                Error::new_loading_message(
                    name,
                    "module is not in the embedded Images artifact or exact host overlay map",
                )
            })?;
        Module::declare(ctx.clone(), name, source.as_bytes())
    }
}
