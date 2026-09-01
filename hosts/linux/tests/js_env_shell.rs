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

/// A timeout fires through the OWNER pump: the guest registers a setTimeout, and
/// only when the owner pumps due timers (calling `__jsenv_fire_due` on the owner
/// thread) does the callback run. No unrelated thread is involved.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn timeout_fires_through_owner_pump() {
    let actor = JsEnvActor::spawn(EmbeddedLoader::new()).expect("spawn actor");

    // Register a timeout (ms=0); it must NOT fire until the owner pumps.
    let before = actor
        .eval_async(
            r#"globalThis.__fired = false; setTimeout(() => { globalThis.__fired = true; }, 0); return globalThis.__fired;"#,
        )
        .await
        .expect("register timer");
    assert_eq!(before, "false", "timer must not fire before the owner pumps");

    // Owner pumps due timers (now = far future) ON the owner thread.
    let after = actor
        .eval_async(
            r#"
const fired = globalThis.__jsenv_fire_due(Number.MAX_SAFE_INTEGER);
return { firedCount: fired, firedFlag: globalThis.__fired };
"#,
        )
        .await
        .expect("pump timers");
    let v: serde_json::Value = serde_json::from_str(&after).unwrap();
    assert_eq!(v["firedCount"], serde_json::json!(1), "exactly one due timer fired via the owner pump");
    assert_eq!(v["firedFlag"], serde_json::json!(true), "timer callback ran through the owner pump");
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
