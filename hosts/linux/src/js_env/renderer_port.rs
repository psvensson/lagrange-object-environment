//! 3zb-A slice 3A: the Renderer port.
//!
//! Connects the embedded JS Environment core to the REAL `LinuxRendererAdapter`
//! across the reviewed ownership/threading boundary:
//!
//!   JS-owner thread (QuickJS)
//!     -> renderer-op request on its OWN channel (NOT `OwnerCommand`)
//!     -> GTK-owning thread
//!     -> exactly one of the six `RendererAdapterOps`
//!     -> `oneshot` response
//!     -> JS owner resumes the continuation.
//!
//! # Why a dedicated channel (not `OwnerCommand`)
//!
//! The slice-2 re-entrancy invariant: a host-callable runs its Rust closure
//! WHILE `drive()` holds the runtime lock, so it MUST resolve via a cross-thread
//! `oneshot` waker and MUST NEVER `send`+`await` an `OwnerCommand` from within
//! that lock (single-thread self-deadlock). A renderer op is a host-callable, so
//! it uses its OWN request channel + a `oneshot` per op. The GTK thread never
//! touches QuickJS; the `oneshot` is the only crossing back.
//!
//! # Sync-vs-async semantics
//!
//! A renderer op is SYNCHRONOUS from the guest's perspective in the sense that
//! the JS `Compositor` `await`s each op before starting the next (sequenced).
//! But it is implemented as an `Async` host fn that SUSPENDS the JS Promise
//! while the GTK thread does the work — it does NOT block the JS-owner thread's
//! drive loop, so there is no re-entrancy deadlock. This is the
//! "renderer-call-blocked-waiting-for-GTK-reply" case: the Promise is suspended
//! on the GTK reply, but the JS owner remains a live owner (it is NOT the same
//! as a JS Promise suspended on an async Images capability, which permits other
//! events; the Compositor's own sequencing already prevents a second renderer op
//! mid-op). No JS re-entry happens while the runtime lock is inside a renderer
//! host call — the host call only sends a request and awaits the oneshot.
//!
//! # Plain-data discipline
//!
//! Values cross as `serde_json::Value` (the data-representable boundary the
//! `LinuxRendererAdapter` already enforces via `assert_data_representable`). NO
//! semantic decoding in Rust: the port passes the descriptor JSON through; the
//! adapter owns realization. Handles are opaque transient strings; no key->ref,
//! no authority, no observation semantics in Rust.

use std::sync::mpsc as std_mpsc;

use serde_json::Value;
use tokio::sync::oneshot;

use crate::linux_adapter::{LinuxRendererAdapter, RendererAdapterOps};

/// A single renderer operation request, sent from the JS-owner thread to the
/// GTK-owning thread. Each carries a `oneshot` for the result. This channel is
/// structurally DISTINCT from the JS actor's `OwnerCommand` (the re-entrancy
/// fence).
pub enum RendererOp {
    CreateSurface { view_descriptor: Value, done: oneshot::Sender<Result<String, String>> },
    AttachPresentation { handle: String, presentation_descriptor: Value, done: oneshot::Sender<Result<(), String>> },
    DetachPresentation { handle: String, done: oneshot::Sender<Result<(), String>> },
    Resize { handle: String, width: u32, height: u32, done: oneshot::Sender<Result<(), String>> },
    DestroySurface { handle: String, done: oneshot::Sender<Result<(), String>> },
    DestroyAll { done: oneshot::Sender<Result<(), String>> },
}

/// The sending end the JS-owner side uses to issue renderer ops. Cheap to clone.
#[derive(Clone)]
pub struct RendererPortTx {
    tx: std_mpsc::Sender<RendererOp>,
}

/// The GTK-side host: owns the REAL `LinuxRendererAdapter` on the GTK (main)
/// thread and executes queued renderer ops when `pump()` is called.
///
/// # Why the GTK owner is the CALLING thread, not a spawned thread
///
/// GTK4 permits exactly ONE `gtk4::init()` per process and binds it to the
/// thread that calls it ("main thread" by GTK's accounting; a second init from
/// another thread panics). GTK widgets are not `Send`. So the adapter must be
/// created on, and its ops executed on, the process's designated GTK thread —
/// which in the Linux client is the main thread (the same thread that owns the
/// GTK main loop), and in tests is the `#[test]` thread. The JS-owner actor is
/// the SPAWNED thread. This mirrors the proven `native_js_loop` structure
/// (GTK on the test/main thread, JS on a separate worker).
///
/// The GTK thread drives the port by calling `pump()`: it processes any queued
/// renderer ops (executing them on itself) and iterates the GTK main context so
/// widget realization/intents advance. This is the same pump shape the existing
/// GTK tests use.
pub struct RendererPortHost {
    adapter: LinuxRendererAdapter,
    rx: std_mpsc::Receiver<RendererOp>,
}

impl RendererPortHost {
    /// Create the GTK-side host on the calling (GTK/main) thread. `gtk4::init()`
    /// must already have succeeded on THIS thread. Returns the host plus the
    /// `RendererPortTx` the JS-owner side uses to issue ops.
    pub fn new(glb_runner: crate::linux_adapter::GlbRunner) -> (Self, RendererPortTx) {
        let (tx, rx) = std_mpsc::channel::<RendererOp>();
        (
            Self { adapter: LinuxRendererAdapter::new(glb_runner), rx },
            RendererPortTx { tx },
        )
    }

    /// Access the adapter for HOST-SIDE inspection seams (gtk_visible_text,
    /// activate_gtk_action, etc. — NOT contract ops), mirroring how the existing
    /// GTK tests drive the realization.
    pub fn adapter(&mut self) -> &mut LinuxRendererAdapter {
        &mut self.adapter
    }

    /// Process all currently-queued renderer ops on THIS (GTK) thread and
    /// iterate the GTK main context once. Returns the number of ops processed.
    /// Called repeatedly by the GTK thread's loop (test pump or the client's
    /// main loop). No QuickJS contact happens here.
    pub fn pump(&mut self) -> usize {
        let mut n = 0;
        while let Ok(op) = self.rx.try_recv() {
            self.execute(op);
            n += 1;
        }
        // Iterate the GTK main context so realization/intents advance on this
        // thread between ops.
        while gtk4::glib::MainContext::default().iteration(false) {}
        n
    }

    fn execute(&mut self, op: RendererOp) {
        match op {
            RendererOp::CreateSurface { view_descriptor, done } => {
                let _ = done.send(self.adapter.create_surface(&view_descriptor));
            }
            RendererOp::AttachPresentation { handle, presentation_descriptor, done } => {
                let _ = done.send(self.adapter.attach_presentation(&handle, &presentation_descriptor));
            }
            RendererOp::DetachPresentation { handle, done } => {
                let _ = done.send(self.adapter.detach_presentation(&handle));
            }
            RendererOp::Resize { handle, width, height, done } => {
                let _ = done.send(self.adapter.resize(&handle, width, height));
            }
            RendererOp::DestroySurface { handle, done } => {
                let _ = done.send(self.adapter.destroy_surface(&handle));
            }
            RendererOp::DestroyAll { done } => {
                let _ = done.send(self.adapter.destroy_all());
            }
        }
    }
}

impl RendererPortTx {
    /// Issue one renderer op and await its oneshot result. Called from an
    /// `Async` host fn on the JS-owner thread: the send enqueues the op on the
    /// GTK thread; the oneshot await SUSPENDS the JS Promise (the drive loop
    /// keeps running on the owner thread) until the GTK thread resolves it.
    async fn op<R>(&self, make: impl FnOnce(oneshot::Sender<Result<R, String>>) -> RendererOp) -> Result<R, String> {
        let (done, rx) = oneshot::channel();
        self.tx
            .send(make(done))
            .map_err(|_| "renderer GTK thread gone".to_string())?;
        rx.await.map_err(|_| "renderer op response dropped".to_string())?
    }

    pub async fn create_surface(&self, view_descriptor: Value) -> Result<String, String> {
        self.op(|done| RendererOp::CreateSurface { view_descriptor, done }).await
    }
    pub async fn attach_presentation(&self, handle: String, presentation_descriptor: Value) -> Result<(), String> {
        self.op(|done| RendererOp::AttachPresentation { handle, presentation_descriptor, done }).await
    }
    pub async fn detach_presentation(&self, handle: String) -> Result<(), String> {
        self.op(|done| RendererOp::DetachPresentation { handle, done }).await
    }
    pub async fn resize(&self, handle: String, width: u32, height: u32) -> Result<(), String> {
        self.op(|done| RendererOp::Resize { handle, width, height, done }).await
    }
    pub async fn destroy_surface(&self, handle: String) -> Result<(), String> {
        self.op(|done| RendererOp::DestroySurface { handle, done }).await
    }
    pub async fn destroy_all(&self) -> Result<(), String> {
        self.op(|done| RendererOp::DestroyAll { done }).await
    }
}

/// Install the RendererAdapter-shaped object into the guest as `globalThis`
/// properties. The six methods are `Async` host fns forwarding to the
/// `RendererPortTx`; descriptor args cross as JSON strings (the guest
/// stringifies; the port parses to `serde_json::Value`), preserving the
/// data-representable boundary. The returned object is the RendererAdapter the
/// JS `Compositor` consumes. This is the ONLY way JS reaches the renderer — no
/// QuickJS contact on the GTK thread, no `OwnerCommand` on this path.
///
/// `install` is called from within a `JsEnvActor::with_context` closure (which
/// runs on the JS-owner thread under the runtime lock). It only REGISTERS the
/// host fns; calling them later suspends a Promise on the GTK thread's oneshot.
/// Map a renderer-op `String` error into a JS error carrying the REAL message
/// (e.g. "unknown/destroyed surface handle"), so the guest sees the adapter's
/// own loud-reject rather than an opaque "op". The message is plain data from
/// the adapter's contract — no semantic decoding.
fn op_err(op: &'static str) -> impl Fn(String) -> rquickjs::Error {
    move |msg| rquickjs::Error::new_from_js_message(op, "renderer-op", msg)
}

/// Map a JSON-parse failure into a JS error.
fn json_err(op: &'static str, what: &'static str) -> impl Fn(serde_json::Error) -> rquickjs::Error {
    move |e| rquickjs::Error::new_from_js_message(op, what, e.to_string())
}

/// Install the RendererAdapter-shaped object the REAL JS `Compositor` consumes.
///
/// # Marshalling owner (two layers, both installed here)
///
/// The real Compositor calls `createSurface(viewDescriptor)` with a PLAIN
/// descriptor object (not a JSON string). rquickjs cannot move a guest
/// `Value<'js>` into the `'static`/Send future the GTK-thread op requires, and
/// an `Async` host closure does not receive a call-time `Ctx` to stringify it.
/// So the port installs BOTH layers (mirroring the proven 64j bridge.mjs shape):
///   (a) six low-level host fns taking JSON STRINGS (`__jsenv_renderer_*`) that
///       forward to the `RendererPortTx`, and
///   (b) a thin JS wrapper object (`name`) whose six methods take the
///       Compositor's plain-object args, `JSON.stringify` them guest-side (on
///       the JS-owner thread — data-representable by construction; the adapter
///       re-checks via `assert_data_representable`), and delegate to (a).
/// The port owns this marshalling; no ad-hoc wrapper may grow elsewhere.
///
/// Must be called from within a `JsEnvActor::with_context` closure (JS-owner
/// thread under the runtime lock); it only REGISTERS the host fns.
pub fn install_renderer_adapter(ctx: &rquickjs::Ctx, tx: RendererPortTx, name: &str) -> rquickjs::Result<()> {
    use rquickjs::prelude::Async;
    use rquickjs::Function;

    // (a) Low-level host fns taking JSON strings.
    // createSurface(viewDescriptorJson) -> handle (string)
    {
        let tx = tx.clone();
        let f = Function::new(
            ctx.clone(),
            Async(move |view_descriptor_json: String| {
                let tx = tx.clone();
                async move {
                    let view_descriptor: Value = serde_json::from_str(&view_descriptor_json)
                        .map_err(json_err("createSurface", "viewDescriptor JSON"))?;
                    tx.create_surface(view_descriptor).await.map_err(op_err("createSurface"))
                }
            }),
        )?;
        ctx.globals().set("__jsenv_renderer_createSurface", f)?;
    }

    // attachPresentation(handle, presentationDescriptorJson) -> void
    {
        let tx = tx.clone();
        let f = Function::new(
            ctx.clone(),
            Async(move |handle: String, presentation_descriptor_json: String| {
                let tx = tx.clone();
                async move {
                    let presentation_descriptor: Value = serde_json::from_str(&presentation_descriptor_json)
                        .map_err(json_err("attachPresentation", "presentationDescriptor JSON"))?;
                    tx.attach_presentation(handle, presentation_descriptor).await.map_err(op_err("attachPresentation"))
                }
            }),
        )?;
        ctx.globals().set("__jsenv_renderer_attachPresentation", f)?;
    }

    // detachPresentation(handle) -> void
    {
        let tx = tx.clone();
        let f = Function::new(
            ctx.clone(),
            Async(move |handle: String| {
                let tx = tx.clone();
                async move { tx.detach_presentation(handle).await.map_err(op_err("detachPresentation")) }
            }),
        )?;
        ctx.globals().set("__jsenv_renderer_detachPresentation", f)?;
    }

    // resize(handle, sizeJson) -> void
    {
        let tx = tx.clone();
        let f = Function::new(
            ctx.clone(),
            Async(move |handle: String, size_json: String| {
                let tx = tx.clone();
                async move {
                    let size: Value = serde_json::from_str(&size_json)
                        .map_err(json_err("resize", "size JSON"))?;
                    let width = size.get("width").and_then(Value::as_u64).unwrap_or(0) as u32;
                    let height = size.get("height").and_then(Value::as_u64).unwrap_or(0) as u32;
                    tx.resize(handle, width, height).await.map_err(op_err("resize"))
                }
            }),
        )?;
        ctx.globals().set("__jsenv_renderer_resize", f)?;
    }

    // destroySurface(handle) -> void
    {
        let tx = tx.clone();
        let f = Function::new(
            ctx.clone(),
            Async(move |handle: String| {
                let tx = tx.clone();
                async move { tx.destroy_surface(handle).await.map_err(op_err("destroySurface")) }
            }),
        )?;
        ctx.globals().set("__jsenv_renderer_destroySurface", f)?;
    }

    // destroyAll() -> void
    {
        let tx = tx.clone();
        let f = Function::new(
            ctx.clone(),
            Async(move || {
                let tx = tx.clone();
                async move { tx.destroy_all().await.map_err(op_err("destroyAll")) }
            }),
        )?;
        ctx.globals().set("__jsenv_renderer_destroyAll", f)?;
    }

    // (b) The JS wrapper object the Compositor consumes: plain-object args in,
    // stringify guest-side, delegate to the low-level host fns.
    let wrapper_src = format!(
        r#"(() => {{
  const S = JSON.stringify;
  return {{
    createSurface: (viewDescriptor) => globalThis.__jsenv_renderer_createSurface(S(viewDescriptor)),
    attachPresentation: (handle, presentationDescriptor) => globalThis.__jsenv_renderer_attachPresentation(handle, S(presentationDescriptor)),
    detachPresentation: (handle) => globalThis.__jsenv_renderer_detachPresentation(handle),
    resize: (handle, size) => globalThis.__jsenv_renderer_resize(handle, S(size)),
    destroySurface: (handle) => globalThis.__jsenv_renderer_destroySurface(handle),
    destroyAll: () => globalThis.__jsenv_renderer_destroyAll(),
  }};
}})()"#
    );
    let adapter: rquickjs::Object = ctx.eval(wrapper_src.as_str())?;
    ctx.globals().set(name, adapter)?;
    Ok(())
}
