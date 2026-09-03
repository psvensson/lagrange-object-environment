//! 3zb-A slice 3A acceptance: the Renderer port against the REAL
//! `LinuxRendererAdapter` (GTK, under Xvfb).
//!
//! Proves the reviewed ownership/threading shape for all six RendererAdapterOps:
//! the JS-owner actor (spawned thread) issues a renderer op on its OWN channel;
//! the GTK-owning (test) thread executes exactly one of the six ops via
//! `RendererPortHost::pump()`; a oneshot carries the result back; the JS owner
//! resumes. The real adapter realizes actual GTK controls. Values cross as
//! plain-data JSON; no semantic decoding in Rust; no `OwnerCommand` on this path.
//!
//! THREAD MODEL (GTK constraint): GTK4 permits ONE `gtk4::init()` per process
//! and binds widget work to that thread. So this is ONE `#[test]` (cargo runs
//! each `#[test]` on its own thread): the test thread owns GTK + the
//! `RendererPortHost`, the JS actor is the spawned thread, and the test pumps
//! the host while the JS work is in flight. This test directly owns that
//! in-process threading proof (GTK on the test thread, JS on its owner thread).

use std::sync::Once;
use std::time::Duration;

use lagrange_host_linux::js_env::actor::JsEnvActor;
use lagrange_host_linux::js_env::renderer_port::{install_renderer_adapter, RendererPortHost};
use lagrange_host_linux::js_env::EmbeddedLoader;

static GTK_INIT: Once = Once::new();

fn gtk_init() {
    GTK_INIT.call_once(|| {
        gtk4::init().expect("gtk4::init() must succeed (run under Xvfb/xvfb-run)");
    });
}

/// A glb_runner that errors if a GLB kind is attached (slice 3A exercises only
/// GTK tool kinds; the real runner arrives in slice 4). Built on the GTK thread.
fn stub_glb_runner() -> lagrange_host_linux::linux_adapter::GlbRunner {
    Box::new(|_fut| -> Result<lagrange_host_linux::GlbInstance, String> {
        Err("glb not wired in slice 3A (tool kinds only)".to_string())
    })
}

/// Drive a JS async block on the actor while pumping the GTK host on THIS
/// (test) thread, until the JS work completes. Causal interleave: the GTK
/// thread must pump (process ops) for the JS renderer calls to resolve, so the
/// test pumps while the JS future is in flight. Runs on the test's runtime.
fn run_js_while_pumping(
    runtime: &tokio::runtime::Runtime,
    actor: &JsEnvActor,
    host: &mut RendererPortHost,
    js: &str,
) -> String {
    let sender = actor.clone_sender();
    let js = js.to_string();
    let (done_tx, mut done_rx) = tokio::sync::oneshot::channel();
    let _js_work = runtime.spawn(async move {
        let out = sender.eval_async(&js).await;
        let _ = done_tx.send(out);
    });

    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    loop {
        host.pump();
        if let Ok(out) = done_rx.try_recv() {
            return match out {
                Ok(s) => s,
                Err(e) => panic!("JS renderer work failed: {e}"),
            };
        }
        if std::time::Instant::now() > deadline {
            panic!("timed out waiting for JS renderer work (the GTK pump must resolve the ops)");
        }
        // Let the runtime's spawned JS work progress, without sleeping as
        // correctness: the pump + try_recv is the causal poll.
        runtime.block_on(tokio::task::yield_now());
    }
}

/// ONE test owns the GTK thread and runs all slice-3A phases sequentially.
#[test]
fn renderer_port_against_real_adapter() {
    gtk_init();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("tokio runtime");

    let (mut host, tx) = RendererPortHost::new(stub_glb_runner());
    let actor = JsEnvActor::spawn(EmbeddedLoader::new()).expect("spawn actor");
    let tx2 = tx.clone();
    runtime
        .block_on(actor.with_context(move |ctx| install_renderer_adapter(&ctx, tx2, "rendererAdapter")))
        .expect("install renderer adapter");

    // === Phase 1: all six ops against the real adapter ===
    let json = run_js_while_pumping(&runtime, &actor, &mut host, r#"
(async () => {
  const log = [];
  const handle = await rendererAdapter.createSurface({kind:'navigator', width:200, height:400});
  log.push(['created', typeof handle === 'string' && handle.length > 0]);
  await rendererAdapter.attachPresentation(handle, {kind:'navigator', parameters:{heading:'Navigator: obj-root', references:[{label:'obj-b'},{label:'obj-c'}]}});
  log.push(['attached', true]);
  await rendererAdapter.resize(handle, {width:220, height:440});
  log.push(['resized', true]);
  await rendererAdapter.detachPresentation(handle);
  log.push(['detached', true]);
  await rendererAdapter.attachPresentation(handle, {kind:'navigator', parameters:{heading:'Navigator: obj-root', references:[{label:'obj-d'}]}});
  log.push(['reattached', true]);
  await rendererAdapter.destroySurface(handle);
  log.push(['destroyed', true]);
  await rendererAdapter.destroyAll();
  await rendererAdapter.destroyAll();
  log.push(['destroyAll-idempotent', true]);
  return { log, handle };
})()
"#);
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    for entry in v["log"].as_array().unwrap() {
        assert_eq!(entry[1], serde_json::json!(true), "six-op failed: {entry}");
    }
    let handle = v["handle"].as_str().unwrap();
    assert!(handle.starts_with("linux-surface-"), "real opaque transient handle: {handle}");

    // === Phase 2: presentOn detach->attach sequence -> GTK shows the LATEST ===
    // The presentation descriptors use the REAL projector shape (matching the
    // Rust `projector.rs` the adapter calls): {kind, subject:{objectId},
    // parameters:{fields:{slot:value}, references:[...]}}. The heading is
    // "Inspector: <objectId>" from subject.objectId; fields are slot->value.
    let json = run_js_while_pumping(&runtime, &actor, &mut host, r#"
(async () => {
  const handle = await rendererAdapter.createSurface({kind:'inspector', width:300, height:400});
  await rendererAdapter.attachPresentation(handle, {kind:'inspector', subject:{objectId:'obj-root'}, parameters:{fields:{title:'original'}}});
  await rendererAdapter.detachPresentation(handle);
  await rendererAdapter.attachPresentation(handle, {kind:'inspector', subject:{objectId:'obj-root'}, parameters:{fields:{title:'edited'}}});
  return { handle };
})()
"#);
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    let insp_handle = v["handle"].as_str().unwrap().to_string();
    assert!(insp_handle.starts_with("linux-surface-"));
    // The GTK inspector realized the LATEST presentation on the persistent handle.
    let text = host.adapter().gtk_visible_text(&insp_handle).expect("inspector text");
    assert!(text.iter().any(|t| t == "edited"), "inspector shows the re-presented value: {text:?}");
    assert!(!text.iter().any(|t| t == "original"), "the stale value is gone: {text:?}");

    // === Phase 3: loud-reject crosses the port (adapter's OWN message) ===
    let json = run_js_while_pumping(&runtime, &actor, &mut host, r#"
(async () => {
  try {
    await rendererAdapter.attachPresentation('linux-surface-does-not-exist', {kind:'navigator', parameters:{heading:'x'}});
    return { rejected: false };
  } catch (e) {
    return { rejected: true, message: String(e) };
  }
})()
"#);
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(v["rejected"], serde_json::json!(true), "unknown surface must reject");
    let msg = v["message"].as_str().unwrap();
    assert!(
        msg.contains("unknown/destroyed surface"),
        "the adapter's OWN loud-reject message crosses the port (not an opaque 'op'): {msg}"
    );

    // === Phase 4: a renderer op SUSPENDS (does NOT block the JS-owner thread) ==
    // The load-bearing slice-2 invariant at the port's own channel: while a
    // renderer op is IN FLIGHT (the GTK thread has not resolved it — we do NOT
    // pump yet), the JS owner must remain responsive: a host push delivered now
    // runs BEFORE the op's continuation. If the op blocked the JS-owner thread,
    // the push could not run until the op finished. This discriminates the
    // suspend-on-oneshot design from the tempting blocking-recv design.
    //
    // Install a push handler that records, then start an op WITHOUT pumping.
    runtime
        .block_on(actor.eval(
            r#"
globalThis.__order = [];
globalThis.__jsenv_on_push = async (payload) => { globalThis.__order.push('push:' + payload); };
"#,
        ))
        .expect("install push handler");

    // Start a createSurface op but DO NOT pump the GTK host yet: the op is in
    // flight, its oneshot unresolved. Use `eval` (NOT `eval_async`): `eval`
    // STARTS the async IIFE and returns once the first `await` PARKS, freeing the
    // owner's command loop for the push. (`eval_async` would drive the WHOLE
    // IIFE promise to completion inside one command — blocking the command loop
    // on the parked createSurface await and deadlocking the push.)
    runtime
        .block_on(actor.eval(
            r#"
(async () => {
  const h = await rendererAdapter.createSurface({kind:'navigator', width:100, height:100});
  globalThis.__order.push('op-resumed');
})()
"#,
        ))
        .expect("start createSurface op");

    // Deliver a push WITHOUT pumping the GTK host. If the JS owner is responsive
    // (op suspended), the push handler runs now — WHILE the op is still
    // unresolved.
    runtime.block_on(actor.push("intent-x")).expect("push while op in flight");

    // DISCRIMINATING ASSERTION (at this instant, BEFORE pumping): the op has NOT
    // resolved (we have not pumped the GTK host), so `op-resumed` must be ABSENT
    // — yet `push:intent-x` ran. If the op blocked the JS-owner thread (a
    // blocking recv), the push could not have been delivered while the op was
    // unresolved, so `__order` would be empty here. Suspend => ['push:intent-x'].
    let mid_json = runtime
        .block_on(actor.eval_async("globalThis.__order"))
        .expect("read mid order");
    let mid: Vec<String> = serde_json::from_str(&mid_json).unwrap();
    assert_eq!(
        mid,
        vec!["push:intent-x".to_string()],
        "SUSPEND-PROOF: while the renderer op was still UNRESOLVED (GTK host not yet pumped), the \
         push handler ran — the JS owner stayed responsive (suspend-on-oneshot, NOT a blocking \
         recv that would have frozen the owner and left __order empty): {mid:?}"
    );

    // NOW pump the GTK host so the op resolves; the owner's drive loop resumes
    // the continuation (records 'op-resumed'). Pump until 'op-resumed' appears.
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let order: Vec<String> = loop {
        host.pump();
        let order_json = runtime
            .block_on(actor.eval_async("globalThis.__order"))
            .expect("read order");
        let order: Vec<String> = serde_json::from_str(&order_json).unwrap();
        if order.iter().any(|o| o == "op-resumed") {
            break order;
        }
        if std::time::Instant::now() > deadline {
            panic!("op continuation never resumed after pumping: {order:?}");
        }
        runtime.block_on(tokio::task::yield_now());
    };
    assert_eq!(
        order,
        vec!["push:intent-x".to_string(), "op-resumed".to_string()],
        "after pumping, the op continuation resumed: {order:?}"
    );

    runtime.block_on(actor.shutdown());
}
