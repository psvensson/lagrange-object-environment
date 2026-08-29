//! The Rust consumer of the SemanticUi/v1 contract (`src/semantic-ui.js`).
//!
//! ADR 0013's host-neutral tool-UI description, deserialized here and turned
//! into real GTK4 controls by the GTK realizer. This module is ONE of TWO
//! conforming implementations of the single authoritative contract (the other
//! is the JS validator); both run against the same checked-in fixture corpus
//! (green + red). The Rust side does NOT re-decide semantics: it validates a
//! SemanticUi document and renders it, exactly like the browser DOM realizer.
//!
//! The validation tolerance MUST mirror src/semantic-ui.js (see its
//! CONFORMANCE NOTE): unknown extra properties are tolerated (forward-compat)
//! and not recursed, except the structural children/items arrays which are
//! recursed as nodes; host-specific fields and refs are rejected at both the
//! document and every node level; action keys must be non-negative integers
//! (descriptor-local, never a ref).

use serde::Deserialize;
use std::collections::BTreeSet;

/// The host-neutral SemanticUi/v1 document.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct SemanticUi {
    pub kind: String,
    pub version: u32,
    pub root: Node,
}

/// A SemanticUi node. `serde(tag = "kind")` dispatches on the node's `kind`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Node {
    Group {
        #[serde(default)]
        title: Option<String>,
        children: Vec<Node>,
    },
    Text {
        #[serde(default)]
        role: Option<String>,
        text: String,
    },
    Field {
        label: String,
        text: String,
    },
    Collection {
        #[serde(default)]
        label: Option<String>,
        items: Vec<Node>,
    },
    Action {
        key: i64,
        label: String,
    },
}

pub const SUPPORTED_VERSION: u32 = 1;

// Host-specific fields that must not appear (DOM, GTK, or geometry). Mirrors
// FORBIDDEN_KEYS in src/semantic-ui.js.
const FORBIDDEN_KEYS: &[&str] = &[
    "tagName", "cssClass", "className", "style", "css", "GtkWidget", "gtkWidget", "widget", "x",
    "y", "width", "height", "left", "top", "coordinates", "bounds", "geometry",
];

// Return the integral value of a JSON number, matching JS Number.isInteger
// semantics: accepts `1`, `1.0`, `1e3`, `-0` (all integral); rejects `1.5`,
// `-1.0`, non-numbers. serde's as_i64/as_u64 alone would reject float-typed
// tokens even when integral, which would drift from the JS validator.
fn integral_number(v: &serde_json::Value) -> Option<u64> {
    let f = v.as_f64()?;
    if f.is_finite() && f.fract() == 0.0 && f >= 0.0 {
        Some(f as u64)
    } else {
        None
    }
}

fn is_ref_like(v: &serde_json::Value) -> bool {
    if let serde_json::Value::Object(m) = v {
        m.get("objectId").is_some_and(|o| o.is_string())
            || m.get("kind").is_some_and(|k| k == "ref" || k == "pinned-ref")
            || m.get("imageId").is_some_and(|i| i.is_string())
    } else {
        false
    }
}

/// Validate the RAW JSON value first (for host-specific fields / smuggled refs,
/// which the typed struct would silently drop), then deserialize to the typed
/// document. Returns the typed document on success.
pub fn validate_and_parse(raw: &serde_json::Value) -> Result<SemanticUi, String> {
    let obj = raw
        .as_object()
        .ok_or_else(|| "the document must be a plain object".to_string())?;

    // Document-level host fields + refs (mirrors validateSemanticUi's doc scan).
    for (key, value) in obj {
        if FORBIDDEN_KEYS.contains(&key.as_str()) {
            return Err(format!(
                "document: host-specific field {key:?} is not allowed (semantic, not DOM/GTK/geometry)"
            ));
        }
        if is_ref_like(value) {
            return Err(format!("document.{key}: a ref/subject may not appear in a SemanticUi document"));
        }
    }

    if obj.get("kind").and_then(|k| k.as_str()) != Some("semantic-ui") {
        return Err(format!(
            "document.kind must be 'semantic-ui', got {:?}",
            obj.get("kind")
        ));
    }
    // Match the JS validator's semantics EXACTLY (CONFORMANCE NOTE): JSON has
    // one number type, so `1` and `1.0` are the same number. JS Number.isInteger
    // accepts integral-valued floats (1.0, 1e3); serde's as_u64/as_i64 reject
    // float-typed tokens regardless of integrality. To replicate the JS
    // semantics, accept any integral-valued finite number (as_f64 + fract==0),
    // rejecting only genuinely fractional/negative values — exactly like JS.
    let version = obj
        .get("version")
        .and_then(integral_number)
        .ok_or_else(|| "document.version must be an integer".to_string())?;
    if version != SUPPORTED_VERSION as u64 {
        return Err(format!(
            "unsupported version {version} (this host understands {SUPPORTED_VERSION})"
        ));
    }
    let root = obj
        .get("root")
        .ok_or_else(|| "document.root is required".to_string())?;
    validate_node_value(root, "root")?;

    // Now that the raw shape is validated, normalize integral-valued floats to
    // integers (so `version:1.0` / `key:1.0` deserialize to u32/i64, matching
    // the JS number model) and deserialize to the typed document.
    let normalized = normalize_numbers(raw.clone());
    serde_json::from_value(normalized).map_err(|e| format!("SemanticUi/v1 deserialize: {e}"))
}

// Recursively rewrite integral-valued floats to integers so the typed
// deserialize (which expects u32/i64) accepts `1.0` exactly as the JS number
// model does. Genuinely fractional values are left as-is (validation already
// rejected them where they are not allowed).
fn normalize_numbers(v: serde_json::Value) -> serde_json::Value {
    match v {
        serde_json::Value::Number(n) => {
            if let Some(f) = n.as_f64() {
                if f.is_finite() && f.fract() == 0.0 && f.abs() <= (i64::MAX as f64) {
                    return serde_json::Value::Number((f as i64).into());
                }
            }
            serde_json::Value::Number(n)
        }
        serde_json::Value::Array(a) => {
            serde_json::Value::Array(a.into_iter().map(normalize_numbers).collect())
        }
        serde_json::Value::Object(m) => serde_json::Value::Object(
            m.into_iter().map(|(k, v)| (k, normalize_numbers(v))).collect(),
        ),
        other => other,
    }
}

// Recursively validate the RAW JSON of a node: known shape, no host fields,
// no refs, action keys are non-negative integers. Unknown extra keys are
// tolerated (not recursed); children/items are recursed.
fn validate_node_value(node: &serde_json::Value, path: &str) -> Result<(), String> {
    let obj = node
        .as_object()
        .ok_or_else(|| format!("{path}: a node must be a plain object"))?;
    let kind = obj
        .get("kind")
        .and_then(|k| k.as_str())
        .ok_or_else(|| format!("{path}: node.kind must be a string"))?;

    for (key, value) in obj {
        if FORBIDDEN_KEYS.contains(&key.as_str()) {
            return Err(format!(
                "{path}.{kind}: host-specific field {key:?} is not allowed (semantic, not DOM/GTK/geometry)"
            ));
        }
        if is_ref_like(value) {
            return Err(format!(
                "{path}.{kind}.{key}: a ref/subject may not appear in a SemanticUi node (display data + descriptor-local keys only)"
            ));
        }
    }

    match kind {
        "group" => {
            let children = obj
                .get("children")
                .and_then(|c| c.as_array())
                .ok_or_else(|| format!("{path}.group.children must be an array"))?;
            for (i, child) in children.iter().enumerate() {
                validate_node_value(child, &format!("{path}.children[{i}]"))?;
            }
        }
        "text" => {
            if !obj.get("text").is_some_and(|t| t.is_string()) {
                return Err(format!("{path}.text.text must be a string"));
            }
        }
        "field" => {
            if !obj.get("label").is_some_and(|l| l.is_string()) {
                return Err(format!("{path}.field.label must be a string"));
            }
            if !obj.get("text").is_some_and(|t| t.is_string()) {
                return Err(format!("{path}.field.text must be a string"));
            }
        }
        "collection" => {
            let items = obj
                .get("items")
                .and_then(|c| c.as_array())
                .ok_or_else(|| format!("{path}.collection.items must be an array"))?;
            for (i, item) in items.iter().enumerate() {
                validate_node_value(item, &format!("{path}.items[{i}]"))?;
            }
        }
        "action" => {
            if !obj.get("label").is_some_and(|l| l.is_string()) {
                return Err(format!("{path}.action.label must be a string"));
            }
            // Same integral-number semantics as `version` (match JS).
            match obj.get("key").and_then(integral_number) {
                Some(_k) => {}
                _ => {
                    return Err(format!(
                        "{path}.action.key must be a non-negative integer (a descriptor-local item key)"
                    ))
                }
            }
        }
        other => {
            return Err(format!(
                "{path}: unknown node kind {other:?} (want group/text/field/collection/action)"
            ))
        }
    }
    Ok(())
}

/// Load + validate a SemanticUi document from a JSON string.
pub fn parse_semantic_ui(json: &str) -> Result<SemanticUi, String> {
    let raw: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("invalid JSON: {e}"))?;
    validate_and_parse(&raw)
}

/// The set of action keys present in the document (for tests).
pub fn action_keys(doc: &SemanticUi) -> BTreeSet<i64> {
    fn walk(node: &Node, out: &mut BTreeSet<i64>) {
        match node {
            Node::Group { children, .. } => children.iter().for_each(|c| walk(c, out)),
            Node::Collection { items, .. } => items.iter().for_each(|c| walk(c, out)),
            Node::Action { key, .. } => {
                out.insert(*key);
            }
            Node::Text { .. } | Node::Field { .. } => {}
        }
    }
    let mut out = BTreeSet::new();
    walk(&doc.root, &mut out);
    out
}
