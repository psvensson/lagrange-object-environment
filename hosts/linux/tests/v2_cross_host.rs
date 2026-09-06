//! CROSS-HOST PORTABILITY for SemanticUi/v2's transient input.
//!
//! This is a PORTABILITY proof, not two parallel test suites that happen to
//! assert similar things: it consumes the SAME checked-in fixture bytes the JS
//! side consumes, and asserts the SAME contract content — including the input
//! key derivation, which is the semantically interesting part.
//!
//! The reorder fixture is here deliberately. Keys follow ARRAY POSITION, so a
//! port that re-derived a key from an entry's content would produce a different
//! document from the same descriptor; with a single-input fixture the two
//! implementations would be indistinguishable.

use lagrange_host_linux::semantic_gtk::Intent;
use lagrange_host_linux::semantic_ui::{parse_semantic_ui, Node, SemanticUi};
use std::path::Path;

fn fixtures() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/semantic-ui")
}
fn read(name: &str) -> String {
    std::fs::read_to_string(fixtures().join(name)).unwrap_or_else(|e| panic!("read {name}: {e}"))
}

/// Every input node as (key, label, submit_label), in document order.
fn inputs(doc: &SemanticUi) -> Vec<(i64, String, String)> {
    fn walk(n: &Node, out: &mut Vec<(i64, String, String)>) {
        match n {
            Node::Group { children, .. } => children.iter().for_each(|c| walk(c, out)),
            Node::Collection { items, .. } => items.iter().for_each(|c| walk(c, out)),
            Node::Input { key, label, submit_label, .. } => {
                out.push((*key, label.clone(), submit_label.clone()))
            }
            _ => {}
        }
    }
    let mut out = Vec::new();
    walk(&doc.root, &mut out);
    out
}

#[test]
fn the_native_boundary_accepts_the_same_v2_fixture_bytes_the_js_boundary_does() {
    let doc = parse_semantic_ui(&read("v2-input.json")).expect("v2-input.json must parse natively");
    assert_eq!(doc.version, 2);
    assert_eq!(
        inputs(&doc),
        vec![(0, "Replacement source".to_string(), "Replace".to_string())]
    );
}

#[test]
fn input_keys_follow_array_position_across_the_native_boundary_too() {
    // The SAME reorder fixture the JS side reads. Gamma holds key 0 because it is
    // FIRST in the array, not because of anything about "gamma".
    let doc = parse_semantic_ui(&read("v2-input-reorder.json")).expect("reorder fixture parses");
    assert_eq!(doc.version, 2);
    assert_eq!(
        inputs(&doc),
        vec![
            (0, "Gamma".to_string(), "SC".to_string()),
            (1, "Beta".to_string(), "SB".to_string()),
            (2, "Alpha".to_string(), "SA".to_string()),
        ]
    );
}

#[test]
fn the_native_host_emits_the_canonical_submit_input_bytes_for_every_intent_fixture() {
    // The canonical intent fixtures are the SHARED ORACLE: the DOM lane fetches
    // the same files. Byte equality against them is what makes this portability
    // rather than two hosts agreeing with themselves.
    for name in [
        "intents/submit-input-empty.json",
        "intents/submit-input-unicode.json",
        "intents/submit-input-multiline.json",
    ] {
        let canonical: serde_json::Value =
            serde_json::from_str(&read(name)).unwrap_or_else(|e| panic!("{name}: {e}"));
        let key = canonical["key"].as_i64().expect("key");
        let text = canonical["text"].as_str().expect("text").to_string();

        let emitted = serde_json::to_value(Intent::submit_input(key, text.clone()))
            .expect("serialize the native intent");
        assert_eq!(
            emitted, canonical,
            "the native submit-input intent must serialize to the SAME bytes the DOM emits ({name})"
        );
        // RAW: the text crossed the boundary untouched. Each of these is
        // something a trimming/normalizing host would have silently destroyed.
        assert_eq!(emitted["text"].as_str().unwrap(), text);
    }
}

#[test]
fn an_empty_submission_still_carries_its_text_field_natively() {
    let v = serde_json::to_value(Intent::submit_input(0, String::new())).unwrap();
    assert!(
        v.get("text").is_some(),
        "absence of text must be unrepresentable: an EMPTY submission is not a MISSING one"
    );
    assert_eq!(v["text"], "");
}
