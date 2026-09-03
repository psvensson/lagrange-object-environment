//! Shared test-only driver for the in-process Environment/GTK acceptance
//! protocol. Composition modules own setup and dependency injection; this file
//! alone owns the common open -> NAV -> OBS -> OLM -> STALE -> DENIED -> C1
//! sequencing, renderer pumping, and assertions.

use std::sync::Once;
use std::time::{Duration, Instant};

use lagrange_host_linux::js_env::actor::JsEnvActor;
use lagrange_host_linux::js_env::renderer_port::RendererPortHost;
use serde_json::{json, Value};

static GTK_INIT: Once = Once::new();

pub fn gtk_init() {
    GTK_INIT.call_once(|| {
        gtk4::init().expect("gtk4::init() must succeed (run under Xvfb/xvfb-run)");
    });
}

pub fn stub_glb_runner() -> lagrange_host_linux::linux_adapter::GlbRunner {
    Box::new(|_fut| -> Result<lagrange_host_linux::GlbInstance, String> {
        Err("glb not wired in the in-process tool acceptance".to_string())
    })
}

/// Flavor-specific values stay explicit so the fake and real compositions can
/// share sequencing without weakening their deliberately different proofs.
pub struct AcceptanceFlavor<'a> {
    pub name: &'a str,
    pub root_object_id: &'a str,
    pub initial_title: &'a str,
    pub observed_title: &'a str,
    pub olm_title: &'a str,
    pub stale_external_title: &'a str,
    pub stale_attempt_title: &'a str,
    pub denied_write_title: &'a str,
    pub denied_attempt_title: &'a str,
    pub denied_write_same_object_as_primary: bool,
    pub minimum_c1_tokens: u64,
}

/// Drive a JS async block that triggers renderer ops, pumping the GTK host on
/// this thread until JS completes. Renderer promises cannot resolve without
/// this pump; GTK intent delivery itself remains composition-owned and
/// fire-and-forget.
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

/// Pump once, then evaluate a bounded pure-read or fire-and-forget seam.
fn pump_and_eval(
    runtime: &tokio::runtime::Runtime,
    actor: &JsEnvActor,
    host: &mut RendererPortHost,
    js: &str,
) -> String {
    host.pump();
    runtime
        .block_on(actor.eval_async(js))
        .expect("pump_and_eval")
}

fn parse_json(out: String, what: &str) -> Value {
    serde_json::from_str(&out)
        .unwrap_or_else(|error| panic!("{what} returned non-JSON output: {error}; output={out}"))
}

fn run_json_while_pumping(
    runtime: &tokio::runtime::Runtime,
    actor: &JsEnvActor,
    host: &mut RendererPortHost,
    js: &str,
    what: &str,
) -> Value {
    parse_json(run_js_while_pumping(runtime, actor, host, js), what)
}

fn pump_and_eval_json(
    runtime: &tokio::runtime::Runtime,
    actor: &JsEnvActor,
    host: &mut RendererPortHost,
    js: &str,
    what: &str,
) -> Value {
    parse_json(pump_and_eval(runtime, actor, host, js), what)
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
        let value = serde_json::from_str(&out).unwrap_or_else(|_| json!({"_unparsed": out}));
        if pred(&value) {
            return value;
        }
        if Instant::now() > deadline {
            panic!("poll timed out: {what}; last={value}");
        }
        runtime.block_on(tokio::task::yield_now());
    }
}

fn assert_exact_keys(value: &Value, expected: &[&str], what: &str) {
    let object = value
        .as_object()
        .unwrap_or_else(|| panic!("{what} must be an object: {value}"));
    let mut actual = object.keys().map(String::as_str).collect::<Vec<_>>();
    let mut expected = expected.to_vec();
    actual.sort_unstable();
    expected.sort_unstable();
    assert_eq!(actual, expected, "{what} exact key set");
}

fn assert_nonempty_string(value: &Value, what: &str) {
    assert!(
        value.as_str().is_some_and(|s| !s.is_empty()),
        "{what} must be a nonempty string: {value}"
    );
}

fn assert_nonnegative_integer(value: &Value, what: &str) {
    assert!(
        value.as_u64().is_some(),
        "{what} must be a nonnegative integer: {value}"
    );
}

fn session_string_call(method: &str, value: &str) -> String {
    format!(
        "globalThis.__session.{method}({})",
        serde_json::to_string(value).expect("session string argument")
    )
}

fn assert_external_mutation(value: &Value, what: &str) {
    assert_exact_keys(value, &["committed", "tokenAdvanced"], what);
    assert_eq!(
        value,
        &json!({"committed": true, "tokenAdvanced": true}),
        "{what}"
    );
}

fn assert_token_state_shape(value: &Value, what: &str) {
    assert_exact_keys(
        value,
        &[
            "hasToken",
            "objectIdMatchesPrimary",
            "tokenIsFresh",
            "obsEvents",
        ],
        what,
    );
    assert!(
        value["hasToken"].is_boolean(),
        "{what}.hasToken must be boolean"
    );
    assert!(
        value["objectIdMatchesPrimary"].is_boolean(),
        "{what}.objectIdMatchesPrimary must be boolean"
    );
    assert!(
        value["tokenIsFresh"].is_boolean(),
        "{what}.tokenIsFresh must be boolean"
    );
    assert_nonnegative_integer(&value["obsEvents"], &format!("{what}.obsEvents"));
}

fn assert_edit_error(value: &Value, expected_name: &str, what: &str) {
    assert_exact_keys(value, &["edited", "error"], what);
    assert_eq!(
        value["edited"],
        json!(false),
        "{what} must not report a committed edit"
    );
    assert_exact_keys(&value["error"], &["name"], &format!("{what}.error"));
    assert_eq!(
        value["error"]["name"],
        json!(expected_name),
        "{what} classification"
    );
}

pub fn run_in_process_acceptance(
    runtime: &tokio::runtime::Runtime,
    actor: &JsEnvActor,
    host: &mut RendererPortHost,
    flavor: &AcceptanceFlavor<'_>,
) {
    // OPEN: setup/DI is composition-specific; the common protocol begins here.
    let opened = run_json_while_pumping(
        runtime,
        actor,
        host,
        &session_string_call("open", flavor.root_object_id),
        "open",
    );
    assert_exact_keys(
        &opened,
        &[
            "navigatorSurfaceHandle",
            "inspectorSurfaceHandle",
            "rootObjectId",
            "primaryObjectId",
        ],
        "open",
    );
    for key in [
        "navigatorSurfaceHandle",
        "inspectorSurfaceHandle",
        "rootObjectId",
        "primaryObjectId",
    ] {
        assert_nonempty_string(&opened[key], &format!("open.{key}"));
    }
    assert_eq!(
        opened["rootObjectId"],
        json!(flavor.root_object_id),
        "open root identity"
    );
    let navigator_handle = opened["navigatorSurfaceHandle"]
        .as_str()
        .unwrap()
        .to_string();
    let inspector_handle = opened["inspectorSurfaceHandle"]
        .as_str()
        .unwrap()
        .to_string();

    // NAV: a key-only GTK intent is resolved by the real Environment shell.
    let intent = host
        .adapter()
        .activate_gtk_action(&navigator_handle, 0)
        .expect("activate")
        .expect("an activate-item intent");
    assert_eq!(
        intent,
        json!({"kind": "activate-item", "key": 0}),
        "NAV key-only intent"
    );
    let payload = json!({"intent": intent, "surfaceHandle": navigator_handle}).to_string();
    runtime
        .block_on(actor.push(&payload))
        .expect("push activate intent");
    let nav = poll_until(
        runtime,
        actor,
        host,
        "globalThis.__session.inspector()",
        |v| v["title"] == json!(flavor.initial_title),
        "navigation: inspector shows the primary object after activate-item key 0",
    );
    assert_exact_keys(&nav, &["title", "kind", "reason"], "NAV inspector");
    let nav_gtk = host
        .adapter()
        .gtk_visible_text(&inspector_handle)
        .expect("gtk text");
    assert!(
        nav_gtk
            .iter()
            .any(|text| text.contains(flavor.initial_title)),
        "NAV ({}): GTK inspector shows the primary title: {nav_gtk:?}",
        flavor.name
    );

    // OBS: follow after navigation, complete a poll before mutation, then prove
    // the event drove a fresh Images read and GTK presentation.
    let follow = run_json_while_pumping(
        runtime,
        actor,
        host,
        "globalThis.__session.follow()",
        "follow",
    );
    assert_eq!(follow, json!(true), "follow contract");
    let poll_count = poll_until(
        runtime,
        actor,
        host,
        "globalThis.__session.obsPollCount()",
        |v| v.as_u64().unwrap_or(0) >= 1,
        "follow anchor: at least one completed poll",
    );
    assert_nonnegative_integer(&poll_count, "obsPollCount");
    let observed_mutation = run_json_while_pumping(
        runtime,
        actor,
        host,
        &session_string_call("externalMutate", flavor.observed_title),
        "OBS externalMutate",
    );
    assert_external_mutation(&observed_mutation, "OBS externalMutate");
    let observed_state = poll_until(
        runtime,
        actor,
        host,
        "globalThis.__session.tokenState()",
        |v| v["obsEvents"].as_u64().unwrap_or(0) >= 1,
        "observation lane fired",
    );
    assert_token_state_shape(&observed_state, "OBS tokenState");
    let obs = poll_until(
        runtime,
        actor,
        host,
        "(async () => ({ui: globalThis.__session.inspector().title, img: await globalThis.__session.imageTitle()}))()",
        |v| v["ui"] == json!(flavor.observed_title) && v["img"] == json!(flavor.observed_title),
        "observation fresh reread landed in inspector",
    );
    assert_exact_keys(&obs, &["ui", "img"], "OBS reread report");
    assert_eq!(obs["ui"], json!(flavor.observed_title));
    assert_eq!(
        obs["img"],
        json!(flavor.observed_title),
        "OBS fresh Images read"
    );

    // OLM: a held Command makes self-observation arrive while editInFlight > 0.
    let armed = run_json_while_pumping(
        runtime,
        actor,
        host,
        "globalThis.__session.armHold()",
        "armHold",
    );
    assert_eq!(armed, json!(true), "armHold contract");
    let edit_intent = host
        .adapter()
        .edit_gtk_field(&inspector_handle, 0, flavor.olm_title)
        .expect("edit")
        .expect("an edit-field intent");
    assert_eq!(
        edit_intent,
        json!({"kind": "edit-field", "key": 0, "text": flavor.olm_title}),
        "OLM GTK edit intent"
    );
    let payload = json!({"intent": edit_intent, "surfaceHandle": inspector_handle}).to_string();
    runtime
        .block_on(actor.push(&payload))
        .expect("push edit intent");
    let olm = poll_until(
        runtime,
        actor,
        host,
        "({deferred: globalThis.__session.deferredCount(), held: globalThis.__session.gateHeld()})",
        |v| v["deferred"].as_u64().unwrap_or(0) >= 1 && v["held"] == json!(true),
        "OLM self-observation deferred while edit was in flight",
    );
    assert_exact_keys(&olm, &["deferred", "held"], "OLM held report");
    assert_nonnegative_integer(&olm["deferred"], "OLM deferredCount");
    assert!(
        olm["deferred"].as_u64().unwrap() >= 1,
        "OLM defer path must fire"
    );
    assert_eq!(
        olm["held"],
        json!(true),
        "OLM gate must still be held before release"
    );
    let released = run_json_while_pumping(
        runtime,
        actor,
        host,
        "globalThis.__session.releaseGate()",
        "releaseGate",
    );
    assert_eq!(released, json!(true), "releaseGate contract");
    let drained = poll_until(
        runtime,
        actor,
        host,
        "(async () => ({ui: globalThis.__session.inspector().title, tok: await globalThis.__session.tokenState()}))()",
        |v| v["ui"] == json!(flavor.olm_title) && v["tok"]["tokenIsFresh"] == json!(true),
        "OLM deferred reread drained and token re-paired",
    );
    assert_exact_keys(&drained, &["ui", "tok"], "OLM drain report");
    assert_token_state_shape(&drained["tok"], "OLM tokenState");
    let unfollowed = run_json_while_pumping(
        runtime,
        actor,
        host,
        "globalThis.__session.unfollow()",
        "unfollow",
    );
    assert_eq!(
        unfollowed,
        json!(true),
        "unfollow must complete before STALE"
    );

    // STALE: advance behind the unfollowed shell, prove the held token differs,
    // require exact conflict classification, then require recovery reread.
    let stale_mutation = run_json_while_pumping(
        runtime,
        actor,
        host,
        &session_string_call("externalMutate", flavor.stale_external_title),
        "STALE externalMutate",
    );
    assert_external_mutation(&stale_mutation, "STALE externalMutate");
    let entry = pump_and_eval_json(
        runtime,
        actor,
        host,
        "globalThis.__session.staleEditEntryState()",
        "staleEditEntryState",
    );
    assert_exact_keys(
        &entry,
        &["usedStaleToken", "heldIsNull", "differsFromCurrent"],
        "staleEditEntryState",
    );
    assert_eq!(
        entry,
        json!({"usedStaleToken": true, "heldIsNull": false, "differsFromCurrent": true}),
        "STALE must enter with the previously held stale token"
    );
    let stale = run_json_while_pumping(
        runtime,
        actor,
        host,
        &format!(
            "globalThis.__session.edit(0, {})",
            serde_json::to_string(flavor.stale_attempt_title).unwrap()
        ),
        "stale edit",
    );
    assert_edit_error(&stale, "CommandConflictError", "STALE edit");
    let recovered = poll_until(
        runtime,
        actor,
        host,
        "globalThis.__session.inspector()",
        |v| v["title"] == json!(flavor.stale_external_title),
        "STALE recovery reread restores the external value",
    );
    assert_exact_keys(
        &recovered,
        &["title", "kind", "reason"],
        "STALE recovered inspector",
    );

    // DENIED WRITE: composition chooses its flavor-specific target. The fake
    // deliberately uses a separate readable object; the real flavor later must
    // use the primary object while preserving the same result contract.
    let denied_setup = run_json_while_pumping(
        runtime,
        actor,
        host,
        "globalThis.__session.prepareDeniedWrite()",
        "prepareDeniedWrite",
    );
    assert_exact_keys(
        &denied_setup,
        &["expectedTitle", "sameObjectAsPrimary"],
        "prepareDeniedWrite",
    );
    assert_eq!(
        denied_setup["expectedTitle"],
        json!(flavor.denied_write_title)
    );
    assert_eq!(
        denied_setup["sameObjectAsPrimary"],
        json!(flavor.denied_write_same_object_as_primary),
        "DENIED WRITE flavor identity"
    );
    let denied_visible = poll_until(
        runtime,
        actor,
        host,
        "globalThis.__session.inspector()",
        |v| v["title"] == json!(flavor.denied_write_title),
        "denied-write target remains readable",
    );
    assert_exact_keys(
        &denied_visible,
        &["title", "kind", "reason"],
        "DENIED WRITE inspector",
    );
    let denied = run_json_while_pumping(
        runtime,
        actor,
        host,
        &format!(
            "globalThis.__session.edit(0, {})",
            serde_json::to_string(flavor.denied_attempt_title).unwrap()
        ),
        "denied edit",
    );
    assert_edit_error(&denied, "CommandAuthorizationError", "DENIED WRITE edit");
    let denied_after = pump_and_eval_json(
        runtime,
        actor,
        host,
        "globalThis.__session.deniedWriteState()",
        "deniedWriteState",
    );
    assert_exact_keys(
        &denied_after,
        &["imageTitle", "inspectorTitle"],
        "deniedWriteState",
    );
    assert_eq!(
        denied_after["imageTitle"],
        json!(flavor.denied_write_title),
        "denied mutation changes nothing"
    );
    assert_eq!(
        denied_after["inspectorTitle"],
        json!(flavor.denied_write_title),
        "inspector remains usable"
    );

    // DENIED READ: preserve the fake oracle's unauthorized presentation. The
    // unavailable positive-control distinction is deliberately deferred to the
    // real Part 2B composition.
    let selected_denied = run_json_while_pumping(
        runtime,
        actor,
        host,
        "globalThis.__session.selectDeniedRead()",
        "selectDeniedRead",
    );
    assert_exact_keys(&selected_denied, &["selected"], "selectDeniedRead");
    assert_eq!(selected_denied, json!({"selected": true}));
    let denied_read = poll_until(
        runtime,
        actor,
        host,
        "globalThis.__session.inspector()",
        |v| v["kind"] == json!("unauthorized-reference"),
        "denied-read surfaces unauthorized-reference",
    );
    assert_exact_keys(
        &denied_read,
        &["title", "kind", "reason"],
        "DENIED READ inspector",
    );
    assert_eq!(denied_read["kind"], json!("unauthorized-reference"));

    // C1: reselect the primary object, wait for its live token, then prove all
    // checked tokens are absent from durable, renderer, descriptor, and GTK sinks.
    let selected_primary = run_json_while_pumping(
        runtime,
        actor,
        host,
        "globalThis.__session.selectPrimary()",
        "selectPrimary",
    );
    assert_exact_keys(&selected_primary, &["selected"], "selectPrimary");
    assert_eq!(selected_primary, json!({"selected": true}));
    let live_token = poll_until(
        runtime,
        actor,
        host,
        "globalThis.__session.tokenState()",
        |v| v["hasToken"] == json!(true) && v["objectIdMatchesPrimary"] == json!(true),
        "C1 primary live-token anchor",
    );
    assert_token_state_shape(&live_token, "C1 tokenState");
    assert_eq!(live_token["hasToken"], json!(true));
    assert_eq!(live_token["objectIdMatchesPrimary"], json!(true));
    let gtk_text = host
        .adapter()
        .gtk_visible_text(&inspector_handle)
        .expect("gtk text");
    let gtk_descriptor = host
        .adapter()
        .gtk_descriptor(&inspector_handle)
        .expect("gtk desc")
        .unwrap_or(json!(null));
    let c1_js = format!(
        "globalThis.__session.c1Check({{gtkVisibleText: {}, gtkDescriptorJson: {}}})",
        serde_json::to_string(&gtk_text).unwrap(),
        serde_json::to_string(&gtk_descriptor.to_string()).unwrap()
    );
    let c1 = pump_and_eval_json(runtime, actor, host, &c1_js, "c1Check");
    assert_exact_keys(&c1, &["tokensChecked", "sinksChecked", "leaks"], "c1Check");
    for key in ["tokensChecked", "sinksChecked", "leaks"] {
        assert_nonnegative_integer(&c1[key], &format!("c1Check.{key}"));
    }
    assert!(
        c1["tokensChecked"].as_u64().unwrap() >= flavor.minimum_c1_tokens,
        "C1 ({}) must check at least {} live token(s): {c1}",
        flavor.name,
        flavor.minimum_c1_tokens
    );
    assert_eq!(
        c1["leaks"],
        json!(0),
        "C1: tokens must be absent from durable intent, parameters, renderer payloads, and GTK text"
    );

    let teardown = run_json_while_pumping(
        runtime,
        actor,
        host,
        "globalThis.__session.teardown()",
        "teardown",
    );
    assert_exact_keys(&teardown, &["destroyed"], "teardown");
    assert_eq!(teardown, json!({"destroyed": true}));
}
