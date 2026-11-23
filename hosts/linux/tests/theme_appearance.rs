//! T4: native GTK renders the very same ThemeResolver output fixture that the
//! browser DOM production adapter consumes. GTK style is transient and scoped
//! to a widget tree; no process-wide theme or seventh RendererAdapter op.
use gtk4::prelude::*;
use lagrange_host_linux::gtk_theme::{apply_native_tool_css, css_for_resolved_tokens};
use lagrange_host_linux::linux_adapter::{GlbRunner, LinuxRendererAdapter, RendererAdapterOps};
use lagrange_host_linux::semantic_gtk::realize;
use lagrange_host_linux::semantic_ui::parse_semantic_ui;
use serde_json::{json, Value};
use std::path::Path;

fn tokens(name: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/theme").join(format!("{name}-tokens.json"))
    ).unwrap()).unwrap()
}
fn document() -> lagrange_host_linux::semantic_ui::SemanticUi {
    parse_semantic_ui(&std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/semantic-ui/navigator.json")
    ).unwrap()).unwrap()
}
fn rgb(widget: &gtk4::Widget) -> (u8, u8, u8) {
    let rgba = widget.style_context().color();
    let to_byte = |value: f32| (value * 255.0).round() as u8;
    (to_byte(rgba.red()), to_byte(rgba.green()), to_byte(rgba.blue()))
}

#[test]
fn native_renderer_materializes_two_independent_resolved_themes_without_a_default() {
    gtk4::init().expect("GTK4 headless under Xvfb");
    let stock = tokens("stock");
    let derived = tokens("derived");
    let first_css = css_for_resolved_tokens(&stock).expect("stock is a complete validated Theme");
    let second_css = css_for_resolved_tokens(&derived).expect("derived is another complete Theme");
    assert_ne!(first_css, second_css);
    // Cross-host T4 falsifiers from an independent GTK review: a background
    // color hidden behind the toolkit button image, the missing internal
    // GtkTextView text node, or an unmatched entry focus pseudo-class would
    // all pass the old foreground-only assertion without styling the UI.
    for css in [&first_css, &second_css] {
        assert!(css.contains("button {\n  background-image: none;"),
            "button background images must not obscure the resolved raised fill");
        assert!(css.contains("entry, textview, textview text {"),
            "multiline source/input text area must use the resolved colors");
        assert!(css.contains("entry:focus-within"),
            "GTK4 entries focus their internal GtkText child, not entry:focus");
    }
    for (expected, css) in [
        (["#e6e6e2", "#245a81", "#f5f5f0", "13px", "6px"], &first_css),
        (["#121922", "#ac4f81", "#253242", "16px", "12px"], &second_css),
    ] {
        for value in expected { assert!(css.contains(value), "GTK must materialize {value} from the shared resolved tokens"); }
    }

    let a = realize(&document());
    let b = realize(&document());
    let plain = realize(&document());
    apply_native_tool_css(a.root.upcast_ref(), &first_css);
    apply_native_tool_css(b.root.upcast_ref(), &second_css);
    assert_eq!(rgb(a.root.upcast_ref()), (28, 36, 40), "stock GTK foreground must be the resolved token");
    assert_eq!(rgb(b.root.upcast_ref()), (240, 243, 247), "derived GTK foreground must be the resolved token");
    assert_ne!(rgb(a.root.upcast_ref()), rgb(b.root.upcast_ref()));
    assert_ne!(rgb(plain.root.upcast_ref()), rgb(b.root.upcast_ref()),
        "no Theme supplied must not silently select the derived Theme");
    // A second provider on another pane cannot mutate the first pane's
    // computed foreground or the action→intent semantic route.
    assert_eq!(rgb(a.root.upcast_ref()), (28, 36, 40));
    assert_eq!(a.activate(0).unwrap().key(), 0);
    assert_eq!(b.activate(0).unwrap().key(), 0);
    assert_eq!(plain.activate(0).unwrap().key(), 0);

    // The actual LinuxRendererAdapter constructor/attach route uses the same
    // style conversion and the unchanged six-operation RendererAdapterOps.
    let glb: GlbRunner = Box::new(|_| panic!("tool pane must not start GLB"));
    let mut adapter = LinuxRendererAdapter::with_resolved_tokens(glb, &derived)
        .expect("host may install the already-resolved tokens");
    let handle = adapter.create_surface(&json!({"kind":"tool-pane"})).unwrap();
    let descriptor = json!({
      "kind":"navigator", "subject":{"kind":"ref","imageId":"img","objectId":"obj-root"},
      "parameters":{"fields":{"slot-title":{"kind":"text","value":"Root"}},
        "references":[{"kind":"ref","imageId":"img","objectId":"obj-b"}]}
    });
    adapter.attach_presentation(&handle, &descriptor).unwrap();
    assert_eq!(adapter.gtk_foreground_rgb(&handle).unwrap(), Some((240, 243, 247)),
        "computed Theme foreground must be visible through the PRODUCTION adapter attach path");
    assert!(adapter.gtk_visible_text(&handle).unwrap().contains(&"Navigator: obj-root".to_string()));
    assert_eq!(adapter.activate_gtk_action(&handle, 0).unwrap().unwrap().key(), 0);
    adapter.detach_presentation(&handle).unwrap();
    adapter.destroy_surface(&handle).unwrap();
}

#[test]
fn gtk_theme_accepts_the_same_safe_integral_json_numbers_as_the_browser() {
    let mut values = tokens("stock");
    // Rust serde_json stores 13.0 and 1.3e1 as floats; JavaScript's
    // Number.isSafeInteger accepts them as the integer 13. -0.0 is zero.
    values[12]["value"] = serde_json::from_str("1.3e1").unwrap();
    values[14]["value"] = serde_json::from_str("13.0").unwrap();
    values[2]["value"] = serde_json::from_str("-0.0").unwrap();
    let css = css_for_resolved_tokens(&values).expect("integral floats are legal resolved dimensions");
    assert!(css.contains("font-size: 13px"));
    assert!(css.contains("border-radius: 0px"));
    values[12]["value"] = serde_json::from_str("13.5").unwrap();
    assert!(css_for_resolved_tokens(&values).is_err(), "fractional font sizes are not integers");
    values[12]["value"] = serde_json::from_str("9.007199254740992e15").unwrap();
    assert!(css_for_resolved_tokens(&values).is_err(), "unsafe integers are refused");
}

#[test]
fn gtk_style_input_rejects_missing_or_injection_capable_token_data() {
    let base = tokens("stock");
    let mut cases = Vec::new();
    cases.push(json!(null));
    cases.push(json!([]));
    let mut absent = base.clone();
    absent.as_array_mut().unwrap().pop();
    cases.push(absent);
    let mut duplicate = base.clone();
    let first = duplicate[0].clone();
    duplicate.as_array_mut().unwrap()[1] = first;
    cases.push(duplicate);
    let mut injection = base.clone();
    injection[0]["value"] = json!("red; background-image: url(file:///secret)");
    cases.push(injection);
    let mut wrong_type = base.clone();
    wrong_type[0]["type"] = json!("fontFamily");
    cases.push(wrong_type);
    let mut wrong_path = base.clone();
    wrong_path[0]["path"] = json!("css.background");
    cases.push(wrong_path);
    let mut negative = base.clone();
    negative[2]["value"] = json!(-3);
    cases.push(negative);
    let mut extra = base.clone();
    extra[0]["extra"] = json!("unowned");
    cases.push(extra);
    for value in cases {
        assert!(css_for_resolved_tokens(&value).is_err(), "GTK must reject invalid token input: {value}");
    }
}
