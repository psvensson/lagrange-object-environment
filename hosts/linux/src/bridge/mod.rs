//! THROWAWAY 64j-A bridge host (Rust side). NOT a public API. NOT the Linux
//! client architecture. This is the smallest credible embedding that lets the
//! UNMODIFIED JavaScript environment core (running in a Node child process)
//! drive the REAL [`LinuxRendererAdapter`], to falsify the SEMANTIC
//! host-portability claim (ADR 0013). It does NOT prove option A's in-process
//! implementation — a Node subprocess is a PEER process, not an embedded
//! runtime (that is Bead 3zb). When 3zb lands an in-process JS runtime, this
//! whole module is DELETED.
//!
//! FENCES (user-mandated):
//! - Only plain-data newline-JSON crosses the bridge (the child's stdin/stdout).
//! - NO semantic logic here: no key->ref / key->slot / command / authority /
//!   version-token / observation semantics. The bridge is a dumb transport that
//!   forwards the SIX RendererAdapter ops to the adapter and relays GTK intents.
//! - The six ops are EXACTLY the `RendererAdapterOps` trait — no 7th op.
//! - No durable state or identity originates here (handles are minted by the
//!   adapter, tokens never cross — they live only in the JS core).
//!
//! PROTOCOL (op-correlated, strict FIFO, single-in-flight):
//!   JS -> Rust: {"id": N, "op": "<one of the six>", "args": [data]}
//!   Rust -> JS: {"id": N, "ok": result} | {"id": N, "err": "..."}
//!   Rust -> JS: {"event": "intent", "surfaceHandle": h, "intent": {...}}
//!   Rust -> JS (host request): {"cmd": "...", "reqId": M, "args": data}
//!   JS -> Rust (host response): {"reqId": M, "ok": result} | {"reqId": M, "err": "..."}
//! The host-request leg is how the GTK-side test drives/asserts against the
//! worker's JS-core state (open/follow/title/tokenState/externalMutate/...). It
//! carries only PLAIN DATA (booleans about token state, never a token; object
//! ids; field values) — the worker computes it, never the bridge.
//!
//! THREAD MODEL (the F1 design): the SIX OPS RUN ON THE GTK THREAD, NEVER on a
//! tokio worker or the reader thread. A bridge READER thread does blocking
//! line-reads on the child's stdout and enqueues each op onto a channel; the
//! GTK thread drains that channel in [`BridgeHost::pump`], executes the sync op
//! against the adapter (which it owns), and replies through a per-op oneshot so
//! the reader thread can write the ack to the child's stdin. Because the JS
//! Compositor awaits each op before issuing the next (and the JS bridge adapter
//! never pipelines), ops arrive strictly one-at-a-time, so a presentOn's
//! detach->attach ordering is preserved. A GLB attach `block_on`s the GTK thread
//! (the adapter's existing `glb_runner`), so the reader thread simply waits —
//! it never touches GTK.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::linux_adapter::{LinuxRendererAdapter, RendererAdapterOps};
use crate::semantic_gtk::Intent;

/// A single op request from the JS core, plus the oneshot the GTK thread uses
/// to return the result to the reader thread.
struct OpRequest {
    id: u64,
    op: String,
    args: Vec<Value>,
    respond: Sender<Value>,
}

/// The Rust end of the bridge. Owns the Node child + the reader thread. The GTK
/// thread owns the adapter and calls [`BridgeHost::pump`] to execute ops.
pub struct BridgeHost {
    child: Child,
    // The child's stdin is written by BOTH the reader thread (op acks) and the
    // host thread (intent events); a Mutex serializes writes so messages never
    // interleave (newline-JSON framing depends on it).
    child_stdin: Arc<Mutex<ChildStdin>>,
    op_rx: Receiver<OpRequest>,
    resp_rx: Receiver<Value>,
    event_rx: Receiver<Value>,
    next_req_id: u64,
}

impl BridgeHost {
    /// Spawn the Node bridge worker and start the reader thread. `worker_path`
    /// is the .mjs worker script (see hosts/linux/tests/bridge-worker/).
    pub fn spawn(worker_path: &str) -> Result<Self, String> {
        let mut child = Command::new("node")
            .arg(worker_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit()) // surface worker errors in the test log
            .spawn()
            .map_err(|e| format!("bridge: failed to spawn node worker {worker_path}: {e}"))?;
        let child_stdin = child.stdin.take().ok_or("bridge: no child stdin")?;
        let child_stdout = child.stdout.take().ok_or("bridge: no child stdout")?;

        let (op_tx, op_rx) = channel::<OpRequest>();
        let (resp_tx, resp_rx) = channel::<Value>(); // worker {reqId,ok|err} -> host
        let (event_tx, event_rx) = channel::<Value>(); // worker {event:...} -> host
        let child_stdin = Arc::new(Mutex::new(child_stdin));
        let ack_stdin = Arc::clone(&child_stdin);

        // The reader thread: blocking line-reads on the child's stdout, parsing
        // plain-data messages. An op request goes to the GTK thread (op_tx); the
        // reader BLOCKS on the per-op oneshot for the GTK thread's result, then
        // WRITES the ack to the child's stdin (serialized via the Mutex). This
        // keeps result delivery simple: the GTK thread executes + hands the ack
        // back; the reader writes it. The GTK thread never blocks on the child.
        std::thread::spawn(move || {
            let mut reader = BufReader::new(child_stdout);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => break, // EOF: the worker exited
                    Ok(_) => {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        let msg: Value = match serde_json::from_str(trimmed) {
                            Ok(m) => m,
                            Err(_) => continue, // not ours / malformed; plain-data only
                        };
                        // An op request from the JS core: {id, op, args}.
                        if let (Some(id), Some(op)) = (msg.get("id"), msg.get("op")) {
                            let (respond, wait) = channel::<Value>();
                            if op_tx
                                .send(OpRequest {
                                    id: id.as_u64().unwrap_or(0),
                                    op: op.as_str().unwrap_or("").to_string(),
                                    args: msg.get("args").and_then(|a| a.as_array()).cloned().unwrap_or_default(),
                                    respond,
                                })
                                .is_err()
                            {
                                break; // GTK thread gone
                            }
                            // Block until the GTK thread executes the op and replies.
                            if let Ok(ack) = wait.recv() {
                                if let Ok(line) = serde_json::to_string(&ack) {
                                    if let Ok(mut stdin) = ack_stdin.lock() {
                                        let _ = stdin.write_all(line.as_bytes());
                                        let _ = stdin.write_all(b"\n");
                                        let _ = stdin.flush();
                                    }
                                }
                            }
                        } else if msg.get("reqId").is_some() {
                            // A response to a host request: {reqId, ok|err}.
                            let _ = resp_tx.send(msg);
                        } else if msg.get("event").is_some() {
                            // A worker event (e.g. {event:'ready'}).
                            let _ = event_tx.send(msg);
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        Ok(Self { child, child_stdin, op_rx, resp_rx, event_rx, next_req_id: 0 })
    }

    /// Execute all pending ops on the GTK thread against the adapter. Called by
    /// the GTK thread in a loop (between GTK iterations). Returns the number of
    /// ops executed. This is where the SIX OPS RUN — on the GTK thread.
    pub fn pump(&self, adapter: &mut LinuxRendererAdapter) -> usize {
        let mut executed = 0;
        while let Ok(req) = self.op_rx.try_recv() {
            let result = self.execute(adapter, &req.op, &req.args);
            let ack = match result {
                Ok(value) => json!({"id": req.id, "ok": value}),
                Err(err) => json!({"id": req.id, "err": err}),
            };
            let _ = req.respond.send(ack);
            executed += 1;
        }
        executed
    }

    /// Execute ONE op against the adapter (the six-op contract, nothing else).
    fn execute(&self, adapter: &mut LinuxRendererAdapter, op: &str, args: &[Value]) -> Result<Value, String> {
        match op {
            "createSurface" => {
                let view_descriptor = args.first().cloned().unwrap_or(Value::Null);
                adapter.create_surface(&view_descriptor).map(Value::String)
            }
            "attachPresentation" => {
                let handle = args.first().and_then(|h| h.as_str()).ok_or("attachPresentation: handle must be a string")?;
                let descriptor = args.get(1).cloned().unwrap_or(Value::Null);
                adapter.attach_presentation(handle, &descriptor).map(|_| Value::Null)
            }
            "detachPresentation" => {
                let handle = args.first().and_then(|h| h.as_str()).ok_or("detachPresentation: handle must be a string")?;
                adapter.detach_presentation(handle).map(|_| Value::Null)
            }
            "resize" => {
                let handle = args.first().and_then(|h| h.as_str()).ok_or("resize: handle must be a string")?;
                let width = args.get(1).and_then(|w| w.as_u64()).ok_or("resize: width must be a uint")? as u32;
                let height = args.get(2).and_then(|h| h.as_u64()).ok_or("resize: height must be a uint")? as u32;
                adapter.resize(handle, width, height).map(|_| Value::Null)
            }
            "destroySurface" => {
                let handle = args.first().and_then(|h| h.as_str()).ok_or("destroySurface: handle must be a string")?;
                adapter.destroy_surface(handle).map(|_| Value::Null)
            }
            "destroyAll" => adapter.destroy_all().map(|_| Value::Null),
            other => Err(format!("bridge: unknown op {other:?} (the six-op contract is exactly six)")),
        }
    }

    /// Send a message to the JS worker (e.g. a GTK intent event). Plain-data.
    pub fn send(&mut self, msg: &Value) -> Result<(), String> {
        let line = serde_json::to_string(msg).map_err(|e| format!("bridge: serialize: {e}"))?;
        let mut stdin = self.child_stdin.lock().map_err(|e| format!("bridge: stdin lock: {e}"))?;
        stdin
            .write_all(line.as_bytes())
            .and_then(|_| stdin.write_all(b"\n"))
            .and_then(|_| stdin.flush())
            .map_err(|e| format!("bridge: write to worker: {e}"))
    }

    /// Issue a host request to the worker and wait (via pump cycles driven by
    /// the caller) for the matching response. The caller drives the GTK pump
    /// between polls; this just sends + registers the reqId. Pair with
    /// [`BridgeHost::take_response`].
    pub fn call(&mut self, cmd: &str, args: Value) -> Result<u64, String> {
        let req_id = self.next_req_id;
        self.next_req_id += 1;
        let msg = json!({"cmd": cmd, "reqId": req_id, "args": args});
        self.send(&msg)?;
        Ok(req_id)
    }

    /// Take a worker response for `req_id` if one has arrived (non-blocking).
    /// Returns Some(result-or-err) once. Single-in-flight only (the acceptance
    /// flow issues one request at a time): any response for a DIFFERENT reqId is
    /// a protocol error and is surfaced as such rather than silently dropped.
    pub fn take_response(&self, req_id: u64) -> Option<Result<Value, String>> {
        match self.resp_rx.try_recv() {
            Err(_) => None, // empty (or disconnected — treated as no-response-yet here)
            Ok(msg) => {
                let id = msg.get("reqId").and_then(|r| r.as_u64());
                if id != Some(req_id) {
                    return Some(Err(format!(
                        "bridge: response for reqId {id:?} while awaiting {req_id} (the bridge is single-in-flight)"
                    )));
                }
                if let Some(err) = msg.get("err") {
                    Some(Err(err.as_str().unwrap_or("worker error").to_string()))
                } else {
                    Some(Ok(msg.get("ok").cloned().unwrap_or(Value::Null)))
                }
            }
        }
    }

    /// Wait for the worker's {event:'ready'} (non-blocking poll + pump by caller).
    pub fn take_event(&self, name: &str) -> bool {
        let mut seen = false;
        while let Ok(msg) = self.event_rx.try_recv() {
            if msg.get("event").and_then(|e| e.as_str()) == Some(name) {
                seen = true;
            }
        }
        seen
    }

    /// Drain ALL pending worker events (non-blocking), returning them so the
    /// caller can classify each (e.g. 'ready' vs 'preflight-error') without
    /// losing any. Used by the acceptance preflight handshake.
    pub fn drain_events(&self) -> Vec<Value> {
        let mut out = Vec::new();
        while let Ok(msg) = self.event_rx.try_recv() {
            out.push(msg);
        }
        out
    }

    /// Relay a GTK intent to the JS core as an event. Called by the host test
    /// after driving a GTK control (activate_gtk_action / edit_gtk_field).
    pub fn emit_intent(&mut self, surface_handle: &str, intent: &Intent) -> Result<(), String> {
        let msg = json!({
            "event": "intent",
            "surfaceHandle": surface_handle,
            "intent": serde_json::to_value(intent).map_err(|e| format!("bridge: intent: {e}"))?,
        });
        self.send(&msg)
    }

    /// Non-blocking exit-status check (the worker's process exit code, if it
    /// has exited). Mutates to call try_wait.
    pub fn poll_exit(&mut self) -> Option<i32> {
        match self.child.try_wait() {
            Ok(Some(status)) => status.code(),
            _ => None,
        }
    }

    /// Shut down the worker + join. Best-effort.
    pub fn shutdown(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for BridgeHost {
    fn drop(&mut self) {
        self.shutdown();
    }
}
