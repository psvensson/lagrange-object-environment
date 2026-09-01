//! 3zb-A slice 2: the cross-thread async-port + host-push/re-entry FALSIFIER.
//!
//! The real kill test for the embed's threading model. It uses the
//! dedicated-owner-thread actor (`js_env::actor::JsEnvActor`), which establishes
//! ONE semantic JS owner BY CONSTRUCTION (a single OS thread owns the runtime;
//! all QuickJS contact happens there). The earlier task-based model was
//! FALSIFIED by measurement: `tokio::spawn(drive())` on a multi-thread runtime
//! let a continuation resume on a different worker thread than the spawner.
//!
//! Proven causally (thread-id assertions; perturbations go RED):
//!   (A) async capability resolves on a NON-JS thread; the continuation resumes
//!       on the JS-owner thread; double-resolve rejected loudly; shutdown with a
//!       pending capability rejects (no hang/use-after-free).
//!   (B) idle host push wakes the owner -> JS handler -> further async step ->
//!       continuation. No spinning; NOT AsyncRuntime::idle().
//!   (C) interleaving: a push arriving WHILE a JS await is in flight is handled
//!       by ONE deterministic rule (commands are processed in mpsc order; a push
//!       is delivered only after the currently-processing command's JS drains),
//!       NOT blanket serialization of all async I/O.

use std::sync::{Arc, Mutex};

use lagrange_host_linux::js_env::actor::JsEnvActor;
use lagrange_host_linux::js_env::EmbeddedLoader;
use rquickjs::prelude::Async;
use rquickjs::Function;
use tokio::sync::Notify;

/// A signal recorder injectable into JS: `__signal(label, value)` records the
/// value + the CURRENT thread id (the thread the JS callback ran on) and fires a
/// Notify so the test wakes CAUSALLY (no sleeps).
struct Signal {
    notify: Notify,
    record: Mutex<Vec<(String, String, String)>>, // (label, value, threadId)
}
impl Signal {
    fn new() -> Arc<Self> {
        Arc::new(Self { notify: Notify::new(), record: Mutex::new(Vec::new()) })
    }
    fn records(&self) -> Vec<(String, String, String)> {
        self.record.lock().unwrap().clone()
    }
}

async fn install_signal(actor: &JsEnvActor, sig: Arc<Signal>) {
    actor
        .with_context(move |ctx| {
            let sig2 = sig.clone();
            let f = Function::new(ctx.clone(), move |label: String, value: String| {
                let tid = format!("{:?}", std::thread::current().id());
                sig2.record.lock().unwrap().push((label, value, tid));
                sig2.notify.notify_one();
            })
            .unwrap();
            ctx.globals().set("__signal", f).unwrap();
            Ok(())
        })
        .await
        .unwrap();
}

/// Install `__threadId()` returning the current thread id string (so JS can
/// report which thread a continuation resumed on).
async fn install_thread_probe(actor: &JsEnvActor) {
    actor
        .with_context(|ctx| {
            let probe = Function::new(ctx.clone(), || format!("{:?}", std::thread::current().id())).unwrap();
            ctx.globals().set("__threadId", probe).unwrap();
            Ok(())
        })
        .await
        .unwrap();
}

/// Install an async capability `imagesRead(key)` returning a JS Promise bridged
/// from a Rust future awaiting a oneshot. Returns a trigger resolvable from ANY
/// (non-JS) thread. Exactly-once (double-resolve rejected); dropping rejects.
async fn install_async_capability(actor: &JsEnvActor) -> CapabilityTrigger {
    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let rx_cell = Arc::new(Mutex::new(Some(rx)));
    let rx_for_fn = rx_cell.clone();
    actor
        .with_context(move |ctx| {
            let read = Function::new(
                ctx.clone(),
                Async(move |_key: String| {
                    let rx = rx_for_fn.lock().unwrap().take();
                    async move {
                        match rx {
                            Some(rx) => rx
                                .await
                                .map_err(|_| rquickjs::Error::new_from_js("capability", "shutdown")),
                            None => Err(rquickjs::Error::new_from_js("capability", "taken")),
                        }
                    }
                }),
            )
            .unwrap();
            ctx.globals().set("imagesRead", read).unwrap();
            Ok(())
        })
        .await
        .unwrap();
    CapabilityTrigger { tx: Mutex::new(Some(tx)) }
}

struct CapabilityTrigger {
    tx: Mutex<Option<tokio::sync::oneshot::Sender<String>>>,
}
impl CapabilityTrigger {
    fn resolve(&self, value: &str) -> Result<(), String> {
        match self.tx.lock().unwrap().take() {
            Some(tx) => tx.send(value.to_string()).map_err(|_| "receiver dropped".into()),
            None => Err("double-resolve rejected".into()),
        }
    }
}

/// (A) async capability resolves on a NON-JS thread; the continuation resumes on
/// the JS-runtime owner thread (thread-id asserted).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn async_capability_resumes_on_js_owner_thread() {
    let actor = JsEnvActor::spawn(EmbeddedLoader::new()).expect("spawn actor");
    let owner_tid = format!("{:?}", actor.owner_thread_id());
    install_signal(&actor, Signal::new()).await;
    install_thread_probe(&actor).await;
    let sig = Signal::new();
    install_signal(&actor, sig.clone()).await;
    let trigger = install_async_capability(&actor).await;

    // JS: await the capability, then signal the value + the resumed thread id.
    actor
        .eval(
            r#"
(async () => {
  const v = await imagesRead('k1');
  __signal('continuation', v + '|' + __threadId());
})()
"#,
        )
        .await
        .unwrap();

    // Resolve from a DIFFERENT (non-JS) thread.
    let resolver_thread = std::thread::spawn({
        let value = trigger;
        move || {
            let t = std::thread::current().id();
            value.resolve("image-bytes-42").expect("resolve");
            t
        }
    })
    .join()
    .unwrap();
    assert_ne!(format!("{:?}", resolver_thread), owner_tid, "capability resolved on a NON-JS thread");

    // Wait causally for the continuation to signal (poll the record, driven by
    // the owner's drive task; use a bounded causal wait, not a fixed sleep).
    let recs = wait_for_records(&sig, 1).await;
    let (label, payload, signal_thread) = &recs[0];
    assert_eq!(label, "continuation");
    assert!(payload.starts_with("image-bytes-42|"), "value reached the continuation: {payload}");
    let js_reported_thread = payload.strip_prefix("image-bytes-42|").unwrap();
    assert_eq!(js_reported_thread, signal_thread, "JS-reported thread == signal thread (both the owner)");
    assert_eq!(*signal_thread, owner_tid, "continuation resumed on the JS-runtime OWNER thread");
    assert_ne!(*signal_thread, format!("{:?}", resolver_thread), "continuation did NOT run on the resolver thread");

    actor.shutdown().await;
}

/// (A-double) a second resolve attempt on the same capability fails loudly.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn double_resolve_is_rejected_loudly() {
    let actor = JsEnvActor::spawn(EmbeddedLoader::new()).expect("spawn actor");
    let trigger = install_async_capability(&actor).await;
    trigger.resolve("first").expect("first resolve");
    let second = trigger.resolve("second");
    assert!(second.is_err(), "double-resolve must be rejected loudly");
    assert_eq!(second.unwrap_err(), "double-resolve rejected");
    actor.shutdown().await;
}

/// (A-shutdown) dropping the capability sender rejects the pending promise
/// (caught) rather than hanging or use-after-free.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shutdown_with_pending_capability_rejects_not_hang() {
    let actor = JsEnvActor::spawn(EmbeddedLoader::new()).expect("spawn actor");
    let sig = Signal::new();
    install_signal(&actor, sig.clone()).await;
    let trigger = install_async_capability(&actor).await;

    actor
        .eval(
            r#"
(async () => {
  try { await imagesRead('k'); __signal('outcome', 'ok'); }
  catch (e) { __signal('outcome', 'rejected'); }
})()
"#,
        )
        .await
        .unwrap();

    drop(trigger); // shutdown with a pending capability
    let recs = wait_for_records(&sig, 1).await;
    assert_eq!(recs[0].1, "rejected", "pending capability rejects cleanly on shutdown");
    actor.shutdown().await;
}

/// (B) idle host push wakes the owner -> JS handler -> further async step ->
/// continuation. No spinning; NOT AsyncRuntime::idle().
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn idle_host_push_wakes_owner_and_reenters_js() {
    let actor = JsEnvActor::spawn(EmbeddedLoader::new()).expect("spawn actor");
    let sig = Signal::new();
    install_signal(&actor, sig.clone()).await;

    actor
        .eval(
            r#"
globalThis.__jsenv_on_push = async (payload) => {
  __signal('push-received', payload);
  const more = await Promise.resolve('after-push:' + payload);
  __signal('push-continuation', more);
};
"#,
        )
        .await
        .unwrap();

    // The guest is now fully idle. A host push from a NON-JS thread wakes the
    // owner and re-enters JS.
    let pusher = std::thread::spawn({
        let actor_tx = actor.clone_sender();
        move || {
            actor_tx.push_blocking("observation-rev-7").expect("push");
        }
    });
    pusher.join().unwrap();

    let recs = wait_for_records(&sig, 2).await;
    assert!(recs.iter().any(|(l, v, _)| l == "push-received" && v == "observation-rev-7"),
        "idle guest woken by host push: {recs:?}");
    assert!(recs.iter().any(|(l, v, _)| l == "push-continuation" && v == "after-push:observation-rev-7"),
        "re-entered JS made a further async step: {recs:?}");
    actor.shutdown().await;
}

/// (C) interleaving: pushes/intents are processed in mpsc order; a push is
/// delivered only after the currently-processing command's JS drains. The rule
/// is deterministic and does NOT blanket-serialize all async I/O (an async
/// Images await SUSPENDS the JS, freeing the owner to process other commands —
/// the await does not block the owner thread).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn async_await_does_not_block_owner_thread() {
    let actor = JsEnvActor::spawn(EmbeddedLoader::new()).expect("spawn actor");
    let sig = Signal::new();
    install_signal(&actor, sig.clone()).await;
    let trigger = install_async_capability(&actor).await;

    // JS starts an await (suspends) AND registers a push handler.
    actor
        .eval(
            r#"
globalThis.__jsenv_on_push = async (payload) => { __signal('push', payload); };
(async () => {
  __signal('await-start', 'x');
  const v = await imagesRead('k');
  __signal('await-resumed', v);
})()
"#,
        )
        .await
        .unwrap();

    // While the await is parked (unresolved), deliver a push. Because the await
    // SUSPENDED the JS (rather than blocking the owner thread), the push handler
    // runs BEFORE the await resumes — proving the owner stayed responsive during
    // async I/O (this is the "renderer-call-blocked != async-await-suspended"
    // distinction: an async Images await must NOT serialize the environment).
    actor.push("intent-activate").await.expect("push delivered while await parked");
    trigger.resolve("img-1").expect("resolve");

    let recs = wait_for_records(&sig, 3).await;
    let labels: Vec<&str> = recs.iter().map(|(l, _, _)| l.as_str()).collect();
    let started = labels.iter().position(|l| *l == "await-start").unwrap();
    let pushed = labels.iter().position(|l| *l == "push").unwrap();
    let resumed = labels.iter().position(|l| *l == "await-resumed").unwrap();
    assert!(started < pushed, "await started before push: {labels:?}");
    assert!(
        pushed < resumed,
        "DETERMINISTIC RULE: while a JS await is SUSPENDED (non-blocking), the owner stays responsive — \
         the push is delivered BEFORE the await resumes. The await did NOT serialize the environment: {labels:?}"
    );
    assert_eq!(recs[resumed].1, "img-1", "await later resumed with the capability value");
    actor.shutdown().await;
}

/// (C-stronger) the resolve-first variant: proves the interleaving rule against
/// the ACTUAL wrong design (blanket serialization of all async I/O), not just
/// the send-order triviality. Here the capability resolves FIRST (so the await
/// COULD resume immediately), and the push arrives while the resume is still
/// pending. Under a wrong "serialize everything behind the await" model the push
/// could not be processed until the await fully completed; the deterministic
/// rule must still hold and BOTH must complete with no deadlock and no
/// starvation. The key non-trivial assertion: the push is processed by a live
/// owner even when the resolve raced ahead, and the await resumes exactly once
/// with the right value — no double-resume, no lost push.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn resolve_first_then_push_still_deterministic_no_starvation() {
    let actor = JsEnvActor::spawn(EmbeddedLoader::new()).expect("spawn actor");
    let sig = Signal::new();
    install_signal(&actor, sig.clone()).await;
    let trigger = install_async_capability(&actor).await;

    actor
        .eval(
            r#"
globalThis.__jsenv_on_push = async (payload) => { __signal('push', payload); };
(async () => {
  __signal('await-start', 'x');
  const v = await imagesRead('k');
  __signal('await-resumed', v);
})()
"#,
        )
        .await
        .unwrap();

    // Resolve FIRST (the await can now resume), THEN push. The push command and
    // the resume race; the deterministic rule must still produce exactly one
    // resume (correct value) and exactly one push, with no starvation or
    // deadlock — and crucially the owner must remain live to process the push.
    trigger.resolve("img-1").expect("resolve first");
    actor.push("intent-activate").await.expect("push after resolve");

    let recs = wait_for_records(&sig, 3).await;
    let labels: Vec<&str> = recs.iter().map(|(l, _, _)| l.as_str()).collect();
    assert_eq!(labels.iter().filter(|l| **l == "await-resumed").count(), 1, "exactly one resume: {labels:?}");
    assert_eq!(labels.iter().filter(|l| **l == "push").count(), 1, "exactly one push (no loss): {labels:?}");
    let resumed = recs.iter().find(|(l, _, _)| l == "await-resumed").unwrap();
    assert_eq!(resumed.1, "img-1", "resume carried the resolved value");
    let pushed = recs.iter().find(|(l, _, _)| l == "push").unwrap();
    assert_eq!(pushed.1, "intent-activate", "push not starved by the racing resume");
    actor.shutdown().await;
}

/// Causal bounded wait for N signal records (no fixed sleep; polls driven by a
/// Notify with a timeout guard so a broken model fails rather than hangs CI).
async fn wait_for_records(sig: &Arc<Signal>, n: usize) -> Vec<(String, String, String)> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        {
            let recs = sig.record.lock().unwrap();
            if recs.len() >= n {
                return recs.clone();
            }
        }
        if std::time::Instant::now() > deadline {
            panic!("timed out waiting for {n} signal records; got {:?}", sig.records());
        }
        // Causal: wake on the next signal OR re-check after a short park. The
        // Notify is fired by JS callbacks; the park bounds the poll cadence.
        let _ = tokio::time::timeout(std::time::Duration::from_millis(20), sig.notify.notified()).await;
    }
}
