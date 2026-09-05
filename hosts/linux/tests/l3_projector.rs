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
        ("project.json", json!({"kind":"project","subject":{"kind":"project","imageId":"image-a","projectId":"project-alpha"},"parameters":{"project":{"format":"lagrange-project/v1","projectId":"project-alpha","name":"Alpha","namespace":{"kind":"ref","imageId":"image-a","objectId":"workspace"},"members":[{"key":"member/a","role":"source","target":{"kind":"ref","imageId":"image-a","objectId":"obj-a"}},{"key":"member/b","role":"dependency","target":{"kind":"ref","imageId":"image-b","objectId":"obj-b"}}]}}})),
        ("project-editable.json", json!({"kind":"project","subject":{"kind":"project","imageId":"image-a","projectId":"project-alpha"},"parameters":{"project":{"format":"lagrange-project/v1","projectId":"project-alpha","name":"Alpha","namespace":{"kind":"ref","imageId":"image-a","objectId":"workspace"},"members":[{"key":"member/a","role":"source","target":{"kind":"ref","imageId":"image-a","objectId":"obj-a"}},{"key":"member/b","role":"dependency","target":{"kind":"ref","imageId":"image-b","objectId":"obj-b"}}]},"writable":["name"]}})),
        ("native-class.json", json!({"kind":"native-class","subject":{"kind":"native-class","imageId":"img","classRef":ref_("smalltalk/class/BrowseChild")},"parameters":{"smalltalkClass":{"format":"smalltalk-class-description/v1","class":ref_("smalltalk/class/BrowseChild"),"name":"BrowseChild","side":"instance","superclass":ref_("smalltalk/class/BrowseBase"),"classSide":ref_("smalltalk/metaclass/BrowseChild"),"layout":{"instanceVariables":["baseValue","childFirst"],"indexed":"none"},"selectors":["childFirst","childSecond"],"provenance":null},"locators":[{"relation":"superclass","ref":ref_("smalltalk/class/BrowseBase")},{"relation":"class-side","ref":ref_("smalltalk/metaclass/BrowseChild")}]}})),
        ("native-method.json", json!({"kind":"native-method","subject":{"kind":"native-method","imageId":"img","classRef":ref_("smalltalk/class/BrowseChild"),"selector":"childFirst"},"parameters":{"smalltalkMethod":{"format":"smalltalk-method-description/v1","class":ref_("smalltalk/class/BrowseChild"),"side":"instance","selector":"childFirst","method":ref_("smalltalk/class/BrowseChild/method/Y2hpbGRGaXJzdA"),"source":null,"provenance":null}}})),
        ("unavailable.json", json!({"kind":"unavailable-reference","subject":ref_("obj-gone"),"parameters":{"reason":"not found"}})),
        ("unauthorized.json", json!({"kind":"unauthorized-reference","subject":ref_("obj-secret"),"parameters":{"reason":"denied"}})),
    ];
    // The corpus is the CROSS-HOST contract: a fixture only one projector checks
    // is a silent divergence. This binds the case list to the directory, exactly
    // as test/semantic-ui.test.js binds the JS case map.
    let mut covered: Vec<String> = cases.iter().map(|(name, _)| name.to_string()).collect();
    let mut on_disk: Vec<String> = std::fs::read_dir(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/semantic-ui"),
    )
    .expect("fixture dir")
    .filter_map(|entry| entry.ok())
    .filter(|entry| entry.file_type().map(|t| t.is_file()).unwrap_or(false))
    .map(|entry| entry.file_name().to_string_lossy().to_string())
    .filter(|name| name.ends_with(".json"))
    // Not a SemanticUi document: the canonical cross-host INTENT bytes.
    .filter(|name| name != "edit-field-intent.json")
    .collect();
    covered.sort();
    on_disk.sort();
    assert_eq!(
        covered, on_disk,
        "every green fixture needs a Rust projector case (and vice versa), or the two projectors can drift"
    );

    for (fixture, descriptor) in cases {
        let expected = parse_semantic_ui(&fixture_text(fixture)).expect("fixture validates");
        let projected = project(&descriptor).unwrap_or_else(|e| panic!("project({fixture}): {e}"));
        assert_eq!(projected, expected, "Rust projector must match {fixture} exactly");
    }
}

/// The two rules most easily collapsed by an independent port, checked directly
/// rather than only through the shared fixture (a fixture cannot catch either:
/// its `locators` agree with its description, and it carries one layout shape).
#[test]
fn native_class_port_indexes_locators_and_keeps_the_layout_distinction() {
    use lagrange_host_linux::semantic_ui::Node;

    let class_ref = ref_("smalltalk/class/BrowseChild");
    let describe = |layout: Option<Value>| {
        let mut record = json!({
            "format": "smalltalk-class-description/v1", "class": class_ref, "name": "BrowseChild",
            "side": "instance", "superclass": ref_("smalltalk/class/BrowseBase"),
            "classSide": ref_("smalltalk/metaclass/BrowseChild"),
            "selectors": [], "provenance": Value::Null,
        });
        // `None` means the key is ABSENT, which must answer exactly like an
        // explicit null; `Some(Value::Null)` is the explicit null.
        if let Some(layout) = layout {
            record["layout"] = layout;
        }
        record
    };
    let project_with = |layout: Option<Value>, locators: Value| {
        let descriptor = json!({
            "kind": "native-class",
            "subject": {"kind": "native-class", "imageId": "img", "classRef": class_ref},
            "parameters": {"smalltalkClass": describe(layout), "locators": locators},
        });
        project(&descriptor).expect("projects")
    };
    // Read the parsed document directly: SemanticUi is deliberately
    // Deserialize-only (it is a contract the host CONSUMES), so a test must walk
    // the enum rather than re-serialize it.
    let children = |doc: &lagrange_host_linux::semantic_ui::SemanticUi| -> Vec<Node> {
        match &doc.root {
            Node::Group { children, .. } => children.clone(),
            other => panic!("root must be a group, got {other:?}"),
        }
    };
    let field_texts = |doc: &lagrange_host_linux::semantic_ui::SemanticUi| -> Vec<String> {
        children(doc)
            .into_iter()
            .filter_map(|node| match node {
                Node::Field { label, text, .. } => Some(format!("{label}={text}")),
                _ => None,
            })
            .collect()
    };
    let collection_labels = |doc: &lagrange_host_linux::semantic_ui::SemanticUi| -> Vec<String> {
        children(doc)
            .into_iter()
            .filter_map(|node| match node {
                Node::Collection { label, .. } => Some(label.unwrap_or_default()),
                _ => None,
            })
            .collect()
    };

    // The locator rows come from the browser-owned ORDERED LIST. Re-deriving
    // them from superclass/classSide would make this port a second decider, and
    // would sprout rows here that the browser never offered.
    let no_locators = project_with(Some(Value::Null), json!([]));
    assert!(!collection_labels(&no_locators).contains(&"Locators".to_string()));
    let one_locator = project_with(
        Some(Value::Null),
        json!([{"relation": "superclass", "ref": ref_("smalltalk/class/BrowseBase")}]),
    );
    assert!(collection_labels(&one_locator).contains(&"Locators".to_string()));

    // `null`, an ABSENT key and `{instanceVariables: []}` are three inputs and
    // exactly TWO answers, identical to the JS projector's rule.
    let null_layout = field_texts(&no_locators);
    assert_eq!(null_layout.last().unwrap(), "Layout=(no declared instance layout)");
    let absent_layout = field_texts(&project_with(None, json!([])));
    assert_eq!(absent_layout, null_layout, "an absent layout key answers exactly like null");
    let empty_layout = field_texts(&project_with(
        Some(json!({"instanceVariables": [], "indexed": "none"})),
        json!([]),
    ));
    assert_eq!(&empty_layout[3..], ["Instance variables=".to_string(), "Indexed=none".to_string()]);
    assert_ne!(null_layout, empty_layout, "declaring NO layout is not declaring an EMPTY one");

    // Instance-variable names are COERCED, never filtered: JS `join(', ')`
    // String-coerces every entry, so dropping a non-string here would make the
    // two ports answer differently from the same bytes.
    let coerced = field_texts(&project_with(
        Some(json!({"instanceVariables": [1, "a"], "indexed": "none"})),
        json!([]),
    ));
    assert_eq!(coerced[3], "Instance variables=1, a");
}
