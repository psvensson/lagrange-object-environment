//! 3zb-A slice-1 acceptance: the rquickjs runtime shell.
//!
//! Proves, at minimum (per the slice-1 charter):
//!   - real checked-in-style ESM source loads unchanged (multi-module imports);
//!   - Promise jobs execute;
//!   - AbortSignal {once:true} + add/remove listener semantics work;
//!   - a timeout fires through the OWNER pump, not an unrelated thread;
//!   - shutdown drops pending host timers cleanly;
//!   - unsupported/Node global facilities remain absent (no `process`, no
//!     `Buffer`, no `require`, no `fetch`, no `crypto`, no `structuredClone`).
//!
//! All JS contact routes through the dedicated-owner-thread actor
//! (`js_env::actor::JsEnvActor`): the ONLY public path to QuickJS is the owner
//! thread's command channel (one owner by construction, per the slice-2 review).
//! The slice-1 `JsEnvOwner` accessors are crate-private; tests use the actor like
//! production does.
//!
//! This slice deliberately does NOT touch the RendererAdapter or any Images
//! capability. It is the runtime shell boundary, reviewed before it accretes
//! more features.

use lagrange_host_linux::js_env::actor::JsEnvActor;
use lagrange_host_linux::js_env::EmbeddedLoader;

/// A tiny multi-module ESM graph, exercising relative imports the same way the
/// Environment core does (`./dep` from an entry).
const DEP: &str = r#"
export const base = 40;
export function add(a, b) { return a + b; }
"#;

const UTIL: &str = r#"
import { base } from './dep.js';
export const doubled = base * 2;
"#;

const ENTRY: &str = r#"
import { add } from './dep.js';
import { doubled } from './util.js';
export const result = add(doubled, 2); // 80 + 2 = 82
"#;

fn graph_loader() -> EmbeddedLoader {
    EmbeddedLoader::new()
        .with_module("dep", DEP)
        .with_module("util", UTIL)
        .with_module("entry", ENTRY)
}

/// Multi-module ESM graph loads unchanged; relative imports resolve; the
/// computed value is exact (distinguishes a real ESM evaluation from a stub).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn loads_multi_module_esm_graph() {
    let actor = JsEnvActor::spawn(graph_loader()).expect("spawn actor");
    // Import the entry module and read its computed export. `import(...)` returns
    // a promise the owner drives; we read `result` from the module namespace.
    let json = actor
        .eval_async("import('entry').then((m) => m.result)")
        .await
        .expect("eval module import");
    assert_eq!(json, "82", "multi-module ESM graph must evaluate to the exact computed value");
    actor.shutdown().await;
}

/// Promise jobs execute on the owner thread (microtasks drain).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn promise_jobs_execute() {
    let actor = JsEnvActor::spawn(EmbeddedLoader::new()).expect("spawn actor");
    let json = actor
        .eval_async("Promise.resolve(21).then((x) => x * 2)")
        .await
        .expect("eval promise");
    assert_eq!(json, "42");
    actor.shutdown().await;
}

/// AbortSignal listener semantics: addEventListener, {once:true} fires exactly
/// once, removeEventListener prevents firing, abort() is idempotent.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn abort_signal_listener_semantics() {
    let actor = JsEnvActor::spawn(EmbeddedLoader::new()).expect("spawn actor");
    let json = actor
        .eval_async(
            r#"
const c = new AbortController();
const log = [];
const persistent = () => log.push('p');
const once = () => log.push('o');
const removed = () => log.push('r');
c.signal.addEventListener('abort', persistent);
c.signal.addEventListener('abort', once, { once: true });
c.signal.addEventListener('abort', removed);
c.signal.removeEventListener('abort', removed);
if (c.signal.aborted) log.push('pre-aborted');
c.abort();           // fires persistent + once; removed must NOT fire
const afterFirst = c.signal.aborted;
c.abort();           // idempotent: nothing more fires
const c2 = new AbortController();
const log2 = [];
c2.signal.addEventListener('abort', () => log2.push('o2'), { once: true });
c2.abort();
c2.abort();
return { log, afterFirst, log2 };
"#,
        )
        .await
        .expect("eval abort semantics");
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(v["log"], serde_json::json!(["p", "o"]), "persistent + once fire; removed never fires");
    assert_eq!(v["afterFirst"], serde_json::json!(true), "aborted is true after abort");
    assert_eq!(v["log2"], serde_json::json!(["o2"]), "a fresh once-listener fires once (idempotent second abort)");
    actor.shutdown().await;
}

/// A guest setTimeout fires AUTOMATICALLY through the actor's command-loop pump
/// — with NO manual `__jsenv_fire_due` call. This is the 3B correction: the
/// actor's loop wakes at the next timer's due time and fires it (image-observation
/// depends on guest setTimeout; previously timers only fired when a test pumped
/// them manually). The timer callback runs on the OWNER thread.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn timeout_fires_automatically_via_actor_pump() {
    let actor = JsEnvActor::spawn(EmbeddedLoader::new()).expect("spawn actor");

    // Register a short timeout. The actor's loop must fire it WITHOUT the test
    // ever calling __jsenv_fire_due. Record the firing thread to prove it runs on
    // the owner thread (not some other thread).
    actor
        .eval_async(
            r#"globalThis.__fired = false; setTimeout(() => { globalThis.__fired = true; }, 20); return true;"#,
        )
        .await
        .expect("register timer");

    // Poll (with a generous deadline) until the actor's automatic pump fires the
    // timer. NO manual fire_due anywhere.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let fired = loop {
        let v = actor
            .eval_async("globalThis.__fired")
            .await
            .expect("read flag");
        if v == "true" {
            break true;
        }
        if std::time::Instant::now() > deadline {
            panic!("timer never fired automatically: __fired still {v}");
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    };
    assert!(fired, "the actor fired the guest setTimeout automatically (no manual pump)");
    actor.shutdown().await;
}

/// MISSED-WAKEUP proof (slice-3B review Finding 2): a setTimeout registered by a
/// CONTINUATION that resumes AFTER the command that started it already returned
/// must still fire — with ZERO further JS commands in flight (any harness
/// eval_async would itself turn the command loop and mask the bug). The guest
/// `__jsenv_timer_changed` host fn wakes the owner loop to recompute next_due.
///
/// Setup: a fire-and-forget script awaits a suspending host call (`__jsenv_delay`,
/// an Async fn that yields to the drive loop), and in its continuation registers
/// a setTimeout whose callback signals a RUST-side `Arc<AtomicBool>` (NOT a JS
/// global — reading a JS global would need a command). The test polls the atomic
/// with Rust-side sleeps only. Without the timer_notify wakeup, the command loop
/// parks with no pending timers and the timer never fires -> the test times out.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn timer_registered_by_resumed_continuation_fires_with_no_commands() {
    use rquickjs::prelude::Async;
    use rquickjs::Function;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };

    let actor = JsEnvActor::spawn(EmbeddedLoader::new()).expect("spawn actor");
    let done = Arc::new(AtomicBool::new(false));

    // Install __jsenv_delay(ms) (Async: yields to the drive loop) and
    // __jsenv_signal_done() (sync: sets the Rust-side atomic).
    {
        let done = Arc::clone(&done);
        actor
            .with_context(move |ctx| {
                let delay = Function::new(
                    ctx.clone(),
                    Async(move |ms: f64| async move {
                        tokio::time::sleep(std::time::Duration::from_millis(ms as u64)).await;
                    }),
                )
                .map_err(|e| rquickjs::Error::from(e))?;
                ctx.globals().set("__jsenv_delay", delay)?;
                let signal = Function::new(ctx.clone(), move || {
                    done.store(true, Ordering::SeqCst);
                })
                .map_err(|e| rquickjs::Error::from(e))?;
                ctx.globals().set("__jsenv_signal_done", signal)?;
                Ok(())
            })
            .await
            .expect("install host fns");
    }

    // Fire-and-forget: await the suspending host call, then in the CONTINUATION
    // register the timer. `eval` returns as soon as the first await parks, so the
    // timer is registered LATER (by the drive task), after this command returned.
    actor
        .eval(
            r#"(async () => { await __jsenv_delay(30); setTimeout(() => { __jsenv_signal_done(); }, 5); })()"#,
        )
        .await
        .expect("start suspending script");

    // Poll the RUST-side atomic with Rust sleeps ONLY — zero JS commands, so the
    // command loop is never prodded. The only thing that can fire the timer is
    // the timer_notify wakeup.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !done.load(Ordering::SeqCst) {
        if std::time::Instant::now() > deadline {
            panic!("timer registered by a resumed continuation never fired (missed wakeup)");
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    actor.shutdown().await;
}

/// clearTimeout removes a pending timer so the pump does not fire it; and a
/// dropped owner leaves no pending host timer that could fire after free.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn clear_and_shutdown_drop_pending_timers() {
    let actor = JsEnvActor::spawn(EmbeddedLoader::new()).expect("spawn actor");
    let json = actor
        .eval_async(
            r#"
globalThis.__a = false; globalThis.__b = false;
const idA = setTimeout(() => { globalThis.__a = true; }, 0);
setTimeout(() => { globalThis.__b = true; }, 0);
clearTimeout(idA);
const firedCount = globalThis.__jsenv_fire_due(Number.MAX_SAFE_INTEGER);
return { firedCount, a: globalThis.__a, b: globalThis.__b };
"#,
        )
        .await
        .expect("clear + pump");
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(v["firedCount"], serde_json::json!(1), "cleared timer must not fire");
    assert_eq!(v["a"], serde_json::json!(false));
    assert_eq!(v["b"], serde_json::json!(true));
    // Drop the actor (shutdown); no detached native timer thread outlives it.
    actor.shutdown().await;
}

/// Node/unsupported globals remain ABSENT in the guest. This is the boundary
/// falsifier: the embed must not grow a Node personality.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn node_facilities_remain_absent() {
    let actor = JsEnvActor::spawn(EmbeddedLoader::new()).expect("spawn actor");
    let json = actor
        .eval_async(
            r#"
return {
  process: typeof process,
  Buffer: typeof Buffer,
  require: typeof require,
  fetch: typeof fetch,
  crypto: typeof crypto,
  structuredClone: typeof structuredClone,
  global: typeof global,
  __dirname: typeof __dirname,
  // Present-and-used natives:
  Promise: typeof Promise,
  queueMicrotask: typeof queueMicrotask,
  atob: typeof atob,
  btoa: typeof btoa,
  AbortController: typeof AbortController,
  setTimeout: typeof setTimeout,
};
"#,
        )
        .await
        .expect("eval globals");
    let v: serde_json::Value = serde_json::from_str(&json).unwrap();
    for key in ["process", "Buffer", "require", "fetch", "crypto", "structuredClone", "global", "__dirname"] {
        assert_eq!(v[key], serde_json::json!("undefined"), "{key} must be absent (no Node personality)");
    }
    for key in ["Promise", "queueMicrotask", "atob", "btoa", "AbortController", "setTimeout"] {
        assert_eq!(v[key], serde_json::json!("function"), "{key} must be present");
    }
    actor.shutdown().await;
}
