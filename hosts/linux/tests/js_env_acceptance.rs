//! 3zb-A slice-4 acceptance: the REAL unchanged Environment semantic core running
//! in-process under rquickjs, consuming only the defined (TEST) Images
//! capability, driving the REAL LinuxRendererAdapter/GTK host.
//!
//! NARROW CLAIM (per the Bead): the real ObjectNavigator / SelectionModel /
//! EnvironmentShell / Compositor / command-router / command-registry /
//! command-dispatcher run unmodified under rquickjs and preserve PR #40
//! Environment-level interaction semantics. This does NOT claim real
//! lagrange-images portability, authority enforcement, CAS correctness, or
//! observation-cursor correctness (those are 3zb-B). The Images side is the
//! slice-3B TEST capability (scripted outcomes, no substrate semantics).
//!
//! THREAD MODEL (GTK constraint): ONE `#[test]` owns GTK (gtk4::init is
//! once-per-process). The test thread owns GTK + the RendererPortHost; the JS
//! actor is the spawned owner thread; the Images capability host is its own
//! dedicated thread. DEADLOCK DISCIPLINE (from slices 2/3):
//!   (A) JS awaiting Images: the Promise suspends; the owner stays responsive.
//!   (B) JS synchronously inside a Renderer op: the GTK thread must NOT re-enter
//!       JS before that op returns.
//!   (C) GTK user intent: the test PULLS it (activate_gtk_action/edit_gtk_field)
//!       and PUSHES it fire-and-forget (the guest handler routes without
//!       awaiting presentOn); NEVER a blocking GTK->JS push while a renderer op
//!       may be pending (no push_blocking from GTK).
//!
//! Phases (causal, pump+poll seams — no sleeps as correctness):
//!   NAV      GTK activate -> real handleActivateItem -> fake read -> presentOn -> GTK.
//!   OBS      external mutation -> follow -> FRESH port reread -> presentOn -> GTK.
//!   OLM      follow stays active; held Command forces self-observation to arrive
//!            while editInFlight>0 -> real defer -> settle -> drain -> re-pair.
//!   STALE    external advance -> held token stale -> usedStaleToken -> conflict -> reread.
//!   DENIED   denied-read (unauthorized-ref) vs denied-write (rejected, unchanged).
//!   C1       token absent from durable intent / parameters / renderer / GTK text.

use std::sync::Once;
use std::time::{Duration, Instant};

use lagrange_host_linux::js_env::actor::JsEnvActor;
use lagrange_host_linux::js_env::images_capability::{install_images_capability, ImagesCapabilityHost, ImagesCapabilityTx};
use lagrange_host_linux::js_env::renderer_port::{install_renderer_adapter, RendererPortHost};
use lagrange_host_linux::js_env::EmbeddedLoader;
use serde_json::{json, Value};

static GTK_INIT: Once = Once::new();
fn gtk_init() {
    GTK_INIT.call_once(|| {
        gtk4::init().expect("gtk4::init() must succeed (run under Xvfb/xvfb-run)");
    });
}

fn stub_glb_runner() -> lagrange_host_linux::linux_adapter::GlbRunner {
    Box::new(|_fut| -> Result<lagrange_host_linux::GlbInstance, String> {
        Err("glb not wired in slice 4 (tool kinds only)".to_string())
    })
}

/// The 12-module real Environment closure + the TEST-only composition module,
/// registered under flat stems (the Env src/ graph is flat; all cross-imports
/// are './x.js'). Loaded via include_str! (checked-in sources).
fn env_loader() -> EmbeddedLoader {
    EmbeddedLoader::new()
        .with_module("model", include_str!("../../../src/model.js"))
        .with_module("renderer-errors", include_str!("../../../src/renderer-errors.js"))
        .with_module("selection-model", include_str!("../../../src/selection-model.js"))
        .with_module("image-observation", include_str!("../../../src/image-observation.js"))
        .with_module("command-router", include_str!("../../../src/command-router.js"))
        .with_module("command-registry", include_str!("../../../src/command-registry.js"))
        .with_module("command-dispatcher", include_str!("../../../src/command-dispatcher.js"))
        .with_module("presentation-registry", include_str!("../../../src/presentation-registry.js"))
        .with_module("object-navigator", include_str!("../../../src/object-navigator.js"))
        .with_module("object-presentation-providers", include_str!("../../../src/object-presentation-providers.js"))
        .with_module("compositor", include_str!("../../../src/compositor.js"))
        .with_module("environment-shell", include_str!("../../../src/environment-shell.js"))
        .with_module("composition", include_str!("acceptance-composition.mjs"))
}

/// Drive a JS async block that triggers RENDERER ops, pumping the GTK host on
/// THIS thread until the JS completes (causal interleave). Like slice 3A.
fn run_js_while_pumping(
    runtime: &tokio::runtime::Runtime,
    actor: &JsEnvActor,
    host: &mut RendererPortHost,
    js: &str,
) -> String {
    let sender = actor.clone_sender();
    let js = js.to_string();
    let js_dbg = js.chars().take(80).collect::<String>();
    let (done_tx, mut done_rx) = tokio::sync::oneshot::channel();
    let _work = runtime.spawn(async move {
        let out = sender.eval_async(&js).await;
        let _ = done_tx.send(out);
    });
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        host.pump();
        if let Ok(out) = done_rx.try_recv() {
            return match out {
                Ok(s) => s,
                Err(e) => panic!("JS work failed: {e}  [src: {js_dbg}]"),
            };
        }
        if Instant::now() > deadline {
            panic!("timed out waiting for JS work (GTK pump must resolve renderer ops)");
        }
        runtime.block_on(tokio::task::yield_now());
    }
}

/// Pump the GTK host once, then run a bounded eval that must NOT itself await a
/// renderer op (a pure-read seam or a fire-and-forget trigger). Returns the
/// JSON-stringified result.
fn pump_and_eval(
    runtime: &tokio::runtime::Runtime,
    actor: &JsEnvActor,
    host: &mut RendererPortHost,
    js: &str,
) -> String {
    host.pump();
    runtime.block_on(actor.eval_async(js)).expect("pump_and_eval")
}

/// Pump+poll a seam until `pred` holds (causal; no sleep as correctness).
fn poll_until<F: Fn(&Value) -> bool>(
    runtime: &tokio::runtime::Runtime,
    actor: &JsEnvActor,
    host: &mut RendererPortHost,
    js: &str,
    pred: F,
    what: &str,
) -> Value {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let out = pump_and_eval(runtime, actor, host, js);
        let v: Value = serde_json::from_str(&out).unwrap_or_else(|_| json!({"_unparsed": out}));
        if pred(&v) {
            return v;
        }
        if Instant::now() > deadline {
            panic!("poll timed out: {what}; last={v}");
        }
        runtime.block_on(tokio::task::yield_now());
    }
}

/// Rust-side EXTERNAL mutation via the cloned port tx (a genuine "external"
/// advance behind the shell's back): read the CURRENT token, then mutate with it
/// (fresh -> commits, advancing the version). Threads real tokens, never
/// fabricates them.
fn ext_mutate(runtime: &tokio::runtime::Runtime, tx: &ImagesCapabilityTx, object_id: &str, new_title: &str) {
    let env = runtime
        .block_on(tx.read_object(object_id.to_string(), Default::default()))
        .expect("ext read");
    let env: Value = serde_json::from_str(&env).unwrap();
    let token = env["ok"]["versionToken"].as_str().expect("ext read versionToken").to_string();
    let value = json!({"probe-title": {"value": new_title}});
    let env = runtime
        .block_on(tx.mutate_object(object_id.to_string(), value, Some(token), Default::default()))
        .expect("ext mutate");
    let env: Value = serde_json::from_str(&env).unwrap();
    assert!(env.get("ok").is_some(), "external mutation must commit: {env}");
}

#[test]
fn slice4_acceptance() {
    gtk_init();
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("tokio runtime");

    // --- Images TEST capability (scripted) + a Rust-held clone for external ops.
    let (images_host, images_tx, script) = ImagesCapabilityHost::new();
    script.add_object("obj-root", json!({"link": {"kind": "ref", "imageId": "img", "objectId": "obj-b"}}));
    script.add_object("obj-b", json!({"probe-title": {"value": "original"}}));
    script.add_object("obj-denied-read", json!({"probe-title": {"value": "secret"}}));
    script.deny_read("obj-denied-read");
    script.add_object("obj-denied-mutate", json!({"probe-title": {"value": "frozen"}}));
    script.deny_mutate("obj-denied-mutate");
    images_host.start();
    let ext_tx = images_tx.clone();

    // --- Renderer port (real adapter on the GTK/test thread) + JS actor.
    let (mut host, renderer_tx) = RendererPortHost::new(stub_glb_runner());
    let actor = JsEnvActor::spawn(env_loader()).expect("spawn actor");
    {
        let tx = renderer_tx.clone();
        runtime.block_on(actor.with_context(move |ctx| install_renderer_adapter(&ctx, tx, "rendererAdapter"))).expect("install renderer");
    }
    {
        let tx = images_tx.clone();
        runtime.block_on(actor.with_context(move |ctx| install_images_capability(&ctx, tx, "imagesCapability"))).expect("install images");
    }

    // --- Compose the REAL Environment + open the workspace on the root.
    let handles_json = run_js_while_pumping(&runtime, &actor, &mut host, r#"
(async () => {
  const m = await import('composition');
  m.setup({
    imageId: 'img',
    blockIds: {read: 'blk-read', mutation: 'blk-mut', observation: 'blk-obs'},
    seededObjectIds: {root: 'obj-root', b: 'obj-b', deniedRead: 'obj-denied-read', deniedMutate: 'obj-denied-mutate'},
  });
  return await globalThis.__session.open('obj-root');
})()
"#);
    let handles: Value = serde_json::from_str(&handles_json).unwrap();
    let nav_handle = handles["navigatorSurfaceHandle"].as_str().unwrap().to_string();
    let _insp_handle = handles["inspectorSurfaceHandle"].as_str().unwrap().to_string();

    // ============ PHASE NAV: GTK activate -> real navigation -> GTK ============
    // Pull the activate intent on the GTK thread, push it fire-and-forget. The
    // intent carries ONLY the key; the REAL EnvironmentShell resolves key->ref
    // (references[0] = obj-b) via the navigator's durableIntent — no Rust shortcut.
    let intent = host.adapter().activate_gtk_action(&nav_handle, 0).expect("activate").expect("an activate-item intent");
    let payload = json!({"intent": intent, "surfaceHandle": nav_handle}).to_string();
    runtime.block_on(actor.push(&payload)).expect("push activate intent");
    poll_until(
        &runtime, &actor, &mut host,
        "globalThis.__session.inspector()",
        |v| v["title"] == json!("original"),
        "navigation: inspector shows obj-b after activate-item key 0",
    );
    let nav_gtk = host.adapter().gtk_visible_text(&_insp_handle).expect("gtk text");
    assert!(nav_gtk.iter().any(|t| t.contains("original")), "NAV: GTK inspector shows obj-b's title: {nav_gtk:?}");

    // ============ PHASE OBS: observation -> FRESH reread -> GTK ===============
    run_js_while_pumping(&runtime, &actor, &mut host, "globalThis.__session.follow('obj-b')");
    // Anchor: the fake live-follow has NO backlog, so wait for >=1 poll BEFORE
    // the external mutation (else it would be invisible).
    poll_until(&runtime, &actor, &mut host, "globalThis.__session.obsPollCount()", |v| v.as_u64().unwrap_or(0) >= 1, "follow anchor: >=1 poll");
    ext_mutate(&runtime, &ext_tx, "obj-b", "observed-1");
    // The observation must drive a FRESH port read (not the host pushing the
    // value): the durable intent (presentOn) AND a fresh port read agree.
    poll_until(
        &runtime, &actor, &mut host,
        "globalThis.__session.tokenState('obj-b')",
        |v| v["obsEvents"].as_u64().unwrap_or(0) >= 1,
        "observation: the lane fired (obsEvents>=1)",
    );
    let obs = poll_until(
        &runtime, &actor, &mut host,
        "(async () => ({ui: globalThis.__session.inspector().title, img: await globalThis.__session.title('obj-b')}))()",
        |v| v["ui"] == json!("observed-1") && v["img"] == json!("observed-1"),
        "observation: fresh reread landed in the inspector (ui==img=='observed-1')",
    );
    assert_eq!(obs["ui"], json!("observed-1"));
    assert_eq!(obs["img"], json!("observed-1"), "OBS: a FRESH port read returned the new value");

    // ============ PHASE OLM: held Command -> real defer/drain =================
    run_js_while_pumping(&runtime, &actor, &mut host, "globalThis.__session.armHold()");
    let edit_intent = host.adapter().edit_gtk_field(&_insp_handle, 0, "edited-olm").expect("edit").expect("an edit-field intent");
    let payload = json!({"intent": edit_intent, "surfaceHandle": _insp_handle}).to_string();
    runtime.block_on(actor.push(&payload)).expect("push edit intent");
    // The edit is FIRE-AND-FORGET (bindIntents .catch); the actor's drain_jobs
    // drives it to the held gate on the owner thread, so a plain synchronous poll
    // suffices here — no port-call pacing required (the slice-4 drive fix).
    let olm = poll_until(
        &runtime, &actor, &mut host,
        "({deferred: globalThis.__session.deferredCount(), held: globalThis.__session.gateHeld()})",
        |v| v["deferred"].as_u64().unwrap_or(0) >= 1 && v["held"] == json!(true),
        "olm: self-observation DEFERRED while the edit was in flight",
    );
    assert!(olm["deferred"].as_u64().unwrap() >= 1, "OLM: the defer path actually fired (non-vacuous)");
    // Release the gate: the edit settles, the deferred reread drains, the token
    // re-pairs, and the inspector reflects the COMMITTED value.
    run_js_while_pumping(&runtime, &actor, &mut host, "globalThis.__session.releaseGate()");
    poll_until(
        &runtime, &actor, &mut host,
        "(async () => ({ui: globalThis.__session.inspector().title, tok: await globalThis.__session.tokenState('obj-b')}))()",
        |v| v["ui"] == json!("edited-olm") && v["tok"]["tokenIsFresh"] == json!(true),
        "olm: deferred reread drained, token re-paired, inspector shows committed value",
    );
    run_js_while_pumping(&runtime, &actor, &mut host, "globalThis.__session.unfollow()");

    // ============ PHASE STALE: external advance -> usedStaleToken conflict ====
    // obj-b is selected (holding its current token). Advance the version
    // EXTERNALLY (follow is stopped, so the shell's held token stays stale).
    ext_mutate(&runtime, &ext_tx, "obj-b", "external-stale");
    let entry = pump_and_eval(&runtime, &actor, &mut host, "globalThis.__session.staleEditEntryState('obj-b')");
    let entry: Value = serde_json::from_str(&entry).unwrap();
    assert_eq!(entry["usedStaleToken"], json!(true), "STALE: the edit entered with the previously-held (now stale) token, not a fresh/dropped one");
    let stale = run_js_while_pumping(&runtime, &actor, &mut host, "globalThis.__session.edit(0, 'stale-write')");
    let stale: Value = serde_json::from_str(&stale).unwrap();
    assert_eq!(stale["error"]["name"], json!("CommandConflictError"), "STALE: optimistic concurrency REJECTS the stale edit (not last-writer-wins)");
    // Recovery: the error arm rereads; the inspector shows the EXTERNAL value.
    poll_until(
        &runtime, &actor, &mut host,
        "globalThis.__session.inspector()",
        |v| v["title"] == json!("external-stale"),
        "stale: recovery reread restores usability with the external value",
    );

    // ============ PHASE DENIED: denied-write vs denied-read ===================
    // Denied-WRITE (separate seeded object; the fake has no authority calculus):
    // readable inspector remains, the mutation is rejected, nothing changes.
    run_js_while_pumping(&runtime, &actor, &mut host, "globalThis.__session.select('obj-denied-mutate')");
    poll_until(&runtime, &actor, &mut host, "globalThis.__session.inspector()", |v| v["title"] == json!("frozen"), "denied-write: inspector readable");
    let dw = run_js_while_pumping(&runtime, &actor, &mut host, "globalThis.__session.edit(0, 'attempt')");
    let dw: Value = serde_json::from_str(&dw).unwrap();
    assert_eq!(dw["error"]["name"], json!("CommandAuthorizationError"), "DENIED-WRITE: rejected with the authority classification");
    let dw_after = pump_and_eval(&runtime, &actor, &mut host, "(async () => ({img: await globalThis.__session.title('obj-denied-mutate'), ui: globalThis.__session.inspector().title}))()");
    let dw_after: Value = serde_json::from_str(&dw_after).unwrap();
    assert_eq!(dw_after["img"], json!("frozen"), "DENIED-WRITE: the value is unchanged");
    assert_eq!(dw_after["ui"], json!("frozen"), "DENIED-WRITE: the inspector remains usable");

    // Denied-READ (separate seeded object): surfaces the unauthorized-ref
    // presentation (distinct from unavailable), never the object.
    run_js_while_pumping(&runtime, &actor, &mut host, "globalThis.__session.select('obj-denied-read')");
    let dr = poll_until(
        &runtime, &actor, &mut host,
        "globalThis.__session.inspector()",
        |v| v["kind"] == json!("unauthorized-reference"),
        "denied-read: surfaces the unauthorized-ref presentation",
    );
    assert_eq!(dr["kind"], json!("unauthorized-reference"), "DENIED-READ: unauthorized-ref (distinct from unavailable)");

    // ============ PHASE C1: token absent from renderer/durable sinks ==========
    // Re-select obj-b so the shell holds a live token, then run the guest-side
    // leak check against the durable intent, every descriptor's parameters, the
    // renderer-bound descriptor, and the GTK-visible text.
    run_js_while_pumping(&runtime, &actor, &mut host, "globalThis.__session.select('obj-b')");
    poll_until(&runtime, &actor, &mut host, "globalThis.__session.tokenState('obj-b')", |v| v["hasToken"] == json!(true), "C1: a token is held");
    let gtk_text = host.adapter().gtk_visible_text(&_insp_handle).expect("gtk text");
    let gtk_desc = host.adapter().gtk_descriptor(&_insp_handle).expect("gtk desc").unwrap_or(json!(null));
    let c1_js = format!(
        "globalThis.__session.c1Check({{gtkVisibleText: {}, gtkDescriptorJson: {}}})",
        serde_json::to_string(&gtk_text).unwrap(),
        serde_json::to_string(&gtk_desc.to_string()).unwrap()
    );
    let c1 = pump_and_eval(&runtime, &actor, &mut host, &c1_js);
    let c1: Value = serde_json::from_str(&c1).unwrap();
    assert!(c1["tokensChecked"].as_u64().unwrap_or(0) > 0, "C1 non-vacuous: real tokens were checked");
    assert_eq!(c1["leaks"], json!(0), "C1: the token is ABSENT from durable intent, parameters, renderer payloads, and GTK text (sinks checked: {})", c1["sinksChecked"]);

    // --- teardown: destroy surfaces + shut down.
    run_js_while_pumping(&runtime, &actor, &mut host, "rendererAdapter.destroyAll()");
    runtime.block_on(actor.shutdown());
}
