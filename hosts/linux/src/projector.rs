//! The Rust projector: presentationDescriptor -> SemanticUi/v1 document.
//!
//! Mirrors `semanticUiForPresentation` in src/semantic-ui.js EXACTLY (the
//! single authoritative contract owner). The SemanticUi description is
//! host-neutral; this projector lets the NATIVE host produce the same document
//! from the same descriptor the browser projects — so the GTK realizer and the
//! DOM realizer consume the identical description from the identical
//! descriptor. It re-implements the projector (which is small and pure) rather
//! than re-deciding semantics: the vocabulary, the heading/reason composition,
//! the valueText normalization, reference/member rows->action(key) mapping and
//! Project summary are a literal port, conformance-tested against the SAME
//! checked-in fixture corpus the JS projector is tested against.

use crate::semantic_ui::{validate_and_parse, SemanticUi};
use serde_json::{json, Map, Value};

/// valueText: leaf Value -> display text (literal port of src/semantic-ui.js).
fn value_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Object(m) => {
            if let Some(Value::String(s)) = m.get("value") {
                return s.clone();
            }
            if let Some(v) = m.get("value") {
                if v.is_number() || v.is_boolean() {
                    return match v {
                        Value::Number(n) => n.to_string(),
                        Value::Bool(b) => b.to_string(),
                        _ => unreachable!(),
                    };
                }
            }
            let kind = m.get("kind").and_then(|k| k.as_str());
            if kind == Some("ref") || kind == Some("pinned-ref") {
                if let Some(oid) = m.get("objectId").and_then(|o| o.as_str()) {
                    return format!("-> {oid}");
                }
            }
            if let Some(oid) = m.get("objectId").and_then(|o| o.as_str()) {
                return format!("-> {oid}");
            }
            // String(value) fallback: a JSON object stringifies (rare; matches
            // JS String({...}) only loosely — fixtures never hit this).
            value.to_string()
        }
        other => other.to_string(),
    }
}

/// Project a presentationDescriptor (plain JSON: {kind, subject, parameters})
/// to a validated SemanticUi/v1 document. Literal port of
/// semanticUiForPresentation.
pub fn project(descriptor: &Value) -> Result<SemanticUi, String> {
    let kind = descriptor.get("kind").and_then(|k| k.as_str()).unwrap_or("");
    let params = descriptor.get("parameters").cloned().unwrap_or(Value::Object(Map::new()));
    let subject = descriptor.get("subject").cloned().unwrap_or(Value::Object(Map::new()));
    let object_id = subject.get("objectId").and_then(|o| o.as_str()).unwrap_or("");
    let project = params.get("project").cloned().unwrap_or(Value::Object(Map::new()));

    let mut children: Vec<Value> = Vec::new();

    // Heading (explicit role).
    let heading = match kind {
        "navigator" => format!("Navigator: {object_id}"),
        "inspector" => format!("Inspector: {object_id}"),
        "project" => format!(
            "Project: {}",
            project.get("name").and_then(|n| n.as_str()).unwrap_or("")
        ),
        _ => kind.to_string(), // unavailable-reference | unauthorized-reference
    };
    children.push(json!({"kind": "text", "role": "heading", "text": heading}));

    if kind == "project" {
        children.push(json!({
            "kind": "field",
            "label": "Project ID",
            "text": project.get("projectId").map(value_text).unwrap_or_default(),
        }));
        children.push(json!({
            "kind": "field",
            "label": "Namespace",
            "text": project.get("namespace").map(value_text).unwrap_or_default(),
        }));
        let empty_members: Vec<Value> = Vec::new();
        let members = project.get("members").and_then(|m| m.as_array()).unwrap_or(&empty_members);
        if !members.is_empty() {
            let items: Vec<Value> = members
                .iter()
                .enumerate()
                .map(|(index, member)| {
                    let member_key = member
                        .get("key")
                        .and_then(|k| k.as_str())
                        .map(|key| key.to_string())
                        .unwrap_or_else(|| index.to_string());
                    let role = member.get("role").and_then(|r| r.as_str()).unwrap_or("");
                    let image_id = member
                        .get("target")
                        .and_then(|t| t.get("imageId"))
                        .and_then(|i| i.as_str())
                        .unwrap_or("");
                    let target_object_id = member
                        .get("target")
                        .and_then(|t| t.get("objectId"))
                        .and_then(|o| o.as_str())
                        .unwrap_or("");
                    json!({
                        "kind": "action",
                        "key": index,
                        "label": format!("{member_key} [{role}] -> {image_id}/{target_object_id}"),
                    })
                })
                .collect();
            children.push(json!({"kind": "collection", "label": "Members", "items": items}));
        }
    } else if kind == "unavailable-reference" || kind == "unauthorized-reference" {
        let base = if kind == "unauthorized-reference" { "Not authorized" } else { "Unavailable" };
        let reason = match params.get("reason").and_then(|r| r.as_str()) {
            Some(r) => format!("{base}: {object_id} ({r})"),
            None => format!("{base}: {object_id}"),
        };
        children.push(json!({"kind": "text", "role": "reason", "text": reason}));
    } else {
        // Fields (slot -> display text), in insertion order. A slot in the
        // host-neutral `writable` set (threaded as parameters.writable) is
        // editable: it carries a descriptor-local key + editable:'text' —
        // mirroring semanticUiForPresentation EXACTLY. Others are read-only.
        let empty_writable: Vec<Value> = Vec::new();
        let writable: Vec<&str> = params
            .get("writable")
            .and_then(|w| w.as_array())
            .unwrap_or(&empty_writable)
            .iter()
            .filter_map(|s| s.as_str())
            .collect();
        let mut field_key: i64 = 0;
        if let Some(fields) = params.get("fields").and_then(|f| f.as_object()) {
            for (slot, val) in fields {
                if writable.contains(&slot.as_str()) {
                    children.push(json!({"kind": "field", "label": slot, "text": value_text(val), "key": field_key, "editable": "text"}));
                    field_key += 1;
                } else {
                    children.push(json!({"kind": "field", "label": slot, "text": value_text(val)}));
                }
            }
        }
        // References -> a collection of descriptor-local actions.
        let empty: Vec<Value> = Vec::new();
        let references = params.get("references").and_then(|r| r.as_array()).unwrap_or(&empty);
        if !references.is_empty() {
            let items: Vec<Value> = references
                .iter()
                .enumerate()
                .map(|(index, r)| {
                    let label = r
                        .get("objectId")
                        .and_then(|o| o.as_str())
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| index.to_string());
                    json!({"kind": "action", "key": index, "label": label})
                })
                .collect();
            children.push(json!({"kind": "collection", "label": "References", "items": items}));
        }
    }

    let doc = json!({
        "kind": "semantic-ui",
        "version": 1,
        "root": {"kind": "group", "title": heading, "children": children},
    });
    validate_and_parse(&doc)
}

/// Collect the descriptor-local references of a descriptor (for the fixture's
/// key->ref resolution, replicating EnvironmentShell.handleActivateItem).
pub fn descriptor_references(descriptor: &Value) -> Vec<Value> {
    descriptor
        .get("parameters")
        .and_then(|p| p.get("references"))
        .and_then(|r| r.as_array())
        .cloned()
        .unwrap_or_default()
}

// Re-export for the adapter/tests.
pub use crate::semantic_ui::Node as SemanticNode;
