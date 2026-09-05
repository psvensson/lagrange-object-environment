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
    let smalltalk_class = params
        .get("smalltalkClass")
        .cloned()
        .unwrap_or(Value::Object(Map::new()));
    let smalltalk_method = params
        .get("smalltalkMethod")
        .cloned()
        .unwrap_or(Value::Object(Map::new()));

    let mut children: Vec<Value> = Vec::new();

    // Heading (explicit role).
    let heading = match kind {
        "navigator" => format!("Navigator: {object_id}"),
        "inspector" => format!("Inspector: {object_id}"),
        "project" => format!(
            "Project: {}",
            project.get("name").and_then(|n| n.as_str()).unwrap_or("")
        ),
        "native-class" => format!(
            "Class: {}",
            smalltalk_class.get("name").and_then(|n| n.as_str()).unwrap_or("")
        ),
        "native-method" => format!(
            "Method: {}",
            smalltalk_method.get("selector").and_then(|s| s.as_str()).unwrap_or("")
        ),
        _ => kind.to_string(), // unavailable-reference | unauthorized-reference
    };
    children.push(json!({"kind": "text", "role": "heading", "text": heading}));

    if kind == "project" {
        // Editable Project fields come from the threaded `writable` set (Project
        // FIELD NAMES, not slot ids); an editable field's key is its index in that
        // array — mirroring semanticUiForPresentation EXACTLY.
        let empty_writable: Vec<Value> = Vec::new();
        let project_writable: Vec<&str> = params
            .get("writable")
            .and_then(|w| w.as_array())
            .unwrap_or(&empty_writable)
            .iter()
            .filter_map(|s| s.as_str())
            .collect();
        let name_text = project.get("name").map(value_text).unwrap_or_default();
        match project_writable.iter().position(|f| *f == "name") {
            Some(name_key) => children.push(json!({
                "kind": "field", "label": "Name", "text": name_text, "key": name_key as i64, "editable": "text",
            })),
            None => children.push(json!({"kind": "field", "label": "Name", "text": name_text})),
        }
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
    } else if kind == "native-class" {
        // The authorized native Smalltalk class description (Images ADR 0087).
        // Its selector and relation rows are ACTIONS keyed by position in the one
        // browser-owned target array (Bead gzz); everything else is display text.
        children.push(json!({
            "kind": "field",
            "label": "Name",
            "text": smalltalk_class.get("name").map(value_text).unwrap_or_default(),
        }));
        children.push(json!({
            "kind": "field",
            "label": "Side",
            "text": smalltalk_class.get("side").map(value_text).unwrap_or_default(),
        }));
        children.push(json!({
            "kind": "field",
            "label": "Class",
            "text": smalltalk_class.get("class").map(value_text).unwrap_or_default(),
        }));
        // LAYOUT: `null` and `{instanceVariables: []}` are DIFFERENT answers and
        // must stay different documents. An ABSENT `layout` key is treated
        // exactly like `null` — `.get()` yielding None and an explicit
        // Value::Null take the same branch, matching the JS `?? null`.
        match smalltalk_class.get("layout") {
            None | Some(Value::Null) => children.push(json!({
                "kind": "field", "label": "Layout", "text": "(no declared instance layout)",
            })),
            Some(layout) => {
                let empty_vars: Vec<Value> = Vec::new();
                // COERCE each entry, never filter: the JS projector renders this
                // with `instanceVariables.join(', ')`, which String-coerces every
                // element, so DROPPING a non-string here would make the two ports
                // answer differently from the same bytes — the exact divergence
                // this port exists to avoid.
                //
                // The coercions agree for every value Images can put here — an
                // instance-variable name is a string — and for integers, bools
                // and null. They do NOT agree for floats (`1.0` -> "1" in JS,
                // "1.0" here), objects or arrays, because `value_text` is a JSON
                // renderer and `String()` is not. That is unreachable from a
                // class description; the rule that matters is coerce-not-drop.
                let instance_variables: Vec<String> = layout
                    .get("instanceVariables")
                    .and_then(|v| v.as_array())
                    .unwrap_or(&empty_vars)
                    .iter()
                    .map(value_text)
                    .collect();
                children.push(json!({
                    "kind": "field",
                    "label": "Instance variables",
                    "text": instance_variables.join(", "),
                }));
                children.push(json!({
                    "kind": "field",
                    "label": "Indexed",
                    "text": layout.get("indexed").map(value_text).unwrap_or_default(),
                }));
            }
        }
        // ACTIONS OVER THE ONE BROWSER-OWNED TARGET ARRAY, a literal port of the
        // JS projector's rule. The array is ENUMERATED ONCE with its index, and
        // the index IS the action key; groups only BUCKET rows for display. This
        // port performs no offset arithmetic and — critically — never RESOLVES a
        // target: it does not reconstruct {classRef, selector}, does not decide
        // class-versus-method, and does not twin `descriptor_references` below.
        // There is ONE Environment semantic resolver and it is in JS; GTK emits
        // the descriptor-local key and pushes it to the guest.
        let empty_targets: Vec<Value> = Vec::new();
        let targets = params
            .get("targets")
            .and_then(|t| t.as_array())
            .unwrap_or(&empty_targets);
        // Insertion-ordered buckets: selector, relation, then any unrecognized
        // group in first-seen order. An unknown group is never dropped, and an
        // empty bucket is omitted entirely.
        let mut buckets: Vec<(&str, Vec<Value>)> =
            vec![("selector", Vec::new()), ("relation", Vec::new()), ("other", Vec::new())];
        for (key, entry) in targets.iter().enumerate() {
            let group = entry.get("group").and_then(|g| g.as_str()).unwrap_or("other");
            let action = json!({
                "kind": "action",
                "key": key,
                "label": entry.get("label").map(value_text).unwrap_or_default(),
            });
            // Every UNRECOGNIZED group shares the ONE trailing bucket, never one
            // bucket per unknown group (which would emit several collections all
            // labelled 'Other'). Nothing is dropped; both ports answer alike.
            let slot = buckets
                .iter()
                .position(|(name, _)| *name == group)
                .unwrap_or(buckets.len() - 1);
            buckets[slot].1.push(action);
        }
        for (group, items) in buckets {
            if items.is_empty() {
                continue;
            }
            let label = match group {
                "selector" => "Selectors",
                "relation" => "Relations",
                _ => "Other",
            };
            children.push(json!({"kind": "collection", "label": label, "items": items}));
        }
        // `provenance` is deliberately NOT rendered; Images owns no durable
        // native-class provenance today (Images jtz.1).
    } else if kind == "native-method" {
        // The authorized native Smalltalk METHOD description (Images ADR 0087).
        // `source` and `provenance` are truthful ABSENCES and their rows are
        // OMITTED, exactly as the JS projector omits them: an empty row would
        // suggest a durable field exists.
        children.push(json!({
            "kind": "field",
            "label": "Selector",
            "text": smalltalk_method.get("selector").map(value_text).unwrap_or_default(),
        }));
        children.push(json!({
            "kind": "field",
            "label": "Side",
            "text": smalltalk_method.get("side").map(value_text).unwrap_or_default(),
        }));
        children.push(json!({
            "kind": "field",
            "label": "Declaring class",
            "text": smalltalk_method.get("class").map(value_text).unwrap_or_default(),
        }));
        children.push(json!({
            "kind": "field",
            "label": "Method",
            "text": smalltalk_method.get("method").map(value_text).unwrap_or_default(),
        }));
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
