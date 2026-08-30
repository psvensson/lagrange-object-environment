//! 64j-A ACCEPTANCE PROOF (throwaway spike; deleted when 3zb embeds in-process):
//! the REAL, UNMODIFIED JavaScript environment core (in a Node child) drives the
//! REAL LinuxRendererAdapter to prove ONE live loop against a REAL Image:
//!
//!   GTK navigator action -> intent -> REAL JS EnvironmentShell -> REAL
//!   ObjectNavigator authorized read -> REAL JS Compositor presentOn ->
//!   LinuxRendererAdapter -> GTK inspector changes
//!
//! and:
//!
//!   GTK edit + Enter -> edit-field intent -> REAL handleEditField (key->slot +
//!   transient token) -> CommandRouter -> registry -> fresh authority ->
//!   dispatcher -> ImageClientAdapter -> REAL mutation -> observation -> fresh
//!   authorized reread -> REAL Compositor presentOn -> GTK shows the new value.
//!
//! Plus a stale-token conflict/recovery arm and a denied-write arm. The bridge
//! carries ONLY plain-data (six ops JS->Rust; intents + handle + status
//! Rust->JS). NO semantic logic is in Rust; versionToken NEVER crosses.
//!
//! ONE #[test] (GTK is main-thread-only; the pump drives the six ops here).

use lagrange_host_linux::bridge::BridgeHost;
use lagrange_host_linux::linux_adapter::LinuxRendererAdapter;
use lagrange_host_linux::semantic_gtk::Intent;
use serde_json::{json, Value};

use std::time::Duration;

const WORKER: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/bridge-worker/acceptance-worker.mjs");

struct Harness {
    host: BridgeHost,
    adapter: LinuxRendererAdapter,
}

impl Harness {
    fn new() -> Self {
        gtk4::init().expect("gtk4::init (run under xvfb)");
        let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
        let adapter = LinuxRendererAdapter::new(Box::new(move |fut| runtime.block_on(fut)));
        let host = BridgeHost::spawn(WORKER).expect("spawn acceptance worker");
        Self { host, adapter }
    }

    fn pump_once(&mut self) {
        self.host.pump(&mut self.adapter);
    }

    /// A host request to the worker, driving the GTK pump until the response.
    fn call(&mut self, cmd: &str, args: Value) -> Result<Value, String> {
        // Drive the GTK pump between polls so the worker's ops keep flowing while
        // we await its response (both legs share this GTK thread).
        let req_id = self.host.call(cmd, args)?;
        let start = std::time::Instant::now();
        loop {
            self.host.pump(&mut self.adapter);
            if let Some(result) = self.host.take_response(req_id) {
                return result;
            }
            if start.elapsed() > Duration::from_secs(30) {
                return Err(format!("call {cmd:?} timed out"));
            }
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    /// Pump until the GTK pane's visible text contains a node matching `want`,
    /// or fail after a deadline. `want` matched as a substring (e.g. the
    /// "Inspector: <id>" heading) or exactly (e.g. a field value).
    fn wait_gtk_text(&mut self, handle: &str, want: &str, timeout: Duration) -> Vec<String> {
        let start = std::time::Instant::now();
        loop {
            self.pump_once();
            let text = self.adapter.gtk_visible_text(handle).unwrap_or_default();
            if text.iter().any(|t| t == want || t.contains(want)) {
                return text;
            }
            if start.elapsed() > timeout {
                panic!("GTK pane did not show {want:?} within {timeout:?}; visible: {text:?}");
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

#[test]
fn native_js_core_loop() {
    let mut h = Harness::new();

    // --- open: the worker builds the real graph + opens the workspace ---------
    // The Compositor drives createSurface+attachPresentation over the bridge to
    // the REAL Rust adapter; navigator + inspector GTK panes appear natively.
    let open = h.call("open", json!({})).expect("open session");
    let nav_handle = open.get("navigatorSurfaceHandle").and_then(|s| s.as_str()).expect("nav handle").to_string();
    let insp_handle = open.get("inspectorSurfaceHandle").and_then(|s| s.as_str()).expect("insp handle").to_string();
    let created_id = open.get("createdObjectId").and_then(|s| s.as_str()).expect("created id").to_string();
    let root_id = open.get("rootObjectId").and_then(|s| s.as_str()).expect("root id").to_string();
    // The GTK navigator pane is REAL (heading + the reference to B).
    let nav_text = h.wait_gtk_text(&nav_handle, "Navigator: ", Duration::from_secs(5));
    assert!(nav_text.iter().any(|t| t.contains(&root_id)), "navigator shows the root: {nav_text:?}");

    // --- FLOW 1 (navigation): GTK action -> JS shell -> reread -> GTK ---------
    // Start the observation->reread lane so the inspector updates are real.
    h.call("follow", json!({})).expect("start follow");
    // The GTK emission is the intent SOURCE (anti-shortcut): activate the
    // navigator's action for B (key 0) on the REAL GTK realization, get the
    // exact intent it emitted, and relay THAT to the JS shell.
    let nav_intent = h.adapter.activate_gtk_action(&nav_handle, 0).expect("activate nav").expect("a nav intent");
    assert_eq!(nav_intent, Intent::activate_item(0));
    h.host.emit_intent(&nav_handle, &nav_intent).expect("relay nav intent to the JS shell");
    // The shell resolves key->ref, selects B, re-reads it, and presentOn the
    // inspector over the bridge -> the GTK inspector shows B's identity. The
    // exact heading is "Inspector: <B-id>" (contains-match would false-positive
    // on the root id, so assert the EXACT node).
    let want_heading = format!("Inspector: {created_id}");
    let mut found = false;
    let start = std::time::Instant::now();
    while start.elapsed() < Duration::from_secs(10) {
        h.pump_once();
        let text = h.adapter.gtk_visible_text(&insp_handle).unwrap_or_default();
        if text.iter().any(|t| t == &want_heading) {
            found = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(found, "GTK inspector did not select B (heading {want_heading:?})");
    // The inspector's editable title field shows the original value.
    let insp_text = h.adapter.gtk_visible_text(&insp_handle).expect("insp text");
    assert!(insp_text.iter().any(|t| t == "original"), "inspector shows B's title: {insp_text:?}");
    // The shell's transient token is now paired with B (proved via a boolean,
    // NEVER the token itself crossing the bridge).
    let token_state = h.call("tokenState", json!({})).expect("tokenState");
    assert_eq!(token_state.get("objectId").and_then(|s| s.as_str()), Some(created_id.as_str()));
    assert_eq!(token_state.get("hasToken").and_then(|b| b.as_bool()), Some(true));
    assert_eq!(token_state.get("tokenIsFresh").and_then(|b| b.as_bool()), Some(true),
        "the shell's held token must be fresh after navigation (no observation reread should have landed yet)");

    // --- FLOW 2 (observation-driven reread, follow RUNNING) -------------------
    // While followSelected is active, mutate B EXTERNALLY. The observation lane
    // must fire, the shell must do a FRESH authorized reread (no shadow cache),
    // and presentOn the inspector over the bridge -> the GTK inspector shows the
    // externally-written value. This is the observation leg of the loop.
    h.call("externalMutate", json!({"title": "observed-externally"})).expect("external mutate");
    h.wait_gtk_text(&insp_handle, "observed-externally", Duration::from_secs(10));
    let obs_title = h.call("title", json!({})).expect("title after observation");
    assert_eq!(obs_title.get("title").and_then(|s| s.as_str()), Some("observed-externally"),
        "the observation reread reflects the image's current value (not a shadow cache)");
    // The reread also re-paired the shell's transient token to the current version.
    let ts2 = h.call("tokenState", json!({})).expect("tokenState after observation");
    assert_eq!(ts2.get("tokenIsFresh").and_then(|b| b.as_bool()), Some(true),
        "the observation reread refreshed the transient token to the current version");

    // --- FLOW 3 (edit): GTK edit -> handleEditField -> mutation -> reread -----
    // The edit-during-active-follow race (Bead olm, P1, BLOCKS 64j) means a
    // fresh-token edit CONFLICTS if follow keeps running: the follow reread
    // re-pairs the token over the edit's own committed write. Until olm's
    // editInFlight guard lands in env-shell.js, the acceptance flow stops follow
    // before editing — EXACTLY the sequencing the integration test proves
    // (test/environment-shell.integration.test.js:157 follow.stop() then the S4a
    // edit). This is the proven-behavior sequence, not a workaround for the
    // bridge: the bridge is faithful; the race is a host-neutral core bug.
    h.call("unfollow", json!({})).expect("unfollow before edit");
    // Drive the GTK editable field (key 0 = probe-title) with a new value + Enter;
    // relay the emitted edit-field intent to the JS shell.
    let edit_intent = h.adapter.edit_gtk_field(&insp_handle, 0, "edited-natively").expect("edit seam").expect("an edit intent");
    assert_eq!(edit_intent, Intent::edit_field(0, "edited-natively".to_string()));
    h.host.emit_intent(&insp_handle, &edit_intent).expect("relay edit intent");
    // The shell routes through CommandRouter -> real mutation. The GTK inspector
    // shows the NEW value (via handleEditField's success path / presentOn).
    h.wait_gtk_text(&insp_handle, "edited-natively", Duration::from_secs(10));
    // The IMAGE state (read via the worker's readObject) confirms the mutation.
    let title = h.call("title", json!({})).expect("read title");
    assert_eq!(title.get("title").and_then(|s| s.as_str()), Some("edited-natively"));

    // --- FLOW 4 (stale-token conflict/recovery, follow stopped) ---------------
    // Advance the version EXTERNALLY so the shell's held token goes stale, then
    // drive another GTK edit: it must conflict, recover via reread, and NOT
    // clobber the external write. (Follow is stopped, so the ONLY version bump
    // is this explicit external write — no observation race.)
    h.call("externalMutate", json!({"title": "external-advance"})).expect("external mutate");
    let stale_intent = h.adapter.edit_gtk_field(&insp_handle, 0, "stale-edit").expect("stale seam").expect("stale intent");
    h.host.emit_intent(&insp_handle, &stale_intent).expect("relay stale edit");
    // The stale edit conflicts; the recovery reread shows the CURRENT value
    // (external-advance), NOT the stale edit. The user can then continue.
    h.wait_gtk_text(&insp_handle, "external-advance", Duration::from_secs(10));
    let after_conflict = h.call("title", json!({})).expect("title after conflict");
    assert_eq!(after_conflict.get("title").and_then(|s| s.as_str()), Some("external-advance"),
        "the stale edit did NOT clobber the external write");

    // --- FLOW 4 (denied write): distinct, no mutation, no dead-end ------------
    let denied = h.call("editDenied", json!({"key": 0, "text": "denied-edit"})).expect("denied edit");
    assert_eq!(
        denied.get("error").and_then(|e| e.get("name")).and_then(|n| n.as_str()),
        Some("CommandAuthorizationError"),
        "a denied WRITE -> CommandAuthorizationError (distinct from an unauthorized read)"
    );
    let after_denied = h.call("title", json!({})).expect("title after denied");
    assert_eq!(after_denied.get("title").and_then(|s| s.as_str()), Some("external-advance"),
        "a denied write mutated nothing");
    // The inspector is still usable (shows the current value; no dead-end).
    let final_text = h.adapter.gtk_visible_text(&insp_handle).expect("final insp text");
    assert!(final_text.iter().any(|t| t == "external-advance"), "the inspector still shows the current value (no dead-end): {final_text:?}");

    // --- teardown --------------------------------------------------------------
    h.call("close", json!({})).expect("close");
}
