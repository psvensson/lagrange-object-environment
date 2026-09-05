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
        ("native-class.json", json!({"kind":"native-class","subject":{"kind":"native-class","imageId":"img","classRef":ref_("smalltalk/class/BrowseChild")},"parameters":{"smalltalkClass":{"format":"smalltalk-class-description/v1","class":ref_("smalltalk/class/BrowseChild"),"name":"BrowseChild","side":"instance","superclass":ref_("smalltalk/class/BrowseBase"),"classSide":ref_("smalltalk/metaclass/BrowseChild"),"layout":{"instanceVariables":["baseValue","childFirst"],"indexed":"none"},"selectors":["childFirst","childSecond"],"provenance":null},"targets":[{"target":{"kind":"native-method","imageId":"img","classRef":ref_("smalltalk/class/BrowseChild"),"selector":"childFirst"},"group":"selector","label":"childFirst"},{"target":{"kind":"native-method","imageId":"img","classRef":ref_("smalltalk/class/BrowseChild"),"selector":"childSecond"},"group":"selector","label":"childSecond"},{"target":{"kind":"native-class","imageId":"img","classRef":ref_("smalltalk/class/BrowseBase")},"group":"relation","label":"superclass -> img/smalltalk/class/BrowseBase"},{"target":{"kind":"native-class","imageId":"img","classRef":ref_("smalltalk/metaclass/BrowseChild")},"group":"relation","label":"class-side -> img/smalltalk/metaclass/BrowseChild"}]}})),
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

/// The rules most easily collapsed by an independent port, checked directly
/// rather than only through the shared fixture.
#[test]
fn native_class_port_keys_one_target_array_and_keeps_the_layout_distinction() {
    use lagrange_host_linux::semantic_ui::Node;

    let class_ref = ref_("smalltalk/class/BrowseChild");
    let describe = |layout: Option<Value>| {
        let mut record = json!({
            "format": "smalltalk-class-description/v1", "class": class_ref, "name": "BrowseChild",
            "side": "instance", "superclass": ref_("smalltalk/class/BrowseBase"),
            "classSide": ref_("smalltalk/metaclass/BrowseChild"),
            "selectors": ["childFirst"], "provenance": Value::Null,
        });
        // `None` means the key is ABSENT, which must answer exactly like an
        // explicit null; `Some(Value::Null)` is the explicit null.
        if let Some(layout) = layout {
            record["layout"] = layout;
        }
        record
    };
    let project_with = |layout: Option<Value>, targets: Value| {
        let descriptor = json!({
            "kind": "native-class",
            "subject": {"kind": "native-class", "imageId": "img", "classRef": class_ref},
            "parameters": {"smalltalkClass": describe(layout), "targets": targets},
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
    let collections = |doc: &lagrange_host_linux::semantic_ui::SemanticUi| -> Vec<(String, Vec<(i64, String)>)> {
        children(doc)
            .into_iter()
            .filter_map(|node| match node {
                Node::Collection { label, items } => Some((
                    label.unwrap_or_default(),
                    items
                        .into_iter()
                        .map(|item| match item {
                            Node::Action { key, label } => (key, label),
                            other => panic!("a native-class collection holds only actions, got {other:?}"),
                        })
                        .collect(),
                )),
                _ => None,
            })
            .collect()
    };

    let selector_target = json!({"target": {"kind": "native-method", "imageId": "img", "classRef": class_ref, "selector": "childFirst"}, "group": "selector", "label": "childFirst"});
    let relation_target = json!({"target": {"kind": "native-class", "imageId": "img", "classRef": ref_("smalltalk/class/BrowseBase")}, "group": "relation", "label": "superclass -> img/smalltalk/class/BrowseBase"});

    // ONE KEY SPACE ACROSS TWO COLLECTIONS. The keys are positions in the single
    // array, so a selector row and a relation row can never share an integer.
    // Asserted as a BIJECTION onto 0..n-1, because GtkRealization::activate is
    // find-first-by-key and a duplicate would silently activate the wrong row.
    let mixed = project_with(Some(Value::Null), json!([selector_target, relation_target]));
    let mixed_collections = collections(&mixed);
    assert_eq!(
        mixed_collections.iter().map(|(label, _)| label.as_str()).collect::<Vec<_>>(),
        vec!["Selectors", "Relations"],
        "bucket order is pinned: selectors, then relations"
    );
    let mut keys: Vec<i64> = mixed_collections.iter().flat_map(|(_, items)| items.iter().map(|(k, _)| *k)).collect();
    keys.sort_unstable();
    assert_eq!(keys, vec![0, 1], "every action key is a distinct index into the ONE array");
    assert_eq!(mixed_collections[0].1[0], (0, "childFirst".to_string()));
    assert_eq!(mixed_collections[1].1[0], (1, "superclass -> img/smalltalk/class/BrowseBase".to_string()));

    // Reversing the ARRAY reverses both the keys and the buckets they land in:
    // the port reads position, never re-derives from selectors/superclass.
    let reversed = collections(&project_with(Some(Value::Null), json!([relation_target, selector_target])));
    assert_eq!(reversed[0].1[0], (1, "childFirst".to_string()), "the selector now sits at index 1");
    assert_eq!(reversed[1].1[0], (0, "superclass -> img/smalltalk/class/BrowseBase".to_string()));

    // An EMPTY bucket is omitted entirely; an UNKNOWN group is never dropped.
    let selectors_only = collections(&project_with(Some(Value::Null), json!([selector_target])));
    assert_eq!(selectors_only.iter().map(|(l, _)| l.as_str()).collect::<Vec<_>>(), vec!["Selectors"]);
    let unknown = json!({"target": {"kind": "native-class", "imageId": "img", "classRef": class_ref}, "group": "future", "label": "f"});
    let with_unknown = collections(&project_with(Some(Value::Null), json!([selector_target, unknown])));
    assert_eq!(
        with_unknown.iter().map(|(l, _)| l.as_str()).collect::<Vec<_>>(),
        vec!["Selectors", "Other"],
        "an unrecognized group goes to one trailing bucket, never dropped"
    );
    assert!(collections(&project_with(Some(Value::Null), json!([]))).is_empty());

    // `null`, an ABSENT key and `{instanceVariables: []}` are three inputs and
    // exactly TWO answers, identical to the JS projector's rule.
    let null_layout = field_texts(&project_with(Some(Value::Null), json!([])));
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

/// An action node carries EXACTLY {kind, key, label}. The SemanticUi validator
/// rejects a nested ref/subject but TOLERATES an unknown scalar property, so a
/// leaked `selector` or `relation` string would cross the renderer boundary
/// unnoticed. Asserted on the serialized fixture bytes, which is what both hosts
/// actually consume.
#[test]
fn native_class_action_nodes_carry_only_kind_key_and_label() {
    let raw: serde_json::Value =
        serde_json::from_str(&fixture_text("native-class.json")).expect("fixture parses");
    fn walk(node: &serde_json::Value, out: &mut Vec<serde_json::Value>) {
        if node.get("kind").and_then(|k| k.as_str()) == Some("action") {
            out.push(node.clone());
        }
        for key in ["children", "items"] {
            for child in node.get(key).and_then(|c| c.as_array()).unwrap_or(&Vec::new()) {
                walk(child, out);
            }
        }
    }
    let mut actions = Vec::new();
    walk(&raw["root"], &mut actions);
    assert!(actions.len() >= 2, "the fixture must carry actions from BOTH groups");
    for action in &actions {
        let mut keys: Vec<&String> = action.as_object().expect("action is an object").keys().collect();
        keys.sort();
        assert_eq!(
            keys,
            vec!["key", "kind", "label"],
            "an action may carry no target, ref, selector or relation: {action}"
        );
    }
}

/// TOOL_KIND PARITY. The two hosts keep separate lists (Rust cannot read a JS
/// array at compile time), so a kind admitted by one and not the other would be
/// realized as semantic tool UI in the browser and routed to the Component
/// realizer natively — the same descriptor producing two different
/// realizations. This pins them equal by reading the JS source, the same shape
/// the fixture-coverage guard above uses to read a directory. It is a narrow
/// parity proof, deliberately not a shared kind registry for a handful of
/// entries.
#[test]
fn tool_kinds_agree_between_the_browser_and_native_hosts() {
    let js = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/browser-renderer/dom-realizer.js"),
    )
    .expect("the browser realizer must be readable");
    let start = js.find("const TOOL_KINDS = Object.freeze([").expect("TOOL_KINDS literal");
    let body = &js[start..];
    let end = body.find("]);").expect("TOOL_KINDS terminator");
    let mut browser_kinds: Vec<String> = body[..end]
        .split('\'')
        .skip(1)
        .step_by(2)
        .map(str::to_string)
        .collect();
    let mut native_kinds: Vec<String> = lagrange_host_linux::linux_adapter::tool_kinds()
        .iter()
        .map(|k| k.to_string())
        .collect();
    assert!(
        browser_kinds.contains(&"native-class".to_string()),
        "parse check: the browser list must be non-vacuous, got {browser_kinds:?}"
    );
    browser_kinds.sort();
    native_kinds.sort();
    assert_eq!(browser_kinds, native_kinds, "both hosts must admit exactly the same tool kinds");
}

/// STRUCTURAL NEGATIVE: there is ONE Environment semantic resolver, and it is in
/// JS. The Rust projector may group, label and emit descriptor-local keys; it
/// must never RESOLVE what a native target means.
///
/// This matters because `descriptor_references` already reconstructs refs
/// Rust-side ("replicating EnvironmentShell.handleActivateItem"), so a
/// `descriptor_targets` twin is the natural next step for an implementer — and
/// two resolvers that happen to agree today are exactly the drift the
/// single-owner rule forbids.
#[test]
fn the_native_host_never_resolves_a_semantic_target() {
    let projector_src = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/projector.rs"),
    )
    .expect("the Rust projector must be readable");

    // The native-class branch is where the target array is consumed. It must read
    // ONLY each entry's display fields: `group` decides the bucket and `label` is
    // rendered. Reaching into `target` — or touching a `classRef` — would make
    // this port a second resolver of semantic identity.
    let branch_start = projector_src
        .find(r#"} else if kind == "native-class" {"#)
        .expect("the native-class branch must exist");
    let rest = &projector_src[branch_start + 10..];
    let branch_end = rest.find("} else if kind ==").expect("the branch must be followed by another");
    let branch: String = rest[..branch_end]
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n");
    // NOTE the singular/plural distinction: iterating `targets` (the array) is
    // the whole job; reaching into an entry's `target` would be resolution.
    // `pointer("/target/selector")` would evade a plain `get("target")` check, so
    // the pointer API is forbidden in this branch outright.
    for forbidden in [r#"get("target")"#, r#"["target"]"#, "classRef", r#"get("selector")"#, "pointer("] {
        assert!(
            !branch.contains(forbidden),
            "the native-class branch must not read {forbidden}: it renders group and label only"
        );
    }
    assert!(branch.contains("\"group\"") && branch.contains("\"label\""), "parse check: the branch reads group and label");

    // And a classRef never appears anywhere in the native host: that identity is
    // Images-owned and only the JS resolver hands it on.
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut offenders: Vec<String> = Vec::new();
    fn walk(dir: &std::path::Path, offenders: &mut Vec<String>) {
        for entry in std::fs::read_dir(dir).expect("readable src dir") {
            let entry = entry.expect("dir entry");
            let path = entry.path();
            if path.is_dir() {
                walk(&path, offenders);
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                continue;
            }
            let source = std::fs::read_to_string(&path).expect("readable source");
            for (number, line) in source.lines().enumerate() {
                if line.trim_start().starts_with("//") {
                    continue;
                }
                if line.contains("classRef") {
                    offenders.push(format!("{}:{}", path.display(), number + 1));
                }
            }
        }
    }
    walk(&root, &mut offenders);
    assert_eq!(offenders, Vec::<String>::new(), "no native-host code may name a classRef");
}
