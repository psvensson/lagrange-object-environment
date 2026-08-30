//! The Rust projector conforms to the JS projector (src/semantic-ui.js): the
//! SAME presentationDescriptor produces the SAME SemanticUi/v1 document — the
//! checked-in fixtures are the canonical corpus.

use lagrange_host_linux::projector::project;
use lagrange_host_linux::semantic_ui::parse_semantic_ui;
use serde_json::{json, Value};
use std::path::Path;

fn fixture_text(name: &str) -> String {
    std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/semantic-ui").join(name),
    )
    .unwrap()
}

fn ref_(o: &str) -> Value {
    json!({"kind":"ref","imageId":"img","objectId":o})
}

#[test]
fn rust_projector_matches_the_checked_in_fixtures() {
    let cases: Vec<(&str, Value)> = vec![
        ("navigator.json", json!({"kind":"navigator","subject":ref_("obj-root"),"parameters":{"fields":{"slot-title":{"kind":"text","value":"Root"}},"references":[ref_("obj-b"),ref_("obj-c")]}})),
        ("inspector.json", json!({"kind":"inspector","subject":ref_("obj-b"),"parameters":{"fields":{"slot-title":{"kind":"text","value":"B"},"slot-count":{"kind":"int","value":17}},"writable":["slot-title"],"references":[ref_("obj-c")]}})),
        ("unavailable.json", json!({"kind":"unavailable-reference","subject":ref_("obj-gone"),"parameters":{"reason":"not found"}})),
        ("unauthorized.json", json!({"kind":"unauthorized-reference","subject":ref_("obj-secret"),"parameters":{"reason":"denied"}})),
    ];
    for (fixture, descriptor) in cases {
        let expected = parse_semantic_ui(&fixture_text(fixture)).expect("fixture validates");
        let projected = project(&descriptor).unwrap_or_else(|e| panic!("project({fixture}): {e}"));
        assert_eq!(projected, expected, "Rust projector must match {fixture} exactly");
    }
}
