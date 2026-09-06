use lagrange_host_linux::semantic_ui::parse_semantic_ui;

const INPUT: &str = r#"{"kind":"input","key":0,"label":"Replacement source","valueKind":"text","submitLabel":"Replace"}"#;
fn doc(v: u32) -> String {
    format!(r#"{{"kind":"semantic-ui","version":{v},"root":{{"kind":"group","title":"x","children":[{INPUT}]}}}}"#)
}

#[test]
fn the_same_input_node_is_red_under_v1_and_green_under_v2() {
    let v1 = parse_semantic_ui(&doc(1));
    assert!(v1.is_err(), "v1 accepted an input node: the serde tagged enum bypassed the version gate");
    let msg = v1.unwrap_err();
    assert!(msg.contains("unknown node kind \"input\" in SemanticUi/v1"), "wrong reason: {msg}");
    parse_semantic_ui(&doc(2)).expect("v2 must accept the SAME node");
    assert!(parse_semantic_ui(&doc(3)).is_err(), "an unsupported version must still be loud");
}

#[test]
fn an_input_may_not_carry_a_current_value() {
    for bad in ["text", "value", "currentValue", "editable"] {
        let node = format!(
            r#"{{"kind":"input","key":0,"label":"L","valueKind":"text","submitLabel":"S","{bad}":"x"}}"#
        );
        let d = format!(r#"{{"kind":"semantic-ui","version":2,"root":{{"kind":"group","children":[{node}]}}}}"#);
        let e = parse_semantic_ui(&d).expect_err(&format!("{bad} was accepted"));
        assert!(e.contains(&format!("input.{bad} is not allowed")), "wrong reason for {bad}: {e}");
    }
}

#[test]
fn a_submit_input_intent_always_carries_its_text() {
    use lagrange_host_linux::semantic_gtk::Intent;
    let empty = serde_json::to_string(&Intent::submit_input(0, String::new())).unwrap();
    assert_eq!(empty, r#"{"kind":"submit-input","key":0,"text":""}"#,
        "an EMPTY submitted value must still serialize its text field");
}

// --- Key derivation: POSITION, never content (the E2 lesson) ---------------

use lagrange_host_linux::projector::project;
use lagrange_host_linux::semantic_ui::Node;
use serde_json::json;

fn descriptor_with(inputs: serde_json::Value) -> serde_json::Value {
    json!({
        "kind": "object",
        "subject": {"objectId": "o"},
        "parameters": {"fields": {}, "inputs": inputs},
    })
}

fn input_pairs(doc: &lagrange_host_linux::semantic_ui::SemanticUi) -> Vec<(i64, String)> {
    fn walk(n: &Node, out: &mut Vec<(i64, String)>) {
        match n {
            Node::Group { children, .. } => children.iter().for_each(|c| walk(c, out)),
            Node::Collection { items, .. } => items.iter().for_each(|c| walk(c, out)),
            Node::Input { key, label, .. } => out.push((*key, label.clone())),
            _ => {}
        }
    }
    let mut out = Vec::new();
    walk(&doc.root, &mut out);
    out
}

#[test]
fn the_native_port_reads_input_position_and_never_re_derives_a_key() {
    let a = json!({"role": "alpha", "label": "Alpha", "submitLabel": "SA"});
    let b = json!({"role": "beta", "label": "Beta", "submitLabel": "SB"});
    let c = json!({"role": "gamma", "label": "Gamma", "submitLabel": "SC"});

    let forward = project(&descriptor_with(json!([a, b, c]))).expect("forward");
    assert_eq!(
        input_pairs(&forward),
        vec![
            (0, "Alpha".to_string()),
            (1, "Beta".to_string()),
            (2, "Gamma".to_string())
        ]
    );

    // REVERSING the array must reverse which label holds which key. A key
    // hard-coded to 0, or derived from the entry's role/label, cannot pass both
    // halves -- which is the whole point, since a one-element array could not
    // tell the two implementations apart.
    let reversed = project(&descriptor_with(json!([c, b, a]))).expect("reversed");
    assert_eq!(
        input_pairs(&reversed),
        vec![
            (0, "Gamma".to_string()),
            (1, "Beta".to_string()),
            (2, "Alpha".to_string())
        ]
    );
}

#[test]
fn a_descriptor_without_inputs_still_projects_as_v1() {
    let doc = project(&json!({
        "kind": "object", "subject": {"objectId": "o"}, "parameters": {"fields": {}}
    }))
    .expect("project");
    assert_eq!(doc.version, 1, "a document gains v2 only by USING a v2 capability");
    assert!(input_pairs(&doc).is_empty());
}

#[test]
fn an_input_carrying_descriptor_projects_as_v2_and_leaks_no_role() {
    let doc = project(&descriptor_with(
        json!([{"role": "replacement-source", "label": "Replacement source", "submitLabel": "Replace"}]),
    ))
    .expect("project");
    assert_eq!(doc.version, 2);
    let raw = serde_json::to_string(&input_pairs(&doc)).unwrap();
    assert!(!raw.contains("replacement-source"), "the semantic role leaked into the document");
}

#[test]
fn every_v1_node_kind_is_still_legal_under_v2() {
    // `kinds(v2) = kinds(v1) + {input}` asserted DIRECTLY, not inferred from a
    // corpus. A review shrank the v2 table to ["group","text","input"] and the
    // entire native suite stayed green, because no checked-in v2 fixture contains
    // a field, collection or action node -- so a v2 document valid in JS would
    // have been rejected here, the exact cross-host divergence the shared corpus
    // exists to prevent.
    for kind in ["group", "text", "field", "collection", "action"] {
        let node = match kind {
            "group" => r#"{"kind":"group","children":[]}"#.to_string(),
            "text" => r#"{"kind":"text","text":"t"}"#.to_string(),
            "field" => r#"{"kind":"field","label":"L","text":"v"}"#.to_string(),
            "collection" => r#"{"kind":"collection","items":[]}"#.to_string(),
            _ => r#"{"kind":"action","key":0,"label":"a"}"#.to_string(),
        };
        for version in [1, 2] {
            let doc = format!(
                r#"{{"kind":"semantic-ui","version":{version},"root":{{"kind":"group","children":[{node}]}}}}"#
            );
            parse_semantic_ui(&doc)
                .unwrap_or_else(|e| panic!("a {kind} node must be legal under v{version}: {e}"));
        }
    }
}
