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
        let mut adapter = LinuxRendererAdapter::new(Box::new(move |fut| runtime.block_on(fut)));
        let mut host = BridgeHost::spawn(WORKER).expect("spawn acceptance worker");
        // 64j PREFLIGHT (non-vacuous acceptance): the worker hard-fails (emits
        // {event:'preflight-error', reason} + exits non-zero) when the sibling
        // lagrange-images runtime is missing or unimportable. This gate must
        // NEVER treat an import failure as an acceptable skip — wait for the
        // preflight handshake and fail FAST with the named reason (not an opaque
        // 'open timed out').
        let start = std::time::Instant::now();
        let mut ready = false;
        let mut preflight_error: Option<String> = None;
        while !ready && preflight_error.is_none() {
            host.pump(&mut adapter);
            // Drain events ONCE per cycle, classifying each (do NOT double-drain:
            // take_event_payload would consume and drop the 'ready' event).
            for evt in host.drain_events() {
                match evt.get("event").and_then(|e| e.as_str()) {
                    Some("ready") => ready = true,
                    Some("preflight-error") => {
                        preflight_error = Some(
                            evt.get("reason").and_then(|r| r.as_str()).unwrap_or("unknown preflight failure").to_string(),
                        );
                    }
                    _ => {}
                }
            }
            if let Some(code) = host.poll_exit() {
                panic!("64j PREFLIGHT FAILURE: the acceptance worker exited (code {code}) before signalling ready — the sibling lagrange-images runtime is unavailable; this is an acceptance FAILURE, never a skip");
            }
            if start.elapsed() > Duration::from_secs(30) {
                panic!("64j PREFLIGHT FAILURE: no ready/preflight-error within 30s (the worker hung before opening the session)");
            }
            if !ready && preflight_error.is_none() {
                std::thread::sleep(Duration::from_millis(2));
            }
        }
        if let Some(reason) = preflight_error {
            panic!("64j PREFLIGHT FAILURE (the sibling lagrange-images runtime is unavailable; this is an acceptance FAILURE, never a skip): {reason}");
        }
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

    /// Pump + poll the worker's tokenState until the shell's held token is FRESH
    /// (== the image's current version token), or fail after a deadline. The
    /// deferred reread that re-pairs the token is fire-and-forget on the shell's
    /// serialized lane, so it lands a few pump cycles after the mutation commits;
    /// a single tokenState call would race it. This polls until the drain lands.
    fn wait_token_fresh(&mut self, timeout: Duration) -> Value {
        let start = std::time::Instant::now();
        loop {
            let ts = self.call("tokenState", json!({})).expect("tokenState");
            if ts.get("tokenIsFresh").and_then(|b| b.as_bool()) == Some(true) {
                return ts;
            }
            if start.elapsed() > timeout {
                panic!("the shell's held token did not become fresh within {timeout:?} (the deferred reread did not re-pair it); last tokenState: {ts}");
            }
            std::thread::sleep(Duration::from_millis(5));
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
    // Start the observation->reread lane AFTER navigation has paired the token
    // (the integration test's sequencing), so the busy-poll follow churn does
    // not race the navigation's own reread. From here follow stays ACTIVE
    // across the edit (the strong 64j acceptance the olm barrier enables).
    h.call("follow", json!({})).expect("start follow");
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
    let ts2 = h.wait_token_fresh(Duration::from_secs(10));
    assert_eq!(ts2.get("tokenIsFresh").and_then(|b| b.as_bool()), Some(true),
        "the observation reread refreshed the transient token to the current version");

    // --- FLOW 3 (edit, follow ACTIVE): GTK edit -> handleEditField -> mutation
    // -> ACTIVE observation sees the committed change -> deferred reread -> GTK.
    // This is the STRONG acceptance chain (the whole point of 64j): follow stays
    // ACTIVE across the edit. The olm barrier (env-shell.js editInFlight) DEFERS
    // the follow's self-observation reread until the edit settles, then drains it
    // as the follow's reread — so a FRESH token does NOT conflict, and the
    // inspector updates via mutation -> observation invalidation -> reread (NOT a
    // post-edit direct-reread shortcut). Drive the GTK editable field (key 0 =
    // probe-title) with a new value + Enter; relay the emitted edit-field intent.
    let edit_intent = h.adapter.edit_gtk_field(&insp_handle, 0, "edited-natively").expect("edit seam").expect("an edit intent");
    assert_eq!(edit_intent, Intent::edit_field(0, "edited-natively".to_string()));
    h.host.emit_intent(&insp_handle, &edit_intent).expect("relay edit intent");
    // The deferred reread presentOn -> the GTK inspector shows the committed value
    // (NOT merely the typed text still sitting in the entry). This is the strong
    // signal: it distinguishes a real commit+reread from a non-commit. First let
    // the edit settle (the mutation commits, the olm barrier defers then drains
    // the self-observation reread).
    h.wait_gtk_text(&insp_handle, "edited-natively", Duration::from_secs(10));
    // The IMAGE state (read via the worker's readObject) confirms the mutation.
    let title = h.call("title", json!({})).expect("read title");
    assert_eq!(title.get("title").and_then(|s| s.as_str()), Some("edited-natively"));
    // The deferred reread re-paired the transient token to the post-edit version
    // (proves the race is GONE — the barrier did not leave the token stale). Poll
    // until the fire-and-forget drain lands.
    let ts3 = h.wait_token_fresh(Duration::from_secs(10));
    assert_eq!(ts3.get("tokenIsFresh").and_then(|b| b.as_bool()), Some(true),
        "the deferred reread re-paired the token to the post-edit version (the olm race is fixed)");

    // --- FLOW 4 (stale-token conflict/recovery, follow ACTIVE) ----------------
    // Optimistic concurrency is preserved (the olm barrier is NOT last-writer-
    // wins): a genuinely external write must STILL conflict. staleConflictEdit
    // advances the version EXTERNALLY then drives handleEditField without yielding
    // to the follow loop, so the shell captures the pre-external (stale) token ->
    // CommandConflictError. The recovery reread shows the CURRENT value.
    let conflict = h.call("staleConflictEdit", json!({"externalTitle": "external-advance", "key": 0, "text": "stale-edit"}))
        .expect("stale conflict edit");
    assert_eq!(
        conflict.get("error").and_then(|e| e.get("name")).and_then(|n| n.as_str()),
        Some("CommandConflictError"),
        "a genuinely external write STILL conflicts (optimistic concurrency preserved, NOT last-writer-wins): {conflict}"
    );
    assert_eq!(
        conflict.get("rereadValue").and_then(|s| s.as_str()),
        Some("external-advance"),
        "the conflict recovery reread shows the CURRENT value, not the stale edit: {conflict}"
    );
    // The recovery reread's presentOn flows over the bridge -> the GTK inspector
    // shows the current value (no dead-end; the user can continue).
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

    // --- C1 FALSIFIER (the versionToken NEVER crosses the bridge) --------------
    // After the FULL flow (open -> navigate -> observe -> live-follow edit ->
    // conflict -> denied), assert the versionToken appears in NO sink that could
    // cross the bridge: the Compositor's durableIntent, every
    // presentationDescriptor's parameters, AND the GTK-visible text the host read.
    // The token itself NEVER crosses (the worker computes the check and returns
    // only booleans). leaks MUST be 0; tokensChecked>0 proves real tokens checked.
    let c1 = h.call("c1Check", json!({"gtkVisibleText": final_text})).expect("c1 check");
    assert!(c1.get("tokensChecked").and_then(|n| n.as_u64()).unwrap_or(0) > 0,
        "the C1 check actually inspected real tokens (not vacuous): {c1}");
    assert_eq!(c1.get("leaks").and_then(|n| n.as_u64()), Some(0),
        "the versionToken leaked into a bridge/GTK/serialized sink (durableIntent / presentationDescriptor / GTK text): {c1}");

    // --- teardown --------------------------------------------------------------
    h.call("close", json!({})).expect("close");
}
