//! L2b cross-host identity proof (Bead 92h / ADR 0013): the SAME checked-in
//! SemanticUi/v1 fixtures that drive the browser DOM realizer ALSO drive a REAL
//! GTK4 realization — with identical interaction semantics. This is the
//! semantic-UI analogue of L1's browser-hash == native-hash.
//!
//! The fixtures are consumed READ-ONLY from test/fixtures/semantic-ui/ (the
//! canonical cross-host corpus). The GTK realizer builds real GTK4 controls
//! (no on-screen window required); a programmatic `emit_clicked` on an action
//! button emits the EXACT same plain-data intent {kind:'activate-item', key}
//! as a DOM button click.
//!
//! Headless: gtk4::init() runs under Xvfb (GDK X11 backend, Cairo renderer).
//! GTK4 init() is once-per-process, so all GTK tests share one init via Once.

use lagrange_host_linux::semantic_gtk::{realize, Intent};
use lagrange_host_linux::semantic_ui::{action_keys, parse_semantic_ui};
use std::path::Path;
use std::sync::Once;

static GTK_INIT: Once = Once::new();

fn gtk_init() {
    GTK_INIT.call_once(|| {
        gtk4::init().expect("gtk4::init() must succeed (run under Xvfb/xvfb-run)");
    });
}

fn fixture_path(name: &str) -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/semantic-ui")
        .join(name)
}

fn read_fixture(name: &str) -> String {
    std::fs::read_to_string(fixture_path(name)).unwrap_or_else(|e| panic!("fixture {name}: {e}"))
}

/// The validator accepts every checked-in GREEN fixture (the SAME bytes the
/// browser validator accepts).
#[test]
fn accepts_green_fixtures() {
    for name in ["navigator.json", "inspector.json", "unavailable.json", "unauthorized.json"] {
        let json = read_fixture(name);
        let doc = parse_semantic_ui(&json).unwrap_or_else(|e| panic!("green fixture {name} must validate: {e}"));
        assert_eq!(doc.kind, "semantic-ui");
        assert_eq!(doc.version, 1);
    }
}

/// The validator LOUDLY rejects every checked-in RED conformance fixture — the
/// SAME corpus the JS validator rejects (one authoritative contract, two
/// conforming validators).
#[test]
fn rejects_red_fixtures() {
    let red_dir = fixture_path("red");
    let mut count = 0;
    for entry in std::fs::read_dir(&red_dir).expect("red fixture dir") {
        let entry = entry.unwrap();
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        count += 1;
        let json = std::fs::read_to_string(&path).unwrap();
        assert!(
            parse_semantic_ui(&json).is_err(),
            "red fixture {} must be rejected by the Rust validator",
            path.file_name().unwrap().to_string_lossy()
        );
    }
    assert!(count >= 6, "expected the red conformance corpus (>= 6 fixtures), found {count}");
}

/// Conformance with the JS validator on integral-valued JSON numbers: JSON has
/// one number type, so `1`/`1.0`/`1e3`/`-0` are all integral (JS
/// Number.isInteger accepts them); both validators must accept those and reject
/// genuinely fractional/negative values (1.5, -1.0). This pins the JS<->Rust
/// validator equivalence the contract's CONFORMANCE NOTE requires.
#[test]
fn integral_float_conformance_with_js() {
    // Accepted (integral-valued, even with float syntax).
    for v in ["1", "1.0", "1e3"] {
        let json = format!(r#"{{"kind":"semantic-ui","version":1,"root":{{"kind":"group","children":[{{"kind":"collection","items":[{{"kind":"action","key":{v},"label":"a"}}]}}]}}}}"#);
        // version must be 1 for accept; use version:1 and vary only the key.
        let _ = v;
        assert!(parse_semantic_ui(&json).is_ok(), "integral key must be accepted");
    }
    // Rejected (genuinely fractional or negative).
    for bad in ["1.5", "-1.0", "-2"] {
        let json = format!(r#"{{"kind":"semantic-ui","version":1,"root":{{"kind":"group","children":[{{"kind":"collection","items":[{{"kind":"action","key":{bad},"label":"a"}}]}}]}}}}"#);
        assert!(parse_semantic_ui(&json).is_err(), "non-integral/negative key {bad} must be rejected");
    }
    // version with float syntax (integral) is accepted; non-1 is rejected.
    assert!(parse_semantic_ui(r#"{"kind":"semantic-ui","version":1.0,"root":{"kind":"group","children":[]}}"#).is_ok());
    assert!(parse_semantic_ui(r#"{"kind":"semantic-ui","version":2.0,"root":{"kind":"group","children":[]}}"#).is_err());
}

/// Cross-host identity: the GTK realizer builds real controls from the SAME
/// fixtures the browser consumes, and an action activation emits the EXACT same
/// intent the DOM emits. ONE test: GTK is main-thread-only, so all widget work
/// (init + realize + activate) must happen on a single thread — a single test
/// guarantees that (cargo runs each #[test] on its own thread).
#[test]
fn fixtures_drive_real_gtk_controls_and_identical_intents() {
    gtk_init();

    // --- navigator: heading + fields + reference buttons + activate-item intent.
    let json = read_fixture("navigator.json");
    let doc = parse_semantic_ui(&json).expect("navigator fixture validates");
    assert_eq!(action_keys(&doc).into_iter().collect::<Vec<_>>(), vec![0, 1]);
    let pane = realize(&doc);
    assert_eq!(pane.action_labels(), vec!["obj-b".to_string(), "obj-c".to_string()]);
    let text = pane.visible_text();
    assert!(text.iter().any(|t| t == "Navigator: obj-root"), "heading shown: {text:?}");
    assert!(text.iter().any(|t| t == "slot-title"), "field label shown: {text:?}");
    assert!(text.iter().any(|t| t == "Root"), "field value shown: {text:?}");
    // Activating the action with key 1 emits {kind:'activate-item', key:1} —
    // identical to the DOM click's intent. NEVER a ref/subject.
    assert_eq!(pane.activate(1), Some(Intent::activate_item(1)));
    assert_eq!(pane.activate(0), Some(Intent::activate_item(0)));
    // A non-existent key emits nothing (stale key, like the DOM stale-key path).
    assert!(pane.activate(99).is_none());

    // --- inspector: fields normalized (int -> "17"), one reference. The
    // writable slot-title is an EDITABLE GtkEntry (the SAME fixture bytes the
    // DOM consumes); the read-only slot-count stays a label.
    let insp = realize(&parse_semantic_ui(&read_fixture("inspector.json")).expect("inspector validates"));
    let insp_text = insp.visible_text();
    assert!(insp_text.iter().any(|t| t == "Inspector: obj-b"), "{insp_text:?}");
    assert!(insp_text.iter().any(|t| t == "17"), "int field normalized to display text: {insp_text:?}");
    assert_eq!(insp.action_labels(), vec!["obj-c".to_string()]);
    assert_eq!(insp.activate(0), Some(Intent::activate_item(0)));
    // EDIT: exactly one editable field (slot-title, key 0); slot-count is
    // read-only (no entry). Committing "B2" via Enter/activate emits the
    // RAW-STRING intent {kind:'edit-field', key:0, text:'B2'} — identical to the
    // DOM's intent. A read-only/absent key emits nothing (stale key).
    assert_eq!(insp.editable_texts(), vec!["B".to_string()], "only the writable field is editable");
    assert_eq!(
        insp.edit_field(0, "B2"),
        Some(Intent::edit_field(0, "B2".to_string())),
        "Enter/activate commits a raw-string edit intent with the descriptor-local key"
    );
    assert!(insp.edit_field(1, "x").is_none(), "no editable field at key 1 (slot-count is read-only)");
    // CROSS-HOST INTENT BYTES (F2): the GTK edit intent SERIALIZES to the exact
    // same JSON the browser DOM emits — asserted against the checked-in
    // canonical intent fixture, not a parallel literal. This pins the intent
    // shape/kind-string/key across both hosts from one source of truth.
    let intent = insp.intents.borrow().last().cloned().expect("an edit intent was recorded");
    let intent_json = serde_json::to_value(&intent).expect("the intent serializes");
    let canonical: serde_json::Value =
        serde_json::from_str(&read_fixture("edit-field-intent.json")).expect("the canonical intent fixture parses");
    assert_eq!(
        intent_json, canonical,
        "the GTK edit-field intent serializes to the SAME bytes the DOM emits (edit-field-intent.json)"
    );

    // --- unavailable + unauthorized: reason lines, no refs/actions.
    let un = realize(&parse_semantic_ui(&read_fixture("unavailable.json")).unwrap());
    let un_text = un.visible_text();
    assert!(un_text.iter().any(|t| t == "Unavailable: obj-gone (not found)"), "{un_text:?}");
    assert!(un.action_labels().is_empty(), "no actions on an unavailable pane");
    let unauth = realize(&parse_semantic_ui(&read_fixture("unauthorized.json")).unwrap());
    let unauth_text = unauth.visible_text();
    assert!(unauth_text.iter().any(|t| t == "Not authorized: obj-secret (denied)"), "{unauth_text:?}");
    assert!(unauth.action_labels().is_empty());

    // --- MIRROR falsifier: a mutated fixture byte-stream changes the GTK output.
    let mutated = json.replace("obj-b", "MUTATED-REF");
    assert_ne!(json, mutated, "the mutation actually changed the bytes");
    let mpane = realize(&parse_semantic_ui(&mutated).expect("mutated fixture validates"));
    assert!(
        mpane.action_labels().contains(&"MUTATED-REF".to_string()),
        "the GTK controls reflect the mutated fixture bytes: {:?}",
        mpane.action_labels()
    );
}
