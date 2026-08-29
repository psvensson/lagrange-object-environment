//! L3 coexistence proof (Bead e01 / ADR 0013): ONE `LinuxRendererAdapter`
//! implements the EXISTING six-op RendererAdapter contract UNCHANGED and
//! realizes BOTH native routes behind ONE surface map — native GTK tool panes
//! (navigator + inspector) AND the native GLB Component view — coexisting.
//!
//! This is a NATIVE FIXTURE: it replicates the Compositor + EnvironmentShell
//! CALL SEQUENCE (createSurface x3 + attachPresentation; the navigator action
//! -> key->ref -> presentOn(inspector) selection loop; destroyAll + recreate),
//! it does NOT run the JS Compositor/EnvironmentShell (embedding Node or
//! rewriting the JS core is an explicit non-goal). The adapter's six ops are
//! the exact contract ops the JS Compositor calls; the fixture drives them in
//! the same order with the same data shapes.
//!
//! THREAD MODEL (plan-review resolution): ONE `#[test]` owns the GTK thread
//! (calls `gtk4::init()` once) AND owns a tokio runtime. GTK ops are
//! SYNCHRONOUS on the test thread (GTK is main-thread-only; never on a tokio
//! worker). GLB async work runs via `runtime.block_on` through the injected
//! `glb_runner` — the six ops are the only crossing.
//!
//! The adapter has EXACTLY the six contract ops (see `RendererAdapterOps`).
//! `read_pixels` / `activate_gtk_action` / `gtk_*` are HOST-SIDE inspection
//! seams (NOT contract ops), mirroring the browser's `readRenderedPixels` /
//! `onIntent` — they observe native state; they are never part of the
//! Compositor-facing lifecycle contract.

use lagrange_host_linux::linux_adapter::{
    assert_data_representable, linux_adapter_base64, LinuxRendererAdapter, RendererAdapterOps,
};
use lagrange_host_linux::projector::descriptor_references;
use lagrange_host_linux::{box_glb_bytes, mesh_pixels};
use serde_json::{json, Value};

// Compile-time "no widening" falsification: the concrete adapter implements
// EXACTLY the six-op `RendererAdapterOps` trait, and the Compositor-facing
// calls in this fixture (create/attach/detach/resize/destroy) go through that
// trait object. If the contract were widened (a 7th op), it would have to be
// added to that trait — and nothing is. Host-side inspection seams
// (read_pixels / activate_gtk_action / pump_frames / gtk_*) are NOT on the
// trait; they are called on the concrete adapter below, exactly like the
// browser test harness calls readRenderedPixels/onIntent off-contract.
fn adapter_ops(adapter: &mut LinuxRendererAdapter) -> &mut dyn RendererAdapterOps {
    adapter
}

fn ref_(object_id: &str) -> Value {
    json!({"kind": "ref", "imageId": "img", "objectId": object_id})
}

/// The durable intent for the composition: a navigator over obj-root, an
/// inspector, and a GLB view. This is the plain-data intent the fixture
/// re-realizes from (handles are never durable).
struct DurableIntent {
    navigator_descriptor: Value,
    inspector_descriptor: Value,
    glb_descriptor: Value,
    view_descriptor_for: fn(&str) -> Value,
}

fn durable_intent() -> DurableIntent {
    // The navigator descriptor projects to the navigator fixture's shape
    // (heading + a field + reference actions obj-b/obj-c). The inspector
    // descriptor is the initial (pre-selection) inspector over obj-root.
    let navigator_descriptor = json!({
        "kind": "navigator",
        "subject": ref_("obj-root"),
        "parameters": {
            "fields": {"slot-title": {"kind": "text", "value": "Root"}},
            "references": [ref_("obj-b"), ref_("obj-c")],
        },
    });
    let inspector_descriptor = json!({
        "kind": "inspector",
        "subject": ref_("obj-root"),
        "parameters": {
            "fields": {"slot-title": {"kind": "text", "value": "Root"}},
            "references": [],
        },
    });
    // The GLB descriptor: the Component kind + the attach-scoped asset bytes
    // (box.glb as the 'main-model' allowlist, base64 — mirroring L1's
    // per-attach authorized bytes).
    let glb_descriptor = json!({
        "kind": "glb",
        "subject": ref_("obj-model"),
        "parameters": {
            "assets": {"main-model": linux_adapter_base64::encode(&box_glb_bytes())},
        },
    });
    DurableIntent {
        navigator_descriptor,
        inspector_descriptor,
        glb_descriptor,
        view_descriptor_for: |_view_id| json!({"kind": "surface", "width": 320, "height": 200}),
    }
}

/// The canned navigate producer (replicating ObjectNavigator.navigate for the
/// selection): the inspector descriptor after selecting obj-b. Hand-constructed
/// to project to a known SemanticUi shape — L3 proves the adapter/6-op/
/// coexistence contract, NOT end-to-end shell navigation.
fn inspector_descriptor_for_obj_b() -> Value {
    json!({
        "kind": "inspector",
        "subject": ref_("obj-b"),
        "parameters": {
            "fields": {
                "slot-title": {"kind": "text", "value": "B"},
                "slot-count": {"kind": "int", "value": 17},
            },
            "references": [ref_("obj-c")],
        },
    })
}

/// Assert a GLB frame is non-blank: a coherent shaded mesh covers a band of
/// the frame (the same predicate shape as L1's assert_mesh).
fn assert_glb_non_blank(adapter: &LinuxRendererAdapter, handle: &str, label: &str) {
    let frame = adapter
        .read_pixels(handle)
        .expect("read_pixels")
        .unwrap_or_else(|| panic!("{label}: the GLB surface should have presented a frame"));
    let (width, height, bytes_per_row) = adapter
        .frame_geometry(handle)
        .expect("frame_geometry")
        .expect("glb handle has frame geometry");
    let mesh = mesh_pixels(&frame, width, height, bytes_per_row);
    let total = (width * height) as usize;
    assert!(
        mesh > total / 50 && mesh < total * 4 / 5,
        "{label}: the GLB view should render a shaded Box (mesh {mesh}/{total})"
    );
}

/// Open the three-view composition through the six ops (replicating the
/// Compositor's openView: createSurface + attachPresentation). The six contract
/// ops are called through the `RendererAdapterOps` trait object — the exact,
/// un-widened contract surface. Returns (navigator, inspector, glb) handles.
fn open_composition(
    adapter: &mut LinuxRendererAdapter,
    intent: &DurableIntent,
) -> (String, String, String) {
    let ops = adapter_ops(adapter);
    let navigator_handle = ops
        .create_surface(&(intent.view_descriptor_for)("navigator-view"))
        .expect("create_surface navigator");
    ops.attach_presentation(&navigator_handle, &intent.navigator_descriptor)
        .expect("attach navigator");

    let inspector_handle = ops
        .create_surface(&(intent.view_descriptor_for)("inspector-view"))
        .expect("create_surface inspector");
    ops.attach_presentation(&inspector_handle, &intent.inspector_descriptor)
        .expect("attach inspector");

    let glb_handle = ops
        .create_surface(&(intent.view_descriptor_for)("glb-view"))
        .expect("create_surface glb");
    ops.attach_presentation(&glb_handle, &intent.glb_descriptor)
        .expect("attach glb");

    (navigator_handle, inspector_handle, glb_handle)
}

#[test]
fn l3_coexistence() {
    // GTK is main-thread-only: init once on THIS thread (the test thread).
    gtk4::init().expect("gtk4::init() must succeed (run under Xvfb/xvfb-run)");

    // The tokio runtime the GLB Component's async work lives on. GTK ops are
    // synchronous on this thread; GLB attach runs via runtime.block_on.
    let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");

    // The adapter. The injected glb_runner bridges the sync GTK thread to the
    // async runtime (the six ops are the only crossing). The concrete adapter
    // is used for the host-side seams; the six contract ops go through the
    // `RendererAdapterOps` trait object inside open_composition / the phases.
    let mut adapter = LinuxRendererAdapter::new(Box::new(move |fut| runtime.block_on(fut)));

    let intent = durable_intent();

    // === Phase 1: open the composition (navigator | inspector | glb) ======
    let (navigator_handle, inspector_handle, glb_handle) =
        open_composition(&mut adapter, &intent);

    // All three realized: GTK navigator + inspector controls exist; the GLB
    // surface read_pixels returns a non-blank frame. The GLB Component's async
    // frame handler only advances while the runtime is driven, so pump frames
    // through the adapter's host-side bridge, then read.
    pump_glb_frames(&mut adapter, &glb_handle);
    assert_glb_non_blank(&adapter, &glb_handle, "phase 1 GLB");

    // The navigator GTK pane: heading + reference action buttons obj-b/obj-c.
    let nav_text = adapter.gtk_visible_text(&navigator_handle).expect("nav text");
    assert!(
        nav_text.iter().any(|t| t == "Navigator: obj-root"),
        "navigator heading shown: {nav_text:?}"
    );
    assert_eq!(
        adapter.gtk_action_labels(&navigator_handle).expect("nav labels"),
        vec!["obj-b".to_string(), "obj-c".to_string()],
        "navigator reference actions"
    );
    // The inspector GTK pane (initial, pre-selection).
    let insp_text = adapter.gtk_visible_text(&inspector_handle).expect("insp text");
    assert!(
        insp_text.iter().any(|t| t == "Inspector: obj-root"),
        "initial inspector heading: {insp_text:?}"
    );

    // === Phase 2: drive the selection loop =================================
    // A GTK navigator action (key 0 -> obj-b) emits {kind:'activate-item',
    // key:0} — the fixture resolves key->ref against the navigator's CURRENT
    // descriptor (replicating EnvironmentShell.handleActivateItem), then
    // presentOn the inspector (detachPresentation + attachPresentation) while
    // the GLB view stays LIVE.
    let activate = adapter
        .activate_gtk_action(&navigator_handle, 0)
        .expect("activate")
        .expect("navigator key 0 emits an intent");
    assert_eq!(activate.kind, "activate-item");
    assert_eq!(activate.key, 0);

    // Resolve key->ref via descriptor_references (the shell's resolution path).
    let nav_descriptor = adapter
        .gtk_descriptor(&navigator_handle)
        .expect("nav descriptor")
        .expect("navigator is GTK");
    let references = descriptor_references(&nav_descriptor);
    let selected_ref = references
        .get(activate.key as usize)
        .expect("key 0 in range")
        .clone();
    assert_eq!(
        selected_ref.get("objectId").and_then(|o| o.as_str()),
        Some("obj-b"),
        "key 0 resolves to obj-b"
    );

    // presentOn the inspector (the exact Compositor.presentOn sequence):
    // detach + attach with the obj-b descriptor, through the trait object.
    let obj_b_inspector = inspector_descriptor_for_obj_b();
    let ops = adapter_ops(&mut adapter);
    ops.detach_presentation(&inspector_handle)
        .expect("detach inspector");
    ops.attach_presentation(&inspector_handle, &obj_b_inspector)
        .expect("re-attach inspector");

    // The inspector now shows obj-b's content ...
    let insp_text = adapter.gtk_visible_text(&inspector_handle).expect("insp text");
    assert!(
        insp_text.iter().any(|t| t == "Inspector: obj-b"),
        "inspector now inspects obj-b: {insp_text:?}"
    );
    assert!(insp_text.iter().any(|t| t == "B"), "obj-b title: {insp_text:?}");
    assert!(insp_text.iter().any(|t| t == "17"), "obj-b count: {insp_text:?}");
    assert_eq!(
        adapter.gtk_action_labels(&inspector_handle).expect("insp labels"),
        vec!["obj-c".to_string()],
        "obj-b's reference action"
    );

    // ... AND the GLB view stayed live through the selection.
    pump_glb_frames(&mut adapter, &glb_handle);
    assert_glb_non_blank(&adapter, &glb_handle, "phase 2 GLB (still live)");

    // === Phase 3: destroy + recreate from the SAME durable intent =========
    // The Compositor's Session destroy maps to the adapter's destroy_all +
    // discarding the adapter; recreate is a FRESH adapter re-realizing the SAME
    // durable intent (handles are never durable identity).
    let old_handles = (navigator_handle.clone(), inspector_handle.clone(), glb_handle.clone());
    adapter_ops(&mut adapter).destroy_all().expect("destroy_all");

    // Using a destroyed handle errors loudly (the surface is gone).
    let err = adapter
        .read_pixels(&old_handles.2)
        .expect_err("read_pixels on a destroyed surface must error");
    assert!(
        err.contains("unknown/destroyed"),
        "loud error naming the destroyed surface: {err}"
    );
    let err = adapter_ops(&mut adapter)
        .resize(&old_handles.0, 100, 100)
        .expect_err("resize on a destroyed surface must error");
    assert!(err.contains("unknown/destroyed"), "loud error: {err}");

    // Recreate from the SAME durable intent with a FRESH adapter (a fresh
    // Session), on a fresh runtime — FRESH realizations, NEW handles.
    drop(adapter);
    let runtime2 = tokio::runtime::Runtime::new().expect("tokio runtime 2");
    let mut adapter2 = LinuxRendererAdapter::new(Box::new(move |fut| runtime2.block_on(fut)));
    let (nav2, insp2, glb2) = open_composition(&mut adapter2, &intent);
    assert_ne!(nav2, old_handles.0, "fresh navigator handle");
    assert_ne!(insp2, old_handles.1, "fresh inspector handle");
    assert_ne!(glb2, old_handles.2, "fresh glb handle");

    // The GLB view renders again (non-blank) and the GTK controls are rebuilt.
    pump_glb_frames(&mut adapter2, &glb2);
    assert_glb_non_blank(&adapter2, &glb2, "phase 3 GLB (recreated)");
    let nav2_text = adapter2.gtk_visible_text(&nav2).expect("nav2 text");
    assert!(
        nav2_text.iter().any(|t| t == "Navigator: obj-root"),
        "recreated navigator heading: {nav2_text:?}"
    );
    assert_eq!(
        adapter2.gtk_action_labels(&nav2).expect("nav2 labels"),
        vec!["obj-b".to_string(), "obj-c".to_string()],
        "recreated navigator actions"
    );

    // === Falsification: data-representable loud-reject =====================
    // A native caller cannot construct a callback Value, but the boundary check
    // is honest and the adapter enforces kind/data rules loudly.
    assert!(assert_data_representable(&json!({"kind": "x"}), "d").is_ok());
    let err = adapter_ops(&mut adapter2)
        .create_surface(&json!({"width": 10}))
        .expect_err("a viewDescriptor without kind must error");
    assert!(err.contains("kind"), "loud kind error: {err}");
}

/// Drive the live GLB instance's animation frames so it presents (host-side
/// pump, NOT a contract op — the native analogue of the browser CI's offscreen
/// run-to-completion driver). The Component's async frame handler only
/// advances while the tokio runtime is driven inside the adapter's block_on
/// bridge. Called on the concrete adapter (pump_frames is off-contract).
fn pump_glb_frames(adapter: &mut LinuxRendererAdapter, glb_handle: &str) {
    adapter.pump_frames(glb_handle, 4).expect("pump glb frames");
}
