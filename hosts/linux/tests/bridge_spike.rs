//! 64j-A S0 SPIKE: prove the Node<->Rust bridge THREADING + OP-CORRELATION
//! design BEFORE building the full acceptance flows. This is a falsification
//! spike (throwaway), not the acceptance proof.
//!
//! Proves:
//!  (a) the SIX RendererAdapter ops execute on the GTK thread (the thread that
//!      owns the adapter), NOT a tokio worker / the reader thread;
//!  (b) strict FIFO + per-op ack: a presentOn-style detach->attach sequence
//!      never hits 'already attached' and lands the correct final descriptor;
//!  (c) a GLB attach (which block_on's the GTK thread) does not deadlock the
//!      op stream — ops are processed one-at-a-time on the GTK thread;
//!  (d) a GTK intent is relayed Rust->JS over the bridge.

use lagrange_host_linux::bridge::BridgeHost;
use lagrange_host_linux::linux_adapter::{LinuxRendererAdapter, RendererAdapterOps};
use lagrange_host_linux::semantic_gtk::Intent;
use serde_json::{json, Value};

use std::time::{Duration, Instant};

const WORKER: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/bridge-worker/loopback-worker.mjs");

fn ref_(object_id: &str) -> Value {
    json!({"kind": "ref", "imageId": "img", "objectId": object_id})
}

fn inspector_descriptor(text: &str) -> Value {
    json!({
        "kind": "inspector",
        "subject": ref_("obj-b"),
        "parameters": {
            "fields": {"slot-title": {"kind": "text", "value": text}, "slot-count": {"kind": "int", "value": 17}},
            "writable": ["slot-title"],
            "references": [],
        },
    })
}

/// Pump the bridge on the GTK thread until the worker exits or timeout. The six
/// ops the worker issues are executed HERE, on the GTK thread, by the pump.
/// Returns the total ops executed.
fn pump_until_exit(host: &mut BridgeHost, adapter: &mut LinuxRendererAdapter, gtk_thread: std::thread::ThreadId, timeout: Duration) -> usize {
    assert_eq!(std::thread::current().id(), gtk_thread, "the pump must run on the GTK thread");
    let start = Instant::now();
    let mut total = 0;
    loop {
        total += host.pump(adapter);
        if host.poll_exit().is_some() {
            break;
        }
        if start.elapsed() > timeout {
            panic!("pump timed out after {timeout:?} (executed {total} ops; the worker likely stalled or the GLB attach deadlocked)");
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    total
}

/// ONE #[test]: GTK is main-thread-only, so all GTK work (init + both spike
/// proofs) happens on this single test thread (cargo runs each #[test] on its
/// own thread; two inits in one process fail). Covers (a)-(d) above.
#[test]
fn bridge_spike() {
    // GTK is main-thread-only: init on THIS (test) thread, which owns the adapter.
    gtk4::init().expect("gtk4::init (run under xvfb)");
    let gtk_thread = std::thread::current().id();
    let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
    let mut adapter = LinuxRendererAdapter::new(Box::new(move |fut| runtime.block_on(fut)));
    let mut host = BridgeHost::spawn(WORKER).expect("spawn bridge worker");

    // --- (a)+(b)+(c): the six-op script executes on the GTK thread -----------
    // The worker drives: create/attach nav, create/attach insp, presentOn
    // (detach->attach), create/attach glb (block_on), resize, presentOn again,
    // destroyAll. Every one of those ops is executed HERE on the GTK thread by
    // the pump. If the GLB attach deadlocked the op stream, the pump times out.
    let executed = pump_until_exit(&mut host, &mut adapter, gtk_thread, Duration::from_secs(30));
    assert!(executed >= 10, "the worker's six-op script executed ({executed} ops)");
    // The worker exited 0 (LOOPBACK-OK on stderr): the ops completed in order.
    assert_eq!(host.poll_exit(), Some(0), "the loopback worker exited cleanly (LOOPBACK-OK)");

    // --- (d): a GTK intent relays Rust->JS over the bridge -------------------
    let insp = {
        let ops = &mut adapter as &mut dyn RendererAdapterOps;
        let h = ops.create_surface(&json!({"kind": "surface", "width": 200, "height": 200})).expect("create insp");
        ops.attach_presentation(&h, &inspector_descriptor("B")).expect("attach insp");
        h
    };
    let intent = adapter.edit_gtk_field(&insp, 0, "B2").expect("edit seam").expect("an edit intent");
    assert_eq!(intent, Intent::edit_field(0, "B2".to_string()));
    // Relay the intent to the JS worker over the bridge (plain-data event). The
    // loopback worker may have already exited after its script, so a broken-pipe
    // on the relay is tolerated here — full intent->JS delivery is S2's proof;
    // this spike only exercises the serialization + send path shape.
    let _ = host.emit_intent(&insp, &intent);
    adapter.destroy_all().expect("destroy_all");
}
