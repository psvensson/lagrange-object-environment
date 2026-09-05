//! 3zb-A slice 3B: the TEST Images capability at the Env<->Images capability port.
//!
//! This is a SMALL DETERMINISTIC TEST capability — scripted outcomes over OPAQUE
//! fake object records/tokens. It is NOT the lagrange-images substrate and does
//! NOT reproduce substrate semantics: no CAS model, no authority calculus, no
//! version-token/cursor/codec/Project semantics, no real lagrange-images import.
//! It is the permanent boundary/conformance proof for the capability port the
//! Environment core consumes (the future WIT boundary); 3zb-B replaces the host
//! side with the real WIT capability and the guest side with the real
//! `image-client-adapter.js`.
//!
//! # The capability port surface (the adapter-level upward surface the Env core calls)
//!
//! The slice-4 modules (ObjectNavigator/SelectionModel/EnvironmentShell/Compositor
//! + command-router/dispatcher) consume exactly:
//!   - `readObject({imageId, objectId, authority, blockId}) -> {slots, indexed, versionToken}`
//!   - `mutateObject({imageId, objectId, value, authority, blockId, versionToken})`
//!   - `observe(imageId, {authority, blockId, signal, intervalMs})` — guest-composed
//!     from the real `observeChanges` over the host `observePull` lane
//!   - `writableSlots` (a static list; the SemanticUi editability single owner)
//!   - `dispatch(command, subject, {authority, context})` (positional; guest-composed
//!     over the real createCommandDispatcher)
//!
//! The HOST port lanes are `readObject` / `mutateObject` / `observePull`, each
//! carrying per-call authority/blockId. Every lane returns a JSON ENVELOPE string:
//! `{"ok": <value>}` on success, `{"err": {"name":..., "message":..., "code":...}}`
//! on a scripted loud-reject. The guest wrapper parses the envelope and, on `err`,
//! throws a NAME- and CODE-faithful error (`Object.assign(new Error(m), {name, code})`)
//! — `Error` does not survive JSON marshalling, so the name/code ride as data.
//!
//! # Threading (review Finding 3)
//!
//! The host is serviced by a DEDICATED thread running a blocking `recv()` loop.
//! It NEVER blocks on JS and NEVER calls back into the runtime, so it cannot
//! reproduce the renderer-port slice-4 deadlock class (a GTK thread blocked on an
//! intent push while the intent's dispatch awaits an images oneshot only the GTK
//! thread can service). This fake has no GTK/real-time affinity, so a plain
//! blocking loop on its own thread is the correct owner.
//!
//! # Scripted-outcome dispatch over opaque token identity (reconciles ownership row 73)
//!
//! The version token is an OPAQUE string the host mints (`v<version>`). The guest
//! NEVER parses/forges/compares it — it captures a token from a read/mutation and
//! threads it back untouched. On mutateObject the host compares the WHOLE presented
//! token for identity against the current token: identical -> apply; different ->
//! a scripted `ObjectMutationConflictError` loud-reject. This is outcome dispatch
//! over token IDENTITY, not a substrate compare-and-swap the guest could reason about.

use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::mpsc as std_mpsc;
use tokio::sync::oneshot;

/// The raw lane kind the fake emits on mutation. This is the SUBSTRATE lane's
/// v1 kind (`object.put`); image-observation.js's `normalizeChange` owns the
/// mapping to the Env-side `record.put` Change type — the fake must speak the
/// lane's raw vocabulary, not the normalized one (review Finding 4).
const OBS_KIND_OBJECT_PUT: &str = "object.put";

/// A scripted object record: opaque slots + a monotonically bumped version.
struct ScriptedObject {
    slots: Value, // a JSON object map slotName -> Value
    indexed: Vec<Value>,
    version: u64,
}

/// One scripted observation event (invalidation only — no payload ever crosses).
struct ScriptedEvent {
    object_id: String,
    kind: String,
    cursor: String,
}

/// The scripted image state. Owned by the host thread; mutated only there.
struct ScriptedImage {
    objects: HashMap<String, ScriptedObject>,
    events: Vec<ScriptedEvent>,
    next_cursor: u64,
    deny_read: HashSet<String>,
    deny_mutate: HashSet<String>,
}

impl ScriptedImage {
    fn new() -> Self {
        Self {
            objects: HashMap::new(),
            events: Vec::new(),
            next_cursor: 1,
            deny_read: HashSet::new(),
            deny_mutate: HashSet::new(),
        }
    }

    fn token(version: u64) -> String {
        format!("v{version}")
    }
}

/// Per-call context the REAL port threads (imageId, blockId, authority). The
/// scripted fake CARRIES these for shape fidelity — so slice 4's guest adapter
/// threads them through this port unchanged — but they are INERT: the fake is a
/// single-image scripted store with no authority calculus and no per-block
/// routing (scripted denials key on objectId). They ride as data, never read.
#[derive(Debug, Default, Clone)]
// These fields are deliberately carried-but-unread (shape fidelity only).
#[allow(dead_code)]
pub struct CallContext {
    image_id: Option<String>,
    block_id: Option<String>,
    /// The per-call authority, JSON-serialized guest-side (opaque). Never read.
    authority_json: Option<String>,
}

/// The ops the JS-owner side can issue. Each carries a oneshot for its envelope.
enum ImagesOp {
    ReadObject {
        object_id: String,
        ctx: CallContext,
        done: oneshot::Sender<String>,
    },
    MutateObject {
        object_id: String,
        value: Value,
        version_token: Option<String>,
        ctx: CallContext,
        done: oneshot::Sender<String>,
    },
    ObservePull {
        after_cursor: Option<String>,
        ctx: CallContext,
        done: oneshot::Sender<String>,
    },
}

/// The sending end the JS-owner side uses. Cheap to clone; `Send`.
#[derive(Clone)]
pub struct ImagesCapabilityTx {
    tx: std_mpsc::Sender<ImagesOp>,
}

/// The host-side scripted capability. Create on any thread, script state via the
/// `ImagesScriptHandle`, then `start()` spawns the dedicated servicing thread.
pub struct ImagesCapabilityHost {
    image: ScriptedImage,
    op_rx: std_mpsc::Receiver<ImagesOp>,
    script_rx: std_mpsc::Receiver<ScriptCmd>,
}

/// A handle the test uses to script the fake's state before the host starts.
/// Script-then-freeze: once `start()` runs, the state is owned solely by the
/// servicing thread (mutations then flow only through mutateObject ops).
pub struct ImagesScriptHandle {
    tx: std_mpsc::Sender<ScriptCmd>,
}

enum ScriptCmd {
    AddObject { object_id: String, slots: Value, indexed: Vec<Value> },
    DenyRead { object_id: String },
    DenyMutate { object_id: String },
}

impl ImagesCapabilityHost {
    /// Create the host (not yet servicing). Returns the host, the Tx the
    /// JS-owner side uses, and the script handle the test uses to seed state.
    pub fn new() -> (Self, ImagesCapabilityTx, ImagesScriptHandle) {
        let (op_tx, op_rx) = std_mpsc::channel::<ImagesOp>();
        let (script_tx, script_rx) = std_mpsc::channel::<ScriptCmd>();
        (
            Self { image: ScriptedImage::new(), op_rx, script_rx },
            ImagesCapabilityTx { tx: op_tx },
            ImagesScriptHandle { tx: script_tx },
        )
    }

    /// Apply the scripted state and spawn the dedicated servicing thread. The
    /// thread runs a blocking recv loop, executing ops against the scripted
    /// state and NEVER touching JS (review Finding 3). Consumes the host.
    pub fn start(mut self) {
        // Apply scripted state before servicing begins (drain whatever the test
        // queued via the script handle).
        while let Ok(cmd) = self.script_rx.try_recv() {
            match cmd {
                ScriptCmd::AddObject { object_id, slots, indexed } => {
                    self.image.objects.insert(object_id, ScriptedObject { slots, indexed, version: 1 });
                }
                ScriptCmd::DenyRead { object_id } => {
                    self.image.deny_read.insert(object_id);
                }
                ScriptCmd::DenyMutate { object_id } => {
                    self.image.deny_mutate.insert(object_id);
                }
            }
        }
        let mut image = self.image;
        let op_rx = self.op_rx;
        std::thread::Builder::new()
            .name("images-capability-host".to_string())
            .spawn(move || {
                // Blocking loop: process ops until the Tx side drops. This thread
                // never blocks on JS and never calls into the runtime.
                while let Ok(op) = op_rx.recv() {
                    match op {
                        ImagesOp::ReadObject { object_id, ctx, done } => {
                            let _ = done.send(read_object(&image, &object_id, &ctx));
                        }
                        ImagesOp::MutateObject { object_id, value, version_token, ctx, done } => {
                            let _ = done.send(mutate_object(&mut image, &object_id, value, version_token, &ctx));
                        }
                        ImagesOp::ObservePull { after_cursor, ctx, done } => {
                            let _ = done.send(observe_pull(&image, after_cursor, &ctx));
                        }
                    }
                }
            })
            .expect("spawn images-capability-host thread");
    }
}

fn ok_envelope(value: Value) -> String {
    json!({ "ok": value }).to_string()
}

fn err_envelope(name: &str, message: &str, code: Option<&str>) -> String {
    let mut e = json!({ "name": name, "message": message });
    if let Some(c) = code {
        e["code"] = json!(c);
    }
    json!({ "err": e }).to_string()
}

fn read_object(image: &ScriptedImage, object_id: &str, _ctx: &CallContext) -> String {
    if image.deny_read.contains(object_id) {
        return err_envelope("AuthorityError", &format!("read denied: {object_id}"), None);
    }
    match image.objects.get(object_id) {
        // The substrate's not-found is TypeError-based (object-navigator.js's
        // fallback reads `instanceof TypeError`); the PRIMARY discriminator the
        // navigator uses is `code === 'OBJECT_NOT_FOUND'`, which we always set.
        // We name it faithfully for the name-conscious consumer (review Finding 7).
        None => err_envelope(
            "ObjectReadNotFoundError",
            &format!("object not found: {object_id}"),
            Some("OBJECT_NOT_FOUND"),
        ),
        Some(rec) => ok_envelope(json!({
            "slots": rec.slots,
            "indexed": rec.indexed,
            "versionToken": ScriptedImage::token(rec.version),
        })),
    }
}

fn mutate_object(
    image: &mut ScriptedImage,
    object_id: &str,
    value: Value,
    version_token: Option<String>,
    _ctx: &CallContext,
) -> String {
    if image.deny_mutate.contains(object_id) {
        return err_envelope("AuthorityError", &format!("mutation denied: {object_id}"), None);
    }
    let rec = match image.objects.get_mut(object_id) {
        None => {
            return err_envelope(
                "Error",
                &format!("object not found: {object_id}"),
                Some("OBJECT_NOT_FOUND"),
            )
        }
        Some(r) => r,
    };
    // Opaque token identity: identical -> apply; otherwise -> conflict.
    let current = ScriptedImage::token(rec.version);
    if version_token.as_deref() != Some(current.as_str()) {
        return err_envelope(
            "ObjectMutationConflictError",
            &format!("stale version token for {object_id}"),
            None,
        );
    }
    // Apply the mutation (merge value's slots), bump the version, and record the
    // observation event BEFORE completing (so any later poll sees it — the olm
    // ordering guarantee slice-4 relies on).
    // Loud-reject a non-object mutation value rather than silently no-oping the
    // merge while still bumping the version/recording an event (fake fidelity:
    // a mutation that "commits" without changing anything would mask a real
    // caller bug behind a token advance).
    if !value.is_object() {
        return err_envelope(
            "ObjectMutationError",
            "mutation value must be a JSON object of slots",
            Some("MUTATION_VALUE_NOT_OBJECT"),
        );
    }
    if let (Value::Object(dst), Value::Object(src)) = (&mut rec.slots, &value) {
        for (k, v) in src {
            dst.insert(k.clone(), v.clone());
        }
    }
    rec.version += 1;
    let new_token = ScriptedImage::token(rec.version);
    let cursor = image.next_cursor.to_string();
    image.next_cursor += 1;
    image.events.push(ScriptedEvent {
        object_id: object_id.to_string(),
        kind: OBS_KIND_OBJECT_PUT.to_string(),
        cursor,
    });
    ok_envelope(json!({ "versionToken": new_token }))
}

/// The high-water cursor: the cursor of the latest event, or "0" if none. A pull
/// resumed from this cursor replays nothing already seen.
fn high_water(image: &ScriptedImage) -> String {
    image.events.last().map(|e| e.cursor.clone()).unwrap_or_else(|| "0".to_string())
}

fn observe_pull(image: &ScriptedImage, after_cursor: Option<String>, _ctx: &CallContext) -> String {
    // Cursor semantics (review Finding 2 — matches the real observeChanges lane,
    // image-observation.js: "live-follow from the current end … replays NO
    // backlog"):
    //   - None or '' (the followSelected default: no afterCursor) => live-follow
    //     from the CURRENT high-water: empty events, cursor = high-water. NO
    //     backlog replay. This is the load-bearing default.
    //   - an explicit cursor (including "0" = from the beginning) => events with
    //     cursor > after_cursor (incremental, monotonic, idempotent on resume).
    let high = high_water(image);
    let (events, cursor) = match after_cursor.as_deref() {
        None | Some("") => (Vec::new(), high),
        Some(c) => {
            let after: u64 = c.parse::<u64>().unwrap_or(0);
            let events: Vec<Value> = image
                .events
                .iter()
                .filter(|e| e.cursor.parse::<u64>().unwrap_or(0) > after)
                .map(|e| json!({ "objectId": e.object_id, "kind": e.kind, "cursor": e.cursor }))
                .collect();
            (events, high_water(image))
        }
    };
    ok_envelope(json!({ "events": events, "cursor": cursor }))
}

impl ImagesScriptHandle {
    /// Script a canned object record (version starts at 1; token `v1`), no
    /// indexed rows.
    pub fn add_object(&self, object_id: &str, slots: Value) {
        self.add_object_full(object_id, slots, vec![]);
    }
    /// Script a canned object record with explicit indexed rows (the lane's third
    /// return field; the navigator may consume indexed rows).
    pub fn add_object_full(&self, object_id: &str, slots: Value, indexed: Vec<Value>) {
        let _ = self.tx.send(ScriptCmd::AddObject {
            object_id: object_id.to_string(),
            slots,
            indexed,
        });
    }
    /// Script a read denial (readObject -> AuthorityError).
    pub fn deny_read(&self, object_id: &str) {
        let _ = self.tx.send(ScriptCmd::DenyRead { object_id: object_id.to_string() });
    }
    /// Script a mutation denial (mutateObject -> AuthorityError).
    pub fn deny_mutate(&self, object_id: &str) {
        let _ = self.tx.send(ScriptCmd::DenyMutate { object_id: object_id.to_string() });
    }
}

impl ImagesCapabilityTx {
    /// Issue one images op and await its envelope string. Called from an `Async`
    /// host fn on the JS-owner thread: the send enqueues the op on the dedicated
    /// host thread; the oneshot await SUSPENDS the JS Promise (the drive loop
    /// keeps running on the owner thread) until the host resolves it.
    async fn op(&self, make: impl FnOnce(oneshot::Sender<String>) -> ImagesOp) -> Result<String, String> {
        let (done, rx) = oneshot::channel();
        self.tx
            .send(make(done))
            .map_err(|_| "images capability host thread gone".to_string())?;
        rx.await.map_err(|_| "images capability op response dropped".to_string())
    }

    pub async fn read_object(&self, object_id: String, ctx: CallContext) -> Result<String, String> {
        self.op(|done| ImagesOp::ReadObject { object_id, ctx, done }).await
    }
    pub async fn mutate_object(
        &self,
        object_id: String,
        value: Value,
        version_token: Option<String>,
        ctx: CallContext,
    ) -> Result<String, String> {
        self.op(|done| ImagesOp::MutateObject { object_id, value, version_token, ctx, done }).await
    }
    pub async fn observe_pull(&self, after_cursor: Option<String>, ctx: CallContext) -> Result<String, String> {
        self.op(|done| ImagesOp::ObservePull { after_cursor, ctx, done }).await
    }
}

/// Install the TEST Images capability under `name` (the guest adapter's port).
///
/// Two-layer marshalling (the same shape as the renderer port): low-level
/// `__jsenv_images_*` host fns exchange JSON envelope STRINGS; a thin guest
/// wrapper object parses each envelope and either returns the value or throws a
/// NAME- and CODE-faithful reconstructed error. The guest adapter (slice 3B/4)
/// builds the readObject/mutateObject/observe surface over this port.
///
/// The per-call `authority`/`blockId`/`imageId` are carried through the port as
/// an opaque JSON string for shape fidelity (the real port threads them; slice
/// 4's guest adapter passes them unchanged) but are INERT in the scripted fake —
/// scripted denials key on objectId, not on an authority calculus, and the fake
/// is a single-image store with no per-block routing (no substrate semantics).
pub fn install_images_capability(ctx: &rquickjs::Ctx, tx: ImagesCapabilityTx, name: &str) -> rquickjs::Result<()> {
    use rquickjs::prelude::Async;
    use rquickjs::Function;

    // Each low-level host fn takes the lane args PLUS the per-call context as an
    // opaque JSON string `ctx_json` ({imageId, blockId, authority}) — carried for
    // shape fidelity, inert in the fake (review Finding 1).
    fn parse_ctx(ctx_json: Option<String>) -> Result<CallContext, rquickjs::Error> {
        match ctx_json {
            None => Ok(CallContext::default()),
            Some(s) => {
                let v: Value = serde_json::from_str(&s)
                    .map_err(|e| op_fail(format!("call-context JSON: {e}")))?;
                Ok(CallContext {
                    image_id: v.get("imageId").and_then(Value::as_str).map(str::to_string),
                    block_id: v.get("blockId").and_then(Value::as_str).map(str::to_string),
                    authority_json: v.get("authority").map(|a| a.to_string()),
                })
            }
        }
    }

    // readObject(objectId, ctxJson) -> envelope string
    {
        let tx = tx.clone();
        let f = Function::new(
            ctx.clone(),
            Async(move |object_id: String, ctx_json: Option<String>| {
                let tx = tx.clone();
                async move {
                    let c = parse_ctx(ctx_json)?;
                    tx.read_object(object_id, c).await.map_err(op_fail)
                }
            }),
        )?;
        ctx.globals().set("__jsenv_images_readObject", f)?;
    }
    // mutateObject(objectId, valueJson, versionTokenOrNull, ctxJson) -> envelope string
    {
        let tx = tx.clone();
        let f = Function::new(
            ctx.clone(),
            Async(move |object_id: String, value_json: String, version_token: Option<String>, ctx_json: Option<String>| {
                let tx = tx.clone();
                async move {
                    let value: Value = serde_json::from_str(&value_json)
                        .map_err(|e| op_fail(format!("mutateObject value JSON: {e}")))?;
                    let c = parse_ctx(ctx_json)?;
                    tx.mutate_object(object_id, value, version_token, c).await.map_err(op_fail)
                }
            }),
        )?;
        ctx.globals().set("__jsenv_images_mutateObject", f)?;
    }
    // observePull(afterCursorOrNull, ctxJson) -> envelope string
    {
        let tx = tx.clone();
        let f = Function::new(
            ctx.clone(),
            Async(move |after_cursor: Option<String>, ctx_json: Option<String>| {
                let tx = tx.clone();
                async move {
                    let c = parse_ctx(ctx_json)?;
                    tx.observe_pull(after_cursor, c).await.map_err(op_fail)
                }
            }),
        )?;
        ctx.globals().set("__jsenv_images_observePull", f)?;
    }

    // The thin guest wrapper: parse each envelope, throw name/code-faithful
    // errors on `err`, else return the `ok` value. Installed under `name`.
    let wrapper = format!(
        r#"
globalThis[{name_json}] = (() => {{
  function unpack(envelope) {{
    const e = JSON.parse(envelope);
    if (e && e.err) {{
      const err = new Error(e.err.message);
      err.name = e.err.name;
      if (e.err.code !== undefined) err.code = e.err.code;
      throw err;
    }}
    return e.ok;
  }}
  // Each method threads the per-call context (imageId, blockId, authority) as
  // an opaque JSON string — carried for shape fidelity, inert in the fake.
  const ctxJson = (opts) => JSON.stringify({{
    imageId: opts?.imageId ?? null, blockId: opts?.blockId ?? null, authority: opts?.authority ?? null,
  }});
  return Object.freeze({{
    readObject: async (objectId, opts = {{}}) => unpack(await __jsenv_images_readObject(objectId, ctxJson(opts))),
    mutateObject: async (objectId, value, versionToken = null, opts = {{}}) =>
      unpack(await __jsenv_images_mutateObject(objectId, JSON.stringify(value ?? {{}}), versionToken, ctxJson(opts))),
    observePull: async (afterCursor = null, opts = {{}}) => unpack(await __jsenv_images_observePull(afterCursor, ctxJson(opts))),
  }});
}})();
"#,
        name_json = serde_json::to_string(name).unwrap_or_else(|_| "\"imagesCapability\"".to_string())
    );
    ctx.eval::<(), _>(wrapper.as_str())?;
    Ok(())
}

fn op_fail(msg: String) -> rquickjs::Error {
    rquickjs::Error::new_from_js_message("images-capability", "guest", msg)
}
